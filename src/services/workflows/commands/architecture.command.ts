import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import {
  composePromptSystemRole,
  renderPromptTaskGuidance,
  resolvePromptTemplate,
} from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { characterArchitecturePrompts, promptLanguageText } from '../../prompt-language'
import { stripThinkingTags } from '../workflow-utils'
import type { WorkflowContext } from '../../../stores/workflow-store'
import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ProjectCoreSynopsisExpected } from '../../../../electron/repositories/project-core-repository'
import type { WritingLanguage } from '../../../shared/writing-language'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  CHARACTER_ROSTER_ROLES,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  GENERATED_GLOBAL_GUIDANCE_MAX_RULES,
  GENERATED_GLOBAL_GUIDANCE_MIN_RULES,
  isGeneratedGlobalGuidanceValid,
  mergeExpandedNovelConfig,
} from '../novel-config-expansion'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  /** 情节大纲：已确认覆盖至 synopsis_covered_to 的纯正文（不含批次进度行）。 */
  synopsis_result?: string
  /** 上一次生成在本批范围内被输出长度中断；synopsis_result 为已完成部分。 */
  synopsis_incomplete?: boolean
  /** 最近一次成功批次的结束章（== totalChapters 时全书大纲完成）。 */
  synopsis_covered_to?: number
  /** 当前/上次生成批次的范围；断点续写恢复时沿用。 */
  synopsis_range?: { from: number; to: number }
  /** 大纲赖以生成的源事实指纹；源事实变化后禁止续写旧检查点。 */
  synopsis_facts_fingerprint?: string
  /** 上次写入 DB 的大纲全文指纹；用于检测大纲是否被手动编辑（防续批覆盖用户修改）。 */
  synopsis_db_hash?: string
  /** 与 synopsis_result 精确绑定；旧检查点缺失时由 DB 逐字等价校验兼容。 */
  synopsis_body_hash?: string
  /** 本批实际使用的作者步骤指导；恢复必须沿用，不读取新输入。 */
  synopsis_step_guidance?: string
}

const SYNOPSIS_CHECKPOINT_FIELDS = [
  'synopsis_result',
  'synopsis_incomplete',
  'synopsis_covered_to',
  'synopsis_range',
  'synopsis_facts_fingerprint',
  'synopsis_db_hash',
  'synopsis_body_hash',
  'synopsis_step_guidance',
] as const satisfies readonly (keyof PartialArchData)[]

function sameSynopsisCheckpoint(
  left: PartialArchData,
  right: PartialArchData,
): boolean {
  return SYNOPSIS_CHECKPOINT_FIELDS.every(field => (
    JSON.stringify(left[field]) === JSON.stringify(right[field])
  ))
}

function restoreSynopsisCheckpoint(
  current: PartialArchData,
  previous: PartialArchData,
): PartialArchData {
  const restored = { ...current }
  for (const field of SYNOPSIS_CHECKPOINT_FIELDS) {
    Object.assign(restored, { [field]: previous[field] })
  }
  return restored
}

/** 大纲章节范围。 */
export interface PlotOutlineChapterRange {
  from: number
  to: number
}

/**
 * 情节大纲生成被输出长度中断、且已完成部分已自动保存时抛出的错误。
 * errorCode 供前端识别并展示「继续生成情节大纲」断点续写按钮。
 */
export const PLOT_OUTLINE_RESUME_ERROR_CODE = 'architecture-synopsis-resume-available'

export class PlotOutlineResumeAvailableError extends Error {
  readonly code = PLOT_OUTLINE_RESUME_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'PlotOutlineResumeAvailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 少于该字符数视为无保存价值的零碎输出，不落盘、不提供续写。 */
const MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS = 120

/** 落库时追加在未完成大纲末尾的可见标记（帮助用户识别与编辑器提示）。 */
const SYNOPSIS_INCOMPLETE_MARKER_ZH = [
  '',
  '> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。',
  '> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。',
  '',
].join('\n')

const SYNOPSIS_INCOMPLETE_MARKER_EN = [
  '',
  '> ⚠ **This outline is incomplete**: generation stopped at the output length limit; the completed part above was saved automatically.',
  '> Click “Continue plot outline” in the AI output notice to resume this batch.',
  '',
].join('\n')

/**
 * 批次进度行的双语模板。模型只有在完整覆盖本批第 from–to 章之后，才允许
 * 以独立一行输出该进度行；机械校验以此区分「完整批次」与「被截断的半截
 * 输出」（许多网关把输出上限截断误报为 finishReason=stop）。
 */
function plotOutlineProgressLine(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  return promptLanguageText(
    writingLanguage,
    `大纲批次进度：已覆盖第${from}–${to}章，全书共${totalChapters}章`,
    `[Outline batch progress: covered chapters ${from}-${to} of ${totalChapters}]`,
  )
}

interface PlotOutlineProgressMark {
  from: number
  to: number
  totalChapters: number
}

const ZH_PROGRESS_MARK_RE = /大纲批次进度：已覆盖第(\d+)[–—-](\d+)章，全书共(\d+)章/gu
const EN_PROGRESS_MARK_RE = /\[Outline batch progress: covered chapters (\d+)[\s-]+(\d+) of (\d+)\]/gu

function findPlotOutlineProgressMark(text: string): PlotOutlineProgressMark | null {
  for (const match of text.matchAll(ZH_PROGRESS_MARK_RE)) {
    const from = Number(match[1])
    const to = Number(match[2])
    const totalChapters = Number(match[3])
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(totalChapters)) {
      return { from, to, totalChapters }
    }
  }
  for (const match of text.matchAll(EN_PROGRESS_MARK_RE)) {
    const from = Number(match[1])
    const to = Number(match[2])
    const totalChapters = Number(match[3])
    if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(totalChapters)) {
      return { from, to, totalChapters }
    }
  }
  return null
}

/** 从已确认正文中移除批次进度行（成功批次落盘前剔除）。 */
function stripPlotOutlineProgressLine(text: string): string {
  return text
    .replace(ZH_PROGRESS_MARK_RE, '')
    .replace(EN_PROGRESS_MARK_RE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

interface PlotOutlineTitleRange {
  from: number
  to: number
  index: number
  headingLineEnd: number
}

class NonRecoverablePlotOutlineError extends Error {}

const CHINESE_CHAPTER_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
})
const CHINESE_CHAPTER_UNITS: Readonly<Record<string, number>> = Object.freeze({ 十: 10, 百: 100, 千: 1000 })
const CHAPTER_NUMBER_TOKEN = '[0-9零〇一二两三四五六七八九十百千]+'
const ZH_CHAPTER_TITLE_RE = new RegExp(
  `^[\\t ]*(?:#{1,6}[\\t ]+|[-*+][\\t ]+)?第(${CHAPTER_NUMBER_TOKEN})(?:[–—-](${CHAPTER_NUMBER_TOKEN}))?章(?=[\\t ]*(?:[:：.．—-]|$))`,
  'gmu',
)
const EN_CHAPTER_TITLE_RE = /^[\t ]*(?:#{1,6}[\t ]+|[-*+][\t ]+)?Chapters?[\t ]+(\d+)(?:[\t ]*[–—-][\t ]*(\d+))?(?=[\t ]*(?:[:.：—-]|$))/gimu

function parseChapterNumberToken(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    const value = Number(token)
    return Number.isSafeInteger(value) ? value : null
  }
  let result = 0
  let digit = 0
  for (const char of token) {
    if (char in CHINESE_CHAPTER_DIGITS) {
      digit = CHINESE_CHAPTER_DIGITS[char]!
      continue
    }
    const unit = CHINESE_CHAPTER_UNITS[char]
    if (!unit) return null
    result += (digit || 1) * unit
    digit = 0
  }
  return result + digit
}

function findPlotOutlineTitleRanges(text: string): PlotOutlineTitleRange[] {
  const ranges: PlotOutlineTitleRange[] = []
  for (const regex of [ZH_CHAPTER_TITLE_RE, EN_CHAPTER_TITLE_RE]) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      const from = parseChapterNumberToken(match[1]!)
      const to = parseChapterNumberToken(match[2] ?? match[1]!)
      if (from !== null && to !== null) {
        const index = match.index ?? 0
        const lineEnd = text.indexOf('\n', index)
        ranges.push({
          from,
          to,
          index,
          headingLineEnd: lineEnd < 0 ? text.length : lineEnd,
        })
      }
    }
  }
  return ranges.sort((left, right) => left.index - right.index)
}

function assertPlotOutlineTitleCoverage(
  merged: string,
  seedText: string,
  from: number,
  to: number,
  uiText: UiText,
): void {
  const seedPriorCounts = new Map<string, number>()
  for (const range of findPlotOutlineTitleRanges(seedText)) {
    if (range.to >= from) continue
    const key = `${range.from}:${range.to}`
    seedPriorCounts.set(key, (seedPriorCounts.get(key) ?? 0) + 1)
  }
  const covered = new Set<number>()
  const invalid: string[] = []
  const entries = findPlotOutlineTitleRanges(merged)
  let nextExpectedChapter = from
  for (const [index, range] of entries.entries()) {
    const key = `${range.from}:${range.to}`
    if (range.to < from) {
      const remaining = seedPriorCounts.get(key) ?? 0
      if (remaining > 0) seedPriorCounts.set(key, remaining - 1)
      else invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from < from || range.to > to || range.from > range.to) {
      invalid.push(`${range.from}-${range.to}`)
      continue
    }
    if (range.from !== nextExpectedChapter) invalid.push(`${range.from}-${range.to}`)
    nextExpectedChapter = Math.max(nextExpectedChapter, range.to + 1)
    const nextHeadingIndex = entries[index + 1]?.index ?? merged.length
    const entryBody = stripPlotOutlineProgressLine(
      merged.slice(Math.min(range.headingLineEnd + 1, merged.length), nextHeadingIndex),
    ).trim()
    if (!entryBody) invalid.push(`${range.from}-${range.to}:empty`)
    for (let chapter = range.from; chapter <= range.to; chapter += 1) {
      if (covered.has(chapter)) invalid.push(String(chapter))
      covered.add(chapter)
    }
  }
  const missing: number[] = []
  for (let chapter = from; chapter <= to; chapter += 1) {
    if (!covered.has(chapter)) missing.push(chapter)
  }
  if (invalid.length > 0 || missing.length > 0) {
    const message = uiText(
      `大纲正文未按顺序提供本批第 ${from}–${to} 章的非空条目（缺失 ${missing.length} 章，空白、重复、乱序或越界 ${invalid.length} 处），结果未按完成保存。`,
      `The outline body does not provide non-empty entries in order for batch chapters ${from}-${to} (${missing.length} missing; ${invalid.length} empty, duplicate, out of order, or out of range), so the result was not saved as complete.`,
    )
    if (invalid.length > 0) {
      throw new NonRecoverablePlotOutlineError(uiText(
        `${message} 完整模型输出仍保留在 AI 输出中，但这种结构错误不能自动续写；请修正范围后重新生成。`,
        `${message} The complete model output remains visible in AI output, but this structural error cannot be continued automatically; correct the range and regenerate.`,
      ))
    }
    throw new Error(message)
  }
}

/** 轻量确定性指纹：绑定大纲赖以生成的源事实，防止旧检查点被续到新上下文。 */
export function synopsisFactsFingerprint(facts: readonly string[]): string {
  const joined = facts.join('\u0001')
  let hash = 5381
  for (let index = 0; index < joined.length; index += 1) {
    hash = ((hash << 5) + hash + joined.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

function renderSynopsisDbText(
  body: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  checkpoint: Pick<PartialArchData, 'synopsis_incomplete' | 'synopsis_covered_to'>,
): string {
  const heading = promptLanguageText(writingLanguage, '情节大纲', 'Plot Outline')
  if (checkpoint.synopsis_incomplete === true) {
    const marker = promptLanguageText(
      writingLanguage,
      SYNOPSIS_INCOMPLETE_MARKER_ZH,
      SYNOPSIS_INCOMPLETE_MARKER_EN,
    )
    return `# ${heading}\n\n${body}\n${marker}`.trim()
  }
  const coveredTo = checkpoint.synopsis_covered_to ?? totalChapters
  const visibleBody = coveredTo < totalChapters
    ? `${body}\n\n${promptLanguageText(
        writingLanguage,
        `> 本大纲已覆盖至第 ${coveredTo} 章（全书 ${totalChapters} 章），其余章节将在后续批次继续生成。`,
        `> This outline covers chapters 1-${coveredTo} of ${totalChapters}; the remaining chapters will be generated in later batches.`,
      )}`
    : body
  return `# ${heading}\n\n${visibleBody}`.trim()
}

function synopsisInputsFingerprint(
  expected: ProjectCoreSynopsisExpected,
  stepGuidance: string,
  range: PlotOutlineChapterRange,
  template: unknown,
): string {
  const sourceInputs = {
    premise: expected.premise,
    charactersArch: expected.charactersArch,
    worldbuilding: expected.worldbuilding,
    genre: expected.genre,
    totalChapters: expected.totalChapters,
    wordsPerChapter: expected.wordsPerChapter,
    writingLanguage: expected.writingLanguage,
    plotStructure: expected.plotStructure,
    narrativePov: expected.narrativePov,
    globalGuidance: expected.globalGuidance,
  }
  return synopsisFactsFingerprint([
    JSON.stringify(sourceInputs),
    stepGuidance,
    `${range.from}:${range.to}`,
    JSON.stringify(template),
  ])
}

/**
 * 「本批生成范围」指令：批次可任意处于第 from–to 章。当 from > 1 时模型
 * 必须从已有前缀（seed）末尾自然衔接继续写；to < total 时剩余章节只允许
 * 一行占位概览，等待后续批次补齐。
 */
function synopsisBatchInstruction(
  writingLanguage: WritingLanguage,
  from: number,
  to: number,
  totalChapters: number,
): string {
  const leading = from > 1
    ? promptLanguageText(
        writingLanguage,
        `第 1–${from - 1} 章的大纲已在【已完成大纲前缀】中给出：不得重复、改写或复述该前缀；从第 ${from} 章起自然衔接继续书写。`,
        `Chapters 1-${from - 1} are already covered in the [confirmed outline prefix]: do not repeat, rewrite, or restate it; continue naturally from chapter ${from}.`,
      )
    : ''
  const trailing = to < totalChapters
    ? promptLanguageText(
        writingLanguage,
        `第 ${to + 1}–${totalChapters} 章本次不展开细写：只写一行“后续概览：……”概览整段走向（不超过 200 字），等待后续批次继续生成。该行不得使用“第N章”或“第N–M章”标题，也不计入本批覆盖。`,
        `Chapters ${to + 1}-${totalChapters} must not be expanded in this batch: write one short “Later overview: ...” line (200 characters or fewer) for that future span. Do not title it “Chapter N” or “Chapters N-M”; it does not count toward this batch's coverage.`,
      )
    : ''
  const contract = [
    leading,
    promptLanguageText(
      writingLanguage,
      `【本次生成范围（重要）】\n本次必须对第 ${from}–${to} 章输出完整详细的情节大纲（全书共 ${totalChapters} 章）。每章或连续章组必须以独立行标题开头，严格使用“第N章：标题”或“第N–M章：标题”格式，并在标题下一行起写非空正文。`,
      `[Generation scope for this batch (important)]\nDetail complete plot outline entries for chapters ${from}-${to} of ${totalChapters}. Start every chapter or consecutive chapter group with its own heading, strictly formatted as “Chapter N: Title” or “Chapters N-M: Title”, then write a non-empty body beginning on the next line.`,
    ),
    trailing,
    promptLanguageText(
      writingLanguage,
      `【批次收尾（必须遵守）】当你已经完整覆盖第 ${from}–${to} 章时，最后一行输出（不要提前、不要缺失）：${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
      `[Batch completion line (required)] Only after fully covering chapters ${from}-${to}, end with exactly this line (never earlier, never missing): ${plotOutlineProgressLine(writingLanguage, from, to, totalChapters)}`,
    ),
  ].filter(Boolean).join('\n\n')
  return contract
}

/** 校验进度行与本批一致；正文标题覆盖由独立校验器证明。 */
function assertPlotOutlineBatchComplete(
  merged: string,
  from: number,
  to: number,
  totalChapters: number,
  uiText: UiText,
): void {
  const mark = findPlotOutlineProgressMark(merged)
  if (!mark
    || mark.from !== from
    || mark.to !== to
    || mark.totalChapters !== totalChapters
  ) {
    throw new Error(uiText(
      `大纲输出未包含有效的批次完成标记（需要与本批范围完全一致：第 ${from}–${to} 章、全书 ${totalChapters} 章），`
        + '可能仍被模型输出上限截断或批次范围错位，结果未按完成保存。',
      `The outline output lacks a batch-completion marker that exactly matches this batch (chapters ${from}-${to} of ${totalChapters}); `
        + 'it may still be truncated by the model output limit or misreport its range, so it was not saved as complete.',
    ))
  }
}

/**
 * 续批/恢复前校验 DB 中的大纲是否仍是上次生成写入的内容。用户可能直接在
 * 编辑器手动修改大纲（保存只更新 DB）：此时若按检查点前缀拼接会覆盖用户的
 * 修改，必须 fail-closed 并引导显式重新生成。
 */
function assertCheckpointDbMirrorCurrent(
  partial: PartialArchData,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
  uiText: UiText,
): string {
  const range = partial.synopsis_range
  const coveredTo = partial.synopsis_covered_to ?? 0
  if (!range
    || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 1 || range.from > range.to || range.to > totalChapters
    || !Number.isSafeInteger(coveredTo) || coveredTo < 0 || coveredTo > totalChapters
    || (partial.synopsis_incomplete !== true && coveredTo !== range.to)
    || (partial.synopsis_incomplete === true && coveredTo >= range.to)
  ) {
    throw new Error(uiText(
      '情节大纲检查点的章节范围或进度已损坏，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has a damaged range or progress value and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const checkpointBody = typeof partial.synopsis_result === 'string'
    ? partial.synopsis_result.trim()
    : ''
  if (!checkpointBody) {
    throw new Error(uiText(
      '情节大纲检查点缺少正文，无法安全续写。请从第 1 章重新生成。',
      'The plot-outline checkpoint has no body and cannot be continued safely. Regenerate from chapter 1.',
    ))
  }
  const dbOutlineHash = synopsisFactsFingerprint([dbOutlineText])
  const recordedHash = partial.synopsis_db_hash
  if (recordedHash === undefined) {
    throw new Error(uiText(
      '续批检查点没有数据库镜像指纹，无法确认大纲未被手动修改。请从「AI 生成故事架构」从第 1 章重新生成大纲。',
      'The continuation checkpoint has no database-mirror fingerprint, so we cannot confirm the outline was not edited by hand. Regenerate the outline from chapter 1 in “Generate story architecture”.',
    ))
  }
  if (recordedHash !== dbOutlineHash) {
    throw new Error(uiText(
      '情节大纲正文在上次生成后已被手动修改，续批会覆盖这些修改，已拒绝。'
        + '如需保留修改，请基于修改后的正文从第 1 章重新生成；若该修改有误，请先撤销后再续批。',
      'The outline body was manually edited after the last generation; continuing would overwrite those edits, so it was rejected. '
        + 'To keep the edits, regenerate from chapter 1 on top of them; if the edit was a mistake, revert it before continuing.',
    ))
  }
  if (renderSynopsisDbText(checkpointBody, writingLanguage, totalChapters, partial) !== dbOutlineText
    || (partial.synopsis_body_hash !== undefined
      && partial.synopsis_body_hash !== synopsisFactsFingerprint([checkpointBody]))
  ) {
    throw new Error(uiText(
      '情节大纲检查点正文与数据库原文不一致，无法安全续写。数据库正文未被覆盖。',
      'The plot-outline checkpoint body does not exactly match the database source. The database outline was not overwritten.',
    ))
  }
  return checkpointBody
}

export function hasVisibleIncompleteSynopsisMarker(dbOutlineText: string): boolean {
  return dbOutlineText.includes('本大纲未完成')
    || dbOutlineText.includes('This outline is incomplete')
}

export function hasVisiblePartialSynopsisMarker(dbOutlineText: string): boolean {
  return hasVisibleIncompleteSynopsisMarker(dbOutlineText)
    || dbOutlineText.includes('本大纲已覆盖至第')
    || dbOutlineText.includes('This outline covers chapters')
}

export function isUsableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  if (!value || typeof value !== 'object') return false
  const partial = value as PartialArchData
  try {
    return assertCheckpointDbMirrorCurrent(
      partial,
      dbOutlineText,
      writingLanguage,
      totalChapters,
      (zhCNText) => zhCNText,
    ).length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
  } catch {
    return false
  }
}

export function isRecoverableSynopsisCheckpoint(
  value: unknown,
  dbOutlineText: string,
  writingLanguage: WritingLanguage,
  totalChapters: number,
): boolean {
  return Boolean((value as PartialArchData | null)?.synopsis_incomplete)
    && isUsableSynopsisCheckpoint(value, dbOutlineText, writingLanguage, totalChapters)
}
const PLOT_STRUCTURES = new Set<NovelConfig['plotStructure']>([
  'three_act',
  'heros_journey',
  'save_the_cat',
  'kishotenketsu',
  'multi_thread',
  'freeform',
])
const NARRATIVE_POVS = new Set<NovelConfig['narrativePOV']>([
  'third_limited',
  'first_person',
  'third_omniscient',
  'multi_pov',
])
const REQUIRED_CONFIG_TEXT_FIELDS = [
  'genre',
  'targetAudience',
  'subGenre',
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const

type UiText = (zhCNText: string, enUSText: string) => string

function buildNovelConfigJSONContract(
  totalChapters: number,
  wordsPerChapter: number,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(writingLanguage, `【不可变小说配置 JSON 合同】
- 必填且必须为非空字符串的 9 个字段：genre、targetAudience、subGenre、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance、writingStyle。
- plotStructure 必填，且值必须严格为以下英文枚举之一：three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform。
- narrativePOV 必填，且值必须严格为以下英文枚举之一：third_limited | first_person | third_omniscient | multi_pov。
- totalChapters 与 wordsPerChapter 是作者权威设置，可以省略；totalChapters 若输出必须严格等于 ${totalChapters}；wordsPerChapter 若输出必须严格等于 ${wordsPerChapter}。
- globalGuidance 必须是 4–8 条跨章节长期有效的简短规则，总计不得超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符；禁止逐章列大纲或分配章节区间。
- referenceWorks 可省略；若输出必须是字符串。
- 只输出一个完整 JSON 对象。枚举只允许上述英文值，不得输出中文枚举、近义词、说明文字、Markdown、代码围栏或思考过程。`, `[Immutable novel-configuration JSON contract]
- The following nine fields are required non-empty strings: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure is required and must be exactly one of: three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform.
- narrativePOV is required and must be exactly one of: third_limited | first_person | third_omniscient | multi_pov.
- totalChapters and wordsPerChapter are authoritative author settings and may be omitted. If present, they must equal ${totalChapters} and ${wordsPerChapter} respectively.
- globalGuidance must contain 4–8 short, stable cross-chapter rules within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters. Do not enumerate chapters or allocate chapter ranges.
- referenceWorks may be omitted; if present, it must be a string.
- Output one complete JSON object only. Do not emit aliases, explanatory prose, Markdown, code fences, or reasoning.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeCompleteNovelConfig(
  content: string,
  expectedTotalChapters: number,
  expectedWordsPerChapter: number,
): NovelConfig {
  let value: unknown
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    value = JSON.parse(fenced?.[1].trim() ?? trimmed)
  } catch {
    throw new Error('AI 返回的小说配置不是完整 JSON 对象')
  }
  if (!isRecord(value)) throw new Error('AI 返回的小说配置必须是 JSON 对象')

  const textFields: Record<(typeof REQUIRED_CONFIG_TEXT_FIELDS)[number], string> = {} as never
  for (const field of REQUIRED_CONFIG_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`AI 返回的小说配置缺少非空字段：${field}`)
    }
    textFields[field] = value[field].trim()
  }
  if (typeof value.plotStructure !== 'string' || !PLOT_STRUCTURES.has(value.plotStructure as NovelConfig['plotStructure'])) {
    throw new Error('AI 返回的小说配置包含非法 plotStructure')
  }
  if (typeof value.narrativePOV !== 'string' || !NARRATIVE_POVS.has(value.narrativePOV as NovelConfig['narrativePOV'])) {
    throw new Error('AI 返回的小说配置包含非法 narrativePOV')
  }
  for (const [field, expected] of [
    ['totalChapters', expectedTotalChapters],
    ['wordsPerChapter', expectedWordsPerChapter],
  ] as const) {
    const candidate = value[field]
    if (candidate !== undefined && (
      typeof candidate !== 'number'
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
      || candidate !== expected
    )) {
      throw new Error(`AI 返回的小说配置包含无效 ${field}，不得回退或覆盖作者设置`)
    }
  }
  if (value.referenceWorks !== undefined && typeof value.referenceWorks !== 'string') {
    throw new Error('AI 返回的小说配置包含无效 referenceWorks')
  }

  return {
    genre: textFields.genre,
    targetAudience: textFields.targetAudience,
    subGenre: textFields.subGenre,
    totalChapters: expectedTotalChapters,
    wordsPerChapter: expectedWordsPerChapter,
    plotStructure: value.plotStructure as NovelConfig['plotStructure'],
    narrativePOV: value.narrativePOV as NovelConfig['narrativePOV'],
    coreOutline: textFields.coreOutline,
    worldSetting: textFields.worldSetting,
    goldenFinger: textFields.goldenFinger,
    protagonistProfile: textFields.protagonistProfile,
    globalGuidance: textFields.globalGuidance,
    writingStyle: textFields.writingStyle,
    ...(typeof value.referenceWorks === 'string' ? { referenceWorks: value.referenceWorks.trim() } : {}),
  }
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
interface CharacterIdentitySlot {
  slotId: string
  name: string
  role: CharacterRosterEntry['role']
  narrativeDuty: string
  relations: Array<{ targetSlotId: string; relation: string }>
}

interface CharacterDetailOutput extends Omit<CharacterRosterEntry, 'relationships'> {
  slotId: string
  relationships?: unknown
}

const MIN_CHARACTER_SLOTS = 3
const MAX_CHARACTER_SLOTS = 8
const CHARACTER_DETAIL_BATCH_SIZE = 3
const CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS = 120
const CHARACTER_STATE_TEXT_MAX_CHARS = 80
const CHARACTER_DETAIL_DESCRIPTION_FIELDS = [
  'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes',
] as const
const CHARACTER_STATE_TEXT_FIELDS = [
  'location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents',
] as const
const MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES = 32_768

function promptUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function findCompleteJsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return undefined
    }
  }
  return undefined
}

function extractSingleCompleteJsonObject(content: string): string {
  const source = stripThinkingTags(content).trim()
  const candidates: string[] = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const start = source.indexOf('{', searchFrom)
    if (start === -1) break
    const end = findCompleteJsonObjectEnd(source, start)
    if (end === undefined) throw new Error('AI 返回包含截断 JSON 对象片段')

    const candidate = source.slice(start, end + 1)
    try {
      if (isRecord(JSON.parse(candidate))) candidates.push(candidate)
    } catch {
      // Keep scanning for the one complete JSON object; malformed candidates
      // are not repaired or accepted.
    }
    searchFrom = end + 1
  }

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) throw new Error('AI 返回包含多个完整 JSON 对象，无法确定唯一结构化结果')
  throw new Error('AI 返回未包含一个完整 JSON 对象')
}

function decodeCharacterIdentityManifest(content: string): CharacterIdentitySlot[] {
  const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { slots?: unknown }
  if (!Array.isArray(parsed.slots)) throw new Error('角色身份清单缺少 slots')
  if (parsed.slots.length < MIN_CHARACTER_SLOTS || parsed.slots.length > MAX_CHARACTER_SLOTS) {
    throw new Error(`角色身份清单必须包含 ${MIN_CHARACTER_SLOTS}–${MAX_CHARACTER_SLOTS} 个角色`)
  }
  const slots = parsed.slots.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`角色身份清单第 ${index + 1} 项无效`)
    const relations = candidate.relations
    if (!Array.isArray(relations)) throw new Error(`角色身份清单第 ${index + 1} 项缺少关系列表`)
    const slotId = normalizeCharacterSlotId(candidate.slotId)
    if (
      slotId === undefined
      || typeof candidate.name !== 'string' || !candidate.name.trim()
      || typeof candidate.role !== 'string' || !CHARACTER_ROSTER_ROLES.includes(candidate.role as CharacterRosterEntry['role'])
      || typeof candidate.narrativeDuty !== 'string' || !candidate.narrativeDuty.trim()
    ) throw new Error(`角色身份清单第 ${index + 1} 项字段不完整`)
    return {
      slotId,
      name: candidate.name.trim(),
      role: candidate.role as CharacterRosterEntry['role'],
      narrativeDuty: candidate.narrativeDuty.trim(),
      relations: relations.map((relation, relationIndex) => {
        const targetSlotId = isRecord(relation)
          ? normalizeCharacterSlotId(relation.targetSlotId)
          : undefined
        if (!isRecord(relation)
          || targetSlotId === undefined
          || typeof relation.relation !== 'string' || !relation.relation.trim()) {
          throw new Error(`角色身份清单第 ${index + 1} 项关系 ${relationIndex + 1} 无效`)
        }
        return { targetSlotId, relation: relation.relation.trim() }
      }),
    }
  })
  const slotIds = new Set(slots.map(slot => slot.slotId))
  const names = new Set(slots.map(slot => slot.name))
  if (slotIds.size !== slots.length || names.size !== slots.length) throw new Error('角色身份清单包含重复 slotId 或姓名')
  if (!slots.some(slot => slot.role === 'protagonist')) throw new Error('角色身份清单必须至少包含一个主角')
  for (const slot of slots) {
    for (const relation of slot.relations) {
      if (!slotIds.has(relation.targetSlotId) || relation.targetSlotId === slot.slotId) {
        throw new Error('角色身份清单关系端点不闭合或存在自指')
      }
    }
  }
  return slots
}

function normalizeCharacterSlotId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined
}

function validateCharacterDetail(output: CharacterDetailOutput): string | undefined {
  const slotId = typeof output.slotId === 'string' && output.slotId.trim() ? output.slotId.trim() : 'unknown'
  const invalid = (field: string, reason: string) => `角色详情 slotId=${slotId} 字段 ${field} ${reason}`
  for (const field of [
    'slotId', 'name', 'gender', 'age', 'appearance', 'personality', 'background',
    'abilities', 'motivation', 'arc', 'notes',
  ] as const) {
    const value = output[field]
    if (typeof value !== 'string' || !value.trim()) return invalid(field, '必须是非空文本')
  }
  for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
    if (Array.from(output[field].trim()).length > CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS) {
      return invalid(field, `不得超过 ${CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS} 字符`)
    }
  }
  if (!CHARACTER_ROSTER_ROLES.includes(output.role)) return invalid('role', '不是允许的定位')
  if (output.relationships !== undefined) return invalid('relationships', '不得出现')
  if (output.currentState === undefined) return invalid('currentState', '必填')
  {
    if (!isRecord(output.currentState)) return invalid('currentState', '必须是对象')
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      const value = output.currentState[field]
      if (typeof value !== 'string' || !value.trim()) return invalid(`currentState.${field}`, '必须是非空文本')
      if (Array.from(value.trim()).length > CHARACTER_STATE_TEXT_MAX_CHARS) {
        return invalid(`currentState.${field}`, `不得超过 ${CHARACTER_STATE_TEXT_MAX_CHARS} 字符`)
      }
    }
    if (!Number.isSafeInteger(output.currentState.updatedAtChapter) || output.currentState.updatedAtChapter < 0) {
      return invalid('currentState.updatedAtChapter', '必须是非负整数')
    }
  }
  return undefined
}

function normalizeDetailStringList(value: unknown, separator: string): unknown {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value) || value.length === 0) return value
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return value
    normalized.push(item.trim())
  }
  return normalized.join(separator)
}

function normalizeBoundedDetailText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value
  return Array.from(value.trim()).slice(0, maxChars).join('')
}

export interface ArchitectureProjectSnapshot {
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
}

function assertArchitectureProjectSessionCurrent(
  projectSession: ProjectSessionContext,
  context: CommandExecuteParams['context'],
): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error(workflowUiText(
      context,
      '当前项目已切换，架构生成已停止以避免写入错误项目',
      'The current project changed, so architecture generation stopped to avoid writing to the wrong project.',
    ))
  }
}

async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/.vela/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
  operationLabel: string,
  fallbackMessage?: string,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/.vela/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, operationLabel, fallbackMessage)
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
  fallbackError: string,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-core-update',
    { [key]: cleanContent },
    expectedProjectPath,
  )
  if (!result.success) {
    throw new Error(result.error || fallbackError)
  }

  // 通知 UI 层实时刷新架构完成状态
  const { globalEventBus } = await import('../../../shared/event-bus')
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName: `${key}.md`,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const existingConfig = { ...(useProjectStore.getState().currentProject?.novelConfig ?? {}) }
    callbacks.log(text(
      '正在调度配置专家 AI，准备解析您的脑洞...',
      'Preparing the configuration model to structure your story idea...',
    ))

    const template = await resolvePromptTemplate('generate_global_config', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 generate_global_config 模板',
      'The generate_global_config template was not found.',
    ))

    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)
    const configJSONContract = buildNovelConfigJSONContract(
      this.totalChapters,
      this.wordsPerChapter,
      writingLanguage,
    )
    const authorConfigContext = Object.keys(existingConfig).length > 0
      ? promptLanguageText(
          writingLanguage,
          `【作者已有配置】\n以下非空内容和选择是作者权威输入：长文本只能在保留原文的基础上补充，类型、受众、结构与视角选择不得改写。\n${JSON.stringify(existingConfig, null, 2)}`,
          `[Existing author configuration]\nThe following non-empty content and choices are authoritative. Preserve long-form text and only add useful details; do not change the author's genre, audience, structure, or point-of-view choices.\n${JSON.stringify(existingConfig, null, 2)}`,
        )
      : ''
    const originalTask = [promptBuilder.build(), authorConfigContext, configJSONContract]
      .filter(Boolean)
      .join('\n\n')

    const initial = await this.callLLMResult(
      originalTask,
      promptBuilder.getSystemRole(),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'generate-global-config',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
      },
      context,
    )
    let resultRaw: string
    if (initial.finishReason === 'stop') {
      resultRaw = initial.content
    } else if (initial.finishReason === 'length') {
      callbacks.log(text(
        '首轮配置 JSON 达到输出上限，已丢弃不可信截断内容，正在请求一次完整替代 JSON...',
        'The first configuration JSON reached the output limit. The untrusted truncated response was discarded; requesting one complete replacement JSON...',
      ))
      const replacement = await this.callLLMResult(
        promptLanguageText(
          writingLanguage,
          `上一轮输出因长度限制而中断。上一轮截断内容是不可信数据，已被丢弃，不得引用或续接。\n\n`
            + `【原始任务合同】\n${originalTask}\n\n`
            + '【硬性要求】\n从头完成原始任务，只输出一个完整替代 JSON。不要只补后缀，不要解释、Markdown 或思考过程。',
          `The previous response stopped at the length limit. Its truncated content is untrusted and discarded; do not quote or continue it.\n\n`
            + `[Original task contract]\n${originalTask}\n\n`
            + '[Hard requirement]\nRestart the original task and output one complete replacement JSON object only. Do not emit a suffix, explanation, Markdown, or reasoning.',
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: 'generate-global-config-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      if (replacement.finishReason !== 'stop') {
        throw this.createIncompleteCompletionError(replacement.finishReason)
      }
      resultRaw = replacement.content
    } else {
      throw this.createIncompleteCompletionError(initial.finishReason)
    }
    this.assertNotCancelled(context)

    callbacks.log(text(
      '解析完成，正在应用到项目配置...',
      'Parsing is complete; applying the result to the project configuration...',
    ))
    let parsed: NovelConfig
    try {
      parsed = decodeCompleteNovelConfig(resultRaw, this.totalChapters, this.wordsPerChapter)
    } catch (e) {
      throw new Error(text(
        'AI 返回的小说配置不完整或无效，结果未应用。详细信息: ' + String(e),
        'The AI novel configuration was incomplete or invalid, so the result was not applied.',
      ))
    }
    if (!isGeneratedGlobalGuidanceValid(parsed.globalGuidance)) {
      callbacks.log(text(
        '生成的全局写作要求不符合 4–8 条简短规则合同，正在执行唯一一次字段级完整替代。',
        'The generated global guidance did not satisfy the 4–8 short-rule contract; requesting the single field-level replacement.',
      ))
      const replacement = await this.callLLM(
        promptLanguageText(
          writingLanguage,
          `只纠正小说配置中的 globalGuidance 字段。写 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条跨章节长期有效的简短规则，每条独占一行，总计不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符。不得逐章列大纲、分配章节区间或复述核心大纲。只输出规则正文，不要标题、解释、Markdown 或 JSON。\n\n【已验证的其余小说配置，仅作上下文】\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
          `Correct only the globalGuidance field in the novel configuration. Write ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} short, stable cross-chapter rules, one per line, within ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters total. Do not enumerate chapters, allocate chapter ranges, or restate the core outline. Output only the rules, with no title, explanation, Markdown, or JSON.\n\n[Validated remaining novel configuration — context only]\n${JSON.stringify({ ...parsed, globalGuidance: undefined }, null, 2)}`,
        ),
        promptBuilder.getSystemRole(),
        callbacks,
        {
          purpose: 'generate-global-guidance-replacement',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
      const replacementGuidance = this.stripThinkingTags(replacement).trim()
      if (!isGeneratedGlobalGuidanceValid(replacementGuidance)) {
        throw new Error(text(
          `全局写作要求仍不符合 ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES} 条且不超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符的合同，配置未应用。`,
          `The global guidance still does not satisfy the ${GENERATED_GLOBAL_GUIDANCE_MIN_RULES}–${GENERATED_GLOBAL_GUIDANCE_MAX_RULES}-rule, ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS}-character contract, so the configuration was not applied.`,
        ))
      }
      parsed = { ...parsed, globalGuidance: replacementGuidance }
    }

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未应用',
        'The current project changed, so the generated configuration was not applied.',
      ))
    }
    this.onGenerated(mergeExpandedNovelConfig(existingConfig, parsed))
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(text(
        '当前项目已切换，智能配置结果未保存',
        'The current project changed, so the generated configuration was not saved.',
      ))
    }
    const saved = await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log(text(
        'AI 配置生成并保存成功，请检查各字段后点击「生成架构」',
        'The AI configuration was generated and saved. Review the fields, then select Generate architecture.',
      ))
    } else {
      callbacks.log(text(
        'AI 配置生成成功，请检查各字段后点击「立即保存」',
        'The AI configuration was generated. Review the fields, then select Save now.',
      ))
    }
    callbacks.setProgress(100)
    return text('生成的配置已成功应用！', 'The generated configuration was applied successfully.')
  }
}

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)
    callbacks.log(text('生成故事前提...', 'Generating story premise...'))

    const template = await resolvePromptTemplate('premise', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到 premise 模板',
      'The story-premise template was not found.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withGenre(modelFacts.genre)
      .withSubGenre(config.subGenre || modelFacts.genre)
      .withTopic(config.coreOutline || missingValue)
      .withTargetAudience(modelFacts.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-core-seed', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (!result.trim()) throw new Error(text(
      '故事前提生成失败，AI 返回空内容',
      'Story premise generation failed because the AI returned empty content.',
    ))
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    const heading = promptLanguageText(writingLanguage, '故事前提', 'Story Premise')
    const content = `# ${heading}\n\n${result}\n`
    this.assertNotCancelled(context)
    await writeArchToDb(
      'premise',
      content,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.premise_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '故事前提已生成并写入数据库',
      'Story premise generated and saved to the database.',
    ))
    return result
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  private assertCommittedRosterReadable(
    receipt: { snapshot?: { entries?: Array<{ name?: unknown }>; renderedMarkdown?: unknown } } | undefined,
    candidateEntries: unknown,
    text: UiText,
  ): asserts receipt is { snapshot: { entries: Array<{ name: string }>; renderedMarkdown: string } } {
    const snapshot = receipt?.snapshot
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0 || typeof snapshot.renderedMarkdown !== 'string' || !snapshot.renderedMarkdown.trim()) {
      throw new Error(text(
        '角色名单提交后未能回读角色卡和角色图谱，未将本步骤标记为成功',
        'Character cards and the character graph could not be read back after commit, so this step was not marked complete.',
      ))
    }

    if (!Array.isArray(candidateEntries)) return
    const candidateNames = candidateEntries
      .map(entry => (
        entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name.trim()
          : ''
      ))
      .filter(Boolean)
    const committedNames = new Set(snapshot.entries
      .map(entry => typeof entry.name === 'string' ? entry.name.trim() : '')
      .filter(Boolean))
    if (candidateNames.length === 0 || candidateNames.some(name => !committedNames.has(name))) {
      throw new Error(text(
        '角色名单提交回读不完整，未将本步骤标记为成功',
        'The committed character roster readback was incomplete, so this step was not marked complete.',
      ))
    }
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('character-architecture', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const promptCopy = characterArchitecturePrompts(writingLanguage)
    const creativeTemplate = await resolvePromptTemplate('character_dynamics', projectSession, writingLanguage)
    if (!creativeTemplate) throw new Error(text(
      '角色规划模板丢失',
      'The character-planning template is missing.',
    ))
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error(text(
        '故事前提尚未生成或内容不完整，请返回勾选生成',
        'The story premise is missing or incomplete. Go back and include it for generation.',
      ))
    }

    callbacks.log(text('生成角色图谱...', 'Generating character graph...'))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const manifestContext = {
      premise: premise_result,
      genre: modelFacts.genre,
      protagonistProfile: config.protagonistProfile || missingValue,
      globalGuidance: config.globalGuidance || missingValue,
      stepGuidance: ((context.data.stepGuidance as Record<string, string>) || {}).characters || missingValue,
      referenceWorks: config.referenceWorks || missingValue,
    }
    const manifestContextJson = JSON.stringify(manifestContext)
    const templateVariables = {
      premise: manifestContext.premise,
      genre: manifestContext.genre,
      protagonist_profile: manifestContext.protagonistProfile,
      global_guidance: manifestContext.globalGuidance,
      step_guidance: manifestContext.stepGuidance,
      reference_works: manifestContext.referenceWorks,
      number_of_chapters: String(config.totalChapters),
      golden_finger: config.goldenFinger || missingValue,
      world_building: config.worldSetting || missingValue,
    }
    const creativeSystem = composePromptSystemRole(creativeTemplate, writingLanguage)
    const creativeGuidance = renderPromptTaskGuidance(creativeTemplate, templateVariables, writingLanguage)
    const manifestSystem = `${creativeSystem}\n\n${promptCopy.manifestSystem}`
    const manifestTask = promptCopy.manifestTask(
      manifestContextJson,
      MIN_CHARACTER_SLOTS,
      MAX_CHARACTER_SLOTS,
    )
    const manifestPrompt = creativeGuidance
      ? `${creativeGuidance}\n\n${manifestTask}`
      : manifestTask
    const manifestSection = (sectionName: string, key: keyof typeof manifestContext) => ({
      sectionName,
      messageIndex: 1,
      finalText: JSON.stringify({ [key]: manifestContext[key] }).slice(1, -1),
    })
    const manifestRaw = await this.callLLMWithBoundedCompletion(
      manifestPrompt,
      manifestSystem,
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'character-architecture-manifest',
        reasoningStage: 'planning',
        writingSkillStage: 'planning',
        promptBudget: {
          limitUtf8Bytes: MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
          sections: [
            {
              sectionName: 'system-instructions',
              messageIndex: 0,
              finalText: manifestSystem,
            },
            manifestSection('story-premise', 'premise'),
            manifestSection('genre', 'genre'),
            manifestSection('protagonist-profile', 'protagonistProfile'),
            manifestSection('global-guidance', 'globalGuidance'),
            manifestSection('step-guidance', 'stepGuidance'),
            manifestSection('reference-works', 'referenceWorks'),
          ],
        },
      },
      context,
    )
    let manifest: CharacterIdentitySlot[]
    try {
      manifest = decodeCharacterIdentityManifest(manifestRaw)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(text(
        detail,
        'The character identity manifest was invalid, so no character data was saved.',
      ))
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const manifestById = new Map(manifest.map(slot => [slot.slotId, slot]))
    const detailContract: StructuredBatchContract<CharacterIdentitySlot, CharacterDetailOutput> = {
      buildTask: ({ items, validatedPrefix }) => {
        this.assertNotCancelled(context)
        assertArchitectureProjectSessionCurrent(projectSession, context)
        const prefix = JSON.stringify(validatedPrefix.map(entry => ({
          slotId: entry.slotId,
          name: entry.name,
          role: entry.role,
          relationships: entry.relationships,
        })))
        const frozenManifest = JSON.stringify({ slots: manifest })
        const slotIds = items.map(slot => slot.slotId).join(', ')
        const detailTask = promptCopy.detailTask({
          context: manifestContextJson,
          manifest: frozenManifest,
          slotIds,
          validatedPrefix: prefix,
        })
        const detailPrompt = creativeGuidance
          ? `${creativeGuidance}\n\n${detailTask}`
          : detailTask
        const detailSystem = `${creativeSystem}\n\n${promptCopy.detailSystem}`
        const detailRequestBytes = promptUtf8Bytes(detailSystem) + promptUtf8Bytes(detailPrompt)
        const fixedDetailRequestBytes = detailRequestBytes - promptUtf8Bytes(prefix)
        return {
          purpose: 'character-architecture-details',
          output: 'structured-data',
          messages: [
            { role: 'system', content: detailSystem },
            {
              role: 'user',
              content: detailPrompt,
            },
          ],
          promptBudget: {
            limitUtf8Bytes: fixedDetailRequestBytes + MAX_CHARACTER_STRUCTURED_CONTEXT_UTF8_BYTES,
            sections: [
              {
                sectionName: 'system-instructions',
                messageIndex: 0,
                finalText: detailSystem,
              },
              manifestSection('story-premise', 'premise'),
              manifestSection('genre', 'genre'),
              manifestSection('protagonist-profile', 'protagonistProfile'),
              manifestSection('global-guidance', 'globalGuidance'),
              manifestSection('step-guidance', 'stepGuidance'),
              manifestSection('reference-works', 'referenceWorks'),
              {
                sectionName: 'identity-manifest',
                messageIndex: 1,
                finalText: frozenManifest,
              },
              {
                sectionName: 'batch-slot-ids',
                messageIndex: 1,
                finalText: slotIds,
              },
              {
                sectionName: 'validated-prefix',
                messageIndex: 1,
                finalText: prefix,
              },
            ],
          },
        }
      },
      inputKey: slot => slot.slotId,
      outputKey: entry => entry.slotId,
      decode: (content) => {
        const parsed = JSON.parse(extractSingleCompleteJsonObject(content)) as { entries?: unknown }
        if (!Array.isArray(parsed.entries)) throw new Error(text(
          '角色详情响应缺少 entries',
          'The character-detail response is missing entries.',
        ))
        return parsed.entries.map((candidate) => {
          if (!isRecord(candidate)) return candidate as unknown as CharacterDetailOutput
          const age = candidate.age
          const normalizedCandidate = { ...candidate }
          for (const field of CHARACTER_DETAIL_DESCRIPTION_FIELDS) {
            normalizedCandidate[field] = normalizeBoundedDetailText(
              candidate[field],
              CHARACTER_DETAIL_DESCRIPTION_MAX_CHARS,
            )
          }
          let currentState: unknown = candidate.currentState
          if (isRecord(candidate.currentState)) {
            const normalizedState: Record<string, unknown> = {
              ...candidate.currentState,
              keyItems: normalizeDetailStringList(candidate.currentState.keyItems, '、'),
              recentEvents: normalizeDetailStringList(candidate.currentState.recentEvents, '；'),
              // Architecture generation describes the pre-chapter baseline. A
              // model-supplied future chapter must never become persisted fact.
              updatedAtChapter: 0,
            }
            for (const field of CHARACTER_STATE_TEXT_FIELDS) {
              normalizedState[field] = normalizeBoundedDetailText(
                normalizedState[field],
                CHARACTER_STATE_TEXT_MAX_CHARS,
              )
            }
            currentState = normalizedState
          }
          return {
            ...normalizedCandidate,
            ...(typeof age === 'number' && Number.isFinite(age) ? { age: String(age) } : {}),
            currentState,
          } as unknown as CharacterDetailOutput
        })
      },
      validateItem: (entry) => {
        const basicError = validateCharacterDetail(entry)
        if (basicError) return basicError
        const slot = manifestById.get(entry.slotId)
        if (!slot || slot.name !== entry.name || slot.role !== entry.role) return '角色详情身份与冻结清单不一致'
        return undefined
      },
    }
    const generationExecution = this.requireGenerationExecution()
    const detailExecution = await createStructuredBatchExecutor({
      contract: detailContract,
      session: injectWritingSkillIntoSession(generationExecution.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: manifest,
      limits: { maxBatchItems: CHARACTER_DETAIL_BATCH_SIZE },
      signal: generationExecution.signal,
    })
    if (!detailExecution.ok) {
      const diagnostic = detailExecution.failure.diagnostic
      const attempts = detailExecution.receipt.attempts.length > 0
        ? detailExecution.receipt.attempts
            .map(attempt => `purpose=${attempt.purpose ?? 'unknown'} finishReason=${attempt.finishReason}`)
            .join('; ')
        : 'none'
      const failureReceipt = [
        `code=${detailExecution.failure.code}`,
        `reason=${detailExecution.failure.reason ?? 'unknown'}`,
        ...(diagnostic
          ? [`diagnosticCode=${diagnostic.code} diagnosticPath=${diagnostic.path} diagnosticField=${diagnostic.field}`]
          : []),
        `attempts=${attempts}`,
      ].join(' ')
      throw new Error(text(
        `${detailExecution.failure.message}；角色详情失败收据：${failureReceipt}`,
        `Character details failed structural validation and were not saved. Receipt: ${failureReceipt}`,
      ))
    }
    if (detailExecution.items.length !== manifest.length) {
      throw new Error(text(
        '角色详情未完整覆盖冻结身份清单',
        'Character details did not fully cover the frozen identity manifest.',
      ))
    }
    const entries = detailExecution.items.map((detail) => {
      const entry: Record<string, unknown> = { ...detail }
      delete entry.slotId
      entry.relationships = manifestById.get(detail.slotId)!.relations.map(relation => ({
        target: manifestById.get(relation.targetSlotId)!.name,
        relation: relation.relation,
      }))
      return entry as unknown as CharacterRosterEntry
    })
    const candidate = { schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION, entries }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const currentRoster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentRoster.revision,
        schemaVersion: candidate.schemaVersion as typeof CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: candidate.entries as CharacterRosterEntry[],
        intent: 'architecture_generation',
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || text(
        '角色名单提交失败，未保存角色图谱或角色卡',
        'The character-roster commit failed, so the character graph and cards were not saved.',
      ))
    }
    this.assertCommittedRosterReadable(commitResult.receipt, candidate.entries, text)
    const renderedMarkdown = commitResult.receipt.snapshot.renderedMarkdown
    const characterCount = commitResult.receipt.snapshot.entries.length

    // 事务 receipt 是取消边界：提交成功后不再把已保存的角色事实误报为零写入取消。
    if (context.cancelled) {
      this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }

    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (context.cancelled) {
      callbacks.log(text(
        `角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`,
        `The character graph and ${characterCount} character cards were generated; the remaining workflow was cancelled.`,
      ))
      return renderedMarkdown
    }
    partial.character_dynamics_result = renderedMarkdown
    context.data.partial = partial
    try {
      await savePartialData(
        expectedProjectPath,
        partial,
        projectSession,
        text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
        text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      callbacks.log(
        text(
          `[警告] 角色图谱与 ${characterCount} 张角色卡已保存，但检查点保存失败：${detail}。当前流程可继续；若中断，将无法从此步骤恢复。`,
          `[Warning] The character graph and ${characterCount} character cards were saved, but the checkpoint failed: ${detail}. The workflow can continue, but it cannot resume from this step after an interruption.`,
        ),
      )
    }

    callbacks.log(text(
      `角色图谱与 ${characterCount} 张角色卡已生成`,
      `The character graph and ${characterCount} character cards were generated.`,
    ))
    return renderedMarkdown
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error(text(
        '故事前提尚未生成或内容不完整，请返回勾选生成',
        'The story premise is missing or incomplete. Go back and include it for generation.',
      ))
    }

    callbacks.log(text('生成世界观...', 'Generating worldbuilding...'))
    const template = await resolvePromptTemplate('world_building', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The worldbuilding template is missing.',
    ))

    const missingValue = promptLanguageText(writingLanguage, '（未填写）', '(not provided)')
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise_result)
      .withGenre(modelFacts.genre)
      .withCoreSetting(config.worldSetting || missingValue)
      .withGoldenFinger(config.goldenFinger || missingValue)
      .withProtagonistProfile(config.protagonistProfile || missingValue)
      .withGlobalGuidance(config.globalGuidance || missingValue)
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || '')

    const result = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { purpose: 'generate-world-building', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow was cancelled.'))

    this.assertNotCancelled(context)
    const heading = promptLanguageText(writingLanguage, '世界观', 'Worldbuilding')
    await writeArchToDb(
      'worldbuilding',
      `# ${heading}\n\n${result}\n`,
      expectedProjectPath,
      context.runId,
      projectSession,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.world_building_result = result
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存架构生成检查点', 'Save architecture-generation checkpoint'),
      text('保存架构生成检查点失败', 'Failed to save the architecture-generation checkpoint.'),
    )
    context.data.partial = partial

    callbacks.log(text(
      '世界观已生成并写入数据库',
      'Worldbuilding generated and saved to the database.',
    ))
    return result
  }
}

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(
    private selectedSteps: string[],
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly options: {
      /** 从上次中断点续写当前批次（需要有效检查点：incomplete=true 且指纹匹配）。 */
      resumeSynopsis?: boolean
      /** 本次生成范围 [from..to]；缺省 = 第 1 章到全书（显式覆盖重写）。 */
      synopsisRange?: PlotOutlineChapterRange | null
    } = {},
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    assertArchitectureProjectSessionCurrent(requireWorkflowProjectSession(params.context), params.context)
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw new Error(text(
      '故事前提未生成',
      'The story premise has not been generated.',
    ))
    if (!char_dyn || char_dyn.includes('待生成')) throw new Error(text(
      '角色图谱未生成',
      'The character graph has not been generated.',
    ))
    if (!world_b || world_b.includes('待生成')) throw new Error(text(
      '世界观未生成',
      'Worldbuilding has not been generated.',
    ))

    const totalChapters = Number(config.totalChapters) > 0 ? Number(config.totalChapters) : 0
    if (totalChapters <= 0) throw new Error(text(
      '小说配置的总章数无效，无法生成情节大纲',
      'The total chapter count in the novel configuration is invalid; the plot outline cannot be generated.',
    ))

    const sourceExpected: ProjectCoreSynopsisExpected = {
      synopsis: core?.synopsis || '',
      premise,
      charactersArch: char_dyn,
      worldbuilding: world_b,
      genre: config.genre || '',
      totalChapters,
      wordsPerChapter: Number(config.wordsPerChapter) || 0,
      writingLanguage,
      plotStructure: config.plotStructure || '',
      narrativePov: config.narrativePOV || '',
      globalGuidance: config.globalGuidance || '',
    }
    const requestedStepGuidance = ((context.data.stepGuidance as Record<string, string>) || {}).synopsis || ''

    const resumeRequested = this.options.resumeSynopsis === true
    callbacks.log(text(
      resumeRequested
        ? '正在读取情节大纲中断检查点...'
        : '生成情节大纲...',
      resumeRequested
        ? 'Reading the interrupted plot-outline checkpoint...'
        : 'Generating plot outline...',
    ))

    const template = await resolvePromptTemplate('synopsis', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '模板丢失',
      'The plot-outline template is missing.',
    ))

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(
      config.plotStructure || 'three_act',
      totalChapters,
      writingLanguage,
    )
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited', writingLanguage)

    // ===== 状态机：解析本次批次模式与检查点 =====
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    context.data.partial = partial
    const coveredTo = partial.synopsis_covered_to ?? 0
    const interrupted = partial.synopsis_incomplete === true
    const checkpointFingerprint = partial.synopsis_facts_fingerprint

    let mode: 'resume' | 'fresh' | 'batch'
    let from: number
    let to: number
    let seedText = ''
    let effectiveStepGuidance = requestedStepGuidance

    if (resumeRequested) {
      // ---- 断点续写：无有效检查点必须 fail-closed，绝不退化为覆盖生成 ----
      if (!interrupted) {
        throw new Error(text(
          '未找到中断的情节大纲检查点（当前大纲没有未完成的批次）。请从「AI 生成故事架构」重新生成。',
          'No interrupted plot-outline checkpoint was found (no batch is incomplete). Regenerate from “Generate story architecture” instead.',
        ))
      }
      if (!partial.synopsis_range) {
        throw new Error(text(
          '中断检查点缺少批次范围，无法续写。请从「AI 生成故事架构」重新生成。',
          'The interrupted checkpoint is missing its batch range. Regenerate from “Generate story architecture” instead.',
        ))
      }
      from = partial.synopsis_range.from
      to = partial.synopsis_range.to
      if (partial.synopsis_step_guidance === undefined) {
        throw new Error(text(
          '旧情节大纲检查点缺少完整输入绑定，无法证明其来源事实与当前一致，不能自动续写。检查点与数据库正文均已保留；请从第 1 章重新生成。',
          'This legacy plot-outline checkpoint lacks complete input binding, so its source facts cannot be proven to match the current project and it cannot be continued automatically. The checkpoint and database prose remain preserved; regenerate from chapter 1.',
        ))
      }
      effectiveStepGuidance = partial.synopsis_step_guidance
      const expectedCheckpointFingerprint = synopsisInputsFingerprint(
        sourceExpected,
        effectiveStepGuidance,
        { from, to },
        template,
      )
      if (checkpointFingerprint !== expectedCheckpointFingerprint) {
        throw new Error(text(
          '项目源事实（故事前提/角色/世界观/总章数等）自上次中断后已变化，旧检查点不能续到新上下文。请从「AI 生成故事架构」重新生成情节大纲。',
          'The source facts (premise / characters / worldbuilding / chapter count, etc.) changed after the interruption, so the old checkpoint cannot be continued into the new context. Regenerate the plot outline from “Generate story architecture”.',
        ))
      }
      seedText = assertCheckpointDbMirrorCurrent(
        partial,
        sourceExpected.synopsis,
        writingLanguage,
        totalChapters,
        text,
      )
      if (seedText.length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) {
        throw new Error(text(
          '中断检查点内容过短，无法安全续写。请从「AI 生成故事架构」重新生成。',
          'The interrupted checkpoint is too short to resume safely. Regenerate from “Generate story architecture” instead.',
        ))
      }
      mode = 'resume'
    } else {
      const requested = this.options.synopsisRange ?? null
      if (requested && (
        !Number.isSafeInteger(requested.from) || !Number.isSafeInteger(requested.to)
        || requested.from < 1 || requested.to > totalChapters || requested.from > requested.to
      )) {
        throw new Error(text(
          `章节范围无效：必须满足 1 ≤ from ≤ to ≤ ${totalChapters}`,
          `Invalid chapter range: expected 1 ≤ from ≤ to ≤ ${totalChapters}.`,
        ))
      }
      from = requested?.from ?? 1
      to = requested?.to ?? totalChapters
      if (from === 1) {
        // 覆盖重写（显式发起）或首次生成。若只覆盖到一半会静默丢弃
        // 第 to+1–coveredTo 章的已确认大纲 → 拒绝，要求续批或全量重写。
        if (!interrupted && coveredTo > 0 && to < coveredTo) {
          throw new Error(text(
            `本批只生成到第 ${to} 章，将丢弃已确认的第 ${to + 1}–${coveredTo} 章大纲。`
              + `若只需补充，请从第 ${coveredTo + 1} 章发起续批；若确定重写，请生成 1–${Math.max(coveredTo, totalChapters)} 章全量覆盖。`,
            `This batch stops at chapter ${to} and would discard the confirmed outline for chapters ${to + 1}-${coveredTo}. `
              + `To extend, continue from chapter ${coveredTo + 1}; to rewrite, regenerate the full range 1-${Math.max(coveredTo, totalChapters)}.`,
          ))
        }
        mode = 'fresh'
      } else {
        // 连续续批：不得跳跃、不得重写已确认前缀、源事实不得变化
        if (interrupted) {
          throw new Error(text(
            '当前存在未完成的批次（可断点续写）。请先完成该批次，再发起下一批生成。',
            'A batch is still incomplete (it can be resumed). Finish that batch before starting the next one.',
          ))
        }
        if (coveredTo <= 0 || from !== coveredTo + 1) {
          throw new Error(text(
            coveredTo > 0 && from <= coveredTo
              ? `第 ${from} 章已包含在已确认大纲中。请从第 ${coveredTo + 1} 章继续，或从第 1 章显式选择覆盖重写。`
              : `大纲必须连续生成：当前已覆盖至第 ${coveredTo} 章，本批应从第 ${coveredTo + 1} 章开始。`,
            coveredTo > 0 && from <= coveredTo
              ? `Chapter ${from} is already inside the confirmed outline. Continue from chapter ${coveredTo + 1}, or explicitly rewrite from chapter 1.`
              : `The outline must grow contiguously: chapters up to ${coveredTo} are confirmed, so this batch must start at chapter ${coveredTo + 1}.`,
          ))
        }
        if (!partial.synopsis_range) {
          throw new Error(text(
            '续批检查点缺少上一批范围，无法确认连续覆盖。请从第 1 章重新生成。',
            'The continuation checkpoint is missing the previous batch range. Regenerate from chapter 1.',
          ))
        }
        if (partial.synopsis_step_guidance === undefined) {
          throw new Error(text(
            '旧情节大纲检查点缺少完整输入绑定，无法证明其来源事实与当前一致，不能自动续批。检查点与数据库正文均已保留；请从第 1 章重新生成。',
            'This legacy plot-outline checkpoint lacks complete input binding, so its source facts cannot be proven to match the current project and it cannot be extended automatically. The checkpoint and database prose remain preserved; regenerate from chapter 1.',
          ))
        }
        const checkpointStepGuidance = partial.synopsis_step_guidance
        const expectedCheckpointFingerprint = synopsisInputsFingerprint(
          sourceExpected,
          checkpointStepGuidance,
          partial.synopsis_range,
          template,
        )
        if (checkpointFingerprint !== expectedCheckpointFingerprint) {
          throw new Error(text(
            '项目源事实自上次生成后已变化，既有大纲不能与新的源事实拼接。请从「AI 生成故事架构」从第 1 章重新生成。',
            'The source facts changed since the previous generation, so the existing outline cannot be joined with the new facts. Regenerate from chapter 1 in “Generate story architecture”.',
          ))
        }
        seedText = assertCheckpointDbMirrorCurrent(
          partial,
          sourceExpected.synopsis,
          writingLanguage,
          totalChapters,
          text,
        )
        mode = 'batch'
      }
    }

    const factsFingerprint = synopsisInputsFingerprint(
      sourceExpected,
      effectiveStepGuidance,
      { from, to },
      template,
    )
    const promptBuilder = new ArchitecturePromptBuilder(template, writingLanguage)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(modelFacts.genre)
      .withNumberOfChapters(totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || promptLanguageText(writingLanguage, '（未填写）', '(not provided)'))
      .withStepGuidance(effectiveStepGuidance)

    if (mode === 'resume') {
      callbacks.log(text(
        `检测到中断检查点，正在续写第 ${from}–${to} 章（全书 ${totalChapters} 章）...`,
        `An interrupted checkpoint was found; resuming chapters ${from}-${to} of ${totalChapters}...`,
      ))
    } else if (mode === 'fresh') {
      callbacks.log(text(
        to < totalChapters
          ? `正在生成第 ${from}–${to} 章大纲（全书 ${totalChapters} 章；本批后可从第 ${to + 1} 章继续分块补齐）...`
          : `正在生成全书 ${totalChapters} 章情节大纲...`,
        to < totalChapters
          ? `Generating the outline for chapters ${from}-${to} of ${totalChapters} (later batches may continue from chapter ${to + 1})...`
          : `Generating the ${totalChapters}-chapter plot outline...`,
      ))
    } else {
      callbacks.log(text(
        `正在续接第 ${from}–${to} 章（保留已确认的第 1–${coveredTo} 章，不会覆盖）...`,
        `Continuing chapters ${from}-${to} (chapters 1-${coveredTo} are kept unchanged)...`,
      ))
    }

    const taskPrompt = [
      promptBuilder.build(),
      synopsisBatchInstruction(writingLanguage, from, to, totalChapters),
    ].filter(Boolean).join('\n\n')

    // ===== 有界生成：seed 续写 + 自动续写；任何失败先交出已合并文本 =====
    let interruptedContent = ''
    let merged = ''
    const runCompletion = async (): Promise<string> => {
      merged = await this.callLLMWithAppendContinuation({
        taskPrompt,
        systemPrompt: promptBuilder.getSystemRole(),
        callbacks,
        context,
        llmOptions: {
          purpose: mode === 'resume'
            ? 'generate-plot-architecture-resume'
            : mode === 'batch'
              ? 'generate-plot-architecture-batch'
              : 'generate-plot-architecture',
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        seedText,
        maxContinuations: 3,
        onPartialAvailable: content => { interruptedContent = content },
      })
      return merged
    }

    // 中断/机械校验失败时：落盘已完成部分并抛出可续写错误
    const persistAndRaiseResume = async (partialBody: string, cause: Error): Promise<never> => {
      if (partialBody.length < MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS) throw cause
      this.assertNotCancelled(context)
      assertArchitectureProjectSessionCurrent(projectSession, context)
      await this.persistInterruptedSynopsis(
        projectSession,
        expectedProjectPath,
        context,
        partialBody,
        { from, to },
        factsFingerprint,
        effectiveStepGuidance,
        sourceExpected,
      )
      callbacks.log(text(
        `已完成部分（约 ${partialBody.length} 字）已保存，可点击「继续生成情节大纲」从断点续写`,
        `The completed part (about ${partialBody.length} characters) was saved. Click “Continue plot outline” to resume from the break point.`,
      ))
      throw new PlotOutlineResumeAvailableError(text(
        `情节大纲生成在完成前中断：${cause instanceof Error ? cause.message : String(cause)}。已完成部分（约 ${partialBody.length} 字）已自动保存为不完整状态，没有白费。\n点击「继续生成情节大纲」可续写本批（第 ${from}–${to} 章）；如本批范围仍偏大，可先在「AI 生成架构」缩小每批章节数后重试。`,
        `Plot-outline generation stopped before completing this batch: ${cause instanceof Error ? cause.message : String(cause)}. The finished part (about ${partialBody.length} characters) was saved automatically.\nClick “Continue plot outline” to finish batch chapters ${from}-${to}; if the batch is still too large, choose a smaller per-batch range in “Generate story architecture” and retry.`,
      ))
    }

    try {
      merged = await runCompletion()
    } catch (error) {
      const partialText = stripThinkingTags(interruptedContent).trim()
      const seedTrimmed = stripThinkingTags(seedText).trim()
      const madeProgress = partialText !== seedTrimmed
      if (
        !context.cancelled
        && madeProgress
        && partialText.length >= MIN_SYNOPSIS_PARTIAL_PERSIST_CHARS
      ) {
        await persistAndRaiseResume(partialText, error as Error)
      }
      throw error
    }

    if (!merged.trim()) throw new Error(text(
      '情节大纲生成失败，AI 返回空内容',
      'Plot outline generation failed because the AI returned empty content.',
    ))

    // ===== 完成校验：必须带与本次范围一致的批次进度行（截断误报 stop 时不会误判成功） =====
    let confirmedBody = ''
    try {
      assertPlotOutlineTitleCoverage(merged, seedText, from, to, text)
      assertPlotOutlineBatchComplete(merged, from, to, totalChapters, text)
      confirmedBody = stripPlotOutlineProgressLine(merged)
    } catch (error) {
      if (error instanceof NonRecoverablePlotOutlineError) throw error
      await persistAndRaiseResume(stripPlotOutlineProgressLine(merged), error as Error)
    }
    if (!confirmedBody) {
      // persistAndRaiseResume 已以中断错误终结；此处仅为类型安全的兜底。
      throw new Error(text('情节大纲未完成且无法保存', 'The plot outline is incomplete and could not be saved.'))
    }

    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    // ===== 落盘：先写检查点（权威进度 + DB 镜像指纹），再镜像到 DB 正文 =====
    const previousPartial = { ...partial }
    partial.synopsis_result = confirmedBody
    partial.synopsis_incomplete = false
    partial.synopsis_covered_to = to
    partial.synopsis_range = { from, to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([confirmedBody])
    partial.synopsis_step_guidance = effectiveStepGuidance
    const dbOutlineText = renderSynopsisDbText(confirmedBody, writingLanguage, totalChapters, partial)
    partial.synopsis_db_hash = synopsisFactsFingerprint([dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存情节大纲批次检查点', 'Save the plot-outline batch checkpoint'),
      text('保存情节大纲批次检查点失败', 'Failed to save the plot-outline batch checkpoint.'),
    )
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
    this.assertNotCancelled(context)

    // 全书完成的「全流程」运行（前提+角色+世界观+大纲一次做完）才清理检查点文件；
    // 分块/续批运行保留检查点供后续批次与断点续写使用。
    if (to >= totalChapters
      && this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters')
      && this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      this.assertNotCancelled(context)
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          `${expectedProjectPath}/.vela/partial_arch.json`,
          '{}',
          expectedProjectPath,
        ),
        text('清理架构生成检查点', 'Clear architecture-generation checkpoint'),
        text('清理架构生成检查点失败', 'Failed to clear the architecture-generation checkpoint.'),
      )
    }

    callbacks.log(text(
      to >= totalChapters
        ? (mode === 'resume' ? '情节大纲续写完成，全书大纲已就绪' : '情节大纲已生成，全书大纲已就绪')
        : (mode === 'resume'
            ? `第 ${from}–${to} 章续写完成；全书还剩第 ${to + 1} 章起待生成`
            : `第 ${from}–${to} 章已生成；全书还剩第 ${to + 1} 章起待生成`),
      to >= totalChapters
        ? (mode === 'resume' ? 'Plot-outline continuation complete; the full outline is ready.' : 'Plot outline generated; the full outline is ready.')
        : (mode === 'resume'
            ? `Batch chapters ${from}-${to} continued; chapters ${to + 1}+ are still pending.`
            : `Batch chapters ${from}-${to} generated; chapters ${to + 1}+ are still pending.`),
    ))
    return confirmedBody
  }

  private async rollbackSynopsisCheckpoint(
    expectedProjectPath: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
  ): Promise<void> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const readResult = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-json',
      `${expectedProjectPath}/.vela/partial_arch.json`,
      expectedProjectPath,
    )
    if (!readResult.success || !readResult.data) {
      throw new Error(text(
        '无法回读当前架构检查点',
        'The current architecture checkpoint could not be read back.',
      ))
    }
    const currentPartial = readResult.data as PartialArchData
    if (!sameSynopsisCheckpoint(currentPartial, writtenPartial)) {
      context.data.partial = currentPartial
      return
    }
    const restored = restoreSynopsisCheckpoint(currentPartial, previousPartial)
    await savePartialData(
      expectedProjectPath,
      restored,
      projectSession,
      text('恢复旧情节大纲检查点', 'Restore the previous plot-outline checkpoint'),
      text('恢复旧情节大纲检查点失败', 'Failed to restore the previous plot-outline checkpoint.'),
    )
    context.data.partial = restored
  }

  private async commitSynopsisWithCheckpointRollback(
    synopsis: string,
    expectedProjectPath: string,
    runId: string,
    projectSession: ProjectSessionContext,
    context: WorkflowContext,
    expected: ProjectCoreSynopsisExpected,
    previousPartial: PartialArchData,
    writtenPartial: PartialArchData,
    fallbackError: string,
  ): Promise<void> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-synopsis-commit',
      { synopsis: stripThinkingTags(synopsis), expected },
      expectedProjectPath,
    )
    if (!result.success) {
      const commitError = result.error === '项目数据已变化，已拒绝覆盖情节大纲'
        ? text(
            '项目数据已变化，已拒绝覆盖情节大纲。',
            'Project data changed while the outline was being generated, so overwriting it was refused.',
          )
        : result.error || fallbackError
      try {
        await this.rollbackSynopsisCheckpoint(
          expectedProjectPath,
          projectSession,
          context,
          previousPartial,
          writtenPartial,
        )
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        throw new Error(text(
          `${commitError} 同时无法安全恢复旧检查点：${detail}`,
          `${commitError} The previous checkpoint also could not be restored safely: ${detail}`,
        ))
      }
      throw new Error(commitError)
    }

    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('ARCH_FILE_UPDATED', {
      fileName: 'synopsis.md',
      projectPath: expectedProjectPath,
      projectSession,
      runId,
    })
  }

  /**
   * 中断时落盘：先写检查点（权威：正文 + 批次范围 + 源事实指纹 + 未完成标记），
   * 再镜像 DB 正文并附加「未完成」说明。检查点写入失败时不提供续写入口。
   */
  private async persistInterruptedSynopsis(
    projectSession: ProjectSessionContext,
    expectedProjectPath: string,
    context: WorkflowContext,
    partialText: string,
    range: PlotOutlineChapterRange,
    factsFingerprint: string,
    stepGuidance: string,
    sourceExpected: ProjectCoreSynopsisExpected,
  ): Promise<void> {
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    const previousPartial = { ...partial }
    partial.synopsis_result = partialText
    partial.synopsis_incomplete = true
    partial.synopsis_covered_to = range.from - 1
    partial.synopsis_range = { from: range.from, to: range.to }
    partial.synopsis_facts_fingerprint = factsFingerprint
    partial.synopsis_body_hash = synopsisFactsFingerprint([partialText])
    partial.synopsis_step_guidance = stepGuidance
    const dbOutlineText = renderSynopsisDbText(
      partialText,
      writingLanguage,
      sourceExpected.totalChapters,
      partial,
    )
    partial.synopsis_db_hash = synopsisFactsFingerprint([dbOutlineText])
    context.data.partial = partial
    this.assertNotCancelled(context)
    await savePartialData(
      expectedProjectPath,
      partial,
      projectSession,
      text('保存中断的情节大纲检查点', 'Save the interrupted plot-outline checkpoint'),
      text('保存中断的情节大纲检查点失败', 'Failed to save the interrupted plot-outline checkpoint.'),
    )
    if (context.cancelled) {
      await this.rollbackSynopsisCheckpoint(
        expectedProjectPath,
        projectSession,
        context,
        previousPartial,
        partial,
      )
    }
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession, context)

    await this.commitSynopsisWithCheckpointRollback(
      dbOutlineText,
      expectedProjectPath,
      context.runId,
      projectSession,
      context,
      sourceExpected,
      previousPartial,
      partial,
      text('故事架构写入数据库失败', 'Failed to write story architecture to the database.'),
    )
  }
}
