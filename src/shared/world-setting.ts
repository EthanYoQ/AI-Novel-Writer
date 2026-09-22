/**
 * 世界观设定的共享契约（renderer 与主进程共用）。
 *
 * 先生定的方向：**A 结构化条目库**，并且**分类允许作者自建**。
 *
 * 分类的关键设计（先生提醒的「自建分类如何被识别读取」就落在这里）：
 *
 *   · **条目只认 key**（`world_settings.category` 存 key），分类的显示名与说明存在
 *     `world_setting_categories` 表里 —— 作者改个名字、加个分类，都不会动到已有条目；
 *   · 内置分类在首次打开项目时写入表中（`builtin = 1`，不可删），key 就是下面这八个；
 *   · 自建分类的 key 由主进程生成（前缀 `cat_`），与内置 key 永不冲突；
 *   · **每个分类都带一句说明** —— 这不只是给作者看的，更是 AI 生成与定稿归纳时
 *     「这个词该归哪一类」的判据。自建分类也要作者填说明，否则 AI 只能瞎猜。
 *
 * 与既有三处的关系：
 *   · 故事架构的「世界观」文档 —— 总纲 / 导言，生成式的浓缩版；
 *   · 本条目库 —— **事实源（canon）**，作者与 AI 共同维护的明细；
 *   · 知识库 —— 从正文提取的检索素材（RAG），与本库分工不同。
 */

/** 内置分类的 key。作者可在此之外自建分类。 */
export const WORLD_SETTING_CATEGORIES = [
  'world',      // 世界观总则
  'faction',    // 势力
  'geography',  // 地理
  'history',    // 历史
  'rule',       // 规则（力量体系 / 社会规则）
  'race',       // 种族 · 职业
  'item',       // 物品 · 道具
  'concept',    // 概念 · 专有名词
] as const

/**
 * 条目上的分类键：**内置 key 或作者自建的 key**。
 *
 * 之所以是 string 而不是字面量联合 —— 自建分类在编译期当然不存在。
 * 需要判断「是不是内置」时用 isBuiltinWorldSettingCategory()。
 */
export type WorldSettingCategory = string

export interface WorldSettingCategoryLabels {
  zhCN: string
  enUS: string
}

/** 分类表里的一行：侧栏、下拉、AI 归类判据都读它。 */
export interface WorldSettingCategoryRecord {
  key: string
  zhCN: string
  enUS: string
  /** 这个分类放什么 —— AI 生成与定稿归纳的归类判据。 */
  descriptionZhCN: string
  descriptionEnUS: string
  /** 内置分类不可删除。 */
  builtin: boolean
  sortOrder: number
}

/** 自建分类的 key 前缀：与内置 key 永不冲突，也便于识别来源。 */
export const CUSTOM_CATEGORY_KEY_PREFIX = 'cat_'

export function isBuiltinWorldSettingCategory(key: unknown): boolean {
  return typeof key === 'string' && (WORLD_SETTING_CATEGORIES as readonly string[]).includes(key)
}

/** 内置分类的默认文案与说明：初始化分类表时用，也是查不到分类时的兜底。 */
const BUILTIN_CATEGORY_META: Readonly<Record<string, {
  labels: WorldSettingCategoryLabels
  descriptions: WorldSettingCategoryLabels
}>> = {
  world: {
    labels: { zhCN: '世界观', enUS: 'World' },
    descriptions: { zhCN: '世界的底层规则：时代、形态、常识与禁忌', enUS: 'Ground rules of the world: era, shape, common sense and taboos' },
  },
  faction: {
    labels: { zhCN: '势力', enUS: 'Factions' },
    descriptions: { zhCN: '门派、家族、组织、政权 —— 谁在和谁角力', enUS: 'Sects, families, organizations and powers in play' },
  },
  geography: {
    labels: { zhCN: '地理', enUS: 'Geography' },
    descriptions: { zhCN: '大陆、城池、秘境、要道 —— 故事发生的地方', enUS: 'Continents, cities, secret realms and routes where the story happens' },
  },
  history: {
    labels: { zhCN: '历史', enUS: 'History' },
    descriptions: { zhCN: '纪元、大事、旧怨 —— 今天为什么是这个样子', enUS: 'Eras, events and old grudges that shaped the present' },
  },
  rule: {
    labels: { zhCN: '规则', enUS: 'Rules' },
    descriptions: { zhCN: '力量体系、修行境界、社会律法', enUS: 'Power systems, cultivation tiers and social laws' },
  },
  race: {
    labels: { zhCN: '种族 · 职业', enUS: 'Races & classes' },
    descriptions: { zhCN: '种族、血脉、职业与身份', enUS: 'Races, bloodlines, classes and identities' },
  },
  item: {
    labels: { zhCN: '物品', enUS: 'Items' },
    descriptions: { zhCN: '神器、道具、丹药、材料', enUS: 'Artifacts, tools, pills and materials' },
  },
  concept: {
    labels: { zhCN: '概念', enUS: 'Concepts' },
    descriptions: { zhCN: '专有名词：功法、术语、口号、称谓', enUS: 'Proper nouns: techniques, terms, slogans and titles' },
  },
}

/** 初始化分类表用的八条内置记录（顺序即侧栏顺序）。 */
export function builtinCategoryRecords(): WorldSettingCategoryRecord[] {
  return WORLD_SETTING_CATEGORIES.map((key, index) => {
    const meta = BUILTIN_CATEGORY_META[key]
    return {
      key,
      zhCN: meta.labels.zhCN,
      enUS: meta.labels.enUS,
      descriptionZhCN: meta.descriptions.zhCN,
      descriptionEnUS: meta.descriptions.enUS,
      builtin: true,
      sortOrder: index,
    }
  })
}

/**
 * 查分类的显示名。
 *
 * 第二参数是项目当前的分类表（含自建分类）；不传就只认内置，
 * 两者都查不到时**回退显示 key 本身** —— 分类被删掉时也不会让界面出现空白。
 */
export function getWorldSettingCategoryLabels(
  key: unknown,
  categories?: readonly WorldSettingCategoryRecord[],
): WorldSettingCategoryLabels {
  const normalized = normalizeWorldSettingCategory(key)
  const fromTable = categories?.find(category => category.key === normalized)
  if (fromTable) return { zhCN: fromTable.zhCN, enUS: fromTable.enUS }
  const builtin = BUILTIN_CATEGORY_META[normalized]
  if (builtin) return builtin.labels
  return { zhCN: normalized, enUS: normalized }
}

/** 查分类的说明（AI 归类判据）。回退规则同 labels。 */
export function getWorldSettingCategoryDescription(
  key: unknown,
  categories?: readonly WorldSettingCategoryRecord[],
): WorldSettingCategoryLabels {
  const normalized = normalizeWorldSettingCategory(key)
  const fromTable = categories?.find(category => category.key === normalized)
  if (fromTable) return { zhCN: fromTable.descriptionZhCN, enUS: fromTable.descriptionEnUS }
  const builtin = BUILTIN_CATEGORY_META[normalized]
  if (builtin) return builtin.descriptions
  return { zhCN: '', enUS: '' }
}

/**
 * 条目状态。
 *
 * - `pending`：AI 归纳或作者选词产生、**尚未经作者确认**的候选；
 * - `confirmed`：作者已确认，是事实源。
 *
 * 先生定的闸门：**pending 一律不注入正文生成、也不进助手上下文** ——
 * 否则 AI 自己猜的设定被反过来喂给写稿 AI，猜测会自我强化、越滚越偏。
 * 这条闸门同时保证提示词不膨胀：注入量只随作者确认过的条目增长。
 */
export const WORLD_SETTING_STATUSES = ['confirmed', 'pending'] as const
export type WorldSettingStatus = typeof WORLD_SETTING_STATUSES[number]

export function normalizeWorldSettingStatus(value: unknown): WorldSettingStatus {
  return value === 'pending' ? 'pending' : 'confirmed'
}

/** 重要度：决定条目在提示词里的取舍顺序（主线必带，背景可省）。 */
export const WORLD_SETTING_IMPORTANCE = ['main', 'side', 'background'] as const
export type WorldSettingImportance = typeof WORLD_SETTING_IMPORTANCE[number]

export const WORLD_SETTING_IMPORTANCE_LABELS: Readonly<Record<WorldSettingImportance, WorldSettingCategoryLabels>> = {
  main: { zhCN: '主线', enUS: 'Main' },
  side: { zhCN: '支线', enUS: 'Side' },
  background: { zhCN: '背景', enUS: 'Background' },
}

/** 来源：作者手写 / AI 生成 / 从架构文档拆出，用于追溯与批量清理。 */
export const WORLD_SETTING_SOURCES = ['manual', 'ai', 'architecture'] as const
export type WorldSettingSource = typeof WORLD_SETTING_SOURCES[number]

/** 条目之间的关联（势力—人物、地点—势力…），将来可直接喂给关系图谱。 */
export interface WorldSettingRelation {
  target: string
  relation: string
}

/**
 * 会被 AI 更新、因此需要记录来源的字段。
 *
 * 与人物状态同样的思路：`name` / `category` 是身份与归类，不参与自动更新，
 * 所以不列进来（避免"改个名字整条条目的 provenance 就乱掉"）。
 */
export const WORLD_SETTING_PROVENANCE_FIELDS = [
  'summary',
  'content',
  'aliases',
  'tags',
  'importance',
] as const

export type WorldSettingProvenanceField = typeof WORLD_SETTING_PROVENANCE_FIELDS[number]

/**
 * 字段级来源。做这个是为了让**定稿后的自动更新只追加作者手写过的内容，绝不改写**。
 *
 * - `author`：作者在界面上手写 → **只允许追加，不允许改写**（先生拍板的保护线）；
 * - `derived`：从某一章定稿正文按原文依据自动写入 → 允许被更新的定稿继续覆盖；
 * - `architecture`：从故事架构文档拆出来的，没有具体章节；
 * - `legacy`：provenance 机制上线之前就存在的旧条目，按可更新处理。
 *
 * 与人物状态一致：**只有 derived / legacy 允许被覆盖改写**，author 只追加。
 * —— 注意这条规矩的适用对象是**自动写入**（见 WorldSettingWriteMode）：
 * 作者本人在界面上的保存永远能改写自己的内容，否则「作者写过一次就再也改不动」。
 */
export type WorldSettingFieldProvenance =
  | { kind: 'author' }
  | { kind: 'derived'; chapterNumber: number }
  | { kind: 'architecture' }
  | { kind: 'legacy' }

/** 只保留已知字段里的合法值，脏数据一律丢弃（旧库/手工改库都可能带脏值）。 */
export function normalizeWorldSettingProvenance(  value: unknown,
): Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const result: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>> = {}
  for (const field of WORLD_SETTING_PROVENANCE_FIELDS) {
    const item = record[field]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const kind = (item as { kind?: unknown }).kind
    if (kind === 'author') {
      result[field] = { kind: 'author' }
      continue
    }
    if (kind === 'derived') {
      const chapterNumber = (item as { chapterNumber?: unknown }).chapterNumber
      if (typeof chapterNumber === 'number' && Number.isInteger(chapterNumber) && chapterNumber > 0) {
        result[field] = { kind: 'derived', chapterNumber }
      }
      continue
    }
    if (kind === 'architecture') {
      result[field] = { kind: 'architecture' }
      continue
    }
    if (kind === 'legacy') {
      result[field] = { kind: 'legacy' }
    }
  }
  return result
}

/**
 * 一条「正文与设定打架」的裁决记录。
 *
 * 为什么要有这张表：定稿后 AI 能发现冲突，但**不知道该听哪边** ——
 * 条目写「青云宗已覆灭」、正文写「青云宗派人来援」，自动改等于赌，
 * 赌错就是把作者原本正确的东西改坏。所以 AI 只负责报告，
 * 把裁决留给作者，并且**让冲突出现在作者能一键处理的地方**
 * （而不是让他自己去设定库里一条条翻）。
 *
 * 两个内容快照是刻意冗余的：裁决界面要在**不改动任何东西**的前提下
 * 把「正文说了什么」与「条目原来写什么」并排给作者看。
 */
export type WorldSettingConflictStatus = 'open' | 'resolved' | 'ignored'

export interface WorldSettingConflict {
  id: number
  chapterNumber: number
  settingId: number
  settingName: string
  /** 条目当时的正文快照（作者可能在此之后改过条目，快照才对得上裁决语境）。 */
  settingContentSnapshot: string
  /** 正文里的原句证据。 */
  evidence: string
  /** 一句话说明冲突点。 */
  statement: string
  status: WorldSettingConflictStatus
  /** 作者怎么裁的：采纳正文 / 保留条目原文。 */
  resolution?: 'adopted-draft' | 'kept-entry'
  createdAt: string
  resolvedAt?: string
}

/** 新建冲突记录（裁决状态与 id 由主进程给）。 */
export interface WorldSettingConflictDraft {
  chapterNumber: number
  settingId: number
  settingName: string
  settingContentSnapshot?: string
  evidence: string
  statement: string
}

export interface WorldSettingEntry {
  id: number
  category: WorldSettingCategory
  name: string
  /** 别名 / 别称：检索与 AI 提及匹配时一并命中。 */
  aliases: string[]
  /** 一句话摘要：列表展示 + 注入提示词时优先用它，正文太长不进上下文。 */
  summary: string
  content: string
  tags: string[]
  importance: WorldSettingImportance
  related: WorldSettingRelation[]
  source: WorldSettingSource
  /** 确认状态；pending 不进生成链路。 */
  status: WorldSettingStatus
  /** 字段级来源；缺失表示旧条目（等同于 legacy）。 */
  provenance?: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>>
  createdAt: string
  updatedAt: string
}

/**
 * 本次写入由谁发起 —— 字段级来源保护只对**自动写入**生效。
 *
 * - `author`（默认）：作者在界面上的显式保存。作者的意志高于一切来源标记，
 *   连标了 `author` / `architecture` 的字段也允许改写 —— 这正是「作者在界面上
 *   改不动自己写的条目」那个错的修正（保护线保护的是作者，不该反锁作者）。
 * - `auto`：无人在场的自动写入（定稿后处理、批量回填等）。沿用保护线：
 *   标了 `author` / `architecture` 的字段**只允许追加，不允许覆盖改写**。
 *
 * 自动写入路径**必须显式声明** `auto`；默认值刻意选了「放行」而不是「保护」，
 * 因为漏传的代价不对称：漏传 auto 最多多写一次内容（可改回来），
 * 而漏传 author 会让作者整条条目变成只读（改不动、且看不出原因）。
 */
export type WorldSettingWriteMode = 'author' | 'auto'

/** 新建 / 保存的输入；不带 id 表示新建，带 id 表示更新。 */
export interface WorldSettingDraft {
  id?: number
  category: WorldSettingCategory
  name: string
  aliases?: string[]
  summary?: string
  content?: string
  tags?: string[]
  importance?: WorldSettingImportance
  related?: WorldSettingRelation[]
  source?: WorldSettingSource
  /** 不传视为 confirmed：作者在界面上手写的就是已确认内容。 */
  status?: WorldSettingStatus
  /** 调用方可显式声明字段来源（例如定稿后处理写入 derived）；不传则按作者手写处理。 */
  provenance?: Partial<Record<WorldSettingProvenanceField, WorldSettingFieldProvenance>>
  /**
   * 本次写入是谁发起的；不传按 `author`（界面保存）处理。
   * 自动写入必须传 `auto`，否则会绕过字段级保护改写作者原文。
   */
  writeMode?: WorldSettingWriteMode
}

/**
 * 创建「待确认候选」的结果。
 *
 * 候选创建是**只新增**的存储操作，与 save 的 upsert 语义刻意分开：
 * 名字（按大小写折叠）已经存在时一律拒绝并保留原行，绝不退化成
 * 「默认 author 权限的覆盖式 save」—— 否则模型报出的歧义名字会绕过证据校验，
 * 用虚构引文改写作者已确认的事实源，而且原行仍是 confirmed、待确认队列却一条没多。
 */
export type WorldSettingCandidateResult =
  | { created: true; entry: WorldSettingEntry }
  | {
    created: false
    reason: 'duplicate-name'
    /** 命中的既有行，供调用方如实报告「没写成，因为名字已经属于谁」。 */
    existingId: number
    existingName: string
    existingStatus: WorldSettingStatus
  }
  | { created: false; reason: 'invalid-name' }

/** 新建分类的输入。 */
export interface WorldSettingCategoryDraft {
  zhCN: string
  enUS?: string
  descriptionZhCN?: string
  descriptionEnUS?: string
}

/**
 * 一章引用了哪些设定。
 *
 * 先生定的路线：设定**不做全量注入**，写某一章时只带这张表里指明的条目。
 * `source` 用来区分这次引用是谁提的：作者手动，还是 AI 生成蓝图时自己提出的。
 */
export interface ChapterWorldSettingRef {
  chapterNumber: number
  settingId: number
  source: 'manual' | 'ai'
}

/** 条目名的长度上限：与角色名一致，挡住异常长的脏数据。 */
export const MAX_WORLD_SETTING_NAME_LENGTH = 200
/** 分类名长度上限。 */
export const MAX_CATEGORY_NAME_LENGTH = 40

/**
 * 分类 key 归一。
 *
 * 与条目分类不同，这里**不把未知 key 映射回内置默认** —— 自建分类的 key 当然是
 * 未知的，映射掉就等于把作者的分类吃掉。只做 trim 与空值兜底。
 */
export function normalizeWorldSettingCategory(value: unknown): WorldSettingCategory {
  if (typeof value !== 'string') return 'world'
  const trimmed = value.trim()
  return trimmed || 'world'
}

export function normalizeWorldSettingImportance(value: unknown): WorldSettingImportance {
  if (typeof value === 'string' && (WORLD_SETTING_IMPORTANCE as readonly string[]).includes(value)) {
    return value as WorldSettingImportance
  }
  return 'side'
}

export function normalizeWorldSettingSource(value: unknown): WorldSettingSource {
  if (typeof value === 'string' && (WORLD_SETTING_SOURCES as readonly string[]).includes(value)) {
    return value as WorldSettingSource
  }
  return 'manual'
}

export function getWorldSettingImportanceLabels(value: unknown): WorldSettingCategoryLabels {
  return WORLD_SETTING_IMPORTANCE_LABELS[normalizeWorldSettingImportance(value)]
}
