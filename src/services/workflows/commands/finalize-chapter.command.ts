import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { commitFinalizationSnapshot } from '../../finalization-client'
import type { FinalizationSnapshot } from '../../finalization-snapshot'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  type PostProcessStep,
  type PostProcessStatus,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import type {
  FinalizedCharacterStateCandidate,
  FinalizedContinuityFact,
  FinalizedContinuityFactCategory,
  FinalizedSourceIdentity,
} from '../../../shared/finalized-continuity'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import {
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterRosterCharacterState,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { normalizeCharacterRole } from '../../../shared/character-role'
import type { CharacterCandidateInput } from '../../../shared/character-candidate'
import { normalizeCharacterCandidateState } from '../../../shared/character-candidate'
import { writingLanguageText } from '../../../shared/writing-language'
import { localize } from '../../../i18n/core'
import type { Locale } from '../../../i18n/types'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
  /** 批量任务中任一后处理失败即停止，不再继续后续章节 */
  stopOnPostProcessFailure?: boolean
  /** 标记定稿来源，避免批量任务触发单章的自动打开下一章对话框 */
  eventSource?: 'manual' | 'batch'
  /** 手动定稿由 DraftEditor 在确认时冻结；batch 则在 workflow session 内构造同等快照。 */
  snapshot?: FinalizationSnapshot
}

export interface FinalizePostProcessGeneration {
  complete(
    builder: { build: () => string; getSystemRole: () => string },
    callbacks: StepCallbacks,
    output: 'visible-text' | 'structured-data',
    context: WorkflowContext,
  ): Promise<string>
}

/** 容错 JSON 解析（剥离 Markdown 代码块 + 自动截取有效 JSON 边界） */
function parseJSON<T>(text: string): T {
  let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
  const firstBrace = cleanText.indexOf('{')
  const lastBrace = cleanText.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  }
  return JSON.parse(cleanText) as T
}

const CONTINUITY_FACT_LIMIT = 12
const CONTINUITY_STATEMENT_LIMIT = 280
const CONTINUITY_EVIDENCE_LIMIT = 240
type CharacterStatePatch = Partial<Pick<CharacterRosterCharacterState, typeof CHARACTER_STATE_TEXT_FIELDS[number]>>

/** 世界观落袋：单次最多处理几条，以及单条陈述/证据的长度上限。 */
const WORLD_SETTING_UPDATE_LIMIT = 8
const WORLD_SETTING_STATEMENT_LIMIT = 120
const WORLD_SETTING_EVIDENCE_LIMIT = 240

interface WorldSettingUpdateItem {
  entryName: string
  evidence: string
  statement: string
}

interface WorldSettingNewEntityItem {
  name: string
  evidence: string
  statement: string
}

interface WorldSettingUpdateProposal {
  updates: WorldSettingUpdateItem[]
  conflicts: WorldSettingUpdateItem[]
  newEntities: WorldSettingNewEntityItem[]
}

/**
 * 解析定稿后的世界观落袋建议。
 *
 * 与角色状态解析的差别：这里**不抛错** —— 世界观落袋是"锦上添花"，
 * 解析不出来就当本章没有可落袋的进展，绝不因为它让整条定稿链路失败。
 * 但每一项都要严格校验：空名字、空证据、空陈述一律丢弃（宁缺毋滥，
 * 不能让模型凑出来的空壳进事实源）。
 */
function parseWorldSettingUpdateProposal(content: string): WorldSettingUpdateProposal | null {
  let parsed: unknown
  try {
    parsed = parseJSON<unknown>(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const readItems = (
    value: unknown,
    limit: number,
  ): WorldSettingUpdateItem[] => {
    if (!Array.isArray(value)) return []
    const items: WorldSettingUpdateItem[] = []
    for (const raw of value) {
      if (items.length >= limit) break
      if (!isRecord(raw)) continue
      const entryName = typeof raw.entryName === 'string' ? raw.entryName.trim() : ''
      const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : ''
      const statement = typeof raw.statement === 'string' ? raw.statement.trim() : ''
      if (!entryName || !evidence || !statement) continue
      items.push({
        entryName,
        evidence: evidence.slice(0, WORLD_SETTING_EVIDENCE_LIMIT),
        statement: statement.slice(0, WORLD_SETTING_STATEMENT_LIMIT),
      })
    }
    return items
  }

  const newEntities: WorldSettingNewEntityItem[] = []
  if (Array.isArray(parsed.newEntities)) {
    for (const raw of parsed.newEntities) {
      if (newEntities.length >= WORLD_SETTING_UPDATE_LIMIT) break
      if (!isRecord(raw)) continue
      const name = typeof raw.name === 'string' ? raw.name.trim() : ''
      const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : ''
      const statement = typeof raw.statement === 'string' ? raw.statement.trim() : ''
      if (!name || !evidence || !statement) continue
      newEntities.push({
        name,
        evidence: evidence.slice(0, WORLD_SETTING_EVIDENCE_LIMIT),
        statement: statement.slice(0, WORLD_SETTING_STATEMENT_LIMIT),
      })
    }
  }

  return {
    updates: readItems(parsed.updates, WORLD_SETTING_UPDATE_LIMIT),
    conflicts: readItems(parsed.conflicts, WORLD_SETTING_UPDATE_LIMIT),
    newEntities,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Missing state fields preserve the existing fact; an explicitly supplied
 * string (including an empty string) replaces it. Chapter identity is always
 * supplied by the frozen finalization input, never trusted from the model.
 */
function parseCharacterStateUpdates(
  content: string,
  roster: readonly CharacterRosterEntry[],
  chapterNumber: number,
): Map<string, CharacterStatePatch> {
  const parsed = parseJSON<unknown>(content)
  if (!isRecord(parsed)) throw new Error('角色状态响应必须是 JSON 对象')
  if (!Object.hasOwn(parsed, 'updates')) throw new Error('角色状态响应缺少 updates 列表')
  if (!Array.isArray(parsed.updates)) throw new Error('角色状态响应的 updates 必须是列表')

  const rosterByIdentity = new Map<string, CharacterRosterEntry>()
  for (const character of roster) {
    const identity = characterRosterIdentityKey(character.name)
    if (!identity || rosterByIdentity.has(identity)) {
      throw new Error(`角色名单存在同名冲突：「${character.name}」`)
    }
    rosterByIdentity.set(identity, character)
  }

  const updatesByName = new Map<string, CharacterStatePatch>()
  for (const [index, rawUpdate] of parsed.updates.entries()) {
    if (!isRecord(rawUpdate)) throw new Error(`角色状态 updates[${index}] 格式无效`)
    if (typeof rawUpdate.name !== 'string' || !rawUpdate.name.trim()) {
      throw new Error(`角色状态 updates[${index}].name 必须是非空文本`)
    }
    const identity = characterRosterIdentityKey(rawUpdate.name)
    const character = rosterByIdentity.get(identity)
    if (!character) throw new Error(`角色状态更新引用了未知角色：「${rawUpdate.name.trim()}」`)
    if (updatesByName.has(character.name)) {
      throw new Error(`角色状态响应包含同名冲突：「${rawUpdate.name.trim()}」`)
    }
    if (!isRecord(rawUpdate.currentState)) {
      throw new Error(`角色状态 updates[${index}].currentState 必须是对象`)
    }

    const patch: CharacterStatePatch = {}
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      if (!Object.hasOwn(rawUpdate.currentState, field)) continue
      const value = rawUpdate.currentState[field]
      if (typeof value !== 'string') {
        throw new Error(`角色状态 updates[${index}].currentState.${field} 必须是文本`)
      }
      patch[field] = value.trim()
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(`角色状态 updates[${index}].currentState 没有可更新字段`)
    }
    if (
      Object.hasOwn(rawUpdate.currentState, 'updatedAtChapter')
      && rawUpdate.currentState.updatedAtChapter !== chapterNumber
    ) {
      throw new Error(`角色状态 updates[${index}].currentState.updatedAtChapter 与定稿章节不一致`)
    }
    updatesByName.set(character.name, patch)
  }
  return updatesByName
}

/**
 * 在正文里找该名字出现过的那一句，作为「凭什么提他」的证据。
 *
 * 纯本地字符串查找，**不花任何 token** —— 却能让作者一眼看出这人是在哪儿冒出来
 * 的，而不必自己回正文里翻。找不到就留空，绝不编造。
 */
function locateNameEvidence(chapterContent: string, name: string): string {
  const index = chapterContent.indexOf(name)
  if (index < 0) return ''
  const from = Math.max(0, index - 60)
  const to = Math.min(chapterContent.length, index + name.length + 60)
  return chapterContent.slice(from, to).replace(/\s+/gu, ' ').trim()
}

/**
 * 从定稿后处理的输出里接住 `newCharacters`。
 *
 * ── 为什么单独一个函数，而且刻意写得宽松 ────────────────────────────────────
 * 上面那句 parseCharacterStateUpdates 是**严格**的：状态写回一旦对不上号就必须
 * 停下来，宁可不写也不能写错。但新角色候选是**附加信息** —— 它丢了最多是少一次
 * 提名，绝不该把整章定稿搞失败。所以这里所有读不懂的地方都退化成「这一条不要」，
 * 而不是抛错。
 *
 * ── 接上这段输出的意义 ──────────────────────────────────────────────────────
 * 提示词早就要求模型返回 `newCharacters`（「分析并在 newCharacters 中提取本章
 * 新出场的重要角色，不要包含路人或已死无后续影响的龙套」），模型也照做了，
 * 可此前**没有任何代码读它** —— 那一半 token 白花，正文里冒出来的新人物既不建档、
 * 也没人提醒作者。先生 2026-09-21 点破了这件事：「这应该让用户自己来判断」。
 *
 * 追记（同一天，先生第二次报障）：接住 name / role 之后，`currentState` 又被漏了一层 ——
 * 提示词给每个新角色都写了状态（location / powerLevel / physicalState / mentalState /
 * keyItems / recentEvents），解析器却只取名字。于是作者采纳建档后得到一张只有名字的
 * 空卡：「新档只有名字，里面没有任何的内容？」这一处一并接住，见下面的 currentState。
 *
 * 所以这里只**提名**：交给待确认队列，等作者点头才建档（见 character-candidate）。
 *
 * 刻意 export：这条「接住 newCharacters」的契约值得被单测钉住 —— 它此前正是因为
 * 没人读而静默失效了整整一轮。
 */
export function parseNewCharacterCandidates(
  content: string,
  roster: readonly CharacterRosterEntry[],
  chapterContent: string,
  chapterNumber: number,
): CharacterCandidateInput[] {
  let parsed: unknown
  try {
    parsed = parseJSON<unknown>(content)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.newCharacters)) return []

  const rosterKeys = new Set(
    roster
      .map(character => characterRosterIdentityKey(character.name))
      .filter(Boolean),
  )
  const seen = new Set<string>()
  const candidates: CharacterCandidateInput[] = []
  for (const raw of parsed.newCharacters) {
    if (!isRecord(raw)) continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name || name.length > 200) continue
    const key = characterRosterIdentityKey(name)
    // 已经在名单里的不算新人；同一次输出里重名的只留一条。
    if (!key || rosterKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    candidates.push({
      name,
      role: normalizeCharacterRole(raw.role),
      evidence: locateNameEvidence(chapterContent, name),
      chapterNumber,
      /**
       * 一并接住 `currentState`。
       *
       * 提示词的要求写在输出格式里：`newCharacters` 的每一项都带 location /
       * powerLevel / physicalState / mentalState / keyItems / recentEvents /
       * updatedAtChapter，与 `updates` 里已有角色的形状完全一致。
       * 此前这里只读 name 与 role，把这一整块丢了 —— 作者在角色页点「采纳并建档」，
       * 建出来的新档除名字以外一片空白（先生报障）。这份状态本来就在返回里，
       * 接住它不花任何额外 token，只是此前没人读。
       */
      currentState: normalizeCharacterCandidateState(raw.currentState, chapterNumber),
    })
  }
  return candidates
}

function factCategory(statement: string): FinalizedContinuityFactCategory {
  if (/(?:角色|状态|持有|受伤|位于|死亡|身亡|牺牲|去世|character|holds?|injur|location|dead|died|deceased)/iu.test(statement)) return 'character-state'
  if (/(?:时间|当日|翌日|多年|之前|之后|timeline|before|after|years?)/iu.test(statement)) return 'timeline'
  if (/(?:伏笔|悬念|承诺|未解|线索|promise|unresolved|clue|mystery)/iu.test(statement)) return 'open-thread'
  return 'plot'
}

function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(groups.flatMap((group) => {
    const characters = [...group]
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
  }))
}

function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  const factEntities = entities.filter(entity => statement.includes(entity))
  const statementWithoutEntities = [...factEntities]
    .sort((left, right) => right.length - left.length)
    .reduce((text, entity) => text.split(entity).join(' '), statement)
  const signals = textBigrams(statementWithoutEntities)
  const signalList = [...signals]
  const candidates = factEntities.length > 0
    ? sentences.filter(sentence => factEntities.some(entity => sentence.includes(entity)))
    : sentences
  const ranked = candidates
    .map((sentence) => {
      const sentenceSignals = textBigrams(sentence)
      const matchedIndexes = signalList
        .map((signal, index) => sentenceSignals.has(signal) ? index : -1)
        .filter(index => index >= 0)
      const independentlySupported = matchedIndexes.some((index, matchIndex) => (
        matchIndex > 0 && index - matchedIndexes[matchIndex - 1] > 1
      ))
      return {
        sentence,
        score: matchedIndexes.length,
        supported: matchedIndexes.length === signalList.length || independentlySupported,
      }
    })
    .sort((left, right) => right.score - left.score)
  const minimumScore = factEntities.length > 0 ? 1 : 2
  const matched = ranked.find(candidate => candidate.score >= minimumScore && candidate.supported)?.sentence
  return (matched ?? '').slice(0, CONTINUITY_EVIDENCE_LIMIT).trim()
}

export function buildFinalizedContinuityFacts(
  chapterNumber: number,
  chapterNotes: string,
  finalizedContent: string,
  chapterEntities: readonly string[] = [],
): FinalizedContinuityFact[] {
  const entities = [...new Set(chapterEntities.map(entity => entity.trim()).filter(Boolean))].slice(0, 8)
  const statements = chapterNotes
    .split(/\n+|(?<=[。！？.!?])\s*/u)
    .map(statement => statement.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim())
    .filter(Boolean)
  return statements.flatMap(statement => {
    const factEntities = entities.filter(entity => statement.includes(entity))
    const evidence = evidenceExcerpt(finalizedContent, statement, factEntities)
    return evidence
      ? [{
          category: factCategory(statement),
          entities: factEntities,
          statement: statement.slice(0, CONTINUITY_STATEMENT_LIMIT),
          sourceChapter: chapterNumber,
          evidence,
        }]
      : []
  }).slice(0, CONTINUITY_FACT_LIMIT)
}

// ===== 世界观落袋：名称解析与证据校验（导出供测试）=====

/** 名称解析的输入：只关心 id / 名称 / 别名，正文与摘要留给调用方。 */
export interface WorldSettingNameCandidate {
  id: number
  name: string
  aliases: readonly string[]
}

/**
 * 名称解析的三种结果。
 *
 * 为什么必须把「歧义」与「无命中」分开（review P1）：
 * 两者曾经都被揉成一个 `null`，于是共享同一条「降级为待确认候选」的路径 ——
 * 而那条路径用覆盖式 save 落库，歧义名字一旦与既有条目同名，就会覆盖作者已确认的
 * 原文。语义上它们本就不同：
 *   · `ambiguous` —— 库里有多条可能的目标，**不能猜**，也**不是新条目**（名字早就存在）；
 *   · `unmatched` —— 库里真的没有这个名字，才是「正文引出、库里还没有」的新设定。
 */
export type WorldSettingNameMatch =
  | { kind: 'unique'; id: number }
  | { kind: 'ambiguous' }
  | { kind: 'unmatched' }

/**
 * 把一个模型返回的名称归类：唯一命中 / 歧义 / 无命中。
 *
 * 反例（review 点名）：库中有「东城商会」和「西城商会」，模型只报「商会」——
 * 两个名字都包含它，按长度差挑一个会把进展写进任意一条。所以这里：
 *   · 规范名称精确命中（大小写折叠）且**唯一** → unique；
 *   · **唯一**别名精确命中 → unique；
 *   · 多个条目同时命中（含重复别名）→ ambiguous，绝不靠长度差猜一个；
 *   · 完全没命中 → unmatched，可进候选队列等作者确认。
 */
export function classifyWorldSettingName(
  rawName: string,
  candidates: readonly WorldSettingNameCandidate[],
): WorldSettingNameMatch {
  const wanted = rawName.trim()
  if (!wanted) return { kind: 'unmatched' }
  const folded = wanted.toLowerCase()

  const nameMatches = candidates.filter(candidate => candidate.name.toLowerCase() === folded)
  if (nameMatches.length === 1) return { kind: 'unique', id: nameMatches[0].id }
  if (nameMatches.length > 1) return { kind: 'ambiguous' }

  const aliasMatches = candidates.filter(candidate => (
    candidate.aliases.some(alias => alias.trim().toLowerCase() === folded)
  ))
  if (aliasMatches.length === 1) return { kind: 'unique', id: aliasMatches[0].id }
  if (aliasMatches.length > 1) return { kind: 'ambiguous' }

  return { kind: 'unmatched' }
}

/**
 * 把一个模型返回的名称解析成真实条目 id，**只在无歧义时返回**。
 *
 * 歧义与无命中都会得到 `null`；需要区分二者时用 classifyWorldSettingName ——
 * 「歧义」绝不能当成新条目去建候选，那正是 review P1 的入口。
 */
export function resolveWorldSettingEntryId(
  rawName: string,
  candidates: readonly WorldSettingNameCandidate[],
): number | null {
  const match = classifyWorldSettingName(rawName, candidates)
  return match.kind === 'unique' ? match.id : null
}

/** 空白/换行归一化：排版与模型回传引文在空格、换行上常有差异，归一化后再比对。 */
function normalizeEvidenceWhitespace(value: string): string {
  return value.replace(/\s+/gu, '')
}

/**
 * 判断一段「原文证据」是否真的出现在冻结的定稿正文里。
 *
 * 反例（review 点名）：正文只有「旅人独自离开了客栈，走向山路。」，
 * 模型却报 evidence =「青云宗已经彻底覆灭。」—— 引文根本不在正文里，
 * 却因「非空」而被当成有据可查。这里要求归一化后 evidence 必须是正文子串。
 */
export function evidenceAppearsInContent(content: string, evidence: string): boolean {
  const foldedEvidence = normalizeEvidenceWhitespace(evidence)
  if (!foldedEvidence) return false
  return normalizeEvidenceWhitespace(content).includes(foldedEvidence)
}

// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
  generation: FinalizePostProcessGeneration,
  finalizedDraftId?: number,
  chapterEntities: readonly string[] = [],
  uiLocale: Locale = 'zh-CN',
  finalizedSource?: FinalizedSourceIdentity,
  projectionGeneration?: number,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []
  const text = (zhCNText: string, enUSText: string) => localize(uiLocale, zhCNText, enUSText)
  let generatedChapterNotes: string | undefined
  let generatedCharacterCards: string | undefined

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: text('导入知识库', 'Import into knowledge base'),
    critical: true,
    executor: async (callbacks, context) => {
      if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
      if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
      const projectSession = requireWorkflowProjectSession(context)
      const writingLanguage = workflowWritingLanguage(context)
      const contentFileName = chapterTitle
        ? writingLanguageText(
            writingLanguage,
            `第${chapterNumber}章 ${chapterTitle}.txt`,
            `Chapter ${chapterNumber} ${chapterTitle}.txt`,
          )
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:import-text',
        draftContent,
        contentFileName,
        _project.path,
      ) as { success: boolean; error?: string; chunkCount?: number; docId?: string }
      requireIpcSuccess(result, text('导入知识库', 'Import into knowledge base'))
      if (finalizedDraftId !== undefined) {
        if (!result.docId) throw new Error(workflowUiText(
          context,
          '知识库导入成功但缺少文档身份收据',
          'The knowledge-base import succeeded but returned no document identity receipt.',
        ))
        const linked = await ipc.invokeWithProjectSession(
          projectSession,
          'db:finalization-link-knowledge-document',
          finalizedDraftId,
          result.docId,
          _project.path,
        )
        requireIpcSuccess(linked, text(
          '登记定稿知识文档身份',
          'Link finalized knowledge document identity',
        ))
      }
      callbacks.log(workflowUiText(
        context,
        `正文章节已导入知识库（${result.chunkCount} 块）`,
        `Manuscript chapter imported into the knowledge base (${result.chunkCount} chunks)`,
      ))
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  steps.push({
      key: 'chapter_notes',
      label: text('章节剧情要点', 'Chapter plot notes'),
      critical: true,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        if (
          finalizedDraftId !== undefined
          && (
            !finalizedSource
            || finalizedSource.draftId !== finalizedDraftId
            || !Number.isSafeInteger(projectionGeneration)
            || projectionGeneration! < 0
          )
        ) {
          throw new Error(workflowUiText(
            context,
            '定稿连续性投影缺少模型调用前冻结的来源水位',
            'The finalized continuity projection is missing the source watermark frozen before the model call.',
          ))
        }
        const projectSession = requireWorkflowProjectSession(context)
        const writingLanguage = workflowWritingLanguage(context)
        const notesTemplate = await resolvePromptTemplate('generate_chapter_notes', projectSession, writingLanguage)
        if (!notesTemplate) throw new Error(workflowUiText(
          context,
          '未找到章节要点模板',
          'Chapter-notes template not found.',
        ))
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate, writingLanguage)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        generatedChapterNotes ??= await generation.complete(notesBuilder, callbacks, 'visible-text', context)
        const cleanNotes = generatedChapterNotes
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))

        if (finalizedDraftId !== undefined) {
          const facts = buildFinalizedContinuityFacts(
            chapterNumber,
            cleanNotes,
            draftContent,
            chapterEntities,
          )
          const continuityResult = await ipc.invokeWithProjectSession(
            projectSession,
            'db:continuity-save-finalized',
            {
              draftId: finalizedDraftId,
              chapterNumber,
              chapterNotes: cleanNotes,
              facts,
              projectionGeneration: projectionGeneration!,
              source: finalizedSource!,
            },
            _project.path,
          )
          requireIpcSuccess(continuityResult, text(
            '保存定稿连续性事实',
            'Save finalized continuity facts',
          ))
          callbacks.log(workflowUiText(
            context,
            `已投影连续性事实：${facts.length} 条`,
            `Projected continuity facts: ${facts.length}`,
          ))
        }

        // 兼容已有蓝图项目；作者原稿无蓝图时，权威事实仍已由定稿投影保存。
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-update-notes',
          chapterNumber,
          cleanNotes,
          _project.path,
        )
        requireIpcSuccess(result, text('写入章节剧情要点', 'Write chapter plot notes'))
        callbacks.log(
          result.updated === false
            ? workflowUiText(
                context,
                '本章剧情要点提取完成（已保存定稿连续性事实）',
                'Chapter plot-note extraction completed; finalized continuity facts were saved.',
              )
            : workflowUiText(
                context,
                '本章剧情要点提取完成（已写入蓝图）',
                'Chapter plot-note extraction completed and was written to the blueprint.',
              ),
        )
      },
    })

  // ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  steps.push({
      key: 'character_cards',
      label: text('角色状态更新', 'Update character state'),
      critical: false,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        const projectSession = requireWorkflowProjectSession(context)
        const writingLanguage = workflowWritingLanguage(context)
        const cardTemplate = await resolvePromptTemplate('update_character_cards', projectSession, writingLanguage)
        if (!cardTemplate) throw new Error(workflowUiText(
          context,
          '未找到角色状态模板',
          'Character-state template not found.',
        ))
        // 章节定稿只更新已存在的结构化角色状态。新角色必须来自作者确认
        // 或已提交蓝图的明确候选，不能由正文后处理模型自由创建。
        const roster = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-roster-read',
          _project.path,
        )
        if (roster.status !== 'ready' && roster.status !== 'empty') {
          throw new Error(workflowUiText(
            context,
            '角色名单当前不可安全更新；请先完成旧项目修复或处理数据不一致状态',
            'The character roster cannot be updated safely. Repair the legacy project or resolve its inconsistent data first.',
          ))
        }
        const allChars = roster.entries
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        const cardBuilder = new PostProcessPromptBuilder(cardTemplate, writingLanguage)
          .withChapterContent(draftContent.trim())
          .withChapterNumber(chapterNumber)
          .withExistingCardsJson(simpleCards)

        const cardsResult = generatedCharacterCards ?? await generation.complete(
          cardBuilder,
          callbacks,
          'structured-data',
          context,
        )
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        const updatesByName = parseCharacterStateUpdates(cardsResult, allChars, chapterNumber)
        generatedCharacterCards = cardsResult

        /**
         * 顺手接住模型这次一并给出的**新角色提名**。
         *
         * 提示词一直在要 `newCharacters`，但此前没人读 —— 这里把它接进待确认队列：
         * 只提名、不建档，等作者在角色页点头（先生 2026-09-21 定的形态）。
         *
         * 两处刻意为之：
         *   · 它是**附加信息**，所以入队失败只留一行日志，绝不拖垮定稿；
         *   · 提名的依据不必回模型要 —— 直接在正文里找该名字出现过的一句，
         *     本地字符串查找，零 token。
         */
        const newCharacterCandidates = parseNewCharacterCandidates(
          cardsResult,
          allChars,
          draftContent,
          chapterNumber,
        )
        if (newCharacterCandidates.length > 0) {
          try {
            const queued = await ipc.invokeWithProjectSession(
              projectSession,
              'db:character-candidate-queue',
              newCharacterCandidates,
              _project.path,
            ) as { success?: boolean; queued?: number } | undefined
            if (queued?.success && (queued.queued ?? 0) > 0) {
              callbacks.log(workflowUiText(
                context,
                `发现 ${queued.queued} 名名单外的新角色，已放进角色栏「待确认」等你裁决`,
                `${queued.queued} character(s) outside the roster were queued in “Pending review”`,
              ))
            }
          } catch (error) {
            callbacks.log(workflowUiText(
              context,
              `  新角色提名入队失败（不影响定稿）：${error}`,
              `  Could not queue new-character candidates (finalization is unaffected): ${error}`,
            ))
          }
        }

        let updatedCount = 0
        const changedEntries: CharacterRosterEntry[] = []
        const blockedCandidates: FinalizedCharacterStateCandidate[] = []
        for (const character of allChars) {
          const patch = updatesByName.get(character.name)
          if (!patch) continue
          updatedCount += 1
          const currentState = character.currentState
          if (!finalizedSource || finalizedSource.draftId !== finalizedDraftId) {
            throw new Error(workflowUiText(
              context,
              '角色状态更新缺少冻结定稿来源收据',
              'The character-state update is missing its frozen finalization receipt.',
            ))
          }
          // Only fields actually returned by this model call carry this derived receipt.
          const provenance: NonNullable<CharacterRosterCharacterState['provenance']> = {}
          for (const field of CHARACTER_STATE_TEXT_FIELDS) {
            if (!Object.hasOwn(patch, field)) continue
            provenance[field] = { kind: 'derived', source: finalizedSource }
            const previousValue = currentState?.[field] ?? ''
            const previousSource = currentState?.provenance?.[field]
            const protectedValue = previousSource?.kind === 'author'
              || previousSource?.kind === 'legacy'
              || Boolean(previousValue && previousSource?.kind !== 'derived')
            if (protectedValue && patch[field] !== previousValue) {
              blockedCandidates.push({ characterName: character.name, field, value: patch[field] ?? '' })
            }
          }
          // 章节推进只提交状态补丁：关系边与关系备注由主进程按既有事实保留，
          // 候选无需（也不应该）在这里改写它们。
          changedEntries.push({
            ...character,
            currentState: {
              location: patch.location ?? currentState?.location ?? '',
              powerLevel: patch.powerLevel ?? currentState?.powerLevel ?? '',
              physicalState: patch.physicalState ?? currentState?.physicalState ?? '',
              mentalState: patch.mentalState ?? currentState?.mentalState ?? '',
              keyItems: patch.keyItems ?? currentState?.keyItems ?? '',
              recentEvents: patch.recentEvents ?? currentState?.recentEvents ?? '',
              updatedAtChapter: chapterNumber,
              provenance,
            },
          })
        }

        if (updatedCount > 0) {
          if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
          const result = await ipc.invokeWithProjectSession(
            projectSession,
            'db:character-roster-commit',
            {
              operationId: `chapter-progress-${context.runId}-${chapterNumber}`,
              expectedRevision: roster.revision,
              schemaVersion: 1,
              intent: 'chapter_progress',
              source: finalizedSource,
              // chapter_progress only carries changed state for confirmed
              // characters; it never echoes untouched legacy relationship notes.
              entries: changedEntries,
            },
            _project.path,
          )
          if (!result.success || !result.receipt) {
            throw new Error(result.error || workflowUiText(
              context,
              '角色状态未能原子提交',
              'Character-state updates could not be committed atomically.',
            ))
          }
          if (blockedCandidates.length > 0) {
            if (projectionGeneration === undefined) {
              throw new Error(workflowUiText(
                context,
                '角色状态候选缺少连续性投影水位',
                'The character-state candidates are missing the continuity projection watermark.',
              ))
            }
            const candidateResult = await ipc.invokeWithProjectSession(
              projectSession,
              'db:continuity-save-character-state-candidates',
              {
                draftId: finalizedDraftId!,
                chapterNumber,
                candidates: blockedCandidates,
                projectionGeneration,
                source: finalizedSource!,
              },
              _project.path,
            )
            requireIpcSuccess(candidateResult, text(
              '保存角色状态原文定位候选',
              'Save character-state prose locators',
            ))
          }
          if (updatedCount > 0) callbacks.log(workflowUiText(
            context,
            `更新角色动态状态: ${updatedCount} 名`,
            `Updated dynamic character state: ${updatedCount}`,
          ))
        }
      },
    })

  // ─── 步骤 4: 世界观设定落袋 ──────────────────────────────────────
  //
  // 先生点名要的那一环：正文一直往前写，设定库却停在建库那一刻 ——
  // AI 手里的「事实源」会越来越过时，最后输出混乱。
  // 这里把本章产生的设定进展落袋，分三档处理：
  //   · updates     正文有原文证据的事实演进 → **自动追加**进条目（只增不改）
  //   · conflicts   正文与条目直接矛盾     → 不自动改，记进日志请作者裁决
  //   · newEntities 正文出现的全新专名     → 存成 pending 候选，作者确认后入库
  // 只处理**作者为本章声明引用**的条目，与写稿/审稿的注入范围保持一致。
  steps.push({
    key: 'world_settings',
    label: text('世界观设定更新', 'Update world settings'),
    critical: false,
    executor: async (callbacks, context) => {
      if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
      if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
      const projectSession = requireWorkflowProjectSession(context)
      const writingLanguage = workflowWritingLanguage(context)
      const expectedProjectPath = _project.path

      // 本章引用了哪些设定？没有引用也要继续跑 ——
      // 因为**正文可能引出从未被任何章节引用过的新设定**，那种东西
      // 如果不趁定稿时沉淀下来，作者永远不知道自己的世界里多了什么。
      const refs = await ipc.invoke(
        'world-setting:list-chapter-refs',
        chapterNumber,
        expectedProjectPath,
      )
      const allEntries = await ipc.invoke('world-setting:list', expectedProjectPath)
      if (!Array.isArray(allEntries)) return
      const byId = new Map<number, (typeof allEntries)[number]>()
      for (const entry of allEntries) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'number') byId.set(entry.id, entry)
      }
      // 闸门：pending 候选不进任何 AI 链路（与写稿一致）。
      const referenced = (Array.isArray(refs) ? refs : [])
        .map(ref => (ref && typeof ref === 'object' && typeof ref.settingId === 'number'
          ? byId.get(ref.settingId)
          : undefined))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter(entry => entry.status !== 'pending')

      const template = await resolvePromptTemplate('update_world_settings', projectSession, writingLanguage)
      if (!template) throw new Error(workflowUiText(
        context,
        '未找到世界观更新模板',
        'The world-setting update template was not found.',
      ))

      const builder = new PostProcessPromptBuilder(template, writingLanguage)
        .withChapterContent(draftContent.trim())
        .withChapterNumber(chapterNumber)
        .withReferencedEntriesJson(referenced.map(entry => ({
          name: entry.name,
          summary: entry.summary,
          content: entry.content,
        })))

      const raw = await generation.complete(builder, callbacks, 'structured-data', context)
      if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
      const proposal = parseWorldSettingUpdateProposal(raw)
      if (!proposal) {
        // 解析失败不影响定稿（critical: false），但要留下线索。
        callbacks.log(workflowUiText(
          context,
          '  世界观更新结果无法解析，本次跳过落袋',
          '  The world-setting update result could not be parsed; skipped this time',
        ))
        return
      }

      /**
       * 可解析条目池：本章引用的条目 + 全库已有条目（按 id 去重）。
       *
       * 为什么必须带上全库：正文可能引出**从未被本章声明引用**的既有条目 ——
       * 本步骤开头点名要覆盖这个场景。旧实现只在 `referenced` 里解析名字，
       * 于是「本章没有引用任何条目」时，模型报上来的每一条进展都必然匹配失败
       * 并被静默丢弃：作者只看到「4/4 成功」，库里却一条候选都没多。
       */
      interface ResolvableSettingEntry {
        id: number
        name: string
        aliases: string[]
        summary: string
        content: string
      }
      const resolvableEntries: ResolvableSettingEntry[] = []
      const seenEntryIds = new Set<number>()
      for (const entry of [...referenced, ...allEntries]) {
        if (!entry || typeof entry !== 'object') continue
        const { id, name } = entry
        if (typeof id !== 'number' || !Number.isInteger(id) || seenEntryIds.has(id)) continue
        if (typeof name !== 'string' || !name.trim()) continue
        seenEntryIds.add(id)
        resolvableEntries.push({
          id,
          name,
          aliases: Array.isArray(entry.aliases)
            ? entry.aliases.filter((alias): alias is string => typeof alias === 'string')
            : [],
          summary: typeof entry.summary === 'string' ? entry.summary : '',
          content: typeof entry.content === 'string' ? entry.content : '',
        })
      }

      /**
       * 把一个模型返回的名字归类：唯一命中 / 歧义 / 无命中。
       *
       * 为什么要放宽到全等之外：模型对同一个设定的措辞常与条目名有细微差异
       * （大小写、空格、用别名）—— 匹配失手不该让进展被**静默丢弃**，所以
       * 「无命中」会降级为待确认候选，并**记住失手**留下日志线索。
       * 但放宽只到「全等（折叠大小写）」为止：包含关系一律不算命中，
       * 更不会靠长度差在多个候选里挑一个。
       *
       * 歧义与无命中是两件不同的事：歧义不自动归属、也**不建候选**
       * （名字本来就存在，不是新设定）；无命中才是「正文引出、库里还没有」的新设定。
       */
      const classifyEntryName = (rawName: string): WorldSettingNameMatch => (
        classifyWorldSettingName(rawName, resolvableEntries)
      )
      const idToEntry = new Map(resolvableEntries.map(entry => [entry.id, entry]))
      /** 因名称歧义而未自动归属的条目名（含重复别名）：只如实报告，库里一个字都不动。 */
      const ambiguousNames = new Set<string>()
      let ambiguousCount = 0

      // 记下「模型报了、但对不上任何条目」的名字，供日志排查（否则无从下手）。
      const unresolvedNames = new Set<string>()
      /**
       * 对不上任何条目的 updates：它们其实是「正文引出、库里还没有」的设定。
       * 旧实现只记一笔日志然后丢弃 —— 作者永远不会知道正文里多了什么设定，
       * 只看到这一步"成功"。这里降级为待确认候选，与 newEntities 走同一条
       * 落库路径，由作者在待确认队列里裁决。
       */
      const unmatchedAsCandidates: Array<{ name: string; evidence: string; statement: string }> = []

      // ① 事实演进：有原文证据 → 自动追加（仓储侧只增不改，作者原文一个字都不动）
      let appendedCount = 0
      let rejectedEvidenceCount = 0
      for (const item of proposal.updates) {
        if (!item.evidence.trim() || !item.statement.trim()) continue
        const match = classifyEntryName(item.entryName)
        if (match.kind === 'ambiguous') {
          // 歧义绝不能当新条目去建候选：那条路径在名字撞车时会退化成一次覆盖式写入，
          // 把模型编造的引文写进作者已确认的事实源（review P1）。这里只报告，不落库。
          ambiguousCount += 1
          ambiguousNames.add(item.entryName)
          continue
        }
        if (match.kind === 'unmatched') {
          unresolvedNames.add(item.entryName)
          unmatchedAsCandidates.push({
            name: item.entryName,
            evidence: item.evidence,
            statement: item.statement,
          })
          continue
        }
        const entryId = match.id
        // 自动追加的引文必须真的出自冻结正文，否则就是模型编造，不得进事实源。
        if (!evidenceAppearsInContent(draftContent, item.evidence)) {
          rejectedEvidenceCount += 1
          continue
        }
        const result = await ipc.invoke(
          'world-setting:append-derived',
          entryId,
          { content: item.statement.trim() },
          chapterNumber,
          expectedProjectPath,
        )
        if (result && typeof result === 'object' && 'appended' in result && result.appended) {
          appendedCount += 1
        }
      }

      // ② 直接冲突：绝不自动改 —— 「两个事实打架」时 AI 不知道该听哪边，
      //    写进 updates 会把作者原本正确的设定改掉。
      //    落进裁决队列，让作者在界面上并排对照后一键处理（不必自己去库里翻找）。
      let conflictCount = 0
      for (const item of proposal.conflicts) {
        const match = classifyEntryName(item.entryName)
        if (match.kind !== 'unique') {
          // 冲突登记同样不接受歧义归属：记到哪一条都不对，只报告。
          if (match.kind === 'ambiguous') {
            ambiguousCount += 1
            ambiguousNames.add(item.entryName)
          } else {
            unresolvedNames.add(item.entryName)
          }
          continue
        }
        const entryId = match.id
        const entry = idToEntry.get(entryId)
        if (!entry) continue
        const recorded = await ipc.invoke(
          'world-setting:record-conflict',
          {
            chapterNumber,
            settingId: entry.id,
            settingName: entry.name,
            settingContentSnapshot: entry.content || entry.summary || '',
            evidence: item.evidence.trim(),
            statement: item.statement.trim(),
          },
          expectedProjectPath,
        )
        if (recorded && typeof recorded === 'object' && 'id' in recorded) conflictCount += 1
      }

      // ③ 新实体 + 对不上条目的进展：都存成待确认候选，作者确认后才成为事实源。
      let pendingCount = 0
      /** 候选名字与既有条目撞车（含大小写折叠）而被拒绝的次数 —— 如实报告，绝不虚报成功。 */
      let candidateConflictCount = 0
      const queuedCandidateNames = new Set<string>()
      const pendingInputs = [
        ...proposal.newEntities.map(item => ({
          name: item.name,
          evidence: item.evidence,
          statement: item.statement,
        })),
        // 模型把「正文引出、库里还没有」的设定误报成既有条目的进展时，
        // 它们是同一个东西，必须一起进入候选，而不是被丢掉。
        ...unmatchedAsCandidates,
      ]
      for (const item of pendingInputs) {
        const name = item.name.trim()
        if (!name || !item.statement.trim()) continue
        // 同一件事可能同时出现在 updates 与 newEntities（提示词要求不要两边都写，
        // 但模型会犯），按身份去重后只建一条候选。
        const candidateKey = name.toLowerCase()
        if (queuedCandidateNames.has(candidateKey)) continue
        queuedCandidateNames.add(candidateKey)
        // 已经存在的条目（含别名、含全库）不该再建一条 ——
        // 但它的内容可能是本章新写的，所以转为「追加进展」而不是一丢了之。
        // 必须与 updates 走同一套无歧义解析：歧义/包含关系绝不自动归属，
        // 否则「北境仙门」这种重复别名会在这里绕过保护、写进第一条条目。
        const match = classifyWorldSettingName(name, resolvableEntries)
        if (match.kind === 'ambiguous') {
          // 重复别名/多命中：既不能自动归属，也不能当成「新条目」建候选 ——
          // 名字早就属于别人，建候选等于把歧义偷偷变成一次覆盖式写入。
          ambiguousCount += 1
          ambiguousNames.add(name)
          continue
        }
        if (match.kind === 'unique') {
          // 同名转追加也不能绕过证据校验 —— 引文不在正文里就绝不自动写入。
          if (!evidenceAppearsInContent(draftContent, item.evidence)) {
            rejectedEvidenceCount += 1
            continue
          }
          const appended = await ipc.invoke(
            'world-setting:append-derived',
            match.id,
            { content: item.statement.trim() },
            chapterNumber,
            expectedProjectPath,
          )
          if (appended && typeof appended === 'object' && 'appended' in appended && appended.appended) {
            appendedCount += 1
          }
          continue
        }
        // 库里确实没有这个名字 → 走**只新增**的候选通道。
        // 不能用 world-setting:save：它是覆盖式 upsert（默认 author 权限、UPDATE 又不改
        // status），同名撞车时会改写作者已确认的条目，且 pendingCount 会虚报（review P1）。
        const created = await ipc.invoke(
          'world-setting:create-candidate',
          {
            category: 'world',
            name,
            content: `${item.statement.trim()}\n\n依据（第${chapterNumber}章）：${item.evidence.trim()}`,
            source: 'ai',
            status: 'pending',
            provenance: { content: { kind: 'derived', chapterNumber } },
          },
          expectedProjectPath,
        )
        // 只有真在库里建出 pending 行才计数：不做「调用成功就算新增」的虚报。
        if (created && typeof created === 'object' && 'created' in created && created.created) {
          pendingCount += 1
        } else if (
          created && typeof created === 'object' && 'reason' in created
          && created.reason === 'duplicate-name'
        ) {
          candidateConflictCount += 1
        }
      }

      const summaryParts: string[] = []
      if (appendedCount > 0) summaryParts.push(
        workflowUiText(context, `${appendedCount} 条已更新`, `${appendedCount} updated`),
      )
      if (conflictCount > 0) summaryParts.push(
        workflowUiText(context, `${conflictCount} 条冲突待裁决`, `${conflictCount} conflicts need review`),
      )
      if (pendingCount > 0) summaryParts.push(
        workflowUiText(context, `${pendingCount} 条新设定待确认`, `${pendingCount} new entries pending review`),
      )
      if (ambiguousCount > 0) {
        // 名字全列出来会刷屏，但一条都不给又没法排查：给前 5 个。
        const shownNames = Array.from(ambiguousNames).slice(0, 5).join('、')
        summaryParts.push(workflowUiText(
          context,
          `${ambiguousCount} 条名称歧义、未自动归属（${shownNames}）`,
          `${ambiguousCount} ambiguous names were not auto-assigned (${shownNames})`,
        ))
      }
      if (candidateConflictCount > 0) summaryParts.push(
        workflowUiText(
          context,
          `${candidateConflictCount} 条候选因同名已存在未写入`,
          `${candidateConflictCount} candidates were skipped: the name already exists`,
        ),
      )
      if (rejectedEvidenceCount > 0) summaryParts.push(
        workflowUiText(
          context,
          `${rejectedEvidenceCount} 条证据不在正文、已拒绝自动写入`,
          `${rejectedEvidenceCount} rejected: evidence not found in the manuscript`,
        ),
      )
      if (summaryParts.length > 0) {
        callbacks.log(workflowUiText(
          context,
          `世界观设定：${summaryParts.join('，')}`,
          `World settings: ${summaryParts.join(', ')}`,
        ))
      } else if (referenced.length > 0 || unresolvedNames.size > 0) {
        // 有引用却一条都没落袋、或者模型报了名字却一条都对不上：这是最需要排查的
        // 情况，必须留下可查的线索。旧条件只看 referenced.length，于是「本章没有引用
        // 任何条目」时整步静默 —— 作者只看到"4/4 成功"，库里却什么都没多。
        const unresolvedHint = unresolvedNames.size > 0
          ? workflowUiText(
            context,
            `（模型报了对不上的条目名：${Array.from(unresolvedNames).join('、')}）`,
            ` (the model named entries that could not be matched: ${Array.from(unresolvedNames).join(', ')})`,
          )
          : workflowUiText(
            context,
            '（模型未报告任何事实变化）',
            ' (the model reported no factual changes)',
          )
        callbacks.log(workflowUiText(
          context,
          `世界观设定：本次无更新${unresolvedHint}`,
          `World settings: nothing updated this time${unresolvedHint}`,
        ))
      }
    },
  })

  return steps
}

export interface RunFinalizePostProcessParams {
  project: { path: string }
  chapterNumber: number
  chapterTitle: string
  draftContent: string
  draftId: number
  sourceLabel: string
  finalizedSource: FinalizedSourceIdentity
  stopOnFailure?: boolean
  onlyFailed?: boolean
  stepKey?: string
  chapterEntities?: readonly string[]
}

/** One post-process run freezes one model and one budget across notes/cards. */
export class RunFinalizePostProcessCommand extends BaseWorkflowCommand<PostProcessStatus> {
  constructor(
    private readonly params: RunFinalizePostProcessParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<PostProcessStatus> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<PostProcessStatus> {
    const projectSession = requireWorkflowProjectSession(context)
    const finalizedSource = await ipc.invokeWithProjectSession(
      projectSession,
      'db:continuity-read-source',
      this.params.draftId,
      this.params.project.path,
    )
    const frozen = finalizedSource.status === 'valid' ? finalizedSource.snapshot : null
    if (
      !frozen
      || frozen.source.draftId !== this.params.finalizedSource.draftId
      || frozen.source.finalizationId !== this.params.finalizedSource.finalizationId
      || frozen.source.chapterNumber !== this.params.finalizedSource.chapterNumber
      || frozen.source.contentHash !== this.params.finalizedSource.contentHash
    ) {
      throw new Error(workflowUiText(
        context,
        '定稿正文来源收据已失效，后处理未启动',
        'The finalized manuscript source receipt is stale, so post-processing was not started.',
      ))
    }
    const generation: FinalizePostProcessGeneration = {
      complete: async (builder, stepCallbacks, output, generationContext) => this.callLLM(
        builder.build(),
        builder.getSystemRole(),
        output === 'structured-data'
          ? { ...stepCallbacks, appendText: () => undefined }
          : stepCallbacks,
        {
          ...(output === 'structured-data' ? { responseFormat: { type: 'json_object' } } : {}),
          purpose: 'post-process',
          reasoningStage: 'review',
        },
        generationContext,
      ),
    }
    const allSteps = buildFinalizePostProcessSteps(
      this.params.project,
      this.params.chapterNumber,
      this.params.chapterTitle,
      frozen.content,
      generation,
      this.params.draftId,
      this.params.chapterEntities,
      workflowUiLocale(context),
      this.params.finalizedSource,
      frozen.projectionGeneration,
    )
    const steps = this.params.stepKey
      ? allSteps.filter(step => step.key === this.params.stepKey)
      : allSteps
    if (this.params.stepKey && steps.length === 0) {
      throw new Error(workflowUiText(
        context,
        `未知的后处理步骤：${this.params.stepKey}`,
        `Unknown post-processing step: ${this.params.stepKey}`,
      ))
    }
    return runPostProcessPipeline(
      this.params.project.path,
      getChapterFinalizeScope(this.params.chapterNumber),
      this.params.sourceLabel,
      steps,
      callbacks,
      {
        stopOnFailure: this.params.stopOnFailure,
        onlyFailed: this.params.onlyFailed,
        cancellation: context,
        projectSession,
      },
    )
  }
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(uiText('未打开项目', 'No project is open.'))
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error(uiText(
        '项目已切换，已停止对原项目的定稿操作',
        'The project changed, so finalization of the previous project was stopped.',
      ))
    }

    callbacks.log(uiText(
      '\n===== 开始定稿与后处理分析 =====',
      '\n===== Starting finalization and post-processing analysis =====',
    ))

    const snapshot = this.params.snapshot ?? await this.createBatchSnapshot(context, project.path)
    if (snapshot.projectPath !== project.path) {
      throw new Error(uiText(
        '定稿快照属于已切换的项目会话',
        'The finalization snapshot belongs to a project session that is no longer active.',
      ))
    }
    const refinedDraftText = snapshot.content
    if (!refinedDraftText) throw new Error(uiText('没有定稿内容', 'There is no content to finalize.'))

    // SQLite 正文、状态和 publication outbox 由主进程在一个事务内提交。这里绝不
    // 再读取旧数据库正文，也不以 renderer 路径写实体稿。
    this.assertNotCancelled(context)
    const commit = await commitFinalizationSnapshot(snapshot)
    if (!commit.committed || !commit.finalizationId || !commit.contentHash || commit.draftId === undefined) {
      throw new Error(commit.error || uiText(
        '定稿事务未提交',
        'The finalization transaction was not committed.',
      ))
    }

    // 事实已提交就立即通知 reconciliation；即使实体稿或后处理随后失败，也绝不
    // 将数据库定稿回滚为 draft，更不能让旧完成结果覆盖后续编辑。
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: snapshot.tabId,
      chapterNumber: snapshot.chapterNumber,
      chapterTitle: snapshot.chapterTitle,
      projectPath: snapshot.projectPath,
      projectSession: snapshot.projectSession,
      draftId: commit.draftId,
      finalizationId: commit.finalizationId,
      contentHash: commit.contentHash,
      contentRevision: commit.contentRevision ?? snapshot.contentRevision,
      snapshotContent: snapshot.content,
      publicationStatus: commit.publicationStatus ?? 'pending',
      source: this.params.eventSource ?? 'manual',
    })
    if (!commit.success) {
      const publicationError = commit.error || uiText(
        '定稿已提交、实体稿待发布',
        'Finalization was committed, but manuscript publication is still pending.',
      )
      callbacks.log(publicationError)
      throw new Error(publicationError)
    }
    callbacks.log(uiText(
      `定稿内容已提交到 SQLite 并发布实体稿（第${snapshot.chapterNumber}章）`,
      `Finalized content committed to SQLite and published as a manuscript (Chapter ${snapshot.chapterNumber})`,
    ))

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log(uiText(
      '正在启动后台大模型推演系统更新全书状态...',
      'Starting background AI post-processing to update the novel state...',
    ))

    const sourceLabel = uiText(
      `第${snapshot.chapterNumber}章定稿`,
      `Chapter ${snapshot.chapterNumber} finalization`,
    )
    const chapterEntities = this.params.chapterInfo.characters.length > 0
      ? this.params.chapterInfo.characters
      : (await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-get',
          snapshot.chapterNumber,
          project.path,
        ))?.characters ?? []
    const postProcessStatus = await new RunFinalizePostProcessCommand({
      project,
      chapterNumber: snapshot.chapterNumber,
      chapterTitle: snapshot.chapterTitle,
      draftContent: refinedDraftText,
      draftId: commit.draftId,
      finalizedSource: {
        draftId: commit.draftId,
        finalizationId: commit.finalizationId,
        chapterNumber: snapshot.chapterNumber,
        contentHash: commit.contentHash,
      },
      sourceLabel,
      stopOnFailure: this.params.stopOnPostProcessFailure,
      chapterEntities,
    }).execute({ step: {}, context, callbacks })
    this.assertNotCancelled(context)

    if (this.params.stopOnPostProcessFailure) {
      const failedLabels = Object.values(postProcessStatus.steps)
        .filter((step) => !step.ok)
        .map((step) => step.label)
      if (failedLabels.length > 0) {
        throw new Error(uiText(
          `后处理失败，批量创作已停止：${failedLabels.join('、')}`,
          `Post-processing failed, so batch creation was stopped: ${failedLabels.join(', ')}`,
        ))
      }
    }

    callbacks.log(uiText(
      `\n第${snapshot.chapterNumber}章创作全流程彻底完成`,
      `\nChapter ${snapshot.chapterNumber} creation workflow fully completed`,
    ))
    this.assertNotCancelled(context)
    await useProjectStore.getState().refreshFileTree(project.path, undefined, projectSession)
  }

  private async createBatchSnapshot(
    context: WorkflowContext,
    projectPath: string,
  ): Promise<FinalizationSnapshot> {
    const projectSession = requireWorkflowProjectSession(context)
    const dbDraft = await readWorkflowDraftMeta(this.params.draftPath, projectPath, projectSession)
    this.assertNotCancelled(context)
    if (!dbDraft) throw new Error('内部状态流转异常：无法定位待定稿草稿')
    return Object.freeze({
      tabId: `batch:${context.runId}:${dbDraft.id}`,
      projectPath,
      projectSession: Object.freeze({ ...projectSession }),
      draftId: dbDraft.id,
      chapterNumber: this.params.chapterNumber,
      chapterTitle: this.params.chapterInfo.title,
      content: this.params.draftContent,
      contentRevision: 0,
    })
  }
}
