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
 * 3. **事务过滤器只认 `select.pointer`**：输入、程序化选区一概不碰。
 *
 * ============================ 第五次报障：方向键 ============================
 *
 * 先生：「编辑正文和草稿的时候，按 ↑ 和 ↓ 会让光标落到两个自然段落中间空白的地方。」
 *
 * 上面第 3 条自我约束原写作「不碰键盘」，理由是「方向键经过空行是作者主动移动」。
 * 实测下来这个让步是错的，机制在校验时查清：
 *   CodeMirror 的上下移动（`EditorView.moveVertically`）**不按行走，按半行高扫描** ——
 *   从当前行底边起步，每 `textHeight >> 1`（约 9px）试一个 y，直到某一行的**内容盒中心**
 *   越过出发点。段间距空行的行块只有 20px（正文行 38px），它的「中心」正好卡在
 *   起步点上方一点点，于是**每次方向键都会先停在段间距上**，再按一下才到下一段。
 *   作者体感就是「光标掉进了两段中间的空白里」，而且那一下还会触发
 *   `.cm-lp-caret-empty` 把空行展开，下方内容整体下沉 —— 与鼠标点进去是同一种抖动。
 *
 * 修法：**方向键跨过这一格段间距**。落点若压在段间距上，就再走一步落到它后面那一行；
 * `view.moveVertically` 每次都把 goalColumn 带下去，所以横向的列位置照旧保持。
 *
 * ⚠️ 只跨**一层**，不是跨整片空白区 —— 这一条是踩过坑才定下来的，改动前请先读：
 *
 * 起初写的是「顺着同一方向一直走，直到走出这段空白为止」。它在标准排版下没问题，
 * 但作者**在段中按 Enter 起新段落**时，文档会变成
 * `段A / 空 / 新段落行 / 空 / 段B` —— 中间连着三行空白。
 * 「跨整片」把这三行当成一个整体跨掉：从段A 按 ↓ 直接落到段B，
 * 于是作者用 ↑ 离开后**按 ↓ 再也回不到自己刚起的那一段**。
 * （先生：「enter 切换段落后，没打字就按 ↑/↓ 移走，那个空段落就回不去了。」）
 *
 * 只跨一层之后：
 *   · `段A / 空行 / 段B`：从段A 按 ↓ → 跨过那一格空行 → 落在段B ✓（标准段间距照样跨过）
 *   · `段A / 空行 / 新段落行 / 空行 / 段B`：从段A 按 ↓ → 落在新段落行 ✓（作者的落脚点）
 *     再按 ↓ → 跨过下一格空行 → 落在段B ✓
 *   · `段A / 空行 / 新段落行`（文末）：从段A 按 ↓ → 落点是空行，再走一步走不动
 *     → 让位给默认命令 → 光标停在那个空行上 ✓（Enter 起的段落必须能落脚）
 *   · 反向同理：从新段落行按 ↑，跨过空行回到段A 末尾 ✓
 * 于是「连续空白区」可以逐层走遍，「一格段间距」一律跨过。
 *
 * 只有落点确实压在段间距上时才接管；正常落在正文行时原样返回 false 让位给
 * CodeMirror 自己的命令（折行内的上下移动、`moveToLineBoundary` 兜底等都保持原样）。
 * Shift + ↑/↓（选区扩展）走同一条跨越逻辑，否则拖选到段间距上照样会抖。
 *
 * 配套测试：
 *   · `__tests__/paragraph-gap-caret.test.ts` —— 吸附落点的纯函数（不需要浏览器）
 *   · `__tests__/CodeMirrorEditor-paragraph-gap-click.browser.tsx` —— 真实点击与版面不动
 *   · `__tests__/CodeMirrorEditor-paragraph-gap-middle-right-click.browser.tsx` —— 中键与右键
 *   · `__tests__/CodeMirrorEditor-paragraph-gap-arrow.browser.tsx` —— ↑↓ 跨过段间距
 *
 * ============================ 第六次报障：左右箭头 ============================
 *
 * 先生：「正文、草稿、便利贴的渲染器，左箭头右箭头跨行错误。它们理论上应该和上下按键
 * 一样，在跨段落的时候，能自己跟上上一段落，或者下一段落，但现在没有。」
 *
 * 上面那条修法只绑了 ↑↓，横向的两支漏了 —— 而横向的落点机制完全不同：
 *   CodeMirror 的逐字符移动是**逻辑行**的（`byCharLogical`：行末就 `line.to + 1`、
 *   行首就 `line.from - 1`，即跨过换行符本身），它压根不知道段与段之间还隔着一个空行。
 *   于是这一格又被走成了一条**独立的落点**：
 *     段A 行末 →（→）→ 段间距空行 →（→）→ 段B 行首
 *   光标停在空行上，`.cm-lp-caret-empty` 立刻把它展开、下方内容整体下沉。
 *   与鼠标点进去、与 ↑↓ 停上去，是同一种抖动；体感就是「左右键跨行跨错了」。
 *
 * 修法：**与 ↑↓ 完全同构地跨一层**。判据、让位条件、只跨一层的尺度、作者按 Enter
 * 起的那一格必须仍能落脚 —— 四条逐字照搬，只是把「相邻行」的来源从
 * `moveVertically` 的落点换成横向移动的落点（行末 / 行首）。
 *
 * 落点与 assoc 照抄 `byCharLogical` 的口径（向右 `assoc = -1`、向左 `assoc = 1`），
 * 这样折行处光标的显示位置与 CodeMirror 原生行为一致。
 * 段内一律让位：横向的接管只在**逻辑行端点**上发生，折行内部的逐格移动一个字都不动。
 *
 * 配套测试：`__tests__/CodeMirrorEditor-paragraph-gap-arrow-horizontal.browser.tsx`
 */
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type SelectionRange,
  type Text,
} from '@codemirror/state'
import { EditorView, ViewPlugin, keymap } from '@codemirror/view'
import { isUserParagraph } from './live-preview'

/** 空行 = 视觉上的段间距。判定口径与 v2-editor.css 的 `:has(> br:only-child)`、live-preview 的展开规则一致。 */
function isGapLine(text: string): boolean {
  return text.trim() === ''
}

/** 行首缩进空白：半角空格 / em 空格 / 全角空格 —— 与 live-preview 隐藏缩进用的是同一套字符。 */
export const LEADING_BLANK = /^[\s\u2003\u3000]+/

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
 * 从当前位置出发：若方向键的落点压在段间距上，返回「跨过这段空白之后」的位置；
 * 落点本来就在正文行上、或那个方向已经走不动了，返回 null（调用方让位给默认命令）。
 *
 * 判据是「**能不能走出去**」，不是「落点是空行就继续走」——
 * 文末那段空行（Enter 刚起的新段落行）走不出去，于是照旧可以落脚，见文件头的说明。
 */
function crossParagraphGap(
  view: EditorView,
  from: SelectionRange,
  forward: boolean,
): SelectionRange | null {
  const doc = view.state.doc
  const currentLine = doc.lineAt(from.head)

  /**
   * ① 先问默认命令会把光标带到哪：**若它还在本段落内部，原样让位**。
   *
   * 「一个段落」在这里是**逻辑行**，而屏幕上它可能折成好几个视觉行
   * （实测 414px 视口下，一段二十来字就折成两行）。段落**内部**的行与行之间
   * 是紧凑的行距，不是段间距 —— 光标该一格一格走。
   *
   * 这一条是先生报障后补的：此前下面那段判断「纯按行号」一刀切，
   * 于是从段落的**第一个视觉行**按 ↓，直接就被甩到下一个段落去了，
   * 段内的上下移动整个失效（先生：「光标在段落中移动的时候，按 ↑ 和 ↓ 位置不对了，
   * 直接就跳过一大段」）。
   */
  const step = view.moveVertically(from, forward)
  if (step.head === from.head) return null
  if (doc.lineAt(step.head).number === currentLine.number) return null

  /**
   * ② 落点已经跨出了本段落，这时才轮到「段间距要不要跳」的判断。
   *
   * 目标行**按行号**算，不用 `moveVertically` 的落点 —— 这一点也是踩坑定下来的：
   * `moveVertically` 走的是「半行高的像素扫描」，起点是当前行内容盒的底边，
   * 而首字下沉那个 3.15em 的朱砂大字会把首行的坐标拉到 59px 高，
   * 扫描步长（实测 textHeight=19 → 一步 19px）于是**一口气越过一整个空行**。
   * 实测：`段A / 空 / 空 / 段B` 里从段A 按一次 ↓，它直接答「行3」，
   * 紧挨着的行2 根本没被考虑。按行号走就没有这些偶然：
   *   · 紧邻的下一行是**正文行** → 不是段间距，返回 null 让位给默认命令；
   *   · 紧邻的下一行是**作者按 Enter 起的新段落** → 那是落脚点，同样让位（见下）；
   *   · 紧邻的下一行是**空行**（一格段间距）→ 跨过它，落到再下一行；
   *   · 再下一行越出文档（文末/文首那片空白）→ 返回 null，
   *     默认命令会把光标放在空行上，那正是 Enter 起的落脚点。
   */
  const adjacentNumber = currentLine.number + (forward ? 1 : -1)
  if (adjacentNumber < 1 || adjacentNumber > doc.lines) return null
  const adjacentLine = doc.line(adjacentNumber)
  /**
   * 紧邻的那一行若是**作者按 Enter 起的新段落**，就不跨 —— 让默认命令把光标停上去。
   *
   * 那一格与段间距在文本上都是一行空白，但来历不同：它是作者的落脚点
   * （先生：「创建的那个空段落只要一直不变即可，光标移走了那个地方依然在」）。
   * 在能分辨来历之前，这里只能按「空行」一刀切 —— 于是从段B 按 ↑ 会越过作者的
   * 新段落直接跳到段A，他再也回不到自己刚起的那一段。
   */
  if (isUserParagraph(view.state, adjacentLine.from)) return null
  if (!isGapLine(adjacentLine.text)) return null

  const targetNumber = adjacentNumber + (forward ? 1 : -1)
  if (targetNumber < 1 || targetNumber > doc.lines) return null
  const target = doc.line(targetNumber)

  /**
   * 出发时的水平列（像素）。
   *
   * 必须自己量下来：`moveVertically` 的 goalColumn 是「按行块左缘折算的列」，
   * 跨过空行（空行没有文字、量不出列）之后会漂 —— 实测从第 1 行第 3 个字按 ↓，
   * 落到第 3 行时已经漂到行尾。
   */
  const side: 1 | -1 = from.assoc ? (from.assoc as 1 | -1) : (forward ? 1 : -1)
  const goalX = view.coordsAtPos(from.head, side)?.left ?? null

  // 向下时对齐目标行最上面那个视觉行、向上时对齐最下面那个 —— 那才是紧挨着出发行的一端
  const anchor = forward ? target.from : target.to
  if (goalX != null) {
    const coords = view.coordsAtPos(anchor, forward ? 1 : -1)
    if (coords) {
      const aligned: number | null = view.posAtCoords({ x: goalX, y: (coords.top + coords.bottom) / 2 })
      // 落点必须确实在目标行上（列超出该行宽度时 posAtCoords 可能滑到邻行）
      if (aligned != null && doc.lineAt(aligned).number === targetNumber) {
        return EditorSelection.cursor(aligned, -1)
      }
    }
  }
  // 量不出列（或落点滑走了）时退到行首/行尾 —— 「跨过段间距」这件事本身必须成立
  return EditorSelection.cursor(anchor, forward ? 1 : -1)
}

/** ↑ / ↓：跨过段间距落到相邻段落上。 */
function cursorAcrossGap(view: EditorView, forward: boolean): boolean {
  if (!view.state.facet(gapCaretEnabled)) return false
  const range = view.state.selection.main
  // 有选区时让位给默认行为（它会把光标收到选区端），本命令只管空选区
  if (!range.empty) return false
  const target = crossParagraphGap(view, range, forward)
  if (!target) return false
  view.dispatch({ selection: target, scrollIntoView: true, userEvent: 'select' })
  return true
}

/**
 * Shift + ↑ / ↓：只移动选区头，锚点不动 —— 语义照搬 `@codemirror/commands` 的
 * `extendSel`（`EditorSelection.range(anchor, head.head, head.goalColumn, head.bidiLevel || undefined, head.assoc)`）。
 */
function selectAcrossGap(view: EditorView, forward: boolean): boolean {
  if (!view.state.facet(gapCaretEnabled)) return false
  const range = view.state.selection.main
  const target = crossParagraphGap(view, range, forward)
  if (!target) return false
  view.dispatch({
    selection: EditorSelection.range(
      range.anchor,
      target.head,
      target.goalColumn,
      target.bidiLevel || undefined,
      target.assoc,
    ),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

/**
 * 从当前位置出发：← / → 的落点若压在段间距上，返回「跨过这段空白之后」的位置；
 * 落点本来就在正文行上、或那个方向已经走不动了，返回 null（调用方让位给默认命令）。
 *
 * 与上面的 `crossParagraphGap`（↑↓）**逐条对称**，只有「相邻行怎么来」不同：
 * 横向移动是逻辑行的，在行末按 → 就是「换行符之后」，也就是下一行的行首；
 * 在行首按 ← 同理退到上一行末尾。所以紧挨着的下一行 / 上一行就是这里的「相邻行」。
 */
function crossParagraphGapHorizontally(
  view: EditorView,
  from: SelectionRange,
  forward: boolean,
): SelectionRange | null {
  const doc = view.state.doc
  const currentLine = doc.lineAt(from.head)

  /**
   * ① 只有落在**逻辑行的端点**上，这一按才会跨到相邻行 ——
   *    判据照抄 `byCharLogical`（`pos == (forward ? line.to : line.from)`）。
   *    于是折行段落内部的逐格移动一个字都不动，全部让位给 CodeMirror 自己。
   */
  if (from.head !== (forward ? currentLine.to : currentLine.from)) return null

  const adjacentNumber = currentLine.number + (forward ? 1 : -1)
  if (adjacentNumber < 1 || adjacentNumber > doc.lines) return null
  const adjacentLine = doc.line(adjacentNumber)

  /**
   * ② 紧邻的那一行若是**作者按 Enter 起的新段落**，就不跨 —— 让默认命令把光标停上去。
   *    与 ↑↓ 同一条规矩：那一格与段间距在文本上都是一行空白，但它是作者的落脚点
   *    （跨过去，他就再也回不到自己刚起的那一段）。其余非空行同样让位。
   */
  if (isUserParagraph(view.state, adjacentLine.from)) return null
  if (!isGapLine(adjacentLine.text)) return null

  const targetNumber = adjacentNumber + (forward ? 1 : -1)
  if (targetNumber < 1 || targetNumber > doc.lines) return null
  const target = doc.line(targetNumber)

  /**
   * ③ 落点与 assoc：
   *    向右落在目标行**第一个字之前**（跳过行首缩进 —— 落在缩进字符之间，
   *    光标会离文字一整格，口径同 `resolveParagraphGapAnchor`）；
   *    向左落在目标行末尾。
   *    assoc 照抄 `byCharLogical`（向右 -1、向左 1），折行处光标的显示位置
   *    因此与 CodeMirror 原生行为一致。
   */
  const anchor = forward
    ? target.from + (LEADING_BLANK.exec(target.text)?.[0].length ?? 0)
    : target.to
  return EditorSelection.cursor(anchor, forward ? -1 : 1)
}

/** ← / →：跨过段间距落到相邻段落上。 */
function cursorAcrossGapHorizontally(view: EditorView, forward: boolean): boolean {
  if (!view.state.facet(gapCaretEnabled)) return false
  const range = view.state.selection.main
  // 有选区时让位给默认行为（它会把光标收到选区端），本命令只管空选区
  if (!range.empty) return false
  const target = crossParagraphGapHorizontally(view, range, forward)
  if (!target) return false
  view.dispatch({ selection: target, scrollIntoView: true, userEvent: 'select' })
  return true
}

/** Shift + ← / →：只移动选区头，锚点不动 —— 语义同 `selectAcrossGap`。 */
function selectAcrossGapHorizontally(view: EditorView, forward: boolean): boolean {
  if (!view.state.facet(gapCaretEnabled)) return false
  const range = view.state.selection.main
  const target = crossParagraphGapHorizontally(view, range, forward)
  if (!target) return false
  view.dispatch({
    selection: EditorSelection.range(
      range.anchor,
      target.head,
      target.goalColumn,
      target.bidiLevel || undefined,
      target.assoc,
    ),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
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
    /**
     * 方向键跨过段间距（先生第五次报障 = ↑↓、第六次报障 = ←→）。
     *
     * `Prec.high` 是必需的：basicSetup 里的 defaultKeymap 也绑了这四个键，
     * 不提权就压不住它（同 CodeMirrorEditor 里 Enter 的处理）。
     * 命令在「落点不是段间距」时一律返回 false，把折行内的逐格移动、
     * 字符级移动等原有行为原样让回去。
     */
    Prec.high(keymap.of([
      { key: 'ArrowUp', run: (view) => cursorAcrossGap(view, false) },
      { key: 'ArrowDown', run: (view) => cursorAcrossGap(view, true) },
      { key: 'Shift-ArrowUp', run: (view) => selectAcrossGap(view, false) },
      { key: 'Shift-ArrowDown', run: (view) => selectAcrossGap(view, true) },
      { key: 'ArrowLeft', run: (view) => cursorAcrossGapHorizontally(view, false) },
      { key: 'ArrowRight', run: (view) => cursorAcrossGapHorizontally(view, true) },
      { key: 'Shift-ArrowLeft', run: (view) => selectAcrossGapHorizontally(view, false) },
      { key: 'Shift-ArrowRight', run: (view) => selectAcrossGapHorizontally(view, true) },
    ])),
    ViewPlugin.fromClass(
      class {
        private readonly onMouseDown = (event: MouseEvent) => {
          handlePointerDown(event, this.view)
        }

        constructor(private readonly view: EditorView) {
          runtimeOf(view)
          /**
           * 按下处理挂在**编辑器根元素**上，并且用**捕获阶段**。两条缺一不可：
           *
           * · **挂根元素**（不是 contentDOM）：纸页四周的留白不在 contentDOM 之内，
           *   挂 contentDOM 就收不到那些位置的按下。
           * · **捕获阶段**：CodeMirror 自己的按下处理也在 contentDOM 上。
           *   若挂在冒泡阶段，事件到达我们时它已经把编辑器聚焦、把插入点放进去了 ——
           *   那时再 `preventDefault` 已经晚一步，正是先生看到的
           *   「鼠标在编辑器框外点击，依然会让编辑器框体变色、控制其中的光标」。
           */
          view.dom.addEventListener('mousedown', this.onMouseDown, true)
        }

        destroy() {
          this.view.dom.removeEventListener('mousedown', this.onMouseDown, true)
        }
      },
    ),
  ]
}

/**
 * 某一行**文字实际占的横向范围**（行首字的左缘 → 行末字的右缘）。
 *
 * ⚠️ 不能用 `Range.getBoundingClientRect()` 量：Range 一旦跨越块级子元素
 * （`.cm-line` 就是块级），给回的是**块盒**（整栏宽）。实测对整块内容取包围盒
 * 得到 `79..335`，等于行块宽度，把文字两侧的空白一起圈进去了。
 * 逐行用 `coordsAtPos` 取行首 / 行末的坐标才准 —— 行首那个位置的左缘正是
 * **缩进之后**的文字起点（实测 112），而不是行块左缘（79）。
 */
function textBoundsOfLine(
  view: EditorView,
  lineNumber: number,
): { left: number; right: number } | null {
  const doc = view.state.doc
  if (lineNumber < 1 || lineNumber > doc.lines) return null
  const line = doc.line(lineNumber)
  if (!line.text.trim()) return null
  const head = view.coordsAtPos(line.from)
  const tail = view.coordsAtPos(line.to)
  if (!head || !tail) return null
  return { left: head.left, right: tail.right }
}

/** 从某个空行出发，朝两侧找到最近的一段正文，量它的文字横向范围。 */
function neighborTextBounds(
  view: EditorView,
  gapLineNumber: number,
): { left: number; right: number } | null {
  const doc = view.state.doc
  for (const step of [-1, 1] as const) {
    for (let number = gapLineNumber + step; number >= 1 && number <= doc.lines; number += step) {
      if (!doc.line(number).text.trim()) continue
      return textBoundsOfLine(view, number)
    }
  }
  return null
}

/**
 * 点击点是否落在**正文框**之内。
 *
 * 先生：「鼠标只要移动出正文框，就变成点击箭头，然后拒绝任何光标相关的事件触发就行了。」
 * 先生（附截图）：「鼠标在正文框外边、点击在两个段落中间，就会出现一个光标 —— 这是不对的。」
 *
 * 两道判断：
 *   ① **命中**：`elementFromPoint` 必须落在某个 `.cm-line` 里 ——
 *      直接问 DOM，不用「坐标 → 位置 → 行块矩形」反推（那条路在**折行的段落**上会选错参照行）。
 *   ② **空行（段间距）另算**：那一格没有文字，只能以**相邻正文行的文字横向范围**为准。
 *      落在这一列之外 —— 缩进区（首行那两格）、每行右侧的空档、纸页留白 —— 就是框外，点击无效。
 *      这正是先生截图里那支红箭头指的地方：那里点一下会把光标插进两个段落之间。
 *
 * 正文行本身不受 ② 限制：整栏都算框内，行内的空白照旧交给坐标映射
 * （作者点行末空档希望光标落到行尾，是合理的）。
 */
function isInsideTextArea(view: EditorView, event: MouseEvent): boolean {
  /**
   * 空文档特例 —— 便利贴的新建状态就是它。
   *
   * 整篇一个字都没有时，正文框里只有顶部那一行 `.cm-line`（约一行高），
   * 它下方一大片全是 `.cm-content` 的空白。照下面的规则，那片空白不是 `.cm-line`，
   * 于是被判成「框外」，紧接着就是 `preventDefault + stopPropagation + blur` ——
   * 作者点哪儿都被吃掉，编辑区成了点不进去的死区，一个字也打不出来。
   * （草稿永远有内容，所以这条路径从没被走到过。）
   *
   * 空文档时整块都算框内：那是唯一的落笔点。
   * 判据用「整篇没有可见文字」而不是「length === 0」，这样作者先敲几个回车
   * 再想点回去，也照样点得进去。
   */
  if (view.state.doc.length <= 4000 && view.state.doc.toString().trim() === '') return true

  // ① 命中：`elementFromPoint` 必须落在某个 `.cm-line`（正文框）里。
  //    这是唯一的总闸 —— 纸页四周的留白、`.cm-content` 的 padding 全都不是 `.cm-line`。
  const element = document.elementFromPoint(event.clientX, event.clientY)
  const lineEl = element instanceof Element ? element.closest('.cm-line') : null
  if (!lineEl) return false

  const pos = ORIGINAL_POS_AT_COORDS.call(view, { x: event.clientX, y: event.clientY })
  if (pos == null) return false
  const line = view.state.doc.lineAt(pos)
  // ② 正文行：整栏都算框内（点行末空档希望光标落到行尾，是合理的）
  if (line.text.trim() !== '') return true

  /**
   * ③ 空行（段间距）**没有文字**，行块里的横向留白不该算框内 ——
   *    只有「相邻正文行文字所在的那一列」才算，其余（缩进区、行末空档）一律框外。
   *    量不出边界时**拒绝**：先生的规则是框外什么都不做，宁可严一点。
   */
  const bounds = neighborTextBounds(view, line.number)
  if (!bounds) return false
  const tolerance = 6
  return event.clientX >= bounds.left - tolerance && event.clientX <= bounds.right + tolerance
}

/**
 * 指针按下时的统一处理（contentDOM 与根元素两条路都走这里）。
 *
 * 顺序很重要：**先在「补丁尚未打开」的状态下判断命中** —— 此刻坐标还是真话；
 * 随后才打开补丁，让紧接着的选取定位走吸附语义。
 */
function handlePointerDown(event: MouseEvent, view: EditorView): void {
  /**
   * 正文框外：**不碰正文，但作为「退出编辑」的手势**。
   *
   * 先生：「鼠标在正文框外应该是什么都不能做的，不是吗？！我一直以来要求的逻辑就是如此。」
   * 先生：「刷新后，我鼠标在编辑器框外点击，依然会让编辑器框体变色、控制其中的光标。」
   * 先生：「给鼠标点击正文框外加一个功能，就是让正文框本来在工作的时候的红色提示消失吧。
   *        不然完全没任何反应也有点奇怪。」
   *
   * 三件事的顺序都在这里定死：
   *   ① `preventDefault` —— 挡掉浏览器把插入点放进可编辑面、挡掉焦点转移；
   *   ② `stopPropagation` —— 连 CodeMirror 自己的按下处理都收不到，
   *      它就没机会聚焦编辑器、也没机会改动选区（这一步是「框体不再变色」的关键：
   *      冒泡阶段才拦已经晚一步，所以监听挂在**捕获阶段**）；
   *   ③ `blur()` —— 唯一主动做的事：退出编辑状态。
   *      编辑中的朱砂光标（`.cm-cursor`）只在聚焦时显示，失焦即消失 ——
   *      作者因此得到一个明确的「我已经离开编辑」的反馈，而不是彻底的毫无动静。
   *      正文本身一概不动：不放光标、不改选区、不改 state。
   */
  if (!isInsideTextArea(view, event)) {
    event.preventDefault()
    event.stopPropagation()
    view.contentDOM.blur()
    return
  }

  const runtime = runtimeOf(view)
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
}
