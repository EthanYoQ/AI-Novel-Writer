import { useState, useCallback, useEffect, useRef } from 'react'
import { FileUp, FolderOpen, BookOpen, Zap, Clock, AlertTriangle, RotateCcw } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { ipc } from '../../services/ipc-client'
import type { ImportInspectionSummary, ImportRunPreparationResult, ImportRunSnapshot } from '../../shared/import-run'
import { createImportWorkflow, estimateImportCost } from '../../services/workflows/import-workflow'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { useLocaleStore } from '../../stores/locale-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { randomUUID } from '../../utils/id'

interface ImportNovelDialogProps {
  open: boolean
  onClose: () => void
}

/** 小说拆解与仿写向导对话框 */
export default function ImportNovelDialog({ open, onClose }: ImportNovelDialogProps) {
  const createProject = useProjectStore((s) => s.createProject)
  const currentProject = useProjectStore((s) => s.currentProject)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const activeWorkflows = useWorkflowStore((s) => s.activeRuns)
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)

  // 表单状态
  const [name, setName] = useState('')
  const [savePath, setSavePath] = useState('')
  const [targetMode, setTargetMode] = useState<'new' | 'current'>('new')

  // 拆章结果
  const [inspection, setInspection] = useState<ImportInspectionSummary | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')
  const [selectionPreparation, setSelectionPreparation] = useState<ImportRunPreparationResult | null>(null)
  const [selectionProjectLeaseId, setSelectionProjectLeaseId] = useState('')
  const selectionRunId = useRef(randomUUID())

  // 导入流程
  const [importing, setImporting] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  const [resumableState, setResumableState] = useState<{
    projectLeaseId: string
    runs: ImportRunSnapshot[]
  } | null>(null)
  const [selectedResumableRunId, setSelectedResumableRunId] = useState('')
  const resumableRuns = resumableState && currentProject?.sessionLease === resumableState.projectLeaseId
    ? resumableState.runs
    : []
  const resumableRun = resumableRuns.find(run => run.id === selectedResumableRunId)
    ?? resumableRuns[0]
    ?? null
  const resumableRunIsActive = resumableRun
    ? activeWorkflows.some(workflow => workflow.id === resumableRun.id)
    : false
  const runProgress = (run: ImportRunSnapshot) => ({
    completed: run.progressCompleted ?? run.completedChapters,
    total: run.progressTotal ?? run.totalChapters,
  })

  useEffect(() => {
    if (!open || !currentProject) return
    const session = captureProjectSession(currentProject)
    if (!session) return
    let active = true
    void ipc.invokeWithProjectSession(session, 'db:import-run-list-resumable', currentProject.path)
      .then(runs => {
        if (active && isProjectSessionCurrent(session)) {
          setResumableState(runs.length > 0 ? { projectLeaseId: session.leaseId, runs } : null)
          setSelectedResumableRunId(selected => (
            runs.some(run => run.id === selected) ? selected : (runs[0]?.id ?? '')
          ))
        }
      })
      .catch(() => {
        if (active && isProjectSessionCurrent(session)) setResumableState(null)
      })
    return () => { active = false }
  }, [open, currentProject])

  /** 选择文件 */
  const handleSelectFiles = useCallback(async (resumeRunId?: string) => {
    setSplitting(true)
    try {
      let project = useProjectStore.getState().currentProject
      let projectSession = captureProjectSession(project)
      if (targetMode === 'new' && !resumeRunId) {
        if (!name.trim() || !savePath.trim()) throw new Error(text(
          '请先填写新项目名称和保存位置，再选择小说文件。',
          'Enter the new project name and save location before choosing novel files.',
        ))
        const success = await createProject({
          name: name.trim(),
          path: savePath.trim(),
          genre: '',
          targetAudience: '',
          writingLanguage: locale,
        })
        if (!success) return
        project = useProjectStore.getState().currentProject
        projectSession = captureProjectSession(project)
        setTargetMode('current')
      }
      if (!project || !projectSession) throw new Error(text(
        '目标项目缺少有效会话，已拒绝读取小说文件。',
        'The target project has no valid session, so the novel files were not read.',
      ))
      const runId = resumeRunId || selectionRunId.current
      const result = await ipc.invoke('dialog:select-novel-files', {
        runId,
        purpose: 'reference',
        locale,
        expectedProjectPath: project.path,
      }, projectSession)
      if (!result) return
      setSplitDone(false)
      setSplitError('')
      setImportNotice('')
      setInspection(null)
      setSelectionPreparation(null)
      setSelectionProjectLeaseId('')
      if (result.success && result.preparation) {
        const prepared = result.preparation
        setSelectionPreparation(prepared)
        setSelectionProjectLeaseId(projectSession.leaseId)
        const preparedRun = prepared.run
        const chapterCount = preparedRun?.totalChapters
          ?? prepared.newChapterNumbers.length
          + prepared.duplicateChapterNumbers.length
          + prepared.conflictChapterNumbers.length
        setInspection({
          inspectionId: runId,
          sourceCount: preparedRun?.sourceDisplay.length ?? 0,
          sourceDisplayNames: preparedRun?.sourceDisplay.map(source => source.displayName) ?? [],
          chapterCount,
          totalWords: preparedRun?.manifestWordCount ?? 0,
          totalBytes: preparedRun?.totalContentSize ?? 0,
          preview: [],
        })
        setSplitDone(true)
      } else {
        setSplitError(result.error || text('拆章失败', 'Could not split chapters'))
      }
    } catch (e) {
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [createProject, locale, name, savePath, targetMode, text])

  /** 选择保存路径 */
  const handleSelectFolder = useCallback(async () => {
    const selected = await ipc.invoke('dialog:select-folder')
    if (selected) setSavePath(selected)
  }, [])

  const launchRun = useCallback((run: ImportRunSnapshot) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = captureProjectSession(project)
    if (!project || !projectSession) {
      throw new Error(text('当前项目会话已失效，无法启动导入', 'The project session expired, so the import cannot start.'))
    }
    const workflow = createImportWorkflow({
      run,
      projectPath: project.path,
      projectSession,
      executionOwner: randomUUID(),
    })
    void startWorkflow(workflow, false).catch(error => {
      console.error('[ImportNovel] 导入工作流失败:', error)
    })
    if (isProjectSessionCurrent(projectSession)) onClose()
  }, [onClose, startWorkflow, text])

  /** 执行导入 */
  const handleImport = useCallback(async () => {
    if (
      !inspection
      || !selectionPreparation
      || currentProject?.sessionLease !== selectionProjectLeaseId
    ) return

    setImporting(true)
    setSplitError('')
    setImportNotice('')
    try {
      const project = useProjectStore.getState().currentProject
      const projectSession = captureProjectSession(project)
      if (!project || !projectSession) throw new Error(text(
        '目标项目缺少有效会话，已拒绝导入',
        'The target project has no valid session, so the import was rejected.',
      ))

      setInspection(null)
      setSplitDone(false)
      const preparation = selectionPreparation
      setSelectionPreparation(null)
      setSelectionProjectLeaseId('')
      if (preparation.classification === 'exact-duplicate') {
        setImportNotice(text(
          '该来源与已完成导入完全一致；未创建任务，也未调用模型。',
          'This source exactly matches a completed import. No task or model call was created.',
        ))
        return
      }
      if (preparation.classification === 'conflict') {
        const chaptersText = preparation.conflictChapterNumbers.join(', ')
        setSplitError(text(
          `以下章节号已有不同参照内容，请先调整编号或拆分文件：${chaptersText}`,
          `These chapter numbers already contain different reference content. Renumber or split them before importing: ${chaptersText}`,
        ))
        return
      }
      if (preparation.classification === 'resumable' && preparation.run) {
        setResumableState(previous => {
          const previousRuns = previous?.projectLeaseId === projectSession.leaseId ? previous.runs : []
          return {
            projectLeaseId: projectSession.leaseId,
            runs: [preparation.run!, ...previousRuns.filter(run => run.id !== preparation.run!.id)],
          }
        })
        setSelectedResumableRunId(preparation.run.id)
        setImportNotice(text(
          '发现同一来源的未完成导入，请选择继续或重新开始。',
          'An unfinished import for this source is available. Continue it or start over.',
        ))
        return
      }
      if (!preparation.run) throw new Error(text('导入运行缺少持久化记录', 'The import run has no persisted record.'))
      selectionRunId.current = randomUUID()
      launchRun(preparation.run)
    } catch (e) {
      console.error('[ImportNovel] 导入失败:', e)
      setSplitError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }, [
    inspection, selectionPreparation, selectionProjectLeaseId, currentProject, text, launchRun,
  ])

  const handleResume = useCallback(() => {
    if (!resumableRun) return
    if (resumableRun.stage === 'parsing') {
      selectionRunId.current = resumableRun.id
      void handleSelectFiles(resumableRun.id)
      return
    }
    launchRun(resumableRun)
  }, [handleSelectFiles, launchRun, resumableRun])

  const handleRestart = useCallback(async () => {
    if (!resumableRun) return
    const project = useProjectStore.getState().currentProject
    const session = captureProjectSession(project)
    if (!project || !session) return
    setImporting(true)
    try {
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-restart',
        resumableRun.id,
        randomUUID(),
        project.path,
      )
      if (!result.success || !result.run) throw new Error(result.error || text(
        '无法重新开始导入', 'Could not restart the import.',
      ))
      launchRun(result.run)
    } catch (error) {
      setSplitError(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }, [launchRun, resumableRun, text])

  // 成本预估
  const costEstimate = splitDone && inspection
    ? estimateImportCost(inspection.totalWords, inspection.chapterCount)
    : null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp size={18} className="text-[var(--color-accent)]" />
            {text('小说拆解与仿写', 'Novel analysis and style study')}
          </DialogTitle>
          <DialogDescription>{text('选择参考小说文件，AI 将执行结构拆解、文风提取、蓝图反推，并生成后续写作可用的仿写约束', 'Select a reference novel. AI will analyze its structure and style, infer a blueprint, and create writing constraints for future chapters.')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <Label>{text('导入目标', 'Import destination')}</Label>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={text('导入目标', 'Import destination')}>
              <Button
                type="button"
                variant={targetMode === 'new' ? 'default' : 'outline'}
                aria-pressed={targetMode === 'new'}
                data-testid="import-target-new"
                onClick={() => {
                  setTargetMode('new')
                  setInspection(null)
                  setSelectionPreparation(null)
                  setSelectionProjectLeaseId('')
                  setSplitDone(false)
                }}
              >
                {text('创建新项目', 'Create new project')}
              </Button>
              <Button
                type="button"
                variant={targetMode === 'current' ? 'default' : 'outline'}
                aria-pressed={targetMode === 'current'}
                data-testid="import-target-current"
                disabled={!currentProject}
                onClick={() => {
                  setTargetMode('current')
                  setInspection(null)
                  setSelectionPreparation(null)
                  setSelectionProjectLeaseId('')
                  setSplitDone(false)
                }}
              >
                {text('导入当前项目', 'Import into current project')}
              </Button>
            </div>
            {targetMode === 'current' && currentProject && (
              <div className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }} data-testid="import-current-project-name">
                {text(`当前项目：${currentProject.name}`, `Current project: ${currentProject.name}`)}
              </div>
            )}
          </div>

          {targetMode === 'current' && resumableRun && (
            <div
              className="rounded-lg px-3 py-3 space-y-2"
              style={{ border: '1px solid var(--color-warning)', backgroundColor: 'var(--color-hover)' }}
              data-testid="import-resumable-run"
            >
              <div className="flex items-center gap-2 text-xs font-medium">
                <RotateCcw size={14} />
                {text('可继续的导入', 'Resumable imports')}
              </div>
              <div className="space-y-1" data-testid="import-resumable-runs">
                {resumableRuns.map(run => (
                  <Button
                    key={run.id}
                    type="button"
                    size="sm"
                    variant={run.id === resumableRun.id ? 'default' : 'outline'}
                    aria-pressed={run.id === resumableRun.id}
                    className="w-full justify-between"
                    data-testid={`import-resumable-choice-${run.id}`}
                    onClick={() => setSelectedResumableRunId(run.id)}
                  >
                    <span className="truncate">{run.sourceDisplay[0]?.displayName ?? run.id}</span>
                    <span>{runProgress(run).completed}/{runProgress(run).total}</span>
                  </Button>
                ))}
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                {text(
                  `阶段：${resumableRun.stage}；进度：${runProgress(resumableRun).completed}/${runProgress(resumableRun).total}`,
                  `Stage: ${resumableRun.stage}; progress: ${runProgress(resumableRun).completed}/${runProgress(resumableRun).total}`,
                )}
                {resumableRun.lastError ? ` — ${resumableRun.lastError}` : ''}
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={handleResume} disabled={importing || resumableRunIsActive}>
                  {text('继续导入', 'Continue import')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={handleRestart} disabled={importing || resumableRunIsActive}>
                  <RotateCcw size={13} />
                  {text('重新开始', 'Start over')}
                </Button>
              </div>
            </div>
          )}

          {/* ===== 文件选择 ===== */}
          <div>
            <Label>{text('选择小说文件', 'Reference files')}</Label>
            <div className="flex gap-2">
              <div
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs truncate"
                style={{
                  backgroundColor: 'var(--color-input)',
                  border: '1px solid var(--color-border)',
                  color: inspection ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <BookOpen size={14} style={{ flexShrink: 0 }} />
                {inspection
                  ? text(`${inspection.sourceCount} 个文件已选择`, `${inspection.sourceCount} files selected`)
                  : text('支持 .txt / .md 文件（单个或多个）', 'Supports one or more .txt / .md files')}
              </div>
              <Button variant="outline" onClick={() => { void handleSelectFiles() }} disabled={splitting}>
                <FolderOpen size={14} />
                {text('选择', 'Choose')}
              </Button>
            </div>
          </div>

          {/* ===== 拆章预览 ===== */}
          {splitting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}>
              <div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
              {text('正在拆章并准备结构拆解...', 'Splitting chapters and preparing analysis...')}
            </div>
          )}

          {splitError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'color-mix(in srgb, var(--color-error) 8%, transparent)', color: 'var(--color-error-text)' }}>
              <AlertTriangle size={14} />
              {splitError}
            </div>
          )}

          {importNotice && (
            <div
              className="px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}
              data-testid="import-classification-notice"
            >
              {importNotice}
            </div>
          )}

          {splitDone && inspection && (
            <div className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--color-border)' }}>
              {/* 统计头 */}
              <div className="flex items-center gap-4 px-3 py-2"
                style={{ backgroundColor: 'var(--color-hover)' }}>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  {text(`共 ${inspection.chapterCount} 章`, `${inspection.chapterCount} chapters`)}
                </span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {text(`${inspection.totalWords.toLocaleString()} 字`, `${inspection.totalWords.toLocaleString()} words`)}
                </span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {text(
                    `平均 ${Math.round(inspection.totalWords / inspection.chapterCount).toLocaleString()} 字/章`,
                    `Average ${Math.round(inspection.totalWords / inspection.chapterCount).toLocaleString()} words/chapter`,
                  )}
                </span>
              </div>
              {/* 章节列表（最多显示 8 行 + 省略） */}
              <div className="px-3 py-2 space-y-1" style={{ maxHeight: '160px', overflowY: 'auto' }}>
                {inspection.preview.map((ch) => (
                  <div key={ch.number} className="flex items-center justify-between text-xs">
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {text(`第${ch.number}章 ${ch.title}`, `Chapter ${ch.number} ${ch.title}`)}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {text(`${ch.wordCount.toLocaleString()} 字`, `${ch.wordCount.toLocaleString()} words`)}
                    </span>
                  </div>
                ))}
                {inspection.chapterCount > inspection.preview.length && (
                  <div className="text-xs text-center py-1" style={{ color: 'var(--color-text-muted)' }}>
                    {text(
                      `还有 ${inspection.chapterCount - inspection.preview.length} 章`,
                      `${inspection.chapterCount - inspection.preview.length} more chapters`,
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===== 项目信息 ===== */}
          {targetMode === 'new' && (
            <>
              <div>
                <Label>{text('新项目名称', 'New project name')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={text('拆解后创建的新项目名称', 'Name for the analyzed project')}
                />
              </div>

              <div>
                <Label>{text('保存位置', 'Save location')}</Label>
                <div className="flex gap-2">
                  <Input
                    value={savePath}
                    onChange={(e) => setSavePath(e.target.value)}
                    placeholder={text('选择项目保存目录', 'Choose a project folder')}
                    className="flex-1"
                  />
                  <Button variant="outline" onClick={handleSelectFolder}>
                    <FolderOpen size={14} />
                    {text('选择', 'Choose')}
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* ===== Token 预估 ===== */}
          {costEstimate && (
            <div className="rounded-lg px-3 py-2.5 space-y-1.5"
              style={{
                backgroundColor: 'rgba(107, 164, 220, 0.06)',
                border: '1px solid rgba(107, 164, 220, 0.15)',
              }}>
              <div className="flex items-center gap-1.5">
                <Zap size={13} style={{ color: 'var(--color-accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  {text('预估 AI 消耗', 'Estimated AI usage')}
                </span>
              </div>
              <div className="text-xs space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {(locale === 'zh-CN'
                  ? costEstimate.breakdown.split('\n')
                  : [
                      `Global analysis: ~15K tokens`,
                      `Chapter blueprints: ~${Math.max(0, costEstimate.estimatedTokens - 15000) / 1000}K tokens`,
                      `Total: ~${costEstimate.estimatedTokens / 1000}K tokens`,
                    ]).map((line, i) => <div key={i}>{line}</div>)}
              </div>
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <Clock size={11} />
                {text(
                  `预计耗时 ~${costEstimate.estimatedMinutes} 分钟（因模型速度而异）`,
                  `About ${costEstimate.estimatedMinutes} minutes, depending on model speed`,
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            onClick={handleImport}
            disabled={
              importing
              || !inspection
              || !selectionPreparation
              || currentProject?.sessionLease !== selectionProjectLeaseId
            }
          >
            <FileUp size={14} />
            {importing
              ? text('拆解中...', 'Analyzing...')
              : targetMode === 'current'
                ? text(`导入当前项目（${inspection?.chapterCount ?? 0} 章）`, `Import into current project (${inspection?.chapterCount ?? 0} chapters)`)
                : text(`开始拆解仿写（${inspection?.chapterCount ?? 0} 章）`, `Start analysis (${inspection?.chapterCount ?? 0} chapters)`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
