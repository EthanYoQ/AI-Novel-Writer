import { useCallback, useEffect, useRef, useState } from 'react'
import { assertGraphResult, canExecuteGraph, createGraphGeneration } from '../../../services/graph-generation'
import type { MainGenerationRunHandle, MainGenerationRunView } from '../../../services/generation/generation-runtime'
import { ipc } from '../../../services/ipc-client'
import { isGenerationModel, preferredGenerationModelId } from '../../../services/workflows/chapter-write-launch'
import type {
  NarrativeThreadCandidateGenerator,
  NarrativeThreadEventCandidate,
  NarrativeThreadPlanCandidate,
} from '../../../services/narrative-thread-candidate-generator'
import {
  PlotTreeGenerationError,
  PlotTreeInputLimitError,
  PlotTreeIncompleteError,
  PlotTreeResponseError,
  PlotTreeSourceError,
  PlotTreeSourceLimitError,
  type GeneratePlotTreeInput,
  type PlotTreeGenerationErrorCode,
  type PlotTreeResponseErrorCode,
} from '../../../services/plot-tree-generator'
import type { GraphGenerationInput, GraphGenerationRecovery } from '../../../shared/graph-generation'
import type { DatabaseChannels } from '../../../shared/ipc-channels'
import {
  resolveNarrativeThreadDormantThreshold,
  type NarrativeThreadEventType,
  type NarrativeThreadPlanInput,
  type NarrativeThreadView,
} from '../../../shared/narrative-thread'
import type { PlotTreeSnapshot, PlotTreeSourceBundle, PlotTreeSourceReference } from '../../../shared/plot-tree'
import { routeStageModel } from '../../../shared/model-stage-routing'
import { formatResourceUri } from '../../../shared/project-paths'
import { resolveWritingLanguage } from '../../../shared/writing-language'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { openChapterFile } from '../../panels/sidebar/sidebar-file-openers'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import { toast } from '../../ui/Toast'
import { pluralEn } from '../../../shared/plural-en'
import { knownAppErrorMessage } from '../../../i18n/app-errors'
import { providerContextFailureText } from '../../../services/generation/prompt-budget-failure'

const EMPTY_PLAN: NarrativeThreadPlanInput = {
  title: '', type: '', targetStartChapter: 1, targetEndChapter: 1, authorIntent: '',
}

export const STATUS_LABELS: Record<NarrativeThreadView['status'], [string, string]> = {
  planned: ['已计划', 'Planned'],
  planted: ['已埋设', 'Planted'],
  progressing: ['推进中', 'Progressing'],
  resolved: ['已解决', 'Resolved'],
  abandoned: ['已放弃', 'Abandoned'],
}

export interface PlotThreadsOptions {
  candidateGenerator?: NarrativeThreadCandidateGenerator
  initialView?: 'plot-tree' | 'plans'
  viewRequest?: number
  plotTreeGenerator?: (request: GeneratePlotTreeInput) => Promise<PlotTreeSnapshot>
}

type AICandidateMode = 'plan' | 'event'

type LocaleText = (zh: string, en: string) => string

const SNAPSHOT_VALIDATION_ERROR_ENDINGS = [
  '无效', '不存在', '不匹配', '超出轨道章节范围', '重复', '不能有父轨道', '必须归属一条主线', '必须是现有主线', '缺少来源引用',
] as const

function plotTreeErrorMessage(
  error: unknown,
  text: LocaleText,
  fallback: [zh: string, en: string],
): string {
  if (error instanceof PlotTreeGenerationError) {
    return error.code === 'DEADLINE_EXHAUSTED'
      ? text(
          '剧情树生成超过会话截止时间，旧快照保持不变，请稍后重试。',
          'Plot-tree generation exceeded the session deadline; the previous snapshot remains unchanged. Try again later.',
        )
      : text(
          '剧情树模型请求失败，旧快照保持不变，请检查模型连接后重试。',
          'The plot-tree model request failed; the previous snapshot remains unchanged. Check the model connection and try again.',
        )
  }
  if (error instanceof PlotTreeResponseError) {
    return error.code === 'invalid_json'
      ? text(
          '模型未返回可解析的剧情树 JSON，旧快照保持不变。',
          'The model did not return parseable plot-tree JSON; the previous snapshot remains unchanged.',
        )
      : text(
          '模型返回的剧情树结构或来源引用无效，旧快照保持不变。',
          'The model returned an invalid plot-tree structure or source reference; the previous snapshot remains unchanged.',
        )
  }
  if (error instanceof PlotTreeSourceLimitError) {
    return text(
      `剧情树完整来源上限为 ${error.maximum} 个章节；本次未调用模型，旧快照保持不变。`,
      `The complete plot-tree source limit is ${error.maximum} ${pluralEn(error.maximum, 'chapter')}; the model was not called and the previous snapshot remains unchanged.`,
    )
  }
  if (error instanceof PlotTreeInputLimitError) {
    return text(
      '压缩后的剧情资料仍超过安全上下文上限；本次未调用模型，旧快照保持不变。请缩短资料后重试。',
      'The compacted plot sources still exceed the safe context limit; the model was not called and the previous snapshot remains unchanged. Shorten the sources and try again.',
    )
  }
  if (error instanceof PlotTreeSourceError) {
    return text(
      '请先添加章节蓝图、定稿或叙事线索，再生成剧情树。',
      'Add a chapter blueprint, finalized chapter, or narrative thread before generating a plot tree.',
    )
  }
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = raw.replace(/^Error:\s*/, '')
  if (message === 'GRAPH_GENERATION_DETACHED') {
    return text(
      '页面已与本次生成断开。请恢复生成记录查看结果。',
      'This page disconnected from the generation. Recover the generation record to view its result.',
    )
  }
  if (message === 'GRAPH_GENERATION_INCOMPLETE' || message === 'GRAPH_GENERATION_CANCELLED') {
    return text(
      '本次生成未完成保存。请恢复生成记录查看结果和取消状态。',
      'This generation was not saved. Recover the generation record to check its result and cancellation status.',
    )
  }
  const providerRejection = providerContextFailureText(error, text)
  if (providerRejection) return providerRejection
  if (message === 'GRAPH_GENERATION_NOT_CONFIRMABLE') {
    return text(
      '本次结果未保存。请恢复生成记录，检查来源是否变化或生成是否已取消。',
      'The result was not saved. Recover the generation record to check whether its sources changed or it was cancelled.',
    )
  }
  if (message.startsWith('剧情树')
    && SNAPSHOT_VALIDATION_ERROR_ENDINGS.some(ending => message.endsWith(ending))) {
    return text('剧情树快照无效。', 'The plot-tree snapshot is invalid.')
  }
  if (message === '剧情树快照保存失败') {
    return text('无法保存剧情树。', 'Could not save the plot tree.')
  }
  if (message === '剧情资料在生成期间已更新，本次结果未保存，请重新生成。'
    || message === 'Plot sources changed during generation. This result was not saved; generate it again.') {
    return text(
      '剧情资料在生成期间已更新，本次结果未保存，请重新生成。',
      'Plot sources changed during generation. This result was not saved; generate it again.',
    )
  }
  if (error instanceof PlotTreeIncompleteError) {
    if (error.finishReason === 'length') {
      return text(
        '剧情树输出达到模型最大长度，结果未保存，请提高最大输出 Tokens 或缩短项目资料。',
        'Plot-tree output reached the model maximum output length and was not saved. Increase maximum output tokens or shorten the project sources.',
      )
    }
    if (error.finishReason === 'content_filter') {
      return text(
        '剧情树输出因内容限制未完成，结果未保存。',
        'Plot-tree output was stopped by the content policy and was not saved.',
      )
    }
    if (error.finishReason === 'cancelled') {
      return text(
        '剧情树生成已取消，结果未保存。',
        'Plot-tree generation was cancelled and the result was not saved.',
      )
    }
    return text(
      '剧情树生成未正常完成，结果未保存。',
      'Plot-tree generation did not complete normally and the result was not saved.',
    )
  }
  return text(...fallback)
}

export type BoundPlanCandidate = NarrativeThreadPlanCandidate & { generationIndex?: number; generationHandle?: MainGenerationRunHandle }

export interface BoundEventCandidate extends NarrativeThreadEventCandidate {
  generationIndex?: number
  generationHandle?: MainGenerationRunHandle
  planId: number
  draftId: number
  chapterNumber: number
}

/**
 * 剧情树与伏笔线索的数据：线索计划的增删改、定稿事件确认、剧情树生成与清除、AI 候选与生成记录恢复。
 * 「剧情与伏笔」页用它；危险操作的确认由页面呈现。
 */
export function usePlotThreads(projectKey: string, {
  candidateGenerator,
  initialView = 'plans',
  viewRequest,
  plotTreeGenerator,
}: PlotThreadsOptions = {}) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const models = useLLMStore(s => s.models)
  const planningModelId = useLLMStore(s => routeStageModel('planning', s).modelId)
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
  const [planCandidates, setPlanCandidates] = useState<BoundPlanCandidate[]>([])
  const [eventCandidates, setEventCandidates] = useState<BoundEventCandidate[]>([])
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [view, setView] = useState<'plot-tree' | 'plans'>(initialView)
  const [plotSources, setPlotSources] = useState<PlotTreeSourceBundle | null>(null)
  const [plotModelId, setPlotModelId] = useState<string | null>(null)
  const [plotBusy, setPlotBusy] = useState(false)
  const [plotError, setPlotError] = useState('')
  const [sourcePlanId, setSourcePlanId] = useState<number | null>(null)
  const candidateAbortRef = useRef<AbortController | null>(null)
  const plotAbortRef = useRef<AbortController | null>(null)
  const graphClient = useRef<ReturnType<typeof createGraphGeneration> | null>(null)
  const [graphRecovery, setGraphRecovery] = useState<GraphGenerationRecovery | null>(null)
  const [graphRuns, setGraphRuns] = useState<MainGenerationRunView[]>([])
  const [graphError, setGraphError] = useState('')
  const previousViewRequestRef = useRef(viewRequest)
  const dormantThreshold = resolveNarrativeThreadDormantThreshold(
    currentProject?.novelConfig.narrativeThreadDormantChapterThreshold,
  )
  const generationModels = models.filter(isGenerationModel)
  const fallbackModelId = preferredGenerationModelId(models, planningModelId)
  const selectedModelId = aiModelId ?? fallbackModelId
  const selectedModel = generationModels.find(model => model.id === selectedModelId)
  const selectedPlotModelId = plotModelId ?? fallbackModelId
  const selectedPlotModel = generationModels.find(model => model.id === selectedPlotModelId)
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
  const plotModelSelectionError = generationModels.length === 0
    ? modelSelectionError
    : !selectedPlotModel
      ? text(
          '所选剧情树模型已不可用，请重新选择。',
          'The selected plot-tree model is unavailable. Select another model.',
        )
      : ''

  const loadGraphRuns = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    try {
      const runs = await ipc.invokeWithProjectSession(session, 'generation:list')
      if (isProjectSessionCurrent(session)) setGraphRuns(runs.filter(run => ['plot-tree-snapshot', 'narrative-thread-plan-candidate', 'narrative-thread-event-candidate'].includes(run.operation ?? '')))
    } catch { if (isProjectSessionCurrent(session)) setGraphError(text('无法读取生成历史。', 'Could not read generation history.')) }
  }, [projectKey, text])
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) void loadGraphRuns() })
    return () => { active = false }
  }, [loadGraphRuns, currentProject?.sessionLease])
  const showGraphRecovery = (value: GraphGenerationRecovery) => {
    setGraphRecovery(value)
    const result = value.result
    const confirmed = new Set(value.effects.map(effect => effect.index))
    setPlanCandidates([])
    setEventCandidates([])
    if (result?.kind === 'plan') {
      setAiMode('plan'); setAiOpen(true)
      setPlanCandidates(result.candidates.map((candidate, generationIndex) => ({ ...candidate, generationIndex, generationHandle: value.view.handle })).filter(candidate => !confirmed.has(candidate.generationIndex)))
    } else if (result?.kind === 'event' && value.context.kind === 'event') {
      const context = value.context
      setAiMode('event'); setAiOpen(true)
      setEventCandidates(result.candidates.map((candidate, generationIndex) => ({ ...candidate, generationIndex, generationHandle: value.view.handle,
        planId: context.plan.id, draftId: context.source.draftId, chapterNumber: context.source.chapterNumber,
      })).filter(candidate => !confirmed.has(candidate.generationIndex)))
    }
  }
  const startGraph = async (input: GraphGenerationInput, modelId: string) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) throw new Error('GRAPH_GENERATION_PROJECT_REQUIRED')
    graphClient.current?.detach()
    const client = createGraphGeneration(session)
    graphClient.current = client
    const opened = await client.open({ input, modelId, uiActionNonce: crypto.randomUUID() })
    if (!isProjectSessionCurrent(session) || graphClient.current !== client) throw new Error('GRAPH_GENERATION_DETACHED')
    showGraphRecovery(opened)
    void loadGraphRuns()
    const value = await client.execute()
    if (!isProjectSessionCurrent(session) || graphClient.current !== client) throw new Error('GRAPH_GENERATION_DETACHED')
    showGraphRecovery(value)
    assertGraphResult(value)
    return { client, value }
  }
  const restoreGraph = async (run: MainGenerationRunView) => {
    if (plotBusy || aiBusy) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    graphClient.current?.detach()
    const client = createGraphGeneration(session)
    graphClient.current = client
    try {
      const value = await client.open({ handle: run.handle })
      if (isProjectSessionCurrent(session) && graphClient.current === client) { showGraphRecovery(value); setGraphError('') }
    } catch { setGraphError(text('无法恢复原生成记录。', 'Could not recover the original generation.')) }
  }
  const continueGraph = async () => {
    const client = graphClient.current
    if (!client || !graphRecovery || plotBusy || aiBusy || !canExecuteGraph(graphRecovery)) return
    const setGenerationBusy = graphRecovery.context.kind === 'plot' ? setPlotBusy : setAiBusy
    setGenerationBusy(true)
    setGraphError('')
    try {
      const value = await client.execute()
      if (graphClient.current === client) showGraphRecovery(value)
      assertGraphResult(value)
    } catch (error) {
      if (graphClient.current === client) setGraphError(providerContextFailureText(error, text) ?? text('原运行未完成，结果已保留。', 'The original run did not complete; its output is preserved.'))
    } finally {
      if (graphClient.current === client) setGenerationBusy(false)
    }
  }
  const confirmGraph = async (index: number, expectedHandle?: MainGenerationRunHandle) => {
    const client = graphClient.current
    if (!client) throw new Error('GRAPH_GENERATION_NOT_OPEN')
    const effect = await client.confirm(index, expectedHandle)
    const value = await client.read()
    if (graphClient.current === client) showGraphRecovery(value)
    return effect
  }
  const cancelGraph = async () => {
    const client = graphClient.current
    if (!client) return
    try {
      await client.cancel()
      const value = await client.read()
      if (graphClient.current === client) showGraphRecovery(value)
    } catch { setGraphError(text('取消状态尚未确认。', 'Cancellation is not confirmed.')) }
  }

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

  const loadPlotTree = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    try {
      const sources = await ipc.invokeWithProjectSession(
        session,
        'db:plot-tree-read',
        projectKey,
      )
      if (!isProjectSessionCurrent(session)) return
      setPlotSources(sources)
      setPlotError('')
    } catch (error) {
      if (isProjectSessionCurrent(session)) {
        setPlotError(plotTreeErrorMessage(
          error,
          text,
          ['无法读取剧情树资料。', 'Could not read plot tree sources.'],
        ))
      }
    }
  }, [projectKey, text])

  useEffect(() => {
    if (view === 'plans') queueMicrotask(() => { void reload() })
  }, [reload, currentProject?.sessionLease, view])

  useEffect(() => {
    if (view === 'plot-tree') queueMicrotask(() => { void loadPlotTree() })
  }, [loadPlotTree, currentProject?.sessionLease, view])

  useEffect(() => {
    if (previousViewRequestRef.current === viewRequest) return
    previousViewRequestRef.current = viewRequest
    setView(initialView)
  }, [initialView, viewRequest])

  useEffect(() => {
    if (view !== 'plans' || sourcePlanId === null) return
    document.getElementById(`narrative-plan-${sourcePlanId}`)?.scrollIntoView({ block: 'center' })
  }, [sourcePlanId, threads, view])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setGraphRecovery(null)
      setGraphRuns([])
      setPlotBusy(false)
      setAiBusy(false)
      setAiOpen(false)
      setPlanCandidates([])
      setEventCandidates([])
    })
    return () => {
      active = false
      plotAbortRef.current?.abort()
      candidateAbortRef.current?.abort()
      graphClient.current?.detach()
      graphClient.current = null
    }
  }, [currentProject?.sessionLease, projectKey])

  useEffect(() => {
    if (!loadedModels) void loadModels()
  }, [loadModels, loadedModels])

  const closeAI = useCallback(() => {
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = null
    graphClient.current?.detach()
    graphClient.current = null
    setGraphRecovery(null)
    setAiOpen(false)
    setAiBusy(false)
    setAiError('')
    setPlanCandidates([])
    setEventCandidates([])
  }, [])

  const refreshPlotTree = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const uiLocale = useLocaleStore.getState().locale
    const uiText: LocaleText = (zhCNText, enUSText) => uiLocale === 'en-US' ? enUSText : zhCNText
    const frozenModelId = selectedPlotModel?.id
    if (!session || !isProjectSessionPath(session, projectKey) || !plotSources
      || !frozenModelId || plotBusy || aiBusy) return
    const controller = new AbortController()
    plotAbortRef.current?.abort()
    plotAbortRef.current = controller
    setPlotBusy(true)
    setPlotError('')
    let failureCode: PlotTreeGenerationErrorCode | PlotTreeResponseErrorCode
      | 'sources_changed' | 'length' | 'save_failed' | null = null
    try {
      if (!plotTreeGenerator) {
        const { value } = await startGraph({ kind: 'plot' }, frozenModelId)
        if (value.result?.kind !== 'plot') throw new Error('GRAPH_GENERATION_KIND_MISMATCH')
        if (value.sourceStatus !== 'current') throw new Error(uiText(
          '剧情资料在生成期间已更新，本次结果未保存，请重新生成。',
          'Plot sources changed during generation. This result was not saved; generate it again.',
        ))
        const effect = await confirmGraph(0, value.view.handle)
        if (effect.kind === 'plot' && isProjectSessionCurrent(session)) setPlotSources(previous => previous ? { ...previous, snapshot: effect.snapshot } : previous)
        return
      }
      const snapshot = await plotTreeGenerator({
        modelId: frozenModelId,
        projectSession: session,
        sources: plotSources,
        signal: controller.signal,
      })
      if (!isProjectSessionCurrent(session) || controller.signal.aborted) return
      let saved
      try {
        saved = await ipc.invokeWithProjectSession(
          session,
          'db:plot-tree-save',
          snapshot,
          plotSources.sourceRevision,
          projectKey,
        )
      } catch {
        failureCode = 'save_failed'
        throw new Error(uiText('剧情树快照保存失败', 'Could not save the plot-tree snapshot.'))
      }
      if (!isProjectSessionCurrent(session) || controller.signal.aborted) return
      const savedSnapshot = saved.snapshot
      if (!saved.success || !savedSnapshot) {
        if (saved.errorCode === 'sources-changed') {
          failureCode = 'sources_changed'
          await loadPlotTree()
        } else {
          failureCode = 'save_failed'
        }
        throw new Error(saved.errorCode === 'sources-changed'
          ? uiText(
              '剧情资料在生成期间已更新，本次结果未保存，请重新生成。',
              'Plot sources changed during generation. This result was not saved; generate it again.',
            )
          : uiText('剧情树快照保存失败', 'Could not save the plot-tree snapshot.'))
      }
      setPlotSources(previous => previous ? { ...previous, snapshot: savedSnapshot } : previous)
    } catch (error) {
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) {
        failureCode ??= error instanceof PlotTreeGenerationError
          ? error.code
          : error instanceof PlotTreeResponseError
            ? error.code
            : error instanceof PlotTreeIncompleteError && error.finishReason === 'length'
              ? 'length'
              : null
        if (failureCode) {
          useWorkflowStore.getState().addLog(
            'error',
            uiText(
              `剧情树生成失败（错误码：${failureCode}）。`,
              `Plot-tree generation failed (error code: ${failureCode}).`,
            ),
          )
        }
        setPlotError(plotTreeErrorMessage(
          error,
          uiText,
          ['剧情树生成失败。', 'Could not generate the plot tree.'],
        ))
      }
    } finally {
      if (plotAbortRef.current === controller) plotAbortRef.current = null
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) setPlotBusy(false)
    }
  }

  const clearPlotTree = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || !plotSources?.snapshot) return
    setPlotError('')
    try {
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:plot-tree-clear',
        projectKey,
      )
      if (!isProjectSessionCurrent(session)) return
      if (!result.success) throw new Error(result.error ?? text(
        '无法清除剧情树。',
        'Could not clear the plot tree.',
      ))
      setPlotSources(previous => previous ? { ...previous, snapshot: null } : previous)
    } catch (error) {
      if (isProjectSessionCurrent(session)) {
        setPlotError(plotTreeErrorMessage(
          error,
          text,
          ['无法清除剧情树。', 'Could not clear the plot tree.'],
        ))
      }
    }
  }

  const openPlotSource = (source: PlotTreeSourceReference) => {
    if (source.type === 'blueprint') {
      openBuiltinEditor(
        'chapter-card-editor',
        text('章节蓝图', 'Chapter blueprint'),
        'chapter-card',
        undefined,
        source.chapterNumber,
      )
      return
    }
    if (source.type === 'finalized-chapter') {
      void openChapterFile(
        formatResourceUri({ kind: 'manuscript', id: source.draftId }),
        text(`第 ${source.chapterNumber} 章定稿`, `Chapter ${source.chapterNumber} finalized draft`),
      )
      return
    }
    setSourcePlanId(source.planId)
    setView('plans')
  }

  const openAI = (mode: AICandidateMode) => {
    if (plotBusy || aiBusy) return
    if (mode === 'event' && (eventPlanId === null || eventDraftId === 0)) return
    setAiMode(mode)
    // 沿用作者已选、仍可用的模型；没有选过或已不可用时才回到默认。
    setAiModelId(current => generationModels.some(model => model.id === current) ? current : fallbackModelId)
    if (mode === 'plan') setAiBlueprintChapter(blueprints[0]?.chapterNumber ?? 0)
    setPlanCandidates([])
    setEventCandidates([])
    setAiError('')
    setAiOpen(true)
  }

  const generatePlanCandidates = async () => {
    const projectSnapshot = useProjectStore.getState().currentProject
    const session = captureProjectSession(projectSnapshot)
    const blueprint = blueprints.find(item => item.chapterNumber === aiBlueprintChapter)
    const frozenModelId = selectedModel?.id
    const totalChapters = projectSnapshot?.novelConfig.totalChapters
    if (!session || !isProjectSessionPath(session, projectKey) || !blueprint || !frozenModelId || !totalChapters || aiBusy || plotBusy) return
    const controller = new AbortController()
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = controller
    setAiBusy(true)
    setAiError('')
    setPlanCandidates([])
    try {
      if (!candidateGenerator) { await startGraph({ kind: 'plan', chapterNumber: blueprint.chapterNumber }, frozenModelId); return }
      const candidates = await candidateGenerator.generatePlanCandidates({
        modelId: frozenModelId,
        writingLanguage: resolveWritingLanguage(projectSnapshot.novelConfig.writingLanguage),
        totalChapters,
        blueprint,
        signal: controller.signal,
      })
      if (!isProjectSessionCurrent(session) || controller.signal.aborted) return
      setPlanCandidates(candidates)
    } catch (error) {
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) {
        setAiError(providerContextFailureText(error, text) ?? text('未生成有效的计划候选，请重试。', 'No valid plan candidates were generated. Try again.'))
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
      || !draftSnapshot || !frozenModelId || aiBusy || plotBusy) return
    const controller = new AbortController()
    candidateAbortRef.current?.abort()
    candidateAbortRef.current = controller
    setAiBusy(true)
    setAiError('')
    setEventCandidates([])
    try {
      if (!candidateGenerator) { await startGraph({ kind: 'event', planId: planSnapshot.id, draftId: draftSnapshot.id }, frozenModelId); return }
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
    } catch (error) {
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) {
        setAiError(providerContextFailureText(error, text) ?? text(
          '未生成带有效定稿证据的事件候选，请重试。',
          'No event candidate with valid finalized evidence was generated. Try again.',
        ))
      }
    } finally {
      if (candidateAbortRef.current === controller) candidateAbortRef.current = null
      if (isProjectSessionCurrent(session) && !controller.signal.aborted) setAiBusy(false)
    }
  }

  const confirmPlanCandidate = async (candidate: BoundPlanCandidate) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return
    setBusy(true)
    try {
      if (candidate.generationIndex !== undefined) { await confirmGraph(candidate.generationIndex, candidate.generationHandle); await reload(); return }
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
      if (candidate.generationIndex !== undefined) { await confirmGraph(candidate.generationIndex, candidate.generationHandle); await reload(); return }
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

  /** 保存新建或编辑中的线索计划，成功时返回 true。 */
  const savePlan = async (): Promise<boolean> => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey) || busy) return false
    setBusy(true)
    try {
      const result = editingId === null
        ? await ipc.invokeWithProjectSession(session, 'db:narrative-thread-plan-create', plan, projectKey)
        : await ipc.invokeWithProjectSession(session, 'db:narrative-thread-plan-update', editingId, plan, projectKey)
      if (!result.success) throw new Error(result.error)
      if (!isProjectSessionCurrent(session)) return false
      setPlan(EMPTY_PLAN)
      setEditingId(null)
      await reload()
      return true
    } catch {
      if (isProjectSessionCurrent(session)) toast.error(text('保存叙事线索失败', 'Could not save narrative thread'))
      return false
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
      if (!result.success) throw new Error(result.error ?? 'event confirmation failed')
      if (!isProjectSessionCurrent(session)) return
      setEventPlanId(null)
      setEventEvidence('')
      setEventReason('')
      await reload()
    } catch (error) {
      if (!isProjectSessionCurrent(session)) return
      // 主进程用登记过的码拒绝（如短证据不在定稿正文里）时在表单里说明原因，作者改完能直接重试；其余仍是笼统提示。
      const reason = knownAppErrorMessage(useLocaleStore.getState().locale, error)
      if (reason) setEventError(reason)
      else toast.error(text('保存定稿事件失败', 'Could not save finalized event'))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }


  /** 复制原运行的结果：有结构化结果时复制 JSON，否则复制原运行的候选或产物文字。 */
  const copyOriginalResult = async () => {
    if (!graphRecovery) return
    await navigator.clipboard.writeText(graphRecovery.result
      ? JSON.stringify(graphRecovery.result, null, 2)
      : (graphRecovery.view.candidates ?? graphRecovery.view.artifacts).map(item => item.text).join('\n'))
  }

  const cancelOriginalRun = () => {
    const client = graphClient.current
    if (!client) return
    void client.cancel()
      .then(() => client.read())
      .then(value => { if (graphClient.current === client) showGraphRecovery(value) })
      .catch(() => setGraphError(text('取消状态尚未确认。', 'Cancellation is not confirmed.')))
  }

  const saveOriginalPlotTree = () => {
    if (!graphRecovery) return
    void confirmGraph(0, graphRecovery.view.handle)
      .then(() => loadPlotTree())
      .catch(() => setGraphError(text('无法保存原剧情树。', 'Could not save the original plot tree.')))
  }

  const rejectPlanCandidate = (candidate: BoundPlanCandidate) => setPlanCandidates(previous => previous.filter(item => item !== candidate))
  const rejectEventCandidate = (candidate: BoundEventCandidate) => setEventCandidates(previous => previous.filter(item => item !== candidate))

  const startEditingPlan = (thread: NarrativeThreadView) => {
    setEditingId(thread.id)
    setPlan({ title: thread.title, type: thread.type, targetStartChapter: thread.targetStartChapter, targetEndChapter: thread.targetEndChapter, authorIntent: thread.authorIntent })
  }

  const resetPlan = () => {
    setEditingId(null)
    setPlan(EMPTY_PLAN)
  }

  const startEvent = (planId: number | null) => {
    setEventPlanId(planId)
    setEventError('')
  }

  return {
    view, setView, sourcePlanId,
    threads, finalizedDrafts, blueprints, dormantThreshold, busy,
    plan, setPlan, editingId, startEditingPlan, resetPlan, savePlan, deletePlan,
    eventPlanId, startEvent, eventDraftId, setEventDraftId, eventType, setEventType,
    eventEvidence, setEventEvidence, eventReason, setEventReason, eventError, saveEvent,
    generationModels, plotSources, selectedPlotModel, setPlotModelId, plotBusy, plotError, plotModelSelectionError,
    refreshPlotTree, clearPlotTree, openPlotSource,
    aiOpen, aiMode, aiBusy, aiError, selectedModelId, setAiModelId, modelSelectionError,
    aiBlueprintChapter, setAiBlueprintChapter, planCandidates, eventCandidates,
    openAI, closeAI, generatePlanCandidates, generateEventCandidates,
    confirmPlanCandidate, rejectPlanCandidate, confirmEventCandidate, rejectEventCandidate,
    graphRuns, graphRecovery, graphError, loadGraphRuns, restoreGraph, continueGraph, cancelGraph,
    copyOriginalResult, cancelOriginalRun, saveOriginalPlotTree, setAiError,
  }
}
