/**
 * 章节修稿提示词的装配 —— 与内置「直接修稿」同源。
 *
 * 内置修稿（refine-draft.command）发给模型的是：
 *   正文 · 章节信息 · 作者全局写作指导 · 目标字数 · 文风 · 作者的额外修稿指示
 * 加上模板自带的六条精修要求（画面感 / 设定咬合 / 情绪张力 / 词汇升级 / 钩子节奏 / 防注水）
 * 与「纯文本、禁 Markdown、段间空行」的输出合同。
 *
 * 这里照抄同一套材料与合同，只做两处**对外**的适配：
 *  1. 输出改成网页对话好交付的形式 —— 请它把正文放进一个代码块，
 *     先生一键复制就不会把客套话带进稿子；
 *  2. 可选多带「已定稿剧情事实」与「角色状态」。内置直接修稿这两个变量其实是空的
 *     （工作流没给它摘要），改稿时看不到前文很容易改出矛盾 ——
 *     网页版 AI 上下文宽裕，把这份补上，是外部路线真正的加分项。
 */

import { resolvePromptTemplate } from '../prompt-templates'
import { ChapterPromptBuilder } from './prompt-builder'
import { formatWritingSkillBlock, type WritingSkillBlockSource } from './writing-skill-block'
import { formatFinalizedHistory, readCharacterStates } from './chapter-review-prompt'
import type { ChapterMaterialBlock } from './chapter-review-prompt'
import { ipc } from '../ipc-client'
import { promptLanguageText } from '../prompt-language'
import { EXTERNAL_AI_MATERIAL_SECTION_LABELS } from '../../shared/external-ai-audit'
import type {
  ExternalAiMaterialSection,
  ExternalAiMaterialSelection,
} from '../../shared/external-ai-audit'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'

/** 内置修稿在项目没配字数时的兜底值，与写稿链路保持一致。 */
const DEFAULT_WORDS_PER_CHAPTER = 3000

export interface ChapterRefinePromptInput {
  projectSession: ProjectSessionContext
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  /** 编辑器里**当下**这一份正文。 */
  draftContent: string
  /** 作者在修稿弹窗里填的额外要求（最高优先级）。 */
  userRefinePrompt?: string
  novelConfig: Record<string, unknown>
  writingLanguage: WritingLanguage
  /** `markdown`：网页对话交付（正文放进代码块）。`plain`：与内置一致。 */
  outputFormat?: 'plain' | 'markdown'
  /** 修稿阶段（refinement）绑定的写作 Skill。 */
  writingSkill?: WritingSkillBlockSource | null
  /** 只装配选中的材料块；不传＝全带。 */
  sections?: ExternalAiMaterialSelection
  materialDelivery?: 'inline' | 'file-reference'
}

export interface ChapterRefinePrompt {
  prompt: string
  systemRole: string
  writingSkillName: string | null
  sectionSizes: Array<{ label: string; characters: number }>
  materialBlocks: ChapterMaterialBlock[]
}

/** 网页对话的交付说明：把正文整段放进代码块，方便先生一键取回。 */
function webChatDeliveryNote(writingLanguage: WritingLanguage): string {
  return promptLanguageText(
    writingLanguage,
    '【本次在网页对话中交付】请把精修后的**正文全文**放进一个 Markdown 代码块里（三个反引号），代码块之外不要写任何说明、点评或开场白 —— 这样作者能一键复制正文，不会把多余的话带进稿子。',
    '[Delivered in a web chat] Put the **full revised chapter** inside a single Markdown code block (triple backticks) and write nothing outside it — so the author can copy the prose in one go without dragging commentary into the manuscript.',
  )
}

export async function buildChapterRefinePrompt(
  input: ChapterRefinePromptInput,
): Promise<ChapterRefinePrompt> {
  const { projectSession, projectPath, chapterNumber, writingLanguage } = input
  const draft = input.draftContent
  if (!draft) {
    throw new Error(promptLanguageText(writingLanguage, '无草稿内容', 'There is no draft content to revise.'))
  }

  const wants = (section: ExternalAiMaterialSection) => input.sections?.[section] ?? true
  const fileReference = input.materialDelivery === 'file-reference'
  const labels = EXTERNAL_AI_MATERIAL_SECTION_LABELS
  const sectionLabel = (section: ExternalAiMaterialSection) =>
    promptLanguageText(writingLanguage, labels[section].zh, labels[section].en)
  const materialValue = (section: ExternalAiMaterialSection, content: string): string => {
    if (!wants(section)) return ''
    if (!fileReference) return content
    return promptLanguageText(
      writingLanguage,
      `（内容见随附文件：《${labels[section].zh}》）`,
      `(see the attached file: "${labels[section].en}")`,
    )
  }

  // 章节信息：与内置直接修稿一致 —— 只给章号与标题，蓝图那几个字段内置也是空的。
  const chapterInfoText = JSON.stringify({ chapterNumber, title: input.chapterTitle }, null, 2)

  let finalizedHistory = ''
  if (wants('finalizedHistory')) {
    try {
      const projections = await ipc.invokeWithProjectSession(
        projectSession,
        'db:continuity-list-before',
        chapterNumber,
        projectPath,
      )
      finalizedHistory = formatFinalizedHistory(projections, writingLanguage)
    } catch {
      finalizedHistory = ''
    }
  }
  const characterStates = wants('characterStates')
    ? await readCharacterStates(projectPath, projectSession, writingLanguage)
    : ''

  const novelConfig = input.novelConfig
  const globalGuidance = String(novelConfig.globalGuidance ?? '').trim()
  const writingStyle = String(novelConfig.writingStyle ?? '').trim()
  const wordsPerChapter = Number(novelConfig.wordsPerChapter) || DEFAULT_WORDS_PER_CHAPTER

  const authorNotes = input.userRefinePrompt?.trim() ?? ''
  const userPromptBlock = authorNotes
    ? promptLanguageText(
      writingLanguage,
      `【用户额外修稿指导（最高优先级）】\n${authorNotes}`,
      `[Additional author revision guidance — highest priority]\n${authorNotes}`,
    )
    : ''

  /*
    角色状态档案。
    修稿模板本身**没有** character_states 变量（内置直接修稿也不喂角色状态），
    所以这里作为独立段追加：改稿最怕把角色的位置、能力、状态改错，
    而这几样恰恰只在角色档案里写着。措辞上明确「照着写、别改写」，
    免得模型把它当成新的创作素材。
  */
  const characterStatesSection = characterStates
    ? materialValue(
      'characterStates',
      promptLanguageText(
        writingLanguage,
        `【角色状态档案｜保持一致，不要改写这些设定】\n${characterStates}`,
        `[Character state reference | stay consistent, do not rewrite these facts]\n${characterStates}`,
      ),
    )
    : ''

  const template = await resolvePromptTemplate('refine_chapter', projectSession, writingLanguage)
  if (!template) {
    throw new Error(promptLanguageText(writingLanguage, '未找到修稿模板', 'The revision prompt template was not found.'))
  }

  const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
    .withDraftContent(materialValue('chapterContent', draft))
    .withChapterInfo(materialValue('chapterInfo', chapterInfoText))
    .withGlobalGuidance(materialValue('authorGuidance', globalGuidance))
    // 模板里 global_summary / short_summary 分别是「全书进度」与「近期章节回顾」；
    // 给同一份已定稿事实即可（内置直接把两个都传了同一个值）。
    .withGlobalSummary(materialValue('finalizedHistory', finalizedHistory))
    .withShortSummary(materialValue('finalizedHistory', finalizedHistory))
    .withWordNumber(wants('targetLength') ? String(wordsPerChapter) : '')
    .withWritingStyle(materialValue('writingStyle', writingStyle))
    .withUserRefinePrompt(materialValue('userRefinePrompt', userPromptBlock))

  const writingSkillBlockRaw = input.writingSkill
    ? formatWritingSkillBlock(input.writingSkill, writingLanguage)
    : ''
  const skillBlock = input.writingSkill ? materialValue('writingSkill', writingSkillBlockRaw) : ''

  const prompt = [
    skillBlock,
    promptBuilder.build(),
    characterStatesSection,
    ...(input.outputFormat === 'markdown' ? [webChatDeliveryNote(writingLanguage)] : []),
  ].filter(Boolean).join('\n\n')

  const materialBlocks: ChapterMaterialBlock[] = ([
    { key: 'writingSkill', text: wants('writingSkill') ? writingSkillBlockRaw : '' },
    { key: 'chapterContent', text: wants('chapterContent') ? draft : '' },
    { key: 'chapterInfo', text: wants('chapterInfo') ? chapterInfoText : '' },
    { key: 'finalizedHistory', text: finalizedHistory },
    { key: 'characterStates', text: characterStates },
    { key: 'authorGuidance', text: wants('authorGuidance') ? globalGuidance : '' },
    { key: 'writingStyle', text: wants('writingStyle') ? writingStyle : '' },
    { key: 'targetLength', text: wants('targetLength') ? `${wordsPerChapter}` : '' },
    { key: 'userRefinePrompt', text: wants('userRefinePrompt') ? authorNotes : '' },
  ] as Array<{ key: ExternalAiMaterialSection; text: string }>).map(entry => ({
    key: entry.key,
    label: sectionLabel(entry.key),
    fileName: labels[entry.key].fileName,
    text: entry.text,
    characters: entry.text.length,
  })).filter(block => block.characters > 0)

  return {
    prompt,
    systemRole: promptBuilder.getSystemRole(),
    writingSkillName: skillBlock ? (input.writingSkill?.name ?? null) : null,
    sectionSizes: materialBlocks.map(block => ({ label: block.label, characters: block.characters })),
    materialBlocks,
  }
}
