import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, CheckCircle2, Circle, RefreshCw, FileText, BookOpen, AlertTriangle, FolderTree } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useCharacterStore } from '../../stores/character-store'
import { renderIcon } from '../panels/sidebar/sidebar-icons'

import ArchitectureConfirmDialog from '../dialogs/ArchitectureConfirmDialog'

import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { ipc } from '../../services/ipc-client'

import { ARCH_CHARACTER_SCOPE, runArchCharacterExtract, createArchitectureWorkflow } from '../../services/workflows/architecture-workflow'
import { readPostProcessStatus, type PostProcessStatus } from '../../services/workflows/workflow-utils'
import { globalEventBus } from '../../shared/event-bus'
import {
  createProjectArchTabId,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
} from './arch-file-refresh-policy'
import { LatestRequestGate } from './latest-request-gate'
import { isCharacterExtractionReady } from './character-extraction-policy'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'

type ArchStepKey = 'premise' | 'characters' | 'worldbuilding' | 'synopsis'

const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  label: string
  iconName: string
  desc: string
}> = [
    { key: 'premise', fileName: 'premise.md', label: '故事前提', iconName: 'target', desc: 'Logline · 核心冲突链 · 金手指定位 · 悬念骨架' },
    { key: 'characters', fileName: 'characters.md', label: '角色图谱', iconName: 'users', desc: '角色弧光 · 关系网络 · 矛盾交织' },
    { key: 'worldbuilding', fileName: 'worldbuilding.md', label: '世界观', iconName: 'globe', desc: '核心规则 · 阶层断层 · 深层危机' },
    { key: 'synopsis', fileName: 'synopsis.md', label: '情节大纲', iconName: 'map', desc: '三幕结构 · 拐点节奏 · 伏笔闭环' },
  ]

/** 故事架构编辑器 — 显示四个架构文件状态，并提供 AI 生成入口 */
export default function WorldBuildingEditor({ projectKey }: { projectKey: string }) {
  // ✅ 精确订阅，避免 novelConfig 等变化导致不必要的 loadStatus 重建
  const currentProject = useProjectStore(s => s.currentProject)
  const projectMatches = currentProject?.path === projectKey
  const characters = useCharacterStore(s => s.characters)
  const characterDataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const characterLoadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const characterLoadError = useCharacterStore(s => s.lastError)
  // 角色数据由 ProjectService 统一加载，组件只消费
  const characterCount = characters.length
  const characterExtractionReady = isCharacterExtractionReady({
    projectKey,
    dataProjectKey: characterDataProjectKey,
    loadingProjectKey: characterLoadingProjectKey,
    lastError: characterLoadError,
    characterCount,
  })
  const [archStatus, setArchStatus] = useState<Record<string, boolean>>({})
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [showArchDialog, setShowArchDialog] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const extractingRunIdRef = useRef<string | null>(null)
  const extractingSessionRef = useRef<ProjectSessionContext | null>(null)
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  // 用于强制刷新 PostProcessStatusPanel 的 key
  const [, setPostProcessKey] = useState(0)
  // 角色卡后处理状态（用于控制卡片边框颜色）
  const [charExtractStatus, setCharExtractStatus] = useState<PostProcessStatus | null>(null)
  const archStatusRequestGate = useRef(new LatestRequestGate())
  const characterStatusRequestGate = useRef(new LatestRequestGate())

  /** 加载各架构文件状态（通过 Service 层获取，不直接调 IPC） */
  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      archStatusRequestGate.current.begin()
      setArchStatus({})
      setWordCounts({})
      setLoading(false)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = archStatusRequestGate.current.begin()
    setLoading(true)
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectPath,
    )
    const status: Record<string, boolean> = {
      premise: (core?.premise?.length ?? 0) > 50,
      characters: (core?.charactersArch?.length ?? 0) > 50,
      worldbuilding: (core?.worldbuilding?.length ?? 0) > 50,
      synopsis: (core?.synopsis?.length ?? 0) > 50,
    }
    const counts: Record<string, number> = {
      premise: status.premise ? (core?.premise?.length ?? 0) : 0,
      characters: status.characters ? (core?.charactersArch?.length ?? 0) : 0,
      worldbuilding: status.worldbuilding ? (core?.worldbuilding?.length ?? 0) : 0,
      synopsis: status.synopsis ? (core?.synopsis?.length ?? 0) : 0,
    }
    if (
      !archStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setArchStatus(status)
    setWordCounts(counts)
    setLoading(false)
    // ✅ 只依赖 path 字符串，避免 novelConfig 等变化导致 loadStatus 重建
  }, [currentProject, projectKey, projectMatches])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [loadStatus])

  /** 加载角色卡后处理状态 */
  const loadCharExtractStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      characterStatusRequestGate.current.begin()
      setCharExtractStatus(null)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = characterStatusRequestGate.current.begin()
    const s = await readPostProcessStatus(projectPath, ARCH_CHARACTER_SCOPE, projectSession)
    if (
      !characterStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setCharExtractStatus(s)
  }, [currentProject, projectKey, projectMatches])

  useEffect(() => {
    const timer = setTimeout(() => { void loadCharExtractStatus() }, 0)
    return () => clearTimeout(timer)
  }, [loadCharExtractStatus])

  // 监听 EventBus 事件，刷新后处理状态面板
  useEffect(() => {
    const eventMatchesProjectRun = (payload: {
      projectSession: ProjectSessionContext
      runId: string
    }) =>
      (() => {
        const projectSession = captureProjectSession(currentProject)
        return !!projectSession
          && isProjectSessionCurrent(projectSession)
          && sameProjectSessionContext(projectSession, payload.projectSession)
      })()
      && payload.runId.length > 0
    const unsub1 = globalEventBus.on('ARCH_POSTPROCESS_UPDATED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      setPostProcessKey(k => k + 1)
      loadCharExtractStatus()
      if (
        extractingRunIdRef.current === payload.runId
        && isProjectSessionCurrent(extractingSessionRef.current)
      ) {
        extractingRunIdRef.current = null
        extractingSessionRef.current = null
        setExtracting(false)
      }
    })
    const unsub2 = globalEventBus.on('CHARACTER_EXTRACT_FAILED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      setPostProcessKey(k => k + 1)
      loadCharExtractStatus()
      if (
        extractingRunIdRef.current === payload.runId
        && isProjectSessionCurrent(extractingSessionRef.current)
      ) {
        extractingRunIdRef.current = null
        extractingSessionRef.current = null
        setExtracting(false)
      }
    })
    // 每步架构文件写完后实时刷新状态
    const unsub3 = globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      loadStatus()
    })
    // 整个工作流完成后也刷新一次
    const unsub4 = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      loadStatus()
    })
    return () => { unsub1(); unsub2(); unsub3(); unsub4() }
  }, [currentProject, loadCharExtractStatus, loadStatus, projectKey])



  /** 从角色图谱提取角色卡（首次提取 / 重新提取） */
  const handleExtractCharacters = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey) || extracting) return
    setExtracting(true)
    try {
      const core = await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-get',
        projectSession.projectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      const charArch = core?.charactersArch ?? ''
      if (charArch.length < 50) {
        console.error('角色图谱不存在或内容不完整')
        setExtracting(false)
        return
      }
      if (!isProjectSessionCurrent(projectSession)) return
      extractingSessionRef.current = projectSession
      extractingRunIdRef.current = runArchCharacterExtract(
        projectSession.projectPath,
        charArch,
        currentProject.novelConfig.genre,
        projectSession,
      )
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      console.error('角色卡提取失败', e)
      extractingSessionRef.current = null
      setExtracting(false)
    }
  }, [currentProject, extracting, projectKey, projectMatches])

  /** 打开单个架构文件（arch-file 类型；若 tab 已存在则刷新磁盘内容） */
  const openArchFile = async (f: typeof ARCH_FILES[number]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const filePath = `vela://core/${f.key}`
    const tabId = createProjectArchTabId(projectKey, filePath)
    let core: Record<string, unknown> | null
    try {
      core = (await ipc.invokeWithProjectSession(
        projectSession,
        'db:project-core-get',
        projectSession.projectPath,
      )) as Record<string, unknown> | null
    } catch {
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return
    const propertyKey = f.key === 'characters' ? 'charactersArch' : f.key
    const content = (core && (core[propertyKey] as string)) || ''

    const { useEditorStore } = await import('../../stores/editor-store')
    if (!isProjectSessionCurrent(projectSession)) return
    const store = useEditorStore.getState()
    const existingTab = store.tabs.find(t => t.id === tabId)
    if (existingTab) {
      store.setActiveTab(tabId)
      if (shouldSyncProjectArchTab(existingTab, projectKey)) {
        store.syncTabContent(tabId, content)
        store.markTabSaved(tabId, content)
      }
    } else {
      store.openFile({
        id: tabId,
        name: `${f.label}`,
        type: 'arch-file',
        filePath,
        content,
        savedContent: content,
        projectKey,
      })
    }
  }

  /** 确认后启动架构工作流 */
  const handleConfirm = async (selectedSteps: ArchStepKey[], stepGuidance: Record<string, string>) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const { useWorkflowStore } = await import('../../stores/workflow-store')
    if (!isProjectSessionCurrent(projectSession)) return
    useWorkflowStore.getState().startWorkflow(createArchitectureWorkflow({
      projectPath: projectSession.projectPath,
      projectSession,
      selectedSteps,
      stepGuidance,
    }))
  }

  if (!projectMatches) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              故事架构
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message="请先打开项目" opacity={0.4} />
        </div>
      </div>
    )
  }

  const generatedCount = ARCH_FILES.filter(f => archStatus[f.key]).length

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5">
          <FolderTree size={14} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            故事架构
          </span>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {generatedCount}/{ARCH_FILES.length} 已生成
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={loadStatus}
            title="刷新状态"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </Button>
          {/* AI 生成架构 — 与小说配置/章节蓝图保持一致的按钮位置 */}
          <Button
            variant="ai"
            size="sm"
            onClick={() => setShowArchDialog(true)}
            title="AI 生成故事架构（选择要生成的步骤）"
          >
            <Sparkles size={12} />
            AI 生成架构
          </Button>
        </div>
      </div>

      {/* 文件卡片列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {ARCH_FILES.map(f => {
          const generated = archStatus[f.key]
          const words = wordCounts[f.key] ?? 0
          const isCharacters = f.key === 'characters'
          // 角色图谱卡片：提取失败时显示红色警告
          const charExtractFailed = isCharacters && charExtractStatus && !charExtractStatus.allCriticalPassed
          // 动态边框颜色：提取失败 → 红 | 已生成 → 绿 | 未生成 → 默认
          const cardBorderColor = charExtractFailed
            ? 'var(--color-error, #ef4444)'
            : generated
              ? 'var(--color-success)'
              : 'var(--color-border)'
          return (
            <div key={f.key} className="space-y-2">
              <div
                className="rounded-lg border p-4 flex items-center gap-4 cursor-pointer transition-all"
                style={{
                  borderColor: cardBorderColor,
                  backgroundColor: charExtractFailed ? 'rgba(239, 68, 68, 0.03)' : 'var(--color-panel)',
                  opacity: loading ? 0.6 : 1,
                }}
                onClick={() => openArchFile(f)}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = cardBorderColor}
                title={`点击查看 — ${f.desc}`}
              >
                {/* 状态图标 */}
                {generated
                  ? <CheckCircle2 size={18} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
                  : <Circle size={18} style={{ flexShrink: 0, color: 'var(--color-text-muted)' }} />
                }

                {/* 图标 */}
                <span className="flex-shrink-0" style={{ color: generated ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}>{renderIcon(f.iconName, 24)}</span>

                {/* 标题 + 描述 */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                    {f.label}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                    {f.desc}
                  </div>
                </div>

                {/* 右侧状态标签 / 字数 / 提取按钮 */}
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {generated ? (
                    <>
                      <span className="text-[0.7rem] px-1.5 py-0.5 rounded font-medium bg-green-500/10 text-green-600 dark:text-green-400">
                        已生成
                      </span>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {words.toLocaleString()} 字符
                      </span>
                    </>
                  ) : (
                    <span
                      className="text-[0.7rem] px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: 'rgba(var(--color-accent-rgb,99 102 241),0.1)', color: 'var(--color-accent)' }}
                    >
                      待生成
                    </span>
                  )}
                  {/* 角色图谱已生成但角色卡为空时，显示重新提取按钮（带质感的警告色） */}
                  {isCharacters && generated && !loading && characterExtractionReady && (
                    <Button
                      size="sm"
                      disabled={extracting}
                      className="gap-1.5 mt-0.5 bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-sm hover:from-red-600 hover:to-orange-600 border-none hover:shadow hover:-translate-y-[0.5px] transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleExtractCharacters()
                      }}
                      title="角色档案为空，可能是因为上一次生成失败或被删除。点击重新提取"
                    >
                      {extracting
                        ? <RefreshCw size={12} className="animate-spin opacity-90" />
                        : <AlertTriangle size={12} className="opacity-90" />
                      }
                      {extracting ? '提取中...' : '提取角色卡'}
                    </Button>
                  )}
                  {/* 查看箭头提示 */}
                  {generated && !(isCharacters && !loading && characterExtractionReady) && (
                    <span className="text-[0.7rem] flex items-center gap-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      <FileText size={10} /> 点击查看
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* AI 生成架构确认弹窗 */}
      <ArchitectureConfirmDialog
        isOpen={showArchDialog}
        onClose={() => setShowArchDialog(false)}
        archStatus={archStatus}
        onConfirm={handleConfirm}
      />
    </div>
  )
}
