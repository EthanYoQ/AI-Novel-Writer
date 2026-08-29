import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, Loader2, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'

import type { DatabaseChannels, ModelProfile } from '../../shared/ipc-channels'
import {
  resolveNarrativeThreadDormantThreshold,
  type NarrativeThreadEventType,
  type NarrativeThreadPlanInput,
  type NarrativeThreadView,
} from '../../shared/narrative-thread'
import { resolveWritingLanguage } from '../../shared/writing-language'
import { ipc } from '../../services/ipc-client'
import {
  narrativeThreadCandidateGenerator,
  type NarrativeThreadCandidateGenerator,
  type NarrativeThreadEventCandidate,
  type NarrativeThreadPlanCandidate,
} from '../../services/narrative-thread-candidate-generator'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../project-session-gate'
import { Button } from '../ui/Button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/Dialog'
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

interface NarrativeThreadEditorProps {
  projectKey: string
  candidateGenerator?: NarrativeThreadCandidateGenerator
}

type AICandidateMode = 'plan' | 'event'

interface BoundEventCandidate extends NarrativeThreadEventCandidate {
  planId: number
  draftId: number
  chapterNumber: number
}

function isGenerationModel(model: ModelProfile): boolean {
  return model.purposes.includes('generation')
}

export default function NarrativeThreadEditor({
  projectKey,
  candidateGenerator = narrativeThreadCandidateGenerator,
}: NarrativeThreadEditorProps) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const loadedModels = useLLMStore(s => s.loaded)
  const loadModels = useLLMStore(s => s.loadModels)
  const [threads, setThreads] = useState<NarrativeThreadView[]>([])
  const [finalizedDrafts, setFinalizedDrafts] = useState<DatabaseChannels['db:draft-list-all']['return']>([])
  const [blueprints, setBlueprints] = useState<DatabaseChannels['db:blueprint-get-all']['return']>([])
  const [plan, setPlan] = useState<NarrativeThreadPlanInput>(EMPTY_PLAN)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [eventPlanId, setEventPlanId] = useState<number | null>(null)
  const [eventDraftId, setEventDraftId] = useState(0)
  const [eventType, setEventType] = useState<NarrativeThreadEventType>('planted')
  const [eventEvidence, setEventEvidence] = useState('')
  const [eventReason, setEventReason] = useState('')
  const [eventError, setEventError] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiMode, setAiMode] = useState<AICandidateMode>('plan')
  const [aiModelId, setAiModelId] = useState<string | null>(null)
  const [aiBlueprintChapter, setAiBlueprintChapter] = useState(0)
  const [planCandidates, setPlanCandidates] = useState<NarrativeThreadPlanCandidate[]>([])
  const [eventCandidates, setEventCandidates] = useState<BoundEventCandidate[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const candidateAbortRef = useRef<AbortController | null>(null)
  const dormantThreshold = resolveNarrativeThreadDormantThreshold(
    currentProject?.novelConfig.narrativeThreadDormantChapterThreshold,
  )
  const generationModels = models.filter(isGenerationModel)
  const fallbackModelId = generationModels.some(model => model.id === defaultModelId)
    ? defaultModelId
    : generationModels[0]?.id ?? null
  const selectedModelId = aiModelId ?? fallbackModelId
  const selectedModel = generationModels.find(model => model.id === selectedModelId)
  const modelSelectionError = generationModels.length === 0
    ? text(
        '没有已配置且可用于文本生成的模型。请先在设置中添加生成模型。',
        'No configured model can generate text. Add a generation model in Settings first.',
      )
    : !selectedModel
      ? text(
          '所选识别模型已不可用，请重新选择。',
          'The selected analysis model is unavailable. Select another model.',
        )
      : ''

  const reload = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    try {
      const [nextThreads, drafts, nextBlueprints] = await Promise.all([
        ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', projectKey),
        ipc.invokeWithProjectSession(session, 'db:draft-list-all', projectKey),
        ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', projectKey),
      ])
      if (!isProjectSessionCurrent(session)) return
      const finalized = drafts.filter(draft => draft.status === 'finalized')
      setFinalizedDrafts(finalized)
      setThreads(nextThreads)
      setBlueprints(nextBlueprints)
      setEventDraftId(previous => previous || finalized[0]?.id || 0)
      setAiBlueprintChapter(previous => previous || nextBlueprints[0]?.chapterNumber || 0)
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('加载叙事线索失败', 'Could not load narrative threads'))
    }
  }, [projectKey, text])

  useEffect(() => {
    queueMicrotask(() => { void reload() })
  }, [reload, currentProject?.sessionLease])

  useEffect(() => {
    if (!loadedModels) void loadModels()
  }, [loadModels, loadedModels])

  const closeAI = useCallback(() => {
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = null
    setAiOpen(false)
    setAiBusy(false)
    setAiError('')
    setPlanCandidates([])
    setEventCandidates([])
  }, [])

  const openAI = (mode: AICandidateMode) => {
    if (mode === 'event' && (eventPlanId === null || eventDraftId === 0)) return
    setAiMode(mode)
    setAiModelId(generationModels.some(model => model.id === defaultModelId)
      ? defaultModelId
      : generationModels[0]?.id ?? null)
    if (mode === 'plan') setAiBlueprintChapter(blueprints[0]?.chapterNumber ?? 0)
    setPlanCandidates([])
    setEventCandidates([])
    setAiError('')
    setAiOpen(true)
  }

  const generatePlanCandidates = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const blueprint = blueprints.find(item => item.chapterNumber === aiBlueprintChapter)
    const frozenModelId = selectedModel?.id
    if (!session || !isProjectSessionPath(session, projectKey) || !blueprint || !frozenModelId || aiBusy) return
    const controller = new AbortController()
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = controller
    setAiBusy(true)
    setAiError('')
    setPlanCandidates([])
    try {
      const candidates = await candidateGenerator.generatePlanCandidates({
        modelId: frozenModelId,
        writingLanguage: resolveWritingLanguage(useProjectStore.getState().currentProject?.novelConfig.writingLanguage),
        blueprint,
        signal: controller.signal,
      })
      if (!isProjectSessionCurrent(session) || controller.signal.aborted) return
      setPlanCandidates(candidates)
    } catch {
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) {
        setAiError(text('未生成有效的计划候选，请重试。', 'No valid plan candidates were generated. Try again.'))
      }
    } finally {
      if (candidateAbortRef.current === controller) candidateAbortRef.current = null
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) setAiBusy(false)
    }
  }

  const generateEventCandidates = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const planSnapshot = threads.find(item => item.id === eventPlanId)
    const draftSnapshot = finalizedDrafts.find(item => item.id === eventDraftId)
    const frozenModelId = selectedModel?.id
    if (!session || !isProjectSessionPath(session, projectKey) || !planSnapshot
      || !draftSnapshot || !frozenModelId || aiBusy) return
    const controller = new AbortController()
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = controller
    setAiBusy(true)
    setAiError('')
    setEventCandidates([])
    try {
      const fullDraft = await ipc.invokeWithProjectSession(
        session, 'db:draft-get-full', draftSnapshot.id, projectKey,
      )
      if (!fullDraft || !isProjectSessionCurrent(session) || controller.signal.aborted) return
      const candidates = await candidateGenerator.generateEventCandidates({
        modelId: frozenModelId,
        writingLanguage: resolveWritingLanguage(useProjectStore.getState().currentProject?.novelConfig.writingLanguage),
        plan: planSnapshot,
        draftId: draftSnapshot.id,
        chapterNumber: draftSnapshot.chapterNumber,
        finalizedContent: fullDraft.content,
        signal: controller.signal,
      })
      if (!isProjectSessionCurrent(session) || controller.signal.aborted) return
      setEventCandidates(candidates.map(candidate => ({
        ...candidate,
        planId: planSnapshot.id,
        draftId: draftSnapshot.id,
        chapterNumber: draftSnapshot.chapterNumber,
      })))
    } catch {
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) {
        setAiError(text(
          '未生成带有效定稿证据的事件候选，请重试。',
          'No event candidate with valid finalized evidence was generated. Try again.',
        ))
      }
    } finally {
      if (candidateAbortRef.current === controller) candidateAbortRef.current = null
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) setAiBusy(false)
    }
  }

  const confirmPlanCandidate = async (candidate: NarrativeThreadPlanCandidate) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return
    setBusy(true)
    try {
      const result = await ipc.invokeWithProjectSession(
        session, 'db:narrative-thread-plan-create', candidate, projectKey,
      )
      if (!result.success) throw new Error(result.error)
      if (!isProjectSessionCurrent(session)) return
      setPlanCandidates(previous => previous.filter(item => item !== candidate))
      await reload()
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('保存叙事线索失败', 'Could not save narrative thread'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  const confirmEventCandidate = async (candidate: BoundEventCandidate) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return
    setBusy(true)
    try {
      const result = await ipc.invokeWithProjectSession(session, 'db:narrative-thread-event-confirm', {
        planId: candidate.planId,
        draftId: candidate.draftId,
        type: candidate.type,
        evidence: candidate.evidence,
        reason: candidate.reason,
      }, projectKey)
      if (!result.success) throw new Error(result.error)
      if (!isProjectSessionCurrent(session)) return
      setEventCandidates(previous => previous.filter(item => item !== candidate))
      await reload()
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('保存定稿事件失败', 'Could not save finalized event'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

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
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{text('伏笔与叙事线索', 'Foreshadowing & narrative threads')}</h2>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text('设置埋设与预计回收章节；活跃计划会自动注入后续写作，逾期或沉寂时提醒。只有人工确认的定稿内容才记为已发生事件。', 'Set setup and expected payoff chapters. Active plans are injected into later writing and flagged when overdue or dormant; only user-confirmed finalized text becomes an event.')}
            </p>
          </div>
          <Button variant="ai" size="sm" onClick={() => openAI('plan')} disabled={blueprints.length === 0}>
            <Sparkles size={13} />{text('AI 建议伏笔与线索', 'Suggest foreshadowing with AI')}
          </Button>
        </header>

        <section className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
          <div className="flex items-center gap-2 font-medium"><Plus size={16} />{editingId === null ? text('新建计划', 'New plan') : text('编辑计划', 'Edit plan')}</div>
          <div className="grid grid-cols-2 gap-3">
            <label><Label>{text('标题', 'Title')}</Label><Input value={plan.title} onChange={event => setPlan({ ...plan, title: event.target.value })} /></label>
            <label><Label>{text('类型', 'Type')}</Label><Input value={plan.type} onChange={event => setPlan({ ...plan, type: event.target.value })} /></label>
            <label><Label>{text('计划埋设 / 开始章', 'Setup / start chapter')}</Label><Input type="number" min={1} value={plan.targetStartChapter} onChange={event => setPlan({ ...plan, targetStartChapter: Number(event.target.value) })} /></label>
            <label><Label>{text('预计回收 / 结束章', 'Expected payoff / end chapter')}</Label><Input type="number" min={1} value={plan.targetEndChapter} onChange={event => setPlan({ ...plan, targetEndChapter: Number(event.target.value) })} /></label>
          </div>
          <label><Label>{text('作者意图 / 理由', 'Author intent / rationale')}</Label><Textarea value={plan.authorIntent} onChange={event => setPlan({ ...plan, authorIntent: event.target.value })} /></label>
          <Button onClick={() => void savePlan()} disabled={busy || !plan.title.trim() || !plan.type.trim() || !plan.authorIntent.trim() || plan.targetEndChapter < plan.targetStartChapter}>{text('保存计划', 'Save plan')}</Button>
        </section>

        {threads.length === 0 && <p className="text-sm text-center py-8" style={{ color: 'var(--color-text-muted)' }}>{text('暂无伏笔或叙事线索', 'No foreshadowing or narrative threads yet')}</p>}
        {threads.map(thread => (
          <section key={thread.id} className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{thread.title}</h3>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{thread.type} · {text(`埋设/开始 ${thread.targetStartChapter} · 预计回收/结束 ${thread.targetEndChapter}`, `Setup/start ${thread.targetStartChapter} · expected payoff/end ${thread.targetEndChapter}`)}</p>
              </div>
              <span className="text-xs rounded px-2 py-1" style={{ background: 'var(--color-bg)' }}>{text(...STATUS_LABELS[thread.status])}</span>
            </div>
            <p className="text-sm">{thread.authorIntent}</p>
            {thread.status !== 'resolved' && thread.status !== 'abandoned' && (
              <div className="flex gap-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1"><Clock3 size={13} />{text(`沉寂 ${thread.dormantChapters} 章`, `Dormant ${thread.dormantChapters} chapters`)}</span>
                {thread.dormantChapters >= dormantThreshold && (
                  <span role="status">{text('已达到项目沉寂提醒阈值', 'Project dormant threshold reached')}</span>
                )}
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
              <div className="col-span-2 flex gap-2">
                <Button onClick={() => void saveEvent()} disabled={busy || !eventEvidence.trim() || !eventReason.trim()}>{text('保存事件', 'Save event')}</Button>
                <Button variant="ai" onClick={() => openAI('event')} disabled={busy}>
                  <Sparkles size={13} />{text('AI 识别定稿事件', 'Find finalized events with AI')}
                </Button>
              </div>
            </div>}
          </section>
        ))}
      </div>
      <Dialog open={aiOpen} onOpenChange={open => { if (!open) closeAI() }}>
        <DialogContent className="max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Sparkles size={15} />{aiMode === 'plan'
              ? text('蓝图计划候选', 'Blueprint plan candidates')
              : text('定稿事件候选', 'Finalized event candidates')}</DialogTitle>
            <DialogDescription>{aiMode === 'plan'
              ? text(
                  'AI 只提出人工计划候选；确认前不会写入项目，也不会产生章节事件。',
                  'AI proposes author-plan candidates only. Nothing is saved and no chapter event is created before confirmation.',
                )
              : text(
                  'AI 只从当前绑定的定稿正文提出带原文证据的事件候选；确认前不会写入项目。',
                  'AI proposes evidence-bound events only from the selected finalized chapter. Nothing is saved before confirmation.',
                )}</DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            <label className="block">
              <Label htmlFor="narrative-thread-ai-model">{text('本次识别模型', 'Model for this analysis')}</Label>
              <NativeSelect
                id="narrative-thread-ai-model"
                value={selectedModelId ?? ''}
                disabled={generationModels.length === 0 || aiBusy}
                onChange={event => setAiModelId(event.target.value || null)}
              >
                <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
                {generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
              </NativeSelect>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>{text(
                '仅用于本次识别，不会更改默认模型。',
                'Used for this analysis only; it does not change the default model.',
              )}</p>
              {modelSelectionError && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--color-error-text)' }}>{modelSelectionError}</p>}
            </label>
            {aiMode === 'plan' && <label className="block">
              <Label htmlFor="narrative-thread-ai-blueprint">{text('蓝图章节', 'Blueprint chapter')}</Label>
              <NativeSelect id="narrative-thread-ai-blueprint" value={aiBlueprintChapter} disabled={aiBusy} onChange={event => setAiBlueprintChapter(Number(event.target.value))}>
                {blueprints.map(blueprint => <option key={blueprint.chapterNumber} value={blueprint.chapterNumber}>{text(`第${blueprint.chapterNumber}章 · ${blueprint.title}`, `Chapter ${blueprint.chapterNumber} · ${blueprint.title}`)}</option>)}
              </NativeSelect>
            </label>}
            {aiError && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{aiError}</p>}
            {planCandidates.map((candidate, index) => (
              <section key={`${candidate.title}:${index}`} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--color-border)' }}>
                <div className="font-medium">{candidate.title}</div>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{candidate.type} · {text('目标', 'Target')} {candidate.targetStartChapter}–{candidate.targetEndChapter}</p>
                <p className="text-sm">{candidate.authorIntent}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void confirmPlanCandidate(candidate)} disabled={busy}>{text('确认计划', 'Confirm plan')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPlanCandidates(previous => previous.filter(item => item !== candidate))} disabled={busy}>{text('拒绝候选', 'Reject candidate')}</Button>
                </div>
              </section>
            ))}
            {eventCandidates.map((candidate, index) => (
              <section key={`${candidate.type}:${candidate.evidence}:${index}`} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--color-border)' }}>
                <div className="font-medium">{text(...STATUS_LABELS[candidate.type])} · {text(`第${candidate.chapterNumber}章`, `Chapter ${candidate.chapterNumber}`)}</div>
                <blockquote className="text-sm border-l-2 pl-3" style={{ borderColor: 'var(--color-border)' }}>{candidate.evidence}</blockquote>
                <p className="text-sm">{candidate.reason}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void confirmEventCandidate(candidate)} disabled={busy}>{text('确认事件', 'Confirm event')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEventCandidates(previous => previous.filter(item => item !== candidate))} disabled={busy}>{text('拒绝候选', 'Reject candidate')}</Button>
                </div>
              </section>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAI} disabled={aiBusy}>{text('关闭', 'Close')}</Button>
            <Button variant="ai" onClick={() => void (aiMode === 'plan' ? generatePlanCandidates() : generateEventCandidates())} disabled={aiBusy || Boolean(modelSelectionError) || (aiMode === 'plan' && !aiBlueprintChapter)}>
              {aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {aiBusy ? text('识别中...', 'Analyzing...') : text('生成候选', 'Generate candidates')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
