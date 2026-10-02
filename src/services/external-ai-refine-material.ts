/**
 * 外部 AI 修稿的材料装配 —— 点某个入口时真正要复制/写盘的那份东西。
 *
 * 与审稿那条路完全对称：修稿材料由 `chapter-refine-prompt` 装配（与内置直接修稿同源），
 * 这里只负责三件事 —— 取「修稿」阶段绑定的写作 Skill、包一层抬头、按投递方式
 * 输出文本或逐块 .md 文件。
 *
 * 与审稿唯一的结构性差别在**产物**：审稿交回的是报告（先生读完就算数），
 * 修稿交回的是**正文**，所以软件这侧还多一条回流的通道（见板块上的「贴回改好的正文」）。
 */

import {
  buildExternalAiAuditClipboardText,
  EXTERNAL_AI_MATERIAL_SECTION_LABELS,
} from '../shared/external-ai-audit'
import type {
  ExternalAiAuditDelivery,
  ExternalAiMaterialSelection,
} from '../shared/external-ai-audit'
import { freezeWritingSkillsSnapshot } from './agent/writing-skill-bindings'
import { buildChapterRefinePrompt } from './prompts/chapter-refine-prompt'
import type { ExternalAiAuditFile } from './external-ai-audit-review'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { WritingLanguage } from '../shared/writing-language'

export interface ExternalAiRefineMaterialInput {
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
  locale: 'zh-CN' | 'en-US'
  sections?: ExternalAiMaterialSelection
  delivery?: ExternalAiAuditDelivery
}

export interface ExternalAiRefineMaterial {
  delivery: ExternalAiAuditDelivery
  /** 文本投递：直接写进剪贴板的那段。 */
  text: string
  /** 文件投递：逐个写盘并放进剪贴板文件列表的那批文件。 */
  files: ExternalAiAuditFile[]
  writingSkillName: string | null
  characters: number
  sectionSizes: Array<{ label: string; characters: number }>
}

/**
 * 取「修稿」阶段当前绑定的写作 Skill（内置修稿用的是 refinement 阶段）。
 * 读失败一律当「没绑定」—— 与内置修稿的容错口径一致。
 */
export async function loadRefineWritingSkill(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<{ name: string; content: string } | null> {
  try {
    const snapshot = await freezeWritingSkillsSnapshot(projectSession, writingLanguage)
    const bound = snapshot.refinement
    return bound ? { name: bound.name, content: bound.content } : null
  } catch {
    return null
  }
}

export async function buildExternalAiRefineMaterial(
  input: ExternalAiRefineMaterialInput,
): Promise<ExternalAiRefineMaterial> {
  const delivery: ExternalAiAuditDelivery = input.delivery ?? 'inline'
  const writingSkill = await loadRefineWritingSkill(input.projectSession, input.writingLanguage)

  const refine = await buildChapterRefinePrompt({
    projectSession: input.projectSession,
    projectPath: input.projectPath,
    chapterNumber: input.chapterNumber,
    chapterTitle: input.chapterTitle,
    draftContent: input.draftContent,
    userRefinePrompt: input.userRefinePrompt,
    novelConfig: input.novelConfig,
    writingLanguage: input.writingLanguage,
    // 网页对话：要求它把正文放进代码块，先生一键取回。
    outputFormat: 'markdown',
    writingSkill,
    sections: input.sections,
    materialDelivery: delivery === 'files' ? 'file-reference' : 'inline',
  })

  if (delivery === 'files') {
    const files: ExternalAiAuditFile[] = [
      {
        name: `${EXTERNAL_AI_MATERIAL_SECTION_LABELS.refineInstructions.fileName}.md`,
        content: markdownFile('修稿要求', refine.prompt),
      },
      ...refine.materialBlocks.map(block => ({
        name: `${block.fileName}.md`,
        content: markdownFile(block.label, block.text),
      })),
    ]
    return {
      delivery,
      text: '',
      files,
      writingSkillName: refine.writingSkillName,
      characters: files.reduce((total, file) => total + file.content.length, 0),
      sectionSizes: refine.sectionSizes,
    }
  }

  const text = buildExternalAiAuditClipboardText({
    chapterTitle: input.chapterTitle,
    chapterNumber: input.chapterNumber,
    prompt: refine.prompt,
    locale: input.locale,
    intent: 'refine',
  })

  return {
    delivery,
    text,
    files: [],
    writingSkillName: refine.writingSkillName,
    characters: text.length,
    sectionSizes: refine.sectionSizes,
  }
}

/** 每个 .md 顶上补一行标题：对方打开文件时一眼知道这份是什么。 */
function markdownFile(label: string, body: string): string {
  return `# ${label}\n\n${body.trim()}\n`
}
