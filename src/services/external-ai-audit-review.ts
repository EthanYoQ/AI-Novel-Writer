/**
 * 外部 AI 审计的**材料装配** —— 点某个入口时真正要复制的那段文本。
 *
 * 先生的关键一课：只把「本章正文」交给网页版 AI，根本不叫一致性审稿 ——
 * 没有前文、没有角色档案、没有世界观，模型判不了「是否与前文矛盾」。
 * 所以这里直接复用软件内置审稿的装配（`prompts/chapter-review-prompt`），
 * 材料一模一样，只是把输出格式换成网页对话更好读的 Markdown。
 *
 * 写作 Skill 也一并带上：
 *  - 内置审稿那边由工作流在发请求时注入（base-command），
 *  - 复制的这条路不经过工作流，必须自己取「审稿」阶段绑定的那份。
 * 两边用的是同一个绑定、同一段注入文本。
 */

import { buildExternalAiAuditClipboardText, EXTERNAL_AI_AUDIT_INSTRUCTIONS_FILE } from '../shared/external-ai-audit'
import type {
  ExternalAiAuditDelivery,
  ExternalAiAuditMaterialSelection,
} from '../shared/external-ai-audit'
import { freezeWritingSkillsSnapshot } from './agent/writing-skill-bindings'
import { buildChapterReviewPrompt } from './prompts/chapter-review-prompt'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'

export interface ExternalAiAuditReviewInput {
  projectSession: ProjectSessionContext
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  /** 编辑器里**当下**这一份正文（作者可能刚敲完还没保存）。 */
  draftContent: string
  /** 作者在弹窗里勾选的审稿维度（与内置审稿同一个值）。 */
  reviewFocus?: string
  novelConfig: Record<string, unknown>
  writingLanguage: WritingLanguage
  locale: 'zh-CN' | 'en-US'
  /** 参与本次审计的材料块；不传＝全带。 */
  sections?: ExternalAiAuditMaterialSelection
  /** 默认走文本投递（一次粘贴最省事）。 */
  delivery?: ExternalAiAuditDelivery
}

/** 一个待写盘的材料文件。 */
export interface ExternalAiAuditFile {
  /** 文件名（含 .md），带序号以保证在对话里的顺序。 */
  name: string
  content: string
}

export interface ExternalAiAuditReviewMaterial {
  delivery: ExternalAiAuditDelivery
  /** 文本投递：直接写进剪贴板的那段。 */
  text: string
  /** 文件投递：逐个写盘并放进剪贴板文件列表的那批文件。 */
  files: ExternalAiAuditFile[]
  /** 本次实际带上的写作 Skill 名字（没绑定就是 null）。 */
  writingSkillName: string | null
  /** 总字符数，用来向作者交代「这次带了多少东西」。 */
  characters: number
  /** 各材料块的字符数。 */
  sectionSizes: Array<{ label: string; characters: number }>
}

/**
 * 取「审稿」阶段当前绑定的写作 Skill。
 *
 * 读失败一律当作「没绑定」：未安装、版本不兼容、绑定文件损坏，
 * 都不应该让整次外部审计失败 —— 这与内置审稿的容错口径一致。
 */
export async function loadReviewWritingSkill(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<{ name: string; content: string } | null> {
  try {
    const snapshot = await freezeWritingSkillsSnapshot(projectSession, writingLanguage)
    const bound = snapshot.review
    return bound ? { name: bound.name, content: bound.content } : null
  } catch {
    return null
  }
}

export async function buildExternalAiAuditReviewMaterial(
  input: ExternalAiAuditReviewInput,
): Promise<ExternalAiAuditReviewMaterial> {
  const delivery: ExternalAiAuditDelivery = input.delivery ?? 'inline'
  const writingSkill = await loadReviewWritingSkill(input.projectSession, input.writingLanguage)

  const review = await buildChapterReviewPrompt({
    projectSession: input.projectSession,
    projectPath: input.projectPath,
    chapterNumber: input.chapterNumber,
    draftContent: input.draftContent,
    reviewFocus: input.reviewFocus,
    novelConfig: input.novelConfig,
    writingLanguage: input.writingLanguage,
    // 网页对话场景：不要 JSON 合同，要人能直接读的报告。
    outputFormat: 'markdown',
    writingSkill,
    sections: input.sections,
    // 文件投递时材料各写一份文件，提示词里只留「见随附文件《X》」，不重复占字数。
    materialDelivery: delivery === 'files' ? 'file-reference' : 'inline',
  })

  if (delivery === 'files') {
    const files: ExternalAiAuditFile[] = [
      {
        name: `${EXTERNAL_AI_AUDIT_INSTRUCTIONS_FILE}.md`,
        content: markdownFile('审稿要求', review.prompt),
      },
      ...review.materialBlocks.map(block => ({
        name: `${block.fileName}.md`,
        content: markdownFile(block.label, block.text),
      })),
    ]
    return {
      delivery,
      text: '',
      files,
      writingSkillName: review.writingSkillName,
      characters: files.reduce((total, file) => total + file.content.length, 0),
      sectionSizes: review.sectionSizes,
    }
  }

  const text = buildExternalAiAuditClipboardText({
    chapterTitle: input.chapterTitle,
    chapterNumber: input.chapterNumber,
    prompt: review.prompt,
    locale: input.locale,
  })

  return {
    delivery,
    text,
    files: [],
    writingSkillName: review.writingSkillName,
    characters: text.length,
    sectionSizes: review.sectionSizes,
  }
}

/** 每个 .md 顶上补一行标题：对方打开文件时一眼知道这份是什么。 */
function markdownFile(label: string, body: string): string {
  return `# ${label}\n\n${body.trim()}\n`
}
