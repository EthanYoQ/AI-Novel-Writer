/**
 * 书架首页「当前项目」卡片的数据聚合。
 *
 * 先生的要求：这张卡要「即时读取」真实项目数据，和设计 demo 一样有信息量。
 * 这里的取舍是**只读既有真相，不为首页新增任何持久化状态**：
 *
 *  · 全书字数 / 已定稿章数 / 焦点章字数 —— 全部从 draft-store 的 `draftsByChapter` 派生。
 *    那份索引在打开项目时已由 `loadAllDrafts()` 一次性全量载入（project-service 的
 *    `onProjectOpened`），所以这几项**零额外 IPC**。
 *  · 架构状态 / 蓝图数 / 伏笔待收 —— 3 次轻量查询（架构与蓝图复用 architecture-service
 *    的既有实现）。
 *  · 「上一笔停在」—— 取焦点章最新一版的正文尾部，1 次 `db:draft-get-full`。
 *
 * 刻意不做的两件事（demo 有、产品取不到）：
 *  · 「第 2 卷 · 疑云」：项目数据模型里没有「卷」的概念，不编。
 *  · 「设定 0 冲突」：一致性冲突是运行时按蓝图逐条预检算出来的（O(蓝图数) 次 IPC），
 *    不适合首页常驻调用，因此不在卡片上摆这个数字。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { checkArchStatus, getBlueprintCount } from '../../../services/architecture-service'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import type { DraftsByChapter } from '../../../stores/draft-store'
import { useCharacterStore } from '../../../stores/character-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { CREATION_STAGE_ORDER, type CreationStage } from '../../layout/v2/creation-stages'
import type { ProjectPeekOverview } from '../../../shared/ipc-channels'

export interface ProjectOverviewStage {
  stage: CreationStage
  /** 该段是否已达成 */
  done: boolean
  /** 当前停在哪一段（第一个未达成者） */
  now: boolean
}

export interface ProjectFocus {
  chapterNumber: number
  /** 该章最新一版的草稿 id（供「继续写作」直接翻开这一章） */
  draftId: number
  /** 该章最新一版正文的尾部摘要（「上一笔停在」） */
  excerpt: string
  words: number
  targetWords: number | null
  /** 本章完成度（字数 / 每章目标），取不到目标字数时为 null */
  percent: number | null
}

export interface ProjectOverview {
  /** 全书字数：按章取最新一版求和；一章都没有时为 null（不摆 0 冒充数据） */
  totalWords: number | null
  draftedChapters: number
  finalizedChapters: number
  plannedChapters: number | null
  blueprintChapters: number | null
  focus: ProjectFocus | null
  stages: ProjectOverviewStage[]
  /** 未回收的伏笔（非 resolved / abandoned） */
  threadsPending: number | null
  characters: number
  /** 一句话简介（取自核心大纲的首句） */
  lede: string
  genres: string[]
  loading: boolean
}

/** 取正文尾部一句话，作为「上一笔停在」。 */
export function summarizeTail(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  let tail = lines.at(-1) ?? ''
  // 最后一行若是 markdown 标题，就再往上取一行
  if (/^#{1,6}\s/.test(tail)) tail = lines.at(-2) ?? ''
  const clean = tail.replace(/[#>*_`~]/g, '').trim()
  if (!clean) return ''
  return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean
}

/** 取一段文本的第一句，用于卡片上的一句话简介。 */
export function firstSentence(value: string | undefined | null, max = 96): string {
  const flat = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const cut = flat.match(/^[^。！？!?]{4,}?[。！？!?]/)?.[0] ?? flat
  return cut.length > max ? `${cut.slice(0, max)}…` : cut
}

/**
 * 焦点章：优先正在编辑的那一章，其次最近改动过的一章。
 * 两者都没有时返回 null（新项目还没落笔）。
 */
export function pickFocusChapter(
  draftsByChapter: DraftsByChapter,
  activeChapterNumber: number | undefined,
): number | null {
  if (activeChapterNumber !== undefined && draftsByChapter[activeChapterNumber]?.length) {
    return activeChapterNumber
  }
  let bestChapter: number | null = null
  let bestAt = ''
  for (const [chapter, drafts] of Object.entries(draftsByChapter)) {
    const latest = drafts[0]
    if (!latest) continue
    const at = latest.updatedAt ?? latest.createdAt ?? ''
    if (bestChapter === null || at > bestAt) {
      bestChapter = Number(chapter)
      bestAt = at
    }
  }
  return bestChapter ?? activeChapterNumber ?? null
}

interface DraftStats {
  totalWords: number | null
  draftedChapters: number
  finalizedChapters: number
  reviewedOrBeyond: number
  focusWords: number
}

function summarizeDrafts(draftsByChapter: DraftsByChapter, focusChapter: number | null): DraftStats {
  let totalWords = 0
  let draftedChapters = 0
  let finalizedChapters = 0
  let reviewedOrBeyond = 0

  for (const drafts of Object.values(draftsByChapter)) {
    if (!drafts.length) continue
    draftedChapters += 1
    // draftsByChapter 已按 version 降序排列，[0] 就是该章最新一版
    totalWords += drafts[0].wordCount ?? 0
    if (drafts.some((draft) => draft.status === 'finalized')) finalizedChapters += 1
    if (drafts.some((draft) => draft.status === 'finalized' || draft.status === 'reviewed')) {
      reviewedOrBeyond += 1
    }
  }

  const focusWords = focusChapter === null
    ? 0
    : draftsByChapter[focusChapter]?.[0]?.wordCount ?? 0

  return {
    totalWords: draftedChapters > 0 ? totalWords : null,
    draftedChapters,
    finalizedChapters,
    reviewedOrBeyond,
    focusWords,
  }
}

/**
 * 远程聚合结果。带上「属于哪个项目会话」的键，读取时对不上就按空处理 ——
 * 这样切换项目/重新打开项目时，effect 里不需要同步 setState 去清零。
 */
interface RemoteState {
  key: string
  /** 三次查询是否已经回来 */
  loaded: boolean
  archReady: boolean
  blueprints: number | null
  threads: number | null
  /** 「上一笔停在」属于哪一版草稿 */
  excerptDraftId: number | undefined
  excerpt: string
}

const EMPTY_REMOTE: RemoteState = {
  key: '',
  loaded: false,
  archReady: false,
  blueprints: null,
  threads: null,
  excerptDraftId: undefined,
  excerpt: '',
}

export function useProjectOverview(): ProjectOverview {
  const currentProject = useProjectStore((s) => s.currentProject)
  const draftsByChapter = useDraftStore((s) => s.draftsByChapter)
  const characters = useCharacterStore((s) => s.characters.length)
  const activeChapterNumber = useEditorStore((s) => {
    const tab = s.tabs.find((item) => item.id === s.activeTabId)
    return tab?.chapterNumber
  })

  const [remote, setRemote] = useState<RemoteState>(EMPTY_REMOTE)

  const focusChapter = pickFocusChapter(draftsByChapter, activeChapterNumber)
  const stats = useMemo(
    () => summarizeDrafts(draftsByChapter, focusChapter),
    [draftsByChapter, focusChapter],
  )

  const sessionKey = `${currentProject?.path ?? ''}#${currentProject?.sessionLease ?? ''}`
  /**
   * 远程数据一律按「项目会话键」派生读取：key 对不上就按空处理。
   * 这样 effect 里不需要同步 setState 去清零（会触发 React 的级联渲染告警），
   * 换项目/重开项目时旧数据也绝不会漏到新项目上。
   */
  const view = remote.key === sessionKey ? remote : EMPTY_REMOTE

  /**
   * 项目对象的「最新值」引用。
   *
   * 为什么需要它：currentProject 是**每次配置改动都会换引用的新对象**
   * （project-store.updateNovelConfig 用 {...project} 重建），
   * 若把它写进下面几个 effect 的依赖数组，作者在配置页每敲一个数字，
   * 这里就会重发 3 次 IPC；而 TitleBarV2 又会调一份本 hook，
   * 于是一次配置编辑引发多次重复查询。改成只依赖 sessionKey（路径 + 租约），
   * 真正的项目切换才重新取数，对象重建不再触发。读值走 ref，避免闭包取到旧对象。
   */
  const currentProjectRef = useRef(currentProject)
  // 赋值放在 effect 里而不是 render 期（同 CodeMirrorEditor 的 updateHandlerRef 范式）：
  // render 期写 ref 在并发渲染 / StrictMode 双调用下可能写入被丢弃的那次渲染的值。
  // 本 effect 声明在下面两个读取 effect 之前，React 按声明顺序执行，读到的必是最新对象。
  useEffect(() => {
    currentProjectRef.current = currentProject
  })

  // 架构 / 蓝图 / 伏笔：三次轻量查询，失败不影响卡片其余部分
  useEffect(() => {
    const projectSession = captureProjectSession(currentProjectRef.current)
    if (!projectSession) return
    let cancelled = false
    void (async () => {
      const settled = await Promise.all([
        checkArchStatus(projectSession).catch(() => null),
        getBlueprintCount(projectSession).catch(() => null),
        ipc.invokeWithProjectSession(
          projectSession,
          'db:narrative-thread-list',
          projectSession.projectPath,
        ).catch(() => null),
      ])
      if (cancelled || !isProjectSessionCurrent(projectSession)) return
      const [arch, blueprints, threads] = settled
      setRemote((prev) => ({
        ...prev,
        key: sessionKey,
        loaded: true,
        archReady: arch ? Object.values(arch).some(Boolean) : false,
        blueprints: typeof blueprints === 'number' ? blueprints : null,
        threads: threads
          ? threads.filter((thread) => thread.status !== 'resolved' && thread.status !== 'abandoned').length
          : null,
      }))
    })()
    return () => { cancelled = true }
  }, [sessionKey])

  // 「上一笔停在」：焦点章最新一版正文的尾部
  const focusDraftId = focusChapter === null
    ? undefined
    : draftsByChapter[focusChapter]?.[0]?.id
  useEffect(() => {
    if (focusDraftId === undefined) return
    const projectSession = captureProjectSession(currentProjectRef.current)
    if (!projectSession) return
    let cancelled = false
    void (async () => {
      const full = await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-get-full',
        focusDraftId,
        projectSession.projectPath,
      ).catch(() => null)
      if (cancelled || !isProjectSessionCurrent(projectSession)) return
      setRemote((prev) => ({
        ...prev,
        key: sessionKey,
        excerptDraftId: focusDraftId,
        excerpt: summarizeTail(full?.content ?? ''),
      }))
    })()
    return () => { cancelled = true }
  }, [focusDraftId, sessionKey])

  /** 摘要必须属于当前这一版草稿，否则按空处理（切章不会串味） */
  const excerpt = view.excerptDraftId === focusDraftId ? view.excerpt : ''
  const archReady = view.archReady
  const blueprintChapters = view.blueprints
  const threadsPending = view.threads

  const novelConfig = currentProject?.novelConfig
  const configReady = Boolean(
    novelConfig
    && (novelConfig.coreOutline?.trim() || novelConfig.worldSetting?.trim() || novelConfig.genre?.trim()),
  )
  const targetWords = novelConfig?.wordsPerChapter && novelConfig.wordsPerChapter > 0
    ? novelConfig.wordsPerChapter
    : null

  const stages = useMemo<ProjectOverviewStage[]>(() => {
    const doneMap: Record<CreationStage, boolean> = {
      config: configReady,
      arch: archReady,
      bp: (blueprintChapters ?? 0) > 0,
      draft: stats.draftedChapters > 0,
      review: stats.reviewedOrBeyond > 0,
      final: stats.finalizedChapters > 0,
    }
    const firstUndone = CREATION_STAGE_ORDER.find((stage) => !doneMap[stage]) ?? null
    return CREATION_STAGE_ORDER.map((stage) => ({
      stage,
      done: doneMap[stage],
      now: stage === firstUndone,
    }))
  }, [archReady, blueprintChapters, configReady, stats.draftedChapters, stats.finalizedChapters, stats.reviewedOrBeyond])

  const focus = useMemo<ProjectFocus | null>(() => {
    if (focusChapter === null || focusDraftId === undefined) return null
    return {
      chapterNumber: focusChapter,
      draftId: focusDraftId,
      excerpt,
      words: stats.focusWords,
      targetWords,
      percent: targetWords ? Math.round((stats.focusWords / targetWords) * 100) : null,
    }
  }, [excerpt, focusChapter, focusDraftId, stats.focusWords, targetWords])

  const genres = useMemo(() => {
    if (!novelConfig) return []
    return [novelConfig.genre, novelConfig.subGenre]
      .map((value) => (value ?? '').trim())
      .filter(Boolean)
  }, [novelConfig])

  const plannedChapters = novelConfig?.totalChapters && novelConfig.totalChapters > 0
    ? novelConfig.totalChapters
    : null
  const lede = firstSentence(novelConfig?.coreOutline)

  /**
   * 打开项目时把统计快照存进 localStorage，供书架上的「点击即预览」瞬间读取。
   * 只在这份数据真正就绪（view.loaded）时写，避免把半截状态存成缓存。
   */
  const snapshotBody = useMemo(() => ({
    path: currentProject?.path ?? '',
    name: currentProject?.name ?? '',
    totalWords: stats.totalWords,
    finalizedChapters: stats.finalizedChapters,
    draftedChapters: stats.draftedChapters,
    plannedChapters,
    blueprintChapters,
    genres,
    lede,
    focus,
    stages,
    threadsPending,
    characters,
  }), [
    blueprintChapters, characters, currentProject?.name, currentProject?.path,
    focus, genres, lede, plannedChapters, stages,
    stats.draftedChapters, stats.finalizedChapters, stats.totalWords, threadsPending,
  ])

  useEffect(() => {
    if (!snapshotBody.path || !snapshotBody.name || !view.loaded) return
    writeOverviewSnapshot({ ...snapshotBody, savedAt: new Date().toISOString() })
  }, [snapshotBody, view.loaded])

  return {
    totalWords: stats.totalWords,
    draftedChapters: stats.draftedChapters,
    finalizedChapters: stats.finalizedChapters,
    plannedChapters,
    blueprintChapters,
    focus,
    stages,
    threadsPending,
    characters,
    lede,
    genres,
    loading: Boolean(currentProject) && !view.loaded,
  }
}

/* ==========================================================================
 * 卡片书名的自适应字号
 * ======================================================================== */

/**
 * demo 的书名是 52px，但那是给「天女伏魔录」这种五个字定的；先生的书名可以有
 * 十几个字（「这个奇奇怪怪超能力的世界快点完蛋吧！」），52px 会把
 * 「书名 + 题材」这一行挤爆、题材被顶到第二排。
 *
 * 这里按可用宽度反算字号，让第一排永远是「书名 + 题材」一行；
 * 缩到 18px 仍放不下的超长书名，交给 CSS 的 ellipsis 兜底。
 */
export function currentTitleFontSize(title: string, genreChars = 0): number {
  // 卡片内容宽 = 1100(max-width) − 46×2(书架内边距) − 34×2(卡片内边距)
  const cardContentWidth = 940
  const genreGap = 18
  const genreWidth = genreChars > 0 ? Math.min(260, genreChars * 13) : 0
  const usable = Math.max(240, cardContentWidth - genreWidth - genreGap)
  const chars = Math.max(1, [...title].length)
  return Math.max(18, Math.min(52, usable / chars))
}

/* ==========================================================================
 * 书架上的「进度预览」快照
 *
 * 先生要的交互：点书架里的一本书，上方卡片就显示**那本书**的进度。
 * 产品是单项目架构（同一时刻只打开一个项目库），跨项目实时统计需要新的只读
 * IPC；而书架里的书本来就是「打开过的项目」——所以这里在**打开项目时**
 * 把它的统计快照落到 localStorage，点击书时瞬间读出来，不必等数据库。
 * 快照只是展示用的缓存，任何时候都不会被当成业务真相写回去。
 * ======================================================================== */

const SNAPSHOT_PREFIX = 'vela:overview:'

export interface OverviewSnapshot {
  path: string
  name: string
  savedAt: string
  totalWords: number | null
  finalizedChapters: number
  draftedChapters: number
  plannedChapters: number | null
  blueprintChapters: number | null
  genres: string[]
  lede: string
  focus: ProjectFocus | null
  stages: ProjectOverviewStage[]
  threadsPending: number | null
  characters: number
}

export function writeOverviewSnapshot(snapshot: OverviewSnapshot): void {
  try {
    localStorage.setItem(`${SNAPSHOT_PREFIX}${snapshot.path}`, JSON.stringify(snapshot))
  } catch {
    // 隐私模式或配额用满：预览功能降级，不影响正事
  }
}

export function readOverviewSnapshot(projectPath: string): OverviewSnapshot | null {
  try {
    const raw = localStorage.getItem(`${SNAPSHOT_PREFIX}${projectPath}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as OverviewSnapshot
    return parsed?.path === projectPath ? parsed : null
  } catch {
    return null
  }
}

/* ==========================================================================
 * 书架「点击即读取」—— 直接去读那本书自己的库
 *
 * 快照只能覆盖「本机打开过」的书，而且它终究是缓存。要让「点哪本书就显示哪本书」
 * 真的成立，就得去读那本书自己的库：主进程短开一个只读连接，把卡片要的字段
 * 一次性聚合回来（见 electron/services/project-peek.ts）。
 * 一次点击 = 一次 IPC，不常驻、不轮询。
 * ======================================================================== */

export type ProjectPeekState = 'idle' | 'loading' | 'ready' | 'unavailable'

export interface ProjectPeekResult {
  state: ProjectPeekState
  data: ProjectPeekOverview | null
}

/**
 * 按路径读取另一个项目的资料。
 *
 * 状态按「请求键」派生，而不是在 effect 里同步 setState：键对不上就说明还没回来
 * （loading）。这样既不触发级联渲染告警，换一本书时上一本的资料也不会漏过来。
 */
export function useProjectPeek(projectPath: string | null): ProjectPeekResult {
  const [result, setResult] = useState<{ key: string; data: ProjectPeekOverview | null }>({
    key: '',
    data: null,
  })

  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    void ipc.invoke('project:peek-overview', projectPath)
      .then((data) => {
        if (!cancelled) setResult({ key: projectPath, data: data ?? null })
      })
      .catch(() => {
        if (!cancelled) setResult({ key: projectPath, data: null })
      })
    return () => { cancelled = true }
  }, [projectPath])

  if (!projectPath) return { state: 'idle', data: null }
  if (result.key !== projectPath) return { state: 'loading', data: null }
  return { state: result.data ? 'ready' : 'unavailable', data: result.data }
}
