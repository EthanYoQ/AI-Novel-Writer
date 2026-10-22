import { useCallback, useEffect, useRef, useState } from 'react'
import { appErrorMessage } from '../../../i18n/app-errors'
import type { Locale } from '../../../i18n/types'
import { ipc } from '../../../services/ipc-client'
import {
  selectPlanningMaterials,
  unwrapKnowledgeValue,
  type KBDocument, type KBStatsData, type SearchResult, type VectorRebuildStatus,
} from '../../../services/knowledge-service'
import {
  createPlanningMaterialCharacterExtractionWorkflow,
  createPlanningMaterialWorkflow,
} from '../../../services/workflows/planning-material-workflow'
import { globalEventBus } from '../../../shared/event-bus'
import type { ModelProfile, ProjectSessionContext } from '../../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import { knowledgeDraftDirty, type KnowledgeDraft } from '../../../stores/editor-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../../stores/workflow-store'
import { workflowMainProcessError } from '../../../services/workflows/workflow-project-session'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { toast } from '../../ui/Toast'
import { pluralEn } from '../../../shared/plural-en'

const EMPTY_STATS: KBStatsData = { documentCount: 0, totalChunks: 0, vectorDimension: 0 }
export const EMPTY_DRAFT: KnowledgeDraft = { docId: null, copy: null, content: '' }

/**
 * kb 通道返回的失败结果：主进程交的是错误码（#474），按 workflowMainProcessError 的约定接在说明后面。
 * errorCode 优先，因为同一结果里的 error 可能是按系统语言写好的说明。
 */
function knowledgeFailureMessage(locale: Locale, result: { error?: string; errorCode?: string }, zhCNSummary: string, enUSSummary: string): string {
  return workflowMainProcessError({ uiLocale: locale }, result.errorCode ?? result.error, zhCNSummary, enUSSummary).message
}

/**
 * 所选资料与改动存放的位置：知识库标签上，换页再回来不丢。
 * 第三项读此刻的值：读写返回时页面可能已换了实例，只认这一格里现在放着的。
 */
export type KnowledgeDraftSlot = readonly [KnowledgeDraft, (next: KnowledgeDraft) => void, () => KnowledgeDraft]

/** 定稿章节由定稿自动收入，要改就改正文；其余都是作者导入的资料。 */
export function isImportedDocument(document: KBDocument): boolean {
  return document.finalizedChapter === undefined
}

/**
 * 检索索引的状态与检查重建，放在设置的检索模型页；
 * 状态检查只读本地数据，重建会按当前检索模型补全或重建。
 */
export function useKnowledgeIndex() {
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const [status, setStatus] = useState<VectorRebuildStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [backfilling, setBackfilling] = useState(false)
  // 只有最后一次读取写状态：连改两次检索模型时，先发的那次晚到也不会写回过时的提示。
  const statusRequest = useRef(0)

  const loadStatus = useCallback(async () => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) return
    const request = ++statusRequest.current
    const latest = () => request === statusRequest.current && isProjectSessionCurrent(projectSession)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:get-vector-rebuild-status', projectSession.projectPath)
      if (!latest()) return
      setStatus(unwrapKnowledgeValue(result))
      setStatusError('')
    } catch (error) {
      if (latest()) setStatusError(appErrorMessage(locale, error))
    }
  }, [locale])

  // 状态检查的唯一自动触发：挂载、换了作品或重新打开，以及模型配置变了（设置里保存或删除检索模型只改模型仓库，
  // 设置页与后台挂着的知识库页都不会重新挂载）。资料增删由各自的操作与资源刷新事件显式重读。
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const models = useLLMStore(s => s.models)
  const embeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  useEffect(() => {
    Promise.resolve().then(() => loadStatus())
  }, [loadStatus, projectPath, sessionLease, models, embeddingModelId])

  const backfill = useCallback(async () => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    setBackfilling(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:backfill-vectors', expectedProjectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        toast.success(result.processed === 0
          ? text('检查完成，当前检索模型不需要重建', 'Check complete. The current retrieval model needs no rebuild.')
          : text(`检索已重建：处理了 ${result.processed} 段资料${result.failed > 0 ? `，${result.failed} 段失败` : ''}`, `Search rebuilt: ${result.processed} ${pluralEn(result.processed, 'passage')} processed${result.failed > 0 ? `, ${result.failed} failed` : ''}`))
      } else {
        toast.error(knowledgeFailureMessage(locale, result, '重建检索失败', 'Could not rebuild search.'))
      }
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) {
        setBackfilling(false)
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'], projectPath: expectedProjectPath, projectSession })
      }
    }
  }, [locale, text])

  const reset = useCallback(() => {
    setStatus(null)
    setStatusError('')
    setBackfilling(false)
  }, [])

  return { status, statusError, backfilling, loadStatus, backfill, reset }
}

/**
 * 知识库的数据：资料列表与统计、资料原文的项目副本（读、改、存、更新本地索引）、检索、清空与导入创作资料。
 * 知识库页用它。确认（切换时放弃修改、清空、外发提取）由页面呈现，
 * 这里只在确认之后执行。
 */
export function useKnowledgeBase(draftSlot?: KnowledgeDraftSlot) {
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const locale = useLocaleStore(s => s.locale)
  const text = useLocaleStore(s => s.text)
  const index = useKnowledgeIndex()
  const { loadStatus, reset: resetIndex } = index
  const [documents, setDocuments] = useState<KBDocument[]>([])
  // 这次打开的资料列表读过一次（成功或失败）之前，空列表不等于知识库是空的。
  const [documentsLoaded, setDocumentsLoaded] = useState(false)
  const [stats, setStats] = useState<KBStatsData>(EMPTY_STATS)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  // 当前结果是按哪个词查出来的；结果被保存、更新检索、清空或换作品清掉时一起清，查找出错时也清，「没有找到」只说真查过的词。
  const [searchedQuery, setSearchedQuery] = useState('')
  const [searching, setSearching] = useState(false)
  // 每次查找与清除都作废之前还没返回的查找：只有最新的一次写结果、结束「查找中」。submittedQuery 是最近一次提交的词（可能还在查）。
  const searchRequest = useRef(0)
  const submittedQuery = useRef('')
  const resetResults = useCallback(() => {
    setSearchResults([])
    setSearchedQuery('')
  }, [])
  /** 清掉查找结果，并作废还没返回的查找。 */
  const clearResults = useCallback(() => {
    searchRequest.current++
    submittedQuery.current = ''
    setSearching(false)
    resetResults()
  }, [resetResults])
  const [topK, setTopK] = useState(10)
  const [clearing, setClearing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [localDraft, setLocalDraft] = useState<KnowledgeDraft>(EMPTY_DRAFT)
  const localDraftRef = useRef(localDraft)
  const writeLocalDraft = useCallback((next: KnowledgeDraft) => { localDraftRef.current = next; setLocalDraft(next) }, [])
  const readLocalDraft = useCallback(() => localDraftRef.current, [])
  const draft = draftSlot ? draftSlot[0] : localDraft
  const setDraft = draftSlot ? draftSlot[1] : writeLocalDraft
  const readDraft = draftSlot ? draftSlot[2] : readLocalDraft
  const openedSession = useRef<string | null>(null)
  const restoredDraft = useRef<KnowledgeDraft | null>(draft)
  const selectedDocId = draft.docId
  const documentCopy = draft.copy
  const draftContent = draft.content
  const documentBusy = Boolean(draft.busy)

  /** 读写在途时作者可能换了资料、改了字，或另一个页面实例接手了这一格；只有它仍是发起时那一份才写回。 */
  const replaceDraft = (expected: KnowledgeDraft, next: KnowledgeDraft) => {
    if (readDraft() === expected) setDraft(next)
  }

  const loadData = useCallback(async () => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    try {
      const [documentsResult, statsResult] = await Promise.all([
        ipc.invokeWithProjectSession(projectSession, 'kb:list-documents', expectedProjectPath),
        ipc.invokeWithProjectSession(projectSession, 'kb:stats', expectedProjectPath),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      setDocuments(unwrapKnowledgeValue(documentsResult))
      setStats(unwrapKnowledgeValue(statsResult))
      setLoadError('')
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setLoadError(appErrorMessage(locale, error))
    }
    setDocumentsLoaded(true)
  }, [locale])

  /** 打开一份资料的项目副本。有未保存的修改时调用方须先征得作者同意。 */
  const openDocument = async (docId: string, reload = false) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    if (!reload && docId === readDraft().docId) return
    const loading: KnowledgeDraft = { docId, copy: null, content: '' }
    setDraft(loading)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:read-document-copy', docId, session.projectPath))
      if (isProjectSessionCurrent(session)) replaceDraft(loading, { docId, copy: result, content: result.content ?? '' })
    } catch (error) {
      if (!isProjectSessionCurrent(session) || readDraft() !== loading) return
      // 读不出来就回到没选资料的样子：不留「正在读取」，作者再点这一份会重读。
      setDraft(EMPTY_DRAFT)
      toast.error(appErrorMessage(locale, error))
    }
  }
  const openDocumentRef = useRef(openDocument)
  useEffect(() => { openDocumentRef.current = openDocument })

  // 只在换了作品或重新打开时清空；同一次打开里作品数据换成新对象（后台写回设定）不清，未保存的改动留着。
  useEffect(() => {
    if (!projectPath || !sessionLease) return
    const sessionKey = JSON.stringify([projectPath, sessionLease])
    const switched = openedSession.current !== null && openedSession.current !== sessionKey
    openedSession.current = sessionKey
    let mounted = true
    Promise.resolve().then(() => {
      if (!mounted) return
      if (switched) {
        setDocuments([])
        setDocumentsLoaded(false)
        setStats(EMPTY_STATS)
        clearResults()
        setDraft(EMPTY_DRAFT)
        resetIndex()
        setLoadError('')
        setClearing(false)
      } else if (restoredDraft.current) {
        // 标签切回来时重读所选资料，刷新检索状态；有未保存改动就原样留着，保存时由副本校验发现冲突。
        // 保存或更新检索在途时也不重读：这一格归在途的那次，它返回时自己重读并结算 busy。
        const restored = restoredDraft.current
        if (restored.docId && !restored.busy && !knowledgeDraftDirty(restored)) void openDocumentRef.current(restored.docId, true)
      }
      restoredDraft.current = null
      void loadData()
    })
    return () => { mounted = false }
  }, [projectPath, sessionLease, loadData, resetIndex, setDraft, clearResults])

  useEffect(() => {
    const current = () => captureProjectSession(useProjectStore.getState().currentProject)
    const offRefresh = globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      const projectSession = current()
      if (
        projectSession
        && sameProjectSessionContext(projectSession, payload.projectSession)
        && (payload.resources.includes('all') || payload.resources.includes('fileTree'))
      ) {
        void loadData()
        void loadStatus()
      }
    })
    const offFinalize = globalEventBus.on('FINALIZE_COMPLETE', ({ projectSession: eventSession }) => {
      const projectSession = current()
      if (!projectSession || !sameProjectSessionContext(projectSession, eventSession)) return
      void loadData()
      void loadStatus()
    })
    return () => { offRefresh(); offFinalize() }
  }, [loadData, loadStatus])

  /** 项目副本改过但还没保存。 */
  const dirty = knowledgeDraftDirty(draft)
  const setDraftContent = (content: string) => setDraft({ ...draft, content })

  /** 保存项目副本。Ctrl S 与退出前保存在页面卸载后也会调到这里；正在保存时再调不重复发送。 */
  const saveDocument = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const current = readDraft()
    const { docId, copy } = current
    if (current.busy || !session || !docId || !copy?.available || !copy.contentHash) return
    const saving = { ...current, busy: true }
    setDraft(saving)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:save-document-copy', docId, current.content, copy.contentHash, session.projectPath))
      if (!isProjectSessionCurrent(session)) return
      if (!result.success) { toast.error(knowledgeFailureMessage(locale, result, '保存失败', 'Save failed.')); return }
      if (readDraft() === saving) await openDocument(docId, true)
      clearResults()
      toast.success(text('项目副本已保存；更新检索后，写作时才能查到新内容', 'Project copy saved. Update search so writing can find the new text.'))
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(appErrorMessage(locale, error))
    } finally {
      replaceDraft(saving, current)
    }
  }

  const reindexDocument = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const current = readDraft()
    if (current.busy || !session || !current.docId) return
    const reindexing = { ...current, busy: true }
    setDraft(reindexing)
    try {
      const result = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(session, 'kb:reindex-document-copy', current.docId, session.projectPath))
      if (!isProjectSessionCurrent(session)) return
      if (!result.success || !result.docId) { toast.error(knowledgeFailureMessage(locale, result, '更新检索失败', 'Could not update search.')); return }
      await loadData()
      await loadStatus()
      if (readDraft() === reindexing) await openDocument(result.docId, true)
      clearResults()
      toast.success(text('检索已更新，写作时能查到新内容', 'Search updated. Writing can now find the new text.'))
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(appErrorMessage(locale, error))
    } finally {
      replaceDraft(reindexing, current)
    }
  }

  /** 查找。只有最后一次查找写结果、结束「查找中」，先发的晚到不算。 */
  const search = async (query = searchQuery, limit = topK) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession) return
    const request = ++searchRequest.current
    submittedQuery.current = query
    const latest = () => request === searchRequest.current && isProjectSessionCurrent(projectSession)
    setSearching(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:search', query, limit, projectSession.projectPath)
      if (!latest()) return
      setSearchResults(unwrapKnowledgeValue(result))
      setSearchedQuery(query)
    } catch (error) {
      if (!latest()) return
      resetResults()
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (latest()) setSearching(false)
    }
  }

  /** 改「最多显示」：按最近一次提交的词（还在查的也算）与新的条数重查，不用已显示结果的旧词。 */
  const changeLimit = (limit: number) => {
    setTopK(limit)
    if (submittedQuery.current) void search(submittedQuery.current, limit)
  }

  /** 清空当前作品的知识库。session 是作者确认前取下的会话；确认期间换了作品就不清。 */
  const clearAll = async (projectSession: ProjectSessionContext) => {
    if (!isProjectSessionCurrent(projectSession)) {
      toast.error(text('项目已切换，本次清空操作已取消', 'The project changed, so the clear operation was cancelled'))
      return
    }
    const expectedProjectPath = projectSession.projectPath
    setClearing(true)
    try {
      const result = await ipc.invokeWithProjectSession(projectSession, 'kb:clear-all', expectedProjectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        setDraft(EMPTY_DRAFT)
        setDocuments([])
        setStats(EMPTY_STATS)
        clearResults()
        resetIndex()
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'], projectPath: expectedProjectPath, projectSession })
        toast.success(text('知识库已清空', 'Knowledge base cleared'))
      } else {
        toast.error(knowledgeFailureMessage(locale, result, '清空知识库失败', 'Could not clear the knowledge base.'))
      }
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) setClearing(false)
    }
  }

  /**
   * 导入创作资料：先只存进本地知识库；配置了生成模型时，再经 confirmExtraction 征得同意，把选中的文本发给模型提取角色卡。
   */
  const importPlanningMaterials = async (confirmExtraction: (model: ModelProfile) => Promise<boolean>) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || importing) return
    setImporting(true)
    try {
      const materials = await selectPlanningMaterials()
      if (materials.length === 0 || !isProjectSessionCurrent(projectSession)) return
      const workflowStore = useWorkflowStore.getState()
      const localRunId = await workflowStore.startWorkflow(createPlanningMaterialWorkflow({ projectSession, materials }))
      const localRun = useWorkflowStore.getState().history.find(run => run.id === localRunId)
      if (localRun?.status !== 'completed' || !isProjectSessionCurrent(projectSession)) return

      const llmState = useLLMStore.getState()
      const model = llmState.models.find(candidate => candidate.id === llmState.defaultModelId)
      if (!model) {
        toast.success(text(
          '创作资料已仅导入本地知识库；配置生成模型后可提取角色卡',
          'Planning material was imported only into the local knowledge base. Configure a generation model to extract character cards.',
        ))
        return
      }
      const shouldExtract = await confirmExtraction(model)
      if (!shouldExtract || !isProjectSessionCurrent(projectSession)) return

      const extractionWorkflow = createPlanningMaterialCharacterExtractionWorkflow({ projectSession, materials, generationModelId: model.id })
      const conflict = useWorkflowStore.getState().getResourceConflict(extractionWorkflow)
      if (conflict) {
        toast.warning(workflowResourceConflictMessage(locale, conflict.title))
        return
      }
      navigate({ kind: 'run', facet: 'tasks' })
      await useWorkflowStore.getState().startWorkflow(extractionWorkflow, true)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) toast.error(appErrorMessage(locale, error))
    } finally {
      setImporting(false)
    }
  }

  /** 「刷新资料」：资料列表与索引状态一起重读。 */
  const reload = useCallback(async () => {
    await Promise.all([loadData(), loadStatus()])
  }, [loadData, loadStatus])

  return {
    index, reload,
    documents, documentsLoaded, stats, loadError,
    selectedDocId, documentCopy, draftContent, setDraftContent, documentBusy, dirty,
    openDocument, saveDocument, reindexDocument,
    searchQuery, setSearchQuery, topK, setTopK, changeLimit, searchResults, setSearchResults, searchedQuery, clearResults, searching, search,
    clearing, clearAll,
    importing, importPlanningMaterials,
  }
}
