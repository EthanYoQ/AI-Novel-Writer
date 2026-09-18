/**
 * 段落之间那排空白（段间距），不允许鼠标把光标插进去。
 *
 * 先生（第四次报障）：
 *   「现在鼠标能在正文、草稿阅览的时候，把光标移动到两个段落的中间
 *    （因为我们渲染默认的是两个段落中间会空出两排字的间距），结果导致上下文抖动。
 *     这个段落中间按照道理是不能被鼠标点击，让光标插进去的。」
 *
 * 「抖动」的来历写在 v2-editor.css 的空行规则里：段落之间那个空行只有 1.2em（约 20px），
 * 正文行却有 38px —— 光标一旦落进空行，`.cm-lp-caret-empty` 就把它展开成完整行高，
 * 下方所有内容被整体推下去约 18px。那套「提前展开」是为**打字不位移**服务的
 * （先生第三次报障），前提是「光标落到空行」本身出自作者本意：按 Enter、或用方向键移过去。
 * 而鼠标点在段间距上，作者只想把光标放到段落文字附近，落进空行纯属意外 ——
 * 于是那次展开就成了一次没人要的版面抖动。
 *
 * 修法：**把段间距从鼠标的命中区里摘出去**。不拦 mousedown，而是校正
 * 「屏幕坐标 → 文档位置」这一步：CodeMirror 里所有鼠标定位都要经过
 * `view.posAndSideAtCoords`（单击、拖动选字、双击、三击）与 `view.posAtCoords`
 * （拖放落点、拖放光标），在这两个入口把落在空行上的点吸附到相邻段落的文字上，
 * 单击与拖动就一起正确了 —— 而且不会有「先落进去、再跳出来」的中间态。
 *
 * ⚠️ **但坐标映射只管得住左键**（先生第二次报障：中键与右键漏网）：
 *   `@codemirror/view` 的 mousedown 处理器写着 `if (!style && event.button == 0)`
 *   —— **中键与右键根本不进入选取通道**，插入点是浏览器原生放进 contenteditable 的，
 *   随后被 DOM 观察者同步成一个 `userEvent: "select.pointer"` 的选区事务
 *   （`@codemirror/view` 内部 applyDOMChange 里那段 `view.dispatch({ selection: newSel, userEvent })`）。
 *   这条事务不经过任何坐标映射，坐标补丁拦不到 —— 光标照样插进段间距、版面照样错位。
 *   所以还有第二条防线：**事务过滤器**（`gapCaretTransactionFilter`），
 *   在事务层把「指针来源 ＋ 空选区 ＋ 落点是空白行」的变化拉回原位。
 *
 * 三条自我约束：
 * 1. **只在鼠标交互期间改写坐标**（mousedown → mouseup）。编辑器内部（绘制选区矩形、
 *    滚动定位、提示定位）也走同一个方法，那时一律原样返回。
 * 2. **只在点击确实落在该空行的行块内时吸附**。点在纸页下方的留白（文档之外）
 *    仍按 CodeMirror 的原意落到文末 —— 那是「接着往下写」的入口，不能吃掉。
 * 3. **不碰键盘**。方向键经过空行时依旧会落上去：那是作者主动移动，位移发生在按键那一刻；
 *    更要紧的是 Enter 产生的新段落行本身就是空行，光标必须能停在上面，否则没法接着写字。
 *   （事务过滤器同样只认 `select.pointer`：键盘的 `select`、输入与程序化选区一概不碰。）
 *
 * 配套测试：
 *   · `__tests__/paragraph-gap-caret.test.ts` —— 吸附落点的纯函数（不需要浏览器）
 *   · `__tests__/CodeMirrorEditor-paragraph-gap-click.browser.tsx` —— 真实点击与版面不动
 *   · `__tests__/CodeMirrorEditor-paragraph-gap-middle-right-click.browser.tsx` —— 中键与右键
 */
import { EditorState, Facet, StateEffect, StateField, Transaction, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** 空行 = 视觉上的段间距。判定口径与 v2-editor.css 的 `:has(> br:only-child)`、live-preview 的展开规则一致。 */
function isGapLine(text: string): boolean {
  return text.trim() === ''
}

/** 行首缩进空白：半角空格 / em 空格 / 全角空格 —— 与 live-preview 隐藏缩进用的是同一套字符。 */
const LEADING_BLANK = /^[\s\u2003\u3000]+/

/**
 * 从空行出发，朝指定方向找最近的正文行，返回光标该落的位置：
 *   向上 = 那一段的末尾（`line.to`）；
 *   向下 = 那一段第一个字之前（跳过行首缩进 —— 落在缩进字符之间，光标会离文字一整格）。
 * 该方向没有正文行（例如空行在文档最前/最后）时返回 null，由调用方换方向兜底。
 */
export function resolveParagraphGapAnchor(
  doc: Text,
  gapLineNumber: number,
  upward: boolean,
): number | null {
  if (upward) {
    for (let number = gapLineNumber - 1; number >= 1; number -= 1) {
      const line = doc.line(number)
      if (!isGapLine(line.text)) return line.to
    }
    return null
  }
  for (let number = gapLineNumber + 1; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    if (!isGapLine(line.text)) {
      return line.from + (LEADING_BLANK.exec(line.text)?.[0].length ?? 0)
    }
  }
  return null
}

/**
 * 上下都试：优先作者点击所偏的那一侧，那一侧没有正文时用另一侧。
 * 两侧都没有正文（整篇都是空行）时返回 null —— 那种文档没有可落笔的段落，
 * 光标落到空行上是合理的，交给调用方保留原位置。
 */
export function resolveParagraphGapCaret(
  doc: Text,
  gapLineNumber: number,
  upward: boolean,
): number | null {
  return resolveParagraphGapAnchor(doc, gapLineNumber, upward)
    ?? resolveParagraphGapAnchor(doc, gapLineNumber, !upward)
}

/**
 * 吸附决策本体（纯函数，几何从外部注入，便于单测）：
 * 给定「坐标 → 文档位置」的原始结果与那一行的行块矩形，返回光标最终该待的位置。
 *
 * 下面每一种「拿不准」都原样返回 —— 鼠标是最高频的入口，宁可维持 CodeMirror 的原行为，
 * 也不要在这一层制造意外：
 *   · 落点本来就在正文行上：不是段间距，不碰；
 *   · 拿不到行块矩形：量不出上下，不猜；
 *   · 点击不在该行块范围内（纸页上下方的留白）：那是「落到文首/文末继续写」的入口；
 *   · 上下都找不到正文行（整篇空行）。
 */
export function resolveParagraphGapClick(
  doc: Text,
  pos: number,
  clickY: number,
  lineRect: { top: number; bottom: number } | null,
): number {
  const line = doc.lineAt(pos)
  if (!isGapLine(line.text)) return pos
  if (!lineRect) return pos
  // 1px 容差：浏览器给的坐标是整数，行块边界可能落在半个像素上
  if (clickY < lineRect.top - 1 || clickY > lineRect.bottom + 1) return pos

  // 以空行的垂直中点为界：点上半 → 吸附到上一段末尾；点下半 → 吸附到下一段开头
  const upward = clickY < (lineRect.top + lineRect.bottom) / 2
  return resolveParagraphGapCaret(doc, line.number, upward) ?? pos
}

/** 是否启用吸附。由扩展自身写入（见 `paragraphGapCaretSnap`），补丁到运行时再读一次。 */
const gapCaretEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/**
 * 本次指针按下「命中段间距」时的吸附目标；没命中就是 null。
 *
 * 为什么这条信息必须经过 state：事务过滤器拿不到 EditorView，
 * 也就**量不了几何** —— 而几何判断不能省。反例（本次踩到的回归）：
 * 点击纸页下方的留白会按 CodeMirror 的原意落到文末，而文末往往正是一个空行，
 * 只看「落点是空白行」根本分不清它是「段间距」还是「文档之外的留白」。
 * 于是：几何在 mousedown 那一刻（手里有 view、有坐标）算一次，
 * 写进 state，过滤器只负责消费。
 */
const setPointerGap = StateEffect.define<number | null>()
const pointerGapField = StateField.define<number | null>({
  create: () => null,
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setPointerGap)) return effect.value
    }
    return value
  },
})

interface GapCaretRuntime {
  /** 只有 mousedown 到 mouseup 之间为 true —— 这一段窗口里，坐标才带吸附语义。 */
  active: boolean
  /** 本次交互的收尾函数（监听在 window 上，鼠标在编辑器外松开也算数）。 */
  release: (() => void) | null
}

const RUNTIME = Symbol('paragraph-gap-caret')

type Coords = { x: number; y: number }
/**
 * CodeMirror 的这两个方法都是**重载**签名（`precise: false` 时保证返回位置）。
 * 这里只包一层薄壳，调用侧按普通签名使用，断言收口在赋值那一行。
 */
type PosAtCoordsImpl = (coords: Coords, precise?: boolean) => number | null
type PosAndSideAtCoordsImpl = (
  coords: Coords,
  precise?: boolean,
) => { pos: number; assoc: -1 | 1 } | null

/**
 * prototype 上的**原始**实现。
 *
 * 两个用途：补丁从它出发（避免包到自己身上造成递归）；
 * 以及任何「要看未吸附的真实坐标」的地方 —— 比如指针按下时判断命中，
 * 那时若走实例方法，会读到上一次交互留下的补丁语义，把「命中」判成「已吸附」。
 */
const ORIGINAL_POS_AT_COORDS = EditorView.prototype.posAtCoords as unknown as PosAtCoordsImpl
const ORIGINAL_POS_AND_SIDE_AT_COORDS =
  EditorView.prototype.posAndSideAtCoords as unknown as PosAndSideAtCoordsImpl

/**
 * 取（必要时安装）本视图的吸附运行时。
 *
 * 补丁**按视图实例只打一次**：CodeMirror 重配置扩展时插件会重建，
 * 若在插件生命周期里反复包裹/还原，先后顺序稍有出入就会把补丁弄丢。
 * 这里用实例上的 Symbol 做幂等标记，是否生效则每次读取 facet 决定 —— 切回 v1 界面即自动失效。
 *
 * ⚠️ 两个方法都要包，一个都不能少：
 *   · `posAndSideAtCoords` 才是**鼠标选取**（单击定位、拖动选字、双击、三击）真正走的入口
 *     —— CodeMirror 的 basicMouseSelection 直接调它，而它内部走的是模块内的坐标函数，
 *     并不经过 `posAtCoords`（起初只包了后者，等于什么都没改）；
 *   · `posAtCoords` 供拖放落点、拖放光标等路径使用。
 * 原始实现从 **prototype** 上取，避免包到自己身上造成递归。
 */
function runtimeOf(view: EditorView): GapCaretRuntime {
  const host = view as EditorView & { [RUNTIME]?: GapCaretRuntime }
  const existing = host[RUNTIME]
  if (existing) return existing

  const runtime: GapCaretRuntime = { active: false, release: null }
  host[RUNTIME] = runtime

  const snapPosAtCoords: PosAtCoordsImpl = (coords, precise = true) => snapWhenActive(
    runtime,
    view,
    coords,
    ORIGINAL_POS_AT_COORDS.call(view, coords, precise),
  )
  view.posAtCoords = snapPosAtCoords as unknown as EditorView['posAtCoords']

  const snapPosAndSide: PosAndSideAtCoordsImpl = (coords, precise = true) => {
    const found = ORIGINAL_POS_AND_SIDE_AT_COORDS.call(view, coords, precise)
    if (!found) return null
    const pos = snapWhenActive(runtime, view, coords, found.pos)
    return pos == null || pos === found.pos ? found : { pos, assoc: found.assoc as -1 | 1 }
  }
  view.posAndSideAtCoords = snapPosAndSide as unknown as EditorView['posAndSideAtCoords']

  return runtime
}

/** 只有在鼠标交互窗口内、且扩展启用时才改写坐标语义；其余一律原样返回。 */
function snapWhenActive(
  runtime: GapCaretRuntime,
  view: EditorView,
  coords: Coords,
  pos: number | null,
): number | null {
  if (pos == null || !runtime.active) return pos
  if (!view.state.facet(gapCaretEnabled)) return pos
  return snapOutOfGap(view, pos, coords.y)
}

/** 该位置所在行的行块在**视口**中的矩形。用真实 DOM 量，不依赖 CodeMirror 的高度账本。 */
function lineRectAt(view: EditorView, pos: number): DOMRect | null {
  const at = view.domAtPos(pos)
  const node: Node = at.node
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const line = element?.closest('.cm-line')
  return line ? line.getBoundingClientRect() : null
}

/**
 * 把落在段间距上的点击位置挪到相邻段落的文字上（几何测量这一层壳，决策见
 * `resolveParagraphGapClick`）。量不出行块时原样返回。
 */
function snapOutOfGap(view: EditorView, pos: number, clickY: number): number {
  try {
    return resolveParagraphGapClick(
      view.state.doc,
      pos,
      clickY,
      lineRectAt(view, pos),
    )
  } catch {
    return pos
  }
}

/**
 * 指针按下时若正好压在段间距上，返回「光标应该去哪」；没压在段间距上则返回 null。
 *
 * 刻意读**未打补丁**的原型方法：此刻若走实例方法，会读到上一次交互残留下的吸附语义，
 * 于是把「命中段间距」判成「已经吸附过」，反而什么都不做。
 */
function pointerGapCaret(view: EditorView, event: MouseEvent): number | null {
  try {
    const pos = ORIGINAL_POS_AT_COORDS.call(view, {
      x: event.clientX,
      y: event.clientY,
    })
    if (pos == null) return null
    const snapped = resolveParagraphGapClick(
      view.state.doc,
      pos,
      event.clientY,
      lineRectAt(view, pos),
    )
    return snapped === pos ? null : snapped
  } catch {
    return null
  }
}

/**
 * 拦住「指针把光标插进段间距」的第二条通道 —— 中键与右键。
 *
 * 左键走坐标映射，`posAndSideAtCoords` 上的补丁已经管住；但 CodeMirror 的 mousedown
 * 处理器写着 `if (!style && event.button == 0)`：**中键与右键根本不进入选取通道**，
 * 插入点是浏览器原生放进 contenteditable 的，随后被 DOM 观察者同步成一笔选区事务
 * （`userEvent: "select.pointer"`，见 `@codemirror/view` 内部 applyDOMChange）。
 * 那条事务不经过坐标映射 —— 所以补丁拦不到它，光标照样插进去、版面照样错位。
 *
 * 这里在事务层兜底：只要是「指针来源 ＋ 空选区 ＋ 落点是空白行」，
 * 就把选区拉回这笔变化**之前**的位置 —— mousedown 处理器已经把光标送对了地方。
 *
 * 只认 `select.pointer`，因此下列三条路一概不碰：
 *   · 键盘方向键（`userEvent: "select"`）—— 光标仍可停上空行，Enter 之后要能接着写；
 *   · 输入与删除（`docChanged`）；程序化选区（没有 userEvent 注解）。
 */
function gapCaretTransactionFilter() {
  return EditorState.transactionFilter.of((transaction) => {
    if (transaction.docChanged || !transaction.newSelection) return transaction
    if (transaction.annotation(Transaction.userEvent) !== 'select.pointer') return transaction
    const range = transaction.newSelection.main
    if (!range.empty) return transaction
    // 两条判据缺一不可：
    // · 落点落在空白行 —— 左键那笔事务的落点已经被坐标补丁挪到正文上，这里自然放行；
    // · 本次指针按下确实压在段间距上（几何判断在 mousedown 那一刻做过）。
    //   少了它，点击纸页留白（按原意落到文末空行）会被一起拦掉 —— 那是「接着往下写」的入口。
    if (transaction.startState.doc.lineAt(range.head).text.trim() !== '') return transaction
    if (transaction.startState.field(pointerGapField) == null) return transaction
    return [transaction, { selection: transaction.startState.selection }]
  })
}

/** 松手（或失焦、触摸取消）即恢复原语义：坐标补丁关掉，命中标记也一并撤走。 */
function armRelease(runtime: GapCaretRuntime, view: EditorView): void {
  runtime.release?.()
  const release = () => {
    runtime.active = false
    runtime.release = null
    window.removeEventListener('mouseup', release, true)
    window.removeEventListener('pointercancel', release, true)
    window.removeEventListener('blur', release, true)
    view.dispatch({ effects: setPointerGap.of(null) })
  }
  runtime.release = release
  // 捕获阶段挂在 window 上：鼠标在编辑器之外松开同样能收到
  window.addEventListener('mouseup', release, true)
  window.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release, true)
}

/**
 * 段间距不可落笔（v2 皮肤专用 —— v1 没有压矮空行，也就没有这个问题）。
 * 挂到编辑器的 extensions 上即启用。
 */
export function paragraphGapCaretSnap() {
  return [
    gapCaretEnabled.of(true),
    pointerGapField,
    gapCaretTransactionFilter(),
    ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          runtimeOf(view)
        }
      },
      {
        eventHandlers: {
          mousedown(event, view) {
            const runtime = runtimeOf(view)
            // 先在「补丁尚未打开」的状态下判断命中：此刻坐标还是真话
            const gapCaret = pointerGapCaret(view, event)
            runtime.active = true
            armRelease(runtime, view)
            // 把命中结果写进 state：过滤器拿不到 view，量不了几何
            view.dispatch({ effects: setPointerGap.of(gapCaret) })
            if (event.button === 0 || gapCaret == null) return
            /**
             * 中键与右键：CodeMirror 不做选取，插入点由浏览器原生放进空行。
             * 先主动把光标送到相邻段落，随后那笔由 DOM 观察者同步来的选区事务，
             * 会被上面的过滤器拉回这里设置的位置 —— 作者看到的是「光标落在段落上，版面没动」。
             * 返回 void：不做 preventDefault，右键菜单与中键自动滚动照旧可用。
             */
            view.dispatch({ selection: { anchor: gapCaret } })
          },
        },
      },
    ),
  ]
}
