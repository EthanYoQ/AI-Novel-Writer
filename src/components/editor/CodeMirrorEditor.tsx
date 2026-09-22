import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react'
import CodeMirror, { ReactCodeMirrorRef, EditorView, ViewUpdate } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { openSearchPanel, closeSearchPanel, search } from '@codemirror/search'
import { Sparkles, Bold, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { createEditorInlineGeneration } from '../../services/editor-inline-generation'
import { useLLMStore } from '../../stores/llm-store'
import type { GenerationReasoningStage } from '../../shared/reasoning-types'
import { countDraftUnits } from '../../shared/draft-units'
import { useLocaleStore } from '../../stores/locale-store'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { livePreview, paperHeadFacet, type PaperHead } from './live-preview'

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
}: CodeMirrorEditorProps) {
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
      setActiveAIAction(uiText(...AI_ACTIONS.find(action => action.key === target.action)!.label))
      const view = editorRef.current?.view
      const from = Math.min(target.from, view?.state.doc.length ?? 0)
      setSelectionRange({ from, to: Math.min(target.to, view?.state.doc.length ?? 0) })
      const coords = view?.coordsAtPos(from)
      setBubblePos({ top: coords?.top ?? 150, left: coords?.left ?? 200 })
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
        if (aiResult === null) { setBubbleOpen(false); setSelectionRange(null) }
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
      ...(mode === 'prose' ? [Prec.highest(keymap.of([
        {
          key: 'Tab',
          run: (target) => {
            if (target.state.readOnly || target.state.selection.ranges.length !== 1 || !target.state.selection.main.empty) return false
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
      ]))] : []),
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
      exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
    }
    if (mode === 'prose') exts.push(...livePreview())
    exts.push(paperHeadFacet.of(stablePaperHead))
    return exts
  }, [mode, stablePaperHead, uiLocale])

  // AI 菜单处理（流式调用，实时显示生成内容）
  const handleAIAction = async (action: EditorAIAction) => {
    let requestSequence: number | null = null
    try {
      if (!selectionRange || !editorRef.current?.view || !editable) return
      const session = getActiveProjectSessionContext()
      if (!session) throw new Error('EDITOR_INLINE_PROJECT_REQUIRED')
      const view = editorRef.current.view
      requestSequence = ++aiRequestSequenceRef.current
      const input = { action: action.key, from: selectionRange.from, to: selectionRange.to,
        selectedText: view.state.sliceDoc(selectionRange.from, selectionRange.to), documentText: view.state.doc.toString() }
      aiTargetRef.current = { ...input, requestSequence, filePath, sessionKey: JSON.stringify(session) }
      inlineRef.current?.detach()
      const client = createEditorInlineGeneration(session)
      inlineRef.current = client
      aiCandidateRef.current = null
      setActiveAIAction(uiText(...action.label)); setAiResult(''); setAiError(null); setCanResumeAI(false)
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
  const cmBasicSetup = useMemo(() => ({
    lineNumbers: false,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
  }), [])

  return (
    <div className="relative h-full flex flex-col min-h-0"
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
                {canResumeAI && <button onClick={handleResumeAI}>{uiText('继续原运行', 'Continue original run')}</button>}
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
