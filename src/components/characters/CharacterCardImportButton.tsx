import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ClipboardPaste, FileUp, X } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useLLMStore } from '../../stores/llm-store'
import { useCharacterStore } from '../../stores/character-store'
import { characterRosterEntriesFromCards } from '../../services/character-roster-client'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { appendPlanningMaterials, selectPlanningMaterials, type PlanningMaterial } from '../../services/knowledge-service'
import { createPlanningMaterialCharacterExtractionWorkflow } from '../../services/workflows/planning-material-workflow'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { appErrorMessage } from '../../i18n/app-errors'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { Button } from '../ui/Button'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import CharacterCardCandidateDialog from './CharacterCardCandidateDialog'
import { useCharacterCardCandidates } from './use-character-card-candidates'

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
  const existingCharacters = useCharacterStore(state => state.characters)
  const existingEntries = useMemo(
    () => characterRosterEntriesFromCards(existingCharacters),
    [existingCharacters],
  )
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
  /** 这一批候选对应的草稿：只有真正写入成功后，才据此清空输入。 */
  const draftRef = useRef<ImportDraft>(EMPTY_IMPORT_DRAFT)
  const candidateFlow = useCharacterCardCandidates({
    onCommitted: () => { clearImportDraftIfCurrent(sessionKey, draftRef.current) },
  })
  const label = text('粘贴 / 导入角色卡', 'Paste / import character cards')

  async function chooseFiles() {
    setBusy(true)
    try {
      const selected = await selectPlanningMaterials()
      if (!isProjectSessionCurrent(session) || selected.length === 0) return
      // 追加而不是替换：先生常常从不同文件夹分几次挑资料，前一次的选择不能丢。
      // 取「当前」草稿而不是捕获值 —— 选择期间作者可能还在改粘贴框。
      const latest = readImportDraft(sessionKey)
      const { files, skipped } = appendPlanningMaterials(latest.files, selected)
      writeImportDraft(sessionKey, { source: latest.source, files })
      if (skipped > 0) {
        toast.info(text(
          `已追加 ${files.length - latest.files.length} 个文件；另有 ${skipped} 个与已选内容完全相同，未重复加入。`,
          `Added ${files.length - latest.files.length} file(s); ${skipped} were identical to files already selected.`,
        ))
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
      const workflow = createPlanningMaterialCharacterExtractionWorkflow({
        projectSession: session,
        materials,
        generationModelId: model.id,
        /**
         * 提取完成后**唯一**的交付口：工作流只负责提取，候选的去留由作者决定。
         * 这里弹预览确认面板，绝不自动写库。
         */
        onCandidatesReady: ready => {
          draftRef.current = submittedDraft
          candidateFlow.deliver(ready, session)
        },
      }, locale)
      const conflict = useWorkflowStore.getState().getResourceConflict(workflow)
      if (conflict) {
        toast.warning(workflowResourceConflictMessage(locale, conflict.title))
        return
      }
      setOpen(false)
      useLayoutStore.getState().openBottomTab('tasks')
      /**
       * 单步工作流，刻意**不再**用步进模式（第二个参数 false）。
       * 旧实现传 true，于是「确认」被降级成任务面板里的一个「继续」按钮 ——
       * 作者看不到候选、也没有勾选机会，一旦没留意那个等待状态，导入就永远不发生。
       */
      const runId = await useWorkflowStore.getState().startWorkflow(workflow, false)
      if (!isProjectSessionCurrent(session)) return
      const run = useWorkflowStore.getState().history.find(candidate => candidate.id === runId)
      // 成功路径已由 onCandidatesReady 交付候选（或给出了 0 条的中性提示），
      // 输入草稿要留到真正写入成功后才清空，所以这里不做任何收尾。
      // hasPending 用 ref 判断：候选面板已经开着时绝不重开输入框，
      // 否则两个对话框叠加，作者会以为出了故障。
      if (run?.status === 'completed' || candidateFlow.hasPending()) return
      setOpen(true)
      toast.warning(text('提取未完成，输入内容已保留；请查看任务详情。', 'Extraction did not complete. Your input has been kept; check the task details.'))
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
      <DialogContent
        className="max-w-[480px]"
        /* 先生：这里常常粘着整段角色卡，误点蒙版关掉会吓一跳（草稿虽在，但体验很差）。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <PageHead
            kicker={text('CAST · 导入角色卡', 'CAST · IMPORT')}
            title={label}
            description={text('粘贴完整角色卡，或选择资料文件。AI 提取后由你预览确认，不会自动保存。', 'Paste full character cards or choose files. Preview and confirm the AI extraction before saving.')}
          />
        </DialogHeader>
        <div className="px-5 py-4 space-y-3">
          <textarea aria-label={text('角色卡全文', 'Full character-card text')} value={draft.source} onChange={event => {
            const nextSource = event.target.value
            writeImportDraft(sessionKey, { source: nextSource, files: draft.files })
          }} disabled={busy} rows={9} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm" />
          <Button variant="outline" size="sm" disabled={busy} title={text('可多次选择，文件会累加', 'Choose as many times as you like; files accumulate')} onClick={() => void chooseFiles()}><FileUp size={14} />{text('选择文件', 'Choose files')}</Button>
          {draft.files.length > 0 && (
            <div
              className="rounded border border-[var(--color-border)] overflow-hidden"
              style={{ backgroundColor: 'var(--color-sidebar)' }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  {text(`已选择 ${draft.files.length} 个文件`, `${draft.files.length} file(s) selected`)}
                </span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
                  writeImportDraft(sessionKey, { source: draft.source, files: [] })
                }}>{text('清除文件', 'Clear files')}</Button>
              </div>
              {/* 逐个文件一行：序号 / 文件名 / 字数 / 单独移除 —— 选中多个资料时一眼看得清。 */}
              <div className="px-3 py-2 space-y-1" style={{ maxHeight: '148px', overflowY: 'auto' }}>
                {draft.files.map((file, index) => (
                  <div key={`${file.fileName}-${index}`} className="flex items-center gap-2 text-xs">
                    <span className="flex-shrink-0 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={file.fileName} style={{ color: 'var(--color-text-secondary)' }}>
                      {file.fileName}
                    </span>
                    <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      {text(`${file.text.length.toLocaleString()} 字`, `${file.text.length.toLocaleString()} chars`)}
                    </span>
                    <button
                      type="button"
                      className="flex-shrink-0 rounded p-0.5 hover:bg-[var(--color-hover)]"
                      aria-label={text(`移除 ${file.fileName}`, `Remove ${file.fileName}`)}
                      disabled={busy}
                      onClick={() => {
                        writeImportDraft(sessionKey, {
                          source: draft.source,
                          files: draft.files.filter((_, fileIndex) => fileIndex !== index),
                        })
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{text('暂不导入', 'Not now')}</Button>
          <Button disabled={busy || (!draft.source.trim() && !draft.files.length)} onClick={() => void extract()}>{busy ? text('处理中…', 'Working…') : text('AI 提取并预览', 'Extract and preview with AI')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <CharacterCardCandidateDialog
      open={candidateFlow.open}
      candidates={candidateFlow.candidates}
      existingEntries={existingEntries}
      busy={candidateFlow.busy}
      error={candidateFlow.error}
      onClose={candidateFlow.discard}
      onConfirm={(selected, overwriteExisting) => { void candidateFlow.submit(selected, overwriteExisting) }}
    />
  </>
}
