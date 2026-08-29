import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Clock3, Pencil, Plus, Trash2 } from 'lucide-react'

import type { DatabaseChannels } from '../../shared/ipc-channels'
import type {
  NarrativeThreadEventType,
  NarrativeThreadPlanInput,
  NarrativeThreadView,
} from '../../shared/narrative-thread'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { Textarea } from '../ui/Textarea'
import { toast } from '../ui/Toast'

const EMPTY_PLAN: NarrativeThreadPlanInput = {
  title: '', type: '', targetStartChapter: 1, targetEndChapter: 1, authorIntent: '',
}

const STATUS_LABELS: Record<NarrativeThreadView['status'], [string, string]> = {
  planned: ['已计划', 'Planned'],
  planted: ['已埋设', 'Planted'],
  progressing: ['推进中', 'Progressing'],
  resolved: ['已解决', 'Resolved'],
  abandoned: ['已放弃', 'Abandoned'],
}

export default function NarrativeThreadEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const [threads, setThreads] = useState<NarrativeThreadView[]>([])
  const [finalizedDrafts, setFinalizedDrafts] = useState<DatabaseChannels['db:draft-list-all']['return']>([])
  const [plan, setPlan] = useState<NarrativeThreadPlanInput>(EMPTY_PLAN)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [eventPlanId, setEventPlanId] = useState<number | null>(null)
  const [eventDraftId, setEventDraftId] = useState(0)
  const [eventType, setEventType] = useState<NarrativeThreadEventType>('planted')
  const [eventEvidence, setEventEvidence] = useState('')
  const [eventReason, setEventReason] = useState('')
  const [eventError, setEventError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    try {
      const [nextThreads, drafts] = await Promise.all([
        ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', projectKey),
        ipc.invokeWithProjectSession(session, 'db:draft-list-all', projectKey),
      ])
      if (!isProjectSessionCurrent(session)) return
      const finalized = drafts.filter(draft => draft.status === 'finalized')
      setFinalizedDrafts(finalized)
      setThreads(nextThreads)
      setEventDraftId(previous => previous || finalized[0]?.id || 0)
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('加载叙事线索失败', 'Could not load narrative threads'))
    }
  }, [projectKey, text])

  useEffect(() => {
    queueMicrotask(() => { void reload() })
  }, [reload, currentProject?.sessionLease])

  const savePlan = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return
    setBusy(true)
    try {
      const result = editingId === null
        ? await ipc.invokeWithProjectSession(session, 'db:narrative-thread-plan-create', plan, projectKey)
        : await ipc.invokeWithProjectSession(session, 'db:narrative-thread-plan-update', editingId, plan, projectKey)
      if (!result.success) throw new Error(result.error)
      if (!isProjectSessionCurrent(session)) return
      setPlan(EMPTY_PLAN)
      setEditingId(null)
      await reload()
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('保存叙事线索失败', 'Could not save narrative thread'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  const deletePlan = async (id: number) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return
    setBusy(true)
    try {
      const result = await ipc.invokeWithProjectSession(session, 'db:narrative-thread-plan-delete', id, projectKey)
      if (!result.success) throw new Error(result.error)
      if (isProjectSessionCurrent(session)) await reload()
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('删除叙事线索失败', 'Could not delete narrative thread'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  const saveEvent = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || eventPlanId === null || busy) return
    setBusy(true)
    setEventError('')
    try {
      const result = await ipc.invokeWithProjectSession(session, 'db:narrative-thread-event-confirm', {
        planId: eventPlanId, draftId: eventDraftId, type: eventType,
        evidence: eventEvidence, reason: eventReason,
      }, projectKey)
      if (!result.success) {
        if (result.error?.includes('短证据必须来自绑定的定稿正文')) {
          setEventError(text(
            '请粘贴所选定稿章节中实际出现的短原文。',
            'Paste a short excerpt that appears in the selected finalized chapter.',
          ))
          return
        }
        throw new Error('event confirmation failed')
      }
      if (!isProjectSessionCurrent(session)) return
      setEventPlanId(null)
      setEventEvidence('')
      setEventReason('')
      await reload()
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('保存定稿事件失败', 'Could not save finalized event'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-5" style={{ color: 'var(--color-text)' }}>
      <div className="mx-auto max-w-5xl space-y-5">
        <header>
          <h2 className="text-lg font-semibold">{text('叙事线索', 'Narrative threads')}</h2>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {text('人工计划保持独立；只有人工确认的定稿章节才能成为已发生事件。', 'Plans stay independent; only user-confirmed finalized chapters become events.')}
          </p>
        </header>

        <section className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
          <div className="flex items-center gap-2 font-medium"><Plus size={16} />{editingId === null ? text('新建计划', 'New plan') : text('编辑计划', 'Edit plan')}</div>
          <div className="grid grid-cols-2 gap-3">
            <label><Label>{text('标题', 'Title')}</Label><Input value={plan.title} onChange={event => setPlan({ ...plan, title: event.target.value })} /></label>
            <label><Label>{text('类型', 'Type')}</Label><Input value={plan.type} onChange={event => setPlan({ ...plan, type: event.target.value })} /></label>
            <label><Label>{text('目标起始章', 'Target start')}</Label><Input type="number" min={1} value={plan.targetStartChapter} onChange={event => setPlan({ ...plan, targetStartChapter: Number(event.target.value) })} /></label>
            <label><Label>{text('目标结束章', 'Target end')}</Label><Input type="number" min={1} value={plan.targetEndChapter} onChange={event => setPlan({ ...plan, targetEndChapter: Number(event.target.value) })} /></label>
          </div>
          <label><Label>{text('作者意图 / 理由', 'Author intent / rationale')}</Label><Textarea value={plan.authorIntent} onChange={event => setPlan({ ...plan, authorIntent: event.target.value })} /></label>
          <Button onClick={() => void savePlan()} disabled={busy || !plan.title.trim() || !plan.type.trim() || !plan.authorIntent.trim() || plan.targetEndChapter < plan.targetStartChapter}>{text('保存计划', 'Save plan')}</Button>
        </section>

        {threads.length === 0 && <p className="text-sm text-center py-8" style={{ color: 'var(--color-text-muted)' }}>{text('暂无叙事线索', 'No narrative threads yet')}</p>}
        {threads.map(thread => (
          <section key={thread.id} className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{thread.title}</h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{thread.type} · {text('目标', 'Target')} {thread.targetStartChapter}–{thread.targetEndChapter}</p>
              </div>
              <span className="text-xs rounded px-2 py-1" style={{ background: 'var(--color-bg)' }}>{text(...STATUS_LABELS[thread.status])}</span>
            </div>
            <p className="text-sm">{thread.authorIntent}</p>
            {thread.status !== 'resolved' && thread.status !== 'abandoned' && (
              <div className="flex gap-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1"><Clock3 size={13} />{text(`沉寂 ${thread.dormantChapters} 章`, `Dormant ${thread.dormantChapters} chapters`)}</span>
                {thread.overdue && <span>{text('已逾期', 'Overdue')}</span>}
              </div>
            )}
            <div className="space-y-1">
              {thread.events.map(event => <div key={event.id} className="text-xs flex gap-2"><CheckCircle2 size={13} /><span>{text(`第${event.chapterNumber}章`, `Chapter ${event.chapterNumber}`)} · {text(...STATUS_LABELS[event.type])} · {event.evidence}</span></div>)}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setEditingId(thread.id); setPlan({ title: thread.title, type: thread.type, targetStartChapter: thread.targetStartChapter, targetEndChapter: thread.targetEndChapter, authorIntent: thread.authorIntent }) }}><Pencil size={13} />{text('编辑', 'Edit')}</Button>
              <Button variant="outline" size="sm" onClick={() => { setEventPlanId(thread.id); setEventError('') }} disabled={finalizedDrafts.length === 0}>{text('确认定稿事件', 'Confirm finalized event')}</Button>
              <Button variant="ghost" size="sm" onClick={() => void deletePlan(thread.id)}><Trash2 size={13} />{text('删除', 'Delete')}</Button>
            </div>
            {eventPlanId === thread.id && <div className="grid grid-cols-2 gap-2 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
              <NativeSelect value={eventDraftId} onChange={event => setEventDraftId(Number(event.target.value))}>{finalizedDrafts.map(draft => <option key={draft.id} value={draft.id}>{text(`第${draft.chapterNumber}章 · 定稿 v${draft.version}`, `Chapter ${draft.chapterNumber} · Finalized v${draft.version}`)}</option>)}</NativeSelect>
              <NativeSelect value={eventType} onChange={event => setEventType(event.target.value as NarrativeThreadEventType)}><option value="planted">{text('埋设', 'Planted')}</option><option value="progressing">{text('推进', 'Progressing')}</option><option value="resolved">{text('解决', 'Resolved')}</option><option value="abandoned">{text('放弃', 'Abandoned')}</option></NativeSelect>
              <div className="col-span-2">
                <Input placeholder={text('粘贴该定稿章节中的短原文', 'Paste a short excerpt from this finalized chapter')} value={eventEvidence} onChange={event => setEventEvidence(event.target.value)} />
                <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>{text('证据必须逐字来自所选定稿章节。', 'Evidence must be copied from the selected finalized chapter.')}</p>
              </div>
              <Input className="col-span-2" placeholder={text('确认理由', 'Confirmation rationale')} value={eventReason} onChange={event => setEventReason(event.target.value)} />
              {eventError && <p className="col-span-2 text-xs" style={{ color: 'var(--color-error-text)' }}>{eventError}</p>}
              <Button onClick={() => void saveEvent()} disabled={busy || !eventEvidence.trim() || !eventReason.trim()}>{text('保存事件', 'Save event')}</Button>
            </div>}
          </section>
        ))}
      </div>
    </div>
  )
}
