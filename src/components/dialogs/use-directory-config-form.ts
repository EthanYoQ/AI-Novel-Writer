import { useEffect, useRef, useState } from 'react'
import type { BlueprintCharacterSyncOperation } from '../../../electron/repositories/blueprint-repository'
import { useProjectStore } from '../../stores/project-store'
import { toast } from '../ui/Toast'
import { useLocaleStore } from '../../stores/locale-store'
import type { DirectoryGenerationCatalog } from '../../shared/generation-owner-contract'
import { terminalDirectoryProgress } from '../../services/workflows/directory-workflow'
import type { DirectoryWorkflowParams } from '../../services/workflows/directory-workflow'
import {
  DEFAULT_BLUEPRINT_GENERATION_COUNT,
  planBlueprintGenerationCost,
} from '../../services/workflows/blueprint-batch-policy'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import {
  listPendingDirectoryCharacterSyncs,
  retryAllPendingDirectoryCharacterSyncs,
} from '../../services/workflows/directory-character-sync-recovery'
import { readAuthoritativeNextChapter } from '../../services/authoritative-chapter-sequence'
import { ipc } from '../../services/ipc-client'
import { assertPlanningActionRange, DEFAULT_PLANNING_ACTION_CHAPTERS, DEFAULT_PLANNING_TARGET_UNITS, parsePlanningTargetUnits, PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../shared/plot-outline-contract'

export interface DirectoryConfigProps {
  isOpen: boolean
  onClose: () => void
  /** 已有蓝图章节数（影响「追加」模式的默认值） */
  existingCount: number
  /** 返回是否已启动；作者在确认环节取消时返回 false，对话框保持原样、不提示。 */
  onConfirm: (params: DirectoryWorkflowParams) => Promise<boolean>
}

function requestedChapterCount(
  params: DirectoryWorkflowParams,
  totalChapters: number,
  authoritativeNextChapter: number,
): number {
  if (params.mode === 'full') {
    return params.count && params.count > 0
      ? Math.min(totalChapters, params.count)
      : totalChapters
  }
  const startChapter = params.startChapter || authoritativeNextChapter
  const remaining = Math.max(0, totalChapters - startChapter + 1)
  return params.count && params.count > 0 ? Math.min(remaining, params.count) : remaining
}

async function readHighestBlueprintChapter(
  projectPath: string,
  projectSession: NonNullable<ReturnType<typeof captureProjectSession>>,
): Promise<number> {
  const blueprints = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-get-all',
    projectPath,
  )
  return blueprints.reduce(
    (highest, blueprint) => Math.max(highest, blueprint.chapterNumber),
    0,
  )
}


/**
 * 生成章节蓝图对话框的表单：范围、每章目标、追加或覆盖、节奏指导、继续未完成的范围、重试角色同步。
 * 生成蓝图对话框用它；没有打开作品时返回 null。
 */
export function useDirectoryConfigForm({ isOpen, onClose, existingCount, onConfirm }: DirectoryConfigProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)

  // 范围选择
  const [rangeMode, setRangeMode] = useState<'front' | 'range' | 'full'>('front')
  // 覆盖/追加模式选择 (仅当 existingCount > 0 时有效)
  const [overwriteMode, setOverwriteMode] = useState<'append' | 'full'>('append')

  const [frontN, setFrontN] = useState<number | ''>(DEFAULT_PLANNING_ACTION_CHAPTERS)
  const [rangeStart, setRangeStart] = useState<number | ''>(existingCount + 1)
  const [rangeEnd, setRangeEnd] = useState<number | ''>(existingCount + DEFAULT_PLANNING_ACTION_CHAPTERS)
  const [targetUnits, setTargetUnits] = useState(String(DEFAULT_PLANNING_TARGET_UNITS))
  const [preferenceLoading, setPreferenceLoading] = useState(true)
  // 节奏指导
  const [pacingGuidance, setPacingGuidance] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [pendingCharacterSyncs, setPendingCharacterSyncs] = useState<BlueprintCharacterSyncOperation[]>([])
  const [isRecoveryLoading, setIsRecoveryLoading] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [authoritativeNextChapter, setAuthoritativeNextChapter] = useState<number | null>(null)
  const [highestBlueprintChapter, setHighestBlueprintChapter] = useState<number | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  const [authorityLoading, setAuthorityLoading] = useState(false)
  const [directoryCatalog, setDirectoryCatalog] = useState<DirectoryGenerationCatalog>({ progress: [], diagnostics: [] })
  const [progressError, setProgressError] = useState<string | null>(null)
  const [progressSessionKey, setProgressSessionKey] = useState('')
  // 范围默认值按哪次打开、从哪一章接着算出；这两者没变时（取消确认或启动失败后重开）保留作者填的起止章。
  const rangeDefaultsFor = useRef<string | null>(null)
  useEffect(() => {
    if (!isOpen) return
    let disposed = false
    void ipc.invoke('config:get').then(config => {
      if (!disposed) setTargetUnits(String(parsePlanningTargetUnits(config.blueprintTargetUnits)))
    }).catch(error => {
      if (!disposed) setLaunchError(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!disposed) setPreferenceLoading(false) })
    return () => { disposed = true; setPreferenceLoading(true) }
  }, [isOpen])
  useEffect(() => {
    if (!isOpen || !currentProject) return
    const session = captureProjectSession(currentProject)
    if (!session) return
    let disposed = false
    void ipc.invokeWithProjectSession(session, 'generation:list-directory-progress').then(catalog => {
      if (disposed || !isProjectSessionCurrent(session)) return
      setProgressSessionKey(session.projectId + ':' + session.leaseId); setProgressError(null)
      const terminals = catalog.progress.map(item => terminalDirectoryProgress(item, catalog.progress))
      setDirectoryCatalog({ ...catalog, progress: [...new Map(terminals.map(item => [item.operationId, item])).values()] })
    }).catch(error => { if (!disposed && isProjectSessionCurrent(session)) { setDirectoryCatalog({ progress: [], diagnostics: [] }); setProgressSessionKey(session.projectId + ':' + session.leaseId); setProgressError(error instanceof Error ? error.message : String(error)) } })
    return () => { disposed = true }
  }, [currentProject, isOpen])


  useEffect(() => {
    if (!isOpen || !currentProject) return
    const projectSession = captureProjectSession(currentProject)
    let disposed = false
    const loadPending = async () => {
      setIsRecoveryLoading(true)
      setPendingCharacterSyncs([])
      setRecoveryError(null)
      if (!projectSession) {
        setRecoveryError(text(
          '项目会话已切换，无法读取角色同步待办。',
          'The project session changed, so pending character syncs cannot be loaded.',
        ))
        setIsRecoveryLoading(false)
        return
      }
      try {
        const operations = await listPendingDirectoryCharacterSyncs(
          currentProject.path,
          projectSession,
        )
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setPendingCharacterSyncs(operations)
      } catch (error) {
        if (disposed) return
        setRecoveryError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) setIsRecoveryLoading(false)
      }
    }
    void loadPending()
    return () => { disposed = true }
  }, [currentProject, isOpen, text])

  useEffect(() => {
    if (!isOpen || !currentProject) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    let disposed = false
    const loadAuthority = async () => {
      setAuthorityLoading(true)
      try {
        const [nextChapter, highestBlueprint] = await Promise.all([
          readAuthoritativeNextChapter(projectSession, locale),
          readHighestBlueprintChapter(currentProject.path, projectSession),
        ])
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeNextChapter(nextChapter)
        setHighestBlueprintChapter(highestBlueprint)
        const appendStart = Math.max(highestBlueprint + 1, nextChapter)
        const defaultsKey = `${projectSession.projectId}:${projectSession.leaseId}:${appendStart}`
        if (rangeDefaultsFor.current !== defaultsKey) {
          rangeDefaultsFor.current = defaultsKey
          setRangeStart(appendStart)
          setRangeEnd(Math.min(currentProject.novelConfig.totalChapters, appendStart + DEFAULT_PLANNING_ACTION_CHAPTERS - 1))
        }
        setAuthorityError(null)
      } catch (cause) {
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeNextChapter(null)
        setHighestBlueprintChapter(null)
        setAuthorityError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed && isProjectSessionCurrent(projectSession)) setAuthorityLoading(false)
      }
    }
    void loadAuthority()
    return () => { disposed = true }
  }, [currentProject, isOpen, locale])

  if (!currentProject) return null
  const total = currentProject.novelConfig.totalChapters
  const appendStart = Math.max((highestBlueprintChapter ?? 0) + 1, authoritativeNextChapter ?? 1)
  const hasPriorAuthority = appendStart > 1
  const appendByDefault = overwriteMode === 'append' && (existingCount > 0 || hasPriorAuthority)
  const selectedRangeStart = Math.min(total, Math.max(appendStart, Number(rangeStart) || appendStart))
  const selectedRangeEnd = Math.min(total, Math.max(selectedRangeStart, Number(rangeEnd) || selectedRangeStart))
  const previewParams: DirectoryWorkflowParams = rangeMode === 'full'
    ? { mode: overwriteMode === 'full' ? 'full' : 'append', count: 0 }
    : rangeMode === 'front'
      ? appendByDefault
        ? {
            mode: 'append',
            startChapter: appendStart,
            count: Math.min(
              Math.max(0, total - appendStart + 1),
              Math.max(1, Number(frontN) || DEFAULT_BLUEPRINT_GENERATION_COUNT),
            ),
          }
        : {
            mode: 'full',
            count: Math.min(total, Math.max(1, Number(frontN) || DEFAULT_BLUEPRINT_GENERATION_COUNT)),
          }
      : {
          mode: 'append',
          startChapter: selectedRangeStart,
          count: Math.max(1, selectedRangeEnd - selectedRangeStart + 1),
        }
  const previewCost = planBlueprintGenerationCost(
    requestedChapterCount(previewParams, total, appendStart),
  )

  const handleCharacterSyncRecovery = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionCurrent(projectSession)) return
    setIsRecovering(true)
    try {
      await retryAllPendingDirectoryCharacterSyncs(currentProject.path, projectSession, locale)
      if (!isProjectSessionCurrent(projectSession)) return
      const remaining = await listPendingDirectoryCharacterSyncs(currentProject.path, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      setPendingCharacterSyncs(remaining)
      setRecoveryError(null)
      toast.info(text('角色同步修复完成，无需重新生成蓝图。', 'Character sync repaired without regenerating blueprints.'))
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsRecovering(false)
    }
  }

  const handleConfirm = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) {
      toast.warning(text(
        '项目会话已切换，已取消生成蓝图。',
        'The project session changed, so blueprint generation was cancelled.',
      ))
      return
    }
    let frozenAuthoritativeNext: number
    let frozenHighestBlueprint: number
    try {
      const authority = await Promise.all([
        readAuthoritativeNextChapter(projectSession, locale),
        readHighestBlueprintChapter(currentProject.path, projectSession),
      ])
      frozenAuthoritativeNext = authority[0]
      frozenHighestBlueprint = authority[1]
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setAuthorityError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return
    setAuthoritativeNextChapter(frozenAuthoritativeNext)
    setHighestBlueprintChapter(frozenHighestBlueprint)
    setAuthorityError(null)
    const frozenAppendStart = Math.max(frozenHighestBlueprint + 1, frozenAuthoritativeNext)
    const frozenAppendByDefault = overwriteMode === 'append'
      && (existingCount > 0 || frozenAppendStart > 1)

    const start = rangeMode === 'range' ? Number(rangeStart)
      : rangeMode === 'full' ? (overwriteMode === 'full' ? 1 : frozenAppendStart)
        : frozenAppendByDefault ? frozenAppendStart : 1
    const end = rangeMode === 'range' ? Number(rangeEnd)
      : rangeMode === 'full' ? total : Math.min(total, start + Number(frontN) - 1)
    try {
      if (rangeMode === 'front') assertPlanningActionRange({ from: 1, to: Number(frontN) })
      assertPlanningActionRange({ from: start, to: end })
      if (end > total || (rangeMode === 'range' && start < frozenAppendStart)) throw new Error('range')
    } catch {
      setLaunchError(text(`请选择有效的连续 1–${PLANNING_ACTION_CHAPTER_LIMIT} 章。全量范围过大时请改选数量或范围。`, `Select 1-${PLANNING_ACTION_CHAPTER_LIMIT} valid consecutive chapters. If the full range is larger, choose a quantity or range.`))
      return
    }
    let target: number
    try { target = parsePlanningTargetUnits(Number(targetUnits)) } catch {
      setLaunchError(text(`每章蓝图目标须为 1–${PLANNING_TARGET_UNITS_LIMIT} 的整数。`, `The blueprint target must be an integer from 1 to ${PLANNING_TARGET_UNITS_LIMIT}.`))
      return
    }
    const params: DirectoryWorkflowParams = {
      mode: rangeMode === 'range' || (rangeMode === 'full' ? overwriteMode !== 'full' : frozenAppendByDefault) ? 'append' : 'full',
      startChapter: start,
      count: end - start + 1,
      targetUnits: target,
    }

    if (!isProjectSessionCurrent(projectSession)) return
    setIsConfirming(true)
    try {
      try {
        const saved = await ipc.invoke('config:set', { blueprintTargetUnits: target })
        if (!saved.success) throw new Error(saved.error)
      } catch {
        setLaunchError(text('目标字数偏好保存失败。请重试，输入已保留。', 'Could not save the target preference. Your input is retained. Please retry.'))
        return
      }
      if (!isProjectSessionCurrent(projectSession)) return
      const started = await onConfirm({ ...params, pacingGuidance: pacingGuidance || undefined })
      setLaunchError(null)
      if (!started) return
      onClose()
      toast.info(text('已提交：正在生成章节蓝图...', 'Submitted: generating chapter blueprints...'))
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsConfirming(false)
    }
  }

  const continueOperation = async (operationId: string) => {
    const session = captureProjectSession(currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    setIsConfirming(true)
    try {
      const started = await onConfirm({ mode: 'append', continueDirectoryOperationId: operationId })
      setLaunchError(null)
      if (started) onClose()
    } catch (error) { setLaunchError(error instanceof Error ? error.message : String(error)) }
    finally { setIsConfirming(false) }
  }

  const progressShown = progressSessionKey === currentProject.id + ':' + currentProject.sessionLease

  return {
    text, currentProject, total, appendStart, hasPriorAuthority, previewCost,
    rangeMode, setRangeMode, overwriteMode, setOverwriteMode, frontN, setFrontN, rangeStart, setRangeStart, rangeEnd, setRangeEnd,
    targetUnits, setTargetUnits, preferenceLoading, pacingGuidance, setPacingGuidance,
    isConfirming, launchError, authorityError, authorityLoading,
    pendingCharacterSyncs, isRecoveryLoading, isRecovering, recoveryError,
    progressError: progressShown ? progressError : null,
    diagnostics: progressShown ? directoryCatalog.diagnostics : [],
    progress: progressShown ? directoryCatalog.progress : [],
    handleCharacterSyncRecovery, handleConfirm, continueOperation,
  }
}
