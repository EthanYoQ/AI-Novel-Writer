/**
 * DrawInspirationCommand — 便利贴的「AI 灵感抽卡」
 *
 * 先生定的规矩（2026-09-20）：
 *   · 一次出 1–10 条，**每条硬上限 500 字**；
 *   · 几条之间必须方向不同，不许同义改写凑数；
 *   · 产物只进便利贴 —— 它**不写入任何创作事实**，也不进写稿上下文。
 *
 * 这是它与世界观候选命令（generate-world-setting.command）的根本区别：
 * 那边产出的是「等着被作者确认的资料」，所以要 pending / confirmed 那道闸门；
 * 这边产出的只是点子，连 pending 都不需要 —— 作者想留就留，想扔就扔。
 *
 * 上下文来源全部由作者在弹窗里亲手点选：四个架构勾选框 + @ 引用的条目 + 自己的话。
 * 这里**不去自动检索**任何别的东西（不查知识库、不读草稿）：抽卡要的是作者当下
 * 脑子里那个方向，不是让模型把全书写一遍。
 */
import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'
import type { StickyMentionRef } from '../../../shared/sticky-note'
import {
  STICKY_DRAW_MAX_COUNT,
  STICKY_IDEA_MAX_CHARS,
  clampStickyIdea,
} from '../../../shared/sticky-note'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { composePromptSystemRole, renderPrompt, resolvePromptTemplate } from '../../prompt-templates'
import { ipc } from '../../ipc-client'
import { readCoreContent } from '../../vela-protocol'

/** 四个架构勾选框 —— 与侧栏「故事架构」下的四份文件一一对应。 */
export const STICKY_ARCH_FILES = [
  { key: 'premise', file: 'vela://core/premise', zh: '故事前提', en: 'Premise' },
  { key: 'characters', file: 'vela://core/characters', zh: '角色图谱', en: 'Character map' },
  { key: 'worldbuilding', file: 'vela://core/worldbuilding', zh: '世界观', en: 'World building' },
  { key: 'synopsis', file: 'vela://core/synopsis', zh: '情节大纲', en: 'Plot synopsis' },
] as const

export type StickyArchKey = typeof STICKY_ARCH_FILES[number]['key']

export interface DrawInspirationRequest {
  includePremise: boolean
  includeCharacters: boolean
  includeWorldbuilding: boolean
  includeSynopsis: boolean
  mentions: StickyMentionRef[]
  idea: string
  count: number
}

/**
 * 单份架构文档注入提示词的字节上限。
 *
 * 长篇写到后期，四份文档加起来轻松过万，全塞进去会把「作者自己的想法」挤到边上，
 * 而后者才是这次抽卡真正的主语。超限就截断，并在文里写明截断了 —— 绝不静默吞掉。
 */
const MAX_ARCH_CHARS = 3000
/** 单条 @ 引用注入的长度上限。 */
const MAX_MENTION_CHARS = 800
/** 引用条目数上限：再多就不像「点名参考」而像全量检索了。 */
const MAX_MENTIONS = 12

function truncate(text: string, maxChars: number): string {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}\n…（内容过长，已截断）`
}

function asTrimmed(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : ''
}

/**
 * 解析模型返回的点子卡。
 *
 * 与世界观候选同样先剥壳再找对象：模型偶尔会套一层 Markdown 代码块或写句开场白。
 * 每条再用 clampStickyIdea 过一道 —— 提示词里已经把 500 字写成硬上限，
 * 这里是第二道兜底，超出来的那截不许落进先生的本子。
 */
export function parseInspirationCards(raw: string, limit: number): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  let text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) text = fenced[1].trim()
  const start = text.indexOf('{')
  if (start === -1) return salvageInspirationIdeas(text, limit)
  const end = text.lastIndexOf('}')
  // 末尾少了 `}` 多半是撞上 max_tokens 被截断 —— 这时候仍然值得往下抢救。
  const body = end > start ? text.slice(start, end + 1) : text.slice(start)
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return salvageInspirationIdeas(text, limit)
  }
  const cards = (parsed as { cards?: unknown })?.cards
  if (!Array.isArray(cards)) return salvageInspirationIdeas(text, limit)

  const candidates: string[] = []
  for (const item of cards) {
    // 兼容模型把卡片写成裸字符串（而不是 {"idea": "..."}）的情况。
    const rawIdea = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? (item as Record<string, unknown>).idea : '')
    candidates.push(asTrimmed(rawIdea, STICKY_IDEA_MAX_CHARS * 2))
  }
  return collectInspirationIdeas(candidates, limit)
}

/**
 * 统一收口：过 500 字上限、去重、按本次要的条数截取。
 *
 * 两条解析路径（正规 JSON / 抢救）都走这里，免得两边的规矩各写一遍、
 * 日后各漂各的。
 */
function collectInspirationIdeas(candidates: readonly string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    const idea = clampStickyIdea(asTrimmed(candidate, STICKY_IDEA_MAX_CHARS * 2))
    if (!idea || seen.has(idea)) continue
    seen.add(idea)
    result.push(idea)
    if (result.length >= limit) break
  }
  return result
}

/**
 * 兜底抢救：整段 JSON 解析不了时，逐条把**已经写完整**的 `"idea"` 字段抠出来。
 *
 * 先生的原话是「token 不能白烧」。最典型的翻车形态是输出撞上 max_tokens：
 * 前六条完好，第七条说到一半就断了，末尾缺了 `]}`。严格 JSON.parse 一抛错，
 * 前面那六条本来好好的点子也跟着一起被扔掉 —— 等了几分钟的东西就这么没了。
 *
 * 只认「引号已经闭合」的字符串，所以半截的第七条天然捞不进来（宁缺毋滥）。
 * 合法 JSON 根本走不到这里，因此正规路径的行为与从前一字不差。
 */
function salvageInspirationIdeas(text: string, limit: number): string[] {
  const pattern = /"idea"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  const candidates: string[] = []
  for (const match of text.matchAll(pattern)) {
    try {
      candidates.push(JSON.parse(`"${match[1]}"`) as string)
    } catch {
      // 转义不合法时按原文用，总好过丢掉。
      candidates.push(match[1])
    }
  }
  return collectInspirationIdeas(candidates, limit)
}

export class DrawInspirationCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly request: DrawInspirationRequest,
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
        '当前项目已切换，灵感抽卡已停止',
        'The project changed, so the inspiration draw stopped.',
      ))
    }

    const count = Math.min(Math.max(Math.floor(this.request.count) || 1, 1), STICKY_DRAW_MAX_COUNT)
    const storyContext = await this.collectArchitecture(projectSession)
    const references = await this.collectMentions(projectSession.projectPath, projectSession)

    callbacks.log(workflowUiText(
      context,
      `正在按作者给的方向攒 ${count} 条灵感…`,
      `Drafting ${count} idea${count > 1 ? 's' : ''} from your direction…`,
    ))

    const writingLanguage = workflowWritingLanguage(context)
    const template = await resolvePromptTemplate('inspiration_draw', projectSession, writingLanguage)
    if (!template) {
      throw new Error(workflowUiText(
        context,
        '未找到灵感抽卡提示词',
        'The inspiration prompt is unavailable.',
      ))
    }

    const prompt = renderPrompt(template, {
      story_context: storyContext || workflowUiText(context, '（作者这次没有勾选任何底稿）', '(the author included no background material)'),
      references: references || workflowUiText(context, '（作者这次没有点名参考任何条目）', '(the author referenced no entries)'),
      idea: this.request.idea.trim() || workflowUiText(context, '（作者这次没有写下自己的想法）', '(the author wrote no idea)'),
      count: String(count),
    }, writingLanguage)

    return await this.callLLM(
      prompt,
      composePromptSystemRole(template, writingLanguage),
      callbacks,
      { purpose: 'sticky-inspiration', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
  }

  /**
   * 作者勾选参与的故事架构。
   *
   * 只读作者**勾了**的那几份；一份没勾就返回空串，由调用处写成「没有勾选」，
   * 而不是拿整部作品去填 —— 抽卡的方向感来自作者的点选，不来自默认值。
   * 四份文档各自读失败都不致命：少一份底稿，照样能出点子。
   */
  private async collectArchitecture(projectSession: ProjectSessionContext): Promise<string> {
    const wanted = STICKY_ARCH_FILES.filter(file => (
      (file.key === 'premise' && this.request.includePremise)
      || (file.key === 'characters' && this.request.includeCharacters)
      || (file.key === 'worldbuilding' && this.request.includeWorldbuilding)
      || (file.key === 'synopsis' && this.request.includeSynopsis)
    ))
    if (wanted.length === 0) return ''

    const blocks: string[] = []
    for (const file of wanted) {
      let content = ''
      try {
        content = await readCoreContent(file.file, projectSession)
      } catch {
        content = ''
      }
      const body = truncate(content, MAX_ARCH_CHARS)
      blocks.push(body
        ? `【${file.zh}】\n${body}`
        : `【${file.zh}】\n（这一项还没有内容）`)
    }
    return blocks.join('\n\n')
  }

  /**
   * 把 @ 点名的条目读成提示词里的一段。
   *
   * 三类各走各的路：角色读名单、设定读设定库、蓝图读蓝图表。
   * **任何一类读失败都只降级成条目名**，绝不让整次抽卡失败 ——
   * 作者要的是点子，不是一次数据完整性审计。
   */
  private async collectMentions(
    projectPath: string,
    projectSession: ProjectSessionContext,
  ): Promise<string> {
    const mentions = this.request.mentions.slice(0, MAX_MENTIONS)
    if (mentions.length === 0) return ''

    const lines: string[] = []
    for (const mention of mentions) {
      const name = mention.name.trim()
      if (!name) continue
      let detail = ''
      try {
        if (mention.type === 'character') {
          detail = await this.readCharacterMention(projectPath, projectSession, name)
        } else if (mention.type === 'world-setting') {
          detail = await this.readWorldSettingMention(projectPath, projectSession, name)
        } else if (mention.type === 'draft') {
          detail = await this.readChapterMention(projectSession, 'draft', mention.value)
        } else if (mention.type === 'manuscript') {
          detail = await this.readChapterMention(projectSession, 'manuscript', mention.value)
        } else {
          detail = await this.readBlueprintMention(projectPath, projectSession, name)
        }
      } catch {
        detail = ''
      }
      lines.push(detail ? `- ${name}：${truncate(detail, MAX_MENTION_CHARS)}` : `- ${name}`)
    }
    return lines.join('\n')
  }

  private async readCharacterMention(
    projectPath: string,
    projectSession: ProjectSessionContext,
    name: string,
  ): Promise<string> {
    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath)
    if (roster.status !== 'ready' && roster.status !== 'empty') return ''
    const card = roster.entries.find(entry => entry.name.trim() === name)
    if (!card) return ''
    return [
      card.role && `角色定位：${card.role}`,
      card.gender && `性别：${card.gender}`,
      card.age && `年龄：${card.age}`,
      card.appearance && `外貌：${card.appearance}`,
      card.personality && `性格：${card.personality}`,
      card.background && `背景：${card.background}`,
      card.motivation && `动机：${card.motivation}`,
      card.arc && `弧光：${card.arc}`,
      card.notes && `备注：${card.notes}`,
    ].filter(Boolean).join('；')
  }

  private async readWorldSettingMention(
    projectPath: string,
    projectSession: ProjectSessionContext,
    name: string,
  ): Promise<string> {
    const entries = await ipc.invokeWithProjectSession(projectSession, 'world-setting:list', projectPath)
    const entry = (Array.isArray(entries) ? entries : [])
      .find(item => item.name.trim() === name && item.status !== 'pending')
    if (!entry) return ''
    return [
      entry.summary && `摘要：${entry.summary}`,
      entry.content && `详情：${entry.content}`,
    ].filter(Boolean).join('；')
  }

  /**
   * 读**具体某一稿 / 某一章定稿**的正文。
   *
   * 走 `vela://` 伪协议 —— 与编辑器打开章节走的是同一条路，所以拿到的就是作者
   * 眼前看到的那一份。整章可能几千字，后面统一由 MAX_MENTION_CHARS 截断。
   *
   * value 是草稿 id（先生从 @ 菜单里选的那一稿）。旧记录若没带 value，
   * 就读不回内容，届时只保留条目名 —— 不猜、不按名字乱找。
   */
  private async readChapterMention(
    projectSession: ProjectSessionContext,
    kind: 'draft' | 'manuscript',
    value: string | undefined,
  ): Promise<string> {
    if (!value) return ''
    const { readVelaContent } = await import('../../vela-protocol')
    return await readVelaContent(`vela://${kind}/${value}`, projectSession)
  }

  private async readBlueprintMention(
    projectPath: string,
    projectSession: ProjectSessionContext,
    name: string,
  ): Promise<string> {
    // 蓝图条目的显示名形如「第12章 雨夜」；章节号是它唯一的稳定身份。
    const match = name.match(/\d+/)
    if (!match) return ''
    const chapterNumber = Number(match[0])
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) return ''
    const blueprint = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-get', chapterNumber, projectPath,
    )
    if (!blueprint) return ''
    return [
      blueprint.title && `标题：${blueprint.title}`,
      blueprint.role && `本章角色：${blueprint.role}`,
      blueprint.purpose && `核心目的：${blueprint.purpose}`,
      blueprint.keyEvents && `关键事件：${blueprint.keyEvents}`,
    ].filter(Boolean).join('；')
  }
}
