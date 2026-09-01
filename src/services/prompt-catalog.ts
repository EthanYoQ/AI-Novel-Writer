import type { PromptLoadDiagnostic, ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectSessionContext } from '../shared/project-session-context'
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import type { PromptTemplate } from './prompt-templates'
import { resolveWritingLanguage, type WritingLanguage } from '../shared/writing-language'

export type PromptSource = 'builtin' | 'global' | 'project'

export interface ResolvedPrompt {
  template: PromptTemplate
  source: PromptSource
}

export type PromptCommit =
  | { action: 'save'; scope: 'global'; template: PromptTemplate }
  | { action: 'delete'; scope: 'global'; key: string; writingLanguage?: WritingLanguage }
  | { action: 'save'; scope: 'project'; projectSession: ProjectSessionContext; template: PromptTemplate }
  | { action: 'delete'; scope: 'project'; projectSession: ProjectSessionContext; key: string; writingLanguage?: WritingLanguage }

/** Persistence is the real seam: Electron IPC in production, an in-memory fake in tests. */
export interface PromptPersistence {
  loadGlobal(): Promise<PromptLoadReceipt>
  loadProject(projectSession: ProjectSessionContext): Promise<PromptLoadReceipt>
  saveGlobal(template: PromptTemplate): Promise<void>
  saveProject(projectSession: ProjectSessionContext, template: PromptTemplate): Promise<void>
  deleteGlobal(key: string, writingLanguage?: WritingLanguage): Promise<void>
  deleteProject(projectSession: ProjectSessionContext, key: string, writingLanguage?: WritingLanguage): Promise<void>
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

function templateLanguage(template: Pick<PromptTemplate, 'writingLanguage'>): WritingLanguage {
  // Files written before bilingual overrides had no language marker. They were
  // authored by the Chinese-only settings surface and therefore migrate to zh-CN.
  return resolveWritingLanguage(template.writingLanguage)
}

function localizedKey(key: string, writingLanguage: WritingLanguage): string {
  return `${key}\u0000${resolveWritingLanguage(writingLanguage)}`
}

function diagnosticMatchesLanguage(
  diagnostic: PromptLoadDiagnostic,
  writingLanguage: WritingLanguage,
): boolean {
  return diagnostic.key === undefined
    || resolveWritingLanguage(diagnostic.writingLanguage) === resolveWritingLanguage(writingLanguage)
}

function keepDiagnosticAfterChange(
  diagnostic: PromptLoadDiagnostic,
  key: string,
  writingLanguage: WritingLanguage,
): boolean {
  return diagnostic.key !== key
    || resolveWritingLanguage(diagnostic.writingLanguage) !== resolveWritingLanguage(writingLanguage)
}

function setLocalizedTemplate(target: Map<string, PromptTemplate>, template: PromptTemplate): void {
  const key = localizedKey(template.key, templateLanguage(template))
  const current = target.get(key)
  // Prefer an explicitly tagged file over its legacy untagged Chinese version.
  if (!current || template.writingLanguage || !current.writingLanguage) target.set(key, template)
}

function promptKeyFromFilename(filename: string): string {
  return filename.replace(/\.json$/u, '').replace(/\.(?:zh-CN|en-US)$/u, '')
}

function promptLanguageFromFilename(filename: string): WritingLanguage | undefined {
  const match = filename.match(/\.(zh-CN|en-US)\.json$/u)
  return match?.[1] as WritingLanguage | undefined
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

  async resolve(
    key: string,
    projectSession?: ProjectSessionContext,
    writingLanguage: WritingLanguage = 'zh-CN',
  ): Promise<ResolvedPrompt | undefined> {
    await this.ensureGlobalLoaded()
    if (projectSession && !await this.ensureProjectLoaded(projectSession)) {
      throw new Error('项目会话已变化，已拒绝读取项目提示词')
    }
    const projectPrompts = this.projectPromptsFor(projectSession)
    const localized = localizedKey(key, writingLanguage)
    const project = projectPrompts?.get(localized)
    if (project) return { template: project, source: 'project' }
    this.throwIfTargetDamaged(key, writingLanguage, this.projectCache?.diagnostics ?? [])

    const global = this.globalPrompts.get(localized)
    if (global) return { template: global, source: 'global' }
    this.throwIfTargetDamaged(key, writingLanguage, this.globalDiagnostics)

    const builtin = this.builtins.get(key)
    return builtin ? { template: builtin, source: 'builtin' } : undefined
  }

  async list(
    projectSession?: ProjectSessionContext,
    writingLanguage: WritingLanguage = 'zh-CN',
  ): Promise<ResolvedPrompt[]> {
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
    const language = resolveWritingLanguage(writingLanguage)
    const diagnostics = [...this.globalDiagnostics, ...projectDiagnostics]
      .filter(item => diagnosticMatchesLanguage(item, language))
    if (diagnostics.length > 0) throw new PromptLoadDiagnosticsError(diagnostics)

    const keys = new Set(this.builtins.keys())
    for (const template of this.globalPrompts.values()) keys.add(template.key)
    for (const template of this.projectPromptsFor(projectSession)?.values() ?? []) keys.add(template.key)
    return [...keys].flatMap((key) => {
      const resolved = this.peek(key, projectSession, writingLanguage)
      return resolved ? [resolved] : []
    })
  }

  async commit(change: PromptCommit): Promise<boolean> {
    try {
      await this.ensureGlobalLoaded()
      if (change.scope === 'global') {
        if (change.action === 'save') {
          await this.persistence.saveGlobal(change.template)
          setLocalizedTemplate(this.globalPrompts, change.template)
          this.globalDiagnostics = this.globalDiagnostics.filter(item => keepDiagnosticAfterChange(
            item,
            change.template.key,
            templateLanguage(change.template),
          ))
        } else {
          const writingLanguage = resolveWritingLanguage(change.writingLanguage)
          await this.persistence.deleteGlobal(change.key, writingLanguage)
          this.globalPrompts.delete(localizedKey(change.key, writingLanguage))
          this.globalDiagnostics = this.globalDiagnostics.filter(item => keepDiagnosticAfterChange(
            item,
            change.key,
            writingLanguage,
          ))
        }
        return true
      }

      const owner = freezeSession(change.projectSession)
      if (!this.isCurrent(owner)) return false
      if (!await this.ensureProjectLoaded(owner)) return false

      if (change.action === 'save') {
        await this.persistence.saveProject(owner, change.template)
      } else {
        await this.persistence.deleteProject(owner, change.key, resolveWritingLanguage(change.writingLanguage))
      }
      if (!this.isCurrent(owner)) return false

      const current = this.projectPromptsFor(owner)
      const currentCache = this.projectCache
      if (!current || !currentCache) return false
      const next = new Map(current)
      if (change.action === 'save') setLocalizedTemplate(next, change.template)
      else next.delete(localizedKey(change.key, resolveWritingLanguage(change.writingLanguage)))
      const changedKey = change.action === 'save' ? change.template.key : change.key
      const changedLanguage = change.action === 'save'
        ? templateLanguage(change.template)
        : resolveWritingLanguage(change.writingLanguage)
      this.projectCache = {
        key: sessionKey(owner),
        owner,
        prompts: next,
        diagnostics: currentCache.diagnostics.filter(item => keepDiagnosticAfterChange(
          item,
          changedKey,
          changedLanguage,
        )),
      }
      return true
    } catch {
      return false
    }
  }

  /** Synchronous compatibility read; lifecycle remains owned by this module. */
  peek(
    key: string,
    projectSession?: ProjectSessionContext,
    writingLanguage: WritingLanguage = 'zh-CN',
  ): ResolvedPrompt | undefined {
    const localized = localizedKey(key, writingLanguage)
    const project = this.projectPromptsFor(projectSession)?.get(localized)
    if (project) return { template: project, source: 'project' }
    const global = this.globalPrompts.get(localized)
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
  async loadProject(
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage = 'zh-CN',
  ): Promise<boolean> {
    const loaded = await this.ensureProjectLoaded(projectSession)
    const diagnostics = this.projectCache?.diagnostics
      .filter(item => diagnosticMatchesLanguage(item, writingLanguage)) ?? []
    if (loaded && diagnostics.length > 0) {
      throw new PromptLoadDiagnosticsError(diagnostics)
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
            if (validTemplate(template)) setLocalizedTemplate(loaded, template)
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
            if (validTemplate(template)) setLocalizedTemplate(prompts, template)
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

  private throwIfTargetDamaged(
    key: string,
    writingLanguage: WritingLanguage,
    diagnostics: readonly PromptLoadDiagnostic[],
  ): void {
    const relevant = diagnostics.filter((item) => (
      (item.key === undefined || item.key === key)
      && diagnosticMatchesLanguage(item, writingLanguage)
    ))
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
        const expectedFilename = parsed.writingLanguage
          ? `${parsed.key}.${resolveWritingLanguage(parsed.writingLanguage)}`
          : parsed.key
        if (expectedFilename !== filenameKey) throw new Error('提示词标识或语言与文件名不一致')
        prompts.push(parsed)
      } catch (error) {
        diagnostics.push({
          key: promptKeyFromFilename(file.name),
          ...(promptLanguageFromFilename(file.name)
            ? { writingLanguage: promptLanguageFromFilename(file.name) }
            : {}),
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
    const writingLanguage = templateLanguage(template)
    requireIpcSuccess(await ipc.invokeWithProjectSession(
      projectSession,
      'fs:write-file',
      `${dirPath}/${template.key}.${writingLanguage}.json`,
      JSON.stringify({ ...template, writingLanguage }, null, 2),
      projectSession.projectPath,
    ), '保存项目提示词')
    if (writingLanguage === 'zh-CN') {
      const legacyPath = `${dirPath}/${template.key}.json`
      const legacyExists = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:check-exists',
        legacyPath,
        projectSession.projectPath,
      )
      if (legacyExists) {
        requireIpcSuccess(await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          legacyPath,
          '',
          projectSession.projectPath,
        ), '迁移旧版项目提示词')
      }
    }
  },

  async deleteGlobal(key, writingLanguage = 'zh-CN') {
    requireIpcSuccess(
      await ipc.invoke('prompt:delete-global', key, resolveWritingLanguage(writingLanguage)),
      '删除自定义提示词',
    )
  },

  async deleteProject(projectSession, key, writingLanguage = 'zh-CN') {
    const language = resolveWritingLanguage(writingLanguage)
    const filePaths = [`${projectSession.projectPath}/.vela/prompts/${key}.${language}.json`]
    if (language === 'zh-CN') filePaths.push(`${projectSession.projectPath}/.vela/prompts/${key}.json`)
    for (const filePath of filePaths) {
      const exists = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:check-exists',
        filePath,
        projectSession.projectPath,
      )
      if (!exists) continue
      requireIpcSuccess(await ipc.invokeWithProjectSession(
        projectSession,
        'fs:write-file',
        filePath,
        '',
        projectSession.projectPath,
      ), '删除项目提示词')
    }
  },
}
