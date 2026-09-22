/**
 * 栏目元数据表 —— v3「时尚杂志」的栏目身份（编号 / 名称 / 颜色 / 定位句）。
 *
 * ── 这张表现在驱动什么 ──────────────────────────────────────────────────────
 * 先生 2026-09-16 的定调（原话）：
 *   「我觉得你倒不如把你这个开篇动画弄成对应栏目的背景，因为现在这个动画太慢，
 *     会让用户觉得卡顿。」
 *
 * 于是栏目身份从「每次切栏目糊 1.4 秒的整幅过场」改成**常驻的背景**：
 *   · 编辑区底色随当前栏目的颜色变化（`--mag-sec` 7% 混纸）
 *   · 右下角一枚出血的巨号编号水印（章节编号，`attr(data-sec-no)`）
 *   · 左缘一道 4px 通高色带
 *   · 切换时只有约 200ms 的底色过渡 + 300ms 的一次扫线 —— 眼睛不等待
 * 换句话说：**栏目色不再是「来一下就走」的动画，而是版面上一直在的底色。**
 *
 * ── 为什么这张表不放在组件里 ────────────────────────────────────────────────
 * 「栏目 → 编号 / 名称 / 颜色」是**编辑设定**，不是渲染细节。
 * 它同时被三处消费：栏目背景、书脊索引块（nth-child 顺序）、以及将来的
 * 刊头彩带定位标。集中成一张表，才不会三处各写一份而慢慢漂移。
 *
 * ── 与书脊的顺序契约 ────────────────────────────────────────────────────────
 * SECTION_ORDER 的顺序**必须**与 `SpineNav.tsx` 的 mainItems 顺序一致：
 * 书脊的 `nth-child(n)` 编号与 `--mag-sec-n` 色标就是照这个顺序硬编码的
 * （见 mag-shell.css「栏目索引带」一节，及 mag-palette.css 的七色栏目色标）。
 * 顺序若在这里被改动而不动书脊，编号与颜色就会错位 —— 契约测试会拦住它。
 */
/**
 * 栏目键。
 *
 * 与 `components/layout/v2/rail-routing.ts` 的 `RailKey` 是**同一个联合类型**：
 * 那里现在直接复用了本类型（`export type RailKey = SectionKey`），
 * 避免「书脊能点的栏目」与「有开篇页的栏目」两份定义各自漂移。
 */
export type SectionKey =
  | 'home'
  | 'project'
  | 'characters'
  | 'world'
  | 'plot-tree'
  | 'blueprint'
  | 'knowledge'

export interface SectionMeta {
  key: SectionKey
  /** 刊内编号：01–07。零填充的两位字符串，直接当排版内容用 */
  no: string
  /** 中文栏目名（与书脊完全一致，不许另起名字） */
  zh: string
  /** 英文栏目名（与书脊完全一致；开篇页以花体签名排出） */
  en: string
  /** 栏目定位句：开篇页标题下方的那行小字 */
  zhLede: string
  enLede: string
  /** 栏目色标序号 1–7，对应 mag-palette.css 的 --mag-sec-N */
  mark: 1 | 2 | 3 | 4 | 5 | 6 | 7
}

/**
 * 栏目顺序 = 刊内编号顺序 = 书脊从上到下的顺序 = 七色色标的分配顺序。
 * 任务 / 日志 / 模型 / 设置属于工具区，不占彩色、不设开篇页 —— 它们不是栏目。
 */
export const SECTION_ORDER: readonly SectionKey[] = [
  'home',
  'project',
  'characters',
  'world',
  'plot-tree',
  'blueprint',
  'knowledge',
] as const

export const SECTIONS: Record<SectionKey, SectionMeta> = {
  home: {
    key: 'home',
    no: '01',
    zh: '书架',
    en: 'Shelf',
    zhLede: '全部作品，与最近翻动过的那一本',
    enLede: 'Every book on the shelf, and the one still warm',
    mark: 1,
  },
  project: {
    key: 'project',
    no: '02',
    zh: '目录',
    en: 'Contents',
    zhLede: '每一章的次序，与尚未落定的那一稿',
    enLede: 'The order of chapters, and the draft still open',
    mark: 2,
  },
  characters: {
    key: 'characters',
    no: '03',
    zh: '人物',
    en: 'Cast',
    zhLede: '档案、关系，以及他们彼此没说出口的部分',
    enLede: 'Dossiers, relations, and what they never say',
    mark: 3,
  },
  world: {
    key: 'world',
    no: '04',
    zh: '设定',
    en: 'World',
    zhLede: '世界的规则：地理、势力，与代价',
    enLede: 'The rules of the world: places, powers, prices',
    mark: 4,
  },
  'plot-tree': {
    key: 'plot-tree',
    no: '05',
    zh: '伏笔',
    en: 'Threads',
    zhLede: '埋下的线，与尚未收回的答案',
    enLede: 'Threads planted, answers still owed',
    mark: 5,
  },
  blueprint: {
    key: 'blueprint',
    no: '06',
    zh: '蓝图',
    en: 'Blueprint',
    zhLede: '每一章的骨架，落笔之前的意图',
    enLede: 'The skeleton of each chapter, intent before ink',
    mark: 6,
  },
  knowledge: {
    key: 'knowledge',
    no: '07',
    zh: '知识库',
    en: 'Library',
    zhLede: '随手可查的资料，与经得起追究的出处',
    enLede: 'Reference at hand, evidence kept',
    mark: 7,
  },
}

/** 本期栏目总数 —— 眉标里的「SECTION 03 / 07」用它。 */
export const SECTION_COUNT = SECTION_ORDER.length

/**
 * 切栏目那次「扫线」的存续时长（毫秒）。
 *
 * 300ms 的扫线 + 120ms 余量。必须与 mag-backdrop.css 里 `mag-sweep` 动画的
 * duration 一致：CSS 管视觉，React 只管到点摘节点。改时长两边一起改。
 *
 * 先生 2026-09-16：「这个动画太慢，会让用户觉得卡顿」——
 * 原来是 1440ms 的整幅过场，现在整幅取消，只留这一道 300ms 的横向扫线。
 */
export const SECTION_SWEEP_MS = 420

/** 取栏目元数据；键永远来自 SECTION_ORDER，因此不会落空。 */
export function sectionMeta(key: SectionKey): SectionMeta {
  return SECTIONS[key]
}

/**
 * 书脊当前高亮项 → 栏目元数据；工具区（任务 / 日志 / 模型 / 设置）返回 null。
 *
 * 栏目背景靠它决定「现在用什么颜色」。工具区不是栏目，不给颜色 ——
 * 彩色只标记「创作的位置」，这是一以贯之的一条纪律。
 */
export function sectionForRail(rail: string): SectionMeta | null {
  return Object.hasOwn(SECTIONS, rail) ? SECTIONS[rail as SectionKey] : null
}

/**
 * 作者开了「减少动效」时，整幅过场页直接不播。
 *
 * 理由：开篇页的价值全在那一拍动画节奏上；把动画砍掉只剩一张静态封面，
 * 反而成了每次切栏目都要多等一秒的阻碍。无障碍偏好面前，装饰让路。
 *
 * 本函数只服务于渲染端（组件首帧即判定），因此可以安全地读 window。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  } catch {
    return false
  }
}

/**
 * 这次「切栏目」要不要扫一道线 —— **纯函数，不读任何 store**。
 *
 * 三个条件缺一不可：
 *   1. 是给 v3 播的（由调用方用 isMagazine 判过，这里只收结果）
 *   2. 正文栏真的会换页：还没打开作品时，点栏目只切侧栏，正文栏留在书架，
 *      此时扫线会与眼前的书架错位，不扫
 *   3. 不是「同一个按钮的第二次点击」：那种点击的语义是折叠 / 展开侧栏
 *      （layout-store.setSidebarView 的既有行为），不是切栏目，不扫
 *
 * 抽成纯函数是为了让契约测试能直接验这三条，而不必去戳组件或 store。
 */
export function shouldPlaySectionSweep(input: {
  magazine: boolean
  hasProject: boolean
  sameButton: boolean
}): boolean {
  if (!input.magazine) return false
  if (!input.hasProject) return false
  if (input.sameButton) return false
  return true
}

