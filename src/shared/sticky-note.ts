/**
 * 便利贴 —— 作者私有的灵感本子。
 *
 * ── 与其它数据的分界线（先生 2026-09-20 定，这是铁律）──────────────────────
 * 便利贴**绝不参与 AI 创作工作流**：写稿、定稿、审稿、助手上下文，一处都不读它。
 * 它只属于作者本人 —— 是本子，不是资料库。
 *
 * 因此它也**不需要**世界观设定那套「候选 / 确认」闸门：便利贴里的东西本就是
 * 作者自己写、自己留的，不存在「未确认的事实」这种身份要防。
 *
 * 它和草稿、正文同属**项目数据**（跟着书走），随项目库一起迁移、一起删除；
 * 但「清除项目生成内容」不得波及它 —— 那是先生手写的，只清 AI 生成物。
 *
 * ── 三张表对应三段生命周期 ──────────────────────────────────────────────
 *   sticky_notes       便利贴本体（正文 = 点子按次序追加累积）
 *   sticky_candidates  待选箱（抽卡落选的点子，可找回）
 *   sticky_draws       一次抽卡的输入存档 —— 先生过两周打开待选箱，会想知道
 *                      「这张卡当初是在什么前提下抽出来的」，只有这张表答得上来
 */

/** 单条点子的硬上限（字）。先生定的 500，写进提示词合同并在解析器兜底截断。 */
export const STICKY_IDEA_MAX_CHARS = 500

/** 一次抽卡最多出几张。先生定的 10。 */
export const STICKY_DRAW_MAX_COUNT = 10

/** 抽卡数目的默认值。 */
export const STICKY_DRAW_DEFAULT_COUNT = 1

/** 便利贴标题的展示上限，防止侧栏被一个超长标题撑破。 */
export const STICKY_TITLE_MAX_CHARS = 60

/**
 * 引用来源。
 *
 * 先生 2026-09-20：「现在只支持引用角色、设定集、章节蓝图，还加一个 ——
 * 引用具体的草稿、具体的正文；然后其他不能引用的内容，就不出现在这个 @ 菜单中。」
 *
 * 所以就是这五类。故事架构 / 知识库 / 当前章节 / 项目文件四类**不出现在便利贴的
 * @ 菜单里**（由 InspirationDrawDialog 的 allowedTypes 限定），也就不会成为引用。
 */
export interface StickyMentionRef {
  type: 'character' | 'world-setting' | 'blueprint' | 'draft' | 'manuscript'
  /** 条目显示名：角色名 / 设定条目名 / 「第12章 雨夜」 */
  name: string
  /**
   * 稳定身份。
   *
   * 草稿与正文靠它定位到具体那一稿（草稿 id）—— 光凭显示名找内容太脆：
   * 同一个章节可以有好几稿，章节标题也会被作者随手改。
   */
  value?: string
}

/**
 * 便利贴文件夹。
 *
 * 先生（2026-09-20）：「新建文件夹，用户可以把便利贴拖入文件夹中存储，
 * 防止后期便利贴太多难以管理。」
 *
 * 只做一层 —— 侧栏本来就二百多像素宽，套两层反而是折磨。
 * 文件夹是**收纳工具**，不是容器：删掉文件夹时里面的便利贴回到根下，
 * 绝不跟着一起消失。
 */
export interface StickyFolder {
  folderId: string
  /** 空串 = 未命名，界面显示本地化的「未命名文件夹」 */
  name: string
  createdAt: string
}

/** 便利贴本体。 */
export interface StickyNote {
  noteId: string
  /** 空串 = 未命名，由界面显示本地化的「未命名便利贴」 */
  title: string
  /** Markdown 正文，由点子按追加次序累积而成 */
  body: string
  /** 所属文件夹；null = 直接放在便利贴根下 */
  folderId: string | null
  createdAt: string
  updatedAt: string
}

/** 一次抽卡的输入存档。 */
export interface StickyDraw {
  drawId: string
  /** 四个架构文件是否参与这次抽卡 */
  includePremise: boolean
  includeCharacters: boolean
  includeWorldbuilding: boolean
  includeSynopsis: boolean
  /** @ 引用到的条目 */
  mentions: StickyMentionRef[]
  /** 作者自己敲的构思想法 */
  idea: string
  /** 作者当时要了几张 */
  requestedCount: number
  createdAt: string
}

/** 抽卡时作者勾选的参与项 + 自述想法，仓库据此落一条 sticky_draws。 */
export interface StickyDrawRecordRequest {
  includePremise: boolean
  includeCharacters: boolean
  includeWorldbuilding: boolean
  includeSynopsis: boolean
  mentions: StickyMentionRef[]
  idea: string
  requestedCount: number
}

export type StickyCandidateStatus = 'pending' | 'used'

/** 待选箱里的一条落选点子。 */
export interface StickyCandidate {
  candidateId: string
  /** 来自哪次抽卡 —— 找回时据此还原来源行 */
  drawId: string
  content: string
  /** 它在那次抽卡结果里的左右次序，1 起；找回与追溯都按它排 */
  ordinal: number
  status: StickyCandidateStatus
  /** 被用在哪张便利贴上；仍在箱里时为 null */
  noteId: string | null
  createdAt: string
  usedAt: string | null
}

/**
 * 追加一段点子正文时给仓库的结构化来源。
 *
 * 来源**行**由仓库统一渲染（见 `stickyIdeaSourceLine`），不让各调用点各写一份格式 ——
 * 否则抽屉、卡片、编辑器三处会慢慢写出三种样子。
 */
export interface StickyIdeaAppendRequest {
  /** 点子正文；超长由仓库按 STICKY_IDEA_MAX_CHARS 截断兜底 */
  idea: string
  /** 来自哪次抽卡；手写追加时为 null */
  drawId: string | null
  mentions: StickyMentionRef[]
  /** 追加时刻（ISO 字符串）；缺省取当前时间，由调用方传入便于测试 */
  at?: string
}

/**
 * 渲染一条点子的来源行。
 *
 * 先生的批准条件（2026-09-20）：「极轻的来源标注，否则过两周自己也认不出
 * 哪段是哪次抽的」。所以它有且只有三小段：时刻、引用项，中间用「·」分隔；
 * 引用为空时只剩时刻。视觉上是发丝灰的极小字，不许抢正文。
 *
 * 形如：`—— 灵感 · 09-20 14:30 · 顾舟 / 势力 / 第12章 雨夜`
 */
export function stickyIdeaSourceLine(input: {
  at: string
  mentions: readonly StickyMentionRef[]
}): string {
  const stamp = stickyTimestamp(input.at)
  const names = input.mentions.map(mention => mention.name.trim()).filter(Boolean)
  return names.length > 0
    ? `—— 灵感 · ${stamp} · ${names.join(' / ')}`
    : `—— 灵感 · ${stamp}`
}

/**
 * 把 ISO 时刻压成 `MM-DD HH:mm`。
 *
 * 来源行是给人认的，不是给机器读的；年份写进去只会让这行变长。
 * 解析不出来时原样回落，绝不因此抛错 —— 来源行不该让一次追加失败。
 */
function stickyTimestamp(at: string): string {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return at
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/**
 * 把一条点子按硬上限裁剪。
 *
 * 提示词里已经把 500 字写成硬上限，这里是**第二道兜底**：模型偶尔会超，
 * 而超出来的那截如果直接落盘，先生看到的第一条点子就可能有 1200 字。
 * 只在真正超限时才动手，且补一个省略号让作者看得出被剪过 —— 绝不静默截断。
 */
export function clampStickyIdea(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= STICKY_IDEA_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, STICKY_IDEA_MAX_CHARS - 1)}…`
}

/** 把一条点子与它的来源行拼成要追加进正文的 Markdown 段落。 */
export function composeStickyIdeaBlock(input: {
  idea: string
  at: string
  mentions: readonly StickyMentionRef[]
}): string {
  const idea = clampStickyIdea(input.idea)
  if (!idea) return ''
  return `${stickyIdeaSourceLine({ at: input.at, mentions: input.mentions })}\n\n${idea}`
}

/**
 * 把新段落追加到正文末尾。
 *
 * 段落之间恒空一行，且**只**在正文非空时补前导分隔 —— 首条点子前面不留空行，
 * 否则便利贴一打开顶部就是一截空白。
 */
export function appendStickyBlock(body: string, block: string): string {
  const base = body.replace(/\s+$/u, '')
  if (!block) return base
  return base ? `${base}\n\n${block}` : block
}

/**
 * 把新段落合并进**作者手里那份还没保存的正文**。
 *
 * 先生（2026-09-20）：「如果便利贴中本来有内容，那加入的内容会自然分段地加入在原本内容中。」
 * 所以一律走 appendStickyBlock —— 段落之间恒空一行、首段不留空行。
 *
 * 抽到点子、或从待选箱找回之后，都用它把新内容接到作者当前编辑的内容后面。
 * 作者手里有未保存改动时，要保护的是**他的字**，而不是「那就不给他看新内容」——
 * 早先正是后者，先生看到的就是「AI 生成的没加进我打开的便利贴」。
 */
export function mergeStickyAppendedBlocks(
  current: string,
  appendedBlocks: readonly string[],
): string {
  return appendedBlocks.reduce((body, block) => appendStickyBlock(body, block), current)
}

/**
 * 便利贴标签页的伪协议路径。
 *
 * 它不指向任何文件也不指向 vela 后端，只借 `vela://` 这个壳做**标签身份**：
 * editor-store 按 `filePath + type + projectKey` 去重，同一个 noteId 在
 * 两本书里就自然分成了两个标签。
 */
export const STICKY_TAB_PATH_PREFIX = 'vela://sticky/'

export function stickyTabPath(noteId: string): string {
  return `${STICKY_TAB_PATH_PREFIX}${noteId}`
}

/** 从标签路径还原便利贴身份；不是便利贴标签时返回 null。 */
export function stickyNoteIdFromTabPath(filePath: string | undefined): string | null {
  if (!filePath || !filePath.startsWith(STICKY_TAB_PATH_PREFIX)) return null
  const noteId = filePath.slice(STICKY_TAB_PATH_PREFIX.length).trim()
  return noteId || null
}
