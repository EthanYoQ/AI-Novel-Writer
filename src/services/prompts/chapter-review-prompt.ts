/**
 * 章节审稿提示词的装配 —— **单一来源**。
 *
 * 这份材料清单就是「一致性审稿」能成立的全部前提：
 *   本章正文 · 已定稿连续性事实 · 角色状态 · 世界观总纲 · 本章引用的世界观条目 ·
 *   作者全局创作指导 · 作者确认的项目配置 · 当前与未来五章蓝图 · 本章目标清单
 * 少任何一块，审稿都只能退化成「单章自查」——
 * 比如没有「已定稿连续性事实」，模型根本无从判断「是否与前文矛盾」。
 *
 * 两条调用路径共用这里，谁都不许再自己拼一份：
 *   1. 软件内置审稿（review-chapter.command）—— 发给模型 API，输出 JSON；
 *   2. 外部 AI 审计（草稿编辑器里的收藏夹）—— 复制给网页版 AI，输出 Markdown。
 * 先生要的「网页版也要有内置那种审稿效果」，靠的就是这份提示词一字不差地过去。
 */

import { resolvePromptTemplate } from '../prompt-templates'
import { ReviewPromptBuilder } from './prompt-builder'
import { formatWritingSkillBlock, type WritingSkillBlockSource } from './writing-skill-block'
import { ipc } from '../ipc-client'
import { promptLanguageText } from '../prompt-language'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../shared/character-roster'
import { EXTERNAL_AI_AUDIT_SECTION_LABELS } from '../../shared/external-ai-audit'
import type {
  ExternalAiMaterialSection,
  ExternalAiMaterialSelection,
} from '../../shared/external-ai-audit'
import {
  buildChapterGoalReviewDeferredNote,
  buildChapterGoalReviewPrompt,
  freezeChapterGoals,
  splitChapterGoalsIntoBatches,
  type FrozenChapterGoals,
} from '../../shared/chapter-goal-review'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { FinalizedContinuityProjection } from '../../shared/finalized-continuity'
import type { WritingLanguage } from '../../shared/writing-language'
import type { ChapterBlueprint } from '../workflows/directory-workflow'

/**
 * 审稿注入世界观设定的上限 —— 比写稿（8 条 / 2400 字）**更紧**。
 *
 * 原因：审稿的问题清单有 `items ≤ 10` 的硬上限，且是**共享预算** ——
 * 设定引起的误报挤进来，被挤掉的是真正的伏笔/连贯性问题。
 * 所以审稿这边宁可少给几条，也不要稀释信噪比。
 */
const REVIEW_WORLD_SETTING_MAX_ENTRIES = 5
const REVIEW_WORLD_SETTING_TOTAL_MAX_CHARS = 1600

/** 蓝图取「本章 + 后续五章」：与写稿时的视野一致。 */
const REVIEW_BLUEPRINT_LOOKAHEAD = 5

export type ChapterReviewOutputFormat = 'json' | 'markdown'

export interface ChapterReviewPromptInput {
  projectSession: ProjectSessionContext
  /** 项目路径：db / 知识库 / 世界观读取都要它。 */
  projectPath: string
  chapterNumber: number
  /** 待审正文。 */
  draftContent: string
  /** 作者勾选的审稿维度侧重点（可选）。 */
  reviewFocus?: string
  /** 项目配置快照。调用方从 project-store 取，保证同一次装配用的是同一份。 */
  novelConfig: Record<string, unknown>
  writingLanguage: WritingLanguage
  /** 进度日志。工作流会显示在任务面板；外部审计不需要传。 */
  log?: (message: string) => void
  /**
   * 输出格式。
   *  - `json`（默认）：内置审稿走结构化合同，便于程序解析与回写。
   *  - `markdown`：给网页版 AI 的对话场景，人能直接读。
   */
  outputFormat?: ChapterReviewOutputFormat
  /**
   * 本次要注入的写作 Skill（审稿阶段绑定的那一份）。
   *
   * **内置审稿不要传**：它由工作流在发请求时统一注入（base-command 会把这段
   * 前置到用户消息最前面），这里再传就会注入两次。
   * 外部 AI 审计必须传：复制的文本不经过工作流，不自己带上就等于丢了 Skill。
   */
  writingSkill?: WritingSkillBlockSource | null
  /**
   * 只装配**选中的**材料块。不传＝全带 —— 内置审稿走的正是这条路，行为一字不变。
   * 外部 AI 审计把它接到作者在材料子菜单里的勾选上。
   */
  sections?: ExternalAiMaterialSelection
  /**
   * 材料的投递方式。
   *  - `inline`（默认）：材料内容写进提示词，一整段贴给 AI。
   *  - `file-reference`：材料各写成独立文件，提示词里只留一句「见随附文件《X》」。
   *    文件粘贴（.md 投递）用它，避免正文等内容在提示词与文件里重复一遍。
   */
  materialDelivery?: 'inline' | 'file-reference'
}

/** 一份材料块：既用于拼装提示词，也用于逐块写成文件。审稿与修稿共用这个形状。 */
export interface ChapterMaterialBlock {
  key: ExternalAiMaterialSection
  label: string
  /** 写文件用的名字（不含扩展名，带序号以便在对话里保持顺序）。 */
  fileName: string
  /** 该块的内容；未参与本次代劳时为空串。 */
  text: string
  characters: number
}

/** 兼容旧名。 */
export type ChapterReviewMaterialBlock = ChapterMaterialBlock

export interface ChapterReviewPrompt {
  /** 完整提示词：模板正文 + 全部上下文材料。 */
  prompt: string
  /** 与内置审稿完全一致的 system role。 */
  systemRole: string
  /** 本次实际带上的写作 Skill 名字（没带就是 null）。 */
  writingSkillName: string | null
  /** 各材料块的字符数，用于向作者交代「这次带了多少上下文」。 */
  sectionSizes: Array<{ label: string; characters: number }>
  /**
   * 本次真正参与的材料块（顺序即拼装顺序）。
   * 外部 AI 审计据此逐块写 .md 文件；文本投递只用它的字数做提示。
   */
  materialBlocks: ChapterReviewMaterialBlock[]
  /** 冻结后的本章目标清单 —— 内置审稿随后要用它做逐项核对。 */
  frozenGoals: FrozenChapterGoals
  /** 目标清单分批方案（清单长时内置审稿会另起多次小调用）。 */
  goalBatches: ReturnType<typeof splitChapterGoalsIntoBatches>
  /** 目标清单是否短到可以随主审稿一次做完。 */
  inlineGoalReview: boolean
}

/** 已定稿历史 —— 模型唯一的「已经发生过什么」来源。 */
export function formatFinalizedHistory(
  projections: readonly FinalizedContinuityProjection[],
  writingLanguage: WritingLanguage,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【已确认定稿历史｜唯一已发生事实源】',
    '[Finalized history | the only source of events that have already happened]',
  )
  if (projections.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（当前章节之前没有已定稿历史）',
    '(there is no finalized history before the current chapter)',
  )}`
  return [
    header,
    ...projections.map((projection) => {
      const facts = (projection.facts ?? []).map(fact => promptLanguageText(
        writingLanguage,
        `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
        `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
      ))
      return [
        promptLanguageText(
          writingLanguage,
          `### 第${projection.chapterNumber}章 ${projection.chapterTitle}`,
          `### Chapter ${projection.chapterNumber}: ${projection.chapterTitle}`,
        ),
        projection.chapterNotes,
        ...facts,
      ].filter(Boolean).join('\n')
    }),
  ].join('\n\n')
}

/** 当前与未来蓝图 —— 刻意标注为「非既定历史」，免得模型把计划当既成事实。 */
export function formatReviewPlanningMaterial(
  blueprints: readonly ChapterBlueprint[],
  writingLanguage: WritingLanguage,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【当前及未来蓝图/计划｜非既定历史】',
    '[Current and future blueprints/plans | not established history]',
  )
  if (blueprints.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（无当前或后续蓝图）',
    '(no current or future blueprints)',
  )}`
  const plans = blueprints.map(blueprint => ({
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters,
    suspenseHook: blueprint.suspenseHook,
    userGuidance: blueprint.userGuidance,
  }))
  return `${header}\n${JSON.stringify(plans, null, 2)}`
}

/**
 * 读取角色状态档案。
 *
 * 导出给修稿那条路复用 —— 审稿与修稿看到的「角色状态」必须是同一份文本，
 * 否则同一章在两边会得到不同的判断口径。
 */
export async function readCharacterStates(
  projectPath: string,
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<string> {
  try {
    const allChars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
    const states: string[] = []
    for (const card of allChars) {
      if (card.name && card.currentState) {
        const cs = card.currentState
        const authorState = Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.flatMap((field) => {
          const provenance = cs.provenance?.[field]
          return provenance?.kind === 'author' && cs[field]
            ? [[field, `${cs[field]} @ch${provenance.chapterNumber}`]]
            : []
        }))
        if (Object.keys(authorState).length === 0) continue
        states.push(promptLanguageText(
          writingLanguage,
          `${card.name}（${card.role || '未知'}）作者状态（按标注章节理解，非永久约束）: ${JSON.stringify(authorState)}`,
          `${card.name} (${card.role || 'unknown'}) author state (time-bound to the annotated chapter, not permanent): ${JSON.stringify(authorState)}`,
        ))
      }
    }
    return states.length > 0 ? states.join('\n') : promptLanguageText(writingLanguage, '（暂无）', '(none)')
  } catch { return promptLanguageText(writingLanguage, '（读取失败）', '(unavailable)') }
}

async function readWorldBuilding(
  projectPath: string,
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<string> {
  const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
  return core?.worldbuilding || promptLanguageText(writingLanguage, '（暂无）', '(none)')
}

/**
 * 本章引用的世界观设定条目 —— 只取作者在「本章引用」区声明过的那几条。
 *
 * 三个刻意的取舍（先生拍板）：
 * 1. **只取本章引用的**，不取全库：写稿时 AI 看到的也只是这几条。
 *    如果审稿能看到全库，就会出现「审稿拿写稿不知道的设定去判写稿有罪」——
 *    审稿用自己的信息优势否定写稿，作者只会被搞糊涂。
 * 2. **只取 confirmed**：pending 是还没经作者确认的候选，不能拿它当裁判标准。
 * 3. **严格限量**（5 条 / 1600 字）：审稿的问题清单有 `items ≤ 10` 的硬上限，
 *    误报挤进来会**挤掉真正重要的问题**，所以这里的量必须比写稿更克制。
 */
async function readReferencedWorldSettings(
  chapterNumber: number,
  projectPath: string,
  writingLanguage: WritingLanguage,
): Promise<string> {
  const refs = await ipc.invoke('world-setting:list-chapter-refs', chapterNumber, projectPath)
  if (!Array.isArray(refs) || refs.length === 0) return ''
  const entries = await ipc.invoke('world-setting:list', projectPath)
  if (!Array.isArray(entries)) return ''
  const byId = new Map<number, (typeof entries)[number]>()
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'number') byId.set(entry.id, entry)
  }
  const blocks: string[] = []
  let usedChars = 0
  for (const ref of refs) {
    if (blocks.length >= REVIEW_WORLD_SETTING_MAX_ENTRIES) break
    if (!ref || typeof ref !== 'object' || typeof ref.settingId !== 'number') continue
    const entry = byId.get(ref.settingId)
    if (!entry || entry.status === 'pending') continue
    const detail = typeof entry.content === 'string' && entry.content.trim().length > 0
      ? entry.content.trim()
      : (entry.summary ?? '').trim()
    if (!detail) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    const block = `- ${name}：${detail}`
    if (usedChars + block.length > REVIEW_WORLD_SETTING_TOTAL_MAX_CHARS) break
    blocks.push(block)
    usedChars += block.length
  }
  if (blocks.length === 0) return ''

  /**
   * 措辞是这里的关键 —— 先生特别要求防误报。
   *
   * 绝不能写成「以下是本章设定，请逐条核对」：
   * 那样等于要求它逐条审，会产出大量「设定 A 没被违反」这类 filler，
   * 白占 items 的 10 条预算，把真正的伏笔/连贯性问题挤出去。
   * 所以定性为**对照参考**、只在明显违反时开口、且必须双引证。
   */
  return promptLanguageText(
    writingLanguage,
    `【本章引用的世界观设定（**对照参考，不是检查清单**）】
仅当本章正文**直接、明显地**违反下列已确认条文时，才归入「剧情合理性」维度报告；
报告时必须同时引用**正文原句**与**所违反的设定条文**。
未被违反就不要提及，也不要新增审查维度，更不要为未违反的条目输出 pass 项。

${blocks.join('\n')}`,
    `[World-setting entries referenced by this chapter (reference only, NOT a checklist)]
Report a problem **only** when this chapter's text directly and clearly violates one of the confirmed entries below, and file it under the "plot plausibility" dimension;
you must quote both the **draft sentence** and the **violated entry text**.
If an entry is not violated, do not mention it, do not add a new review dimension, and do not emit a pass item for it.

${blocks.join('\n')}`,
  )
}

/**
 * 网页对话场景的输出格式说明。
 *
 * 内置模板结尾那份合同是写给模型 API 的（严格 JSON、字段字数上限），
 * 粘到网页版 AI 的输入框里既难读也没必要。这里明确要求「覆盖上文 JSON 要求」——
 * 放在提示词最后一句，模型会照办。
 */
function markdownOutputOverride(writingLanguage: WritingLanguage): string {
  return promptLanguageText(
    writingLanguage,
    `【本次输出格式｜请覆盖上文关于 JSON 的要求】
这一次是网页对话，请**不要输出 JSON**，直接用中文 Markdown 回答：

1. 按维度分组列出问题；每条以「【错误】」「【建议】」「【待核实】」之一开头，说明问题是什么、依据是什么。
2. 每条问题必须引用本章正文里的**具体句子**作为证据（原句照引，不要改写）。
3. 没有问题的维度写一句「未发现问题」即可，不要为了凑数而编造，也不要把「未违反」当作发现来报告。
4. 不要评价文笔与风格，只报告可验证的事实矛盾与不合理之处。
5. 最后用一句话给出总体评价。`,
    `[Output format for this run | supersedes the JSON requirement above]
This is a web chat, so **do not output JSON**. Answer directly in Markdown:

1. Group the problems by dimension. Start each one with 【错误】, 【建议】, or 【待核实】 and explain what is wrong and why.
2. Every problem must quote the **exact sentence** from the chapter draft as evidence (quote it verbatim; do not paraphrase).
3. For a dimension with no problems, one line saying "no issues found" is enough. Do not invent findings to fill the list, and do not report non-violations as findings.
4. Do not comment on prose style; report only verifiable factual contradictions and implausibilities.
5. End with a one-sentence overall assessment.`,
  )
}

/**
 * 装配一份完整的章节审稿提示词。
 *
 * 任何一块上下文读不到都不会让整件事失败 —— 各自的读取函数内部已经降级成
 * 「（暂无）/（读取失败）」之类的占位文本，与内置审稿的处理方式完全一致：
 * 审稿不能因为某条可选材料缺失就整体不做了。
 */
export async function buildChapterReviewPrompt(
  input: ChapterReviewPromptInput,
): Promise<ChapterReviewPrompt> {
  const { projectSession, projectPath, chapterNumber, draftContent, writingLanguage } = input
  const log = input.log ?? (() => {})
  const draft = draftContent
  if (!draft) throw new Error(promptLanguageText(writingLanguage, '无草稿内容', 'There is no draft content to review.'))

  log(promptLanguageText(writingLanguage, '  读取已定稿连续性事实...', '  Reading finalized continuity facts...'))

  let contextSummary = formatFinalizedHistory([], writingLanguage)
  try {
    const projections = await ipc.invokeWithProjectSession(
      projectSession,
      'db:continuity-list-before',
      chapterNumber,
      projectPath,
    )
    contextSummary = formatFinalizedHistory(projections, writingLanguage)
  } catch {
    contextSummary = promptLanguageText(
      writingLanguage,
      '【已确认定稿历史｜唯一已发生事实源】\n（连续性投影暂时不可用；未使用知识库资料替代）',
      '[Finalized history | the only source of events that have already happened]\n(continuity projection unavailable; knowledge-base material was not substituted)',
    )
  }

  const characterState = await readCharacterStates(projectPath, projectSession, writingLanguage)
  const worldBuilding = await readWorldBuilding(projectPath, projectSession, writingLanguage)
  // 本章引用的世界观条目：审稿的**对照基准**（只含作者为本章声明引用的那几条）。
  // 读失败按「本章没有引用」处理 —— 审稿不能因为这条可选信息而整体失败。
  let referencedWorldSettings = ''
  try {
    referencedWorldSettings = await readReferencedWorldSettings(chapterNumber, projectPath, writingLanguage)
  } catch {
    referencedWorldSettings = ''
  }

  const novelConfig = input.novelConfig

  /**
   * 材料取舍。
   *
   * 不传选择＝全带：内置审稿走的正是这条路，一个字节都不变。
   * `file-reference` 投递时材料内容不进提示词，只留一句「见随附文件《X》」——
   * 那些内容会各自写成 .md，免得在提示词与文件里各存一份重复的正文。
   */
  const wants = (section: ExternalAiMaterialSection) => input.sections?.[section] ?? true
  const fileReference = input.materialDelivery === 'file-reference'
  const sectionLabel = (section: ExternalAiMaterialSection) => promptLanguageText(
    writingLanguage,
    EXTERNAL_AI_AUDIT_SECTION_LABELS[section].zh,
    EXTERNAL_AI_AUDIT_SECTION_LABELS[section].en,
  )
  const materialValue = (
    section: ExternalAiMaterialSection,
    content: string,
  ): string => {
    if (!wants(section)) return ''
    if (!fileReference) return content
    return promptLanguageText(
      writingLanguage,
      `（内容见随附文件：《${EXTERNAL_AI_AUDIT_SECTION_LABELS[section].zh}》）`,
      `(see the attached file: "${EXTERNAL_AI_AUDIT_SECTION_LABELS[section].en}")`,
    )
  }

  const globalGuidance = String(novelConfig.globalGuidance ?? '').trim() || promptLanguageText(
    writingLanguage,
    '（无作者全局创作指导）',
    '(no author global creative guidance)',
  )
  const authorGuidanceSection = wants('authorGuidance')
    ? promptLanguageText(
      writingLanguage,
      `【作者全局创作指导｜约束而非已发生事实】\n${
        fileReference ? materialValue('authorGuidance', globalGuidance) : globalGuidance}`,
      `[Author global creative guidance | constraint, not established history]\n${
        fileReference ? materialValue('authorGuidance', globalGuidance) : globalGuidance}`,
    )
    : ''
  const authorConfigJson = JSON.stringify(novelConfig, null, 2)
  const authorConfigSection = wants('projectConfig')
    ? promptLanguageText(
      writingLanguage,
      `【作者确认项目配置｜约束而非已发生事实】\n${
        fileReference ? materialValue('projectConfig', authorConfigJson) : authorConfigJson}`,
      `[Author-confirmed project configuration | constraint, not established history]\n${
        fileReference ? materialValue('projectConfig', authorConfigJson) : authorConfigJson}`,
    )
    : ''

  let planningMaterial = formatReviewPlanningMaterial([], writingLanguage)
  let frozenGoals = freezeChapterGoals(chapterNumber, undefined)
  try {
    const { loadDirectoryBlueprints } = await import('../workflows/directory-workflow')
    const blueprints = (await loadDirectoryBlueprints(projectPath, projectSession))
      .filter(blueprint => (
        blueprint.chapterNumber >= chapterNumber
        && blueprint.chapterNumber <= chapterNumber + REVIEW_BLUEPRINT_LOOKAHEAD
      ))
    planningMaterial = formatReviewPlanningMaterial(blueprints, writingLanguage)
    frozenGoals = freezeChapterGoals(chapterNumber,
      blueprints.find(blueprint => blueprint.chapterNumber === chapterNumber)?.keyEvents ?? null)
  } catch {
    planningMaterial = promptLanguageText(
      writingLanguage,
      '【当前及未来蓝图/计划｜非既定历史】\n（蓝图读取暂时不可用）',
      '[Current and future blueprints/plans | not established history]\n(blueprint retrieval unavailable)',
    )
  }
  // 留一份原件给「逐块写文件」用：file-reference 投递会把上面这份替换成文件指引
  const planningMaterialForFile = planningMaterial
  if (!wants('blueprints')) planningMaterial = ''
  else if (fileReference) planningMaterial = materialValue('blueprints', planningMaterial)

  const template = await resolvePromptTemplate('consistency_check', projectSession, writingLanguage)
  if (!template) {
    throw new Error(promptLanguageText(writingLanguage, '未找到审稿模板', 'The review prompt template was not found.'))
  }

  const promptBuilder = new ReviewPromptBuilder(template, writingLanguage)
    .withChapterContent(materialValue('chapterContent', draft))
    .withCharacterStates(materialValue('characterStates', characterState))
    .withGlobalSummary(materialValue('finalizedHistory', contextSummary))
    .withWorldBuilding(materialValue('worldBuilding', worldBuilding))
    .withReviewFocus(input.reviewFocus || '')

  /**
   * 目标逐项核对：清单短就随主审稿一次做完；清单长就拆成小批次分别核对。
   *
   * 先生（审稿截断事故）：逐项核对的输出长度正比于清单条数，条数一多，单次调用
   * 最容易顶到模型输出上限、让整份报告作废。切批之后每批只核对几项，输出天然变短。
   * 外部审计场景下网页版 AI 一次回答，所以清单长时给的是一句「另行分批核对」的说明 ——
   * 这也与内置审稿在主提示词里写的是同一句。
   */
  const goalBatches = splitChapterGoalsIntoBatches(frozenGoals)
  const inlineGoalReview = goalBatches.length <= 1

  /* 写作 Skill 前置在最前面 —— 与内置工作流的注入位置一字不差。 */
  const writingSkillBlockRaw = input.writingSkill
    ? formatWritingSkillBlock(input.writingSkill, writingLanguage)
    : ''
  const skillBlock = input.writingSkill
    ? materialValue('writingSkill', writingSkillBlockRaw)
    : ''

  if (!wants('referencedSettings')) referencedWorldSettings = ''

  const goalReviewSection = wants('chapterGoals')
    ? (inlineGoalReview
      ? buildChapterGoalReviewPrompt(frozenGoals, writingLanguage)
      : buildChapterGoalReviewDeferredNote(writingLanguage))
    : ''

  const prompt = [
    skillBlock,
    promptBuilder.build(),
    authorGuidanceSection,
    authorConfigSection,
    // 独立成段而不是塞进 withWorldBuilding（那是架构总纲）：
    // 让「总纲」与「本章引用条目」各司其职，也方便日后分别追踪来源。
    referencedWorldSettings,
    planningMaterial,
    goalReviewSection,
    ...(input.outputFormat === 'markdown' ? [markdownOutputOverride(writingLanguage)] : []),
  ].filter(Boolean).join('\n\n')

  /*
    逐块存档：文本投递只需要它们的字数，文件投递则把每块各写成一个 .md。
    未参与的块（text 为空）不进列表 —— 免得先生拿到一个空文件。
  */
  const materialBlocks: ChapterReviewMaterialBlock[] = ([
    { key: 'writingSkill', text: wants('writingSkill') ? writingSkillBlockRaw : '' },
    { key: 'chapterContent', text: wants('chapterContent') ? draft : '' },
    { key: 'finalizedHistory', text: wants('finalizedHistory') ? contextSummary : '' },
    { key: 'characterStates', text: wants('characterStates') ? characterState : '' },
    { key: 'worldBuilding', text: wants('worldBuilding') ? worldBuilding : '' },
    { key: 'referencedSettings', text: referencedWorldSettings },
    {
      key: 'authorGuidance',
      text: wants('authorGuidance')
        ? promptLanguageText(
          writingLanguage,
          `【作者全局创作指导｜约束而非已发生事实】\n${globalGuidance}`,
          `[Author global creative guidance | constraint, not established history]\n${globalGuidance}`,
        )
        : '',
    },
    { key: 'projectConfig', text: wants('projectConfig') ? authorConfigJson : '' },
    { key: 'blueprints', text: wants('blueprints') ? planningMaterialForFile : '' },
    { key: 'chapterGoals', text: goalReviewSection },
  ] as Array<{ key: ExternalAiMaterialSection; text: string }>).map(entry => ({
    key: entry.key,
    label: sectionLabel(entry.key),
    fileName: EXTERNAL_AI_AUDIT_SECTION_LABELS[entry.key].fileName,
    text: entry.text,
    characters: entry.text.length,
  })).filter(block => block.characters > 0)

  return {
    prompt,
    systemRole: promptBuilder.getSystemRole(),
    writingSkillName: skillBlock ? (input.writingSkill?.name ?? null) : null,
    sectionSizes: materialBlocks.map(block => ({ label: block.label, characters: block.characters })),
    materialBlocks,
    frozenGoals,
    goalBatches,
    inlineGoalReview,
  }
}
