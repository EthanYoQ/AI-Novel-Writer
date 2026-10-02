/**
 * 正文新角色候选 —— 定稿时从本章正文里发现、但角色名单里还没有的重要具名角色。
 *
 * ── 为什么要有这条通道 ──────────────────────────────────────────────────────
 * `update_character_cards` 那句提示词**早就要求**模型返回 `newCharacters`
 * （「分析并在 newCharacters 中提取本章新出场的重要角色，不要包含路人或已死
 * 无后续影响的龙套」），模型也照做了 —— 可解析器只读 `updates`，另一半输出
 * 被无声丢弃。于是正文里冒出来的新人物既不建档、也没有任何人提醒作者，
 * 那部分 token 白花。
 *
 * 先生 2026-09-21 定的形态：
 *   「定稿时把正文里出现、但名单里没有的重要具名角色存成 pending 候选，
 *     在角色页给个『待确认』入口，一键采纳即建档、忽略即丢弃。」
 *
 * ── 一条不能松的纪律 ────────────────────────────────────────────────────────
 * 候选**只是候选**：它不进任何 AI 链路，也不会自动变成角色卡。建档必须由作者
 * 亲手点 —— 与既有的「新角色不许由正文后处理模型自由创建」完全一致。
 * 模型做的是「提名 + 附上它在本章读到的那点状态」，去留永远在作者手里。
 * 候选里的一切都**出自本章正文**（提示词的原话），没有一处是凭空补的。
 */
import type { CharacterRole } from './character-role'

export const CHARACTER_CANDIDATE_STATUSES = ['pending', 'adopted', 'dismissed'] as const

export type CharacterCandidateStatus = typeof CHARACTER_CANDIDATE_STATUSES[number]

/** 候选原文证据长度上限 —— 它是要念给作者看的一小段，不是正文备份。 */
export const CHARACTER_CANDIDATE_EVIDENCE_MAX_CHARS = 300

/**
 * 候选携带的角色当前状态。
 *
 * ── 为什么候选要带状态 ──────────────────────────────────────────────────────
 * `update_character_cards` 那句提示词**一直**要求 `newCharacters` 的每一项都带上
 * `currentState`（location / powerLevel / physicalState / mentalState / keyItems /
 * recentEvents / updatedAtChapter 七项，与 `updates` 里已有角色的形状完全一致）。
 * 可解析器只读了 name 与 role —— 这一整块被丢掉，于是先生在角色页点「采纳并建档」，
 * 建出来的新档除名字以外一片空白（先生本轮报障：「新档只有名字，里面没有任何内容」）。
 *
 * 提示词已经把这份状态写在返回里了，我们没有花额外的 token 去要它，只是**没接住** ——
 * 这与 `newCharacters` 当初整段没人读是同一类毛病，所以在这里补上。
 *
 * 形状与 `CharacterRosterCharacterState` 的对应字段同形（全部可选），
 * 于是它可以原样落进角色卡的 currentState，不需要任何换算。
 */
export interface CharacterCandidateState {
  location?: string
  powerLevel?: string
  physicalState?: string
  mentalState?: string
  keyItems?: string
  recentEvents?: string
  updatedAtChapter?: number
}

/** 状态里每个文本字段的长度上限 —— 它是「当前状态」，不是人物小传。 */
export const CHARACTER_CANDIDATE_STATE_FIELD_MAX_CHARS = 200

/** 状态里被接住的文本字段；与提示词的 `currentState` 说明逐项对应。 */
export const CHARACTER_CANDIDATE_STATE_TEXT_FIELDS = [
  'location',
  'powerLevel',
  'physicalState',
  'mentalState',
  'keyItems',
  'recentEvents',
] as const

export type CharacterCandidateStateField = typeof CHARACTER_CANDIDATE_STATE_TEXT_FIELDS[number]

/**
 * 把模型给的 `currentState` 收成候选状态。
 *
 * 三条口径：
 *   · 只认那六个文本字段 —— 读不懂的一律丢掉（候选是附加信息，宁可少写也不能写错）；
 *   · 每项截到 `CHARACTER_CANDIDATE_STATE_FIELD_MAX_CHARS`；
 *   · `updatedAtChapter` 以**本地章号**为准：提示词要求模型填 `{{chapter_number}}`，
 *     而这一块描述的就是「这一章的状态」，本地数字比模型的自述可信。
 *     一个字段都没读到就返回 `{}` —— 空状态不该在角色卡里留一个「第 0 章更新」。
 */
export function normalizeCharacterCandidateState(
  value: unknown,
  chapterNumber: number,
): CharacterCandidateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const state: CharacterCandidateState = {}
  for (const field of CHARACTER_CANDIDATE_STATE_TEXT_FIELDS) {
    const text = typeof raw[field] === 'string' ? raw[field].trim() : ''
    if (text) state[field] = text.slice(0, CHARACTER_CANDIDATE_STATE_FIELD_MAX_CHARS)
  }
  if (Object.keys(state).length === 0) return {}
  const chapter = Math.trunc(Number(chapterNumber))
  const declared = Math.trunc(Number(raw.updatedAtChapter))
  state.updatedAtChapter = Number.isSafeInteger(chapter) && chapter > 0
    ? chapter
    : (Number.isSafeInteger(declared) && declared > 0 ? declared : 0)
  return state
}

/** 候选状态里是否真的写着东西（UI 据此决定要不要渲染那一块）。 */
export function hasCharacterCandidateState(value: CharacterCandidateState | undefined): boolean {
  return Boolean(value) && Object.keys(value as CharacterCandidateState).length > 0
}

export interface CharacterCandidateRecord {
  id: number
  /** 候选角色名（模型给出的原文，不做任何改写）。 */
  name: string
  /** 归一后的角色定位；模型给的中文标签在入队时已折算成枚举。 */
  role: CharacterRole
  /** 为什么认为这是重要角色 —— 模型给出的一句依据，供作者判断。 */
  evidence: string
  /** 在第几章的正文里出现的。 */
  chapterNumber: number
  /**
   * 模型为这名新角色给出的当前状态（可能为空 —— 模型没写、或老库升级上来的条目）。
   * 采纳建档时它会被写进角色卡的 currentState。
   */
  currentState: CharacterCandidateState
  status: CharacterCandidateStatus
  createdAt: string
  /** 作者裁决的时刻；未裁决为空串。 */
  decidedAt: string
}

export interface CharacterCandidateInput {
  name: string
  role?: unknown
  evidence?: string
  chapterNumber: number
  /** 模型给的原始 currentState；由 `normalizeCharacterCandidateState` 收口。 */
  currentState?: unknown
}

/** 入队结果：只报「真的新进了几条」，重复的与已在名单里的都不算数。 */
export interface CharacterCandidateEnqueueResult {
  success: boolean
  queued: number
  skipped: number
  error?: string
}
