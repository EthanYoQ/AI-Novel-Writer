import { getBuiltinWritingSkills } from '../../shared/builtin-writing-skills'
import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
/**
 * Skill 注册中心
 *
 * 管理所有可用的 Skill（基于 SKILL.md 的模块化知识包）。
 * 支持：
 * - 内置 Skill（随 Vela 发布的预设 Skill）
 * - 用户 Skill（用户放在 ~/.vela/skills/ 下的自定义 Skill）
 * - 项目 Skill（放在项目的 .ai-novel/skills/ 下的项目级 Skill）
 *
 * Skill 格式兼容 Cursor 的 SKILL.md 生态。
 */

import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import { toolRegistry, type AgentExecutionContext, type AgentTool } from './tool-registry'
import type { WritingLanguage } from '../../shared/writing-language'
import {
  inspectWritingSkillMarkdown,
  type WritingSkillInspection,
  type WritingSkillSource,
} from '../../shared/writing-skills'

// ===== 类型定义 =====

/** Skill 来源 */
export type SkillSource = WritingSkillSource

/** Skill 元数据（从 SKILL.md frontmatter 解析） */
export interface SkillMetadata {
  /** Skill 唯一名称 */
  name: string
  /** 显示名称 */
  displayName?: string
  /** 功能描述 */
  description: string
  /** 使用场景（用于 Agent 自动匹配） */
  whenToUse?: string
  /** 版本 */
  version?: string
  /** 允许的工具列表（白名单） */
  allowedTools?: string[]
  /** 参数提示 */
  argumentHint?: string
  /** 是否可由模型自动调用 */
  userInvocable?: boolean
}

/** 加载后的 Skill */
export interface LoadedSkill {
  /** 元数据 */
  metadata: SkillMetadata
  /** Skill 内容（Markdown 提示词） */
  content: string
  /** 来源 */
  source: SkillSource
  /** 文件所在目录 */
  baseDir: string
  /** SKILL.md 文件路径 */
  filePath: string
  /** 项目级 Skill 必须绑定其加载时的完整项目 lease。 */
  projectSession?: ProjectSessionContext
  /** Stable project-binding key. */
  skillId: string
  /** Prompt-only workflow compatibility; incompatible packages remain visible but are never injected. */
  writingSkill: WritingSkillInspection
  /** Built-in bilingual copy selected by project writing language. */
  localizedContent?: Partial<Record<WritingLanguage, string>>
}

// ===== Skill Registry =====

function isMissingProjectSkillDirectory(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  if (code === 'ENOENT' || code === 'SECURE_FS_NOT_FOUND') return true
  const message = error instanceof Error ? error.message : ''
  return /(?:^|:\s)(?:SECURE_FS_NOT_FOUND|ENOENT: no such file or directory(?:,|$))/.test(message)
}

class SkillRegistryImpl {
  private skills: Map<string, LoadedSkill> = new Map()
  private loadTail: Promise<void> = Promise.resolve()

  /** 注册一个 Skill */
  register(skill: LoadedSkill): void {
    this.skills.set(skill.skillId, skill)
  }

  /** Legacy lookup by metadata name. Stable project bindings use getById. */
  get(name: string): LoadedSkill | undefined {
    return this.listAll().find(skill => skill.metadata.name === name)
  }

  getById(skillId: string): LoadedSkill | undefined {
    return this.skills.get(skillId)
  }

  /** 列出所有 Skill */
  listAll(): LoadedSkill[] {
    return Array.from(this.skills.values())
  }

  /** 按来源列出 */
  listBySource(source: SkillSource): LoadedSkill[] {
    return this.listAll().filter(s => s.source === source)
  }

  /** Skill 数量 */
  get size(): number {
    return this.skills.size
  }

  /** 清空 */
  clear(): void {
    this.skills.clear()
  }

  /** 从主进程管理的用户 Skill 目录加载，渲染进程不接触 VELA_HOME 路径。 */
  private async loadUserSkills(target: Map<string, LoadedSkill>): Promise<number> {
    let count = 0
    try {
      const entries = await ipc.invoke('skills:list-user')
      for (const entry of entries) {
        const skill = parseSkillMd(entry.content, entry.name, 'user', entry.baseDir, entry.filePath)
        if (!skill) continue
        target.set(skill.skillId, skill)
        count++
      }
    } catch {
      // 用户目录不可用时不影响内置或项目 Skill。
    }
    return count
  }

  /**
   * 从当前项目边界内加载 Skills。
   *
   * 项目路径仍须通过项目会话在主进程重新校验。
   */
  private async loadProjectSkills(
    dir: string,
    projectPath: string,
    projectSession: ProjectSessionContext,
    target: Map<string, LoadedSkill>,
  ): Promise<number> {
    let count = 0
    const exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      dir,
      projectPath,
    )
    if (
      !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) return count
    if (!exists) return count

    let entries
    try {
      entries = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:list-dir',
        dir,
        projectPath,
      )
    } catch (error) {
      if (isMissingProjectSkillDirectory(error)) return count
      throw error
    }
    if (
      !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) return count
    for (const entry of entries) {
      if (
        !sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) return count
      if (!entry.isDir) continue

      const skillFile = `${entry.path}/SKILL.md`
      try {
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'fs:read-file',
          skillFile,
          projectPath,
        )
        if (
          !sameProjectSessionContext(
            projectSession,
            projectSessionContextFromProject(useProjectStore.getState().currentProject),
          )
        ) return count
        if (!result.success) continue

        const skill = parseSkillMd(
          result.content,
          entry.name,
          'project',
          entry.path,
          skillFile,
          projectSession,
        )
        if (skill) {
          target.set(skill.skillId, skill)
          count++
        }
      } catch {
        // 单个 Skill 加载失败不影响整体
      }
    }
    return count
  }

  /**
   * 加载所有 Skill（内置 + 用户 + 项目）
   */
  loadAll(): Promise<void> {
    const load = this.loadTail.then(() => this.loadAllAtomic())
    this.loadTail = load.catch(() => undefined)
    return load
  }

  private async loadAllAtomic(): Promise<void> {
    const projectSession = projectSessionContextFromProject(
      useProjectStore.getState().currentProject,
    )
    const staged = new Map<string, LoadedSkill>()

    // 注册内置 Skill
    registerBuiltinSkills({ register: skill => staged.set(skill.skillId, skill) })

    // 用户 Skill 路径只能由主进程的固定应用数据服务访问。
    const userCount = await this.loadUserSkills(staged)
    if (userCount > 0) {
      console.log(`[Skills] 加载了 ${userCount} 个用户 Skill`)
    }

    // 加载项目 Skill（项目/.ai-novel/skills/）
    if (
      ipc.isElectron
      && projectSession
      && sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) {
      const projectSkillsDir = `${projectSession.projectPath}/${CANONICAL_PROJECT_DIRECTORY}/skills`
      const projectCount = await this.loadProjectSkills(
        projectSkillsDir,
        projectSession.projectPath,
        projectSession,
        staged,
      )
      if (projectCount > 0) {
        console.log(`[Skills] 加载了 ${projectCount} 个项目 Skill`)
      }
    }

    this.skills = staged
    // 将所有 Skill 注册为 Agent Tool
    this.registerToToolRegistry()

    console.log(`[Skills] 共加载 ${this.size} 个 Skill`)
  }

  /**
   * 将 Skill 注册为 Agent Tool
   */
  private registerToToolRegistry(): void {
    // 先清理旧的 Skill Tool
    toolRegistry.unregisterBySource('skill')

    for (const skill of this.listAll()) {
      if (skill.source !== 'builtin') continue
      const agentTool: AgentTool = {
        name: `skill__${skill.metadata.name}`,
        description: skill.metadata.description + (skill.metadata.whenToUse ? ` — ${skill.metadata.whenToUse}` : ''),
        descriptionEn: skill.writingSkill.metadata.description,
        source: 'skill',
        inputSchema: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description: skill.metadata.argumentHint ?? '可选的参数',
              descriptionEn: 'Optional arguments',
            },
          },
        },
        requiresConfirmation: false,
        isReadOnly: true,
        userFacingName: skill.metadata.displayName ?? skill.metadata.name,
        execute: async (toolArgs, context?: AgentExecutionContext) => {
          if (
            skill.projectSession
            && !sameProjectSessionContext(skill.projectSession, context?.projectSession)
          ) {
            return {
              success: false,
              content: '',
              error: '项目 Skill 的加载会话已失效，请重新加载当前项目 Skill',
            }
          }
          const userArgs = (toolArgs.args as string) ?? ''
          // 变量替换
          const writingLanguage = context?.writingLanguage ?? 'zh-CN'
          let content = skill.localizedContent?.[writingLanguage] ?? skill.content
          if (userArgs) {
            content = content.replace(/\$\{args\}/g, userArgs)
            content = content.replace(/\$1/g, userArgs)
          }
          content = content.replace(/\$\{SKILL_DIR\}/g, skill.baseDir)

          return {
            success: true,
            content: `[Skill: ${writingLanguage === 'en-US'
              ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
              : (skill.metadata.displayName ?? skill.metadata.name)}]\n\n${content}`,
          }
        },
      }
      toolRegistry.register(agentTool)
    }
  }
}

/** 全局 Skill 注册中心 */
export const skillRegistry = new SkillRegistryImpl()

// ===== SKILL.md 解析 =====

/**
 * 解析 SKILL.md 文件内容
 *
 * 格式：
 * ```
 * ---
 * name: skill-name
 * description: 功能描述
 * when_to_use: 什么时候使用
 * allowed-tools: [read_file, search_knowledge]
 * ---
 *
 * # Skill 提示词内容
 * ...
 * ```
 */
export function parseSkillMd(
  raw: string,
  fallbackName: string,
  source: SkillSource,
  baseDir: string,
  filePath: string,
  projectSession?: ProjectSessionContext,
): LoadedSkill | null {
  const writingSkill = inspectWritingSkillMarkdown(raw)
  const inspectedName = writingSkill.metadata.name === 'unnamed-writing-skill'
    ? fallbackName
    : writingSkill.metadata.name
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(inspectedName)) return null
  const metadata: SkillMetadata = {
    name: inspectedName,
    displayName: writingSkill.metadata.displayName,
    description: writingSkill.metadata.description || `Skill: ${fallbackName}`,
    version: writingSkill.metadata.version,
    userInvocable: true,
  }

  return {
    metadata,
    content: writingSkill.content,
    source,
    baseDir,
    filePath,
    projectSession,
    skillId: `${source}:${metadata.name}`,
    writingSkill,
  }
}

// ===== 内置 Skills =====

function registerBuiltinSkills(registry: Pick<SkillRegistryImpl, 'register'>): void {
  const builtins = getBuiltinWritingSkills()

  for (const { metadata, content, writingSkill, localizedContent } of builtins) {
    const inspected = writingSkill ?? inspectWritingSkillMarkdown(`---\nname: ${metadata.name}\ndescription: ${metadata.description}\n---\n${content}`)
    registry.register({
      metadata,
      content,
      source: 'builtin',
      baseDir: '',
      filePath: `builtin://${metadata.name}`,
      skillId: `builtin:${metadata.name}`,
      writingSkill: inspected,
      localizedContent,
    })
  }
}
