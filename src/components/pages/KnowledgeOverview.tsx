import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BookOpen, FileText,
  Search, RefreshCw, Layers, Zap, Server, Activity, Trash2, AlertTriangle, Upload,
} from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import PagePlate from '../layout/v2/magazine/PagePlate'
import { PlateFigure, PlateLibrary } from '../layout/v2/magazine/PlateFigures'
import { useProjectStore } from '../../stores/project-store'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { globalEventBus } from '../../shared/event-bus'
import {
  selectPlanningMaterials,
  unwrapKnowledgeValue,
  type KBDocument, type SearchResult, type KBStatsData, type VectorRebuildStatus,
} from '../../services/knowledge-service'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import {
  createPlanningMaterialCharacterExtractionWorkflow,
  createPlanningMaterialWorkflow,
} from '../../services/workflows/planning-material-workflow'
import { useLocaleStore } from '../../stores/locale-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useCharacterStore } from '../../stores/character-store'
import { characterRosterEntriesFromCards } from '../../services/character-roster-client'
import { appErrorMessage } from '../../i18n/app-errors'
import { ipc } from '../../services/ipc-client'
import {
  captureProjectSession,
  isProjectSessionCurrent,
} from '../project-session-gate'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { getVectorRebuildPresentation } from './knowledge-rebuild-presentation'
import CharacterCardCandidateDialog from '../characters/CharacterCardCandidateDialog'
import { useCharacterCardCandidates } from '../characters/use-character-card-candidates'

/**
 * 知识库概览页面 — LanceDB 向量数据库的管理中心
 * 当侧栏视图为"知识库"时，作为中间编辑区的固定内容展示。
 */
export default function KnowledgeOverview() {
  const [documents, setDocuments] = useState<KBDocument[]>([])
  const [stats, setStats] = useState<KBStatsData>({ documentCount: 0, totalChunks: 0, vectorDimension: 0 })
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [topK, setTopK] = useState(10)
  const [vectorRebuildStatus, setVectorRebuildStatus] = useState<VectorRebuildStatus | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState('')

  const currentProject = useProjectStore(s => s.currentProject)
  const { locale, text } = useLocaleStore()
  /** 角色卡候选的确认-提交控制器：与角色栏的「粘贴 / 导入角色卡」共用同一套状态机。 */
  const candidateFlow = useCharacterCardCandidates()
  const characterCards = useCharacterStore(state => state.characters)
  // 同名识别与合并窗口要用当前名单（与角色栏共用同一个 store），
  // 转成角色名单条目形状后才有结构化的关系字段。
  const characterRosterEntries = useMemo(
    () => characterRosterEntriesFromCards(characterCards),
    [characterCards],
  )

  const loadData = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    try {
      const [documentsResult, statsResult] = await Promise.all([
        ipc.invokeWithProjectSession(projectSession, 'kb:list-documents', expectedProjectPath),
        ipc.invokeWithProjectSession(projectSession, 'kb:stats', expectedProjectPath),
      ])
      if (!isProjectSessionCurrent(projectSession)) return
      const docs = unwrapKnowledgeValue(documentsResult)
      const s = unwrapKnowledgeValue(statsResult)
      setDocuments(docs)
      setStats(s)
      setLoadError('')
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setLoadError(appErrorMessage(locale, error))
    }
  }, [currentProject, locale])

  const loadVectorRebuildStatus = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    try {
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:get-vector-rebuild-status',
        expectedProjectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      setVectorRebuildStatus(unwrapKnowledgeValue(result))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      setLoadError(appErrorMessage(locale, error))
    }
  }, [currentProject, locale])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => {
      const projectSession = captureProjectSession(currentProject)
      if (!mounted || !projectSession) return
      setDocuments([])
      setStats({ documentCount: 0, totalChunks: 0, vectorDimension: 0 })
      setSearchResults([])
      setVectorRebuildStatus(null)
      setLoadError('')
      setSearching(false)
      setBackfilling(false)
      setClearing(false)
      loadData()
      loadVectorRebuildStatus()
    })
    return () => { mounted = false }
  }, [currentProject, loadData, loadVectorRebuildStatus])

  useEffect(() => {
    Promise.resolve().then(() => loadVectorRebuildStatus())
  }, [loadVectorRebuildStatus, documents])

  // 通过 EventBus 监听资源刷新和定稿完成事件
  useEffect(() => {
    const unsub1 = globalEventBus.on('REFRESH_RESOURCE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (
        projectSession
        && sameProjectSessionContext(projectSession, payload.projectSession)
        && (payload.resources.includes('all') || payload.resources.includes('fileTree'))
      ) {
        loadData()
        loadVectorRebuildStatus()
      }
    })
    const unsub2 = globalEventBus.on('FINALIZE_COMPLETE', ({ projectSession: eventSession }) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !sameProjectSessionContext(projectSession, eventSession)) return
      loadData()
      loadVectorRebuildStatus()
    })
    return () => { unsub1(); unsub2() }
  }, [currentProject, loadData, loadVectorRebuildStatus])

  // 判断检索模式
  const hasVectors = stats.vectorDimension > 0
  const searchMode = hasVectors ? text('混合检索', 'Hybrid search') : text('BM25 全文检索', 'BM25 full-text search')
  const rebuildPresentation = getVectorRebuildPresentation(vectorRebuildStatus)

  if (!currentProject) {
    return (
      <div className="skin-workspace-page h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              {text('知识库', 'Knowledge base')}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message={text('请先打开项目', 'Open a project first')} opacity={0.4} />
        </div>
      </div>
    )
  }

  /** 语义检索 */
  const handleSearch = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    setSearching(true)
    try {
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:search',
        searchQuery,
        topK,
        expectedProjectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      setSearchResults(unwrapKnowledgeValue(result))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, error))
    } finally {
      if (isProjectSessionCurrent(projectSession)) {
        setSearching(false)
      }
    }
  }

  /** 向量回填 */
  const handleBackfill = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    setBackfilling(true)
    try {
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:backfill-vectors',
        expectedProjectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        toast.success(result.processed === 0
          ? text('向量索引检查完成，当前模型无需重建', 'Vector index check complete; the current model does not need a rebuild')
          : text(`向量索引重建完成：已处理 ${result.processed} 块${result.failed > 0 ? `，${result.failed} 块失败` : ''}`, `Vector index rebuilt: ${result.processed} chunks processed${result.failed > 0 ? `, ${result.failed} failed` : ''}`))
      } else {
        toast.error(result.error || text('向量回填失败', 'Vector backfill failed'))
      }
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, e))
    } finally {
      if (isProjectSessionCurrent(projectSession)) {
        setBackfilling(false)
        globalEventBus.emit('REFRESH_RESOURCE', {
          resources: ['all'],
          projectPath: expectedProjectPath,
          projectSession,
        })
      }
    }
  }

  /** 清空当前项目知识库 */
  const handleClearKnowledgeBase = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    const expectedProjectPath = projectSession.projectPath
    const ok = await confirm(
      text('确认清空当前项目的全部知识库内容？\n此操作会删除已导入的知识文档与切片，不会删除项目正文、蓝图或故事架构。', 'Clear the entire knowledge base for this project?\nImported documents and chunks will be deleted. Manuscripts, blueprints, and story architecture are preserved.'),
      {
        title: text('清空知识库', 'Clear knowledge base'),
        confirmText: text('清空知识库', 'Clear knowledge base'),
        danger: true,
      },
    )
    if (!ok) return
    if (!isProjectSessionCurrent(projectSession)) {
      toast.error(text('项目已切换，本次清空操作已取消', 'The project changed, so the clear operation was cancelled'))
      return
    }

    setClearing(true)
    try {
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:clear-all',
        expectedProjectPath,
      )
      if (!isProjectSessionCurrent(projectSession)) return
      if (result.success) {
        setDocuments([])
        setStats({ documentCount: 0, totalChunks: 0, vectorDimension: 0 })
        setSearchResults([])
        setVectorRebuildStatus(null)
        globalEventBus.emit('REFRESH_RESOURCE', {
          resources: ['all'],
          projectPath: expectedProjectPath,
          projectSession,
        })
        toast.success(text('知识库已清空', 'Knowledge base cleared'))
      } else {
        toast.error(result.error || text('清空知识库失败', 'Could not clear the knowledge base'))
      }
    } catch (e) {
      if (!isProjectSessionCurrent(projectSession)) return
      toast.error(appErrorMessage(locale, e))
    } finally {
      if (isProjectSessionCurrent(projectSession)) {
        setClearing(false)
      }
    }
  }

  const handleImportPlanningMaterials = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || importing) return
    setImporting(true)
    try {
      const materials = await selectPlanningMaterials()
      if (materials.length === 0 || !isProjectSessionCurrent(projectSession)) return
      const workflowStore = useWorkflowStore.getState()
      const localWorkflow = createPlanningMaterialWorkflow({ projectSession, materials })
      const localRunId = await workflowStore.startWorkflow(localWorkflow)
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
      const shouldExtract = await confirm(
        text(
          `创作资料已仅保存在当前项目的本地知识库。\n\n若继续，本次选中的全部文本将发送到当前配置的模型端点，用于提取可编辑角色卡：\n模型：${model.name} (${model.modelName})\n端点：${model.baseUrl}\n\n是否发送并提取？`,
          `The planning material is now stored only in this project's local knowledge base.\n\nIf you continue, all selected text will be sent to the currently configured model endpoint to extract editable character cards:\nModel: ${model.name} (${model.modelName})\nEndpoint: ${model.baseUrl}\n\nSend the text and extract character cards?`,
        ),
        {
          title: text('AI 提取角色卡', 'AI character-card extraction'),
          confirmText: text('发送并提取', 'Send and extract'),
        },
      )
      if (!shouldExtract || !isProjectSessionCurrent(projectSession)) return

      const extractionWorkflow = createPlanningMaterialCharacterExtractionWorkflow({
        projectSession,
        materials,
        generationModelId: model.id,
        /**
         * 提取完成后**唯一**的交付口：弹候选预览面板让作者勾选，绝不自动写库。
         * 旧实现在这里直接 await 一个步进工作流 —— 确认被降级成任务面板里的
         * 一个「继续」按钮，作者既看不到候选内容，也没人告诉他还差一步。
         */
        onCandidatesReady: ready => { candidateFlow.deliver(ready, projectSession) },
      })
      const conflict = useWorkflowStore.getState().getResourceConflict(extractionWorkflow)
      if (conflict) {
        toast.warning(workflowResourceConflictMessage(locale, conflict.title))
        return
      }
      useLayoutStore.getState().openBottomTab('tasks')
      await useWorkflowStore.getState().startWorkflow(extractionWorkflow, false)
    } catch (error) {
      if (isProjectSessionCurrent(projectSession)) toast.error(appErrorMessage(locale, error))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="skin-workspace-page h-full overflow-y-auto" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
      {/* 页头统一提到内容区顶层：与其它子菜单同一位置、同一宽度（先生：整整齐齐） */}
      <div className="pagehead-strip">
        <PagePlate
          section="knowledge"
          /* 数据图形：文献结构 —— 投进去的是几份资料，AI 拿到的是几千个语义块。
             这一页最该被看见的一件事就是这两级之间的落差。 */
          figure={(
            <PlateFigure caption={text(
              `${stats.documentCount} 份资料 · ${stats.totalChunks} 个切片`,
              `${stats.documentCount} documents · ${stats.totalChunks} chunks`,
            )}>
              <PlateLibrary documents={stats.documentCount} chunks={stats.totalChunks} />
            </PlateFigure>
          )}
          facts={text(
            `${stats.vectorDimension} 维向量 · 定稿后自动入库`,
            `${stats.vectorDimension}-dimensional · finalized chapters are indexed automatically`,
          )}
          kicker={text('LIBRARY · 知识库', 'LIBRARY')}
          title={text('知识库', 'Knowledge base')}
          description={text(
            '基于 LanceDB 的本地向量数据库，定稿后自动入库，为 AI 写作提供语义检索上下文',
            'A local LanceDB vector database. Finalized chapters are indexed automatically to provide retrieval context for AI writing.',
          )}
          actions={(
            <>
              <button
                className="btn outline sm"
                type="button"
                onClick={handleImportPlanningMaterials}
                disabled={importing}
              >
                {importing ? <RefreshCw size={11} className="animate-spin" /> : <Upload size={11} />}
                {text('导入创作资料', 'Import planning material')}
              </button>
              <button
                className="btn outline sm"
                type="button"
                onClick={handleClearKnowledgeBase}
                disabled={clearing || (stats.documentCount === 0 && stats.totalChunks === 0)}
              >
                {clearing ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                {text('清空知识库', 'Clear knowledge base')}
              </button>
            </>
          )}
        />
      </div>

      {/* 先生：正文栏里各子菜单的内容宽度统一以「剧情线」计划清单的 mx-auto max-w-5xl 为准 */}
      <div className="mx-auto max-w-5xl px-8 pb-6">
        {loadError && (
          <div className="v2-notice mb-6 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs text-[var(--color-error-text)]" data-tone="error">
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {/* ===== 统计卡片 =====
            骨架照 demo（shell.css 526 行 .knowledge-stats），不再手工写间距 */}
        <div className="knowledge-stats">
          <StatCard icon={<FileText size={14} />} label={text('文档数量', 'Documents')} value={stats.documentCount} />
          <StatCard icon={<Layers size={14} />} label={text('知识切片', 'Chunks')} value={stats.totalChunks} />
          <StatCard
            icon={<Server size={14} />}
            label={text('存储引擎', 'Storage engine')}
            value="LanceDB"
            accent
          />
          <StatCard
            icon={<Activity size={14} />}
            label={text('检索模式', 'Search mode')}
            value={hasVectors ? 'FTS+向量' : 'FTS'}
            badge={hasVectors ? text('混合', 'Hybrid') : text('基础', 'Basic')}
            badgeColor={hasVectors ? 'var(--color-success-text)' : 'var(--color-text-secondary)'}
          />
        </div>

        {/* ===== 向量检查与重建卡片 ===== */}
        {rebuildPresentation && (
          <div
            className={cn(
              'rounded-xl border mb-6 overflow-hidden',
              rebuildPresentation.kind === 'missing-vectors'
                ? 'border-amber-500/20'
                : 'border-blue-500/20',
            )}
            style={{
              backgroundColor: rebuildPresentation.kind === 'missing-vectors'
                ? 'color-mix(in srgb, var(--color-warning) 6%, transparent)'
                : 'color-mix(in srgb, var(--color-info) 6%, transparent)',
            }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'v2-tone-soft w-8 h-8 rounded-lg flex items-center justify-center',
                    rebuildPresentation.kind === 'missing-vectors' ? 'bg-amber-500/15' : 'bg-blue-500/15',
                  )}
                  data-tone={rebuildPresentation.kind === 'missing-vectors' ? 'warning' : 'info'}
                >
                  <Zap size={16} className={rebuildPresentation.kind === 'missing-vectors' ? 'text-[var(--color-warning)]' : 'text-[var(--color-info)]'} />
                </div>
                <div>
                  <div className={cn(
                    'text-sm font-medium',
                    rebuildPresentation.kind === 'missing-vectors' ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-category-progress-text)]',
                  )}>
                    {text(rebuildPresentation.title.zhCN, rebuildPresentation.title.enUS)}
                  </div>
                  <div className={cn(
                    'text-[0.7rem]',
                    rebuildPresentation.kind === 'missing-vectors' ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-category-progress-text)]',
                  )}>
                    {rebuildPresentation.kind === 'missing-vectors'
                      ? text(
                          `${vectorRebuildStatus!.vectorlessCount} 个文本块尚未生成向量嵌入；检查后会安全补全或重建索引。`,
                          `${vectorRebuildStatus!.vectorlessCount} text chunks have no embeddings. The check safely completes or rebuilds the index.`,
                        )
                      : text(
                          `将用一条本地文本块检查当前模型的实际向量维度；如维度变化，会先完整建立新索引，再切换检索。当前索引为 ${vectorRebuildStatus!.activeVectorDimension || 'FTS'}。`,
                          `One local text chunk checks the current model's actual vector dimension. If it changed, a complete new index is built before search switches. Current index: ${vectorRebuildStatus!.activeVectorDimension || 'FTS'}.`,
                        )}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                className={cn(
                  'text-xs',
                  rebuildPresentation.kind === 'missing-vectors'
                    ? 'border-amber-500/30 text-[var(--color-warning-text)] hover:bg-amber-500/20'
                    : 'border-blue-500/30 text-[var(--color-category-progress-text)] hover:bg-blue-500/20',
                )}
                onClick={handleBackfill}
                disabled={backfilling}
              >
                {backfilling ? (
                  <><RefreshCw size={12} className="animate-spin mr-1.5" />{text('检查与重建中...', 'Checking and rebuilding...')}</>
                ) : (
                  <>{text(rebuildPresentation.action.zhCN, rebuildPresentation.action.enUS)}</>
                )}
              </Button>
            </div>
            {/* 进度条（回填时显示） */}
            {backfilling && (
              <div
                className={cn('v2-tone-soft h-1 w-full', rebuildPresentation.kind === 'missing-vectors' ? 'bg-amber-500/10' : 'bg-blue-500/10')}
                data-tone={rebuildPresentation.kind === 'missing-vectors' ? 'warning' : 'info'}
              >
                <div
                  className={cn(
                    'v2-tone-fill h-full animate-pulse rounded-full w-full',
                    rebuildPresentation.kind === 'missing-vectors'
                      ? 'bg-gradient-to-r from-amber-500 to-amber-300'
                      : 'bg-gradient-to-r from-blue-500 to-blue-300',
                  )}
                  data-tone={rebuildPresentation.kind === 'missing-vectors' ? 'warning' : 'info'}
                />
              </div>
            )}
          </div>
        )}

        {/* ===== 语义检索区域 =====
            骨架照 demo（shell.css 540–545 行 .knowledge-search / -head / -body），
            连同卡片底色、42px 头部、输入框规格都由皮肤接管。 */}
        <div className="knowledge-search card">
          <div className="knowledge-search-head">
            <Search size={14} className="text-[var(--color-accent)] flex-shrink-0" />
            <span className="text-sm font-semibold text-[var(--color-text)]">{text('语义检索', 'Semantic search')}</span>
            {/* 检索模式标签 */}
            <span className={cn(
              'v2-status-badge text-[0.65rem] px-1.5 py-0.5 rounded-full font-medium',
              hasVectors
                ? 'bg-emerald-500/15 text-[var(--color-success-text)]'
                : 'bg-blue-500/15 text-[var(--color-category-progress-text)]'
            )} data-tone={hasVectors ? 'success' : 'info'}>
              {searchMode}
            </span>
            <span className="text-[0.7rem] text-[var(--color-text-muted)] ml-auto">
              {hasVectors ? text('BM25 + 向量近邻融合', 'BM25 + vector nearest-neighbor fusion') : text('配置 Embedding 模型后自动升级为混合检索', 'Configure an embedding model to enable hybrid search')}
            </span>
          </div>
          {/* 骨架照 demo（shell.css 543–545 行 .knowledge-search-body）
              —— 它自身就是 display:flex + gap:8px，所以这里不能再套一层 flex 容器，
              否则内层宽度由内容决定、右边会空出一大块（先生报的）。
              主输入框靠 .knowledge-search-body input{flex:1} 自然占满。 */}
          <div className="knowledge-search-body">
            <Input
              className="h-9"
              placeholder={text('输入查询内容，如：主角的能力体系、世界观核心设定...', 'Search for protagonist abilities, core world rules, and more...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-[0.7rem] text-[var(--color-text-muted)]">Top</span>
              {/* 先生：Top 栏太短，拉到能舒服显示两位数 */}
              <Input
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                className="w-16 h-9 text-xs text-center"
              />
            </div>
            <Button
              variant="ai"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
              {text('检索', 'Search')}
            </Button>
          </div>

          {/* 检索结果 */}
          {searchResults.length > 0 && (
            <div className="border-t border-[var(--color-border)]">
              <div className="px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  {text(`检索结果（${searchResults.length} 条）`, `Search results (${searchResults.length})`)}
                </span>
                <button
                  className="text-[0.7rem] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  onClick={() => setSearchResults([])}
                >
                  {text('清除', 'Clear')}
                </button>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                {[...searchResults].reverse().map((r, i) => (
                  <div
                    key={i}
                    className="px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-hover)] transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5">
                        <FileText size={10} />
                        {r.fileName}
                      </span>
                      <span className={cn(
                        'v2-status-badge text-[0.7rem] px-1.5 py-0.5 rounded font-mono',
                        r.score > 0.8 ? 'bg-green-500/20 text-[var(--color-success-text)]' :
                        r.score > 0.6 ? 'bg-yellow-500/20 text-[var(--color-warning-text)]' :
                        'bg-[var(--color-hover)] text-[var(--color-text-muted)]'
                      )} data-tone={r.score > 0.8 ? 'success' : r.score > 0.6 ? 'warning' : 'muted'}>
                        {r.score === 0.5 ? text('全文匹配', 'Text match') : text(`相似度 ${(r.score * 100).toFixed(1)}%`, `${(r.score * 100).toFixed(1)}% similarity`)}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap">
                      {r.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

      </div>
      <CharacterCardCandidateDialog
        open={candidateFlow.open}
        candidates={candidateFlow.candidates}
        existingEntries={characterRosterEntries}
        busy={candidateFlow.busy}
        error={candidateFlow.error}
        onClose={candidateFlow.discard}
        onConfirm={(selected, overwriteExisting) => { void candidateFlow.submit(selected, overwriteExisting) }}
      />
    </div>
  )
}

/** 统计卡片子组件
 *  先生：不要再用内联样式「手工模仿」demo 了 —— 直接把骨架换成 demo 的，
 *  皮肤（shell.css 524–531 行的 .knowledge-stat 一整套）就会自动生效。
 *  demo 的结构是三段式：<span> 标签 / <b> 数值 / <em> 小字；
 *  带徽标的那种（检索模式）走 demo 的 .retrieval + .ks-label 分支。 */
function StatCard({ icon, label, value, accent, badge }: {
  icon: React.ReactNode
  label: string
  value: number | string
  accent?: boolean
  badge?: string
  badgeColor?: string
}) {
  return (
    <div className={cn('knowledge-stat card', accent && 'engine', badge && 'retrieval')}>
      {badge ? (
        <div className="ks-label">
          <span>{icon}{label}</span>
          <em>{badge}</em>
        </div>
      ) : (
        <span>{icon}{label}</span>
      )}
      <b>{value}</b>
    </div>
  )
}
