import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import type { DraftMeta } from '../../../services/draft-index'
import {
  deriveChapters, deriveStages, focusChapter, landingStage, type WorkFacts,
} from '../../../stores/navigation/stage-progress'
import { useLocaleStore } from '../../../stores/locale-store'
import StageSpine from '../StageSpine'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

/** 时间取数据库 datetime('now') 的写法；不给时按版本号排在同一天里。 */
const draft = (chapterNumber: number, version: number, status: DraftMeta['status'], createdAt = `2026-10-12 0${version}:00:00`, updatedAt = createdAt): DraftMeta => ({
  id: chapterNumber * 10 + version, chapterNumber, version, status, createdAt, updatedAt, source: 'write',
  filePath: `ai-novel://draft/${chapterNumber * 10 + version}`, fileName: `draft_v${version}.md`,
})

const READY_CONFIG: WorkFacts['config'] = { coreOutline: '雾钟每晚提前一刻响起。', genre: '悬疑', targetAudience: '成年读者', totalChapters: 12, wordsPerChapter: 3000 }
const ALL_ARCHITECTURE = { premise: true, characters: true, worldbuilding: true, synopsis: true }
const blueprints = (count: number) => Array.from({ length: count }, (_, index) => ({ chapterNumber: index + 1, title: `第${index + 1}章标题` }))

function facts(overrides: Partial<WorkFacts> = {}): WorkFacts {
  return { config: READY_CONFIG, architecture: ALL_ARCHITECTURE, blueprints: blueprints(12), drafts: {}, runningChapters: new Set(), ...overrides }
}

/** 写作中的作品：1、2 章定稿，3 章已审稿（草稿上有一份审稿，还有一份旧草稿归档），4 章已修稿，5 章草稿，6 章正在生成。 */
const WRITING = facts({
  drafts: {
    1: [draft(1, 1, 'finalized')],
    2: [draft(2, 2, 'finalized'), draft(2, 1, 'archived')],
    3: [draft(3, 2, 'draft'), draft(3, 1, 'archived')],
    4: [draft(4, 1, 'revised')],
    5: [draft(5, 1, 'draft')],
  },
  chapterFacts: { 32: { mergeable: [], stale: [], latestReview: { createdAt: '2026-10-12 03:00:00', cycleStatus: 'not-generated' }, lastMergedAt: null } },
  runningChapters: new Set([6]),
})

describe('四个阶段的状态由项目数据派生', () => {
  it('新作品：设定进行中并写明还差哪几项，其余三步未开始', () => {
    const stages = deriveStages(facts({
      config: { coreOutline: '', genre: '悬疑', targetAudience: '', totalChapters: 24, wordsPerChapter: 3000 },
      architecture: {}, blueprints: [],
    }))
    expect(stages.map(status => status.stage)).toEqual(['setup', 'architecture', 'blueprint', 'manuscript'])
    expect(stages[0]).toEqual({ stage: 'setup', missing: ['coreOutline', 'targetAudience'], progress: { state: 'active', ratio: 0.5 } })
    expect(stages.slice(1).map(status => status.progress)).toEqual([{ state: 'todo' }, { state: 'todo' }, { state: 'todo' }])
    expect(landingStage(stages)).toBe('setup')
  })

  it('篇幅缺章数或每章字数也算设定未齐', () => {
    const [setup] = deriveStages(facts({ config: { ...READY_CONFIG, wordsPerChapter: 0 } }))
    expect(setup).toMatchObject({ missing: ['length'], progress: { state: 'active', ratio: 0.75 } })
  })

  it('架构按已有内容的节数计进度；蓝图按 ia.md 至少 1 章即完成', () => {
    const stages = deriveStages(facts({ architecture: { premise: true, characters: true }, blueprints: blueprints(3) }))
    expect(stages[0].progress).toEqual({ state: 'done' })
    expect(stages[1]).toMatchObject({ filled: 2, total: 4, progress: { state: 'active', ratio: 0.5 } })
    expect(stages[2]).toMatchObject({ planned: 3, total: 12, progress: { state: 'done' } })
    expect(stages[3].progress).toEqual({ state: 'todo' })
    // 用户决定 B（#394 §6）：已有蓝图时架构没写完不拉回架构，落点跳到下一个未完成的阶段。
    expect(landingStage(stages)).toBe('manuscript')
    expect(landingStage(deriveStages(facts({ architecture: { premise: true, characters: true }, blueprints: [] })))).toBe('architecture')
    // 已有正文就落在写作位置：没有蓝图（大纲没写完或已写完）也不落到空的蓝图页。
    const written = { blueprints: [], drafts: { 1: [draft(1, 1, 'finalized')] } }
    expect(landingStage(deriveStages(facts({ ...written, architecture: { premise: true, characters: true } })))).toBe('manuscript')
    expect(landingStage(deriveStages(facts(written)))).toBe('manuscript')
    expect(deriveStages(facts({ blueprints: [] }))[2].progress).toEqual({ state: 'todo' })
  })

  it('分批规划的作品（100 章规划了 20 章）写到第 5 章时，蓝图已完成，落点是正文', () => {
    const partial = facts({ config: { ...READY_CONFIG, totalChapters: 100 }, blueprints: blueprints(20),
      drafts: { 1: [draft(1, 1, 'finalized')], 5: [draft(5, 1, 'draft')] } })
    const stages = deriveStages(partial)
    expect(stages[2]).toMatchObject({ planned: 20, total: 100, progress: { state: 'done' } })
    expect(stages[3]).toMatchObject({ finalized: 1, total: 100, progress: { state: 'active', ratio: 0.01 } })
    expect(landingStage(stages)).toBe('manuscript')
    expect(focusChapter(deriveChapters(partial))?.number).toBe(5)
  })

  it('定稿之后又有更新的未归档草稿（版本历史回退）：按草稿显示、打开这份草稿、不计入定稿；定稿之前的旧草稿不影响', () => {
    const reverted = facts({ drafts: {
      1: [draft(1, 3, 'draft'), draft(1, 2, 'finalized'), draft(1, 1, 'draft')],
      2: [draft(2, 2, 'finalized'), draft(2, 1, 'reviewed')],
    } })
    const rows = deriveChapters(reverted)
    expect([rows[0].phase, rows[0].draft?.version, rows[1].phase, rows[1].draft?.version]).toEqual(['draft', 3, 'final', 2])
    expect(deriveStages(reverted)[3]).toMatchObject({ finalized: 1 })
    expect(focusChapter(rows)?.number).toBe(1)
  })

  it('三稿里给较旧的第 2 稿定稿：定稿前就有的第 3 稿不算定稿后的草稿，整章仍是定稿；定稿后才建的稿才算', () => {
    const olderFinalized = facts({ drafts: {
      1: [draft(1, 3, 'draft', '2026-10-12 03:00:00'), draft(1, 2, 'finalized', '2026-10-12 02:00:00', '2026-10-12 05:00:00'), draft(1, 1, 'draft')],
      2: [draft(2, 4, 'draft', '2026-10-12 06:00:00'), draft(2, 3, 'reviewed', '2026-10-12 03:00:00'), draft(2, 2, 'finalized', '2026-10-12 02:00:00', '2026-10-12 05:00:00')],
    } })
    const rows = deriveChapters(olderFinalized)
    expect([rows[0].phase, rows[0].draft?.version, rows[1].phase, rows[1].draft?.version]).toEqual(['final', 2, 'draft', 4])
    expect(deriveStages(olderFinalized)[3]).toMatchObject({ finalized: 1 })
  })

  it('开始写作后正文按定稿比例进行中；全部定稿后四步都完成', () => {
    const writing = deriveStages(WRITING)
    expect(writing.map(status => status.progress.state)).toEqual(['done', 'done', 'done', 'active'])
    expect(writing[3]).toMatchObject({ finalized: 2, total: 12, progress: { ratio: 2 / 12 } })
    expect(landingStage(writing)).toBe('manuscript')

    const done = deriveStages(facts({ drafts: Object.fromEntries(blueprints(12).map(({ chapterNumber }) => [chapterNumber, [draft(chapterNumber, 1, 'finalized')]])) }))
    expect(done.map(status => status.progress.state)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('章节状态来自草稿与定稿：定稿优先，其余取最新的未归档稿，正在生成的章另外标出', () => {
    const rows = deriveChapters(WRITING)
    expect(rows.slice(0, 7).map(row => [row.number, row.phase, row.running])).toEqual([
      [1, 'final', false], [2, 'final', false], [3, 'reviewed', false], [4, 'revised', false], [5, 'draft', false], [6, 'todo', true], [7, 'todo', false],
    ])
    expect(rows[2].draft?.version).toBe(2)
    expect(rows[1].draft?.status).toBe('finalized')
    // 用户决定（#407 第 2 轮）：几章都在写时落在最后一章在写的。
    expect(focusChapter(rows)?.number).toBe(5)
  })
})

describe('流程脊', () => {
  async function mount(location: Parameters<typeof StageSpine>[0]['location'], spy = vi.fn()) {
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    host.style.cssText = 'height: 860px; width: 1280px; display: flex;'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(
      <StageSpine
        stages={deriveStages(WRITING)}
        chapters={deriveChapters(WRITING)}
        location={location}
        onStage={stage => spy('stage', stage)}
        onChapter={chapter => spy('chapter', chapter)}
        onResource={page => spy('resource', page)}
        onSettings={() => spy('settings')}
      />,
    ))
    return host
  }

  const stageRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[data-stage]')]

  it('四个阶段按 设定、架构、蓝图、正文 排列，各自显示状态，当前阶段标为当前页', async () => {
    const container = await mount({ kind: 'stage', stage: 'manuscript', chapter: 3 })
    const rows = stageRows(container)
    expect(rows.map(row => row.querySelector('.stage-row-name')?.textContent)).toEqual(['设定', '架构', '蓝图', '正文'])
    expect(rows.map(row => row.dataset.state)).toEqual(['done', 'done', 'done', 'active'])
    expect(rows.map(row => row.querySelector('.stage-row-meta')?.textContent)).toEqual(['完成', '4 / 4', '12 章', '2 / 12 定稿'])
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual([null, null, null, 'page'])
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('创作流程')
    expect(rows[0].closest('ol')).not.toBeNull()
  })

  it('正文阶段展开章节列表：定稿章标为定稿，其余写出下一步，当前章标为当前页', async () => {
    const container = await mount({ kind: 'stage', stage: 'manuscript', chapter: 3 })
    const list = container.querySelector('[aria-label="章节"]')!
    const chapters = [...list.querySelectorAll<HTMLButtonElement>('button')]
    expect(chapters).toHaveLength(12)
    expect(chapters.slice(0, 6).map(row => [row.dataset.phase, row.textContent])).toEqual([
      ['final', '1第1章标题'], ['final', '2第2章标题'], ['reviewed', '3第3章标题待修稿'], ['revised', '4第4章标题待定稿'], ['draft', '5第5章标题待审稿'], ['todo', '6第6章标题生成中'],
    ])
    expect(chapters[0].querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('定稿')
    expect(chapters.map(row => row.getAttribute('aria-current'))).toEqual([null, null, 'page', ...Array(9).fill(null)])
  })

  it('蓝图已完成但没规划完时，说明写已规划与规划总章数', async () => {
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    const partial = facts({ config: { ...READY_CONFIG, totalChapters: 100 }, blueprints: blueprints(20) })
    await act(async () => root!.render(
      <StageSpine stages={deriveStages(partial)} chapters={deriveChapters(partial)} location={null}
        onStage={() => undefined} onChapter={() => undefined} onResource={() => undefined} onSettings={() => undefined} />,
    ))
    const blueprint = host.querySelector('[data-stage="blueprint"]')!
    expect([blueprint.getAttribute('data-state'), blueprint.querySelector('.stage-row-meta')?.textContent]).toEqual(['done', '20 / 100 章'])
  })

  it('没设规划章数时正文说明写已定稿章数，不写 0 / 0；没有章名的章用「第 N 章」', async () => {
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    document.body.append(host)
    root = createRoot(host)
    const unplanned = facts({ config: { ...READY_CONFIG, totalChapters: 0 }, blueprints: [], drafts: { 1: [draft(1, 1, 'finalized')], 2: [draft(2, 1, 'draft')] } })
    await act(async () => root!.render(
      <StageSpine stages={deriveStages(unplanned)} chapters={deriveChapters(unplanned)} location={{ kind: 'stage', stage: 'manuscript', chapter: 2 }}
        onStage={() => undefined} onChapter={() => undefined} onResource={() => undefined} onSettings={() => undefined} />,
    ))
    expect(host.querySelector('[data-stage="manuscript"] .stage-row-meta')?.textContent).toBe('1 章定稿')
    expect([...host.querySelectorAll('.stage-chapter-title')].map(node => node.textContent)).toEqual(['第 1 章', '第 2 章'])
  })

  it('不在正文阶段时不展开章节列表', async () => {
    const container = await mount({ kind: 'stage', stage: 'blueprint' })
    expect(container.querySelector('[aria-label="章节"]')).toBeNull()
    expect(stageRows(container).map(row => row.getAttribute('aria-current'))).toEqual([null, null, 'page', null])
  })

  it('Tab 到当前阶段行时焦点环叠在当前行的浮起阴影上', async () => {
    const container = await mount({ kind: 'stage', stage: 'blueprint' })
    await userEvent.tab()
    await userEvent.tab()
    await userEvent.tab()
    const current = stageRows(container)[2]
    expect(document.activeElement).toBe(current)
    expect(getComputedStyle(current).boxShadow).toMatch(/^rgb\(255, 254, 251\) 0px 0px 0px 2px, rgb\(44, 74, 140\) 0px 0px 0px 4px, /)
  })

  it('章节列表晚于当前章渲染时，当前章也滚进列表可视区', async () => {
    const many = facts({ config: { ...READY_CONFIG, totalChapters: 80 }, blueprints: blueprints(80) })
    const props = { stages: deriveStages(many), location: { kind: 'stage', stage: 'manuscript', chapter: 70 } as const,
      onStage: () => undefined, onChapter: () => undefined, onResource: () => undefined, onSettings: () => undefined }
    host = document.createElement('div')
    host.className = 'paper-ink stage-shell'
    host.style.cssText = 'height: 640px; width: 1280px;'
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<div className="stage-frame"><StageSpine {...props} chapters={[]} /></div>))
    await act(async () => root!.render(<div className="stage-frame"><StageSpine {...props} chapters={deriveChapters(many)} /></div>))
    const list = host.querySelector<HTMLElement>('[aria-label="章节"]')!
    const current = list.querySelector<HTMLElement>('[aria-current="page"]')!
    expect(current.textContent).toContain('第70章标题')
    const box = list.getBoundingClientRect()
    const rect = current.getBoundingClientRect()
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1).toBe(true)
  })

  it('英文界面里只规划了一章时写 1 chapter，不写 1 chapters', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    try {
      host = document.createElement('div')
      host.className = 'paper-ink stage-shell'
      document.body.append(host)
      root = createRoot(host)
      const meta = async (total: number) => {
        const one = facts({ config: { ...READY_CONFIG, totalChapters: total }, blueprints: blueprints(1) })
        await act(async () => root!.render(<StageSpine stages={deriveStages(one)} chapters={deriveChapters(one)} location={null}
          onStage={() => undefined} onChapter={() => undefined} onResource={() => undefined} onSettings={() => undefined} />))
        return host!.querySelector('[data-stage="blueprint"] .stage-row-meta')?.textContent
      }
      expect(await meta(1)).toBe('1 chapter')
      expect(await meta(0)).toBe('1 chapter')
    } finally {
      useLocaleStore.setState({ locale: 'zh-CN' })
    }
  })

  it('点击阶段、章节、作品资料与设置时，回调收到对应的去处', async () => {
    const spy = vi.fn()
    const container = await mount({ kind: 'stage', stage: 'manuscript', chapter: 3 }, spy)
    await act(async () => stageRows(container)[2].click())
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[aria-label="章节"] button')[3].click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-resource="knowledge"]')!.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '设置')!.click())
    expect(spy.mock.calls).toEqual([['stage', 'blueprint'], ['chapter', 4], ['resource', 'knowledge'], ['settings']])
  })
})
