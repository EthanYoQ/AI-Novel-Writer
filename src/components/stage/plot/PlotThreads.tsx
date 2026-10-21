import { useId, useState, type ReactNode } from 'react'
import { Check, MoreHorizontal, Plus, Sparkles, TriangleAlert } from 'lucide-react'
import type { NarrativeThreadEventType, NarrativeThreadView } from '../../../shared/narrative-thread'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Menu } from '../../ui/Menu'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { InkDialog } from '../InkDialog'
import { threadRoute, type RouteStop } from './plot-shape'
import type { PlotThreads as PlotThreadsData } from './StagePlot'
import { STATUS_LABELS } from './use-plot-threads'
import { pluralEn } from '../../../shared/plural-en'

type Text = (zh: string, en: string) => string

const EVENT_TYPES: readonly { value: NarrativeThreadEventType; label: [string, string] }[] = [
  { value: 'planted', label: ['埋设', 'Plant'] },
  { value: 'progressing', label: ['推进', 'Advance'] },
  { value: 'resolved', label: ['解决', 'Resolve'] },
  { value: 'abandoned', label: ['放弃', 'Abandon'] },
]

const STOP_NAMES: Record<RouteStop['kind'], [string, string]> = {
  planted: ['埋', 'Plant'],
  progressing: ['推', 'Adv.'],
  resolved: ['解', 'Res.'],
}

function Route({ thread, text }: { thread: NarrativeThreadView; text: Text }) {
  return (
    <ol className="stage-thread-route" aria-label={text('线索路线', 'Thread route')}>
      {threadRoute(thread).map(stop => (
        <li key={stop.kind} data-state={stop.state}>
          {text(...STOP_NAMES[stop.kind])}{stop.chapter !== null && text(` · 第 ${stop.chapter} 章`, ` · Ch. ${stop.chapter}`)}
        </li>
      ))}
    </ol>
  )
}

function threadNote(thread: NarrativeThreadView, dormantThreshold: number, text: Text) {
  const open = thread.status !== 'resolved' && thread.status !== 'abandoned'
  if (open && thread.overdue) return <span className="stage-thread-sub" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" />{text('已过计划章节，还没有推进到位', 'Past its planned chapter and not advanced yet')}</span>
  if (open && thread.dormantChapters >= dormantThreshold) return <span className="stage-thread-sub" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" />{text(`已沉寂 ${thread.dormantChapters} 章`, `Quiet for ${thread.dormantChapters} ${pluralEn(thread.dormantChapters, 'chapter')}`)}</span>
  return <span className="stage-thread-sub">{thread.type} · {text(...STATUS_LABELS[thread.status])}</span>
}

interface PlotThreadsProps {
  plot: PlotThreadsData
  onDelete: (thread: NarrativeThreadView) => void
}

/**
 * 伏笔线索：左列线索计划与各自的埋设、推进、解决路线；右列把定稿里的变化记进线索，以及按蓝图请 AI 建议伏笔。
 * 新建与编辑线索在对话框里完成；删除线索在每行的「更多」里，走危险确认。
 */
export default function PlotThreads({ plot, onDelete }: PlotThreadsProps) {
  const text = useLocaleStore(s => s.text)
  const ids = useId()
  const [formOpen, setFormOpen] = useState(false)
  const eventThread = plot.threads.find(thread => thread.id === plot.eventPlanId) ?? null
  const planValid = Boolean(plot.plan.title.trim() && plot.plan.type.trim() && plot.plan.authorIntent.trim()) && plot.plan.targetEndChapter >= plot.plan.targetStartChapter
  const generating = plot.plotBusy || plot.aiBusy

  const openForm = (thread?: NarrativeThreadView) => {
    if (thread) plot.startEditingPlan(thread)
    else plot.resetPlan()
    setFormOpen(true)
  }

  const savePlan = async () => {
    if (await plot.savePlan()) setFormOpen(false)
  }

  const findEvents = () => {
    plot.openAI('event')
    void plot.generateEventCandidates()
  }

  const suggestPlans = () => {
    void plot.generatePlanCandidates()
  }

  const field = (id: string, label: string, input: ReactNode) => (
    <label className="pi-field" htmlFor={`${ids}-${id}`}>{label}{input}</label>
  )

  return (
    <div className="stage-threads">
      <section className="stage-threads-plans" aria-label={text('线索计划', 'Thread plans')}>
        <header className="stage-threads-head">
          <div>
            <h2 className="stage-plot-h2">{text('线索计划', 'Thread plans')} <span className="stage-plot-count">{text(`${plot.threads.length} 条`, `${plot.threads.length}`)}</span></h2>
            <p className="stage-plot-help">{text('每条线索计划在哪章埋下、哪章推进、哪章解决。写作和审稿会参考这里。', 'Each thread plans where it is planted, advanced and resolved. Writing and reviews follow it.')}</p>
          </div>
          <Button variant="secondary" onClick={() => openForm()}><Plus size={14} aria-hidden="true" />{text('新建线索', 'New thread')}</Button>
        </header>
        {plot.threads.length === 0 ? (
          <EmptyState
            heading={text('还没有伏笔线索', 'No threads yet')}
            description={text('为一条伏笔定下埋设与回收的章节，写作时会提醒它；也可以让 AI 按蓝图先给出建议。', 'Set where a foreshadowing thread is planted and paid off and writing will keep it in mind. AI can also suggest some from the blueprint.')}
            action={<Button variant="secondary" onClick={() => openForm()}><Plus size={14} aria-hidden="true" />{text('新建线索', 'New thread')}</Button>}
          />
        ) : (
          <ul className="stage-thread-list">
            {plot.threads.map(thread => (
              <li key={thread.id} id={`narrative-plan-${thread.id}`} className="stage-thread" data-source={plot.sourcePlanId === thread.id || undefined} data-event={plot.eventPlanId === thread.id || undefined}>
                <div className="stage-thread-name">
                  <b>{thread.title}</b>
                  {threadNote(thread, plot.dormantThreshold, text)}
                </div>
                <Route thread={thread} text={text} />
                <Menu
                  label={text(`「${thread.title}」的更多操作`, `More actions for “${thread.title}”`)}
                  icon={<MoreHorizontal size={16} aria-hidden="true" />}
                  align="end"
                  groups={[
                    { id: 'edit', items: [
                      { id: 'edit', label: text('编辑线索', 'Edit thread'), onSelect: () => openForm(thread) },
                      { id: 'event', label: text('记录定稿里的变化', 'Record a change from a final'), onSelect: () => plot.startEvent(thread.id), disabled: plot.finalizedDrafts.length === 0 },
                    ] },
                    { id: 'danger', tone: 'danger', items: [{ id: 'delete', label: text('删除线索…', 'Delete thread…'), onSelect: () => onDelete(thread), disabled: plot.busy }] },
                  ]}
                />
                {thread.events.length > 0 && (
                  <ul className="stage-thread-events" aria-label={text('已确认的定稿事件', 'Confirmed events')}>
                    {thread.events.map(event => (
                      <li key={event.id}>{text(`第 ${event.chapterNumber} 章`, `Ch. ${event.chapterNumber}`)} · {text(...STATUS_LABELS[event.type])} · {event.evidence}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="stage-threads-side">
        <section className="stage-threads-card" aria-label={text('定稿里的线索变化', 'Thread changes in finals')}>
          <h2 className="stage-plot-h2">{text('定稿里的线索变化', 'Thread changes in finals')}</h2>
          <p className="stage-plot-help">{text('从定稿正文里摘一句证据，记下这条线索在这一章埋设、推进还是解决。确认后才会记入线索计划。', 'Quote a line from a final as evidence and record whether the thread is planted, advanced or resolved there. Nothing is recorded until you confirm.')}</p>
          {!eventThread ? (
            <p className="stage-plot-help">{plot.finalizedDrafts.length === 0
              ? text('还没有定稿的章节。', 'No chapter is final yet.')
              : text('在左边线索的「更多」里选「记录定稿里的变化」。', 'Choose “Record a change from a final” in a thread’s menu on the left.')}</p>
          ) : (
            <div className="stage-threads-form">
              <div className="stage-threads-target">{eventThread.title}</div>
              {field('draft', text('定稿章节', 'Final chapter'), (
                <select id={`${ids}-draft`} className="pi-input" value={plot.eventDraftId} onChange={event => plot.setEventDraftId(Number(event.target.value))}>
                  {plot.finalizedDrafts.map(draft => <option key={draft.id} value={draft.id}>{text(`第 ${draft.chapterNumber} 章 · 定稿 v${draft.version}`, `Chapter ${draft.chapterNumber} · final v${draft.version}`)}</option>)}
                </select>
              ))}
              <SegmentedControl<NarrativeThreadEventType>
                label={text('这一章里线索的变化', 'What happens to the thread here')}
                value={plot.eventType}
                onChange={plot.setEventType}
                options={EVENT_TYPES.map(type => ({ value: type.value, label: text(...type.label) }))}
              />
              {field('evidence', text('定稿里的原文', 'Quote from the final'), (
                <input id={`${ids}-evidence`} className="pi-input" placeholder={text('粘贴这一章里实际出现的一句话', 'Paste a line that appears in this chapter')} value={plot.eventEvidence} onChange={event => plot.setEventEvidence(event.target.value)} />
              ))}
              {field('reason', text('理由', 'Why'), (
                <input id={`${ids}-reason`} className="pi-input" value={plot.eventReason} onChange={event => plot.setEventReason(event.target.value)} />
              ))}
              {plot.eventError && <p role="alert" className="stage-plot-error">{plot.eventError}</p>}
              <div className="stage-threads-actions">
                <Button variant="text" onClick={() => plot.startEvent(null)}>{text('取消', 'Cancel')}</Button>
                <Button variant="secondary" disabled={plot.busy || generating || Boolean(plot.modelSelectionError)} onClick={findEvents}>
                  <Sparkles size={14} aria-hidden="true" />{plot.aiBusy && plot.aiMode === 'event' ? text('识别中…', 'Finding…') : text('让 AI 识别', 'Find with AI')}
                </Button>
                <Button variant="primary" disabled={plot.busy || !plot.eventEvidence.trim() || !plot.eventReason.trim()} onClick={() => void plot.saveEvent()}>
                  <Check size={14} aria-hidden="true" />{text('记入线索', 'Record')}
                </Button>
              </div>
            </div>
          )}
          {plot.eventCandidates.map((candidate, index) => (
            <article key={`${candidate.type}:${index}`} className="stage-candidate" aria-label={text('事件候选', 'Event candidate')}>
              <div className="stage-candidate-head">
                <b>{text(...STATUS_LABELS[candidate.type])}</b>
                <span>{text(`第 ${candidate.chapterNumber} 章定稿`, `Chapter ${candidate.chapterNumber} final`)}</span>
              </div>
              <blockquote>{candidate.evidence}</blockquote>
              <p>{text(`理由：${candidate.reason}`, `Why: ${candidate.reason}`)}</p>
              <div className="stage-candidate-foot">
                <Button variant="text" size="sm" disabled={plot.busy} onClick={() => plot.rejectEventCandidate(candidate)}>{text('不采纳', 'Dismiss')}</Button>
                <Button variant="secondary" size="sm" disabled={plot.busy || candidate.generationIndex !== undefined && plot.graphRecovery?.sourceStatus !== 'current'} onClick={() => void plot.confirmEventCandidate(candidate)}>
                  <Check size={13} aria-hidden="true" />{text('确认', 'Confirm')}
                </Button>
              </div>
            </article>
          ))}
        </section>

        <section className="stage-threads-card" aria-label={text('AI 建议的伏笔', 'Suggested threads')}>
          <h2 className="stage-plot-h2">{text('AI 建议的伏笔', 'Suggested threads')}</h2>
          <p className="stage-plot-help">{text('AI 读一章蓝图，建议可以提前埋下的伏笔。建议只列在这里，由你决定是否加入计划。', 'AI reads a chapter of the blueprint and suggests threads to plant early. Suggestions stay here until you add them.')}</p>
          <div className="stage-threads-ai">
            <select className="pi-input" aria-label={text('蓝图章节', 'Blueprint chapter')} value={plot.aiBlueprintChapter} disabled={plot.aiBusy} onChange={event => plot.setAiBlueprintChapter(Number(event.target.value))}>
              {plot.blueprints.map(blueprint => <option key={blueprint.chapterNumber} value={blueprint.chapterNumber}>{text(`第 ${blueprint.chapterNumber} 章 · ${blueprint.title}`, `Chapter ${blueprint.chapterNumber} · ${blueprint.title}`)}</option>)}
            </select>
            <select className="pi-input" aria-label={text('本次识别用的模型', 'Model for this analysis')} value={plot.selectedModelId ?? ''} disabled={plot.aiBusy || plot.generationModels.length === 0} onChange={event => plot.setAiModelId(event.target.value || null)}>
              <option value="" disabled>{text('选择模型', 'Choose a model')}</option>
              {plot.generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}</option>)}
            </select>
            <Button variant="secondary" disabled={generating || plot.blueprints.length === 0 || !plot.aiBlueprintChapter || Boolean(plot.modelSelectionError)} onClick={suggestPlans}>
              <Sparkles size={14} aria-hidden="true" />{plot.aiBusy && plot.aiMode === 'plan' ? text('建议中…', 'Suggesting…') : text('根据蓝图建议伏笔', 'Suggest from the blueprint')}
            </Button>
          </div>
          {plot.modelSelectionError && <p role="alert" className="stage-plot-error">{plot.modelSelectionError}</p>}
          {plot.aiError && <p role="alert" className="stage-plot-error">{plot.aiError}</p>}
          {plot.planCandidates.map((candidate, index) => (
            <article key={`${candidate.title}:${index}`} className="stage-candidate" aria-label={text('伏笔建议', 'Thread suggestion')}>
              <div className="stage-candidate-head">
                <b>{candidate.title}</b>
                <span>{candidate.type} · {text(`第 ${candidate.targetStartChapter}–${candidate.targetEndChapter} 章`, `Ch. ${candidate.targetStartChapter}–${candidate.targetEndChapter}`)}</span>
              </div>
              <p>{candidate.authorIntent}</p>
              <div className="stage-candidate-foot">
                <Button variant="text" size="sm" disabled={plot.busy} onClick={() => plot.rejectPlanCandidate(candidate)}>{text('不采纳', 'Dismiss')}</Button>
                <Button variant="secondary" size="sm" disabled={plot.busy || candidate.generationIndex !== undefined && plot.graphRecovery?.sourceStatus !== 'current'} onClick={() => void plot.confirmPlanCandidate(candidate)}>
                  <Plus size={13} aria-hidden="true" />{text('加入计划', 'Add to plan')}
                </Button>
              </div>
            </article>
          ))}
        </section>
      </aside>

      <InkDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        title={plot.editingId === null ? text('新建线索', 'New thread') : text('编辑线索', 'Edit thread')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" disabled={plot.busy || !planValid} onClick={() => void savePlan()}>{text('保存线索', 'Save thread')}</Button>
          </>
        )}
      >
        <div className="stage-threads-plan-form">
          {field('title', text('名称', 'Name'), <input id={`${ids}-title`} className="pi-input" value={plot.plan.title} onChange={event => plot.setPlan({ ...plot.plan, title: event.target.value })} />)}
          {field('type', text('类型', 'Kind'), <input id={`${ids}-type`} className="pi-input" placeholder={text('主线、支线、人物……', 'Main plot, subplot, character…')} value={plot.plan.type} onChange={event => plot.setPlan({ ...plot.plan, type: event.target.value })} />)}
          {field('start', text('埋设章', 'Planted in chapter'), <input id={`${ids}-start`} className="pi-input" type="number" min={1} value={plot.plan.targetStartChapter} onChange={event => plot.setPlan({ ...plot.plan, targetStartChapter: Number(event.target.value) })} />)}
          {field('end', text('回收章', 'Paid off in chapter'), <input id={`${ids}-end`} className="pi-input" type="number" min={1} value={plot.plan.targetEndChapter} onChange={event => plot.setPlan({ ...plot.plan, targetEndChapter: Number(event.target.value) })} />)}
          {field('intent', text('你的打算', 'Your intent'), <textarea id={`${ids}-intent`} className="pi-input stage-threads-intent" value={plot.plan.authorIntent} onChange={event => plot.setPlan({ ...plot.plan, authorIntent: event.target.value })} />)}
        </div>
      </InkDialog>
    </div>
  )
}
