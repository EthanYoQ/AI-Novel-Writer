import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import {
  assertProjectCoreStoragePathSupported,
  assertProjectStoragePathSupported,
  type ProjectStoragePreflightOptions,
} from './project-storage-preflight'

export const PROJECT_MANIFEST_RELATIVE_PATH = path.join('.vela', 'project.json')
export const PROJECT_ROOT_REQUIRED = 'PROJECT_ROOT_REQUIRED' as const
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const LEGACY_REQUIRED_TABLES = new Set([
  'project_core',
  'blueprints',
  'characters',
  'contents',
  'drafts',
])
const LEGACY_PROJECT_CORE_COLUMNS = new Set([
  'id',
  'project_name',
  'genre',
  'total_chapters',
  'character_states',
])

interface ProjectManifest {
  schemaVersion: 1
  kind: 'ai-novel-project'
  projectId: string
  createdAt: string
}

export class ProjectRootRequiredError extends Error {
  readonly code = PROJECT_ROOT_REQUIRED

  constructor() {
    super('所选目录不是项目根目录：目录缺少有效项目清单或可信旧版指纹')
    this.name = 'ProjectRootRequiredError'
  }
}

export interface TrustedProject {
  kind: 'manifest'
  projectId: string
  rootPath: string
}

export interface LegacyProjectProbe {
  kind: 'legacy'
  rootPath: string
  legacyFingerprint: 'vela-sqlite-v1'
}

export type ProjectProbe = TrustedProject | LegacyProjectProbe

export interface ProjectSessionLease extends TrustedProject {
  leaseId: string
}

/**
 * Renderer-visible portion of a lease. #21 can pass this through additional
 * project-level IPC channels without exposing the canonical root as authority.
 */
export interface ProjectSessionCredential {
  projectId: string
  leaseId: string
}

export interface ProjectAccessServiceOptions extends ProjectStoragePreflightOptions {
  homePath?: string
  newLeaseId?: () => string
}

function projectPathKey(projectPath: string): string {
  return path.normalize(projectPath).toLocaleLowerCase('en-US')
}

function isContainedPath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(projectPathKey(rootPath), projectPathKey(targetPath))
  return (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function sanitizeProjectDirectoryName(name: string): string {
  const trimmed = name.trim()
  const baseName = trimmed.split(/[\\/]/).pop() || trimmed
  const withoutReservedCharacters = baseName.replace(/[<>:"/\\|?*]/g, '_')
  const sanitized = [...withoutReservedCharacters]
    .map(character => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('')
    .trim()
  return sanitized || '未命名项目'
}

function isProjectManifest(value: unknown): value is ProjectManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<ProjectManifest>
  return (
    manifest.schemaVersion === 1
    && manifest.kind === 'ai-novel-project'
    && typeof manifest.projectId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.projectId)
    && typeof manifest.createdAt === 'string'
    && !Number.isNaN(Date.parse(manifest.createdAt))
  )
}

export class ProjectAccessService {
  private readonly homePath: string
  private readonly newLeaseId: () => string
  private readonly storagePreflightOptions: ProjectStoragePreflightOptions
  private activeSession: ProjectSessionLease | null = null

  constructor(options: ProjectAccessServiceOptions = {}) {
    const configuredHome = options.homePath ?? os.homedir()
    this.homePath = path.resolve(configuredHome)
    if (fs.existsSync(configuredHome)) {
      try {
        this.homePath = path.normalize(fs.realpathSync.native(configuredHome))
      } catch {
        // 受限运行环境可能不允许解析主目录；项目根 probe 仍必须 realpath。
      }
    }
    this.newLeaseId = options.newLeaseId ?? randomUUID
    this.storagePreflightOptions = {
      platform: options.platform,
      maxNativePathCharacters: options.maxNativePathCharacters,
    }
  }

  createProject(parentPath: string, projectName: string): TrustedProject {
    const canonicalParent = this.canonicalExistingDirectory(parentPath)
    const directoryName = sanitizeProjectDirectoryName(projectName)
    const requestedRoot = path.resolve(canonicalParent, directoryName)
    const relative = path.relative(canonicalParent, requestedRoot)
    if (
      !relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new Error('新项目目录必须位于所选父目录内')
    }
    assertProjectStoragePathSupported(requestedRoot, this.storagePreflightOptions)
    if (fs.existsSync(requestedRoot)) {
      throw new Error('项目目录已存在，已拒绝覆盖')
    }

    fs.mkdirSync(requestedRoot)
    const rootPath = this.canonicalProjectRoot(requestedRoot)
    return this.writeManifest(rootPath)
  }

  probeExistingProject(candidatePath: string): ProjectProbe {
    const rootPath = this.canonicalProjectRoot(candidatePath)
    assertProjectCoreStoragePathSupported(rootPath, this.storagePreflightOptions)
    const manifestPath = path.join(rootPath, PROJECT_MANIFEST_RELATIVE_PATH)
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      this.assertProjectChildPath(rootPath, manifestPath, '项目清单')
      let parsed: unknown
      try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch {
        throw new Error('项目清单无法读取，已拒绝打开')
      }
      if (!isProjectManifest(parsed)) {
        throw new Error('项目清单无效，已拒绝打开')
      }

      return {
        kind: 'manifest',
        projectId: parsed.projectId,
        rootPath,
      }
    }

    if (this.hasTrustedLegacySqliteFingerprint(rootPath)) {
      return {
        kind: 'legacy',
        rootPath,
        legacyFingerprint: 'vela-sqlite-v1',
      }
    }

    throw new ProjectRootRequiredError()
  }

  adoptLegacyProject(project: ProjectProbe): TrustedProject {
    if (project.kind === 'manifest') return project

    const current = this.probeExistingProject(project.rootPath)
    if (current.kind === 'manifest') return current
    if (current.legacyFingerprint !== 'vela-sqlite-v1') {
      throw new Error('旧版项目指纹不受支持，已拒绝迁移')
    }
    try {
      return this.writeManifest(current.rootPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const adopted = this.probeExistingProject(current.rootPath)
      if (adopted.kind === 'manifest') return adopted
      throw new Error('旧版项目清单创建冲突，已拒绝打开')
    }
  }

  beginSession(project: TrustedProject): ProjectSessionLease {
    const lease: ProjectSessionLease = {
      ...project,
      leaseId: this.newLeaseId(),
    }
    this.activeSession = lease
    return lease
  }

  /**
   * Capture the main-process lease currently trusted for a rollback boundary.
   * The caller receives a frozen copy so it cannot mutate the authority kept
   * by this service; it must still call assertCurrentSession before using it.
   */
  captureCurrentSession(): ProjectSessionLease | null {
    const active = this.activeSession
    return active ? Object.freeze({ ...active }) : null
  }

  sameCanonicalProjectRoot(left: string, right: string): boolean {
    try {
      return projectPathKey(this.canonicalProjectRoot(left))
        === projectPathKey(this.canonicalProjectRoot(right))
    } catch {
      return false
    }
  }

  assertCurrentSession(lease: ProjectSessionCredential): ProjectSessionLease {
    const active = this.activeSession
    if (
      !active
      || active.projectId !== lease.projectId
      || active.leaseId !== lease.leaseId
    ) {
      throw new Error('项目会话已失效，已拒绝操作')
    }
    return active
  }

  /**
   * 验证 IPC 携带的完整项目会话上下文：租约、声称的项目根和主进程当前数据库
   * 必须全部指向同一个 canonical root。路径从不单独构成授权。
   */
  assertCurrentProjectContext(
    context: ProjectSessionContext | undefined,
    currentProjectPath: string | null,
  ): ProjectSessionLease {
    if (!context?.projectId || !context.leaseId || !context.projectPath) {
      throw new Error('缺少项目会话上下文，已拒绝操作')
    }
    const active = this.assertCurrentSession({
      projectId: context.projectId,
      leaseId: context.leaseId,
    })
    if (!this.sameCanonicalProjectRoot(active.rootPath, context.projectPath)) {
      throw new Error('项目会话根目录不匹配，已拒绝操作')
    }
    if (!currentProjectPath || !this.sameCanonicalProjectRoot(active.rootPath, currentProjectPath)) {
      throw new Error('项目会话与当前数据库不匹配，已拒绝操作')
    }
    return active
  }

  invalidateCurrentSession(): void {
    this.activeSession = null
  }

  authorizeDeletion(lease: ProjectSessionCredential, candidatePath: string): string {
    const active = this.assertCurrentSession(lease)
    const rootPath = this.canonicalProjectRoot(candidatePath)
    if (projectPathKey(rootPath) !== projectPathKey(active.rootPath)) {
      throw new Error('删除目标不是当前项目根目录，已拒绝删除')
    }
    const trusted = this.probeExistingProject(rootPath)
    if (trusted.kind !== 'manifest' || trusted.projectId !== active.projectId) {
      throw new Error('删除目标的项目身份不匹配，已拒绝删除')
    }
    return rootPath
  }

  private canonicalProjectRoot(candidatePath: string): string {
    const rootPath = this.canonicalExistingDirectory(candidatePath)
    if (projectPathKey(rootPath) === projectPathKey(path.parse(rootPath).root)) {
      throw new Error('拒绝将磁盘根目录作为项目')
    }
    if (projectPathKey(rootPath) === projectPathKey(path.resolve(this.homePath))) {
      throw new Error('拒绝将用户主目录作为项目')
    }
    return rootPath
  }

  private canonicalExistingDirectory(candidatePath: string): string {
    if (!candidatePath || !candidatePath.trim()) {
      throw new Error('项目目录不能为空')
    }
    const resolved = path.resolve(candidatePath)
    if (!fs.existsSync(resolved)) {
      throw new Error('项目目录不存在')
    }
    const rootPath = path.normalize(fs.realpathSync.native(resolved))
    if (!fs.statSync(rootPath).isDirectory()) {
      throw new Error('项目根必须是目录')
    }
    return rootPath
  }

  private hasTrustedLegacySqliteFingerprint(rootPath: string): boolean {
    const databasePath = path.join(rootPath, '.vela', 'vela.db')
    if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) return false
    try {
      if (!isContainedPath(rootPath, fs.realpathSync.native(databasePath))) return false
      // 必须同时满足只读、fileMustExist 和项目专有结构，避免任意同名 SQLite
      // 文件被误认作小说项目；这个探测不执行迁移或建表。
      const database = new Database(databasePath, { readonly: true, fileMustExist: true })
      try {
        const tables = database.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as Array<{ name: string }>
        const tableNames = new Set(tables.map(row => row.name))
        if (![...LEGACY_REQUIRED_TABLES].every(name => tableNames.has(name))) return false

        const columns = database.prepare('PRAGMA table_info(project_core)').all() as Array<{ name: string }>
        const columnNames = new Set(columns.map(column => column.name))
        return [...LEGACY_PROJECT_CORE_COLUMNS].every(name => columnNames.has(name))
      } finally {
        database.close()
      }
    } catch {
      return false
    }
  }

  private writeManifest(rootPath: string): TrustedProject {
    const manifestPath = path.join(rootPath, PROJECT_MANIFEST_RELATIVE_PATH)
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      kind: 'ai-novel-project',
      projectId: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return {
      kind: 'manifest',
      projectId: manifest.projectId,
      rootPath,
    }
  }

  private assertProjectChildPath(rootPath: string, candidatePath: string, label: string): void {
    const canonicalCandidate = path.normalize(fs.realpathSync.native(candidatePath))
    if (!isContainedPath(rootPath, canonicalCandidate)) {
      throw new Error(`${label}越界，已拒绝打开`)
    }
  }
}

/** 主进程唯一租约登记处；后续业务 IPC 通过 assertCurrentSession 逐步迁移。 */
export const projectAccess = new ProjectAccessService()
