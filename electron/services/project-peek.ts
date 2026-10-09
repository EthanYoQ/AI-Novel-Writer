import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'
import {
  CANONICAL_PROJECT_DATABASE,
  CANONICAL_PROJECT_DIRECTORY,
  parseCanonicalProjectManifest,
} from '../../src/shared/project-format'
import type {
  ProjectOverview,
  ProjectOverviewStage,
  ProjectOverviewStageStatus,
  ProjectPeekCapability,
  ReadyProjectOverview,
} from '../../src/shared/project-overview'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { verifySchema } from '../migrations/runner'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const UNAVAILABLE: ProjectOverview = Object.freeze({ state: 'unavailable' })
const SQLITE_SUFFIXES = ['', '-wal', '-shm'] as const

interface ManifestState {
  rootPath: string
  databasePath: string
  projectId: string
  manifestFingerprint: string
  storageVersion: number
}

interface CapabilityState extends ManifestState {
  capabilityId: string
  expectedSchemaVersion: number
}

interface PhysicalFileState {
  suffix: typeof SQLITE_SUFFIXES[number]
  size: string
  hash: string
  device: string
  inode: string
  modified: string
}

export interface ProjectPeekServiceOptions {
  scratchRoot?: string
  newCapabilityId?: () => string
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const pathKey = (value: string) => process.platform === 'win32'
  ? path.normalize(value).toLocaleLowerCase('en-US')
  : path.normalize(value)

function contained(root: string, child: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(child))
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function regularFile(file: string, root: string): fs.BigIntStats {
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('PROJECT_PEEK_UNSAFE_FILE')
  const canonical = path.normalize(fs.realpathSync.native(file))
  if (!contained(root, canonical)) throw new Error('PROJECT_PEEK_FILE_OUTSIDE_ROOT')
  return info
}

function readManifest(candidatePath: string): ManifestState {
  const resolved = path.resolve(candidatePath)
  const rootInfo = fs.lstatSync(resolved)
  if (!rootInfo.isDirectory()) throw new Error('PROJECT_PEEK_ROOT_INVALID')
  const rootPath = path.normalize(fs.realpathSync.native(resolved))
  if (fs.existsSync(path.join(rootPath, '.vela'))) throw new Error('PROJECT_PEEK_LEGACY_UNAVAILABLE')
  const storageRoot = path.join(rootPath, CANONICAL_PROJECT_DIRECTORY)
  const storageInfo = fs.lstatSync(storageRoot)
  if (!storageInfo.isDirectory() || storageInfo.isSymbolicLink()
    || pathKey(fs.realpathSync.native(storageRoot)) !== pathKey(storageRoot)) throw new Error('PROJECT_PEEK_STORAGE_INVALID')
  const manifestPath = path.join(storageRoot, 'project.json')
  regularFile(manifestPath, rootPath)
  const bytes = fs.readFileSync(manifestPath)
  const manifest = parseCanonicalProjectManifest(JSON.parse(bytes.toString('utf8')))
  const migrationJournal = path.join(rootPath, '.ai-novel-migration', 'journal.json')
  if (fs.existsSync(migrationJournal)) {
    regularFile(migrationJournal, rootPath)
    const journal = JSON.parse(fs.readFileSync(migrationJournal, 'utf8')) as Record<string, unknown>
    if (journal.version !== 1 || journal.phase !== 'switched' || journal.projectId !== manifest.projectId) {
      throw new Error('PROJECT_PEEK_MIGRATION_INCOMPLETE')
    }
  }
  const databasePath = path.join(storageRoot, CANONICAL_PROJECT_DATABASE)
  regularFile(databasePath, rootPath)
  return {
    rootPath,
    databasePath,
    projectId: manifest.projectId,
    manifestFingerprint: digest(bytes),
    storageVersion: manifest.storageVersion,
  }
}

function sourceState(databasePath: string): PhysicalFileState[] {
  if (fs.existsSync(`${databasePath}-journal`)) throw new Error('PROJECT_PEEK_ROLLBACK_JOURNAL_PRESENT')
  return SQLITE_SUFFIXES.filter(suffix => fs.existsSync(databasePath + suffix)).map(suffix => {
    const file = databasePath + suffix
    const info = regularFile(file, path.dirname(databasePath))
    return {
      suffix,
      size: info.size.toString(),
      hash: digest(fs.readFileSync(file)),
      device: info.dev.toString(),
      inode: info.ino.toString(),
      modified: info.mtimeNs.toString(),
    }
  })
}

function sameSnapshotContent(left: readonly PhysicalFileState[], right: readonly PhysicalFileState[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return item.suffix === other?.suffix && item.size === other.size && item.hash === other.hash
  })
}

function positiveChapter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function chapterNumbers(rows: readonly { chapterNumber: number }[]): number[] {
  return [...new Set(rows.map(row => row.chapterNumber).filter(positiveChapter))].sort((a, b) => a - b)
}

function plannedStatus(chapters: readonly number[], plannedChapters: number): ProjectOverviewStageStatus {
  if (!positiveChapter(plannedChapters)) return chapters.length ? 'in-progress' : 'unknown'
  if (!chapters.length) return 'not-started'
  const covered = new Set(chapters.filter(chapter => chapter <= plannedChapters))
  return covered.size === plannedChapters ? 'completed' : 'in-progress'
}

function tailExcerpt(value: string): string | undefined {
  const text = value.trim()
  if (!text) return undefined
  return [...text].slice(-240).join('')
}

interface CoreRow {
  projectName: string
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  writingStyle: string
  premise: string
  worldbuilding: string
  charactersArch: string
  synopsis: string
}

interface FinalizedRow {
  draftId: number
  chapterNumber: number
  version: number
  body: string
  finalizationId: string | null
  outboxChapterNumber: number | null
  contentHash: string | null
  contentSnapshot: string | null
}

function aggregateProject(
  database: BetterSqlite3.Database,
  projectId: string,
  includeExcerpt: boolean,
  physicalRevision = '',
): ReadyProjectOverview {
  const core = database.prepare(`
    SELECT project_name AS projectName, genre, sub_genre AS subGenre,
           target_audience AS targetAudience, total_chapters AS totalChapters,
           core_outline AS coreOutline, world_setting AS worldSetting,
           golden_finger AS goldenFinger, protagonist_profile AS protagonistProfile,
           global_guidance AS globalGuidance, writing_style AS writingStyle,
           premise, worldbuilding, characters_arch AS charactersArch, synopsis
    FROM project_core WHERE id='main'
  `).get() as CoreRow | undefined
  if (!core) throw new Error('PROJECT_PEEK_CORE_MISSING')
  const configurationCount = [
    core.genre, core.subGenre, core.targetAudience, core.coreOutline, core.worldSetting,
    core.goldenFinger, core.protagonistProfile, core.globalGuidance, core.writingStyle,
  ].filter(value => typeof value === 'string' && value.trim()).length
  const architectureCount = [core.premise, core.worldbuilding, core.charactersArch, core.synopsis]
    .filter(value => typeof value === 'string' && value.trim()).length
  const blueprints = chapterNumbers(database.prepare('SELECT DISTINCT chapter_number AS chapterNumber FROM blueprints').all() as { chapterNumber: number }[])
  const currentDrafts = database.prepare(`
    SELECT drafts.chapter_number AS chapterNumber, drafts.word_count AS wordCount
    FROM drafts
    WHERE drafts.status IN ('draft','revised','finalized')
      AND NOT EXISTS (
        SELECT 1 FROM drafts newer
        WHERE newer.chapter_number=drafts.chapter_number
          AND newer.status IN ('draft','revised','finalized')
          AND (newer.version>drafts.version OR newer.version=drafts.version AND newer.id>drafts.id)
      )
  `).all() as { chapterNumber: number; wordCount: number }[]
  const draftChapters = chapterNumbers(currentDrafts)
  const reviewChapters = chapterNumbers(database.prepare(`
    SELECT DISTINCT drafts.chapter_number AS chapterNumber
    FROM reviews JOIN drafts ON drafts.id=reviews.base_draft_id
  `).all() as { chapterNumber: number }[])
  const finalizedRows = database.prepare(`
    SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.version,
           contents.body, finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.chapter_number AS outboxChapterNumber,
           finalization_outbox.content_hash AS contentHash,
           finalization_outbox.content_snapshot AS contentSnapshot
    FROM drafts
    JOIN contents ON contents.id=drafts.content_id
    LEFT JOIN finalization_outbox ON finalization_outbox.draft_id=drafts.id
    WHERE drafts.status='finalized'
      AND NOT EXISTS (
        SELECT 1 FROM drafts newer
        WHERE newer.chapter_number=drafts.chapter_number AND newer.status='finalized'
          AND (newer.version>drafts.version OR newer.version=drafts.version AND newer.id>drafts.id)
      )
    ORDER BY drafts.chapter_number, drafts.version DESC, drafts.id DESC
  `).all() as FinalizedRow[]
  const finalized = finalizedRows.filter(row => {
    if (!positiveChapter(row.draftId) || !positiveChapter(row.chapterNumber) || !positiveChapter(row.version)
      || typeof row.body !== 'string' || !row.body.trim()) return false
    return row.finalizationId !== null && Boolean(row.finalizationId.trim())
      && row.outboxChapterNumber === row.chapterNumber
      && row.contentSnapshot === row.body && row.contentHash === digest(row.body)
  })
  const finalizedChapters = chapterNumbers(finalized)
  const totalWords = currentDrafts.reduce((total, row) => total
    + (Number.isSafeInteger(row.wordCount) && row.wordCount >= 0 ? row.wordCount : 0), 0)
  const characters = Number(database.prepare('SELECT COUNT(*) FROM characters WHERE retired=0').pluck().get())
  const plannedChapters = Number.isSafeInteger(core.totalChapters) ? core.totalChapters : 0
  const stages: ProjectOverviewStage[] = [
    { id: 'configuration', status: configurationCount === 9 ? 'completed' : configurationCount ? 'in-progress' : 'not-started', count: configurationCount },
    { id: 'architecture', status: architectureCount === 4 ? 'completed' : architectureCount ? 'in-progress' : 'not-started', count: architectureCount },
    { id: 'blueprint', status: plannedStatus(blueprints, plannedChapters), count: blueprints.length },
    { id: 'drafting', status: plannedStatus(draftChapters, plannedChapters), count: draftChapters.length },
    { id: 'review', status: plannedStatus(reviewChapters, plannedChapters), count: reviewChapters.length },
    { id: 'finalization', status: plannedStatus(finalizedChapters, plannedChapters), count: finalizedChapters.length },
  ]
  const latestDraftBody = includeExcerpt
    ? database.prepare(`
      SELECT contents.body
      FROM drafts
      JOIN contents ON contents.id=drafts.content_id
      WHERE drafts.status IN ('draft','revised','finalized')
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number=drafts.chapter_number
            AND newer.status IN ('draft','revised','finalized')
            AND (newer.version>drafts.version OR newer.version=drafts.version AND newer.id>drafts.id)
        )
      ORDER BY drafts.chapter_number DESC, drafts.version DESC, drafts.id DESC
      LIMIT 1
    `).pluck().get() as string | undefined
    : undefined
  const facts = {
    projectId,
    physicalRevision,
    core,
    totalWords,
    characters,
    stages,
    finalized: finalized.map(row => [row.draftId, row.chapterNumber, row.version, row.finalizationId, row.contentHash]),
  }
  return Object.freeze({
    state: 'ready',
    projectId,
    revision: digest(JSON.stringify(facts)),
    name: core.projectName.trim(),
    totalWords,
    characters: Number.isSafeInteger(characters) && characters >= 0 ? characters : 0,
    finalizedChapters: finalizedChapters.length,
    stages: Object.freeze(stages),
    ...(latestDraftBody ? { excerpt: tailExcerpt(latestDraftBody) } : {}),
  })
}

export class ProjectPeekService {
  private readonly scratchRoot: string
  private readonly newCapabilityId: () => string
  private readonly capabilities = new Map<string, CapabilityState>()
  private readonly capabilityByRoot = new Map<string, string>()

  constructor(options: ProjectPeekServiceOptions = {}) {
    this.scratchRoot = path.resolve(options.scratchRoot ?? path.join(
      process.env.LOCALAPPDATA || os.tmpdir(),
      'VibeCodingScratch',
      'ai-novel-writer',
      'project-peek',
    ))
    this.newCapabilityId = options.newCapabilityId ?? randomUUID
  }

  issueCapability(projectPath: string): ProjectPeekCapability | null {
    try {
      const state = readManifest(projectPath)
      const existingId = this.capabilityByRoot.get(pathKey(state.rootPath))
      const existing = existingId ? this.capabilities.get(existingId) : undefined
      if (existing && existing.projectId === state.projectId
        && existing.manifestFingerprint === state.manifestFingerprint
        && existing.storageVersion === state.storageVersion) {
        return Object.freeze({ capabilityId: existing.capabilityId, projectId: existing.projectId })
      }
      if (existingId) this.revokeCapability(existingId)
      const capabilityId = this.newCapabilityId()
      const capability: CapabilityState = {
        ...state,
        capabilityId,
        expectedSchemaVersion: CURRENT_DESKTOP_SCHEMA_VERSION,
      }
      this.capabilities.set(capabilityId, capability)
      this.capabilityByRoot.set(pathKey(state.rootPath), capabilityId)
      return Object.freeze({ capabilityId, projectId: state.projectId })
    } catch {
      return null
    }
  }

  revokeCapability(capabilityId: string): void {
    const capability = this.capabilities.get(capabilityId)
    if (!capability) return
    this.capabilities.delete(capabilityId)
    if (this.capabilityByRoot.get(pathKey(capability.rootPath)) === capabilityId) {
      this.capabilityByRoot.delete(pathKey(capability.rootPath))
    }
  }

  peek(capabilityId: string): ProjectOverview {
    const capability = this.capabilities.get(capabilityId)
    if (!capability) return UNAVAILABLE
    try {
      const current = readManifest(capability.rootPath)
      if (!this.matchesCapability(capability, current)) return UNAVAILABLE
      const overview = this.readSnapshot(capability)
      return this.matchesCapability(capability, readManifest(capability.rootPath)) ? overview : UNAVAILABLE
    } catch {
      return UNAVAILABLE
    }
  }

  readCurrent(projectId: string, database: BetterSqlite3.Database): ProjectOverview {
    try {
      if (!projectId) return UNAVAILABLE
      verifySchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      return aggregateProject(database, projectId, true)
    } catch {
      return UNAVAILABLE
    }
  }

  private readSnapshot(capability: CapabilityState): ProjectOverview {
    const before = sourceState(capability.databasePath)
    fs.mkdirSync(this.scratchRoot, { recursive: true })
    const attempt = fs.mkdtempSync(path.join(this.scratchRoot, 'attempt-'))
    const snapshotPath = path.join(attempt, 'snapshot.db')
    let database: BetterSqlite3.Database | undefined
    try {
      fs.writeFileSync(path.join(attempt, '.vibe-owner.json'), JSON.stringify({
        owner: 'AI-Novel-Writer project peek',
        sourceProject: capability.projectId,
        createdAt: new Date().toISOString(),
        ttlHours: 1,
        reason: 'Ephemeral read-only project overview snapshot.',
        cleanupCommand: `Remove-Item -LiteralPath '${attempt.replaceAll("'", "''")}' -Recurse -Force`,
      }), { flag: 'wx' })
      for (const file of before) fs.copyFileSync(
        capability.databasePath + file.suffix,
        snapshotPath + file.suffix,
        fs.constants.COPYFILE_EXCL,
      )
      const copied = sourceState(snapshotPath)
      const after = sourceState(capability.databasePath)
      if (!sameSnapshotContent(before, copied) || JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error('PROJECT_PEEK_SOURCE_CHANGED')
      }
      database = new Database(snapshotPath, { readonly: true, fileMustExist: true })
      database.pragma('foreign_keys = ON')
      verifySchema(new SqliteSchemaAdapter(database), getDesktopMigrationRegistry(), capability.expectedSchemaVersion)
      const physicalRevision = digest(JSON.stringify({
        manifest: capability.manifestFingerprint,
        files: before.map(file => [file.suffix, file.size, file.hash]),
      }))
      return aggregateProject(database, capability.projectId, false, physicalRevision)
    } finally {
      database?.close()
      fs.rmSync(attempt, { recursive: true, force: true })
    }
  }

  private matchesCapability(capability: CapabilityState, current: ManifestState): boolean {
    return current.rootPath === capability.rootPath
      && current.databasePath === capability.databasePath
      && current.projectId === capability.projectId
      && current.manifestFingerprint === capability.manifestFingerprint
      && current.storageVersion === capability.storageVersion
      && capability.expectedSchemaVersion === CURRENT_DESKTOP_SCHEMA_VERSION
  }
}

export const projectPeekService = new ProjectPeekService()
