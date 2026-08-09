import { useState, useCallback, useRef, useEffect } from 'react'
import { Save, RefreshCw, Sparkles, Loader2, AlertTriangle, FileText } from 'lucide-react'
import { renderIcon } from '../panels/sidebar/sidebar-icons'

import { useEditorStore } from '../../stores/editor-store'
import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'
import { Button } from '../ui/Button'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { parseCoreField } from '../../services/vela-protocol'
import CodeMirrorEditor from './CodeMirrorEditor'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { createArchitectureWorkflow } from '../../services/workflows/architecture-workflow'
import { useWorkflowStore } from '../../stores/workflow-store'
import { globalEventBus } from '../../shared/event-bus'
import {
  ARCH_REFRESH_BLOCKED_MESSAGE,
  ARCH_PROJECT_MISMATCH_MESSAGE,
  ArchReloadGate,
  archEditStoreAction,
  decideArchExternalRefresh,
  didArchSaveSettle,
  hasUnsavedArchEdit,
  isArchProjectCurrent,
  reassertBlockedArchEdit,
  shouldRefreshArchOnWorkflowComplete,
  writeArchEditState,
} from './arch-file-refresh-policy'
import {
  canExplicitlyRepairCharacterRoster,
  getCharacterRosterRepairPresentation,
} from './character-roster-repair-state'
import { useCharacterRosterRepair } from './use-character-roster-repair'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

/** 与 Sidebar / WorldBuildingEditor 保持一致的架构文件元信息 */
const ARCH_META: Record<ArchStepKey, { iconName: string; label: string; desc: string }> = {
  premise: { iconName: 'target', label: '故事前提', desc: 'Logline、核心冲突、金手指定位' },
  characters: { iconName: 'users', label: '角色图谱', desc: '角色弧光、关系网、矛盾交织' },
  worldbuilding: { iconName: 'globe', label: '世界观', desc: '核心规则、阶层断层、深层危机' },
  synopsis: { iconName: 'map', label: '情节大纲', desc: '三幕式情节骨架' },
}

/** 从文件路径推断出 ArchStepKey */
function detectStepKey(filePath: string): ArchStepKey | null {
  if (filePath.endsWith('premise.md')) return 'premise'
  if (filePath.endsWith('characters.md')) return 'characters'
  if (filePath.endsWith('worldbuilding.md')) return 'worldbuilding'
  if (filePath.endsWith('synopsis.md')) return 'synopsis'
  return null
}

interface Props {
  tabId: string
  filePath: string
  projectKey: string
  content: string
  savedContent: string
}

/**
 * 架构文件编辑器（Markdown 文件 WYSIWYG 编辑）
 * - 使用 CodeMirrorEditor（document 模式）+ hideStatusBar，底部栏信息整合到本组件工具栏
 * - 脏状态通过比较内容字符串判断，不依赖 onChange 时机
 */
export default function ArchFileViewer(props: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const projectSession = captureProjectSession(currentProject)
  const sessionKey = projectSession && isProjectSessionPath(projectSession, props.projectKey)
    ? `${projectSession.projectId}:${projectSession.leaseId}`
    : `inactive:${props.projectKey}`

  // 同一路径重新打开会产生新 lease；重挂载可隔离旧会话的编辑器临时状态。
  return <ArchFileViewerSession key={sessionKey} {...props} />
}

function ArchFileViewerSession({
  tabId,
  filePath,
  projectKey,
  content: initialContent,
  savedContent: initialSavedContent,
}: Props) {
  const stepKey = detectStepKey(filePath)
  const isCharacterProjection = stepKey === 'characters'
  const meta = stepKey ? ARCH_META[stepKey] : null
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const currentProjectKey = currentProject?.path
  const projectMatches = isArchProjectCurrent(projectKey, currentProjectKey)

  // 磁盘上的内容（已保存的基准）
  const savedContentRef = useRef(initialSavedContent)
  // 编辑器当前内容（用 ref 而非 state，避免每次键入都重渲染导致光标跳末尾）
  const currentContentRef = useRef(initialContent)
  // 传给 CodeMirrorEditor 的初始内容（只有『外部重载』时才更新，不随用户键入变化）
  const [editorContent, setEditorContent] = useState(initialContent)

  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [checkingArch, setCheckingArch] = useState(false)
  const [fullArchStatus, setFullArchStatus] = useState<Record<string, boolean>>({})
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const [refreshBlockedMessage, setRefreshBlockedMessage] = useState<string | null>(null)
  const reloadGateRef = useRef(new ArchReloadGate())

  const isArchRunning = useWorkflowStore(s => s.isTypeRunning('architecture_generation'))
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: isCharacterProjection })

  // 中文字数（由 CodeMirrorEditor 回调更新）
  const [charCount, setCharCount] = useState(0)

  // 脚状态（独立 state，不跟着 content 走）
  const [isDirty, setIsDirty] = useState(initialContent !== initialSavedContent)
  const visibleBlockedMessage = projectMatches
    ? refreshBlockedMessage
    : ARCH_PROJECT_MISMATCH_MESSAGE

  // 外部内容更新时的热重载（拦截 store.syncTabContent 带来的 props.content 更新）
  useEffect(() => {
    if (!projectMatches) return
    const decision = decideArchExternalRefresh({
      savedContent: savedContentRef.current,
      currentContent: currentContentRef.current,
    }, initialContent)
    if (decision.kind === 'blocked') {
      reassertBlockedArchEdit(
        useEditorStore.getState(),
        tabId,
        currentContentRef.current,
      )
      setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
      return
    }
    if (decision.kind === 'apply') {
      reloadGateRef.current.recordContentChange()
      setLoading(false)
      savedContentRef.current = initialContent
      currentContentRef.current = initialContent
      setEditorContent(initialContent)
      setIsDirty(false)
      setRefreshBlockedMessage(null)
    }
  }, [initialContent, projectMatches, tabId])


  // 内容变化回调：更新 ref，不触发重渲染，避免 content prop 回传导致光标跳末尾
  const handleChange = useCallback((md: string) => {
    if (isCharacterProjection) return
    reloadGateRef.current.recordContentChange()
    setLoading(false)
    currentContentRef.current = md
    const storeAction = archEditStoreAction({
      savedContent: savedContentRef.current,
      currentContent: md,
    })
    const dirty = storeAction === 'update-dirty'
    setIsDirty(dirty)
    // 同步 editor-store 的 tab.dirty，供标题栏警示灯、Tab 圆点、关闭确认使用
    writeArchEditState(useEditorStore.getState(), tabId, md, storeAction)
  }, [isCharacterProjection, tabId])

  /** 保存（统一走 vela://core/ DB 路径） */
  const handleSave = useCallback(async (md: string) => {
    if (isCharacterProjection) return
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    reloadGateRef.current.invalidate()
    setLoading(false)
    setSaving(true)
    try {
      if (filePath.startsWith('vela://core/')) {
        const dbField = parseCoreField(filePath)
        if (!dbField) return
        requireIpcSuccess(await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-update',
          { [dbField]: md },
          projectSession.projectPath,
        ), '保存架构文件')
      } else {
        // DB 化后架构文件不应有物理路径；如果意外触发，尝试 FS 写入兜底
        console.warn('[ArchFileViewer] 非预期的物理路径保存:', filePath)
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'fs:write-file',
            filePath,
            md,
            projectSession.projectPath,
          ),
          '保存架构文件',
        )
      }
      if (isProjectSessionCurrent(projectSession)) {
        reloadGateRef.current.invalidate()
        setLoading(false)
        savedContentRef.current = md
        if (didArchSaveSettle(md, currentContentRef.current)) {
          setIsDirty(false)
          setRefreshBlockedMessage(null)
          useEditorStore.getState().markTabSaved(tabId, md)
        } else {
          setIsDirty(true)
          useEditorStore.getState().updateTabContent(tabId, currentContentRef.current)
        }
      }
    } finally {
      if (isProjectSessionCurrent(projectSession)) setSaving(false)
    }
  }, [filePath, isCharacterProjection, projectKey, tabId])

  /** 从 DB 重新加载（AI 生成后刷新用） */
  const handleReload = useCallback(async () => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    if (hasUnsavedArchEdit({
      savedContent: savedContentRef.current,
      currentContent: currentContentRef.current,
    })) {
      reassertBlockedArchEdit(
        useEditorStore.getState(),
        tabId,
        currentContentRef.current,
      )
      setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
      return
    }

    const reloadToken = reloadGateRef.current.begin()
    setLoading(true)
    try {
      let newContent = ''
      if (filePath.startsWith('vela://core/')) {
        const core = await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-get',
          projectSession.projectPath,
        )
        const dbField = parseCoreField(filePath)
        newContent = dbField && core
          ? String(core[dbField as keyof typeof core] ?? '')
          : ''
      } else {
        // 数据库存储后，架构文件不应再有物理路径。
        console.warn('[ArchFileViewer] 非预期的物理路径刷新:', filePath)
        const res = await ipc.invokeWithProjectSession(
          projectSession,
          'fs:read-file',
          filePath,
          projectSession.projectPath,
        )
        if (res.success) newContent = res.content
      }
      const currentTab = useEditorStore.getState().tabs.find(tab => tab.id === tabId)
      if (
        !reloadGateRef.current.isCurrent(reloadToken)
        || !isProjectSessionCurrent(projectSession)
        || currentTab?.projectKey !== projectKey
      ) {
        return
      }
      const decision = decideArchExternalRefresh({
        savedContent: savedContentRef.current,
        currentContent: currentContentRef.current,
      }, newContent)
      if (decision.kind === 'blocked') {
        reassertBlockedArchEdit(
          useEditorStore.getState(),
          tabId,
          currentContentRef.current,
        )
        setRefreshBlockedMessage(ARCH_REFRESH_BLOCKED_MESSAGE)
        return
      }
      if (decision.kind === 'apply') {
        savedContentRef.current = decision.content
        currentContentRef.current = decision.content
        setEditorContent(decision.content)
        setIsDirty(false)
        setRefreshBlockedMessage(null)
        useEditorStore.getState().markTabSaved(tabId, decision.content)
      }
    } catch (error) {
      if (
        reloadGateRef.current.isCurrent(reloadToken)
        && isProjectSessionCurrent(projectSession)
      ) {
        console.warn('[ArchFileViewer] 架构文档刷新失败:', error)
      }
    } finally {
      if (reloadGateRef.current.isCurrent(reloadToken) && isProjectSessionCurrent(projectSession)) {
        setLoading(false)
      }
    }
  }, [filePath, projectKey, tabId])

  useEffect(() => {
    const reloadGate = reloadGateRef.current
    return () => {
      reloadGate.invalidate()
    }
  }, [])

  // 监听架构生成完成事件，自动刷新当前页面
  useEffect(() => {
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      void handleReload()
      void loadCharacterRosterStatus()
    })
  }, [handleReload, loadCharacterRosterStatus, projectKey])

  /** 确认后启动架构生成工作流 */
  const handleConfirm = async (selectedSteps: ArchStepKey[], stepGuidance: Record<string, string>) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return
    useWorkflowStore.getState().startWorkflow(createArchitectureWorkflow({
      projectPath: projectSession.projectPath,
      projectSession,
      selectedSteps,
      stepGuidance,
    }))
  }

  const handleOpenDialog = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!stepKey || !projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      return
    }
    setCheckingArch(true)
    try {
      const core = await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-get',
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      const status: Record<string, boolean> = {
        premise: !!core?.premise && core.premise.length > 50 && !core.premise.includes('待生成'),
        characters: rosterSnapshot?.status === 'ready',
        worldbuilding: !!core?.worldbuilding && core.worldbuilding.length > 50 && !core.worldbuilding.includes('待生成'),
        synopsis: !!core?.synopsis && core.synopsis.length > 50 && !core.synopsis.includes('待生成'),
      }

      // 对于当前文件，如果编辑器内已修改但未保存，也暂时以前面的基准为准即可
      const EditorContentLen = currentContentRef.current.length;
      if (EditorContentLen > 50 && !currentContentRef.current.includes('待生成')) {
        status[stepKey] = true
      }
      setFullArchStatus(status)
      setShowDialog(true)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) {
        console.warn('[ArchFileViewer] 检查架构状态失败:', error)
      }
    } finally {
      if (isProjectSessionCurrent(projectSession)) setCheckingArch(false)
    }
  }

  const generated = initialContent.length > 50 && !initialContent.includes('待生成')

  const rosterPresentation = stepKey === 'characters'
    ? getCharacterRosterRepairPresentation(rosterSnapshot, text, rosterRepairError)
    : null
  const canRepairRoster = canExplicitlyRepairCharacterRoster(rosterPresentation)
  const discardCharacterProjectionDraft = useCallback(() => {
    if (!isCharacterProjection) return
    // 旧版未保存 Markdown 草稿仍停留在只读编辑器中，作者可先复制。只有
    // 明确点击后才放弃该草稿并接受当前确定性投影。
    const projection = rosterSnapshot?.renderedMarkdown ?? initialSavedContent
    savedContentRef.current = projection
    currentContentRef.current = projection
    setEditorContent(projection)
    setIsDirty(false)
    writeArchEditState(useEditorStore.getState(), tabId, projection, 'sync-saved')
  }, [initialSavedContent, isCharacterProjection, rosterSnapshot?.renderedMarkdown, tabId])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 工具栏（背景与编辑区一致，内嵌在内容区中而非独立标题栏） */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        {/* 左侧：Emoji + 标题 + 描述 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>{meta ? renderIcon(meta.iconName, 14) : <FileText size={14} />}</span>
          <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
            {meta?.label ?? '架构文档'}
          </span>
          {meta && (
            <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--color-text-muted)' }}>
              — {meta.desc}
            </span>
          )}
        </div>

        {/* 右侧：字数 + 状态 + 操作按钮 */}
        <div className="flex items-center gap-2 flex-shrink-0">

          {/* 字数 */}
          {charCount > 0 && (
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {charCount.toLocaleString()} 字
            </span>
          )}

          {/* 保存状态 */}
          {saving && (
            <span className="text-xs" style={{ color: 'var(--color-accent)' }}>保存中...</span>
          )}
          {isDirty && !saving && (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--color-warning)' }} title="有未保存的修改" />
          )}

          {/* 刷新按钮 */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleReload}
            title="从磁盘重新加载（AI 生成完成后可点击刷新）"
            disabled={loading || !projectMatches}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>

          {/* 保存按钮（有修改时才显示） */}
          {!isCharacterProjection && isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSave(currentContentRef.current)}
              disabled={saving || !projectMatches}
              title="保存（Cmd+S）"
            >
              <Save size={12} />
              保存
            </Button>
          )}

          {/* 旧项目只可显式安全修复；不再从 Markdown 标题/排版提取角色卡。 */}
          {stepKey === 'characters' && canRepairRoster && !isArchRunning && rosterPresentation?.actionLabel && (
            <Button
              size="sm"
              disabled={extracting || !projectMatches}
              onClick={() => { void handleRepairCharacterRoster() }}
              className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm hover:from-amber-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
              title={rosterPresentation.actionTitle}
            >
              {extracting
                ? <RefreshCw size={12} className="animate-spin opacity-90" />
                : <AlertTriangle size={12} className="opacity-90" />
              }
              {extracting ? text('处理中...', 'Working...') : rosterPresentation.actionLabel}
            </Button>
          )}

          {/* AI 生成按钮 */}
          {stepKey && (
            <Button
              variant="ai"
              size="sm"
              onClick={handleOpenDialog}
              disabled={checkingArch || !projectMatches}
              title={`AI ${generated ? '重新生成' : '生成'}「${meta?.label}」`}
            >
              {checkingArch ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {generated ? 'AI 重新生成' : 'AI 生成'}
            </Button>
          )}
        </div>
      </div>

      {stepKey === 'characters' && rosterPresentation && (
        <div
          role="status"
          className="flex items-start gap-2 px-3 py-2 text-xs"
          style={{
            color: rosterPresentation.kind === 'ready' || rosterPresentation.kind === 'empty'
              ? 'var(--color-text-secondary)'
              : 'var(--color-warning)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {rosterPresentation.kind === 'ready' || rosterPresentation.kind === 'empty'
            ? <FileText size={13} className="flex-shrink-0 mt-0.5" />
            : <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />}
          <span><strong>{rosterPresentation.label}</strong> · {rosterPresentation.description}</span>
        </div>
      )}

      {isCharacterProjection && (
        <div
          role="note"
          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
          style={{
            color: 'var(--color-text-secondary)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span>{text(
            '角色图谱由角色名单自动生成，只读展示。请到「角色管理」修改角色身份、资料和关系。',
            'The character graph is a read-only projection of the roster. Edit identity, profile, and relationships in Character Management.',
          )}</span>
          {isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={discardCharacterProjectionDraft}
              title={text('旧草稿可先复制；点击后明确放弃并加载当前角色图谱', 'Copy the legacy draft first; this explicitly discards it and loads the current character graph.')}
            >
              {text('放弃旧草稿并加载投影', 'Discard draft and load projection')}
            </Button>
          )}
        </div>
      )}

      {visibleBlockedMessage && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-2 text-xs"
          style={{
            color: 'var(--color-warning)',
            backgroundColor: 'var(--color-editor-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>{visibleBlockedMessage}</span>
        </div>
      )}

      {/* CodeMirrorEditor document 模式，隐藏底部栏（信息已整合到上方工具栏） */}
      <div className="flex-1 overflow-hidden">
        <CodeMirrorEditor
          mode="document"
          content={editorContent}
          filePath={filePath}
          editable={!isCharacterProjection}
          onChange={isCharacterProjection ? undefined : handleChange}
          onSave={isCharacterProjection ? undefined : handleSave}
          onCharCountChange={setCharCount}
          hideStatusBar
          placeholder="尚未生成内容，点击右上角「AI 生成」或直接在此编辑..."
        />
      </div>

      {/* AI 生成确认弹窗 */}
      {stepKey && (
        <ArchitectureConfirmDialog
          isOpen={showDialog}
          onClose={() => setShowDialog(false)}
          archStatus={fullArchStatus}
          initialSelectedSteps={[stepKey]}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  )
}
