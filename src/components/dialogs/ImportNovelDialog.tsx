import { useState, useCallback, useEffect } from 'react'
import { FileUp, FolderOpen, BookOpen, FileText, Zap, Clock, AlertTriangle, RotateCcw } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { ipc } from '../../services/ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type {
  ImportInspectionSummary,
  ImportPurpose,
  ImportRunPreparationResult,
  ImportRunPrepareFromInspectionRequest,
  ImportRunSnapshot,
} from '../../shared/import-run'
import type { AuthorManuscriptImportPreview } from '../../shared/author-manuscript-import'
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
  const [purpose, setPurpose] = useState<ImportPurpose>('reference')

  // 拆章结果
  const [inspection, setInspection] = useState<ImportInspectionSummary | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')
  const [authorPreview, setAuthorPreview] = useState<AuthorManuscriptImportPreview | null>(null)
  const [authorPreviewLoading, setAuthorPreviewLoading] = useState(false)
  const [selectionPreparation, setSelectionPreparation] = useState<ImportRunPreparationResult | null>(null)
  const [selectionProjectLeaseId, setSelectionProjectLeaseId] = useState('')

  // 导入流程
  const [importing, setImporting] = useState(false)
  const [importNotice, setImportNotice] = useState('')
  const [resumableState, setResumableState] = useState<{
    projectLeaseId: string
    runs: ImportRunSnapshot[]
  } | null>(null)
  const [selectedResumableRunId, setSelectedResumableRunId] = useState('')
  const resumableRuns = resumableState && currentProject?.sessionLease === resumableState.projectLeaseId
    ? resumableState.runs.filter(run => run.purpose === purpose)
    : []
  const resumableRun = resumableRuns.find(run => run.id === selectedResumableRunId)
    ?? resumableRuns[0]
    ?? null
  const resumableRunIsActive = resumableRun
    ? activeWorkflows.some(workflow => workflow.id === resumableRun.id)
    : false
  const resumableRunCanRestart = resumableRun
    ? ['failed', 'cancelled', 'running'].includes(resumableRun.status)
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

  useEffect(() => {
    if (purpose !== 'author-manuscript' || !inspection || targetMode !== 'current' || !currentProject) {
      return
    }
    const session = captureProjectSession(currentProject)
    if (!session) return
    let active = true
    void ipc.invokeWithProjectSession(
      session,
      'db:import-run-author-preview',
      inspection.inspectionId,
      currentProject.path,
    ).then(preview => {
      if (!active || !isProjectSessionCurrent(session)) return
      setAuthorPreview(preview)
      if (preview.classification === 'conflict') {
        if (preview.authorityInvalid) {
          setSplitError(text(
            `现有权威正文不连续，请先补齐第 ${preview.firstGapChapterNumber ?? '?'} 章或清理重复定稿。`,
            `The authoritative manuscript is not continuous. Fill Chapter ${preview.firstGapChapterNumber ?? '?'} or resolve duplicate finalized chapters first.`,
          ))
        } else if (preview.conflictChapterNumbers.length > 0) {
          setSplitError(text(
            `以下章节与现有权威正文内容冲突：${preview.conflictChapterNumbers.join(', ')}。请修改编号或内容后重新选择。`,
            `These chapters conflict with authoritative manuscript text: ${preview.conflictChapterNumbers.join(', ')}. Change their numbers or content, then choose the files again.`,
          ))
        } else {
          setSplitError(text(
            `导入不能从当前下一章连续追加；请从第 ${preview.firstGapChapterNumber ?? '?'} 章开始。`,
            `The import is not a continuous append. Start with Chapter ${preview.firstGapChapterNumber ?? '?'}.`,
          ))
        }
      }
    }).catch(error => {
      if (active && isProjectSessionCurrent(session)) {
        setAuthorPreview(null)
        setSplitError(error instanceof Error ? error.message : String(error))
      }
    }).finally(() => {
      if (active && isProjectSessionCurrent(session)) setAuthorPreviewLoading(false)
    })
    return () => { active = false }
  }, [currentProject, inspection, purpose, targetMode, text])

  const changePurpose = useCallback((nextPurpose: ImportPurpose) => {
    setPurpose(nextPurpose)
    setInspection(null)
    setAuthorPreview(null)
    setAuthorPreviewLoading(false)
    setSelectionPreparation(null)
    setSelectionProjectLeaseId('')
    setSplitDone(false)
    setSplitError('')
    setImportNotice('')
    if (nextPurpose === 'author-manuscript') setTargetMode('current')
  }, [])

  /** 选择文件 */
  const handleSelectFiles = useCallback(async (
    explicitRun?: Pick<ImportRunSnapshot, 'id' | 'locale'>,
  ) => {
    setSplitting(true)
    setSplitError('')
    let operationSession: ReturnType<typeof captureProjectSession> = null
    try {
      let project = useProjectStore.getState().currentProject
      let projectSession = captureProjectSession(project)
      if (targetMode === 'new' && !explicitRun) {
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
      operationSession = projectSession
      const runId = explicitRun?.id ?? randomUUID()
      const runLocale = explicitRun?.locale ?? locale
      const result = await ipc.invoke('dialog:select-novel-files', {
        runId,
        purpose,
        locale: runLocale,
        expectedProjectPath: project.path,
      }, projectSession)
      if (!isProjectSessionCurrent(projectSession)) return
      if (!result) return
      setSplitDone(false)
      setSplitError('')
      setImportNotice('')
      setInspection(null)
      setAuthorPreview(null)
      setAuthorPreviewLoading(false)
      setSelectionPreparation(null)
      setSelectionProjectLeaseId('')
      if (purpose === 'author-manuscript' && result.success && result.inspection) {
        setAuthorPreviewLoading(true)
        setInspection(result.inspection)
        setSplitDone(true)
      } else if (purpose === 'reference' && result.success && result.preparation) {
        const prepared = result.preparation
        setSelectionPreparation(prepared)
        setSelectionProjectLeaseId(projectSession.leaseId)
        const preparedRun = prepared.run
        const chapterCount = preparedRun?.totalChapters
          ?? prepared.newChapterNumbers.length
          + prepared.duplicateChapterNumbers.length
          + prepared.conflictChapterNumbers.length
        setInspection(prepared.inspection ?? {
          inspectionId: runId,
          purpose,
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
      if (operationSession && !isProjectSessionCurrent(operationSession)) return
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [createProject, locale, name, purpose, savePath, targetMode, text])

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

  const applyPreparation = useCallback((
    preparation: ImportRunPreparationResult,
    projectSession: ProjectSessionContext,
    consumedRunId?: string,
  ) => {
    if (consumedRunId) {
      setResumableState(previous => {
        if (previous?.projectLeaseId !== projectSession.leaseId) return previous
        const runs = previous.runs.filter(run => run.id !== consumedRunId)
        return runs.length > 0 ? { ...previous, runs } : null
      })
    }
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
    launchRun(preparation.run)
  }, [launchRun, text])

  /** 执行导入 */
  const handleImport = useCallback(async () => {
    if (
      !inspection
      || (purpose === 'author-manuscript' && (!authorPreview || authorPreview.classification === 'conflict'))
      || (purpose === 'reference' && (
        !selectionPreparation
        || currentProject?.sessionLease !== selectionProjectLeaseId
      ))
      || !currentProject
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

      if (purpose === 'reference') {
        setInspection(null)
        setSplitDone(false)
        const preparation = selectionPreparation!
        setSelectionPreparation(null)
        setSelectionProjectLeaseId('')
        applyPreparation(preparation, projectSession)
        return
      }

      const prepareRequest: ImportRunPrepareFromInspectionRequest = {
        runId: randomUUID(),
        inspectionId: inspection.inspectionId,
        purpose,
        locale,
        authorityFingerprint: authorPreview!.authorityFingerprint,
        manifestFingerprint: authorPreview!.manifestFingerprint,
      }
      const prepared = await ipc.invokeWithProjectSession(
        projectSession,
        'db:import-run-prepare-inspection',
        prepareRequest,
        project.path,
      )
      if (!prepared.success || !prepared.preparation) throw new Error(prepared.error || text(
        '无法创建导入运行', 'Could not create the import run.',
      ))
      setInspection(null)
      setSplitDone(false)
      const preparation = prepared.preparation
      if (preparation.classification === 'exact-duplicate') {
        setImportNotice(text(
          '这些章节已是相同的权威定稿；未重复发布，也未创建任务。',
          'These chapters already exist as identical authoritative finalized text. Nothing was republished and no task was created.',
        ))
        return
      }
      if (preparation.classification === 'conflict') {
        const chaptersText = preparation.conflictChapterNumbers.join(', ')
        setSplitError(text(
          `原稿预览已过期或章节与权威正文冲突：${chaptersText || '请重新预览'}。`,
          `The manuscript preview is stale or conflicts with authoritative text: ${chaptersText || 'preview again'}.`,
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
      launchRun(preparation.run)
    } catch (e) {
      console.error('[ImportNovel] 导入失败:', e)
      if (purpose === 'author-manuscript') {
        setInspection(null)
        setAuthorPreview(null)
        setSplitDone(false)
      }
      setSplitError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }, [
    applyPreparation, authorPreview, currentProject, inspection, launchRun, locale, purpose,
    selectionPreparation, selectionProjectLeaseId, text,
  ])

  const handleResume = async () => {
    if (!resumableRun) return
    if (resumableRun.stage === 'parsing') {
      const completed = resumableRun.progressCompleted ?? resumableRun.completedSources ?? 0
      const total = resumableRun.progressTotal ?? resumableRun.totalSources ?? 0
      if (total < 1 || completed !== total) {
        void handleSelectFiles(resumableRun)
        return
      }
      const project = useProjectStore.getState().currentProject
      const projectSession = captureProjectSession(project)
      if (!project || !projectSession) return
      setImporting(true)
      setSplitError('')
      setImportNotice('')
      try {
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:import-run-finalize-parsing',
          resumableRun.id,
          project.path,
        )
        if (!isProjectSessionCurrent(projectSession)) return
        if (!result.success || !result.preparation) throw new Error(result.error || text(
          '无法完成已解析的导入，请重试。',
          'Could not finalize the parsed import. Please try again.',
        ))
        applyPreparation(result.preparation, projectSession, resumableRun.id)
      } catch (error) {
        if (!isProjectSessionCurrent(projectSession)) return
        setSplitError(error instanceof Error ? error.message : String(error))
      } finally {
        setImporting(false)
      }
      return
    }
    launchRun(resumableRun)
  }

  const handleRestart = async () => {
    if (!resumableRun) return
    const project = useProjectStore.getState().currentProject
    const session = captureProjectSession(project)
    if (!project || !session) return
    setImporting(true)
    setSplitError('')
    try {
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-restart',
        resumableRun.id,
        randomUUID(),
        project.path,
      )
      if (!isProjectSessionCurrent(session)) return
      if (!result.success || !result.run) throw new Error(result.error || text(
        '无法重新开始导入', 'Could not restart the import.',
      ))
      if (result.run.stage === 'parsing') {
        const restartedRun = result.run
        setResumableState(previous => {
          const previousRuns = previous?.projectLeaseId === session.leaseId ? previous.runs : []
          return {
            projectLeaseId: session.leaseId,
            runs: [restartedRun, ...previousRuns.filter(run => (
              run.id !== resumableRun.id && run.id !== restartedRun.id
            ))],
          }
        })
        setSelectedResumableRunId(restartedRun.id)
        await handleSelectFiles(restartedRun)
        if (!isProjectSessionCurrent(session)) return
        return
      }
      launchRun(result.run)
    } catch (error) {
      if (!isProjectSessionCurrent(session)) return
      setSplitError(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  // 成本预估
  const costEstimate = purpose === 'reference' && splitDone && inspection
    ? estimateImportCost(inspection.totalWords, inspection.chapterCount)
    : null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp size={18} className="text-[var(--color-accent)]" />
            {purpose === 'reference'
              ? text('小说拆解与仿写', 'Novel analysis and style study')
              : text('导入作者原稿', 'Import author manuscript')}
          </DialogTitle>
          <DialogDescription>
            {purpose === 'reference'
              ? text(
                  '选择参考小说文件，AI 将执行结构拆解、文风提取、蓝图反推，并生成后续写作可用的仿写约束。',
                  'Select reference novel files. AI will analyze their structure and style, infer blueprints, and create imitation constraints for future writing.',
                )
              : text(
                  '选择我的原稿文件，按章节号导入为当前项目的不可变权威定稿；不会进入参考语料或触发仿写拆解。',
                  'Select manuscript files to import by chapter number as immutable authoritative finalized text in the current project. They are not added to the reference corpus or imitation analysis.',
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div>
            <Label>{text('文本用途', 'Text purpose')}</Label>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={text('文本用途', 'Text purpose')}>
              <Button
                type="button"
                variant={purpose === 'reference' ? 'default' : 'outline'}
                aria-pressed={purpose === 'reference'}
                data-testid="import-purpose-reference"
                onClick={() => changePurpose('reference')}
              >
                <BookOpen size={14} />
                {text('参考小说', 'Reference novel')}
              </Button>
              <Button
                type="button"
                variant={purpose === 'author-manuscript' ? 'default' : 'outline'}
                aria-pressed={purpose === 'author-manuscript'}
                data-testid="import-purpose-author"
                onClick={() => changePurpose('author-manuscript')}
              >
                <FileText size={14} />
                {text('我的原稿', 'My manuscript')}
              </Button>
            </div>
            <div className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }} data-testid="import-purpose-explanation">
              {purpose === 'reference'
                ? text('用于知识库、结构与文风拆解，不会写入草稿箱或正文章节。', 'Used for knowledge, structure, and style analysis. It never becomes a draft or manuscript chapter.')
                : text('按章节号导入为不可变权威定稿，用于连续性与后续写作；不会进入参考语料或生成仿写拆解。', 'Imported by chapter number as immutable authoritative finalized text for continuity and future writing. It is not added to reference corpus or imitation analysis.')}
            </div>
          </div>

          <div>
            <Label>{text('导入目标', 'Import destination')}</Label>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={text('导入目标', 'Import destination')}>
              <Button
                type="button"
                variant={targetMode === 'new' ? 'default' : 'outline'}
                aria-pressed={targetMode === 'new'}
                data-testid="import-target-new"
                disabled={purpose === 'author-manuscript'}
                onClick={() => {
                  setTargetMode('new')
                  setInspection(null)
                  setAuthorPreview(null)
                  setAuthorPreviewLoading(false)
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
                  setAuthorPreview(null)
                  setAuthorPreviewLoading(false)
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
            {purpose === 'author-manuscript' && !currentProject && (
              <div className="mt-2 text-xs" style={{ color: 'var(--color-error-text)' }}>
                {text('请先打开或创建项目，再导入我的原稿。', 'Open or create a project before importing your manuscript.')}
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
                    <span className="truncate">{
                      (run.stage === 'parsing' ? run.unfinishedSourceDisplay?.[0]?.displayName : undefined)
                      ?? run.sourceDisplay[0]?.displayName
                      ?? run.id
                    }</span>
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
              {resumableRun.stage === 'parsing' && (resumableRun.unfinishedSourceDisplay?.length ?? 0) > 0 && (
                <div
                  className="text-xs"
                  style={{ color: 'var(--color-text-secondary)' }}
                  data-testid="import-unfinished-sources"
                >
                  {text(
                    `需要重新选择：${resumableRun.unfinishedSourceDisplay!.map(source => source.displayName).join('、')}`,
                    `Re-select required: ${resumableRun.unfinishedSourceDisplay!.map(source => source.displayName).join(', ')}`,
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={handleResume} disabled={importing || resumableRunIsActive}>
                  {text('继续导入', 'Continue import')}
                </Button>
                {resumableRunCanRestart && (
                  <Button type="button" size="sm" variant="outline" onClick={handleRestart} disabled={importing || resumableRunIsActive}>
                    <RotateCcw size={13} />
                    {text('重新开始', 'Start over')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ===== 文件选择 ===== */}
          <div>
            <Label>{purpose === 'reference'
              ? text('选择参考小说文件', 'Reference novel files')
              : text('选择我的原稿文件', 'My manuscript files')}</Label>
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
              <Button
                data-testid="import-source-choose"
                variant="outline"
                onClick={() => { void handleSelectFiles() }}
                disabled={splitting}
              >
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
              {purpose === 'reference'
                ? text('正在拆章并准备结构拆解...', 'Splitting chapters and preparing analysis...')
                : text('正在拆章并核对权威正文连续性...', 'Splitting chapters and checking authoritative continuity...')}
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
                {(purpose === 'author-manuscript' && authorPreview
                  ? authorPreview.chapters
                  : inspection.preview).map((ch) => (
                  <div key={ch.number} className="flex items-center justify-between text-xs">
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                      {text(`第${ch.number}章 ${ch.title}`, `Chapter ${ch.number} ${ch.title}`)}
                    </span>
                    <span className="flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
                      <span>{text(`${ch.wordCount.toLocaleString()} 字`, `${ch.wordCount.toLocaleString()} words`)}</span>
                      {purpose === 'author-manuscript' && 'disposition' in ch && (
                        <span data-testid={`author-preview-target-${ch.number}`}>
                          {ch.disposition === 'new'
                            ? text('目标：权威正文章节 / 定稿', 'Target: authoritative manuscript / finalized')
                            : ch.disposition === 'duplicate'
                              ? text('相同定稿（跳过）', 'Identical finalized text (skip)')
                              : text('冲突（阻止）', 'Conflict (blocked)')}
                        </span>
                      )}
                      {purpose === 'reference' && 'targetStatus' in ch && ch.targetStatus && (
                        <span
                          style={{ color: 'var(--color-text-secondary)' }}
                          data-testid={`import-preview-status-${ch.number}`}
                        >
                          {ch.targetStatus === 'new'
                            ? text('新增', 'New')
                            : ch.targetStatus === 'duplicate'
                              ? text('重复', 'Duplicate')
                              : text('冲突', 'Conflict')}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                {purpose === 'reference'
                  && (inspection.previewRemaining ?? inspection.chapterCount - inspection.preview.length) > 0 && (
                  <div
                    className="text-xs text-center py-1"
                    style={{ color: 'var(--color-text-muted)' }}
                    data-testid="import-preview-summary"
                  >
                    {text(
                      `已显示 ${inspection.preview.length}/${inspection.chapterCount}；剩余 ${inspection.previewRemaining ?? inspection.chapterCount - inspection.preview.length} 章`,
                      `Showing ${inspection.preview.length} of ${inspection.chapterCount}; ${inspection.previewRemaining ?? inspection.chapterCount - inspection.preview.length} remaining`,
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {purpose === 'author-manuscript' && splitDone && inspection && (
            <div className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: 'var(--color-hover)' }} data-testid="author-import-confirmation-summary">
              {authorPreviewLoading
                ? text('正在核对章节连续性与项目权威状态…', 'Checking chapter continuity and project authority…')
                : authorPreview?.classification === 'ready'
                  ? text(
                    `确认后将新增 ${authorPreview.newChapterNumbers.length} 章权威定稿；下一章为第 ${authorPreview.nextChapterNumber} 章。确认前不会写入项目。`,
                    `Confirmation will add ${authorPreview.newChapterNumbers.length} authoritative finalized chapters; the next chapter will be ${authorPreview.nextChapterNumber}. The project is not changed before confirmation.`,
                  )
                  : authorPreview?.classification === 'exact-duplicate'
                    ? text('全部章节已存在且内容相同；确认后也不会重复发布。', 'All chapters already exist with identical content. Confirmation will not republish them.')
                    : text('当前清单不能导入，请按上方提示修正。', 'This manifest cannot be imported. Follow the guidance above to correct it.')}
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
              || authorPreviewLoading
              || (purpose === 'author-manuscript' && (!authorPreview || authorPreview.classification === 'conflict'))
              || (purpose === 'reference' && (
                !selectionPreparation
                || currentProject?.sessionLease !== selectionProjectLeaseId
              ))
              || !currentProject
            }
          >
            <FileUp size={14} />
            {importing
              ? (purpose === 'author-manuscript' ? text('导入中...', 'Importing...') : text('拆解中...', 'Analyzing...'))
              : purpose === 'author-manuscript'
                ? text(`确认导入（${inspection?.chapterCount ?? 0} 章）`, `Confirm import (${inspection?.chapterCount ?? 0} chapters)`)
              : targetMode === 'current'
                ? text(`导入当前项目（${inspection?.chapterCount ?? 0} 章）`, `Import into current project (${inspection?.chapterCount ?? 0} chapters)`)
                : text(`开始拆解仿写（${inspection?.chapterCount ?? 0} 章）`, `Start analysis (${inspection?.chapterCount ?? 0} chapters)`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
