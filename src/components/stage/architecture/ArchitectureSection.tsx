import { Copy, Ellipsis, Eye, EyeOff, PenLine, RotateCw, Sparkles, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { ARCH_STEP_NAMES, type ArchStepKey } from '../../../services/architecture-step-selection'
import { outlineSourceChangedNote } from '../../run/run-recovery'
import { useLocaleStore } from '../../../stores/locale-store'
import { LegacyRosterRecoveryPanel } from '../../editor/LegacyRosterRecoveryPanel'
import type { ArchitectureOverview } from '../../editor/use-architecture-overview'
import { Button } from '../../ui/Button'
import { Menu, type MenuGroupSpec } from '../../ui/Menu'
import { Notice } from '../../ui/Notice'
import { badgeText, badgeTone, SECTION_NUMERALS, type SectionBadge } from './architecture-sections'

interface SectionProps {
  sectionKey: ArchStepKey
  overview: ArchitectureOverview
  badge: SectionBadge
  summary: string
  onEdit: () => void
  onGenerate: () => void
  onClear: () => void
  onOpenCast: () => void
  onReload: () => void
}

/** 候选与续写的提示条：世界观或大纲生成到一半停下时，未完成的候选不写入正式内容，作者可以看、复制或接着写。 */
function CandidateNotice({ sectionKey, overview }: { sectionKey: 'worldbuilding' | 'synopsis'; overview: ArchitectureOverview }) {
  const text = useLocaleStore(s => s.text)
  const state = sectionKey === 'synopsis' ? overview.synopsis : overview.worldBuilding
  const editDraft = sectionKey === 'synopsis' && overview.planningRecovery !== null
  // 来源已变的恢复稿不能写回：主动作是从本批起始章重新生成，打开恢复稿只作查看。
  const restart = sectionKey === 'synopsis' ? overview.outlineRestartRange : null
  const locale = useLocaleStore(s => s.locale)
  const filled = Boolean(overview.archStatus[sectionKey])
  let note = state.handle
    ? text('续写从停下的地方接着生成，不会改动已保存的部分。', 'Resuming continues from where it stopped and leaves saved content alone.')
    : text('无法确认这份候选的来源，只能查看或复制，然后重新生成。', 'The source of this candidate cannot be confirmed. View or copy it, then generate again.')
  if (restart && overview.planningRecovery) note = outlineSourceChangedNote(overview.planningRecovery, locale) ?? note
  const resume = () => editDraft
    ? overview.openRecoveryDraft()
    : void (sectionKey === 'synopsis' ? overview.handleResumeSynopsis() : overview.handleResumeWorldBuilding())
  return (
    <>
      <Notice
        tone="warn"
        title={filled
          ? text('上次生成在半途停下，正式内容保留不动。', 'The last run stopped partway. The saved content is unchanged.')
          : text('上次生成在半途停下，还没有写入正式内容。', 'The last run stopped partway. Nothing was saved yet.')}
        actions={(
          <>
            <Button variant="text" size="sm" onClick={() => state.setCandidateShown(shown => !shown)}>
              {state.candidateShown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              {state.candidateShown ? text('收起候选', 'Hide candidate') : text('查看未完成候选', 'View candidate')}
            </Button>
            <Button variant="text" size="sm" onClick={() => { void overview.copyCandidate(state.candidate) }}>
              <Copy size={14} aria-hidden />{text('复制', 'Copy')}
            </Button>
            {restart ? (
              <>
                <Button variant="text" size="sm" disabled={overview.loading} onClick={() => overview.openRecoveryDraft()}>
                  <PenLine size={14} aria-hidden />{text('查看恢复稿', 'View recovery draft')}
                </Button>
                <Button variant="secondary" size="sm" disabled={overview.loading} onClick={overview.openOutlineRestart}>
                  <Sparkles size={14} aria-hidden />{text(`从第 ${restart.from} 章重新生成`, `Generate again from ch. ${restart.from}`)}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" disabled={state.busy || !state.handle || overview.loading} onClick={resume}>
                <RotateCw size={14} aria-hidden />
                {editDraft ? text('编辑恢复稿', 'Edit recovery draft') : state.busy ? text('续写中…', 'Resuming…') : text('断点续写', 'Resume')}
              </Button>
            )}
          </>
        )}
      >
        {note}
      </Notice>
      {state.candidateShown && <pre className="arch-candidate" role="region" aria-label={text('未完成候选', 'Unfinished candidate')}>{state.candidate}</pre>}
    </>
  )
}

/** 大纲的状态提示：被打断、分批生成还有没写到的章，或正文带分批标记而检查点已对不上。 */
function OutlineNotice({ overview, onGenerate }: { overview: ArchitectureOverview; onGenerate: () => void }) {
  const text = useLocaleStore(s => s.text)
  const { progress, recoveryFailed, busy, candidate, handle } = overview.synopsis
  if (!overview.archStatus.synopsis || candidate) return null
  if (progress.kind === 'interrupted') {
    return (
      <Notice tone="warn" title={text('上次生成被输出长度打断，已完成的部分已保存。', 'The last run hit the output limit. The finished part is saved.')}
        actions={(
          <Button variant="secondary" size="sm" disabled={busy || !handle || overview.loading} onClick={() => { void overview.handleResumeSynopsis() }}>
            <RotateCw size={14} aria-hidden />{busy ? text('续写中…', 'Resuming…') : text('断点续写大纲', 'Continue outline')}
          </Button>
        )} />
    )
  }
  if (progress.kind === 'partial') {
    const { coveredTo, total } = progress
    return (
      <Notice tone="warn"
        title={text(`上次生成到第 ${coveredTo} 章停下了，第 ${coveredTo + 1}–${total} 章还没有大纲。`, `Generation stopped at chapter ${coveredTo}; chapters ${coveredTo + 1}–${total} have no outline yet.`)}
        actions={(
          <Button variant="secondary" size="sm" disabled={busy || overview.loading} onClick={() => { void overview.handleContinueOutlineBatch() }}>
            <Sparkles size={14} aria-hidden />{text(`续写第 ${coveredTo + 1} 章起`, `Continue from ch. ${coveredTo + 1}`)}
          </Button>
        )}>
        {text(`已生成的 ${coveredTo} 章保留不动，续写只追加缺少的章节。`, `${coveredTo === 1 ? 'Chapter 1 stays as it is' : `Chapters 1–${coveredTo} stay as they are`}; only missing chapters are added.`)}
      </Notice>
    )
  }
  if (recoveryFailed) {
    return (
      <Notice tone="warn" title={text('大纲末尾还留着分批生成的说明，但正文已和它对不上（可能手动改过）。', 'The outline still ends with a batch note that no longer matches its text (it may have been edited).')}
        actions={<Button variant="secondary" size="sm" onClick={onGenerate}><Sparkles size={14} aria-hidden />{text('选章节范围生成…', 'Choose chapters…')}</Button>}>
        {text('续写按钮用不了；在生成对话框里选起止章，会标出哪些章被替换、哪些原样保留。', 'Continue is unavailable. Pick the chapters in the dialog; it shows which chapters are replaced and which stay.')}
      </Notice>
    )
  }
  return null
}

/** 角色名单需要修复或采用旧角色卡时的提示条，以及保存过的旧修复运行。 */
function RosterNotice({ overview }: { overview: ArchitectureOverview }) {
  const text = useLocaleStore(s => s.text)
  const { presentation, canRepair, repairing, repair } = overview.roster
  const attention = presentation && presentation.kind !== 'ready' && presentation.kind !== 'empty'
  return (
    <>
      {attention && (
        <Notice
          tone={presentation.kind === 'failed_with_data_preserved' || presentation.kind === 'inconsistent' ? 'danger' : 'warn'}
          title={presentation.label}
          actions={canRepair && presentation.actionLabel ? (
            <Button variant="secondary" size="sm" disabled={repairing} title={presentation.actionTitle} onClick={() => { void repair() }}>
              {repairing ? text('处理中…', 'Working…') : presentation.actionLabel}
            </Button>
          ) : undefined}
        >
          {presentation.description}
        </Notice>
      )}
      {/* 旧修复运行要查 generation:list（主进程串行处理，运行多时要几十毫秒），等四节读完再挂，不挡在打开架构的路上。 */}
      {!overview.loading && <div className="arch-legacy-roster"><LegacyRosterRecoveryPanel onRecover={repair} busy={repairing} /></div>}
    </>
  )
}

export default function ArchitectureSection({ sectionKey, overview, badge, summary, onEdit, onGenerate, onClear, onOpenCast, onReload }: SectionProps) {
  const text = useLocaleStore(s => s.text)
  const filled = Boolean(overview.archStatus[sectionKey])
  const cast = sectionKey === 'characters'
  const name = text(...ARCH_STEP_NAMES[sectionKey])

  const groups: MenuGroupSpec[] = [
    { id: 'section', items: [
      { id: 'reload', label: text('重新读取', 'Reload'), onSelect: onReload },
      { id: 'generate', label: filled ? text('AI 重新生成此节…', 'Regenerate with AI…') : text('AI 生成此节…', 'Generate with AI…'), onSelect: onGenerate },
      ...(cast ? [{ id: 'projection', label: text('查看角色名单全文', 'View cast as text'), onSelect: onEdit }] : []),
    ] },
    ...(!cast && filled ? [{ id: 'danger', label: text('危险', 'Danger'), tone: 'danger' as const, items: [
      { id: 'clear', label: text('清空此节…', 'Clear this section…'), onSelect: onClear },
    ] }] : []),
  ]

  let actions: ReactNode
  if (cast) {
    actions = <Button variant="text" size="sm" onClick={onOpenCast}><Users size={14} aria-hidden />{text('打开角色名单', 'Open cast')}</Button>
  } else if (filled) {
    actions = <Button variant="text" size="sm" onClick={onEdit}><PenLine size={14} aria-hidden />{text('编辑', 'Edit')}</Button>
  } else {
    actions = (
      <>
        <Button variant="text" size="sm" onClick={onEdit}><PenLine size={14} aria-hidden />{text('自己写', 'Write it')}</Button>
        <Button variant="secondary" size="sm" onClick={onGenerate}><Sparkles size={14} aria-hidden />{text('AI 生成此节', 'Generate')}</Button>
      </>
    )
  }

  return (
    <section className="arch-section" data-section={sectionKey} data-state={badge.kind} aria-labelledby={`arch-${sectionKey}`}>
      <div className="arch-section-head">
        <span className="arch-section-num" aria-hidden>{SECTION_NUMERALS[sectionKey]}</span>
        <div className="arch-section-heading">
          <div className="arch-section-titleline">
            <h2 className="arch-section-title" id={`arch-${sectionKey}`}>{name}</h2>
            <span className="arch-badge" data-tone={badgeTone(badge)}>{badgeText(badge, text)}</span>
          </div>
          <p className="arch-section-summary">{summary}</p>
        </div>
        <div className="arch-section-actions">
          {actions}
          <Menu label={text(`「${name}」的更多操作`, `More for ${name}`)} icon={<Ellipsis size={16} aria-hidden />} groups={groups} align="end" />
        </div>
      </div>
      {(sectionKey === 'worldbuilding' || sectionKey === 'synopsis') && (sectionKey === 'synopsis' ? overview.synopsis.candidate : overview.worldBuilding.candidate) && (
        <div className="arch-section-notes"><CandidateNotice sectionKey={sectionKey} overview={overview} /></div>
      )}
      {sectionKey === 'synopsis' && <div className="arch-section-notes arch-notes-collapsible"><OutlineNotice overview={overview} onGenerate={onGenerate} /></div>}
      {cast && <div className="arch-section-notes arch-notes-collapsible"><RosterNotice overview={overview} /></div>}
    </section>
  )
}
