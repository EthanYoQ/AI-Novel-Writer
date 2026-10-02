import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import CodeMirror, { ReactCodeMirrorRef, EditorView, ViewUpdate } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState, Prec } from '@codemirror/state'
import { livePreview, markUserParagraph, paperHeadFacet, type PaperHead } from './live-preview'
import { paragraphGapCaretSnap } from './paragraph-gap-caret'
import { openSearchPanel, closeSearchPanel, search } from '@codemirror/search'
import { Sparkles, Bold, Check, Tag, SquareDashed } from 'lucide-react'
import { cn } from '../../lib/utils'
import { createGenerationRuntime } from '../../services/generation/generation-runtime'
import type { GenerationReasoningStage } from '../../shared/reasoning-types'
import { countDraftUnits } from '../../shared/draft-units'
import { useLocaleStore } from '../../stores/locale-store'
import { useUiVersionStore, isModernShell } from '../../stores/ui-version-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorldSettingStore } from '../../stores/world-setting-store'
import { toast } from '../ui/Toast'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { resolveWritingLanguage } from '../../shared/writing-language'
import { promptLanguageText } from '../../services/prompt-language'
import { composePromptSystemRole, renderPrompt, resolvePromptTemplate } from '../../services/prompt-templates'

export type CodeMirrorEditorProps = {
  content: string
  filePath?: string
  editable?: boolean
  onChange?: (content: string) => void
  onSave?: (content: string) => Promise<void> | void
  onCharCountChange?: (count: number) => void
  placeholder?: string
  hideStatusBar?: boolean
  mode?: 'document' | 'prose'
  /** 纸页页眉：章节名 + 「书名 · 第 N 章」；为空则不渲染页眉。 */
  paperHead?: PaperHead | null
  /**
   * 是否启用首字下沉（全文第一段那颗朱砂大字）。
   *
   * 缺省 true —— 正文与草稿的装帧一个字不动。
   * 便利贴是攒点子用的本子，不是文章，由 StickyNoteEditor 传 false 关掉。
   */
  dropcap?: boolean
}

type EditorAIAction = {
  key: 'refine' | 'expand' | 'continue' | 'dialogue'
  label: readonly [string, string]
  color: string
  prompt: readonly [string, string]
  reasoningStage: GenerationReasoningStage
}

const AI_ACTIONS = [
  { key: 'refine', label: ['润色', 'Refine'], color: 'text-[var(--color-category-progress-text)]', prompt: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'], reasoningStage: 'review' },
  { key: 'expand', label: ['扩写', 'Expand'], color: 'text-[var(--color-warning-text)]', prompt: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'], reasoningStage: 'drafting' },
  { key: 'continue', label: ['续写', 'Continue'], color: 'text-[var(--color-category-review-text)]', prompt: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'], reasoningStage: 'drafting' },
  { key: 'dialogue', label: ['对话', 'Dialogue'], color: 'text-[var(--color-success-text)]', prompt: ['将这部分改写为有区分度、能推动冲突的自然对话。', 'Rewrite this passage as distinct, natural dialogue that advances the conflict.'], reasoningStage: 'drafting' },
] satisfies readonly EditorAIAction[]

const EDITOR_AI_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 1,
  maxRequestedOutputTokens: 4096,
  maxRequestedOutputTokensPerAttempt: 4096,
  deadlineMs: 120_000,
})

/**
 * markdown 的结构行：列表、引用、标题、围栏代码块。
 * 这些行上的 Enter 要保留「续写标记」的语义（`- `、`> ` 该被带下去），
 * 因此让位给 CodeMirror 自己的续写命令，本编辑器不插手。
 */
const MARKDOWN_STRUCTURE_LINE = /^\s*(?:[-*+]|\d+[.)])\s|^\s*>|^\s*#{1,6}(?:\s|$)|^\s*(?:```|~~~)/

/**
 * 普通正文段落上的 Enter —— 起一个新段落。
 *
 * 先生：「enter 必须两下才能正确到内容。」
 *
 * 两件事叠在一起，都得在这里解决：
 *
 * ① **段落分隔空行**。本项目的排版约定是「段落与段落之间必须保留一个空行作为分隔」
 *    （见 services/prompt-templates.ts 的强制排版要求），AI 生成的草稿也全是这个格式。
 *    而 markdown 语言包默认把 Enter 绑到「续写标记」命令，它只插入**一个**换行 ——
 *    于是作者在段末按一次 Enter，得到的是「紧贴上一段的新行」，段落结构与文档其余部分
 *    不一致，必须再按一次才凑出正确的空行 —— 正是「enter 要两下」。
 *    所以：当前行**有内容**时插入两个换行（空行 + 新段落行）；
 *    当前行本来就空着时只插入一个（作者是想再加一个空行）。
 *
 * ② **继承缩进**。那个命令还会把当前行的行首缩进复制到新行，新行里就躺着看不见的空格，
 *    作者按 Backspace 时第一下只清掉它们、换行符还在 —— 先生报的「要按两次 Backspace」。
 *    正文段落的缩进本来就由 CSS 的 `text-indent: 2em` 提供（行内缩进字符还会被
 *    live-preview 隐藏），新行不需要任何行内缩进。
 *
 * 边界：只接管「空选区 + 非 markdown 结构行」。
 *   · 有选区时让位 —— 默认行为会先删掉选区再换行；
 *   · 输入法组合期间让位 —— 那时 Enter 是确认候选词，不该被改写。
 *
 * ③ **新段落行登记为「作者起的那一格」**（先生第三次报障的收尾）：
 *    这一行是写作落脚点，不是段间距。登记之后由 live-preview 给它固定整行高，
 *    光标进出都不会改变它 —— 移走光标时下方段落一动不动，与 Word 的手感一致。
 */
function enterPlainParagraph(target: EditorView): boolean {
  if (target.state.readOnly) return false
  if (target.composing) return false
  const range = target.state.selection.main
  if (!range.empty) return false
  const line = target.state.doc.lineAt(range.head)
  if (MARKDOWN_STRUCTURE_LINE.test(line.text)) return false
  const br = target.state.lineBreak
  const insert = line.text.trim() === '' ? br : br + br
  const anchor = range.head + insert.length
  target.dispatch({
    changes: { from: range.head, insert },
    selection: { anchor },
    effects: markUserParagraph.of(anchor),
  })
  return true
}

/**
 * Backspace 与上面的 Enter 对称：一次删掉刚起的那一段。
 *
 * 先生：「删除要按两次 Backspace 才能正确返回上一段落。」
 *
 * Enter 一次插入了「空行 + 新段落行」两个换行，若 Backspace 只删一个，
 * 光标会停在空行行首（而不是回到上一段末尾），作者得再按一次 —— 这就是「两次」。
 * 因此：当光标停在**段落首行行首**、且它上面正好是「一段 + 一个空行」时，
 * 一次删掉这两个换行，直接回到上一段末尾。其余位置一律让位给默认行为。
 *
 * （段首那排行内缩进字符在**光标行是显形的** —— 见 live-preview 的缩进规则 ——
 *  所以作者按 Backspace 删它们时看得见变化，这里不需要额外接管。）
 */
function backspaceParagraphBreak(target: EditorView): boolean {
  if (target.state.readOnly) return false
  if (target.composing) return false
  const { state } = target
  const range = state.selection.main
  if (!range.empty) return false
  const head = range.head
  const line = state.doc.lineAt(head)
  // 只在行首、且该行上面是「非空段末行 + 空行」的结构上接管
  if (head !== line.from) return false
  if (line.number < 3) return false
  const blank = state.doc.line(line.number - 1)
  const paragraph = state.doc.line(line.number - 2)
  if (blank.text.trim() !== '' || paragraph.text.trim() === '') return false
  target.dispatch({
    changes: { from: paragraph.to, to: head },
    selection: { anchor: paragraph.to },
  })
  return true
}

export default function CodeMirrorEditor({
  content,
  editable = true,
  onChange,
  onSave,
  onCharCountChange,
  placeholder,
  mode = 'document',
  paperHead = null,
  dropcap = true,
}: CodeMirrorEditorProps) {
  const uiText = useLocaleStore(s => s.text)
  const uiLocale = useLocaleStore(s => s.locale)
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  // 避免状态回路
  const lastEmittedContentRef = useRef(content)
  const [editorContent, setEditorContent] = useState(content)
  const hasEmittedInitialCount = useRef(false)

  // 更新内容
  useEffect(() => {
    // 首次挂载时主动汇报一次字数
    if (!hasEmittedInitialCount.current) {
      onCharCountChange?.(countDraftUnits(content))
      hasEmittedInitialCount.current = true
    }

    if (content !== lastEmittedContentRef.current) {
      lastEmittedContentRef.current = content
      setEditorContent(content)
      // 内容经由外部变动（例如打开新文件）
      onCharCountChange?.(countDraftUnits(content))
    }
  }, [content, onCharCountChange])

  // ===== Bubble Menu 逻辑 =====
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubblePos, setBubblePos] = useState({ top: 0, left: 0 })
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [activeAIAction, setActiveAIAction] = useState<string | null>(null)
  const [loadingDots, setLoadingDots] = useState('.')
  const [selectionRange, setSelectionRange] = useState<{ from: number, to: number } | null>(null)
  const aiRequestSequenceRef = useRef(0)
  const aiTargetRef = useRef<{
    requestSequence: number
    from: number
    to: number
    selectedText: string
    documentText: string
  } | null>(null)

  useEffect(() => () => {
    aiRequestSequenceRef.current += 1
    aiTargetRef.current = null
  }, [])

  useEffect(() => {
    if (aiResult === '') {
      const timer = setInterval(() => setLoadingDots(d => d.length >= 3 ? '.' : d + '.'), 400)
      return () => clearInterval(timer)
    }
  }, [aiResult])

  /**
   * 字数统计的调度器。
   *
   * 实测（19.6 万字的正文，蓝汐用 vitest browser 基准量过）：
   * doc.toString() 只花 0.00ms（Text 是 rope，很快），而 countDraftUnits() 要
   * **23.90ms** —— 它内部有 normalize + 3 次全量 replace + 2 次全量 match。
   * 逐键调用它就是手感杀手，因此防抖到打字停稳后再算一次：
   * 字数只是面板上的读数，慢 300ms 完全无感，但每个键都省下约 24ms。
   */
  const charCountTimerRef = useRef<number | null>(null)
  const onCharCountChangeRef = useRef(onCharCountChange)
  useEffect(() => {
    onCharCountChangeRef.current = onCharCountChange
  })
  useEffect(() => () => {
    if (charCountTimerRef.current !== null) {
      window.clearTimeout(charCountTimerRef.current)
      charCountTimerRef.current = null
    }
  }, [])

  const scheduleCharCount = useCallback((text: string) => {
    if (charCountTimerRef.current !== null) {
      window.clearTimeout(charCountTimerRef.current)
    }
    charCountTimerRef.current = window.setTimeout(() => {
      charCountTimerRef.current = null
      onCharCountChangeRef.current?.(countDraftUnits(text))
    }, 300)
  }, [])

  /**
   * 先生（打字手感 / 标点重复上屏）：
   * @uiw/react-codemirror 会把 onUpdate 直接塞进扩展数组，并把它列进
   * useLayoutEffect 的依赖 —— onUpdate 的函数引用一变，整个编辑器状态就被重建。
   * 而这段逻辑依赖 onChange（DraftEditor 是内联箭头函数，每次渲染都是新引用），
   * 于是每次敲字都会走一遍「store 更新 → 父组件重渲染 → onUpdate 换引用 →
   * 编辑器重建」，输入法组合被反复打断：中文标点重复上屏、手感发滞。
   * 改法：用 ref 转发最新闭包，对 @uiw 而言 onUpdate 永远指向同一个函数。
   */
  const updateHandlerRef = useRef<(v: ViewUpdate) => void>(() => {})
  useEffect(() => {
    updateHandlerRef.current = (v: ViewUpdate) => {
      if (v.docChanged) {
        const newText = v.state.doc.toString()
        lastEmittedContentRef.current = newText
        onChange?.(newText)

        // 注意：onChange 保持逐键实时（数据安全优先），只把「贵而不紧急」的
        // 字数统计挪到防抖队列里。
        scheduleCharCount(newText)
      }

      if (v.selectionSet || v.docChanged || v.geometryChanged) {
        const sel = v.state.selection.main
        if (sel.empty || sel.to - sel.from < 1) {
          setBubbleOpen(false)
          setSelectionRange(null)
        } else {
          setSelectionRange({ from: sel.from, to: sel.to })
          // 交由下方的 useEffect 进行精准防越界座标计算与位置同步
          if (!aiResult) {
            setBubbleOpen(true)
          }
        }
      }
    }
  })
  const handleUpdate = useCallback((v: ViewUpdate) => updateHandlerRef.current(v), [])

  // 监听滚动与缩放，实时更新 Bubble Menu 坐标
  useEffect(() => {
    if (!bubbleOpen || !selectionRange || !editorRef.current?.view) return;

    const view = editorRef.current.view;
    const scrollDOM = view.scrollDOM;

    let rafId: number;

    const updatePosition = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        const coords = view.coordsAtPos(selectionRange.from)
        if (coords) {
          setBubblePos({ top: coords.top, left: coords.left })
        } else {
          setBubbleOpen(false)
        }
        return
      }

      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const viewRect = scrollDOM.getBoundingClientRect()

      // 判断选区是否整体完全在视口之外
      if (rect.bottom < viewRect.top || rect.top > viewRect.bottom || rect.width === 0) {
        setBubbleOpen(false)
        return
      }

      let top = rect.top - 5 // 与选区顶部有些许间距
      const left = rect.left + rect.width / 2

      // 当用户圈选了一大段并向下滚动时，如果选区顶部滚出了视区，
      // 我们让气泡悬浮在视区顶部边缘，直到选区底部也完全滚出视区。
      if (top < viewRect.top + 45) {
        top = Math.min(viewRect.top + 45, rect.bottom - 10)
      }

      setBubblePos({ top, left })
    }

    const onScrollOrResize = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updatePosition)
    }

    scrollDOM.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize, { passive: true })

    // 初始化计算需要等待 CM 渲染映射完成，确保获取到正确的 DOM Range
    rafId = requestAnimationFrame(updatePosition)

    return () => {
      scrollDOM.removeEventListener('scroll', onScrollOrResize)
      window.removeEventListener('resize', onScrollOrResize)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [bubbleOpen, selectionRange])

  // 主题配置
  const cmTheme = useMemo(() => EditorView.theme({
    "&": {
      height: "100%",
      // prose/document 都是写作场景，使用写作字体
      // 其他模式（如代码等）继承父元素 UI 字体
      fontSize: mode === 'prose' ? "16px" : "14px",
      backgroundColor: "transparent",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-scroller": {
      overflow: "auto",
      paddingBottom: "100px",
      cursor: "text",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-content": {
      width: "100%",
      maxWidth: "800px",
      margin: "0 auto",
      padding: "40px",
      lineHeight: "1.8",
      color: "var(--color-text)",
      cursor: "text",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--color-editor-caret, var(--color-text))", borderLeftWidth: "2px" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-selectionBackground, .cm-focused .cm-selectionBackground": { backgroundColor: "var(--color-hover) !important" },
    ".cm-line": { padding: "0" },
  }), [mode])

  // 构建扩展
  /** 界面版本：实时预览（成书纸页）只在现代外壳（v2 墨纸书斋 / v3 时尚杂志）下启用，便于随时回滚。 */
  const uiVersion = useUiVersionStore((s) => s.uiVersion)

  /**
   * 先生（打字手感 / 标点重复上屏）：
   *
   * paperHead 由调用方按「每次渲染新建对象字面量」的方式传入（见 DraftEditor
   * 的 paperHead={meta ? {…} : null}）。若把它直接放进 extensions 的依赖，
   * 父组件每次渲染都会重建整个扩展数组，而 @uiw/react-codemirror 一旦发现
   * extensions 变化就会对编辑器做一次 reconfigure —— 打字时正文一改、父组件
   * 就重渲染、编辑器紧接着 reconfigure，正好打断中文输入法的组合过程，
   * 于是标点会重复上屏、手感发滞。
   *
   * 这里按**内容值**记忆：只有章节名或副标题真正变化时才重建扩展。
   */
  const paperHeadTitle = paperHead?.title ?? null
  const paperHeadSubtitle = paperHead?.subtitle ?? ''
  const stablePaperHead = useMemo<PaperHead | null>(
    () => (paperHeadTitle === null ? null : { title: paperHeadTitle, subtitle: paperHeadSubtitle }),
    [paperHeadTitle, paperHeadSubtitle],
  )

  const extensions = useMemo(() => {
    const exts = [
      search({ top: true }),
      EditorView.lineWrapping,
      /**
       * 段落缩进键。
       *
       * 注意：这里**刻意不加 Prec 提权**。加了之后 Tab 会走本处理器（插入两个 em 空格
       * U+2003），而当前的实际行为是 CodeMirror 默认缩进（两个普通半角空格）。
       * 两者在屏幕上**看不出差别** —— live-preview 会把行首缩进空白字符隐藏掉，
       * 缩进统一由 CSS 的 `text-indent: 2em` 提供（见 v2-editor.css）。
       *
       * 先生明确说过「tab 原本就是正确的」，且既有浏览器测试断言的是两个普通空格；
       * 所以这里保持既有行为不变，不为了「与注释一致」去改动作者摸熟了的手感。
       */
      keymap.of([
        {
          key: 'Tab',
          run: (target) => {
            if (target.state.readOnly) return false
            // 插入两个 em 空格（U+2003）= 2em = 标准中文首行缩进两字符宽
            // 使用 \u2003 而非 \u3000（全角空格），因为 em 空格在任何 Unicode 字体下
            // 都精确等于 1em，不依赖 CJK 字体加载
            target.dispatch({
              changes: { from: target.state.selection.main.head, insert: '\u2003\u2003' },
              selection: { anchor: target.state.selection.main.head + 2 }
            })
            return true
          }
        }
      ]),
      // 汉化 Search / UI 文本（涵盖官方大小写所有变种）
      EditorState.phrases.of(uiLocale === 'zh-CN' ? {
        "Find": "查找",
        "find": "查找",
        "Replace": "替换",
        "replace": "替换",
        "Replace all": "全部替换",
        "replace all": "全部替换",
        "Next": "下一个",
        "next": "下一个",
        "Previous": "上一个",
        "previous": "上一个",
        "All": "全部选中",
        "all": "全部选中",
        "Match case": "区分大小写",
        "match case": "区分大小写",
        "Regexp": "正则表达式",
        "regexp": "正则表达式",
        "by word": "全词匹配",
        "By word": "全词匹配",
        "Close": "关闭",
        "close": "关闭"
      } : {})
    ]
    // prose（正文）同样加载 markdown 语法：实时预览要靠语法树定位标记字符
    if (mode === 'document' || mode === 'prose') {
      /**
       * 先生（「删除时按两次 Backspace 才会正确」）：见 enterPlainParagraph 的说明。
       *
       * 只在现代外壳接管 —— v1 没有 CSS 提供的段落缩进，行内那两个缩进字符是**必需的**，
       * 在那里让 Enter 继承缩进才是正确行为，不能一并改掉。
       *
       * 用 Prec.high 是因为 markdown() 自己也会绑一份 Enter（默认优先级），
       * 不提权就压不住它 —— 这一点与上面 Tab 的处理刻意不同（Tab 保持既有手感不变）。
       */
      if (isModernShell(uiVersion)) {
        exts.push(Prec.high(keymap.of([
          { key: 'Enter', run: enterPlainParagraph },
          { key: 'Backspace', run: backspaceParagraphBreak },
        ])))
      }
      exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
    }
    // 实时预览：把 markdown 标记从视图里抹掉，编辑时直接呈现成书排版
    if (mode === 'prose' && isModernShell(uiVersion)) {
      exts.push(livePreview({ dropcap }))
    }
    /**
     * 先生（第四次报障）：「鼠标能把光标移动到两个段落中间，导致上下文抖动。」
     *
     * 段落之间那个空行就是段间距（1.2em），光标一落上去 `.cm-lp-caret-empty`
     * 就把它展开成完整行高，下方内容被整体推下去 —— 那是为「打字不位移」设计的，
     * 只该发生在作者主动把光标移过去的时候（Enter / 方向键），不该由鼠标点空白触发。
     *
     * 现代外壳专用：v1 皮肤没有压矮空行，也就没有这段间距可点。
     */
    if (isModernShell(uiVersion)) {
      exts.push(paragraphGapCaretSnap())
    }
    // 纸页页眉由真实 DOM widget 渲染，随正文一起滚动
    exts.push(paperHeadFacet.of(stablePaperHead))
    return exts
  }, [mode, uiLocale, uiVersion, stablePaperHead, dropcap])

  // AI 菜单处理（流式调用，实时显示生成内容）
  /**
   * 先生：草稿里选中一个名词，可以直接收进世界观设定。
   *
   * 落点刻意是**待确认**而不是直接入库 —— 正文里冒出来的名词未必都值得立条，
   * 让作者在待确认队列里过一眼再采纳（与 AI 生成的候选走同一条路径）。
   * 归属分类取当前正在看的分类，作者随后可在待确认里调整。
   */
  const handleSaveAsWorldSetting = useCallback(async () => {
    const view = editorRef.current?.view
    if (!view || !selectionRange) return
    const raw = view.state.sliceDoc(selectionRange.from, selectionRange.to).trim()
    if (!raw) return
    // 选区可能是「青云宗的山门」这样的片段：按标点与空白切开，取第一个词作条目名。
    const name = raw
      .replace(/[\s，。、；：！？"'「」『』（）()《》【】]/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)[0] ?? ''
    if (!name) return

    const store = useWorldSettingStore.getState()
    const saved = await store.save({
      category: store.activeCategory,
      name: name.slice(0, 200),
      aliases: [],
      summary: '',
      content: '',
      tags: [],
      importance: 'side',
      source: 'manual',
      status: 'pending',
    })
    if (saved) {
      toast.success(uiText(`已加入待确认：「${name}」`, `Added to pending review: “${name}”`))
      setBubbleOpen(false)
    } else {
      toast.error(uiText('收录失败，请重试', 'Could not save. Please try again.'))
    }
  }, [selectionRange, uiText])

  const handleAIAction = async (action: EditorAIAction) => {
    let runtime: Awaited<ReturnType<typeof createGenerationRuntime>> | null = null
    let requestSequence: number | null = null
    try {
      if (!selectionRange || !editorRef.current?.view) return
      const view = editorRef.current.view
      const selectedText = view.state.sliceDoc(selectionRange.from, selectionRange.to)
      requestSequence = ++aiRequestSequenceRef.current
      aiTargetRef.current = {
        requestSequence,
        from: selectionRange.from,
        to: selectionRange.to,
        selectedText,
        documentText: view.state.doc.toString(),
      }
      const writingLanguage = resolveWritingLanguage(
        useProjectStore.getState().currentProject?.novelConfig.writingLanguage,
      )
      const template = await resolvePromptTemplate(
        'edit_selected_text',
        getActiveProjectSessionContext() ?? undefined,
        writingLanguage,
      )
      if (!template) throw new Error(uiText('未找到编辑器提示词', 'Editor prompt is unavailable'))

      setActiveAIAction(uiText(...action.label))
      setAiResult('')
      setAiError(null)

      runtime = await createGenerationRuntime({ budget: EDITOR_AI_GENERATION_BUDGET })
      const outcome = await runtime.execute(({ session }) => session.complete({
        purpose: `editor-ai-${action.key}`,
        reasoningStage: action.reasoningStage,
        output: 'visible-text',
        messages: [
          { role: 'system', content: composePromptSystemRole(template, writingLanguage) },
          { role: 'user', content: renderPrompt(template, {
            edit_instruction: promptLanguageText(writingLanguage, ...action.prompt),
            selected_text: selectedText,
          }, writingLanguage) },
        ],
      }))
      if (outcome.status !== 'completed' || outcome.finishReason !== 'stop') {
        if (requestSequence !== aiRequestSequenceRef.current) return
        setAiResult('')
        setAiError(uiText('生成未完整完成，结果不可应用', 'Generation did not complete; the result cannot be applied.'))
        return
      }
      if (requestSequence !== aiRequestSequenceRef.current) return
      setAiResult(outcome.content)
    } catch (e) {
      console.error(e)
      if (requestSequence !== aiRequestSequenceRef.current) return
      setAiResult('')
      setAiError(uiText('生成失败，结果不可应用', 'Generation failed; the result cannot be applied.'))
    } finally {
      await runtime?.close().catch(() => {})
    }
  }

  /**
   * 先生：气泡菜单上加「全选」—— 一键选中整篇文档。
   *
   * 落点刻意是「整篇文档」而不是「当前可见范围」：先生要的是长文里一句话把全文圈起来
   * （整体复制、整体处理），视线滚到哪儿都不该影响结果。
   *
   * 两处细节：
   * · 选区方向照浏览器 Ctrl+A 的习惯：锚点在文首、光标在文末；
   * · **不传 scrollIntoView** —— 全选不该把作者正在看的位置弹到文末去，
   *   视线留在原地，只是高亮铺满全文。
   */
  const handleSelectAll = useCallback(() => {
    const view = editorRef.current?.view
    if (!view) return
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    // 点击气泡时焦点已由容器的 onMouseDown preventDefault 保住，这里再兜一次：
    // 全选之后作者多半紧接着按 Ctrl+C。
    view.focus()
  }, [])

  const handleAcceptAI = () => {
    const target = aiTargetRef.current
    if (target && aiResult && editorRef.current?.view) {
      const view = editorRef.current.view
      if (!editable) {
        setAiError(uiText(
          '正文已变为只读，结果未应用；你仍可复制预览内容',
          'The document is now read-only. The result was not applied; you can still copy the preview.',
        ))
        return
      }
      const targetStillCurrent = (
        target.requestSequence === aiRequestSequenceRef.current
        && view.state.doc.toString() === target.documentText
        && view.state.sliceDoc(target.from, target.to) === target.selectedText
      )
      if (!targetStillCurrent) {
        setAiError(uiText(
          '正文或原目标已变化，结果未应用；你仍可复制预览内容',
          'The document or original target changed. The result was not applied; you can still copy the preview.',
        ))
        return
      }
      view.dispatch({
        changes: { from: target.from, to: target.to, insert: aiResult }
      })
    }
    aiTargetRef.current = null
    setAiResult(null)
    setBubbleOpen(false)
  }

  const handleRejectAI = () => {
    aiRequestSequenceRef.current += 1
    aiTargetRef.current = null
    setAiResult(null)
    setAiError(null)
    setBubbleOpen(false)
  }

  // 固定 basicSetup 内存引用，防止 React 每次渲染生成新对象导致内部扩展被重载（搜索框消失的罪魁祸首）
  const cmBasicSetup = useMemo(() => ({
    lineNumbers: false,
    foldGutter: false,
    dropCursor: false,
    /**
     * 先生（选了字看不到选中反馈）：此前选区交给浏览器原生绘制，全靠一条
     * 16% 的 ::selection —— 铺在纸白上几乎没有色差。改为 CodeMirror 自绘选区
     * （.cm-selectionBackground），选区就有了独立图层，颜色由 v2-editor.css
     * 稳定控制，滚动与重绘时也不会闪。原生 ::selection 仍保留作兜底。
     */
    drawSelection: true,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
  }), [])

  return (
    <div className="relative h-full flex flex-col min-h-0"
      onKeyDownCapture={(e) => {
        // 全局捕获 Ctrl+F 实现搜索框 Toggle（解决搜索框内焦点时快捷键失效的问题）
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          e.stopPropagation()
          const view = editorRef.current?.view
          if (view) {
            const searchPanel = view.dom.querySelector('.cm-search')
            if (searchPanel) {
              closeSearchPanel(view)
              view.focus()
            } else {
              openSearchPanel(view)
            }
          }
        }
      }}
      onKeyDown={(e) => {
        // 捕获 Cmd+S 保存
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          onSave?.(lastEmittedContentRef.current)
        }
      }}>
      <div className="flex-1 relative min-h-0 overflow-hidden"
        onMouseDown={() => {
          // 点击空白处关闭 Bubble Menu
          if (aiResult) return;
          // setBubbleOpen(false) 交给 handleUpdate 里面的 selection empty 判断即可
        }}>
        <div className="absolute inset-0">
          <CodeMirror
            ref={editorRef}
            value={editorContent}
            placeholder={placeholder}
            height="100%"
            className="h-full"
            theme={cmTheme}
            extensions={extensions}
            readOnly={!editable}
            editable={editable}
            basicSetup={cmBasicSetup}
            onUpdate={handleUpdate}
          />
        </div>
      </div>

      {/* Bubble Menu */}
      {bubbleOpen && (editable || aiResult !== null) && bubblePos.top !== 0 && (
        <div
          className="fixed z-50 flex items-center gap-0.5 p-1 rounded-xl border select-none shadow-xl transform -translate-x-1/2 -translate-y-full"
          style={{
            top: bubblePos.top,
            left: bubblePos.left,
            backgroundColor: 'var(--color-sidebar)',
            borderColor: 'var(--color-border)',
          }}
          onMouseDown={(e) => e.preventDefault()} // 防止编辑器失焦
        >
          {aiResult !== null ? (
            <div className="w-[360px] max-h-[260px] overflow-y-auto p-2">
              <div
                className="text-[10px] mb-1.5 font-medium flex items-center gap-1"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Sparkles size={11} style={{ color: 'var(--color-accent)' }} /> {activeAIAction
                  ? uiText(`${activeAIAction}预览`, `${activeAIAction} preview`)
                  : uiText('AI 预览', 'AI preview')}
              </div>
              {/* 流式输入中显示动态内容 */}
              {aiError ? (
                <>
                  <div
                    className="text-xs leading-relaxed mb-3"
                    style={{ color: 'var(--color-error-text)' }}
                  >
                    {aiError}
                  </div>
                  {aiResult && (
                    <div
                      className="text-xs whitespace-pre-wrap leading-relaxed mb-3"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      {aiResult}
                    </div>
                  )}
                </>
              ) : aiResult === '' ? (
                <div
                  className="text-xs leading-relaxed mb-3"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {uiText('正在生成', 'Generating')} {loadingDots}
                </div>
              ) : (
                <div
                  className="text-xs whitespace-pre-wrap leading-relaxed mb-3"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {aiResult}
                </div>
              )}
              <div className="flex items-center gap-2 justify-end">
                <button
                  className="px-2.5 py-1 text-xs rounded-md transition-colors"
                  style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  onClick={handleRejectAI}
                >{uiText('取消', 'Cancel')}</button>
                <button
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md font-medium transition-colors"
                  style={{ backgroundColor: 'var(--color-accent)', color: '#fff' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  disabled={aiResult === '' || aiError !== null}
                  onClick={handleAcceptAI}
                ><Check size={12} aria-hidden="true" />{uiText('替换', 'Replace')}</button>
              </div>
            </div>
          ) : (
            <>
              {mode === 'document' && (
                <>
                  <button
                    className="p-1 rounded"
                    style={{ color: 'var(--color-text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                    onClick={() => {
                      // document模式下的格式转换
                      if (selectionRange && editorRef.current?.view) {
                        const view = editorRef.current.view
                        const text = view.state.sliceDoc(selectionRange.from, selectionRange.to)
                        view.dispatch({
                          changes: { from: selectionRange.from, to: selectionRange.to, insert: `**${text}**` }
                        })
                      }
                    }}
                  ><Bold size={14} /></button>
                  <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
                </>
              )}
              {/*
                先生：选中名词一键收进世界观设定。
                刻意不放在上面的 mode === 'document' 分支里 —— 加粗只在该模式显示，
                而「收录名词」在任何模式下都该可用，否则先生根本看不到它。
              */}
              <button
                className="p-1 rounded flex items-center gap-1 transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                title={uiText('把选中的名词收录为世界观设定（先进待确认队列）', 'Save the selected term as a world-setting entry (pending review)')}
                aria-label={uiText('收录为世界观设定', 'Save as a world-setting entry')}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                onClick={handleSaveAsWorldSetting}
              >
                {/* 先生：光一个图标没人看得出能点，配上「收录」二字 */}
                <Tag size={12} />
                <span className="text-[10px] tracking-widest">{uiText('收录', 'Save')}</span>
              </button>
              {/*
                先生：气泡菜单上加「全选」。
                与「收录」同属「对选区本身的操作」，因此紧挨着它，用同一条分隔线与 AI 动作区隔开。
              */}
              <button
                className="p-1 rounded flex items-center gap-1 transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                title={uiText('选中整篇文档', 'Select the entire document')}
                aria-label={uiText('全选', 'Select all')}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                onClick={handleSelectAll}
              >
                <SquareDashed size={12} />
                <span className="text-[10px] tracking-widest">{uiText('全选', 'Select all')}</span>
              </button>
              <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
              <div
                className="flex items-center gap-0.5 pl-0.5 pr-1 text-[10px]"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Sparkles size={11} />AI
              </div>
              {AI_ACTIONS.map(action => (
                <button
                  key={action.key}
                  className={cn('p-1.5 rounded flex items-center gap-1 transition-colors', action.color)}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  onClick={() => handleAIAction(action)}
                >
                  <span className="text-[10px] tracking-widest">{uiText(...action.label)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
