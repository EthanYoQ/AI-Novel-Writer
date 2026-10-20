import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ClipboardPaste, FileUp } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useLLMStore } from '../../stores/llm-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { selectPlanningMaterials, type PlanningMaterial } from '../../services/knowledge-service'
import { createPlanningMaterialCharacterExtractionWorkflow } from '../../services/workflows/planning-material-workflow'
import type { ModelProfile, ProjectSessionContext } from '../../shared/ipc-channels'
import { appErrorMessage } from '../../i18n/app-errors'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { InkDialog } from '../stage/InkDialog'

interface Props { projectKey: string; disabled?: boolean }

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

function SessionImportButton({ session, disabled }: Props & { session: ProjectSessionContext }) {
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
  const label = text('粘贴 / 导入角色卡', 'Paste or import cards')

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

  /** 待发送的一次提取：材料与发送时要用的模型。 */
  type Job = { submittedDraft: ImportDraft; materials: PlanningMaterial[]; model: ModelProfile }

  function prepare(): Job | null {
    if (busy || !isProjectSessionCurrent(session)) return null
    const submittedDraft = draft
    const materials = [...submittedDraft.files]
    if (submittedDraft.source.trim()) materials.push({ fileName: text('粘贴的角色卡.txt', 'Pasted character cards.txt'), text: submittedDraft.source })
    if (!materials.length) return null
    const llm = useLLMStore.getState()
    const model = llm.models.find(candidate => candidate.id === llm.defaultModelId)
    if (!model) {
      toast.warning(text('请先到设置 → 模型配置，添加并选择默认生成模型；输入内容已保留。', 'Add and select a default generation model in Settings → Models first. Your input has been kept.'))
      return null
    }
    return { submittedDraft, materials, model }
  }

  const consentText = (model: ModelProfile) => text(
    `本次粘贴及选中文件的全部文本将发送到以下模型端点，用于提取角色卡。提取后需预览并确认，才会写入角色名单；不会直接覆盖角色名单。\n\n模型：${model.name} (${model.modelName})\n端点：${model.baseUrl}\n\n是否发送并提取？`,
    `All pasted text and selected files will be sent to the following model endpoint to extract character cards. Preview and confirmation are required before saving to the cast; the cast will not be overwritten directly.\n\nModel: ${model.name} (${model.modelName})\nEndpoint: ${model.baseUrl}\n\nSend and extract?`,
  )

  async function send({ submittedDraft, materials, model }: Job) {
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
    navigate({ kind: 'run', facet: 'tasks' })
    const runId = await useWorkflowStore.getState().startWorkflow(workflow, true)
    if (!isProjectSessionCurrent(session)) return
    const run = useWorkflowStore.getState().history.find(candidate => candidate.id === runId)
    const rejected = run?.status === 'completed' && run.characterProposalChoices
      && !run.characterProposalChoices.selections.some(choice => choice.action !== 'keep-unresolved')
    if (rejected) {
      setOpen(true)
      toast.warning(text('未采用任何角色，输入内容已保留。', 'No characters were adopted; your input was kept.'))
    } else if (run?.status === 'completed') {
      clearImportDraftIfCurrent(sessionKey, submittedDraft)
      toast.success(text('角色卡已导入角色名单', 'Character cards imported into the cast'))
    } else {
      setOpen(true)
      toast.warning(text('导入未完成，输入内容已保留；请查看任务详情。', 'Import did not complete. Your input has been kept; check the task details.'))
    }
  }

  async function guarded(task: () => Promise<void>) {
    setBusy(true)
    try {
      await task()
    } catch (error) {
      if (isProjectSessionCurrent(session)) {
        setOpen(true)
        toast.error(appErrorMessage(locale, error))
      }
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  /** 外发确认是同一个对话框里的第二步。 */
  const [consent, setConsent] = useState<Job | null>(null)
  const sendConsented = (job: Job) => guarded(async () => {
    setConsent(null)
    await send(job)
  })

  return <>
    <Button variant="secondary" size="sm" disabled={disabled || busy} onClick={() => setOpen(true)}><ClipboardPaste size={14} aria-hidden />{label}</Button>
    <InkDialog
      open={open}
      onOpenChange={value => { if (!busy) { setOpen(value); setConsent(null) } }}
      keepOnOutsideClick
      title={consent ? text('AI 提取角色卡', 'AI character-card extraction') : label}
      description={consent
        ? <span className="cast-import-consent">{consentText(consent.model)}</span>
        : text('粘贴完整角色卡，或选择资料文件。AI 提取后由你预览确认，不会自动保存。', 'Paste full character cards or choose files. Preview and confirm the AI extraction before saving.')}
      // 两步的按钮各自带 key 重挂：第一步按钮上的回车连按落在第二步的「返回」上。外发要在第二步单独点一次，
      // 落在同一位置的双击第二下（detail > 1）不算确认。
      footer={consent
        ? <>
          <Button key="consent-back" variant="secondary" autoFocus disabled={busy} onClick={() => setConsent(null)}>{text('返回', 'Back')}</Button>
          <Button key="consent-send" variant="primary" disabled={busy} onClick={event => { if (event.detail <= 1) void sendConsented(consent) }}>{text('发送并提取', 'Send and extract')}</Button>
        </>
        : <>
          <Button key="source-close" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{text('暂不导入', 'Not now')}</Button>
          <Button key="source-extract" variant="primary" disabled={busy || (!draft.source.trim() && !draft.files.length)} onClick={() => setConsent(prepare())}>{busy ? text('处理中…', 'Working…') : text('AI 提取并预览', 'Extract and preview with AI')}</Button>
        </>}
    >
      {!consent && <>
        <textarea className="pi-input cast-import-source" aria-label={text('角色卡全文', 'Full character-card text')} value={draft.source} onChange={event => {
          writeImportDraft(sessionKey, { source: event.target.value, files: draft.files })
        }} disabled={busy} rows={9} />
        <div className="cast-import-files">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void chooseFiles()}><FileUp size={14} aria-hidden />{text('选择文件', 'Choose files')}</Button>
          {draft.files.length > 0 && <>
            <span className="cast-import-names">{draft.files.map(file => file.fileName).join(text('、', ', '))}</span>
            <Button variant="text" size="sm" disabled={busy} onClick={() => writeImportDraft(sessionKey, { source: draft.source, files: [] })}>{text('清除文件', 'Clear files')}</Button>
          </>}
        </div>
      </>}
    </InkDialog>
  </>
}
