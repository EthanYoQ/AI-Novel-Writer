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
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import type { DirectoryWorkflowParams } from '../../services/workflows/directory-workflow'
import {
  DEFAULT_BLUEPRINT_GENERATION_COUNT,
  getBlueprintBatchAdvice,
  MAX_BLUEPRINT_CHAPTERS_PER_TASK,
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

/** 蓝图生成配置弹框 — 选择生成范围和模式 */
export default function DirectoryConfigDialog({ isOpen, onClose, existingCount, onConfirm }: Props) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)

  // 范围选择
  const [rangeMode, setRangeMode] = useState<'front' | 'range' | 'full'>('front')
  // 覆盖/追加模式选择 (仅当 existingCount > 0 时有效)
  const [overwriteMode, setOverwriteMode] = useState<'append' | 'full'>('append')

  const [frontN, setFrontN] = useState<number | ''>(DEFAULT_BLUEPRINT_GENERATION_COUNT)
  const [rangeStart, setRangeStart] = useState<number | ''>(existingCount + 1)
  const [rangeEnd, setRangeEnd] = useState<number | ''>(existingCount + 50)
  // 节奏指导
  const [pacingGuidance, setPacingGuidance] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [pendingCharacterSyncs, setPendingCharacterSyncs] = useState<BlueprintCharacterSyncOperation[]>([])
  const [isRecoveryLoading, setIsRecoveryLoading] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [authoritativeNextChapter, setAuthoritativeNextChapter] = useState<number | null>(null)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  const [authorityLoading, setAuthorityLoading] = useState(false)

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
        const nextChapter = await readAuthoritativeNextChapter(projectSession, locale)
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeNextChapter(nextChapter)
        setRangeStart(nextChapter)
        setRangeEnd(Math.min(currentProject.novelConfig.totalChapters, nextChapter + 49))
        setAuthorityError(null)
      } catch (cause) {
        if (disposed || !isProjectSessionCurrent(projectSession)) return
        setAuthoritativeNextChapter(null)
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
  const appendStart = authoritativeNextChapter ?? existingCount + 1
  const hasPriorAuthority = appendStart > 1
  const appendByDefault = overwriteMode === 'append' && (existingCount > 0 || hasPriorAuthority)
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
          startChapter: Math.min(total, Math.max(1, Number(rangeStart) || 1)),
          count: Math.max(
            1,
            Math.min(total, Math.max(Number(rangeStart) || 1, Number(rangeEnd) || 1))
              - Math.min(total, Math.max(1, Number(rangeStart) || 1))
              + 1,
          ),
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
    try {
      frozenAuthoritativeNext = await readAuthoritativeNextChapter(projectSession, locale)
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setAuthorityError(error instanceof Error ? error.message : String(error))
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return
    setAuthoritativeNextChapter(frozenAuthoritativeNext)
    setAuthorityError(null)
    const frozenAppendByDefault = overwriteMode === 'append'
      && (existingCount > 0 || frozenAuthoritativeNext > 1)

    let params: DirectoryWorkflowParams

    if (rangeMode === 'full') {
      // 追加全量：若已无剩余章节则拒绝（覆盖模式仍可从第 1 章重生成）
      if (overwriteMode === 'append' && frozenAuthoritativeNext > total) {
        toast.warning(text('没有可追加生成的章节', 'No chapters remain to generate.'))
        return
      }
      params = { mode: overwriteMode === 'full' ? 'full' : 'append', count: 0 }
    } else if (rangeMode === 'front') {
      if (frozenAppendByDefault) {
        if (frozenAuthoritativeNext > total) {
          toast.warning(text('没有可追加生成的章节', 'No chapters remain to generate.'))
          return
        }
        const remaining = total - frozenAuthoritativeNext + 1
        const count = Math.min(remaining, Math.max(1, Number(frontN) || DEFAULT_BLUEPRINT_GENERATION_COUNT))
        params = { mode: 'append', startChapter: frozenAuthoritativeNext, count }
      } else {
        params = {
          mode: 'full',
          count: Math.min(total, Math.max(1, Number(frontN) || DEFAULT_BLUEPRINT_GENERATION_COUNT)),
        }
      }
    } else {
      // 指定范围：提交时归一化，不依赖 blur；全书已有蓝图时拒绝追加
      if (existingCount >= total) {
        toast.warning(text('没有可追加生成的章节', 'No chapters remain to generate.'))
        return
      }
      const start = Math.min(total, Math.max(1, Number(rangeStart) || 1))
      const end = Math.min(total, Math.max(start, Number(rangeEnd) || start))
      params = { mode: 'append', startChapter: start, count: Math.max(1, end - start + 1) }
    }

    const costPlan = planBlueprintGenerationCost(requestedChapterCount(params, total, frozenAuthoritativeNext))
    if (costPlan.exceedsHardLimit) {
      toast.warning(text(
        `当前范围超过单次任务安全成本上限，请拆成每段不超过 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章的范围。`,
        `This range exceeds the safe cost limit. Split it into ranges of no more than ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} chapters.`,
      ))
      return
    }

    if (!isProjectSessionCurrent(projectSession)) return
    setIsConfirming(true)
    try {
      await onConfirm({ ...params, pacingGuidance: pacingGuidance.trim() || undefined })
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
                    <Input
                      type="number"
                      value={frontN}
                      onChange={e => setFrontN(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(frontN)
                        if (!v || v < 1) setFrontN(DEFAULT_BLUEPRINT_GENERATION_COUNT)
                        else setFrontN(Math.min(total, v))
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
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
                    <Input
                      type="number"
                      value={rangeStart}
                      onChange={e => setRangeStart(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(rangeStart)
                        if (!v || v < 1) setRangeStart(1)
                        else if (v > total) setRangeStart(total)
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    {text('到 第', 'to')}
                    <Input
                      type="number"
                      value={rangeEnd}
                      onChange={e => setRangeEnd(e.target.value === '' ? '' : parseInt(e.target.value))}
                      onBlur={() => {
                        const v = Number(rangeEnd)
                        const start = Number(rangeStart) || 1
                        if (!v || v < start) setRangeEnd(start)
                        else if (v > total) setRangeEnd(total)
                      }}
                      className="w-16 h-6 text-xs px-2 py-0"
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
                ` 当前范围超过单次任务安全成本上限，请拆成每段不超过 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章。`,
                ` This exceeds the safe per-task cost limit; split it into ranges of no more than ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} chapters.`,
              )}
            </p>
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
              || authorityLoading
              || Boolean(authorityError)
              || isRecoveryLoading
              || isRecovering
              || pendingCharacterSyncs.length > 0
              || Boolean(recoveryError)
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
