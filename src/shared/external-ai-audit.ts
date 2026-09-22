/**
 * 外部 AI 审计 —— 入口契约、URL 安全规范化与剪贴板文案构造。
 *
 * 为什么放在 shared：
 *  - 主进程（真正调用 shell.openExternal 之前）与渲染进程必须共用同一套 URL 规则。
 *    校验函数只有一份，渲染进程被绕过时主进程仍然守得住。
 *  - 剪贴板文案是纯字符串拼接，与 UI 无关，放这里可以直接写单元测试。
 *
 * 与 model-provider-resources.ts 的区别（那份是「固定 ID 白名单」）：
 * 作者可以自己新建入口、粘贴任意网页版 AI 的链接，所以这里不可能用固定表，
 * 只能退而守「协议 + 主机名」这条底线 —— 拒绝 file: / javascript: 等一切非 http(s) 目标。
 */

/** 一个外部 AI 网页版入口（浏览器收藏夹里的一条）。 */
export interface ExternalAiAuditEntry {
  /** 稳定标识：内置项用固定 key，自定义项用运行时生成的随机 id。 */
  id: string
  /** 显示名（作者可自取）。 */
  name: string
  /** 网页版对话页地址，http/https。 */
  url: string
  /** 是否为软件内置入口。内置项可删除，删除后用「恢复默认」补回。 */
  builtin: boolean
}

/**
 * 出厂默认入口 —— 八个网页版 AI，按每页四个排成两页整齐的 2×2。
 *
 * 分页顺序就是这份数组的顺序：
 *   第一页 = 日常主力（DeepSeek / 豆包 / 通义千问 / Kimi）
 *   第二页 = 其他常用（ChatGPT / Gemini / 文心一言 / 腾讯元宝）
 * 先生的自建入口一律追加在最后，不会顶掉这两页的默认布局。
 *
 * 地址一律用各家官网首页而不是深链：首页会自己跳到对话页，改版后也不容易失效；
 * 作者若觉得哪个地址不顺手，删掉它再自建一条即可。
 */
export const DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES: readonly ExternalAiAuditEntry[] = [
  // ===== 第一页：日常主力 =====
  { id: 'builtin-deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', builtin: true },
  { id: 'builtin-doubao', name: '豆包', url: 'https://www.doubao.com/chat/', builtin: true },
  { id: 'builtin-qwen', name: '通义千问', url: 'https://www.tongyi.com/qianwen/', builtin: true },
  { id: 'builtin-kimi', name: 'Kimi', url: 'https://www.kimi.com/', builtin: true },
  // ===== 第二页：其他常用 =====
  { id: 'builtin-chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', builtin: true },
  { id: 'builtin-gemini', name: 'Gemini', url: 'https://gemini.google.com/', builtin: true },
  { id: 'builtin-wenxin', name: '文心一言', url: 'https://yiyan.baidu.com/', builtin: true },
  { id: 'builtin-yuanbao', name: '腾讯元宝', url: 'https://yuanbao.tencent.com/', builtin: true },
]

/** 每页展示的入口数：2×2 网格，翻页只翻整页，永远不出现半行。 */
export const EXTERNAL_AI_AUDIT_PAGE_SIZE = 4

/**
 * 外部 AI 代劳时可以逐块取舍的材料 —— **审稿与修稿共用一张表**。
 *
 * 两个板块各自只显示自己用到的那几块（见下面的 AUDIT_SECTIONS / REFINE_SECTIONS），
 * 但选择记录共用一份：先生在两处勾过的偏好都记得住，互不打架。
 */
export const EXTERNAL_AI_MATERIAL_SECTIONS = [
  // ---- 审稿用 ----
  'reviewInstructions',
  'chapterContent',
  'finalizedHistory',
  'characterStates',
  'worldBuilding',
  'referencedSettings',
  'authorGuidance',
  'projectConfig',
  'blueprints',
  'chapterGoals',
  'writingSkill',
  // ---- 修稿用 ----
  'refineInstructions',
  'chapterInfo',
  'writingStyle',
  'targetLength',
  'userRefinePrompt',
] as const

export type ExternalAiMaterialSection = typeof EXTERNAL_AI_MATERIAL_SECTIONS[number]

/** 兼容旧名：审稿那边一直这么叫。 */
export type ExternalAiAuditMaterialSection = ExternalAiMaterialSection

/** 一块材料是否参与本次代劳。 */
export type ExternalAiMaterialSelection = Record<ExternalAiMaterialSection, boolean>

/** 兼容旧名。 */
export type ExternalAiAuditMaterialSelection = ExternalAiMaterialSelection

/** 各板块**必带、不给取消**的块：去掉它就不是那件事了。 */
export const EXTERNAL_AI_AUDIT_REQUIRED_SECTIONS: readonly ExternalAiMaterialSection[] = [
  'reviewInstructions',
]
export const EXTERNAL_AI_REFINE_REQUIRED_SECTIONS: readonly ExternalAiMaterialSection[] = [
  'refineInstructions',
]

/** 出厂默认：全部带上。 */
export const EXTERNAL_AI_FULL_SELECTION: ExternalAiMaterialSelection = {
  reviewInstructions: true,
  refineInstructions: true,
  chapterContent: true,
  chapterInfo: true,
  finalizedHistory: true,
  characterStates: true,
  worldBuilding: true,
  referencedSettings: true,
  authorGuidance: true,
  writingStyle: true,
  targetLength: true,
  userRefinePrompt: true,
  projectConfig: true,
  blueprints: true,
  chapterGoals: true,
  writingSkill: true,
}

/** 兼容旧名。 */
export const EXTERNAL_AI_AUDIT_FULL_SELECTION = EXTERNAL_AI_FULL_SELECTION

/** 一个预设：只列出它要改的那几块，其余保持先生当前的选择。 */
export interface ExternalAiMaterialPreset {
  id: string
  label: readonly [string, string]
  selection: Partial<ExternalAiMaterialSelection>
}

/** 审稿板块：清单顺序即面板里的排列顺序（固定项垫底）。 */
export const EXTERNAL_AI_AUDIT_SECTIONS: readonly ExternalAiMaterialSection[] = [
  'chapterContent',
  'finalizedHistory',
  'characterStates',
  'worldBuilding',
  'referencedSettings',
  'authorGuidance',
  'projectConfig',
  'blueprints',
  'chapterGoals',
  'writingSkill',
  'reviewInstructions',
]

/**
 * 审稿预设。
 *
 * 「精简」是**判连贯性最小充分集**：没有前文事实与角色档案，模型只能凭空猜；
 * 其余（世界观、蓝图、项目配置）是加分项，砍掉能省下大头。
 */
export const EXTERNAL_AI_AUDIT_PRESETS: readonly ExternalAiMaterialPreset[] = [
  { id: 'full', label: ['完整', 'Full'], selection: { ...EXTERNAL_AI_FULL_SELECTION } },
  {
    id: 'lean',
    label: ['精简', 'Lean'],
    selection: {
      chapterContent: true,
      finalizedHistory: true,
      characterStates: true,
      worldBuilding: false,
      referencedSettings: false,
      authorGuidance: false,
      projectConfig: false,
      blueprints: false,
      chapterGoals: false,
      writingSkill: false,
    },
  },
  {
    id: 'draft-only',
    label: ['仅正文', 'Draft only'],
    selection: {
      chapterContent: true,
      finalizedHistory: false,
      characterStates: false,
      worldBuilding: false,
      referencedSettings: false,
      authorGuidance: false,
      projectConfig: false,
      blueprints: false,
      chapterGoals: false,
      writingSkill: false,
    },
  },
]

/** 兼容旧名（曾用整份选择做预设）。 */
export const EXTERNAL_AI_AUDIT_LEAN_SELECTION: ExternalAiMaterialSelection = {
  ...EXTERNAL_AI_FULL_SELECTION,
  ...EXTERNAL_AI_AUDIT_PRESETS[1]!.selection,
}
export const EXTERNAL_AI_AUDIT_DRAFT_ONLY_SELECTION: ExternalAiMaterialSelection = {
  ...EXTERNAL_AI_FULL_SELECTION,
  ...EXTERNAL_AI_AUDIT_PRESETS[2]!.selection,
}

/** 修稿板块：清单顺序即面板里的排列顺序（固定项垫底）。 */
export const EXTERNAL_AI_REFINE_SECTIONS: readonly ExternalAiMaterialSection[] = [
  'chapterContent',
  'finalizedHistory',
  'characterStates',
  'chapterInfo',
  'authorGuidance',
  'writingStyle',
  'targetLength',
  'userRefinePrompt',
  'writingSkill',
  'refineInstructions',
]

/**
 * 修稿预设。
 *
 * 「与内置一致」是刻意留的对照档：内置的直接修稿**不喂前文事实与角色状态**
 * （它的摘要变量是空的），只靠正文 + 文风 + 作者要求。先生想比对两边结果时用它。
 * 默认那一档多带前文与角色 —— 网页版 AI 上下文宽裕，改稿最怕改出前后矛盾。
 */
export const EXTERNAL_AI_REFINE_PRESETS: readonly ExternalAiMaterialPreset[] = [
  { id: 'full', label: ['完整', 'Full'], selection: { ...EXTERNAL_AI_FULL_SELECTION } },
  {
    id: 'like-builtin',
    label: ['与内置一致', 'Like built-in'],
    selection: {
      finalizedHistory: false,
      characterStates: false,
      chapterInfo: true,
      authorGuidance: true,
      writingStyle: true,
      targetLength: true,
      userRefinePrompt: true,
      writingSkill: true,
    },
  },
  {
    id: 'prose-only',
    label: ['只改文笔', 'Prose only'],
    selection: {
      finalizedHistory: false,
      characterStates: false,
      chapterInfo: false,
      authorGuidance: false,
      writingStyle: true,
      targetLength: true,
      userRefinePrompt: true,
      writingSkill: true,
    },
  },
]

/** 把存档／界面上的勾选洗成一份合法选择：缺项按出厂默认，必带项强制打开。 */
export function normalizeExternalAiAuditMaterialSelection(
  raw: unknown,
): ExternalAiMaterialSelection {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const selection = { ...EXTERNAL_AI_FULL_SELECTION }
  for (const section of EXTERNAL_AI_MATERIAL_SECTIONS) {
    if (typeof record[section] === 'boolean') selection[section] = record[section] as boolean
  }
  for (const required of [
    ...EXTERNAL_AI_AUDIT_REQUIRED_SECTIONS,
    ...EXTERNAL_AI_REFINE_REQUIRED_SECTIONS,
  ]) selection[required] = true
  return selection
}

/**
 * 材料怎么交到网页版 AI 手里。
 *
 *  - `inline`：一整段文本，作者 Ctrl+V 粘贴（默认，最省事）。
 *  - `files`：每块各写成一份 .md，主进程把它们放进系统剪贴板的「文件列表」；
 *    作者在输入框里 Ctrl+V，浏览器会当成「粘贴了这几个文件」→ 直接上传。
 *    先生实测过这条路可行（从资源管理器复制文件、粘贴到网页能触发上传）。
 */
export type ExternalAiAuditDelivery = 'inline' | 'files'

export function isExternalAiAuditDelivery(value: unknown): value is ExternalAiAuditDelivery {
  return value === 'inline' || value === 'files'
}

/**
 * 材料块在界面与文件上的名字 —— **唯一来源**。
 *
 * 界面（材料子菜单）与装配层（写 .md 的文件名）都读这一份，免得两边各写一套
 * 慢慢走偏；字数统计也靠它对齐（界面上「本章正文 3,240 字」要能对上装配结果）。
 *
 * 文件名带序号是刻意的：这些 .md 会被一起粘进网页对话，序号决定它们在对方
 * 文件列表里的先后 —— 审稿要求在最前，材料按重要性依次跟上。
 */
export const EXTERNAL_AI_MATERIAL_SECTION_LABELS: Record<
  ExternalAiMaterialSection,
  { readonly zh: string; readonly en: string; readonly fileName: string }
> = {
  // 审稿
  reviewInstructions: { zh: '审稿要求', en: 'Review instructions', fileName: '00-审稿要求' },
  writingSkill: { zh: '写作 Skill', en: 'Writing skill', fileName: '01-写作Skill' },
  chapterContent: { zh: '本章正文', en: 'Chapter draft', fileName: '02-本章正文' },
  finalizedHistory: { zh: '已定稿剧情事实', en: 'Finalized plot facts', fileName: '03-已定稿剧情事实' },
  characterStates: { zh: '角色状态', en: 'Character states', fileName: '04-角色状态' },
  worldBuilding: { zh: '世界观总纲', en: 'World building', fileName: '05-世界观总纲' },
  referencedSettings: { zh: '本章引用设定', en: 'Referenced settings', fileName: '06-本章引用设定' },
  authorGuidance: { zh: '作者创作指导', en: 'Author guidance', fileName: '07-作者创作指导' },
  projectConfig: { zh: '项目配置', en: 'Project configuration', fileName: '08-项目配置' },
  blueprints: { zh: '蓝图与计划', en: 'Blueprints', fileName: '09-蓝图与计划' },
  chapterGoals: { zh: '本章目标清单', en: 'Chapter goals', fileName: '10-本章目标清单' },
  // 修稿
  refineInstructions: { zh: '修稿要求', en: 'Revision instructions', fileName: '00-修稿要求' },
  chapterInfo: { zh: '本章信息', en: 'Chapter info', fileName: '11-本章信息' },
  writingStyle: { zh: '文风要求', en: 'Writing style', fileName: '12-文风要求' },
  targetLength: { zh: '目标字数', en: 'Target length', fileName: '13-目标字数' },
  userRefinePrompt: { zh: '作者修稿指示', en: 'Author revision notes', fileName: '14-作者修稿指示' },
}

/** 兼容旧名。 */
export const EXTERNAL_AI_AUDIT_SECTION_LABELS = EXTERNAL_AI_MATERIAL_SECTION_LABELS

/** 审稿要求那份文件的基名（文件投递时它永远排在最前）。 */
export const EXTERNAL_AI_AUDIT_INSTRUCTIONS_FILE = EXTERNAL_AI_AUDIT_SECTION_LABELS.reviewInstructions.fileName


/** 单个入口名的长度上限（防止一条超长名字把网格撑破）。 */
export const EXTERNAL_AI_AUDIT_NAME_MAX = 24

/** URL 长度上限：足够长的查询串也放得下，同时挡住异常膨胀的输入。 */
const URL_MAX_LENGTH = 2048

/**
 * 把作者输入（或历史存档）里的地址规范化成一个**可以安全交给系统浏览器**的 URL。
 *
 * 返回 null 表示拒绝。拒绝规则刻意保守：只有 http / https、且必须带主机名。
 * 这样 file://、javascript:、ms-msdt: 这类能触发本机行为的协议一律进不来。
 */
export function normalizeExternalAiUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > URL_MAX_LENGTH) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    // 作者常常只粘「chat.deepseek.com」这种不带协议的一段，这里补 https 再试一次。
    try {
      parsed = new URL(`https://${trimmed}`)
    } catch {
      return null
    }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null

  return parsed.toString()
}

/** 入口名清洗：去掉首尾空白、压掉换行，并截到长度上限。 */
export function normalizeExternalAiAuditName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, EXTERNAL_AI_AUDIT_NAME_MAX)
}

/**
 * 由入口地址推出它的站点图标地址 —— 「默认读取网页的 logo」就靠这里。
 *
 * 为什么不向站点自己要 /favicon.ico：实测这条路基本失效 ——
 *   chat.deepseek.com/favicon.ico → 200，但 Content-Type 是 text/html（返回的是 SPA 首页）
 *   www.doubao.com/favicon.ico    → 同上，292 KB 的 HTML
 *   www.tongyi.com/favicon.ico    → 404
 * `<img>` 拿到 HTML 会解码失败，四个默认入口里三个只能退回首字母块。
 * 因此改用专门的图标服务 favicon.im（国内可直连，实测四个域名都返回 image/png）。
 *
 * 代价是把「作者收藏了哪些站点」这个域名告诉了该服务；对网页版 AI 这类公开站点
 * 无隐私顾虑，换来的是收藏夹里每个入口都能显示真实 logo。
 * 拿不到图标时由 UI 回退成首字母色块，不引第二家服务兜底。
 */
export function faviconUrlFor(url: string): string | null {
  const normalized = normalizeExternalAiUrl(url)
  if (!normalized) return null
  try {
    const hostname = new URL(normalized).hostname
    if (!hostname) return null
    return `https://favicon.im/${hostname}`
  } catch {
    return null
  }
}

/** 生成自定义入口的 id。不用 crypto.randomUUID，避免老渲染进程里缺失导致新建失败。 */
export function createExternalAiAuditEntryId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把任意存档数据洗成一份可用的入口列表。
 *
 * 这是「读取历史数据」的唯一入口：坏数据（手改过的 localStorage、旧版本遗留）
 * 一律丢弃而不是让界面崩掉；内置项去重后按默认顺序排在前面，自定义项保持作者顺序。
 */
export function normalizeExternalAiAuditEntries(raw: unknown): ExternalAiAuditEntry[] {
  if (!Array.isArray(raw)) return [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES]

  const seen = new Set<string>()
  const builtinById = new Map(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.map(entry => [entry.id, entry]))
  const builtins: ExternalAiAuditEntry[] = []
  const customs: ExternalAiAuditEntry[] = []

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id || seen.has(id)) continue

    const builtin = builtinById.get(id)
    const name = normalizeExternalAiAuditName(record.name) || builtin?.name || ''
    const url = normalizeExternalAiUrl(record.url)
    if (!name || !url) continue

    seen.add(id)
    if (builtin) {
      builtins.push({ id, name, url, builtin: true })
    } else {
      customs.push({ id, name, url, builtin: false })
    }
  }

  // 内置项按出厂顺序摆正，缺谁补谁 —— 作者删掉的内置项不在这里复活，
  // 因为「删掉」是他的明确意图；补回默认由「恢复默认」按钮负责。
  const orderedBuiltins = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES
    .map(entry => builtins.find(candidate => candidate.id === entry.id))
    .filter((entry): entry is ExternalAiAuditEntry => !!entry)

  return [...orderedBuiltins, ...customs]
}

// ============================================================
// 剪贴板文案：把装配好的完整审稿提示词包上抬头，交给网页版 AI
// ============================================================

export interface ExternalAiAuditClipboardInput {
  /** 章节标题（没有标题时用「第 N 章」）。 */
  chapterTitle: string
  /** 章节号，用于无标题时的兜底。 */
  chapterNumber?: number
  /**
   * **完整提示词** —— 由 `services/prompts/chapter-review-prompt`（审稿）或
   * `chapter-refine-prompt`（修稿）装配，与软件内置那一步发给模型的材料同源。
   *
   * 这里**不再自编一份要求**：先生指出过，只带正文根本不叫一致性审稿 ——
   * 上下文缺席时，任何自编的「请检查连贯性」都补不回来。
   */
  prompt: string
  /** 语言：决定抬头用中文还是英文写给对方模型看。 */
  locale?: 'zh-CN' | 'en-US'
  /** 这次请对方干什么：给审稿报告，还是给改好的正文。只影响抬头那两句话。 */
  intent?: 'review' | 'refine'
}

/**
 * 给完整提示词包一层抬头。
 *
 * 抬头只说两件事：这是给谁的审稿请求、里面都带了什么材料。
 * 真正的审查原则、检查维度、输出合同全在提示词里 —— 那是与内置审稿同一份文本，
 * 所以网页版 AI 拿到的判断口径与软件内置审稿完全对齐。
 */
export function buildExternalAiAuditClipboardText(input: ExternalAiAuditClipboardInput): string {
  const locale = input.locale ?? 'zh-CN'
  const title = input.chapterTitle.trim()
    || (input.chapterNumber === undefined
      ? (locale === 'en-US' ? 'Untitled chapter' : '未命名章节')
      : (locale === 'en-US' ? `Chapter ${input.chapterNumber}` : `第 ${input.chapterNumber} 章`))
  const body = input.prompt.trim()
  const refine = input.intent === 'refine'

  if (locale === 'en-US') {
    return [
      refine ? `[Revision request: ${title}]` : `[Review request: ${title}]`,
      refine
        ? '(Exported from AI Novel Writer. The material below is the same set the app sends to its own revision model — chapter draft, chapter info, author guidance, style, target length, the author writing skill, and the full revision instructions. Follow the instructions at the end and return the revised chapter.)'
        : '(Exported from AI Novel Writer. The material below is the same set the app sends to its own review model — chapter draft, finalized plot facts, character states, world-building, blueprints, the author writing skill, and the full review instructions. Follow the instructions at the end.)',
      '',
      body,
    ].join('\n')
  }

  return [
    refine ? `【请修稿：${title}】` : `【请审稿：${title}】`,
    refine
      ? '（以下由 AI 小说作家导出，与软件内置修稿用的是同一份材料：本章正文、本章信息、作者写作指导、文风、目标字数、写作 Skill，以及完整的修稿要求。请按文末要求改好正文并交回。）'
      : '（以下由 AI 小说作家导出，与软件内置审稿用的是同一份材料：本章正文、已定稿剧情事实、角色状态、世界观设定、章节蓝图、写作 Skill，以及完整的审稿要求。请按文末要求输出审稿报告。）',
    '',
    body,
  ].join('\n')
}
