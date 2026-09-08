import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ClipboardPaste, FileUp } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useLLMStore } from '../../stores/llm-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { selectPlanningMaterials, type PlanningMaterial } from '../../services/knowledge-service'
import { createPlanningMaterialCharacterExtractionWorkflow } from '../../services/workflows/planning-material-workflow'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { appErrorMessage } from '../../i18n/app-errors'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { Button } from '../ui/Button'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/Dialog'

interface Props { projectKey: string; compact?: boolean; disabled?: boolean }

interface ImportDraft {
  source: string
  files: PlanningMaterial[]
}

const importDraftListeners = new Set<() => void>()
const EMPTY_IMPORT_DRAFT: ImportDraft = { source: '', files: [] }
let activeImportSessionKey: string | null = null
let activeImportDraft: ImportDraft = EMPTY_IMPORT_DRAFT

function importSessionKey(session: ProjectSessionContext): string {
  return `${session.projectId}:${session.leaseId}:${session.projectPath}`
}

function notifyImportDraftListeners(): void {
  for (const listener of importDraftListeners) listener()
}

function readImportDraft(key: string): ImportDraft {
  return activeImportSessionKey === key ? activeImportDraft : EMPTY_IMPORT_DRAFT
}

function activateImportSession(key: string): void {
  if (activeImportSessionKey === key) return
  activeImportSessionKey = key
  activeImportDraft = EMPTY_IMPORT_DRAFT
  notifyImportDraftListeners()
}

function writeImportDraft(key: string, draft: ImportDraft): void {
  if (activeImportSessionKey !== key) return
  activeImportDraft = draft
  notifyImportDraftListeners()
}

function clearImportDraftIfCurrent(key: string, expectedDraft: ImportDraft): void {
  if (activeImportSessionKey !== key || activeImportDraft !== expectedDraft) return
  activeImportDraft = EMPTY_IMPORT_DRAFT
  notifyImportDraftListeners()
}

function subscribeImportDraft(listener: () => void): () => void {
  importDraftListeners.add(listener)
  return () => importDraftListeners.delete(listener)
}

export function CharacterCardImportButton(props: Props) {
  const project = useProjectStore(state => state.currentProject)
  const session = captureProjectSession(project)
  if (!session || !isProjectSessionPath(session, props.projectKey)) return null
  return <SessionImportButton key={JSON.stringify(session)} {...props} session={session} />
}

function SessionImportButton({ session, compact, disabled }: Props & { session: ProjectSessionContext }) {
  const { locale, text } = useLocaleStore()
  const sessionKey = importSessionKey(session)
  const draft = useSyncExternalStore(
    subscribeImportDraft,
    useCallback(() => readImportDraft(sessionKey), [sessionKey]),
  )
  useEffect(() => {
    activateImportSession(sessionKey)
  }, [sessionKey])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const label = text('粘贴 / 导入角色卡', 'Paste / import character cards')

  async function chooseFiles() {
    const draftWhenSelected = draft
    setBusy(true)
    try {
      const selected = await selectPlanningMaterials()
      if (isProjectSessionCurrent(session) && selected.length && readImportDraft(sessionKey) === draftWhenSelected) {
        writeImportDraft(sessionKey, { source: draftWhenSelected.source, files: selected })
      }
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  async function extract() {
    if (busy || !isProjectSessionCurrent(session)) return
    const submittedDraft = draft
    const materials = [...submittedDraft.files]
    if (submittedDraft.source.trim()) materials.push({ fileName: text('粘贴的角色卡.txt', 'Pasted character cards.txt'), text: submittedDraft.source })
    if (!materials.length) return
    const llm = useLLMStore.getState()
    const model = llm.models.find(candidate => candidate.id === llm.defaultModelId)
    if (!model) {
      toast.warning(text('请先到设置 → 模型配置，添加并选择默认生成模型；输入内容已保留。', 'Add and select a default generation model in Settings → Models first. Your input has been kept.'))
      return
    }
    setBusy(true)
    // The shared confirmation owns its own modal; release this focus trap first.
    setOpen(false)
    try {
      const allowed = await confirm(text(
        `本次粘贴及选中文件的全部文本将发送到以下模型端点，用于提取角色卡。提取后需预览并确认，才会写入角色名单；不会直接覆盖角色图谱。\n\n模型：${model.name} (${model.modelName})\n端点：${model.baseUrl}\n\n是否发送并提取？`,
        `All pasted text and selected files will be sent to the following model endpoint to extract character cards. Preview and confirmation are required before saving to the roster; the character graph will not be overwritten directly.\n\nModel: ${model.name} (${model.modelName})\nEndpoint: ${model.baseUrl}\n\nSend and extract?`,
      ), { title: text('AI 提取角色卡', 'AI character-card extraction'), confirmText: text('发送并提取', 'Send and extract') })
      if (!isProjectSessionCurrent(session)) return
      setOpen(true)
      if (!allowed) return
      const currentModel = useLLMStore.getState().models.find(candidate => candidate.id === model.id)
      if (!currentModel || currentModel.baseUrl !== model.baseUrl || currentModel.modelName !== model.modelName) {
        toast.warning(text('模型配置已改变，请重新确认后发送。', 'The model configuration changed. Confirm again before sending.'))
        return
      }
      const workflow = createPlanningMaterialCharacterExtractionWorkflow({ projectSession: session, materials, generationModelId: model.id }, locale)
      const conflict = useWorkflowStore.getState().getResourceConflict(workflow)
      if (conflict) {
        toast.warning(workflowResourceConflictMessage(locale, conflict.title))
        return
      }
      setOpen(false)
      useLayoutStore.getState().openBottomTab('tasks')
      const runId = await useWorkflowStore.getState().startWorkflow(workflow, true)
      if (!isProjectSessionCurrent(session)) return
      const run = useWorkflowStore.getState().history.find(candidate => candidate.id === runId)
      if (run?.status === 'completed') {
        clearImportDraftIfCurrent(sessionKey, submittedDraft)
        toast.success(text('角色卡已导入角色名单', 'Character cards imported into the roster'))
      } else {
        setOpen(true)
        toast.warning(text('导入未完成，输入内容已保留；请查看任务详情。', 'Import did not complete. Your input has been kept; check the task details.'))
      }
    } catch (error) {
      if (isProjectSessionCurrent(session)) {
        setOpen(true)
        toast.error(appErrorMessage(locale, error))
      }
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  return <>
    <Button variant="ghost" size={compact ? 'icon' : 'sm'} className={compact ? 'h-6 w-6' : undefined} disabled={disabled || busy} title={label} aria-label={label} onClick={() => setOpen(true)}>
      <ClipboardPaste size={14} />{!compact && label}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{text('粘贴完整角色卡，或选择资料文件。AI 提取后由你预览确认，不会自动保存。', 'Paste full character cards or choose files. Preview and confirm the AI extraction before saving.')}</DialogDescription>
        </DialogHeader>
        <div className="p-6 space-y-3">
          <textarea aria-label={text('角色卡全文', 'Full character-card text')} value={draft.source} onChange={event => {
            const nextSource = event.target.value
            writeImportDraft(sessionKey, { source: nextSource, files: draft.files })
          }} disabled={busy} rows={9} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm" />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void chooseFiles()}><FileUp size={14} />{text('选择文件', 'Choose files')}</Button>
          {draft.files.length > 0 && <div className="text-xs break-all">{draft.files.map(file => file.fileName).join('、')} <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            writeImportDraft(sessionKey, { source: draft.source, files: [] })
          }}>{text('清除文件', 'Clear files')}</Button></div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{text('暂不导入', 'Not now')}</Button>
          <Button disabled={busy || (!draft.source.trim() && !draft.files.length)} onClick={() => void extract()}>{busy ? text('处理中…', 'Working…') : text('AI 提取并预览', 'Extract and preview with AI')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
