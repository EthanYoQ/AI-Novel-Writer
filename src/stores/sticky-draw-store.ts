/**
 * AI 灵感抽卡弹窗的状态。
 *
 * ── 为什么必须单独有个 store ────────────────────────────────────────────────
 * 抽卡是**异步**的，等结果的那几分钟里作者完全可能切到别的面板去看设定。
 * 原先 stage / cards / selected 都放在弹窗组件自己的 useState 里，而弹窗挂在
 * 便利贴编辑器里 —— 一换标签，编辑器连同弹窗一起被卸载，状态当场蒸发：
 * 结果回来时地址已经不存在，牌面不见了，落选的卡也没进待选箱，
 * 一整轮 token 白烧。先生就是这么撞上的。
 *
 * 状态挪到这里之后，弹窗组件只是**视图**：卸载重挂都读同一份状态，
 * 工作流那边 `onComplete` 闭包写进来的结果也一直留着。
 *
 * ── 一条刻意的取舍 ──────────────────────────────────────────────────────────
 * `closeDialog` **不清结果**。先生：「用户切去其他地方，但这个菜单应该是一直
 * 停留在这里等用户的才对。」所以关掉只是把视图收起来，牌面与选中状态原样留着，
 * 再打开还能接着挑。
 */
import { create } from 'zustand'

export type StickyDrawStage = 'setup' | 'drawing' | 'result'

interface StickyDrawUiState {
  /** 弹窗开着没有。跨组件存活 —— 切走再回来它还在。 */
  open: boolean
  stage: StickyDrawStage
  /** 这次抽到的牌面（原始点子文本，按抽到的顺序） */
  cards: string[]
  /** 被选中的牌面下标 */
  selected: Set<number>
  /** 这次抽卡要追加进哪张便利贴；按下「开始抽卡」时定下 */
  targetNoteId: string | null

  openDialog: () => void
  closeDialog: () => void
  /** 开抽：进 drawing 态并记下目标便利贴。 */
  beginDraw: (targetNoteId: string | null) => void
  /** 结果到了：亮牌。默认全选（作者多半都要，想舍掉的再点掉更快）。 */
  showResult: (cards: string[]) => void
  /** 没抽到东西 / 抽卡失败：退回去让作者改改再来。 */
  backToSetup: () => void
  toggleCard: (index: number) => void
  /** 把这一轮的牌面与选中状态收干净（确认落库之后调用）。 */
  clearResult: () => void
}

export const useStickyDrawStore = create<StickyDrawUiState>()((set, get) => ({
  open: false,
  stage: 'setup',
  cards: [],
  selected: new Set<number>(),
  targetNoteId: null,

  openDialog: () => set({ open: true }),

  closeDialog: () => set({ open: false }),

  beginDraw: (targetNoteId) => set({
    open: true,
    stage: 'drawing',
    cards: [],
    selected: new Set<number>(),
    targetNoteId,
  }),

  showResult: (cards) => set({
    open: true,
    stage: 'result',
    cards,
    selected: new Set(cards.map((_, index) => index)),
  }),

  backToSetup: () => set({ open: true, stage: 'setup' }),

  toggleCard: (index) => {
    // Set 是引用类型：必须换一个新的，否则 zustand 认不出变化。
    const next = new Set(get().selected)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    set({ selected: next })
  },

  clearResult: () => set({
    stage: 'setup',
    cards: [],
    selected: new Set<number>(),
    targetNoteId: null,
  }),
}))
