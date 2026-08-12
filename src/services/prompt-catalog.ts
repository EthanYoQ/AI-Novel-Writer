import type { PromptLoadDiagnostic, ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectSessionContext } from '../shared/project-session-context'
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import type { PromptTemplate } from './prompt-templates'

export type PromptSource = 'builtin' | 'global' | 'project'

export interface ResolvedPrompt {
  template: PromptTemplate
  source: PromptSource
}

export type PromptCommit =
  | { action: 'save'; scope: 'global'; template: PromptTemplate }
  | { action: 'delete'; scope: 'global'; key: string }
  | { action: 'save'; scope: 'project'; projectSession: ProjectSessionContext; template: PromptTemplate }
  | { action: 'delete'; scope: 'project'; projectSession: ProjectSessionContext; key: string }

/** Persistence is the real seam: Electron IPC in production, an in-memory fake in tests. */
export interface PromptPersistence {
  loadGlobal(): Promise<PromptLoadReceipt>
  loadProject(projectSession: ProjectSessionContext): Promise<PromptLoadReceipt>
  saveGlobal(template: PromptTemplate): Promise<void>
  saveProject(projectSession: ProjectSessionContext, template: PromptTemplate): Promise<void>
  deleteGlobal(key: string): Promise<void>
  deleteProject(projectSession: ProjectSessionContext, key: string): Promise<void>
}

export interface PromptLoadReceipt {
  templates: PromptTemplate[]
  diagnostics: PromptLoadDiagnostic[]
}

export class PromptLoadDiagnosticsError extends Error {
  constructor(readonly diagnostics: readonly PromptLoadDiagnostic[]) {
    super(diagnostics.map((item) => `${item.path}: ${item.error}`).join('\n'))
    this.name = 'PromptLoadDiagnosticsError'
  }
}

function freezeSession(projectSession: ProjectSessionContext): ProjectSessionContext {
  return Object.freeze({ ...projectSession })
}

function sessionKey(projectSession: ProjectSessionContext): string {
  return `${projectSession.projectId}\u0000${projectSession.leaseId}\u0000${projectSession.projectPath}`
}

function validTemplate(value: PromptTemplate): boolean {
  return !!value && typeof value.key === 'string' && value.key.length > 0 && typeof value.content === 'string'
}

/**
 * Owns prompt hydration, precedence and durable mutation. Callers never need
 * to know whether a prompt came from disk, cache, a project lease or a built-in.
 */
export class PromptCatalog {
  private readonly builtins: ReadonlyMap<string, PromptTemplate>
  private globalPrompts = new Map<string, PromptTemplate>()
  private globalDiagnostics: readonly PromptLoadDiagnostic[] = []
  private globalLoad: Promise<void> | null = null
  private globalLoaded = false
  private projectCache: {
    key: string
    owner: ProjectSessionContext
    prompts: ReadonlyMap<string, PromptTemplate>
    diagnostics: readonly PromptLoadDiagnostic[]
  } | null = null
  private projectLoads = new Map<string, Promise<boolean>>()

  constructor(
    builtins: readonly PromptTemplate[],
    private readonly persistence: PromptPersistence,
    private readonly currentProjectSession: () => ProjectSessionContext | null,
  ) {
    this.builtins = new Map(builtins.map((template) => [template.key, template]))
  }

  async resolve(key: string, projectSession?: ProjectSessionContext): Promise<ResolvedPrompt | undefined> {
    await this.ensureGlobalLoaded()
    if (projectSession && !await this.ensureProjectLoaded(projectSession)) {
      throw new Error('项目会话已变化，已拒绝读取项目提示词')
    }
    const projectPrompts = this.projectPromptsFor(projectSession)
    const project = projectPrompts?.get(key)
    if (project) return { template: project, source: 'project' }
    this.throwIfTargetDamaged(key, this.projectCache?.diagnostics ?? [])

    const global = this.globalPrompts.get(key)
    if (global) return { template: global, source: 'global' }
    this.throwIfTargetDamaged(key, this.globalDiagnostics)

    const builtin = this.builtins.get(key)
    return builtin ? { template: builtin, source: 'builtin' } : undefined
  }

  async list(projectSession?: ProjectSessionContext): Promise<ResolvedPrompt[]> {
    await this.ensureGlobalLoaded()
    if (projectSession && !await this.ensureProjectLoaded(projectSession)) {
      throw new Error('项目会话已变化，已拒绝读取项目提示词')
    }
    const projectDiagnostics = projectSession
      && this.projectCache
      && this.isCurrent(projectSession)
      && sameProjectSessionContext(projectSession, this.projectCache.owner)
      ? this.projectCache.diagnostics
      : []
    const diagnostics = [...this.globalDiagnostics, ...projectDiagnostics]
    if (diagnostics.length > 0) throw new PromptLoadDiagnosticsError(diagnostics)

    const keys = new Set(this.builtins.keys())
    for (const key of this.globalPrompts.keys()) keys.add(key)
    for (const key of this.projectPromptsFor(projectSession)?.keys() ?? []) keys.add(key)
    return [...keys].flatMap((key) => {
      const resolved = this.peek(key, projectSession)
      return resolved ? [resolved] : []
    })
  }

  async commit(change: PromptCommit): Promise<boolean> {
    try {
      await this.ensureGlobalLoaded()
      if (change.scope === 'global') {
        if (change.action === 'save') {
          await this.persistence.saveGlobal(change.template)
          this.globalPrompts.set(change.template.key, change.template)
          this.globalDiagnostics = this.globalDiagnostics.filter((item) => item.key !== change.template.key)
        } else {
          await this.persistence.deleteGlobal(change.key)
          this.globalPrompts.delete(change.key)
          this.globalDiagnostics = this.globalDiagnostics.filter((item) => item.key !== change.key)
        }
        return true
      }

      const owner = freezeSession(change.projectSession)
      if (!this.isCurrent(owner)) return false
      if (!await this.ensureProjectLoaded(owner)) return false

      if (change.action === 'save') {
        await this.persistence.saveProject(owner, change.template)
      } else {
        await this.persistence.deleteProject(owner, change.key)
      }
      if (!this.isCurrent(owner)) return false

      const current = this.projectPromptsFor(owner)
      const currentCache = this.projectCache
      if (!current || !currentCache) return false
      const next = new Map(current)
      if (change.action === 'save') next.set(change.template.key, change.template)
      else next.delete(change.key)
      const changedKey = change.action === 'save' ? change.template.key : change.key
      this.projectCache = {
        key: sessionKey(owner),
        owner,
        prompts: next,
        diagnostics: currentCache.diagnostics.filter((item) => item.key !== changedKey),
      }
      return true
    } catch {
      return false
    }
  }

  /** Synchronous compatibility read; lifecycle remains owned by this module. */
  peek(key: string, projectSession?: ProjectSessionContext): ResolvedPrompt | undefined {
    const project = this.projectPromptsFor(projectSession)?.get(key)
    if (project) return { template: project, source: 'project' }
    const global = this.globalPrompts.get(key)
    if (global) return { template: global, source: 'global' }
    const builtin = this.builtins.get(key)
    return builtin ? { template: builtin, source: 'builtin' } : undefined
  }

  /** Compatibility hook for project-session lifecycle tests and close events. */
  clearProject(): void {
    this.projectCache = null
    this.projectLoads.clear()
  }

  /** Compatibility preload; normal callers should use resolve/list. */
  async loadProject(projectSession: ProjectSessionContext): Promise<boolean> {
    const loaded = await this.ensureProjectLoaded(projectSession)
    if (loaded && this.projectCache && this.projectCache.diagnostics.length > 0) {
      throw new PromptLoadDiagnosticsError(this.projectCache.diagnostics)
    }
    return loaded
  }

  private async ensureGlobalLoaded(): Promise<void> {
    if (this.globalLoaded) return
    if (!this.globalLoad) {
      this.globalLoad = this.persistence.loadGlobal()
        .then((receipt) => {
          const loaded = new Map<string, PromptTemplate>()
          for (const template of receipt.templates) {
            if (validTemplate(template)) loaded.set(template.key, template)
          }
          this.globalPrompts = loaded
          this.globalDiagnostics = receipt.diagnostics
          this.globalLoaded = true
        })
        .finally(() => { this.globalLoad = null })
    }
    await this.globalLoad
  }

  private async ensureProjectLoaded(projectSession: ProjectSessionContext): Promise<boolean> {
    const owner = freezeSession(projectSession)
    if (!this.isCurrent(owner)) return false
    const key = sessionKey(owner)
    if (this.projectCache?.key === key && this.isCurrent(this.projectCache.owner)) return true

    let loading = this.projectLoads.get(key)
    if (!loading) {
      loading = this.persistence.loadProject(owner)
        .then((receipt) => {
          if (!this.isCurrent(owner)) return false
          const prompts = new Map<string, PromptTemplate>()
          for (const template of receipt.templates) {
            if (validTemplate(template)) prompts.set(template.key, template)
          }
          this.projectCache = { key, owner, prompts, diagnostics: receipt.diagnostics }
          return true
        })
        .finally(() => { this.projectLoads.delete(key) })
      this.projectLoads.set(key, loading)
    }
    return loading
  }

  private isCurrent(projectSession: ProjectSessionContext): boolean {
    return sameProjectSessionContext(projectSession, this.currentProjectSession())
  }

  private projectPromptsFor(
    projectSession: ProjectSessionContext | null | undefined,
  ): ReadonlyMap<string, PromptTemplate> | null {
    if (
      !projectSession
      || !this.projectCache
      || !this.isCurrent(projectSession)
      || !sameProjectSessionContext(projectSession, this.projectCache.owner)
    ) return null
    return this.projectCache.prompts
  }

  private throwIfTargetDamaged(key: string, diagnostics: readonly PromptLoadDiagnostic[]): void {
    const relevant = diagnostics.filter((item) => item.key === undefined || item.key === key)
    if (relevant.length > 0) throw new PromptLoadDiagnosticsError(relevant)
  }
}

/** Electron adapter for the PromptCatalog persistence seam. */
export const ipcPromptPersistence: PromptPersistence = {
  async loadGlobal() {
    if (!ipc.isElectron) return { templates: [], diagnostics: [] }
    return await ipc.invoke('prompt:load-global') as unknown as PromptLoadReceipt
  },

  async loadProject(projectSession) {
    const dirPath = `${projectSession.projectPath}/.vela/prompts`
    const exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      dirPath,
      projectSession.projectPath,
    )
    if (!exists) return { templates: [], diagnostics: [] }

    const files = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:list-dir',
      dirPath,
      projectSession.projectPath,
    )
    const prompts: PromptTemplate[] = []
    const diagnostics: PromptLoadDiagnostic[] = []
    for (const file of files.filter((entry) => !entry.isDir && entry.name.endsWith('.json'))) {
      try {
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'fs:read-file',
          file.path,
          projectSession.projectPath,
        )
        requireIpcSuccess(result, '读取项目提示词')
        if (!result.content.trim()) continue
        const parsed = JSON.parse(result.content) as PromptTemplate
        if (!validTemplate(parsed)) throw new Error('提示词内容结构无效')
        const filenameKey = file.name.slice(0, -'.json'.length)
        if (parsed.key !== filenameKey) throw new Error('提示词标识与文件名不一致')
        prompts.push(parsed)
      } catch (error) {
        diagnostics.push({
          key: file.name.slice(0, -'.json'.length),
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { templates: prompts, diagnostics }
  },

  async saveGlobal(template) {
    requireIpcSuccess(
      await ipc.invoke('prompt:save-global', template as unknown as { key: string; [key: string]: unknown }),
      '保存自定义提示词',
    )
  },

  async saveProject(projectSession, template) {
    const dirPath = `${projectSession.projectPath}/.vela/prompts`
    const exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      dirPath,
      projectSession.projectPath,
    )
    if (!exists) {
      requireIpcSuccess(await ipc.invokeWithProjectSession(
        projectSession,
        'fs:mkdir',
        `${projectSession.projectPath}/.vela`,
        projectSession.projectPath,
      ), '创建项目配置目录')
      requireIpcSuccess(await ipc.invokeWithProjectSession(
        projectSession,
        'fs:mkdir',
        dirPath,
        projectSession.projectPath,
      ), '创建项目提示词目录')
    }
    requireIpcSuccess(await ipc.invokeWithProjectSession(
      projectSession,
      'fs:write-file',
      `${dirPath}/${template.key}.json`,
      JSON.stringify(template, null, 2),
      projectSession.projectPath,
    ), '保存项目提示词')
  },

  async deleteGlobal(key) {
    requireIpcSuccess(await ipc.invoke('prompt:delete-global', key), '删除自定义提示词')
  },

  async deleteProject(projectSession, key) {
    const filePath = `${projectSession.projectPath}/.vela/prompts/${key}.json`
    const exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      filePath,
      projectSession.projectPath,
    )
    if (!exists) return
    requireIpcSuccess(await ipc.invokeWithProjectSession(
      projectSession,
      'fs:write-file',
      filePath,
      '',
      projectSession.projectPath,
    ), '删除项目提示词')
  },
}
