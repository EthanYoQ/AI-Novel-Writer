import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import CodeMirror, { ReactCodeMirrorRef, EditorView, ViewUpdate } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState, type Extension } from '@codemirror/state'
import { openSearchPanel, closeSearchPanel, search } from '@codemirror/search'
import { Sparkles, Bold, Check, MessageSquareText } from 'lucide-react'
import { Button } from '../ui/Button'
import { paragraphIndent } from './paragraph-indent'
import { proseTab } from './prose-tab'
import { useThemeStore } from '../../stores/theme-store'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { createEditorInlineGeneration } from '../../services/editor-inline-generation'
import { EDITOR_INLINE_INSTRUCTION_MAX_LENGTH, type EditorInlineFixedAction, type EditorInlineRequest } from '../../shared/editor-inline-generation'
import { useLLMStore } from '../../stores/llm-store'
import { countDraftUnits } from '../../shared/draft-units'
import { useLocaleStore } from '../../stores/locale-store'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { livePreview, paperHeadFacet, type PaperHead } from './live-preview'
import { commandKeyLabel, isComposing } from '../stage/shortcut-keys'

export type CodeMirrorEditorProps = {
  content: string
  filePath?: string
  recoveryHandle?: MainGenerationRunHandle
  onGenerationHandle?: (handle: MainGenerationRunHandle) => void
  editable?: boolean
  onChange?: (content: string) => void
  onSave?: (content: string) => Promise<void> | void
  onCharCountChange?: (count: number) => void
  placeholder?: string
  hideStatusBar?: boolean
  mode?: 'document' | 'prose'
  paperHead?: PaperHead | null
  /** 编辑器随内容长高、不自己滚动，由外层页面一起滚动（单章视图的纸面）。 */
  fitContent?: boolean
  /** 段落首行缩进两字（只是显示，见 paragraph-indent）。 */
  paragraphIndent?: boolean
}

type Label = readonly [string, string]

function clampBubbleLeft(centerLeft: number, halfWidth: number): number {
  if (!halfWidth) return centerLeft
  return Math.min(Math.max(centerLeft, halfWidth + 8), window.innerWidth - halfWidth - 8)
}

function clampBubbleTop(bottom: number, height: number): number {
  return Math.max(bottom, height + 8)
}

// 圈选一大段并向下滚动、选区顶部滚出视区时，气泡悬浮在视区顶部边缘，直到选区底部也滚出视区。
function selectionBubbleTop(top: number, bottom: number, viewRect: DOMRect): number {
  const anchor = top - 5
  return anchor < viewRect.top + 45 ? Math.min(viewRect.top + 45, bottom - 10) : anchor
}

const AI_ACTIONS: readonly { key: EditorInlineFixedAction; label: Label }[] = [
  { key: 'refine', label: ['润色', 'Refine'] },
  { key: 'expand', label: ['扩写', 'Expand'] },
  { key: 'continue', label: ['续写', 'Continue'] },
  { key: 'dialogue', label: ['改成对话', 'To dialogue'] },
]
const NOTE_LABEL: Label = ['按意见改', 'Revise with note']
const actionLabel = (action: EditorInlineRequest['action']): Label => action === 'instruct' ? NOTE_LABEL : AI_ACTIONS.find(item => item.key === action)!.label

export default function CodeMirrorEditor({
  content,
  filePath,
  recoveryHandle,
  onGenerationHandle,
  editable = true,
  onChange,
  onSave,
  onCharCountChange,
  placeholder,
  mode = 'document',
  paperHead = null,
  fitContent = false,
  paragraphIndent: indentParagraphs = false,
}: CodeMirrorEditorProps) {
  const inkThemeName = useThemeStore(s => s.resolvedTheme)
  const uiText = useLocaleStore(s => s.text)
  const uiLocale = useLocaleStore(s => s.locale)
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  // 避免状态回路
  const lastEmittedContentRef = useRef(content)
  const [editorContent, setEditorContent] = useState(content)
  const hasEmittedInitialCount = useRef(false)
  const composingRef = useRef(false)
  const pendingExternalContentRef = useRef<string | null>(null)
  const latestContentPropRef = useRef(content)
  const charCountHandlerRef = useRef(onCharCountChange)
  useLayoutEffect(() => {
    latestContentPropRef.current = content
    charCountHandlerRef.current = onCharCountChange
  }, [content, onCharCountChange])

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])
  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false
    queueMicrotask(() => {
      const pending = pendingExternalContentRef.current
      if (pending === null) return
      pendingExternalContentRef.current = null
      if (pending !== latestContentPropRef.current) return
      lastEmittedContentRef.current = pending
      setEditorContent(pending)
      charCountHandlerRef.current?.(countDraftUnits(pending))
    })
  }, [])

  // 更新内容
  useEffect(() => {
    // 首次挂载时主动汇报一次字数
    if (!hasEmittedInitialCount.current) {
      onCharCountChange?.(countDraftUnits(content))
      hasEmittedInitialCount.current = true
    }

    if (content !== lastEmittedContentRef.current) {
      if (composingRef.current) {
        pendingExternalContentRef.current = content
        return
      }
      pendingExternalContentRef.current = null
      lastEmittedContentRef.current = content
      setEditorContent(content)
      // 内容经由外部变动（例如打开新文件）
      onCharCountChange?.(countDraftUnits(content))
    }
  }, [content, onCharCountChange])

  // ===== Bubble Menu 逻辑 =====
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubblePos, setBubblePos] = useState({ top: 0, left: 0, inView: true })
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [activeAIAction, setActiveAIAction] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState<string | null>(null)
  const [activeNote, setActiveNote] = useState<string | null>(null)
  const [bubbleSize, setBubbleSize] = useState({ width: 0, height: 0 })
  const bubbleRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const measure = () => setBubbleSize(size => size.width === node.offsetWidth && size.height === node.offsetHeight ? size : { width: node.offsetWidth, height: node.offsetHeight })
    measure()
    // 同步重排，内容长高的这一帧绘制前就夹紧到位，不先画在视口外。
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const bubbleLeft = clampBubbleLeft(bubblePos.left, bubbleSize.width / 2)
  const bubbleTop = bubblePos.inView ? clampBubbleTop(bubblePos.top, bubbleSize.height) : bubblePos.top
  const [loadingDots, setLoadingDots] = useState('.')
  const [selectionRange, setSelectionRange] = useState<{ from: number, to: number } | null>(null)
  const aiRequestSequenceRef = useRef(0)
  const aiTargetRef = useRef<{
    requestSequence: number
    from: number
    to: number
    selectedText: string
    documentText: string
    filePath?: string
    sessionKey: string
  } | null>(null)

  const editableRef = useRef(editable)
  const filePathRef = useRef(filePath)
  useLayoutEffect(() => { editableRef.current = editable; filePathRef.current = filePath }, [editable, filePath])
  const aiCandidateRef = useRef<{ artifactId: string; textHash: string } | null>(null)
  const inlineRef = useRef<ReturnType<typeof createEditorInlineGeneration> | null>(null)
  const [canResumeAI, setCanResumeAI] = useState(false)
  const recoveryKey = recoveryHandle ? JSON.stringify(recoveryHandle) : ''
  useEffect(() => {
    if (!recoveryKey) return
    const handle = JSON.parse(recoveryKey) as MainGenerationRunHandle
    const session = getActiveProjectSessionContext()
    if (!session) return
    const sequence = ++aiRequestSequenceRef.current
    inlineRef.current?.detach()
    const client = createEditorInlineGeneration(session)
    inlineRef.current = client
    void client.open({ handle }).then(recovery => {
      if (sequence !== aiRequestSequenceRef.current) return
      const target = recovery.context
      aiTargetRef.current = { ...target, requestSequence: sequence, filePath, sessionKey: JSON.stringify(session) }
      const candidates = recovery.view.candidates ?? recovery.view.artifacts
      const latest = candidates.at(-1)
      aiCandidateRef.current = latest ? { artifactId: latest.artifactId, textHash: latest.textHash } : null
      setAiResult(latest?.text ?? '')
      const applicable = latest?.status === 'completed' && latest.compositionEligible === true && recovery.view.status !== 'cancelled' && recovery.sourceStatus === 'current'
      setAiError(applicable ? null : uiText('恢复的候选尚不可应用，可复制或继续原运行', 'The recovered candidate cannot be applied yet; copy it or continue the original run.'))
      setCanResumeAI(recovery.sourceStatus === 'current' && recovery.view.status !== 'cancelled' && recovery.view.ledger?.physicalRequests === 0 && candidates.length === 0)
      setActiveAIAction(uiText(...actionLabel(target.action)))
      setActiveNote(target.action === 'instruct' ? target.instruction : null)
      const view = editorRef.current?.view
      const from = Math.min(target.from, view?.state.doc.length ?? 0)
      setSelectionRange({ from, to: Math.min(target.to, view?.state.doc.length ?? 0) })
      const coords = view?.coordsAtPos(from)
      setBubblePos({ top: coords?.top ?? 150, left: coords?.left ?? 200, inView: true })
      setBubbleOpen(true)
    }).catch(() => { if (sequence === aiRequestSequenceRef.current) { setAiResult(''); setAiError(uiText('无法恢复原运行', 'The original run could not be restored.')); setBubbleOpen(true) } })
    return () => { client.detach(); aiRequestSequenceRef.current += 1 }
    // Navigation is explicit; later document changes are checked at acceptance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryKey])

  useEffect(() => () => {
    inlineRef.current?.detach()
    aiRequestSequenceRef.current += 1
    aiTargetRef.current = null
  }, [])

  useEffect(() => {
    if (aiResult === '') {
      const timer = setInterval(() => setLoadingDots(d => d.length >= 3 ? '.' : d + '.'), 400)
      return () => clearInterval(timer)
    }
  }, [aiResult])

  const handleUpdate = useCallback((v: ViewUpdate) => {
    if (v.docChanged) {
      const newText = v.state.doc.toString()
      lastEmittedContentRef.current = newText
      onChange?.(newText)

      const cnt = countDraftUnits(newText)
      onCharCountChange?.(cnt)
    }

    if (v.selectionSet || v.docChanged || v.geometryChanged) {
      const sel = v.state.selection.main
      if (sel.empty || sel.to - sel.from < 1) {
        if (aiResult === null) { setBubbleOpen(false); setSelectionRange(null); setNoteDraft(null) }
      } else {
        setSelectionRange({ from: sel.from, to: sel.to })
        // 交由下方的 useEffect 进行精准防越界座标计算与位置同步
        if (!aiResult) {
          setBubbleOpen(true)
        }
      }
    }
  }, [onChange, onCharCountChange, aiResult])

  // 监听滚动与缩放，实时更新 Bubble Menu 坐标
  useEffect(() => {
    if (!bubbleOpen || !selectionRange || !editorRef.current?.view) return;

    const view = editorRef.current.view;
    // 随内容长高时滚动的是外层页面，选区是否还在可见范围要按那个滚动容器算。
    const scrollDOM = fitContent ? scrollParentOf(view.dom) ?? view.scrollDOM : view.scrollDOM;

    let rafId: number;

    const updatePosition = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        const start = view.coordsAtPos(selectionRange.from)
        if (!start) {
          setBubbleOpen(false)
          return
        }
        const viewRect = scrollDOM.getBoundingClientRect()
        // 选区末尾不在渲染范围内时一定在起点之下，按延伸到无穷远处理。
        const bottom = view.coordsAtPos(selectionRange.to, -1)?.bottom ?? Infinity
        const inView = bottom >= viewRect.top && start.top <= viewRect.bottom
        setBubblePos({ top: inView ? selectionBubbleTop(start.top, bottom, viewRect) : start.top, left: start.left, inView })
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

      setBubblePos({ top: selectionBubbleTop(rect.top, rect.bottom, viewRect), left: rect.left + rect.width / 2, inView: true })
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
  }, [bubbleOpen, selectionRange, fitContent])

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
    ".cm-lp-paperhead": {
      padding: "8px 0 28px",
      textAlign: "center",
      color: "var(--color-text)",
      fontFamily: "var(--font-writing)",
    },
    ".cm-lp-paperhead h2": { margin: "0", fontSize: "1.65em", fontWeight: "600" },
    ".cm-lp-paperhead-sub": { marginTop: "6px", fontSize: "0.8em", color: "var(--color-text-muted)" },
    ".cm-lp-h": { fontWeight: "600", lineHeight: "1.5" },
    ".cm-lp-h1": { fontSize: "1.5em" },
    ".cm-lp-h2": { fontSize: "1.3em" },
    ".cm-lp-h3": { fontSize: "1.15em" },
    ".cm-lp-strong": { fontWeight: "700" },
    ".cm-lp-em": { fontStyle: "italic" },
    ".cm-lp-dropcap-char": {
      color: "var(--color-accent)",
      fontSize: "2.4em",
      fontWeight: "600",
      lineHeight: "0.8",
    },
  }), [mode])

  const paperHeadTitle = paperHead?.title ?? null
  const paperHeadSubtitle = paperHead?.subtitle ?? ''
  const stablePaperHead = useMemo<PaperHead | null>(
    () => paperHeadTitle === null ? null : { title: paperHeadTitle, subtitle: paperHeadSubtitle },
    [paperHeadTitle, paperHeadSubtitle],
  )

  // 构建扩展
  const extensions = useMemo(() => {
    const exts: Extension[] = [
      search({ top: true }),
      EditorView.lineWrapping,
      ...(mode === 'prose' ? [proseTab] : []),
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
    if (mode === 'document' || mode === 'prose') {
      exts.push(markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: mode === 'prose' ? { parseInline: [{
          name: 'HanRun',
          before: 'Escape',
          parse(cx, next, pos) {
            if (next < 0x4e00 || next > 0x9fff) return -1
            do { pos += 1 } while (pos < cx.end && cx.char(pos) >= 0x4e00 && cx.char(pos) <= 0x9fff)
            return pos
          },
        }] } : undefined,
      }))
    }
    if (mode === 'prose') exts.push(...livePreview())
    if (indentParagraphs) exts.push(paragraphIndent)
    exts.push(paperHeadFacet.of(stablePaperHead))
    return exts
  }, [mode, stablePaperHead, uiLocale, indentParagraphs])

  // AI 菜单处理（流式调用，实时显示生成内容）
  const handleAIAction = async (request: EditorInlineRequest) => {
    let requestSequence: number | null = null
    try {
      if (!selectionRange || !editorRef.current?.view || !editable) return
      const session = getActiveProjectSessionContext()
      if (!session) throw new Error('EDITOR_INLINE_PROJECT_REQUIRED')
      const view = editorRef.current.view
      requestSequence = ++aiRequestSequenceRef.current
      const input = { ...request, from: selectionRange.from, to: selectionRange.to,
        selectedText: view.state.sliceDoc(selectionRange.from, selectionRange.to), documentText: view.state.doc.toString() }
      aiTargetRef.current = { ...input, requestSequence, filePath, sessionKey: JSON.stringify(session) }
      inlineRef.current?.detach()
      const client = createEditorInlineGeneration(session)
      inlineRef.current = client
      aiCandidateRef.current = null
      setActiveAIAction(uiText(...actionLabel(request.action))); setActiveNote(request.action === 'instruct' ? request.instruction : null)
      setNoteDraft(null); setAiResult(''); setAiError(null); setCanResumeAI(false)
      const recovery = await client.open({ input, modelId: useLLMStore.getState().defaultModelId ?? '', uiActionNonce: crypto.randomUUID() })
      if (requestSequence !== aiRequestSequenceRef.current) return
      onGenerationHandle?.(recovery.view.handle)
      const receipt = await client.execute()
      if (requestSequence !== aiRequestSequenceRef.current) return
      if (receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop') {
        setAiResult('')
        setAiError(uiText('生成未完整完成，结果不可应用', 'Generation did not complete; the result cannot be applied.'))
        return
      }
      const proof = (receipt.run.candidates ?? receipt.run.artifacts).find(candidate => candidate.text === receipt.outcome.content && candidate.status === 'completed' && candidate.compositionEligible === true)
      aiCandidateRef.current = proof ? { artifactId: proof.artifactId, textHash: proof.textHash } : null
      setAiResult(receipt.outcome.content)
      if (receipt.sourceStatus !== 'current') setAiError(uiText('来源已变化，结果仅可复制', 'Sources changed; the result can only be copied.'))
    } catch {
      if (requestSequence !== aiRequestSequenceRef.current) return
      setAiResult(''); setAiError(uiText('生成失败，结果不可应用', 'Generation failed; the result cannot be applied.'))
    }
  }

  const handleResumeAI = async () => {
    const sequence = aiRequestSequenceRef.current
    setCanResumeAI(false)
    try {
      const receipt = await inlineRef.current?.execute()
      if (sequence !== aiRequestSequenceRef.current) return
      if (!receipt || receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop') throw new Error('EDITOR_INLINE_INCOMPLETE')
      const proof = (receipt.run.candidates ?? receipt.run.artifacts).find(candidate => candidate.text === receipt.outcome.content && candidate.status === 'completed' && candidate.compositionEligible === true)
      aiCandidateRef.current = proof ? { artifactId: proof.artifactId, textHash: proof.textHash } : null
      setAiResult(receipt.outcome.content); setAiError(receipt.sourceStatus === 'current' ? null : uiText('来源已变化，结果仅可复制', 'Sources changed; the result can only be copied.'))
    } catch { if (sequence === aiRequestSequenceRef.current) setAiError(uiText('原运行未完整完成，结果不可应用', 'The original run did not complete; its result cannot be applied.')) }
  }

  const handleAcceptAI = async () => {
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
      try {
        const recovery = await inlineRef.current?.read()
        if (target.requestSequence !== aiRequestSequenceRef.current) return
        const proof = (recovery?.view.candidates ?? recovery?.view.artifacts ?? []).find(candidate => candidate.artifactId === aiCandidateRef.current?.artifactId && candidate.textHash === aiCandidateRef.current?.textHash && candidate.text === aiResult && candidate.status === 'completed' && candidate.compositionEligible === true)
        if (!proof || !recovery || recovery.sourceStatus !== 'current' || recovery.view.status === 'cancelled') throw new Error('EDITOR_INLINE_SOURCE_CHANGED')
      } catch {
        if (target.requestSequence !== aiRequestSequenceRef.current) return
        setAiError(uiText('来源已变化，结果仅可复制', 'Sources changed; the result can only be copied.'))
        return
      }
      const targetStillCurrent = (
        editableRef.current
        && target.filePath === filePathRef.current
        && target.requestSequence === aiRequestSequenceRef.current
        && target.filePath === filePath
        && target.sessionKey === JSON.stringify(getActiveProjectSessionContext())
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

  const submitNote = () => {
    const instruction = noteDraft ?? ''
    if (!instruction.trim()) return
    void handleAIAction({ action: 'instruct', instruction })
  }

  const cancelNote = () => {
    setNoteDraft(null)
    editorRef.current?.view?.focus()
  }

  const handleRejectAI = () => {
    void inlineRef.current?.cancel().catch(() => {})
    setCanResumeAI(false)
    aiRequestSequenceRef.current += 1
    aiTargetRef.current = null
    setAiResult(null)
    setAiError(null)
    setBubbleOpen(false)
  }

  // 固定 basicSetup 内存引用，防止 React 每次渲染生成新对象导致内部扩展被重载（搜索框消失的罪魁祸首）
  // 正文不要补全：打字后补全请求还没结束时，它的键位表会先把 Esc 吞掉，「先 Esc 再 Tab」就移不出编辑区。
  const cmBasicSetup = useMemo(() => ({
    lineNumbers: false,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
    autocompletion: mode !== 'prose',
    completionKeymap: mode !== 'prose',
  }), [mode])

  return (
    <div className={fitContent ? 'relative' : 'relative h-full flex flex-col min-h-0'}
      onCompositionStartCapture={handleCompositionStart}
      onCompositionEndCapture={handleCompositionEnd}
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
          void Promise.resolve(onSave?.(lastEmittedContentRef.current)).catch(() => undefined)
        }
      }}>
      <div className={fitContent ? 'relative' : 'flex-1 relative min-h-0 overflow-hidden'}>
        <div className={fitContent ? undefined : 'absolute inset-0'}>
          <CodeMirror
            ref={editorRef}
            value={editorContent}
            placeholder={placeholder}
            height={fitContent ? undefined : '100%'}
            className={fitContent ? undefined : 'h-full'}
            theme={cmTheme}
            extensions={extensions}
            readOnly={!editable}
            editable={editable}
            basicSetup={cmBasicSetup}
            onUpdate={handleUpdate}
          />
        </div>
      </div>

      {/* 选区工具条：纸墨浮层，自带纸墨令牌与深浅色 */}
      {bubbleOpen && (editable || aiResult !== null) && bubblePos.top !== 0 && (
        <div
          ref={bubbleRef}
          role="toolbar"
          aria-label={uiText('选中文字的操作', 'Actions for the selected text')}
          className="paper-ink cm-selbar"
          data-theme={inkThemeName}
          data-preview={aiResult !== null || undefined}
          style={{ top: bubbleTop, left: bubbleLeft }}
          onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault() }}
        >
          {aiResult !== null ? (
            <div className="cm-selbar-preview">
              <div className="cm-selbar-title">
                <Sparkles size={13} aria-hidden="true" />
                {activeAIAction
                  ? uiText(`${activeAIAction}预览`, `${activeAIAction} preview`)
                  : uiText('AI 预览', 'AI preview')}
              </div>
              {activeNote && <p className="cm-selbar-note-quote">{activeNote}</p>}
              {aiError ? (
                <>
                  <p className="cm-selbar-error" role="alert">{aiError}</p>
                  {aiResult && <p className="cm-selbar-text">{aiResult}</p>}
                </>
              ) : aiResult === '' ? (
                <p className="cm-selbar-status" role="status">{uiText('正在生成', 'Generating')} {loadingDots}</p>
              ) : (
                <p className="cm-selbar-text">{aiResult}</p>
              )}
              <div className="cm-selbar-actions">
                {canResumeAI && <Button variant="text" size="sm" onClick={handleResumeAI}>{uiText('继续原运行', 'Continue original run')}</Button>}
                <Button variant="secondary" size="sm" onClick={handleRejectAI}>{uiText('取消', 'Cancel')}</Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={aiResult === '' || aiError !== null}
                  onClick={handleAcceptAI}
                ><Check size={13} aria-hidden="true" />{uiText('替换', 'Replace')}</Button>
              </div>
            </div>
          ) : noteDraft !== null ? (
            <form className="cm-selbar-note" onSubmit={(e) => { e.preventDefault(); submitNote() }}>
              <div className="cm-selbar-title">
                <MessageSquareText size={13} aria-hidden="true" />
                {uiText(...NOTE_LABEL)}
              </div>
              <textarea
                className="pi-input cm-selbar-note-input"
                aria-label={uiText('修改意见', 'Revision note')}
                aria-keyshortcuts="Control+Enter Meta+Enter Escape"
                placeholder={uiText('想怎么改？例如：改成第一人称，语气更冷', 'How should it change? For example: first person, colder tone')}
                rows={3}
                autoFocus
                value={noteDraft}
                onChange={(e) => setNoteDraft(Array.from(e.target.value).slice(0, EDITOR_INLINE_INSTRUCTION_MAX_LENGTH).join(''))}
                onKeyDown={(e) => {
                  if (isComposing(e.nativeEvent)) return
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelNote() }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); submitNote() }
                }}
              />
              <div className="cm-selbar-actions">
                <span className="cm-selbar-hint">{uiText(`${commandKeyLabel('Enter')} 提交`, `${commandKeyLabel('Enter')} to submit`)}</span>
                <Button variant="secondary" size="sm" type="button" onClick={cancelNote}>{uiText('取消', 'Cancel')}</Button>
                <Button variant="primary" size="sm" type="submit" disabled={!noteDraft.trim()}>{uiText('改写', 'Revise')}</Button>
              </div>
            </form>
          ) : (
            <>
              {mode === 'document' && (
                <>
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={uiText('加粗', 'Bold')}
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
                  ><Bold size={14} aria-hidden="true" /></Button>
                  <span className="cm-selbar-sep" aria-hidden="true" />
                </>
              )}
              {AI_ACTIONS.map((action, index) => (
                <Button key={action.key} variant="text" size="sm" className="cm-selbar-tool" onClick={() => handleAIAction({ action: action.key })}>
                  {index === 0 && <Sparkles size={13} aria-hidden="true" />}
                  {uiText(...action.label)}
                </Button>
              ))}
              <span className="cm-selbar-sep" aria-hidden="true" />
              <Button variant="text" size="sm" className="cm-selbar-tool" onClick={() => setNoteDraft('')}>
                <MessageSquareText size={13} aria-hidden="true" />
                {uiText(...NOTE_LABEL)}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** 最近的会纵向滚动的祖先；随内容长高的编辑器靠它判断选区是否滚出了可见范围。 */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}
