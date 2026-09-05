import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, GitBranch, Loader2, RefreshCw, Trash2 } from 'lucide-react'

import type { ModelProfile } from '../../shared/ipc-channels'
import type {
  PlotTreeEvent,
  PlotTreeSnapshot,
  PlotTreeSourceReference,
} from '../../shared/plot-tree'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'

const CHAPTER_WIDTH = 128

interface PlotTreeViewProps {
  snapshot: PlotTreeSnapshot | null
  sourceRevision: string
  currentChapter: number
  models: ModelProfile[]
  selectedModelId: string | null
  busy: boolean
  error: string
  onModelChange: (modelId: string) => void
  onGenerate: () => void
  onClear: () => void
  onOpenSource: (source: PlotTreeSourceReference) => void
}

function sourceLabel(source: PlotTreeSourceReference, text: (zh: string, en: string) => string): string {
  if (source.type === 'blueprint') {
    return text(`第 ${source.chapterNumber} 章蓝图`, `Chapter ${source.chapterNumber} blueprint`)
  }
  if (source.type === 'finalized-chapter') {
    return text(`第 ${source.chapterNumber} 章定稿`, `Chapter ${source.chapterNumber} finalized draft`)
  }
  return text(`叙事计划 #${source.planId}`, `Narrative plan #${source.planId}`)
}

export default function PlotTreeView({
  snapshot,
  sourceRevision,
  currentChapter,
  models,
  selectedModelId,
  busy,
  error,
  onModelChange,
  onGenerate,
  onClear,
  onOpenSource,
}: PlotTreeViewProps) {
  const text = useLocaleStore(state => state.text)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [selectedEvent, setSelectedEvent] = useState<PlotTreeEvent | null>(null)
  const maxChapter = useMemo(() => Math.max(
    1,
    currentChapter,
    ...(snapshot?.tracks.flatMap(track => [
      track.startChapter,
      track.endChapter,
      ...track.events.map(event => event.chapterNumber),
    ]) ?? []),
  ), [currentChapter, snapshot])
  const chapters = useMemo(
    () => Array.from({ length: maxChapter }, (_, index) => index + 1),
    [maxChapter],
  )
  const stale = Boolean(snapshot && snapshot.sourceRevision !== sourceRevision)

  useEffect(() => {
    if (!viewportRef.current) return
    viewportRef.current.scrollLeft = Math.max(0, (currentChapter - 2) * CHAPTER_WIDTH)
  }, [currentChapter, snapshot])

  return (
    <section className="space-y-4">
      <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-56 flex-1">
            <Label htmlFor="plot-tree-model">{text('本次分析模型', 'Model for this analysis')}</Label>
            <NativeSelect
              id="plot-tree-model"
              value={selectedModelId ?? ''}
              disabled={busy || models.length === 0}
              onChange={event => onModelChange(event.target.value)}
            >
              <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
              {models.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
            </NativeSelect>
          </label>
          <Button variant="ai" onClick={onGenerate} disabled={busy || !selectedModelId}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : snapshot ? <RefreshCw size={14} /> : <GitBranch size={14} />}
            {busy
              ? text('生成中...', 'Generating...')
              : snapshot
                ? text('刷新剧情树', 'Refresh plot tree')
                 : text('生成剧情树', 'Generate plot tree')}
          </Button>
          {snapshot && <Button variant="outline" onClick={onClear} disabled={busy}>
            <Trash2 size={14} />{text('清除剧情树', 'Clear plot tree')}
          </Button>}
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{text(
          'AI 只读归纳现有大纲、蓝图、定稿与叙事计划；剧情树不会反写项目事实。',
          'AI summarizes existing outlines, blueprints, finalized chapters, and narrative plans read-only. The plot tree never rewrites project facts.',
        )}</p>
        {stale && <p role="status" className="text-xs" style={{ color: 'var(--color-warning-text)' }}>{text('剧情资料已有更新，可刷新剧情树。', 'Plot sources have changed. Refresh the plot tree when ready.')}</p>}
        {error && <p role="alert" className="text-xs" style={{ color: 'var(--color-error-text)' }}>{error}</p>}
      </div>

      {!snapshot && (
        <div className="rounded-lg border px-4 py-10 text-center text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          {text('尚未生成剧情树', 'No plot tree has been generated yet')}
        </div>
      )}

      {snapshot && (
        <div ref={viewportRef} className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
          <table className="border-collapse text-xs" style={{ minWidth: 208 + chapters.length * CHAPTER_WIDTH, tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ background: 'var(--color-panel)' }}>
                <th className="sticky left-0 z-10 w-52 border-b border-r px-3 py-2 text-left" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
                  {text('主线 / 支线', 'Main / subplot')}
                </th>
                {chapters.map(chapter => (
                  <th
                    key={chapter}
                    className="border-b border-r px-2 py-2 text-center font-medium"
                    style={{
                      width: CHAPTER_WIDTH,
                      borderColor: 'var(--color-border)',
                      color: chapter === currentChapter ? 'var(--color-accent)' : 'var(--color-text-muted)',
                    }}
                  >
                    {text(`第 ${chapter} 章`, `Ch. ${chapter}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.tracks.map(track => {
                const parent = snapshot.tracks.find(candidate => candidate.id === track.parentTrackId)
                const occurredCount = track.events.filter(event => event.status === 'occurred').length
                return (
                  <tr key={track.id}>
                    <th className="sticky left-0 z-10 border-b border-r p-3 text-left align-top" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
                      <span className="mb-1 block text-[11px] font-normal" style={{ color: track.role === 'main' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
                        {track.role === 'main' ? text('主线', 'Main plot') : text('支线', 'Subplot')}
                        {parent ? ` · ${parent.title}` : ''}
                      </span>
                      <span className="block text-sm">{track.title}</span>
                      <span className="mt-1 block font-normal" style={{ color: 'var(--color-text-muted)' }}>
                        {text(
                          `第 ${track.startChapter}–${track.endChapter} 章 · ${occurredCount}/${track.events.length} 已发生`,
                          `Ch. ${track.startChapter}–${track.endChapter} · ${occurredCount}/${track.events.length} occurred`,
                        )}
                      </span>
                      <span className="mt-1 block font-normal leading-5" style={{ color: 'var(--color-text-muted)' }}>{track.summary}</span>
                    </th>
                    {chapters.map(chapter => {
                      const events = track.events.filter(event => event.chapterNumber === chapter)
                      return (
                        <td key={chapter} className="border-b border-r p-2 align-top" style={{ borderColor: 'var(--color-border)', width: CHAPTER_WIDTH }}>
                          <div className="space-y-1">
                            {events.map((event, index) => (
                              <button
                                key={`${event.chapterNumber}:${event.summary}:${index}`}
                                type="button"
                                className="w-full rounded border px-2 py-1.5 text-left leading-5 hover:border-[var(--color-accent)]"
                                style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
                                onClick={() => setSelectedEvent(event)}
                              >
                                <span className="mb-0.5 block text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                                  {event.status === 'occurred' ? text('已发生', 'Occurred') : text('已计划', 'Planned')}
                                </span>
                                {event.summary}
                              </button>
                            ))}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedEvent && (
        <aside className="rounded-lg border p-4 space-y-2" style={{ borderColor: 'var(--color-border)', background: 'var(--color-panel)' }}>
          <h3 className="font-medium">{selectedEvent.summary}</h3>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {text(`第 ${selectedEvent.chapterNumber} 章 · ${selectedEvent.status === 'occurred' ? '已发生' : '已计划'}`, `Chapter ${selectedEvent.chapterNumber} · ${selectedEvent.status === 'occurred' ? 'Occurred' : 'Planned'}`)}
          </p>
          <div className="flex flex-wrap gap-2">
            {selectedEvent.sources.map((source, index) => (
              <Button key={`${source.type}:${index}`} size="sm" variant="outline" onClick={() => onOpenSource(source)}>
                <ExternalLink size={12} />{sourceLabel(source, text)}
              </Button>
            ))}
          </div>
        </aside>
      )}
    </section>
  )
}
