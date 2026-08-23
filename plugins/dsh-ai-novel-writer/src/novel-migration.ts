/**
 * Explicit, restart-safe conversion from the V1 file assets to the V2 SQLite store.
 */

import { createHash } from 'node:crypto'
import { access, link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from '@deepseek-ai/dsh-workspace'
import type { NovelProjectId } from './types.ts'
import {
  createMigratedNovelStoreFile,
  ensureProjectDirectory,
  NovelStoreError,
  openNovelStore,
} from './novel-store.ts'
import type {
  NovelArchitectureNextValue,
  NovelArtifactSeed,
  NovelChapterNextValue,
  NovelCharactersNextValue,
  NovelMigrationReceipt,
  NovelMigrationSeed,
  NovelProjectNextValue,
} from './novel-store.ts'

export type { NovelMigrationReceipt }

/** One read-only source file represented in a migration preview. */
export interface NovelV1SourcePreview {
  readonly source: string
  readonly revision: string
  readonly bytes: number
}

/** Read-only migration preview shown before an explicit import is allowed. */
export interface NovelV1MigrationPreview {
  readonly projectId: NovelProjectId
  readonly fingerprint: string
  readonly archivePath: string
  readonly alreadyMigrated: boolean
  readonly resumable: boolean
  readonly sourceCount: number
  readonly characterCount: number
  readonly relationshipCount: number
  readonly chapterCount: number
  readonly draftCount: number
  readonly sources: readonly NovelV1SourcePreview[]
  readonly receipt: NovelMigrationReceipt | undefined
}

interface SourceRecord {
  readonly source: string
  readonly bytes: Buffer
}

interface V1Project {
  readonly projectId: NovelProjectId
  readonly project: NovelProjectNextValue
}

interface V1Story {
  readonly premise: string
  readonly world: string
  readonly mainPlot: string
}

interface V1Character {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly summary: string
  readonly goal: string
  readonly relationships: readonly {
    readonly characterId: string
    readonly type: string
    readonly summary: string
  }[]
  readonly notes: string
}

interface V1Chapter {
  readonly chapter: number
  readonly title: string
  readonly purpose: string
  readonly beats: readonly string[]
  readonly characterIds: readonly string[]
  readonly status: 'planned' | 'drafting' | 'drafted' | 'revised' | 'final'
}

interface PreparedMigration {
  readonly root: string
  readonly fingerprint: string
  readonly records: readonly SourceRecord[]
  readonly project: V1Project
  readonly architecture: NovelArchitectureNextValue
  readonly characters: NovelCharactersNextValue
  readonly chapters: readonly NovelChapterNextValue[]
  readonly artifacts: readonly NovelArtifactSeed[]
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NovelStoreError('CANCELLED', 'V1 migration operation was cancelled')
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelStoreError('INVALID_CONTENT', `${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new NovelStoreError('INVALID_CONTENT', `${label} contains missing or unknown fields`)
  }
  return record
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a non-empty string`)
  }
  return value
}

function anyString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new NovelStoreError('INVALID_CONTENT', `${field} must be a string`)
  return value
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be an array of strings`)
  }
  return value as readonly string[]
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a positive integer`)
  }
  return value
}

function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field)
  const time = Date.parse(text)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new NovelStoreError('INVALID_CONTENT', `${field} must be a canonical UTC timestamp`)
  }
  return text
}

function jsonRecord(bytes: Buffer, source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new NovelStoreError('INVALID_CONTENT', `${source} is not valid JSON`, { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelStoreError('INVALID_CONTENT', `${source} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseProject(record: Record<string, unknown>): V1Project {
  const value = exactKeys(record, [
    'formatVersion', 'kind', 'projectId', 'title', 'language', 'genre', 'plannedChapters',
    'targetWordsPerChapter', 'creativeStrategy', 'createdAt', 'updatedAt',
  ], 'project.json')
  if (value.formatVersion !== 1 || value.kind !== 'harness-novel-project') {
    throw new NovelStoreError('UNSUPPORTED_FORMAT', 'project.json is not a Harness V1 project')
  }
  const projectId = nonEmptyString(value.projectId, 'project.json.projectId')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new NovelStoreError('INVALID_CONTENT', 'project.json.projectId must be a UUID')
  }
  const creativeStrategy = nonEmptyString(value.creativeStrategy, 'project.json.creativeStrategy')
  if (!['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'].includes(creativeStrategy)) {
    throw new NovelStoreError('INVALID_CONTENT', 'project.json.creativeStrategy is not supported')
  }
  return {
    projectId: projectId as NovelProjectId,
    project: {
      title: nonEmptyString(value.title, 'project.json.title'),
      language: nonEmptyString(value.language, 'project.json.language'),
      genre: nonEmptyString(value.genre, 'project.json.genre'),
      plannedChapters: positiveInteger(value.plannedChapters, 'project.json.plannedChapters'),
      targetWordsPerChapter: positiveInteger(value.targetWordsPerChapter, 'project.json.targetWordsPerChapter'),
      creativeStrategy: creativeStrategy as NovelProjectNextValue['creativeStrategy'],
      structureMode: 'three-act',
      narrativePov: 'third-limited',
      globalGuidance: '',
      createdAt: isoTimestamp(value.createdAt, 'project.json.createdAt'),
      updatedAt: isoTimestamp(value.updatedAt, 'project.json.updatedAt'),
    },
  }
}

function parseCharacters(record: Record<string, unknown> | undefined): NovelCharactersNextValue {
  if (record === undefined) return { items: [], relationships: [] }
  const value = exactKeys(record, ['characters'], 'characters.json')
  if (!Array.isArray(value.characters)) throw new NovelStoreError('INVALID_CONTENT', 'characters must be an array')
  const characters = value.characters.map(item => {
    const character = exactKeys(item, [
      'id', 'name', 'role', 'summary', 'goal', 'relationships', 'notes',
    ], 'character')
    return {
      id: nonEmptyString(character.id, 'character.id'),
      name: nonEmptyString(character.name, 'character.name'),
      role: nonEmptyString(character.role, 'character.role'),
      summary: nonEmptyString(character.summary, 'character.summary'),
      goal: nonEmptyString(character.goal, 'character.goal'),
      relationships: Array.isArray(character.relationships) ? character.relationships.map(relation => {
        const fields = exactKeys(relation, ['characterId', 'type', 'summary'], 'relationship')
        return {
          characterId: nonEmptyString(fields.characterId, 'relationship.characterId'),
          type: nonEmptyString(fields.type, 'relationship.type'),
          summary: nonEmptyString(fields.summary, 'relationship.summary'),
        }
      }) : (() => {
        throw new NovelStoreError('INVALID_CONTENT', 'character.relationships must be an array')
      })(),
      notes: anyString(character.notes, 'character.notes'),
    } satisfies V1Character
  })
  const ids = new Set(characters.map(character => character.id))
  if (ids.size !== characters.length) throw new NovelStoreError('INVALID_CONTENT', 'character.id must be unique')
  const relationships = characters.flatMap(character => character.relationships.map(relationship => {
    if (!ids.has(relationship.characterId)) {
      throw new NovelStoreError('INVALID_CONTENT', 'relationship references an unknown character')
    }
    return {
      fromCharacterId: character.id,
      toCharacterId: relationship.characterId,
      relation: relationship.type,
      notes: relationship.summary,
    }
  }))
  const relationshipKeys = new Set(relationships.map(item => `${item.fromCharacterId}\0${item.toCharacterId}\0${item.relation}`))
  if (relationshipKeys.size !== relationships.length) {
    throw new NovelStoreError('INVALID_CONTENT', 'relationship must be unique after V1 conversion')
  }
  return {
    items: characters.map(character => ({
      characterId: character.id,
      name: character.name,
      role: character.role,
      summary: character.summary,
      goal: character.goal,
      currentState: '',
      notes: character.notes,
    })),
    relationships,
  }
}

function parseStory(record: Record<string, unknown> | undefined): NovelArchitectureNextValue {
  if (record === undefined) {
    return {
      premise: '', characterGraph: '', world: '', plotOutline: '', styleConstraints: '', referenceWorks: [],
    }
  }
  const value = exactKeys(record, ['premise', 'themes', 'world', 'mainPlot', 'endingGoal'], 'story.json')
  const story: V1Story = {
    premise: nonEmptyString(value.premise, 'story.premise'),
    world: nonEmptyString(value.world, 'story.world'),
    mainPlot: nonEmptyString(value.mainPlot, 'story.mainPlot'),
  }
  stringArray(value.themes, 'story.themes')
  nonEmptyString(value.endingGoal, 'story.endingGoal')
  return {
    premise: story.premise,
    characterGraph: '',
    world: story.world,
    plotOutline: story.mainPlot,
    styleConstraints: '',
    referenceWorks: [],
  }
}

function parseChapter(record: Record<string, unknown>, characters: ReadonlySet<string>): V1Chapter {
  const value = exactKeys(record, [
    'chapter', 'title', 'purpose', 'beats', 'characterIds', 'continuityNotes', 'status',
  ], 'chapter blueprint')
  const chapter = positiveInteger(value.chapter, 'chapter.chapter')
  if (chapter > 9_999) throw new NovelStoreError('INVALID_CONTENT', 'chapter must be between 1 and 9999')
  const characterIds = stringArray(value.characterIds, 'chapter.characterIds')
  if (new Set(characterIds).size !== characterIds.length) {
    throw new NovelStoreError('INVALID_CONTENT', 'chapter.characterIds must be unique')
  }
  if (characterIds.some(id => !characters.has(id))) {
    throw new NovelStoreError('INVALID_CONTENT', 'chapter references an unknown character')
  }
  const rawStatus = anyString(value.status, 'chapter.status')
  if (!['planned', 'drafting', 'drafted', 'revised', 'final'].includes(rawStatus)) {
    throw new NovelStoreError('INVALID_CONTENT', 'chapter.status is not supported')
  }
  stringArray(value.continuityNotes, 'chapter.continuityNotes')
  return {
    chapter,
    title: nonEmptyString(value.title, 'chapter.title'),
    purpose: nonEmptyString(value.purpose, 'chapter.purpose'),
    beats: stringArray(value.beats, 'chapter.beats'),
    characterIds,
    status: rawStatus as V1Chapter['status'],
  }
}

function statusMapping(status: V1Chapter['status']): NovelChapterNextValue['status'] {
  if (status === 'drafted') return 'reviewing'
  if (status === 'final') return 'finalized'
  return status === 'revised' ? 'revising' : status
}

async function canonicalRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new NovelStoreError('PATH_REJECTED', 'workspace root must be absolute')
  try {
    const configured = await lstat(root)
    if (!configured.isDirectory() || configured.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', 'workspace root must be a real directory')
    }
  } catch (cause) {
    if (cause instanceof NovelStoreError) throw cause
    throw new NovelStoreError('PATH_REJECTED', 'workspace root does not exist', { cause })
  }
  let canonical: string
  try {
    canonical = await realpath(root)
  } catch (cause) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root does not exist', { cause })
  }
  const rel = relative(root, canonical)
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`))) {
    throw new NovelStoreError('PATH_REJECTED', 'workspace root resolves outside its configured path')
  }
  return canonical
}

async function realDirectory(path: string, label: string, missing: 'reject' | 'empty'): Promise<boolean> {
  try {
    const value = await lstat(path)
    if (!value.isDirectory() || value.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', `${label} must be a real directory`)
    }
    return true
  } catch (cause) {
    if (cause instanceof NovelStoreError) throw cause
    if (missing === 'empty' && isMissing(cause)) return false
    throw cause
  }
}

async function optionalRealFile(path: string, source: string): Promise<Buffer | undefined> {
  try {
    const value = await lstat(path)
    if (!value.isFile() || value.isSymbolicLink()) {
      throw new NovelStoreError('PATH_REJECTED', `${source} must be a real file`)
    }
    return await readFile(path)
  } catch (cause) {
    if (cause instanceof NovelStoreError) throw cause
    if (isMissing(cause)) return undefined
    throw cause
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
}

async function numberedFiles(
  directory: string,
  extension: '.json' | '.md',
  sourcePrefix: string,
): Promise<Map<number, SourceRecord>> {
  if (!await realDirectory(directory, sourcePrefix, 'empty')) return new Map()
  const entries = await readdir(directory, { withFileTypes: true })
  const result = new Map<number, SourceRecord>()
  for (const entry of entries) {
    const match = /^([0-9]{4})\.json$|^([0-9]{4})\.md$/.exec(entry.name)
    const matchedExtension = entry.name.endsWith(extension)
    if (!matchedExtension || match === null) continue
    const chapter = Number.parseInt(match[1] ?? match[2] ?? '', 10)
    const path = join(directory, entry.name)
    const bytes = await optionalRealFile(path, `${sourcePrefix}/${entry.name}`)
    if (bytes === undefined) continue
    if (result.has(chapter)) throw new NovelStoreError('INVALID_CONTENT', `duplicate numbered V1 asset: chapter ${chapter}`)
    result.set(chapter, { source: `${sourcePrefix}/${entry.name}`, bytes })
  }
  return result
}

function fingerprintOf(records: readonly SourceRecord[]): string {
  const hash = createHash('sha256')
  for (const record of [...records].sort((left, right) => left.source.localeCompare(right.source))) {
    hash.update(Buffer.from(record.source, 'utf8'))
    hash.update('\0')
    hash.update(record.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function prepare(root: string): Promise<PreparedMigration> {
  const canonical = await canonicalRoot(root)
  const projectDirectory = join(canonical, '.ai-novel')
  if (!await realDirectory(projectDirectory, '.ai-novel', 'empty')) {
    throw new NovelStoreError('NOT_INITIALIZED', 'Harness V1 project was not found')
  }
  const projectBytes = await optionalRealFile(join(projectDirectory, 'project.json'), '.ai-novel/project.json')
  if (projectBytes === undefined) throw new NovelStoreError('NOT_INITIALIZED', 'Harness V1 project was not found')
  const characterBytes = await optionalRealFile(join(projectDirectory, 'characters.json'), '.ai-novel/characters.json')
  await realDirectory(join(projectDirectory, 'blueprints'), '.ai-novel/blueprints', 'empty')
  const storyBytes = await optionalRealFile(
    join(projectDirectory, 'blueprints', 'story.json'),
    '.ai-novel/blueprints/story.json',
  )
  const chapterRecords = await numberedFiles(
    join(projectDirectory, 'blueprints', 'chapters'),
    '.json',
    '.ai-novel/blueprints/chapters',
  )
  const draftRecords = await numberedFiles(join(canonical, 'chapters'), '.md', 'chapters')

  const records: SourceRecord[] = [
    { source: '.ai-novel/project.json', bytes: projectBytes },
    ...characterBytes === undefined ? [] : [{ source: '.ai-novel/characters.json', bytes: characterBytes }],
    ...storyBytes === undefined ? [] : [{ source: '.ai-novel/blueprints/story.json', bytes: storyBytes }],
    ...[...chapterRecords.values()],
    ...[...draftRecords.values()],
  ].sort((left, right) => left.source.localeCompare(right.source))
  const fingerprint = fingerprintOf(records)

  const project = parseProject(jsonRecord(projectBytes, '.ai-novel/project.json'))
  const characters = parseCharacters(characterBytes === undefined ? undefined : jsonRecord(characterBytes, '.ai-novel/characters.json'))
  const architecture = parseStory(storyBytes === undefined ? undefined : jsonRecord(storyBytes, '.ai-novel/blueprints/story.json'))
  const characterIds = new Set(characters.items.map(item => item.characterId))
  const parsedChapters = [...chapterRecords.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, record]) => parseChapter(jsonRecord(record.bytes, record.source), characterIds))
  const chapterNumbers = new Set(parsedChapters.map(chapter => chapter.chapter))
  const chapters: NovelChapterNextValue[] = parsedChapters.map(chapter => ({
    chapter: chapter.chapter,
    title: chapter.title,
    purpose: chapter.purpose,
    plotBeats: chapter.beats,
    characters: chapter.characterIds,
    keyEvents: [],
    suspense: '',
    status: statusMapping(chapter.status),
  }))
  for (const chapter of draftRecords.keys()) {
    if (chapterNumbers.has(chapter)) continue
    chapters.push({
      chapter,
      title: `第 ${chapter} 章`,
      purpose: `保留 V1 第 ${chapter} 章正文。`,
      plotBeats: [],
      characters: [],
      keyEvents: [],
      suspense: '',
      status: 'drafting',
    })
  }
  chapters.sort((left, right) => left.chapter - right.chapter)
  const artifacts = [...draftRecords.entries()]
    .sort(([left], [right]) => left - right)
    .map(([chapter, record]) => ({
      artifactId: `v1-draft-${fingerprint}-chapter-${chapter}`,
      chapter,
      kind: 'draft' as const,
      content: record.bytes.toString('utf8').replace(/\r\n?/g, '\n'),
      createdAt: project.project.updatedAt,
    }))
  return {
    root: canonical,
    fingerprint,
    records,
    project,
    architecture,
    characters,
    chapters,
    artifacts,
  }
}

function previewOf(prepared: PreparedMigration, alreadyMigrated: boolean, resumable: boolean, receipt?: NovelMigrationReceipt): NovelV1MigrationPreview {
  return {
    projectId: prepared.project.projectId,
    fingerprint: prepared.fingerprint,
    archivePath: `.ai-novel/v1-archive/${prepared.fingerprint}`,
    alreadyMigrated,
    resumable,
    sourceCount: prepared.records.length,
    characterCount: prepared.characters.items.length,
    relationshipCount: prepared.characters.relationships.length,
    chapterCount: prepared.chapters.length,
    draftCount: prepared.artifacts.length,
    sources: prepared.records.map(record => ({
      source: record.source,
      revision: sha256(record.bytes),
      bytes: record.bytes.length,
    })),
    receipt,
  }
}

async function existingReceipt(root: string): Promise<NovelMigrationReceipt | undefined> {
  let store: Awaited<ReturnType<typeof openNovelStore>> | undefined
  try {
    store = await openNovelStore(root, WorkspaceId('00000000-0000-0000-0000-000000000000'))
    const state = await store.read(new AbortController().signal)
    return state.migration
  } finally {
    await store?.dispose()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (isMissing(cause)) return false
    throw cause
  }
}

async function ensureInsideArchive(root: string, path: string): Promise<void> {
  const real = await realpath(path)
  const rel = relative(root, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new NovelStoreError('PATH_REJECTED', 'archive destination escapes the fingerprinted archive')
  }
}

async function rejectArchiveDrift(root: string, fingerprint: string): Promise<boolean> {
  const archiveRoot = join(root, '.ai-novel', 'v1-archive')
  if (!await realDirectory(archiveRoot, 'V1 archive root', 'empty')) return false
  const entries = await readdir(archiveRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue
    await realDirectory(join(archiveRoot, entry.name), `V1 archive ${entry.name}`, 'reject')
    if (entry.name !== fingerprint) {
      throw new NovelStoreError('STALE_REVISION', 'V1 sources changed since the archived migration')
    }
  }
  return true
}

async function archiveSources(prepared: PreparedMigration): Promise<string> {
  await ensureProjectDirectory(prepared.root, true)
  const archivePath = join(prepared.root, '.ai-novel', 'v1-archive', prepared.fingerprint)
  if (await pathExists(archivePath)) {
    if (!await realDirectory(archivePath, 'V1 fingerprint archive', 'reject')) throw new NovelStoreError('PATH_REJECTED', 'V1 fingerprint archive must be a real directory')
    await ensureInsideArchive(archivePath, archivePath)
  } else {
    await mkdir(archivePath, { recursive: true, mode: 0o700 })
  }
  for (const record of prepared.records) {
    const destination = join(archivePath, record.source)
    const temporary = `${destination}.staging`
    await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
    await ensureInsideArchive(archivePath, join(destination, '..'))
    if (await pathExists(destination)) {
      const existing = await optionalRealFile(destination, record.source)
      if (existing === undefined || !existing.equals(record.bytes)) {
        throw new NovelStoreError('STALE_REVISION', `archived V1 source does not match: ${record.source}`)
      }
      continue
    }
    await rm(temporary, { force: true })
    try {
      await writeFile(temporary, record.bytes, { flag: 'wx', mode: 0o600 })
      const handle = await open(temporary, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await link(temporary, destination)
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST') {
        const existing = await optionalRealFile(destination, record.source)
        if (existing !== undefined && existing.equals(record.bytes)) continue
      }
      throw new NovelStoreError('WRITE_FAILED', `failed to archive V1 source: ${record.source}`, { cause })
    }
    await rm(temporary, { force: true })
  }
  return archivePath
}

async function cleanupPublishedStaging(root: string, fingerprint: string): Promise<void> {
  const stagingPath = join(
    root,
    '.ai-novel',
    'v1-archive',
    fingerprint,
    '.novel.db.staging',
  )
  try {
    await removeStaging(stagingPath)
  } catch {
    // Preview remains read-only; a later explicit migration retries this cleanup.
  }
}

async function removeStaging(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-journal`, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ])
}

async function requireNoSidecars(path: string): Promise<void> {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      await access(`${path}${suffix}`)
    } catch (cause) {
      if (isMissing(cause)) continue
      throw cause
    }
    throw new NovelStoreError('WRITE_FAILED', `migration staging database still has a ${suffix} sidecar`)
  }
}

async function requireSourceSnapshotUnchanged(prepared: PreparedMigration): Promise<void> {
  let current: PreparedMigration
  try {
    current = await prepare(prepared.root)
  } catch (cause) {
    if (cause instanceof NovelStoreError && (
      cause.code === 'NOT_INITIALIZED' || cause.code === 'INVALID_CONTENT' || cause.code === 'UNSUPPORTED_FORMAT'
    )) {
      throw new NovelStoreError('STALE_REVISION', 'V1 sources changed during explicit migration', { cause })
    }
    throw cause
  }
  if (current.fingerprint !== prepared.fingerprint) {
    throw new NovelStoreError('STALE_REVISION', 'V1 sources changed during explicit migration')
  }
}

async function publishStaging(stagingPath: string, databasePath: string): Promise<void> {
  const handle = await open(stagingPath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await requireNoSidecars(stagingPath)
  if (await pathExists(databasePath)) {
    throw new NovelStoreError('ALREADY_INITIALIZED', 'novel.db appeared before V1 migration publication')
  }
  try {
    await link(stagingPath, databasePath)
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST') {
      throw new NovelStoreError('ALREADY_INITIALIZED', 'novel.db appeared before V1 migration publication')
    }
    throw new NovelStoreError('WRITE_FAILED', 'failed to publish migration database without replacement', { cause })
  }
  try {
    await rm(stagingPath, { force: true })
  } catch {
    // The published database is authoritative; an ignored leftover staging name is recovered on retry.
  }
}

/**
 * Read and validate one V1 project without changing its source files.
 *
 * @param root Absolute workspace root that may contain `.ai-novel/project.json`.
 * @param signal Cancellation signal checked before filesystem work.
 * @returns Fingerprint, source revisions, converted counts, and any published migration receipt.
 * @throws {@link NovelStoreError} when no V1 project exists, content is invalid, or published sources drifted.
 */
export async function previewV1NovelMigration(root: string, signal: AbortSignal): Promise<NovelV1MigrationPreview> {
  requireNotAborted(signal)
  const canonical = await canonicalRoot(root)
  const databasePath = join(canonical, '.ai-novel', 'novel.db')
  if (await pathExists(databasePath)) {
    const receipt = await existingReceipt(canonical)
    if (receipt === undefined) throw new NovelStoreError('UNSUPPORTED_FORMAT', 'novel.db has no V1 migration receipt')
    try {
      const prepared = await prepare(canonical)
      if (prepared.fingerprint !== receipt.fingerprint) {
        throw new NovelStoreError('STALE_REVISION', 'V1 sources changed after migration')
      }
      return previewOf(prepared, true, false, receipt)
    } catch (cause) {
      if (cause instanceof NovelStoreError && (cause.code === 'NOT_INITIALIZED' || cause.code === 'INVALID_CONTENT' || cause.code === 'UNSUPPORTED_FORMAT')) {
        throw new NovelStoreError('STALE_REVISION', 'V1 sources changed after migration', { cause })
      }
      throw cause
    }
  }
  const prepared = await prepare(canonical)
  const archivePath = join(canonical, '.ai-novel', 'v1-archive', prepared.fingerprint)
  const resumable = await rejectArchiveDrift(canonical, prepared.fingerprint)
  return previewOf(prepared, false, resumable && await pathExists(archivePath))
}

/**
 * Explicitly import a previewed V1 project through an archived staging database.
 *
 * @param root Absolute workspace root containing the V1 project.
 * @param workspaceId Opaque DSH Workspace identity for the V2 binding.
 * @param previewFingerprint SHA-256 fingerprint returned by the preview shown to the user.
 * @param signal Cancellation signal checked before publication.
 * @returns Receipt persisted in the published V2 database.
 * @throws {@link NovelStoreError} for invalid content, preview mismatch, archive drift, or publication failure.
 */
export async function migrateV1NovelProject(
  root: string,
  workspaceId: WorkspaceIdType,
  previewFingerprint: string,
  signal: AbortSignal,
): Promise<NovelMigrationReceipt> {
  requireNotAborted(signal)
  if (!/^[a-f0-9]{64}$/.test(previewFingerprint)) {
    throw new NovelStoreError('INVALID_CONTENT', 'preview fingerprint must be a SHA-256 digest')
  }
  const preview = await previewV1NovelMigration(root, signal)
  if (preview.fingerprint !== previewFingerprint) {
    throw new NovelStoreError('STALE_REVISION', 'V1 sources changed since the preview shown to the user')
  }
  if (preview.alreadyMigrated) {
    if (preview.receipt === undefined) throw new NovelStoreError('INVALID_CONTENT', 'published migration receipt is missing')
    await cleanupPublishedStaging(await canonicalRoot(root), preview.receipt.fingerprint)
    return preview.receipt
  }

  const prepared = await prepare(await canonicalRoot(root))
  if (prepared.fingerprint !== previewFingerprint) {
    throw new NovelStoreError('STALE_REVISION', 'V1 sources changed since the preview shown to the user')
  }
  const archivePath = await archiveSources(prepared)
  const stagingPath = join(archivePath, '.novel.db.staging')
  await removeStaging(stagingPath)
  let published = false
  const databasePath = join(prepared.root, '.ai-novel', 'novel.db')
  try {
    const receipt = await createMigratedNovelStoreFile(stagingPath, prepared.root, {
      projectId: prepared.project.projectId,
      workspaceId,
      project: prepared.project.project,
      architecture: prepared.architecture,
      characters: prepared.characters,
      chapters: prepared.chapters,
      artifacts: prepared.artifacts,
      fingerprint: prepared.fingerprint,
      archivePath: `.ai-novel/v1-archive/${prepared.fingerprint}`,
      sourceCount: prepared.records.length,
      migratedAt: new Date().toISOString(),
    } satisfies NovelMigrationSeed)
    requireNotAborted(signal)
    await requireSourceSnapshotUnchanged(prepared)
    await publishStaging(stagingPath, databasePath)
    published = true
    let store: Awaited<ReturnType<typeof openNovelStore>> | undefined
    try {
      store = await openNovelStore(prepared.root, workspaceId)
      const state = await store.read(signal)
      if (state.migration === undefined || state.migration.fingerprint !== receipt.fingerprint) {
        throw new NovelStoreError('WRITE_FAILED', 'published migration database failed verification')
      }
      return state.migration
    } finally {
      await store?.dispose()
    }
  } catch (cause) {
    if (published) {
      if (cause instanceof NovelStoreError) throw cause
      throw new NovelStoreError('WRITE_FAILED', 'published migration database failed verification and remains published', {
        cause,
      })
    }
    await removeStaging(stagingPath)
    if (cause instanceof NovelStoreError) throw cause
    throw new NovelStoreError('WRITE_FAILED', 'explicit V1 migration failed', { cause })
  }
}
