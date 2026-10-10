import { useEffect, useState } from 'react'
import { FileText, RotateCcw } from 'lucide-react'
import type { BlueprintCharacterSyncOperation } from '../../../electron/repositories/blueprint-repository'
import { useProjectStore } from '../../stores/project-store'
import { toast } from '../ui/Toast'
import { useLocaleStore } from '../../stores/locale-store'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import type { DirectoryGenerationCatalog } from '../../shared/generation-owner-contract'
import { terminalDirectoryProgress } from '../../services/workflows/directory-workflow'
import type { DirectoryWorkflowParams } from '../../services/workflows/directory-workflow'
import {
  DEFAULT_BLUEPRINT_GENERATION_COUNT,
  getBlueprintBatchAdvice,
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
import { resolveWritingLanguage } from '../../shared/writing-language'
import { assertPlanningActionRange, DEFAULT_PLANNING_ACTION_CHAPTERS, DEFAULT_PLANNING_TARGET_UNITS, parsePlanningTargetUnits, PLANNING_ACTION_CHAPTER_LIMIT, PLANNING_TARGET_UNITS_LIMIT } from '../../shared/plot-outline-contract'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 已有蓝图章节数（影响「追加」模式的默认值） */
  existingCount: number
  onConfirm: (params: DirectoryWorkflowParams) => Promise<void>
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

/** 蓝图生成配置弹框 — 选择生成范围和模式 */
export default function DirectoryConfigDialog({ isOpen, onClose, existingCount, onConfirm }: Props) {
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
        setRangeStart(appendStart)
        setRangeEnd(Math.min(currentProject.novelConfig.totalChapters, appendStart + DEFAULT_PLANNING_ACTION_CHAPTERS - 1))
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
      await retryAllPendingDirectoryCharacterSyncs(currentProject.path, projectSession)
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
      await onConfirm({ ...params, pacingGuidance: pacingGuidance || undefined })
      setLaunchError(null)
      onClose()
      toast.info(text('已提交：正在生成章节蓝图...', 'Submitted: generating chapter blueprints...'))
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsConfirming(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={16} className="text-[var(--color-accent)]" />
            {text('生成章节蓝图', 'Generate chapter blueprints')}
          </DialogTitle>
          <DialogDescription>
            {existingCount > 0
              ? text(`当前已存在 ${existingCount} 章蓝图，选择下一步操作：`, `${existingCount} chapter blueprints already exist. Choose what to do next:`)
              : hasPriorAuthority
                ? text(`权威正文已定稿至第 ${appendStart - 1} 章，下一章蓝图从第 ${appendStart} 章开始。`, `Finalized manuscript authority ends at Chapter ${appendStart - 1}; the next blueprint starts at Chapter ${appendStart}.`)
              : text(`项目共 ${total} 章，请选择生成范围：`, `The project has ${total} chapters. Choose a generation range:`)}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {progressSessionKey === currentProject.id + ':' + currentProject.sessionLease && progressError && <p role="alert" className="text-xs">{progressError}</p>}
          {progressSessionKey === currentProject.id + ':' + currentProject.sessionLease && directoryCatalog.diagnostics.length > 0 && (
            <div role="status" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-xs space-y-1">
              {[...new Set(directoryCatalog.diagnostics.map(item => item.code))].map(code => <p key={code}>
                {code === 'GENERATION_BLUEPRINTS_CLEARED'
                  ? text('蓝图已清空，旧生成记录不能续接', 'Blueprints were cleared. Previous generation runs cannot continue.')
                  : code === 'GENERATION_DIRECTORY_PROGRESS_INVALID'
                    ? text('旧蓝图生成进度校验失败，不能续接', 'Previous blueprint generation progress failed validation and cannot continue.')
                    : text('旧蓝图作者保存记录校验失败，不能续接', 'A previous author save record failed validation and cannot continue.')}
              </p>)}
              <p>{text('旧恢复稿仍可编辑或复制，也可开始新的蓝图生成', 'You can still edit or copy old recovery drafts, or start new blueprint generation.')}</p>
            </div>
          )}
          {(progressSessionKey === currentProject.id + ':' + currentProject.sessionLease ? directoryCatalog.progress : []).map(progress => (
            <div key={progress.operationId} className="rounded-lg border p-3 text-xs">
              <p>{text(
                '已保存第 ' + progress.committedRange.startChapter + '–' + progress.committedRange.endChapter + ' 章蓝图。',
                'Blueprints for chapters ' + progress.committedRange.startChapter + '–' + progress.committedRange.endChapter + ' are saved.',
              )}</p>
              {progress.remainingRange ? (
                <Button variant="outline" className="mt-2" disabled={isConfirming} onClick={async () => {
                  const session = captureProjectSession(currentProject)
                  if (!session || !isProjectSessionCurrent(session)) return
                  setIsConfirming(true)
                  try {
                    await onConfirm({ mode: 'append', continueDirectoryOperationId: progress.operationId })
                    setLaunchError(null); onClose()
                  } catch (error) { setLaunchError(error instanceof Error ? error.message : String(error)) }
                  finally { setIsConfirming(false) }
                }}>
                  {text('继续第 ' + progress.remainingRange.startChapter + '–' + progress.remainingRange.endChapter + ' 章（沿用原预算）',
                    'Continue chapters ' + progress.remainingRange.startChapter + '–' + progress.remainingRange.endChapter + ' (same budget)')}
                </Button>
              ) : <p>{text('该范围已完成。', 'This range is complete.')}</p>}
            </div>
          ))}
          {(isRecoveryLoading || pendingCharacterSyncs.length > 0 || recoveryError) && (
            <div
              className="rounded-lg border px-3 py-2.5 text-xs"
              style={{
                color: 'var(--color-text-secondary)',
                backgroundColor: 'var(--color-panel)',
                borderColor: 'var(--color-border)',
              }}
            >
              <p>
                {isRecoveryLoading
                  ? text('正在检查角色同步待办...', 'Checking pending character syncs...')
                  : pendingCharacterSyncs.length > 0
                    ? text(
                        `发现 ${pendingCharacterSyncs.length} 次角色同步待修复；蓝图已安全保存，无需重新生成。`,
                        `${pendingCharacterSyncs.length} character sync operation(s) need repair. The blueprints are already saved.`,
                      )
                    : recoveryError}
              </p>
              {!isRecoveryLoading && (pendingCharacterSyncs.length > 0 || recoveryError) && (
                <Button
                  variant="outline"
                  className="mt-2 h-7 text-xs"
                  onClick={handleCharacterSyncRecovery}
                  disabled={isRecovering}
                >
                  <RotateCcw size={13} />
                  {isRecovering
                    ? text('修复中...', 'Repairing...')
                    : text('重试角色同步', 'Retry character sync')}
                </Button>
              )}
            </div>
          )}
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              {text('生成数量 / 范围', 'Quantity / range')}
            </Label>
            <div className="space-y-3 mt-2">
              <RadioOption
                checked={rangeMode === 'front'}
                onChange={() => setRangeMode('front')}
                label={
                  <span className="flex items-center gap-2">
                    {text('批量连续生成', 'Generate next')}
                    <input
                      type="number"
                      min={1} max={PLANNING_ACTION_CHAPTER_LIMIT} step={1}
                      aria-label={text('本次蓝图章数', 'Blueprint chapters in this action')}
                      value={frontN}
                      onChange={e => setFrontN(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-16 h-6 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {text('章', 'chapters')}
                  </span>
                }
              />
              <RadioOption
                checked={rangeMode === 'range'}
                onChange={() => setRangeMode('range')}
                label={
                  <span className="flex items-center gap-2">
                    {text('指定生成：第', 'Generate range:')}
                    <input
                      type="number"
                      min={1} max={total} step={1}
                      aria-label={text('蓝图起始章', 'First blueprint chapter')}
                      value={rangeStart}
                      onChange={e => setRangeStart(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-16 h-6 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {text('到 第', 'to')}
                    <input
                      type="number"
                      min={1} max={total} step={1}
                      aria-label={text('蓝图结束章', 'Last blueprint chapter')}
                      value={rangeEnd}
                      onChange={e => setRangeEnd(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-16 h-6 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {text('章', 'chapter')}
                  </span>
                }
              />
              <RadioOption
                checked={rangeMode === 'full'}
                onChange={() => setRangeMode('full')}
                label={text(`全量生成（共 ${total} 章）`, `Generate all ${total} chapters`)}
              />
            </div>
            <p
              className="mt-3 rounded-md border px-3 py-2 text-xs leading-5"
              style={{
                color: 'var(--color-text-secondary)',
                backgroundColor: 'var(--color-panel)',
                borderColor: 'var(--color-border)',
              }}
            >
              {text(
                getBlueprintBatchAdvice('zh-CN', previewCost.chapterCount),
                getBlueprintBatchAdvice('en-US', previewCost.chapterCount),
              )}
              {previewCost.exceedsHardLimit && text(
                ' 大范围可能耗尽本次预算；已验证的连续蓝图会保存，剩余范围保持未完成。',
                ' Large ranges may exhaust this action’s budget. Validated consecutive blueprints are saved; the rest remain incomplete.',
              )}
            </p>
          </div>

          <div>
            <Label htmlFor="blueprint-target-units">
              {resolveWritingLanguage(currentProject.novelConfig.writingLanguage) === 'zh-CN'
                ? text('每章蓝图目标字数', 'Blueprint target characters per chapter')
                : text('每章蓝图目标词数', 'Blueprint target words per chapter')}
            </Label>
            <input id="blueprint-target-units" type="number" min={1} max={PLANNING_TARGET_UNITS_LIMIT} step={1}
              className="mt-1 h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 text-xs"
              value={targetUnits} disabled={preferenceLoading} onChange={event => setTargetUnits(event.target.value)} />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{text('仅作生成目标，实际内容可多可少。', 'A generation target. Actual content may be longer or shorter.')}</p>
          </div>

          {(existingCount > 0 || hasPriorAuthority) && (
            <div
              className="rounded-lg p-3 space-y-2 mt-4"
              style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                {text('针对已有数据的处理方式：', 'Existing blueprint handling:')}
              </p>
              <div className="space-y-3 mt-2">
                <RadioOption
                  checked={overwriteMode === 'append'}
                  onChange={() => setOverwriteMode('append')}
                  label={text(`追加模式：保留现有蓝图，从第 ${appendStart} 章起往后生成`, `Append: keep existing blueprints and continue from chapter ${appendStart}`)}
                />
                <RadioOption
                  checked={overwriteMode === 'full'}
                  onChange={() => setOverwriteMode('full')}
                  label={text('覆盖模式：无视现有蓝图，从第 1 章起强制覆盖生成', 'Overwrite: regenerate from chapter 1 and replace existing blueprints')}
                />
              </div>
            </div>
          )}

          {/* 节奏/风格指导（可选） */}
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              {text('节奏/风格指导（可选）', 'Pacing / style guidance (optional)')}
            </Label>
            <Textarea
              value={pacingGuidance}
              onChange={e => setPacingGuidance(e.target.value)}
              placeholder={text('如：“前30章快节奏，每章安排一个爽点。中期适当铺设伏笔和角色成长。”', 'e.g. Keep the first 30 chapters fast-paced, then add foreshadowing and character growth.')}
              rows={2}
              className="text-xs"
            />
          </div>
          {launchError && (
            <p className="whitespace-pre-line rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5 text-xs text-[var(--color-warning-text)]">
              {launchError}
            </p>
          )}
          {authorityError && (
            <p className="whitespace-pre-line rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5 text-xs text-[var(--color-warning-text)]">
              {authorityError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isConfirming || isRecovering}>{text('取消', 'Cancel')}</Button>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={
              isConfirming
              || preferenceLoading
              || authorityLoading
              || Boolean(authorityError)
              || isRecovering
            }
          >
            <FileText size={13} />
            {isConfirming ? text('启动中...', 'Starting...') : text('开始生成', 'Generate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 单选按钮选项 */
function RadioOption({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: React.ReactNode
}) {
  return (
    <label
      className="flex items-center gap-2 text-xs cursor-pointer select-none"
      style={{ color: 'var(--color-text-secondary)' }}
      onClick={onChange}
    >
      <div
        className="w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0"
        style={{
          borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
          backgroundColor: checked ? 'var(--color-accent)' : 'transparent',
        }}
      >
        {checked && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>
      {label}
    </label>
  )
}
