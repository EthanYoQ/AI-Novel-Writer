import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Lock, RotateCcw } from 'lucide-react'
import type { VersionRecord } from '../../../services/version-service'
import { useDraftStore } from '../../../stores/draft-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../stores/project-store'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../../shared/project-session-context'
import { sqliteTime } from '../../../shared/sqlite-time'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Notice } from '../../ui/Notice'
import { toast } from '../../ui/Toast'
import RevertDialog from './RevertDialog'
import { useVersionHistory, type VersionComparison } from './use-version-history'
import { diffProse } from './version-diff'
import { pluralEn } from '../../../shared/plural-en'

type Text = (zh: string, en: string) => string

const TYPE_NAMES: Record<string, [string, string]> = {
  draft: ['草稿', 'Draft'],
  refined: ['修稿', 'Revision'],
  final: ['定稿', 'Final'],
}

function versionName(version: VersionRecord, text: Text): string {
  const [zh, en] = TYPE_NAMES[version.type] ?? TYPE_NAMES.draft
  return text(`${zh} v${version.version}`, `${en} v${version.version}`)
}

/** 对比区还没有对比时的一句。稿已删除时各稿正在后台重读、可能失败，不担保列表已刷新。 */
function comparisonHint(reading: boolean, missingPicked: boolean, text: Text): string {
  if (reading) return text('正在读取…', 'Loading…')
  if (missingPicked) return text('这一稿已不存在，可能已被删除，请另选一稿。', 'This version no longer exists. It may have been deleted. Pick another version.')
  return text('选一稿，与当前稿逐字对比。', 'Pick a version to compare it with the current draft.')
}

function DiffView({ older, current }: { older: string; current: string }) {
  const text = useLocaleStore(s => s.text)
  const diff = useMemo(() => diffProse(older, current), [older, current])
  return (
    <>
      <p className="stage-hist-stats">
        {diff.added + diff.removed === 0
          ? <span>{text('与当前稿相同', 'Same as the current draft')}</span>
          : <>
            <span data-kind="added">{text(`新增 ${diff.added} 处`, `${diff.added} added`)}</span>
            <span data-kind="removed">{text(`删去 ${diff.removed} 处`, `${diff.removed} removed`)}</span>
          </>}
        <span className="stage-hist-readonly"><Lock size={12} aria-hidden="true" />{text('只读对比，不能在这里编辑', 'Read-only comparison. Nothing here can be edited.')}</span>
      </p>
      <article className="stage-hist-page" aria-label={text('与当前稿的差异', 'Differences from the current draft')} aria-readonly="true">
        {diff.paragraphs.map((paragraph, index) => (
          <p key={index}>
            {paragraph.map((segment, part) => segment.kind === 'added'
              ? <ins key={part}>{segment.text}</ins>
              : segment.kind === 'removed' ? <del key={part}>{segment.text}</del> : <span key={part}>{segment.text}</span>)}
          </p>
        ))}
      </article>
    </>
  )
}

/** 读得快的章不闪「正在读取」：挂上 150ms 后才出现。用计时而不是动画延迟，减弱动画时也一样。 */
function SlowLoading() {
  const text = useLocaleStore(s => s.text)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 150)
    return () => window.clearTimeout(timer)
  }, [])
  return shown ? <p className="stage-hist-help stage-hist-loading" role="status">{text('正在读取…', 'Loading…')}</p> : null
}

/**
 * 版本历史：左列章节，中列这一章的各稿（新的在上），右列所选一稿与当前稿的只读对比。
 * 回退用旧稿新建一稿，不覆盖、不删除任何一稿。
 */
export default function StageHistory({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const draftsByChapter = useDraftStore(s => s.draftsByChapter)
  const draftSession = useDraftStore(s => s.dataProjectSession)
  const { chapters, loading, selectedChapter, selectChapter, versions, versionsLoading, versionsFailed, reloadVersions, readComparison, createRollbackDraft } = useVersionHistory(projectKey)
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [comparison, setComparison] = useState<VersionComparison | null>(null)
  /** 刚点的那一稿已不存在（被删掉而列表还没刷新）；再点别的稿或换章时清掉。 */
  const [missingPicked, setMissingPicked] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [revertOpen, setRevertOpen] = useState(false)
  const comparisonRequest = useRef(0)

  const draftCounts = sameProjectSessionContext(draftSession, projectSessionContextFromProject(project)) ? draftsByChapter : null
  const ordered = useMemo(() => [...versions].sort((left, right) => right.version - left.version), [versions])
  const latest = ordered[0]
  const selected = ordered.find(version => version.id === selectedVersionId) ?? null
  const chapter = chapters.find(candidate => candidate.number === selectedChapter)

  const formatTime = (value: string) => sqliteTime(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

  // 选的稿与对比只属于这次打开：重新打开作品后各稿重读、最新稿可能已换，留着旧对比会与新页头对不上。
  // 还在读的旧对比不用作废：会话已切换时 readComparison 返回 null，回到「选一稿」。
  const sessionLease = project?.sessionLease
  const [pickLease, setPickLease] = useState(sessionLease)
  if (pickLease !== sessionLease) {
    setPickLease(sessionLease)
    setSelectedVersionId(null)
    setComparison(null)
    setMissingPicked(false)
  }

  const pickChapter = (chapterNumber: number) => {
    comparisonRequest.current++
    setSelectedVersionId(null)
    setComparison(null)
    setMissingPicked(false)
    selectChapter(chapterNumber)
  }

  const reloadDraftCounts = () => {
    const session = projectSessionContextFromProject(useProjectStore.getState().currentProject)
    if (session) void useDraftStore.getState().loadAllDrafts(session.projectPath, session)
  }

  const pickVersion = async (versionId: number) => {
    const request = ++comparisonRequest.current
    setSelectedVersionId(versionId)
    setComparison(null)
    setMissingPicked(false)
    try {
      const next = await readComparison(versionId)
      if (request !== comparisonRequest.current) return
      if (next === 'missing') {
        // 这一稿已被删掉：说明一句，并重读各稿与左列稿数把它去掉。
        setSelectedVersionId(null)
        setMissingPicked(true)
        reloadVersions()
        reloadDraftCounts()
      } else if (next === null) {
        // 作品已重新打开：回到「选一稿」，不停在正在读取。
        setSelectedVersionId(null)
      } else setComparison(next)
    } catch (error) {
      if (request !== comparisonRequest.current) return
      setSelectedVersionId(null)
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
      toast.error(text(`读取这一稿失败：${reason}`, `Could not read this version: ${reason}`))
    }
  }

  const revert = async () => {
    if (!selected || selectedChapter === null) return
    setReverting(true)
    try {
      const created = await createRollbackDraft(selected.id)
      if (created === null) return
      setRevertOpen(false)
      toast.success(created.version === null
        ? text('已新建回滚草稿，原有各稿都保留', 'Rollback draft created. Every earlier version is kept.')
        : text(`已新建草稿 v${created.version}，原有各稿都保留`, `Draft v${created.version} created. Every earlier version is kept.`))
      reloadDraftCounts()
      comparisonRequest.current++
      setSelectedVersionId(null)
      setComparison(null)
    } catch (error) {
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, error)
      toast.error(text(`回退失败：${reason}`, `Could not revert: ${reason}`))
    } finally {
      setReverting(false)
    }
  }

  if (!loading && chapters.length === 0) {
    return (
      <div className="stage-hist stage-hist--empty">
        <EmptyState
          heading={text('还没有可回看的章节', 'No chapters to look back on yet')}
          description={text('每章的草稿、修稿和定稿都会留在这里。先在蓝图里规划章节。', 'Every draft, revision and final of each chapter is kept here. Plan chapters in the blueprint first.')}
          action={<Button variant="primary" onClick={() => navigate({ kind: 'stage', stage: 'blueprint' })}>{text('打开蓝图', 'Open blueprint')}</Button>}
        />
      </div>
    )
  }

  return (
    <div className="stage-hist-frame">
      <div className="stage-hist">
        <nav className="stage-hist-col stage-hist-chapters" aria-label={text('章节', 'Chapters')}>
          <div className="stage-hist-pad">
            <h1 className="stage-hist-title">{text('版本历史', 'Version history')}</h1>
            <p className="stage-hist-help">{text('每章的草稿、修稿和定稿都会留下记录。', 'Every draft, revision and final of each chapter is kept.')}</p>
          </div>
          <ol className="stage-hist-list">
            {chapters.map(item => {
              const count = draftCounts ? (draftCounts[item.number]?.length ?? 0) : undefined
              return (
                <li key={item.number}>
                  <button
                    type="button"
                    className="stage-hist-chapter"
                    aria-current={item.number === selectedChapter ? 'true' : undefined}
                    data-empty={count === 0 || undefined}
                    onClick={() => pickChapter(item.number)}
                  >
                    <span className="stage-hist-no">{String(item.number).padStart(2, '0')}</span>
                    <span className="stage-hist-name">{item.title}</span>
                    {count !== undefined && <small>{count === 0 ? text('未开始', 'Not started') : text(`${count} 稿`, `${count} ${pluralEn(count, 'draft')}`)}</small>}
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <section className="stage-hist-col stage-hist-versions" aria-label={text('这一章的各稿', 'Versions of this chapter')}>
          {chapter ? <>
            <div className="stage-hist-eyebrow">{text(`第 ${chapter.number} 章`, `Chapter ${chapter.number}`)}</div>
            <h2 className="stage-hist-chapter-title">{chapter.title}</h2>
            {versionsLoading
              ? <SlowLoading key={chapter.number} />
              : versionsFailed
              ? (
                <Notice tone="warn" title={text('没能读出这一章的各稿', 'Could not read the versions of this chapter')}
                  actions={<Button variant="secondary" size="sm" onClick={reloadVersions}>{text('重新读取', 'Read again')}</Button>}>
                  {text('这次没读出来，可以重新读取。', 'This read did not go through. You can read again.')}
                </Notice>
              )
              : ordered.length === 0
              ? <p className="stage-hist-help">{text('这一章还没有稿。写出第一稿后会出现在这里。', 'No drafts yet. The first draft will appear here.')}</p>
              : (
                <ol className="stage-hist-timeline" aria-label={text('版本时间线', 'Version timeline')}>
                  {ordered.map(version => (
                    <li key={version.id} data-kind={version.type}>
                      <button
                        type="button"
                        className="stage-hist-version"
                        aria-pressed={version.id === selectedVersionId}
                        onClick={() => void pickVersion(version.id)}
                      >
                        <span className="stage-hist-node" aria-hidden="true" />
                        <span className="stage-hist-version-name">
                          {versionName(version, text)}
                          {version === latest && <span className="stage-hist-badge">{text('当前', 'Current')}</span>}
                          {version.dependencies_stale && (
                            <span
                              className="stage-hist-badge"
                              data-tone="warn"
                              title={text(
                                '此草稿生成时使用的前文来源已变化或不再是当前定稿；草稿会保留，但连续性需要复核。',
                                'A prior source used to generate this draft changed or is no longer the current final. The draft is preserved, but its continuity needs review.',
                              )}
                            >
                              {text('来源已过期', 'Source changed')}
                            </span>
                          )}
                        </span>
                        <span className="stage-hist-meta">
                          {text(`${version.word_count.toLocaleString(locale)} 字`, `${version.word_count.toLocaleString(locale)} ${pluralEn(version.word_count, 'word')}`)} · {formatTime(version.created_at)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
          </> : <p className="stage-hist-help">{text('从左边选一章，查看它的各稿。', 'Pick a chapter on the left to see its versions.')}</p>}
        </section>

        <section className="stage-hist-col stage-hist-diff" aria-label={text('对比', 'Comparison')}>
          {selected && comparison && latest ? <>
            <header className="stage-hist-diff-head">
              <div className="stage-hist-pair">
                <span className="stage-hist-tag">{versionName(selected, text)} · {formatTime(selected.created_at)}</span>
                <ArrowRight size={14} aria-hidden="true" />
                <span className="stage-hist-tag">{text('当前', 'Current')} · {versionName(latest, text)}</span>
              </div>
              {selected !== latest && (
                <Button variant="secondary" onClick={() => setRevertOpen(true)}>
                  <RotateCcw size={14} aria-hidden="true" />{text('回退到此版本…', 'Revert to this version…')}
                </Button>
              )}
            </header>
            {comparison.current === null
              ? <p className="stage-hist-help">{text('这一章还没有当前稿。', 'This chapter has no current draft.')}</p>
              : <DiffView older={comparison.older} current={comparison.current} />}
          </> : (
            <p className="stage-hist-help stage-hist-hint" role="status">{comparisonHint(selectedVersionId !== null, missingPicked, text)}</p>
          )}
        </section>

        {selected && latest && selectedChapter !== null && (
          <RevertDialog
            open={revertOpen}
            onOpenChange={setRevertOpen}
            chapterNumber={selectedChapter}
            source={versionName(selected, text)}
            nextVersion={latest.version + 1}
            current={versionName(latest, text)}
            busy={reverting}
            onConfirm={() => void revert()}
          />
        )}
      </div>
    </div>
  )
}
