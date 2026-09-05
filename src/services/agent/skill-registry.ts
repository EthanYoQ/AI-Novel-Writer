/**
 * Skill 注册中心
 *
 * 管理所有可用的 Skill（基于 SKILL.md 的模块化知识包）。
 * 支持：
 * - 内置 Skill（随 Vela 发布的预设 Skill）
 * - 用户 Skill（用户放在 ~/.vela/skills/ 下的自定义 Skill）
 * - 项目 Skill（放在项目的 .vela/skills/ 下的项目级 Skill）
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

    // 加载项目 Skill（项目/.vela/skills/）
    if (
      ipc.isElectron
      && projectSession
      && sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )
    ) {
      const projectSkillsDir = `${projectSession.projectPath}/.vela/skills`
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
  const builtins: Array<{
    metadata: SkillMetadata
    content: string
    writingSkill?: WritingSkillInspection
    localizedContent?: Partial<Record<WritingLanguage, string>>
  }> = [
    {
      metadata: {
        name: 'long-form-continuity',
        displayName: '长篇连续性与场景推进',
        description: '在规划和正文阶段守住作者事实、因果链、角色状态与伏笔进度。',
        version: '1.0.0',
      },
      content: 'Treat established author facts as authoritative. Track causality, character state, and unresolved narrative threads. Build each scene around a character choice, its cost, and a concrete change in the story state.',
      localizedContent: {
        'zh-CN': '以作者已经确认的事实为最高依据。持续核对因果链、角色状态和未回收的叙事线索。每个场景围绕角色的主动选择、选择的代价，以及故事状态发生的具体变化展开。',
        'en-US': 'Treat established author facts as authoritative. Track causality, character state, and unresolved narrative threads. Build each scene around a character choice, its cost, and a concrete change in the story state.',
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: long-form-continuity\ndisplay_name: Long-form Continuity and Scene Progression\ndescription: Long-form continuity and scene progression\nversion: 1.0.0\nlanguage: bilingual\nstage: planning\n---\nTreat established author facts as authoritative. Track causality, character state, and unresolved narrative threads.`),
    },
    {
      metadata: {
        name: 'natural-prose-refinement',
        displayName: '自然语言润色',
        description: '在修稿阶段减少模板化表达，让动作、感官和句式服务于人物与场景。',
        version: '1.0.0',
      },
      content: 'Revise the prose without changing author facts or plot outcomes. Replace generic summaries with selective concrete action, vary sentence rhythm, preserve the viewpoint voice, and remove meta commentary and repetitive transitions.',
      localizedContent: {
        'zh-CN': '在不改变作者事实和情节结果的前提下润色正文。用有选择的具体动作替代空泛概述，调整句式节奏，保持视角人物的语言质感，并删除元话术和重复的过渡表达。',
        'en-US': 'Revise the prose without changing author facts or plot outcomes. Replace generic summaries with selective concrete action, vary sentence rhythm, preserve the viewpoint voice, and remove meta commentary and repetitive transitions.',
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: natural-prose-refinement\ndisplay_name: Natural Prose Refinement\ndescription: Natural prose refinement\nversion: 1.0.0\nlanguage: bilingual\nstage: refinement\n---\nRevise the prose without changing author facts or plot outcomes.`),
    },
    {
      metadata: {
        name: 'review-chapter',
        displayName: '章节审阅',
        description: '对指定章节进行全面的质量审阅，包括剧情逻辑、角色一致性、节奏感、伏笔呼应等多个维度。',
        whenToUse: '用户要求审阅、检查、评估某个章节时',
      },
      content: `# 章节审阅

请对目标章节进行专业的小说审阅。依次检查以下维度：

## 1. 剧情逻辑
- 情节是否连贯，有无逻辑矛盾
- 因果关系是否成立

## 2. 角色一致性
- 角色行为是否符合既定性格
- 对话风格是否一致

## 3. 节奏感
- 张弛是否有度
- 是否有不必要的拖沓或过于仓促的转折

## 4. 伏笔与呼应
- 已有伏笔是否得到了回应
- 新埋的伏笔是否自然

## 5. 文笔与风格
- 描写是否生动
- 是否符合整体文风设定

请先使用 read_drafts 工具读取目标章节，再使用 read_architecture 读取故事架构进行对比评估。
输出格式：每个维度评分（1-5星）+ 详细说明 + 修改建议。`,
      localizedContent: {
        'en-US': `# Chapter Review

Review the target chapter as a fiction editor. Check each dimension in order:

## 1. Plot logic
- Is the plot coherent and free of logical contradictions?
- Are cause and effect convincing?

## 2. Character consistency
- Do actions match established characterization?
- Does each character keep a consistent voice?

## 3. Pacing
- Is tension balanced with release?
- Are any passages needlessly slow or any turns too abrupt?

## 4. Foreshadowing and payoff
- Are established clues paid off where appropriate?
- Do new clues arise naturally?

## 5. Prose and style
- Is the description vivid and purposeful?
- Does it match the project's established style?

Use read_drafts to load the target chapter and read_architecture to compare it with the story plan.
For each dimension, provide a 1-5 rating, a concise explanation, and actionable revision suggestions.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: review-chapter\ndisplay_name: Chapter Review\ndescription: Reviews a chapter for plot logic, character consistency, pacing, foreshadowing, and prose quality.\nlanguage: bilingual\nstage: review\n---\nUse the read_drafts and read_architecture tools before reviewing the chapter.`),
    },
    {
      metadata: {
        name: 'brainstorm',
        displayName: '脑暴创意',
        description: '针对指定话题进行创意脑暴，生成多个创意方向和灵感。',
        whenToUse: '用户要求头脑风暴、找灵感、想创意时',
      },
      content: `# 创意脑暴

请围绕用户给出的话题进行专业的创意脑暴。

## 输出格式
为每个创意方向提供：
1. **创意概念**（一句话）
2. **详细展开**（100-200 字）
3. **可行性评估**（高/中/低）
4. **与已有剧情的融合度**

请先使用 read_architecture 和 read_project_state 了解项目背景，确保创意与现有设定不矛盾。
至少提供 5 个不同方向的创意。`,
      localizedContent: {
        'en-US': `# Creative Brainstorming

Brainstorm professionally around the user's topic.

## Output format
For every direction, provide:
1. **Concept** in one sentence
2. **Development** in 100-200 words
3. **Feasibility** as high, medium, or low
4. **Fit with the existing plot**

Use read_architecture and read_project_state first so the ideas do not contradict established project facts.
Provide at least five distinct directions.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: brainstorm\ndisplay_name: Creative Brainstorming\ndescription: Generates multiple creative directions and ideas for a chosen topic.\nlanguage: bilingual\nstage: planning\n---\nUse the read_architecture and read_project_state tools before brainstorming.`),
    },
    {
      metadata: {
        name: 'character-analysis',
        displayName: '角色分析',
        description: '深入分析指定角色的性格、动机、角色弧、人物关系等。',
        whenToUse: '用户想深入了解或调整角色设定时',
      },
      content: `# 角色深度分析

请对目标角色进行全方位的深度分析。

## 分析维度
1. **核心性格特质** — MBTI、大五人格倾向
2. **深层动机** — 驱动角色行动的核心诉求
3. **角色弧预测** — 基于当前设定推演角色成长轨迹
4. **关系网络** — 与其他角色的关系图谱
5. **冲突点** — 角色面临的核心矛盾和困境
6. **独特标识** — 口头禅、习惯动作、标志性特征

请先使用 read_characters 读取角色卡，以及 read_architecture 了解故事结构。`,
      localizedContent: {
        'en-US': `# Character Analysis

Analyze the target character in depth.

## Dimensions
1. **Core traits** — including useful personality-framework tendencies
2. **Deep motivation** — the need that drives action
3. **Character arc** — likely development based on established facts
4. **Relationship network** — ties to other characters
5. **Sources of conflict** — central pressures and dilemmas
6. **Distinctive markers** — speech patterns, habits, and recognizable traits

Use read_characters for the character cards and read_architecture for the story structure before analyzing.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: character-analysis\ndisplay_name: Character Analysis\ndescription: Analyzes a character's personality, motivation, arc, and relationships in depth.\nlanguage: bilingual\nstage: planning\n---\nUse the read_characters and read_architecture tools before analyzing the character.`),
    },
    {
      metadata: {
        name: 'continuity-check',
        displayName: '连续性检查',
        description: '检查小说中的设定一致性和连续性问题，发现矛盾和遗漏。',
        whenToUse: '用户想检查设定有没有矛盾、是否有不一致的地方时',
      },
      content: `# 连续性与一致性检查

请对项目进行全面的连续性检查。

## 检查项
1. **时间线一致性** — 事件发生顺序是否合理
2. **地理一致性** — 地点描述是否前后一致
3. **角色状态** — 角色的伤病、装备、能力等是否正确追踪
4. **设定遵守** — 是否与世界观设定产生矛盾
5. **伏笔追踪** — 哪些伏笔已回收，哪些待回收

请使用 list_chapters 了解进度，使用 read_architecture 获取设定，逐章检查关键节点。
输出为表格形式，标注问题严重程度（🔴严重 / 🟡注意 / 🟢正常）。`,
      localizedContent: {
        'en-US': `# Continuity Check

Run a comprehensive continuity check on the project.

## Checks
1. **Timeline** — whether events occur in a plausible order
2. **Geography** — whether locations remain consistent
3. **Character state** — injuries, equipment, abilities, and other tracked state
4. **Setting rules** — conflicts with established worldbuilding
5. **Foreshadowing** — clues already resolved and clues still open

Use list_chapters to understand progress and read_architecture for established facts, then inspect the key points chapter by chapter.
Return a table and label each finding as critical, warning, or clear.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: continuity-check\ndisplay_name: Continuity Check\ndescription: Checks the novel for continuity and setting inconsistencies, contradictions, and omissions.\nlanguage: bilingual\nstage: review\n---\nUse the list_chapters and read_architecture tools for a chapter-by-chapter continuity check.`),
    },
    {
      metadata: {
        name: 'writing-coach',
        displayName: '写作教练',
        description: '提供专业的写作技巧指导和文笔改善建议。',
        whenToUse: '用户想提高写作水平、求教写作技巧时',
      },
      content: `# 写作教练

作为专业的写作教练，为用户提供针对性的指导。

## 指导范围
- 叙述技巧（视角运用、时间线处理）
- 描写技法（环境渲染、人物刻画）
- 对话写作（个性化对话、潜台词运用）
- 节奏控制（场景切换、留白技巧）
- 悬念设置（钩子、反转、暗线）

请先使用 read_project_state 了解项目的写作风格设定，
再根据用户的具体问题提供定制化建议，并附上示例对比。`,
      localizedContent: {
        'en-US': `# Writing Coach

Act as a professional writing coach and give guidance tailored to the user's question.

## Areas
- Narrative technique, including viewpoint and timeline
- Description, including atmosphere and characterization
- Dialogue, including individual voice and subtext
- Pacing, including scene transitions and deliberate omission
- Suspense, including hooks, reversals, and hidden threads

Use read_project_state first to understand the project's established style. Then give focused advice with a short before-and-after example.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: writing-coach\ndisplay_name: Writing Coach\ndescription: Provides professional writing guidance and suggestions for improving prose.\nlanguage: bilingual\nstage: refinement\n---\nUse the read_project_state tool before giving tailored writing advice.`),
    },
  ]

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
