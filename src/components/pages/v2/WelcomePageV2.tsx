import { Fragment, useMemo, useState } from 'react'
import { ArrowRight, Compass, FolderOpen, Import, Plus } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useOnboardingStore } from '../../../stores/onboarding-store'
import { APP_BRAND } from '../../../shared/brand'
import { useLocaleStore } from '../../../stores/locale-store'
import { cn } from '../../../lib/utils'
import { UpdateSection } from '../../updates/UpdateSection'
import BookShelf, { type ShelfBook } from './BookShelf'
import {
  currentTitleFontSize,
  readOverviewSnapshot,
  useProjectOverview,
  useProjectPeek,
  type OverviewSnapshot,
  type ProjectFocus,
  type ProjectOverviewStage,
  type ProjectPeekResult,
  type ProjectPeekState,
} from './useProjectOverview'
import { CREATION_STAGE_ORDER, STAGE_LABEL, type CreationStage } from '../../layout/v2/creation-stages'
import { goRail } from '../../layout/v2/rail-routing'
import { openChapterFile } from '../../panels/sidebar/sidebar-file-openers'
import { BRAND_SEAL_LARGE_URL, shelfBackgroundStyle } from '../../layout/v2/v2-assets'
import { useUiVersionStore, isMagazine } from '../../../stores/ui-version-store'
import MagLogo from '../../layout/v2/magazine/MagLogo'
import { useThemeStore } from '../../../stores/theme-store'

export interface WelcomePageV2Props {
  onNewProject: () => void
  onOpenProject: () => void
  onImportNovel?: () => void
}

/** 卡片要展示的全部内容 —— 既能来自「当前项目」的实时统计，也能来自书架上某本书的实时资料。 */
interface CardView {
  name: string
  /** true 表示这张卡正在预览书架上另一本书 */
  isPreview: boolean
  /** false 表示这本书没有可显示的数据（读不到它的库，也还没留下过快照） */
  hasSnapshot: boolean
  /** 预览另一本书时的资料来源状态，只用于提示文案 */
  peekState: ProjectPeekState
  totalWords: number | null
  finalizedChapters: number
  plannedChapters: number | null
  blueprintChapters: number | null
  genres: string[]
  lede: string
  focus: ProjectFocus | null
  stages: ProjectOverviewStage[]
  threadsPending: number | null
  characters: number
}

const EMPTY_CARD: Omit<CardView, 'name' | 'isPreview' | 'hasSnapshot' | 'peekState'> = {
  totalWords: null,
  finalizedChapters: 0,
  plannedChapters: null,
  blueprintChapters: null,
  genres: [],
  lede: '',
  focus: null,
  stages: [],
  threadsPending: null,
  characters: 0,
}

/**
 * 预览态卡片的取值顺序：**刚读到的真实资料** → 还没读回来时的旧快照 → 空卡。
 *
 * 为什么留快照这一层：点下书脊到 IPC 返回之间有几十毫秒，先拿快照顶上，
 * 卡片就不会闪一下空白；等真实资料到了立刻换掉。快照只是过渡，永不作为真相。
 */
function buildPreviewCard(
  name: string,
  peek: ProjectPeekResult,
  snapshot: OverviewSnapshot | null,
): CardView {
  if (peek.state === 'ready' && peek.data) {
    const data = peek.data
    const targetWords = data.focusTargetWords
    const focus: ProjectFocus | null =
      data.focusChapterNumber === null || data.focusDraftId === null
        ? null
        : {
            chapterNumber: data.focusChapterNumber,
            draftId: data.focusDraftId,
            excerpt: data.focusExcerpt,
            words: data.focusWords,
            targetWords,
            percent: targetWords ? Math.round((data.focusWords / targetWords) * 100) : null,
          }
    const doneMap: Record<CreationStage, boolean> = {
      config: data.configReady,
      arch: data.archReady,
      bp: (data.blueprintChapters ?? 0) > 0,
      draft: data.draftedChapters > 0,
      review: data.reviewedOrBeyond > 0,
      final: data.finalizedChapters > 0,
    }
    const firstUndone = CREATION_STAGE_ORDER.find((stage) => !doneMap[stage]) ?? null
    return {
      name: data.name || name,
      isPreview: true,
      hasSnapshot: true,
      peekState: 'ready',
      totalWords: data.totalWords,
      finalizedChapters: data.finalizedChapters,
      plannedChapters: data.plannedChapters,
      blueprintChapters: data.blueprintChapters,
      genres: data.genres,
      lede: data.lede,
      focus,
      stages: CREATION_STAGE_ORDER.map((stage) => ({
        stage,
        done: doneMap[stage],
        now: stage === firstUndone,
      })),
      threadsPending: data.threadsPending,
      characters: data.characters,
    }
  }

  if (snapshot) {
    return { ...snapshot, isPreview: true, hasSnapshot: true, peekState: peek.state }
  }

  return { ...EMPTY_CARD, name, isPreview: true, hasSnapshot: false, peekState: peek.state }
}

/** 书脊上的类型标签：从快照派生，书架上就能看出每本书走到哪一步了。 */
function shelfStatus(snapshot: OverviewSnapshot | null, fallback: string): string {
  if (!snapshot) return fallback
  const { finalizedChapters, focus, draftedChapters, blueprintChapters, plannedChapters } = snapshot
  if (plannedChapters !== null && plannedChapters > 0 && finalizedChapters >= plannedChapters) return '已定稿'
  if (focus) return '写作中'
  if (draftedChapters > 0) return '草稿'
  if ((blueprintChapters ?? 0) > 0) return '蓝图'
  return fallback
}

/**
 * 「墨纸书斋」书架首页（v2）。
 *
 * 对应 demo 的 viewShelf()：腊梅水墨底 → 印章 Hero → 当前项目卡 → 拟真书柜 → 书案三卡。
 *
 * 两张卡是联动的：
 *  · 默认展示**当前项目**的实时统计（useProjectOverview，数据都来自真实项目状态）
 *  · 单击书架上另一本书 → 卡片切成**那本书**的进度（读打开它时落下的快照，瞬时显示）
 *  · 再击同一本书 → 真正进入它
 */
export default function WelcomePageV2({ onNewProject, onOpenProject, onImportNovel }: WelcomePageV2Props) {
  const recentProjects = useProjectStore((s) => s.recentProjects)
  const currentProject = useProjectStore((s) => s.currentProject)
  const openProject = useProjectStore((s) => s.openProject)
  const text = useLocaleStore((s) => s.text)
  /** 首页背景按**界面版本**切换（不是按主题）：v2 腊梅/星空、v3 杂志版面。
   *  两个版本各自拥有全新的背景页，互不蚕食 —— 见 v2-assets.ts。 */
  const theme = useThemeStore((s) => s.theme)
  const uiVersion = useUiVersionStore((s) => s.uiVersion)
  const overview = useProjectOverview()
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  /** 书脊的状态与体量都取自各项目自己的快照，书架一眼能看出进度 */
  const shelfBooks: ShelfBook[] = useMemo(
    () => recentProjects.map((project, index) => {
      const snapshot = readOverviewSnapshot(project.path)
      return {
        id: `${project.path}#${index}`,
        title: project.name,
        status: shelfStatus(snapshot, text('藏书', 'On shelf')),
        chapters: snapshot?.plannedChapters ?? undefined,
      }
    }),
    [recentProjects, text],
  )

  const previewingBook = previewPath !== null && previewPath !== currentProject?.path
  /** 书架上点开的那本书：直接去读它自己的库；快照只作为「还没读回来」时的过渡 */
  const peek = useProjectPeek(previewingBook ? previewPath : null)
  const previewSnapshot = useMemo(
    () => (previewingBook && previewPath ? readOverviewSnapshot(previewPath) : null),
    [previewingBook, previewPath],
  )
  const previewName = recentProjects.find((project) => project.path === previewPath)?.name ?? ''

  const card: CardView | null = previewingBook
    ? buildPreviewCard(previewName, peek, previewSnapshot)
    : (currentProject
      ? { ...overview, name: currentProject.name, isPreview: false, hasSnapshot: true, peekState: 'ready' }
      : null)

  const titleSize = currentTitleFontSize(card?.name ?? '', card?.genres.join(' · ').length ?? 0)
  const focus = card?.focus ?? null

  return (
    <div
      className="v2-shelf-page skin-workspace-page"
      style={{ height: '100%', overflowY: 'auto', ...shelfBackgroundStyle(theme, uiVersion) }}
    >
      <div className="v2-shelf-inner">
        {/* ===== Hero：印章 + 书名 + 题记 ===== */}
        <div className="v2-shelf-hero">
          <span className="shlogo">
            {/* v3：首页刊标也换成**双页 W**（先生挑的 NO.02）—— 与刊头同一个母题；
                v2 仍是原来的朱砂印章，逐像素不变。 */}
            {isMagazine(uiVersion)
              ? <MagLogo size={64} />
              : <img src={BRAND_SEAL_LARGE_URL} alt={text(APP_BRAND.zhName, APP_BRAND.enName)} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="v2-shelf-eyebrow">AI NOVEL WRITER</div>
            <h1 className="home-hero-title">{text(APP_BRAND.zhName, APP_BRAND.enName)}</h1>
            <p className="v2-shelf-lede">{text(APP_BRAND.tagline, APP_BRAND.taglineEn)}</p>
          </div>
          <div className="v2-shelf-verse">
            {text('从灵感到章节', 'From spark to chapter')}
            <br />
            {text('沉浸创作', 'Immerse and write')}
          </div>
        </div>

        {/* ===== 项目卡：当前项目 / 书架上选中某本书的进度 ===== */}
        {card && (
          <div
            className={cn('card home-current-card v2-current-card', card.isPreview && 'is-preview')}
            title={card.isPreview ? previewPath ?? '' : currentProject?.path}
            onClick={() => {
              if (card.isPreview && previewPath) {
                void openProject(previewPath)
                return
              }
              goRail('project')
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              if (card.isPreview && previewPath) {
                void openProject(previewPath)
                return
              }
              goRail('project')
            }}
          >
            <div className="v2-current-head">
              <span className="v2-current-eyebrow">
                {card.isPreview
                  ? text('书架预览 · PREVIEW', 'SHELF PREVIEW')
                  : text('当前项目 · CURRENT', 'CURRENT PROJECT')}
              </span>
              <span className="badge r">
                {focus ? text('写作中', 'In progress') : text('待落笔', 'Not started')}
              </span>
              {card.plannedChapters !== null && (
                <span className="v2-current-volume">
                  {text(`计划 ${card.plannedChapters} 章`, `${card.plannedChapters} chapters planned`)}
                </span>
              )}
            </div>

            {/* 第一排永远是「书名 + 题材」：书名长了缩字号，不换行 */}
            <div className="v2-current-titlerow">
              <h2
                className="home-current-title"
                style={{ ['--current-title-size' as string]: `${titleSize.toFixed(1)}px` }}
              >
                {card.name}
              </h2>
              {card.genres.length > 0 && (
                <span className="v2-current-genres">{card.genres.join(' · ')}</span>
              )}
            </div>

            {/* 先生：没有简介的书也要占住这一行 —— 早先是 {card.lede && <p>}，
                没简介时整段消失，面板就矮一行，框体大小随书而变。
                现在始终渲染，空简介留白占位。 */}
            <p className="v2-current-lede">{card.lede ?? ''}</p>

            {!card.hasSnapshot && (
              <p className="v2-current-empty">
                {card.peekState === 'loading'
                  ? text('正在读取这本书的资料…', 'Reading this book’s data…')
                  : card.peekState === 'unavailable'
                    ? text(
                      '读不到这本书的项目库（可能已被移动或删除）。',
                      'Cannot read this project database (it may have been moved or deleted).',
                    )
                    : text(
                      '这本书还没有进度快照。双击书脊进入它，统计就会出现在这里。',
                      'No progress snapshot yet. Double-click the spine to open it and the stats will show up here.',
                    )}
              </p>
            )}

            {card.hasSnapshot && (
              <>
                {/* 数据行：取不到的项显示破折号，不摆 0 冒充数据 */}
                <div className="v2-current-stats">
                  <div>
                    <b className={cn(card.totalWords === null && 'is-empty')}>
                      {card.totalWords === null ? '—' : card.totalWords.toLocaleString()}
                    </b>
                    <span>{text('全书字数', 'Total words')}</span>
                  </div>
                  <div>
                    <b className={cn('is-accent', !focus && 'is-empty')}>
                      {focus
                        ? (
                          <>
                            {focus.words.toLocaleString()}
                            {focus.targetWords !== null && <em> / {focus.targetWords.toLocaleString()}</em>}
                          </>
                        )
                        : '—'}
                    </b>
                    <span>
                      {focus
                        ? text(`第 ${focus.chapterNumber} 章字数`, `Chapter ${focus.chapterNumber} words`)
                        : text('当前章字数', 'Current chapter')}
                    </span>
                  </div>
                  <div>
                    <b className={cn(card.plannedChapters === null && 'is-empty')}>
                      {card.finalizedChapters}
                      {card.plannedChapters !== null && <em> / {card.plannedChapters}</em>}
                    </b>
                    <span>{text('已定稿章节', 'Finalized chapters')}</span>
                  </div>
                </div>

                {/* 六道工序：完成度由真实数据派生 */}
                {card.stages.length > 0 && (
                  <div className="v2-current-flow">
                    {card.stages.map((item, index) => (
                      <Fragment key={item.stage}>
                        {index > 0 && (
                          <span className={cn('flink', card.stages[index - 1].done && 'done')} />
                        )}
                        <span className={cn('fstep', item.done && 'done', item.now && 'now')}>
                          <span className="fdot">{item.done ? '✓' : ''}</span>
                          {text(STAGE_LABEL[item.stage].zh, STAGE_LABEL[item.stage].en)}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                )}

                {/* 焦点章节：这本书上次写到哪
                    先生：一章都没有的书也要占住这块 —— 早先是 {focus && <div>}，
                    没章节时整块消失，面板就矮一截、框体大小随书而变。
                    现在用三元补上占位，且**沿用同一套结构**（.fc-main/.fc-title/.fc-note），
                    所以有没有章节，这一块的高度都相同。 */}
                {focus ? (
                  <div className="v2-current-focus">
                    <div className="fc-main">
                      <div className="fc-title">
                        {text(`第 ${focus.chapterNumber} 章`, `Chapter ${focus.chapterNumber}`)}
                      </div>
                      {focus.excerpt && (
                        <div className="fc-note">
                          {text('上一笔停在：', 'Last line: ')}
                          {focus.excerpt}
                        </div>
                      )}
                    </div>
                    {focus.percent !== null && (
                      <span className="fc-progress">
                        {text(`本章 ${focus.percent}%`, `Chapter ${focus.percent}%`)}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="v2-current-focus">
                    <div className="fc-main">
                      <div className="fc-title">{text('还没开始创作呢', 'Nothing written yet')}</div>
                      <div className="fc-note">
                        {text('挑一章落笔，这里就会显示上次写到哪里。', 'Start a chapter and this will show where you left off.')}
                      </div>
                    </div>
                  </div>
                )}

                <div className="v2-current-cta">
                  <div className="v2-current-actions">
                    {card.isPreview ? (
                      <>
                        <button
                          className="btn ai"
                          onClick={(event) => {
                            event.stopPropagation()
                            if (previewPath) void openProject(previewPath)
                          }}
                        >
                          {text('打开这本书 →', 'Open this book →')}
                        </button>
                        <button
                          className="btn outline"
                          onClick={(event) => { event.stopPropagation(); setPreviewPath(null) }}
                        >
                          {text('返回当前项目', 'Back to current')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn ai"
                          onClick={(event) => {
                            event.stopPropagation()
                            if (!focus) {
                              goRail('project')
                              return
                            }
                            void openChapterFile(
                              `vela://draft/${focus.draftId}`,
                              text(`第 ${focus.chapterNumber} 章`, `Chapter ${focus.chapterNumber}`),
                            )
                          }}
                        >
                          {focus ? text('继续写作 →', 'Keep writing →') : text('开始写作 →', 'Start writing →')}
                        </button>
                        <button
                          className="btn outline"
                          onClick={(event) => { event.stopPropagation(); goRail('project') }}
                        >
                          {text('查看章节', 'Chapter list')}
                        </button>
                      </>
                    )}
                  </div>

                  <div className="v2-current-signals">
                    {card.threadsPending !== null && (
                      <span>
                        <span className={cn('dot', card.threadsPending > 0 ? 'warn' : 'idle')} />
                        {text(`伏笔 ${card.threadsPending} 处待收`, `${card.threadsPending} threads open`)}
                      </span>
                    )}
                    {card.characters > 0 && (
                      <span>
                        <span className="dot ok" />
                        {text(`人物 ${card.characters} 位已建档`, `${card.characters} characters`)}
                      </span>
                    )}
                    {card.blueprintChapters !== null && (
                      <span>
                        <span className={cn('dot', card.blueprintChapters > 0 ? 'ok' : 'idle')} />
                        {text(`蓝图 ${card.blueprintChapters} 章已规划`, `${card.blueprintChapters} blueprints`)}
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ===== 我的书架：拟真书柜（点一下看进度，再点进入） ===== */}
        {shelfBooks.length > 0 && (
          <div style={{ marginBottom: 36 }}>
            <div className="v2-shelf-section-head">
              <b>{text('我的书架', 'My shelf')}</b>
              <span className="v2-shelf-count">
                {text(`MY SHELF · ${shelfBooks.length} 本`, `MY SHELF · ${shelfBooks.length} books`)}
              </span>
            </div>
            <BookShelf
              books={shelfBooks}
              onNewBook={onNewProject}
              onSelectBook={(book) => setPreviewPath(book.id.split('#')[0])}
              onOpenBook={(book) => { void openProject(book.id.split('#')[0]) }}
            />
          </div>
        )}

        {/* ===== 书案三卡 ===== */}
        <div className="v2-desk-cards">
          <button className="card hov v2-desk-card" onClick={onNewProject}>
            <span className="v2-desk-icon" style={{ ['--tint' as string]: 'var(--seal)' }}>
              <Plus size={19} />
            </span>
            <span className="v2-desk-copy">
              <b>{text('新建小说', 'New novel')}</b>
              <span>{text('为新的故事起个头', 'Start a new story')}</span>
            </span>
            <ArrowRight size={14} className="v2-desk-arrow" />
          </button>

          <button className="card hov v2-desk-card" onClick={onOpenProject}>
            <span className="v2-desk-icon" style={{ ['--tint' as string]: 'var(--info)' }}>
              <FolderOpen size={19} />
            </span>
            <span className="v2-desk-copy">
              <b>{text('打开小说', 'Open novel')}</b>
              <span>{text('继续上一本书', 'Pick up where you left off')}</span>
            </span>
            <ArrowRight size={14} className="v2-desk-arrow" />
          </button>

          <button className="card hov v2-desk-card" onClick={onImportNovel}>
            <span className="v2-desk-icon" style={{ ['--tint' as string]: 'var(--green)' }}>
              <Import size={19} />
            </span>
            <span className="v2-desk-copy">
              <b>{text('拆解仿写', 'Style study')}</b>
              <span>{text('从参考小说取风格', 'Learn from a reference novel')}</span>
            </span>
            <ArrowRight size={14} className="v2-desk-arrow" />
          </button>
        </div>

        {/* ===== 产品既有能力：更新检查（demo 没有，但功能不能丢） ===== */}
        <UpdateSection />

        {/* 新手引导的手动入口：自动只弹一次，想重看随时点这里。 */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0 12px' }}>
          <button
            type="button"
            onClick={() => useOnboardingStore.getState().openGuide()}
            title={text('从配置模型开始，重看一遍上手流程', 'Walk through the setup flow again, starting from the model')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              fontSize: 11.5,
              color: 'var(--muted)',
              background: 'transparent',
              border: '1px solid var(--line2)',
              borderRadius: 7,
              cursor: 'pointer',
            }}
          >
            <Compass size={12} />
            {text('新手引导', 'Quick start guide')}
          </button>
        </div>

        <div className="v2-shelf-foot">
          {text(
            `${APP_BRAND.zhName} · 七阶段 AI 驱动创作流水线 · 本地数据安全`,
            `${APP_BRAND.enName} · Seven-stage AI writing pipeline · Local data control`,
          )}
        </div>
      </div>
    </div>
  )
}
