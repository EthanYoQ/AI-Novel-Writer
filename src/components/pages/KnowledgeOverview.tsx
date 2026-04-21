import { useState, useEffect, useCallback } from 'react'
import {
  Database, BookOpen, FileText,
  Search, RefreshCw, Layers, Zap, Server, Activity,
} from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { useProjectStore } from '../../stores/project-store'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { globalEventBus } from '../../shared/event-bus'
import {
  loadKBData, getVectorlessCount, searchKB, backfillVectors,
  type KBDocument, type SearchResult, type KBStatsData,
} from '../../services/knowledge-service'

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
  const [vectorlessCount, setVectorlessCount] = useState(0)
  const [backfilling, setBackfilling] = useState(false)

  const currentProject = useProjectStore(s => s.currentProject)

  const loadData = useCallback(async () => {
    if (!currentProject) return
    try {
      const { documents: docs, stats: s } = await loadKBData()
      setDocuments(docs)
      setStats(s)
    } catch { /* 忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path])

  const checkVectorless = useCallback(async () => {
    if (!currentProject) return
    try {
      setVectorlessCount(await getVectorlessCount())
    } catch { /* 忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path])

  useEffect(() => { 
    loadData()
    checkVectorless()
  }, [loadData, checkVectorless])

  useEffect(() => { checkVectorless() }, [checkVectorless, documents])

  // 通过 EventBus 监听资源刷新和定稿完成事件
  useEffect(() => {
    const unsub1 = globalEventBus.on('REFRESH_RESOURCE', (payload: { resources: string[] }) => {
      if (payload.resources.includes('all') || payload.resources.includes('fileTree')) {
        loadData()
        checkVectorless()
      }
    })
    const unsub2 = globalEventBus.on('FINALIZE_COMPLETE', () => {
      loadData()
      checkVectorless()
    })
    return () => { unsub1(); unsub2() }
  }, [loadData, checkVectorless])

  // 判断检索模式
  const hasVectors = stats.vectorDimension > 0
  const searchMode = hasVectors ? '混合检索' : 'BM25 全文检索'

  if (!currentProject) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              知识库
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message="请先打开项目" opacity={0.4} />
        </div>
      </div>
    )
  }

  /** 语义检索 */
  const handleSearch = async () => {
    setSearching(true)
    try {
      const results = await searchKB(searchQuery, topK)
      setSearchResults(results)
    } catch { /* 忽略 */ }
    setSearching(false)
  }

  /** 向量回填 */
  const handleBackfill = async () => {
    setBackfilling(true)
    try {
      const result = await backfillVectors()
      if (result.success) {
        toast.success(`向量索引重建完成：已处理 ${result.processed} 块${result.failed > 0 ? `，${result.failed} 块失败` : ''}`)
      } else {
        toast.error(result.error || '向量回填失败')
      }
    } catch (e) {
      toast.error('向量回填失败: ' + String(e))
    } finally {
      setBackfilling(false)
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
    }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
      <div className="max-w-4xl mx-auto px-8 py-6">

        {/* ===== 标题 ===== */}
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-hover))' }}
          >
            <Database size={20} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text)]">知识库</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              基于 LanceDB 的本地向量数据库，定稿后自动入库，为 AI 写作提供语义检索上下文
            </p>
          </div>
        </div>

        {/* ===== 统计卡片 ===== */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <StatCard icon={<FileText size={14} />} label="文档数量" value={stats.documentCount} />
          <StatCard icon={<Layers size={14} />} label="知识切片" value={stats.totalChunks} />
          <StatCard
            icon={<Server size={14} />}
            label="存储引擎"
            value="LanceDB"
            accent
          />
          <StatCard
            icon={<Activity size={14} />}
            label="检索模式"
            value={hasVectors ? 'FTS+向量' : 'FTS'}
            badge={hasVectors ? '混合' : '基础'}
            badgeColor={hasVectors ? '#22c55e' : '#3b82f6'}
          />
        </div>

        {/* ===== 向量回填卡片 ===== */}
        {vectorlessCount > 0 && (
          <div
            className="rounded-xl border border-amber-500/20 mb-6 overflow-hidden"
            style={{ backgroundColor: 'rgba(245, 158, 11, 0.06)' }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center">
                  <Zap size={16} className="text-amber-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-amber-300">向量索引待升级</div>
                  <div className="text-[0.7rem] text-amber-400/70">
                    {vectorlessCount} 个文本块尚未生成向量嵌入，升级后可启用语义检索增强
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                className="text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                onClick={handleBackfill}
                disabled={backfilling}
              >
                {backfilling ? (
                  <><RefreshCw size={12} className="animate-spin mr-1.5" />重建中...</>
                ) : (
                  <>重建向量索引</>
                )}
              </Button>
            </div>
            {/* 进度条（回填时显示） */}
            {backfilling && (
              <div className="h-1 w-full bg-amber-500/10">
                <div className="h-full bg-gradient-to-r from-amber-500 to-amber-300 animate-pulse rounded-full w-full" />
              </div>
            )}
          </div>
        )}

        {/* ===== 语义检索区域 ===== */}
        <div
          className="rounded-xl border border-[var(--color-border)] mb-6 overflow-hidden"
          style={{ backgroundColor: 'var(--color-sidebar)' }}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
            <Search size={14} className="text-[var(--color-accent)] flex-shrink-0" />
            <span className="text-sm font-semibold text-[var(--color-text)]">语义检索</span>
            {/* 检索模式标签 */}
            <span className={cn(
              'text-[0.65rem] px-1.5 py-0.5 rounded-full font-medium',
              hasVectors
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-blue-500/15 text-blue-400'
            )}>
              {searchMode}
            </span>
            <span className="text-[0.7rem] text-[var(--color-text-muted)] ml-auto">
              {hasVectors ? 'BM25 + 向量近邻融合' : '配置 Embedding 模型后自动升级为混合检索'}
            </span>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2">
              <Input
                className="flex-1 h-9"
                placeholder="输入查询内容，如：主角的能力体系、世界观核心设定..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-[0.7rem] text-[var(--color-text-muted)]">Top</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={topK}
                  onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                  className="w-12 h-7 text-xs rounded px-1.5 text-center"
                />
              </div>
              <Button
                variant="ai"
                onClick={handleSearch}
                disabled={searching}
              >
                {searching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
                检索
              </Button>
            </div>
          </div>

          {/* 检索结果 */}
          {searchResults.length > 0 && (
            <div className="border-t border-[var(--color-border)]">
              <div className="px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  检索结果 ({searchResults.length} 条)
                </span>
                <button
                  className="text-[0.7rem] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  onClick={() => setSearchResults([])}
                >
                  清除
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
                        'text-[0.7rem] px-1.5 py-0.5 rounded font-mono',
                        r.score > 0.8 ? 'bg-green-500/20 text-green-400' :
                        r.score > 0.6 ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-[var(--color-hover)] text-[var(--color-text-muted)]'
                      )}>
                        {r.score === 0.5 ? '全文匹配' : `相似度 ${(r.score * 100).toFixed(1)}%`}
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
    </div>
  )
}

/** 统计卡片子组件 */
function StatCard({ icon, label, value, accent, badge, badgeColor }: {
  icon: React.ReactNode
  label: string
  value: number | string
  accent?: boolean
  badge?: string
  badgeColor?: string
}) {
  return (
    <div
      className="rounded-xl p-4 border border-[var(--color-border)]"
      style={{ backgroundColor: 'var(--color-sidebar)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[var(--color-text-muted)]">{icon}</span>
        <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className={cn(
          'text-2xl font-bold',
          accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'
        )}>
          {value}
        </div>
        {badge && (
          <span
            className="text-[0.6rem] px-1.5 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: `${badgeColor}20`, color: badgeColor }}
          >
            {badge}
          </span>
        )}
      </div>
    </div>
  )
}
