/**
 * GenerateWorldSettingCandidatesCommand — 按分类产出世界观设定候选
 *
 * 先生定的三条硬规矩：
 *   1. **分析式生成**，不是「一键铺满分类」：只产出与剧情推进、伏笔、人物行动
 *      真正相关的设定；与主线无关的背景名词一律不产。
 *   2. **一次不要太多**（默认上限 8 条），宁缺毋滥。
 *   3. **先预览再入库**：本命令只产出候选，作者在预览里勾选后才写库。
 *
 * 上下文来源：作品概览（小说配置）+ 故事架构的世界观文档 + 已有条目名（去重）
 *            + 知识库检索片段。产物是 JSON 数组，解析与校验都在这里完成，
 *            调用方拿到的是干净的结构化候选。
 */
import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { composePromptSystemRole, resolvePromptTemplate, renderPrompt } from '../../prompt-templates'
import { ipc } from '../../ipc-client'
import { readCoreContent } from '../../vela-protocol'
import { normalizeWorldSettingImportance } from '../../../shared/world-setting'
import type { WorldSettingImportance } from '../../../shared/world-setting'
import { useWorldSettingStore } from '../../../stores/world-setting-store'

/** 候选条目：AI 建议的归属分类与「为什么值得立条」的理由都带上，供作者判断。 */
export interface WorldSettingCandidate {
  name: string
  aliases: string[]
  summary: string
  content: string
  tags: string[]
  importance: WorldSettingImportance
  /** AI 建议的归属分类 key（允许与本次请求的分类不同）。 */
  category: string
  /** 为什么它与剧情强相关 —— 预览时给作者看的判据。 */
  reason: string
}

/** 一次生成的条数上限。先生：不要太多，宁可少而准。 */
export const WORLD_SETTING_CANDIDATE_LIMIT = 8

/**
 * 注入提示词的上下文上限。
 *
 * 先生提的「令牌冲突」防的就是这里：长篇写到后期，条目上百、架构几千字，
 * 光「已有条目」这一段就能吃掉大半提示词预算，把真正该给模型的篇幅挤没。
 * 去重只需要"知道有哪些名字"，不需要全文 —— 所以按条数与字数双重截断。
 */
const MAX_CONTEXT_ENTRIES = 120
const MAX_CONTEXT_CHARS = 4000

function truncateForContext(text: string, maxChars: number): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n…（内容过长，已截断）`
}

/** 单条内容长度上限，挡住模型偶尔的失控输出。 */
const MAX_SUMMARY_CHARS = 200
const MAX_CONTENT_CHARS = 2000

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
    if (result.length >= limit) break
  }
  return result
}

function asTrimmedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

/**
 * 解析模型返回的候选 JSON。
 *
 * 模型偶尔会套一层 Markdown 代码块或写点开场白，所以先剥壳再找第一个数组。
 * 任何解析不出来的情况都返回空数组 —— 生成失败不该让界面炸掉。
 */
export function parseWorldSettingCandidates(raw: string, fallbackCategory: string): WorldSettingCandidate[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let text = raw.trim()
  // 剥掉 ```json ... ``` 外壳
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) text = fenced[1].trim()
  // 取第一个 '[' 到最后一个 ']'（前面可能有解释性文字）
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const seenNames = new Set<string>()
  const candidates: WorldSettingCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = asTrimmedString(record.name, 200)
    if (!name || seenNames.has(name)) continue
    seenNames.add(name)
    candidates.push({
      name,
      aliases: asStringArray(record.aliases, 8),
      summary: asTrimmedString(record.summary, MAX_SUMMARY_CHARS),
      content: asTrimmedString(record.content, MAX_CONTENT_CHARS),
      tags: asStringArray(record.tags, 8),
      importance: normalizeWorldSettingImportance(record.importance),
      category: asTrimmedString(record.category, 64) || fallbackCategory,
      reason: asTrimmedString(record.reason, 200),
    })
    if (candidates.length >= WORLD_SETTING_CANDIDATE_LIMIT) break
  }
  return candidates
}

export class GenerateWorldSettingCandidatesCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly request: {
      /** 本次要生成的分类 key。 */
      categoryKey: string
      maxCandidates?: number
    },
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (
      !project
      || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))
    ) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，设定生成已停止',
        'The current project changed, so setting generation stopped.',
      ))
    }

    const store = useWorldSettingStore.getState()
    const category = store.categories.find(item => item.key === this.request.categoryKey)
    if (!category) {
      throw new Error(workflowUiText(context, '找不到该分类，请刷新后重试', 'That category no longer exists; refresh and try again.'))
    }

    const config = project.novelConfig
    const projectBrief = [
      `类型：${config.genre || '未设置'}${config.subGenre ? ` / ${config.subGenre}` : ''}`,
      `计划总章数：${config.totalChapters}`,
      `核心大纲：${config.coreOutline || '（作者未填）'}`,
      `作者的世界设定：${config.worldSetting || '（作者未填）'}`,
      `主角人设：${config.protagonistProfile || '（作者未填）'}`,
    ].join('\n')

    // 故事架构里的世界观文档 —— 是「总纲」，本次生成要与它一致。
    let architecture = ''
    try {
      architecture = await readCoreContent('vela://core/worldbuilding', projectSession)
    } catch {
      architecture = ''
    }
    if (!architecture.trim()) {
      try {
        architecture = await readCoreContent('vela://core/premise', projectSession)
      } catch {
        architecture = ''
      }
    }

    // 已有条目（含待确认候选）全部算作「已有」，避免生成出换名重出的东西。
    // 但只给前 MAX_CONTEXT_ENTRIES 条并砍掉多余别名 —— 去重不需要通读全部条目。
    const allEntries = store.entries
    const existingEntries = allEntries
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map(entry => {
        const aliases = entry.aliases.length > 0
          ? `（别名：${entry.aliases.slice(0, 3).join('、')}）`
          : ''
        return `- [${entry.category}] ${entry.name}${aliases}`
      })
      .join('\n')
      + (allEntries.length > MAX_CONTEXT_ENTRIES
        ? `\n（另有 ${allEntries.length - MAX_CONTEXT_ENTRIES} 条未列出；若与它们同名请勿重复生成）`
        : '')

    const categoryList = store.categories
      .map(item => `- ${item.key} = ${item.zhCN}${item.descriptionZhCN ? `：${item.descriptionZhCN}` : ''}`)
      .join('\n')

    // 知识库素材：先生要求「根据已有的知识库或正文来生成」。
    // 检索失败（未配置向量模型等）不影响生成，只是少了一份参考。
    let knownMaterial = ''
    try {
      const search = await ipc.invoke(
        'kb:search-writing-context',
        `${config.genre || ''} ${category.zhCN} ${category.descriptionZhCN || ''}`.trim() || category.zhCN,
        5,
        projectSession.projectPath,
      )
      if (Array.isArray(search)) {
        // 每条片段截断：知识库命中往往是大段正文，全塞进去会挤掉设定本身的篇幅。
        knownMaterial = search
          .map(hit => `· ${truncateForContext(hit.text, 400)}`)
          .join('\n')
      }
    } catch {
      knownMaterial = ''
    }

    callbacks.log(workflowUiText(
      context,
      `正在分析作品与已有素材，生成「${category.zhCN}」候选…`,
      `Analyzing the project and existing material to draft “${category.enUS}” candidates…`,
    ))

    const template = await resolvePromptTemplate('world_setting_candidates', projectSession, workflowWritingLanguage(context))
    if (!template) {
      throw new Error(workflowUiText(context, '未找到设定生成提示词', 'The setting-generation prompt is unavailable.'))
    }
    const prompt = renderPrompt(template, {
      project_brief: projectBrief,
      architecture: truncateForContext(architecture, MAX_CONTEXT_CHARS) || '（尚未生成故事架构）',
      existing_entries: existingEntries || '（暂无）',
      category_label: category.zhCN,
      category_description: category.descriptionZhCN || '（作者未填说明，请按分类名自行判断范围）',
      category_list: categoryList,
      known_material: knownMaterial || '（知识库暂无相关素材）',
      target_count: String(this.request.maxCandidates ?? WORLD_SETTING_CANDIDATE_LIMIT),
    }, workflowWritingLanguage(context))
    const systemPrompt = composePromptSystemRole(template, workflowWritingLanguage(context))

    return await this.callLLM(
      prompt,
      systemPrompt,
      callbacks,
      { purpose: 'world-setting-candidates', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
  }
}

/** 单条目生成的建议：填进表单，由作者决定是否保存。 */
export interface WorldSettingEntrySuggestion {
  summary: string
  content: string
  aliases: string[]
  tags: string[]
}

/**
 * 解析单条目生成的 JSON。
 * 与候选解析同样先剥壳再找对象；解析不出来返回空建议（界面据此提示失败）。
 */
export function parseWorldSettingEntrySuggestion(raw: string): WorldSettingEntrySuggestion {
  const empty: WorldSettingEntrySuggestion = { summary: '', content: '', aliases: [], tags: [] }
  if (typeof raw !== 'string' || !raw.trim()) return empty
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return empty
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    return {
      summary: asTrimmedString(parsed.summary, MAX_SUMMARY_CHARS),
      content: asTrimmedString(parsed.content, MAX_CONTENT_CHARS),
      aliases: asStringArray(parsed.aliases, 8),
      tags: asStringArray(parsed.tags, 8),
    }
  } catch {
    return empty
  }
}

/**
 * 单条目生成命令 —— 先生：条目编辑页也要能一键让 AI 写完整。
 *
 * 与「批量候选」的分工：这里作者已经定好了**条目名与分类**，
 * 命令只负责把这一条写扎实（摘要 / 详情 / 别名 / 标签），产出直接填进表单。
 */
export class GenerateWorldSettingEntryCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly request: {
      categoryKey: string
      name: string
      existingSummary?: string
      existingContent?: string
    },
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (
      !project
      || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))
    ) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，条目生成已停止',
        'The current project changed, so entry generation stopped.',
      ))
    }

    const store = useWorldSettingStore.getState()
    const category = store.categories.find(item => item.key === this.request.categoryKey)
    if (!category) {
      throw new Error(workflowUiText(context, '找不到该分类，请刷新后重试', 'That category no longer exists; refresh and try again.'))
    }

    const config = project.novelConfig
    const projectBrief = [
      `类型：${config.genre || '未设置'}${config.subGenre ? ` / ${config.subGenre}` : ''}`,
      `核心大纲：${config.coreOutline || '（作者未填）'}`,
      `作者的世界设定：${config.worldSetting || '（作者未填）'}`,
      `主角人设：${config.protagonistProfile || '（作者未填）'}`,
    ].join('\n')

    let architecture = ''
    try {
      architecture = await readCoreContent('vela://core/worldbuilding', projectSession)
    } catch {
      architecture = ''
    }

    // 作者已经写下的东西要原样进提示词 —— 命令的职责是补全，不是改写。
    const existingDraft = [
      this.request.existingSummary?.trim() ? `摘要：${this.request.existingSummary.trim()}` : '',
      this.request.existingContent?.trim() ? `正文：\n${this.request.existingContent.trim()}` : '',
    ].filter(Boolean).join('\n\n')

    const siblingEntries = store.entries
      .filter(entry => entry.category === this.request.categoryKey && entry.name !== this.request.name)
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map(entry => `- ${entry.name}${entry.summary ? `：${truncateForContext(entry.summary, 120)}` : ''}`)
      .join('\n')

    callbacks.log(workflowUiText(context, `正在补全「${this.request.name}」…`, `Drafting “${this.request.name}”…`))

    const template = await resolvePromptTemplate('world_setting_entry', projectSession, workflowWritingLanguage(context))
    if (!template) {
      throw new Error(workflowUiText(context, '未找到条目生成提示词', 'The entry-generation prompt is unavailable.'))
    }
    const prompt = renderPrompt(template, {
      project_brief: projectBrief,
      architecture: truncateForContext(architecture, MAX_CONTEXT_CHARS) || '（尚未生成故事架构）',
      category_label: category.zhCN,
      category_description: category.descriptionZhCN || '（作者未填说明，请按分类名自行判断范围）',
      entry_name: this.request.name,
      existing_draft: existingDraft || '（作者还没有写任何内容）',
      sibling_entries: siblingEntries || '（同分类下暂无其它条目）',
    }, workflowWritingLanguage(context))
    const systemPrompt = composePromptSystemRole(template, workflowWritingLanguage(context))

    return await this.callLLM(
      prompt,
      systemPrompt,
      callbacks,
      { purpose: 'world-setting-entry', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
  }
}
