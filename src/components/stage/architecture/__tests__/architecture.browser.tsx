import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { renderSynopsisDbText, synopsisFactsFingerprint } from '../../../../shared/plot-outline-checkpoint'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../../../shared/plot-outline-contract'
import { EMPTY_CARD, useCharacterStore } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageArchitecture from '../StageArchitecture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const PREMISE = '收到匿名信的林舟登上一座本该拆除的车站的末班车，发现每盏阅读灯都对应一个失踪者。'.repeat(2)

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let core: Record<string, unknown>
let partial: Record<string, unknown> | null
let rosterStatus: 'empty' | 'ready'
let recoveryContext: Record<string, unknown> | null
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const primary = () => host!.querySelector('.arch-header .pi-btn--primary')?.textContent
/** 启动的工作流只含勾选的那几节，步骤 key 就是实际交给后台的节。 */
let started: ReturnType<typeof vi.fn<(definition: { steps: { key: string }[] }) => Promise<string>>>
const launchedSteps = () => started.mock.calls.map(([definition]) => definition.steps.map(step => step.key))
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-update')

function filledSpine(filled: readonly string[]) {
  const architecture = Object.fromEntries(['premise', 'characters', 'worldbuilding', 'synopsis'].map(key => [key, filled.includes(key)]))
  useStageStore.setState({ work: { session, architecture, blueprints: [] } })
}

/** 按章写好的大纲正文，与主进程逐章生成的格式相同。 */
const outlineBody = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
  .map(n => `## 第${n}章：第${n}盏灯\n林舟在第${n}站认出一位失踪者的座位。`).join('\n\n')
const OUTLINE_SOURCE = { totalChapters: 24, writingLanguage: 'zh-CN' as const }

/** 已有第 1–16 章大纲（全书 24 章），分批检查点可用。 */
function seedPartialOutline() {
  const body = outlineBody(1, 16)
  core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 16, OUTLINE_SOURCE) }
  partial = {
    synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 16, synopsis_range: { from: 11, to: 16 },
    synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
  }
  filledSpine(['premise', 'synopsis'])
}
const mark = (step: string) => document.querySelector(`[data-step="${step}"] .arch-mark`)?.textContent
const stepChecked = (step: string) => document.querySelector<HTMLInputElement>(`[data-step="${step}"] input[type="checkbox"]`)?.checked
async function typeInto(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render() {
  await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading], .arch-page[data-cast-loading]')).toBeNull())
}

beforeEach(() => {
  core = { premise: PREMISE, worldbuilding: '', synopsis: '', totalChapters: 24, writingLanguage: 'zh-CN' }
  partial = null
  recoveryContext = null
  rosterStatus = 'empty'
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:project-core-get') return core
    if (channel === 'fs:read-json') return partial ? { success: true, data: partial } : { success: false, error: 'not found' }
    if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: rosterStatus, entries: [], renderedMarkdown: '林舟、沈砚', projectionHash: 'p', factHash: 'f' }
    if (channel === 'generation:list') return []
    if (channel === 'generation:read-context') return recoveryContext
    if (channel === 'generation:read-visible-composition') return null
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'db:project-core-update') {
      Object.assign(core, args[0] as Record<string, unknown>)
      return { success: true }
    }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: {
    id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车',
    novelConfig: { totalChapters: 24, wordsPerChapter: 3000, genre: '悬疑', targetAudience: '成人', coreOutline: '末班车', writingLanguage: 'zh-CN' },
  } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  started = vi.fn(async () => 'r1')
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [], startWorkflow: started as never })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useCharacterStore.setState({ characters: [{ ...EMPTY_CARD, characterId: 'c1', name: '林舟' }, { ...EMPTY_CARD, characterId: 'c2', name: '沈砚' }],
    dataProjectKey: session.projectPath, loadingProjectKey: null, lastError: null })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1100px; height: 900px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('架构阶段', () => {
  const LONG = '内容。'.repeat(30)
  it.each([
    { state: '一节都没有', premise: '', cast: false, world: '', outline: 'none', count: 0, action: 'AI 生成架构' },
    { state: '前提与角色名单', premise: PREMISE, cast: true, world: '', outline: 'none', count: 2, action: '继续生成架构' },
    { state: '缺情节大纲', premise: PREMISE, cast: true, world: LONG, outline: 'none', count: 3, action: '继续生成架构' },
    { state: '大纲只到第 16 章', premise: PREMISE, cast: true, world: LONG, outline: 'partial', count: 3, action: '继续生成架构' },
    { state: '四节齐全', premise: PREMISE, cast: true, world: LONG, outline: 'full', count: 4, action: '下一步：章节蓝图' },
  ])('主按钮与页头计数读四节徽标：$state', async ({ premise, cast, world, outline, count, action }) => {
    if (outline === 'partial') seedPartialOutline()
    core = { ...core, premise, worldbuilding: world, ...(outline === 'full' ? { synopsis: LONG } : {}) }
    rosterStatus = cast ? 'ready' : 'empty'
    await render()
    const ready = [...host!.querySelectorAll('.arch-badge')].filter(badge => badge.textContent === '已确认').length
    expect(ready).toBe(count)
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain(`${count} / 4 已确认`)
    expect(primary()).toBe(action)
    expect(host!.querySelectorAll('.arch-header .pi-btn--primary')).toHaveLength(1)
    const next = button('下一步：章节蓝图') as HTMLButtonElement
    expect(next.disabled).toBe(count < 4)
  })

  it('清空此节先出危险确认，取消后什么也不写、摘要不变；确认后才清空', async () => {
    filledSpine(['premise'])
    await render()
    const summary = () => host!.querySelector('[data-section="premise"] .arch-section-summary')?.textContent
    const before = summary()
    expect(before).toContain('收到匿名信的林舟')
    expect(host!.querySelector('[data-section="premise"] .arch-badge')?.textContent).toBe('已确认')
    expect(host!.querySelector('[data-section="characters"] .arch-section-summary')?.textContent).toBe('2 位角色：林舟、沈砚')

    await click('「故事前提」的更多操作')
    await click('清空此节…')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('清空「故事前提」？')
    expect(dialog?.textContent).toContain('无法撤销')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(writes()).toHaveLength(0)
    expect(summary()).toBe(before)

    await click('「故事前提」的更多操作')
    await click('清空此节…')
    await click('清空此节')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0][1]).toEqual({ premise: '' })
    await vi.waitFor(() => expect(host!.querySelector('[data-section="premise"] .arch-badge')?.textContent).toBe('待生成'))
  })

  it('角色名单保存后（修订号前进）重读名单状态，不触发修复；角色卡首次载入不多读一次', async () => {
    const rosterReads = () => invoke.mock.calls.filter(([channel]) => channel === 'db:character-roster-read').length
    await act(async () => useCharacterStore.setState({ rosterRevision: null }))
    await render()
    const afterOpen = rosterReads()
    await act(async () => useCharacterStore.setState({ rosterRevision: 1 }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(rosterReads()).toBe(afterOpen)

    await act(async () => useCharacterStore.setState({ rosterRevision: 2 }))
    await vi.waitFor(() => expect(rosterReads()).toBe(afterOpen + 1))
    expect(invoke.mock.calls.some(([channel]) => channel === 'legacy-roster:read-source')).toBe(false)
    // 名单快照换了不必再读一遍另三节：打开时一轮，重读名单后也不加。
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-get')).toHaveLength(1)
    expect(started).not.toHaveBeenCalled()
  })

  it.each([
    { switch: '换成另一部作品', other: { projectId: '另一部', projectPath: 'C:/novels/other', leaseId: '另一次打开' } },
    { switch: '同一部作品被重新打开', other: { ...session, leaseId: '重新打开' } },
  ])('清空确认打开期间$switch，确认时什么也不写', async ({ other }) => {
    filledSpine(['premise'])
    await render()
    await click('「故事前提」的更多操作')
    await click('清空此节…')
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: other.projectId, path: other.projectPath, sessionLease: other.leaseId, name: '另一部', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
      setActiveProjectSessionContext(other)
    })
    if (document.querySelector('[role="dialog"]')) await click('清空此节')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(writes()).toHaveLength(0)
  })

  it('大纲分批停在第 16 章：提示条说明缺的章，续写只从第 17 章起追加', async () => {
    seedPartialOutline()
    await render()
    const outline = host!.querySelector('[data-section="synopsis"]')!
    expect(outline.querySelector('.arch-badge')?.textContent).toBe('部分完成 · 16 / 24 章')
    expect(outline.textContent).toContain('第 17–24 章还没有大纲')
    expect(outline.textContent).toContain('续写只追加缺少的章节')

    await click('续写第 17 章起')
    const from = document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的起始章"]')
    const to = document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的结束章"]')
    expect(from?.value).toBe('17')
    expect(Number(to?.value)).toBeGreaterThanOrEqual(17)
    expect(Number(to?.value)).toBeLessThanOrEqual(24)
    expect(mark('synopsis')).toBe('续写')
  })

  it.each([
    ['第 7 章请求前被拒', { kind: 'request', chapterNumber: 7, attempt: 'normal' }, [6]],
    // 最后一章生成完、候选已齐，正式保存时被来源检查拒绝：检查点仍记着本批未完成，同样只能重新生成。
    ['第 10 章生成完、正式保存被拒', { kind: 'complete' }, [6, 7, 8, 9, 10]],
  ] as const)('第 6–10 章那批途中改了模型（%s）、恢复稿写回被封锁：提示只能查看或复制并从第 6 章重新生成，按钮直接打开从第 6 章起的对话框', async (_case, cursor, completeChapters) => {
    const body = outlineBody(1, 5)
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 5, OUTLINE_SOURCE) }
    const handle = { projectId: session.projectId, epoch: '本次', rootActionId: '大纲动作', runId: '第二批' }
    const draft = outlineBody(6, completeChapters.at(-1)!)
    partial = { synopsis_result: draft, synopsis_incomplete: true, synopsis_generation_handle: handle }
    recoveryContext = { handle, plotOutline: { range: { from: 6, to: 10 }, cursor },
      plotOutlineRecovery: { draft, completeChapters, writeState: { kind: 'blocked', reason: 'source-changed' }, saved: null } }
    filledSpine(['premise', 'synopsis'])
    await render()
    const outline = host!.querySelector('[data-section="synopsis"]')!
    expect(outline.textContent).not.toContain('续写从停下的地方')
    expect(outline.textContent).toContain('只能查看或复制。请从第 6 章重新生成情节大纲')
    const restart = [...outline.querySelectorAll('button')].find(item => item.textContent === '从第 6 章重新生成')
    expect(restart?.className).toContain('pi-btn--secondary')
    expect([...outline.querySelectorAll('button')].find(item => item.textContent === '查看恢复稿')?.className).toContain('pi-btn--text')
    expect(button('编辑恢复稿')).toBeUndefined()

    await act(async () => restart!.click())
    expect(document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的起始章"]')?.value).toBe('6')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的结束章"]')?.value).toBe('10')
    expect(stepChecked('synopsis')).toBe(true)
    expect(stepChecked('worldbuilding')).toBe(false)
  })

  it.each([
    ['检查点缺失', () => {
      core = { ...core, synopsis: renderSynopsisDbText(outlineBody(1, 16), 'zh-CN', 24, { synopsis_incomplete: true }) }
      partial = null
    }],
    ['末尾多一个换行', () => {
      seedPartialOutline()
      core = { ...core, synopsis: `${core.synopsis as string}\n` }
    }],
  ])('大纲带分批尾标但%s、接不上续写：不算已确认，页头 3 / 4，下一步不可点', async (_case, seed) => {
    seed()
    core = { ...core, worldbuilding: '世界观。'.repeat(30) }
    rosterStatus = 'ready'
    await render()
    const outline = host!.querySelector('[data-section="synopsis"]')!
    expect(outline.querySelector('.arch-badge')?.textContent).toBe('不完整')
    expect(outline.textContent).toContain('大纲末尾还留着分批生成的说明，但正文已和它对不上（可能手动改过）。')
    expect(host!.querySelector('.arch-progress')?.textContent).toBe(' · 3 / 4 已确认')
    expect(primary()).toBe('继续生成架构')
  })

  it('续写入口只预选情节大纲：先在别的节打开「AI 重新生成此节」再取消，不会把那一节带进续写', async () => {
    seedPartialOutline()
    await render()
    await click('「故事前提」的更多操作')
    await click('AI 重新生成此节…')
    expect(stepChecked('premise')).toBe(true)
    await click('取消')
    await vi.waitFor(() => expect(document.querySelector('[data-step="premise"]')).toBeNull())
    await click('继续生成架构')
    expect(stepChecked('premise')).toBe(false)
    await click('取消')
    await vi.waitFor(() => expect(document.querySelector('[data-step="premise"]')).toBeNull())

    await click('续写第 17 章起')
    expect(stepChecked('premise')).toBe(false)
    expect(mark('premise')).toBe('保留')
    await click(/开始生成 \d 项/)
    await vi.waitFor(() => expect(launchedSteps()).toEqual([['synopsis']]))
  })

  const submit = () => button(/开始生成 \d 项/) as HTMLButtonElement
  const issue = () => document.querySelector('.arch-range-issue')?.textContent ?? null
  const effect = () => document.querySelector('.arch-range-effect')?.textContent ?? null
  const inputValue = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value
  async function range(from: number, to: number) {
    await typeInto('本次生成范围的起始章', String(from))
    await typeInto('本次生成范围的结束章', String(to))
  }
  async function openOutlineRegenerate() {
    await click('「情节大纲」的更多操作')
    await click('AI 重新生成此节…')
  }

  it('大纲范围按主进程开跑时的同一判定：起始章不超过已有章节是覆盖该范围、其余保留，紧接已有章节是续写，只有跳章无效', async () => {
    seedPartialOutline()
    await render()
    await openOutlineRegenerate()
    expect(inputValue('本次生成范围的起始章')).toBe('17')

    await range(1, 5)
    expect(mark('synopsis')).toBe('将覆盖第 1–5 章')
    expect(effect()).toBe('第 1–5 章按本次结果替换，第 6–16 章原样保留。')
    expect(issue()).toBeNull()
    expect(submit().disabled).toBe(false)

    await range(1, 10)
    expect(mark('synopsis')).toBe('将覆盖第 1–10 章')
    expect(submit().disabled).toBe(false)

    await range(10, 14)
    expect(mark('synopsis')).toBe('将覆盖第 10–14 章')
    expect(effect()).toBe('第 10–14 章按本次结果替换，第 1–9、15–16 章原样保留。')
    expect(submit().disabled).toBe(false)

    await range(17, 24)
    expect(mark('synopsis')).toBe('续写')
    expect(effect()).toBe('接在第 16 章之后写第 17–24 章，已有章节不动。')
    expect(submit().disabled).toBe(false)

    await range(20, 24)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toContain('请从第 17 章续写')
    expect(submit().disabled).toBe(true)
    await act(async () => submit().click())
    expect(started).not.toHaveBeenCalled()

    await range(1, 5)
    await act(async () => submit().click())
    await vi.waitFor(() => expect(launchedSteps()[0]).toContain('synopsis'))
  })

  it('超过单批上限或全书章数的范围在对话框里直接标无效，提交不可点', async () => {
    seedPartialOutline()
    await render()
    await openOutlineRegenerate()
    const limitIssue = '情节大纲范围无效。请选择第 1–24 章内连续的 1–10 章。'

    await range(1, 16)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toBe(limitIssue)
    expect(effect()).toBeNull()
    expect(submit().disabled).toBe(true)

    await range(17, 30)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toBe(limitIssue)
    expect(submit().disabled).toBe(true)

    await range(7, 16)
    expect(mark('synopsis')).toBe('将覆盖第 7–16 章')
    expect(issue()).toBeNull()
    expect(submit().disabled).toBe(false)
  })

  it('还没有大纲时把起始章改成 2：提示从第 1 章起，不说「已有大纲没有按章的标题」', async () => {
    await render()
    await click('继续生成架构')
    await range(2, 4)
    expect(issue()).toBe('还没有情节大纲，请从第 1 章起生成。')
    expect(submit().disabled).toBe(true)
  })

  it('大纲分批写满全书后仍可重写其中一段', async () => {
    const body = outlineBody(1, 24)
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 24, OUTLINE_SOURCE) }
    partial = {
      synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 24, synopsis_range: { from: 21, to: 24 },
      synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
    }
    await render()
    expect(host!.querySelector('[data-section="synopsis"] .arch-badge')?.textContent).toBe('已确认')
    await openOutlineRegenerate()
    expect(inputValue('本次生成范围的起始章')).toBe('1')
    await range(1, 5)
    expect(mark('synopsis')).toBe('将覆盖第 1–5 章')
    expect(effect()).toBe('第 1–5 章按本次结果替换，第 6–24 章原样保留。')
    expect(submit().disabled).toBe(false)
  })

  it('作者调过章节顺序的大纲（1、5、2、3、4）选第 3–5 章：判无效并说明章节没按章号排，不承诺其余章原样保留', async () => {
    const body = [1, 5, 2, 3, 4].map(n => outlineBody(n, n)).join('\n\n')
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 5, OUTLINE_SOURCE) }
    await render()
    await openOutlineRegenerate()
    await range(3, 5)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toBe('已有大纲的章节没有按章号顺序排列，按范围重写会打乱或丢掉其他章，后台会拒绝。请先把大纲里的章节按章号排好。')
    expect(effect()).toBeNull()
    expect(submit().disabled).toBe(true)
  })

  it('大纲里同一章出现两次（1、2、3、2）选第 4–5 章：说明重复的是第 2 章，而不是说没按章号排', async () => {
    const body = [1, 2, 3, 2].map(n => outlineBody(n, n)).join('\n\n')
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 3, OUTLINE_SOURCE) }
    await render()
    await openOutlineRegenerate()
    await range(4, 5)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toBe('已有大纲里第 2 章出现了不止一次，按范围重写会打乱或丢掉其他章，后台会拒绝。请先删掉或改正重复的那一章。')
    expect(submit().disabled).toBe(true)
  })

  const PROLOGUE = '## 第0章：序章\n守塔人听见第十三声钟。'

  it('只有序章的作品生成第 1–2 章后：徽标部分完成 2 / 24，续写从第 3 章起、序章不算缺章', async () => {
    const body = outlineBody(1, 2)
    core = { ...core, synopsis: renderPlotOutlineSynopsis(`${PROLOGUE}\n\n${body}`, 2, OUTLINE_SOURCE) }
    partial = {
      synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 2, synopsis_range: { from: 1, to: 2 },
      synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
    }
    filledSpine(['premise', 'synopsis'])
    await render()
    const outline = host!.querySelector('[data-section="synopsis"]')!
    expect(outline.querySelector('.arch-badge')?.textContent).toBe('部分完成 · 2 / 24 章')

    await click('续写第 3 章起')
    expect(inputValue('本次生成范围的起始章')).toBe('3')
    await range(3, 4)
    expect(mark('synopsis')).toBe('续写')
    expect(effect()).toBe('接在第 2 章之后写第 3–4 章，已有章节不动。')
    expect(issue()).toBeNull()
    await act(async () => submit().click())
    await vi.waitFor(() => expect(launchedSteps()).toEqual([['synopsis']]))
  })

  it.each([
    ['第 0 章出现两次（0、1、2、0）', [0, 1, 2, 0], '已有大纲里第 0 章出现了不止一次，按范围重写会打乱或丢掉其他章，后台会拒绝。请先删掉或改正重复的那一章。'],
    ['第 0 章不在最前（1、0、2）', [1, 0, 2], '已有大纲的章节没有按章号顺序排列，按范围重写会打乱或丢掉其他章，后台会拒绝。请先把大纲里的章节按章号排好。'],
  ])('%s选第 3–4 章：判无效并说明原因', async (_, order, expected) => {
    const body = order.map(n => n === 0 ? PROLOGUE : outlineBody(n, n)).join('\n\n')
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 2, OUTLINE_SOURCE) }
    await render()
    await openOutlineRegenerate()
    await range(3, 4)
    expect(mark('synopsis')).toBe('范围无效')
    expect(issue()).toBe(expected)
    expect(submit().disabled).toBe(true)
  })

  it('有一批被打断时，范围仍按数据库里的正式大纲判定，不看检查点的进度', async () => {
    seedPartialOutline()
    // 重写第 1–5 章的那一批被打断：检查点记的进度是开跑前的 0，正式大纲仍是第 1–16 章。
    partial = {
      synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: true, synopsis_covered_to: 0, synopsis_range: { from: 1, to: 5 },
      synopsis_generation_handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'run' },
    }
    await render()
    expect(host!.querySelector('[data-section="synopsis"] .arch-badge')?.textContent).toBe('不完整')
    await openOutlineRegenerate()
    expect(inputValue('本次生成范围的起始章')).toBe('17')
    await range(1, 5)
    expect(mark('synopsis')).toBe('将覆盖第 1–5 章')
    expect(submit().disabled).toBe(false)
    await range(17, 24)
    expect(mark('synopsis')).toBe('续写')
    expect(submit().disabled).toBe(false)
    await range(18, 24)
    expect(mark('synopsis')).toBe('范围无效')
    expect(submit().disabled).toBe(true)
  })

  it('只差分批没写完的大纲时，主按钮直接打开续批并能提交', async () => {
    seedPartialOutline()
    core = { ...core, worldbuilding: '世界观。'.repeat(30) }
    rosterStatus = 'ready'
    await render()
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain('3 / 4 已确认')
    await click('继续生成架构')
    expect(['premise', 'characters', 'worldbuilding', 'synopsis'].map(stepChecked)).toEqual([false, false, false, true])
    expect(inputValue('本次生成范围的起始章')).toBe('17')
    expect(inputValue('本次生成范围的结束章')).toBe('21')
    expect(document.querySelector('[data-step="synopsis"] .arch-step-status')?.textContent).toBe('不完整')
    expect(mark('synopsis')).toBe('续写')
    await act(async () => submit().click())
    await vi.waitFor(() => expect(launchedSteps()).toEqual([['synopsis']]))
  })

  it('生成架构对话框按新样式标出已确认的节是覆盖还是保留', async () => {
    core = { ...core, worldbuilding: '世界观。'.repeat(30) }
    filledSpine(['premise', 'worldbuilding'])
    await render()
    await click('继续生成架构')
    const mark = (step: string) => document.querySelector(`[data-step="${step}"] .arch-mark`)?.textContent
    expect(mark('premise')).toBe('保留')
    expect(mark('worldbuilding')).toBe('保留')
    expect(mark('characters')).toBe('新生成')
    expect(mark('synopsis')).toBe('新生成')
    const premise = document.querySelector<HTMLInputElement>('[data-step="premise"] input[type="checkbox"]')!
    await act(async () => premise.click())
    expect(mark('premise')).toBe('将覆盖')
    expect(button(/开始生成 3 项/)).toBeTruthy()

    const all = document.querySelector<HTMLInputElement>('.arch-step-all input[type="checkbox"]')!
    await act(async () => all.click())
    expect(['premise', 'characters', 'worldbuilding', 'synopsis'].map(stepChecked)).toEqual([true, true, true, true])
    expect(all.checked).toBe(true)
    await act(async () => all.click())
    expect(['premise', 'characters', 'worldbuilding', 'synopsis'].map(stepChecked)).toEqual([false, false, false, false])
    expect(all.checked).toBe(false)
    expect((button(/开始生成 0 项/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('第一次读到四节状态之前不显示各节的动作按钮，读到后按内容显示，之后刷新时不隐藏', async () => {
    filledSpine(['premise'])
    let release!: () => void
    let held!: Promise<void>
    const hold = () => { held = new Promise<void>(resolve => { release = resolve }) }
    hold()
    const answer = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'db:project-core-get') await held
      return answer(channel, ...args)
    })
    await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
    const shown = () => [...host!.querySelectorAll<HTMLElement>('[data-section="premise"] .arch-section-actions button')]
      .filter(action => action.checkVisibility({ visibilityProperty: true }))
      .map(action => action.textContent || action.getAttribute('aria-label'))
    expect(host!.querySelector('.arch-page[data-loading]')).not.toBeNull()
    expect(host!.querySelectorAll('[data-section="premise"] .arch-section-actions button').length).toBeGreaterThan(0)
    expect(shown()).toEqual([])

    await act(async () => release())
    await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading], .arch-page[data-cast-loading]')).toBeNull())
    expect(shown()).toEqual(['编辑', '「故事前提」的更多操作'])

    hold()
    await click('架构的更多操作')
    await click('刷新状态')
    await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading]')).not.toBeNull())
    expect(shown()).toEqual(['编辑', '「故事前提」的更多操作'])
    await act(async () => release())
    await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading]')).toBeNull())
  })

  it('四节状态读取失败时动作区照常显示并可聚焦，页头停在加载态、主按钮不可用', async () => {
    filledSpine(['premise', 'characters', 'worldbuilding', 'synopsis'])
    const answer = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'db:project-core-get') throw new Error('数据库读取失败')
      return answer(channel, ...args)
    })
    const rejected: unknown[] = []
    const record = (event: PromiseRejectionEvent) => { rejected.push(event.reason) }
    window.addEventListener('unhandledrejection', record)
    try {
      await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
      await vi.waitFor(() => expect(rejected.map(reason => (reason as Error).message)).toEqual(['数据库读取失败']))
    } finally {
      window.removeEventListener('unhandledrejection', record)
    }
    const shown = (section: string) => [...host!.querySelectorAll<HTMLElement>(`[data-section="${section}"] .arch-section-actions button`)]
      .filter(action => action.checkVisibility({ visibilityProperty: true }))
      .map(action => action.textContent || action.getAttribute('aria-label'))
    await vi.waitFor(() => expect(shown('premise')).toEqual(['自己写', 'AI 生成此节', '「故事前提」的更多操作']))
    expect(shown('characters')).toEqual(['打开角色名单', '「角色名单」的更多操作'])
    expect(host!.querySelector('.arch-page[data-loading]')).not.toBeNull()
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toBe('架构')
    expect(primary()).toBe('AI 生成架构')
    expect(host!.querySelector<HTMLButtonElement>('.arch-header .pi-btn--primary')!.disabled).toBe(true)
    const cast = button('打开角色名单') as HTMLButtonElement
    cast.focus()
    expect(document.activeElement).toBe(cast)
  })

  it('英文界面：大纲只生成到第 1 章停下时说 Chapter 1 stays as it is，不说 The first 1 chapter stay', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const body = outlineBody(1, 1)
    core = { ...core, synopsis: renderPlotOutlineSynopsis(body, 1, OUTLINE_SOURCE) }
    partial = {
      synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 1, synopsis_range: { from: 1, to: 1 },
      synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
    }
    filledSpine(['premise', 'synopsis'])
    await render()
    expect(host!.querySelector('[data-section="synopsis"] .pi-notice-text')?.textContent).toBe('Chapter 1 stays as it is; only missing chapters are added.')
  })

  it('英文界面里截断的摘要用英文省略号', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    core = { ...core, premise: 'A stranger mails Lin Zhou a train ticket dated 1998, and every night the fog bell rings a quarter hour early. '.repeat(2) }
    filledSpine(['premise'])
    await render()
    const summary = host!.querySelector('[data-section="premise"] .arch-section-summary')!.textContent!
    expect(summary.endsWith('…')).toBe(true)
    expect(summary).not.toContain('……')
  })

  it('分节摘要不带文档的 Markdown 标题行', async () => {
    core = { ...core, premise: `# 故事前提\n\n## 核心钩子\n\n${PREMISE}` }
    filledSpine(['premise'])
    await render()
    expect(host!.querySelector('[data-section="premise"] .arch-section-summary')?.textContent?.startsWith('收到匿名信的林舟')).toBe(true)
  })

  it('某节只写了不足 50 字：摘要显示这段内容、动作是编辑，徽标不算已确认；生成时标「将覆盖」而不是「新生成」', async () => {
    const SHORT = '末班车上，每盏阅读灯都对应一个失踪者。'
    core = { ...core, premise: '', worldbuilding: SHORT }
    await render()
    const world = host!.querySelector('[data-section="worldbuilding"]')!
    expect(world.querySelector('.arch-section-summary')?.textContent).toBe(SHORT)
    expect(world.textContent).not.toContain('还没有内容')
    expect(world.querySelector('.arch-badge')?.textContent).toBe('不完整')
    expect([...world.querySelectorAll('button')].map(node => node.textContent)).toContain('编辑')
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain('0 / 4 已确认')
    expect(host!.querySelector('[data-section="premise"] .arch-section-summary')?.textContent).toContain('还没有内容')

    await click('AI 生成架构')
    expect(stepChecked('worldbuilding')).toBe(true)
    expect(mark('worldbuilding')).toBe('将覆盖')
    expect(mark('premise')).toBe('新生成')
  })

  it('某节只有空白（超过 50 个字符）：与空节一样显示还没有内容、徽标待生成，不算已确认', async () => {
    core = { ...core, worldbuilding: ' \n'.repeat(40) }
    await render()
    const world = host!.querySelector('[data-section="worldbuilding"]')!
    expect(world.querySelector('.arch-section-summary')?.textContent).toContain('还没有内容')
    expect(world.querySelector('.arch-badge')?.textContent).toBe('待生成')
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain('1 / 4 已确认')
  })

  describe('只有序章的大纲（#417）', () => {
    const LONG_PROLOGUE = `## 第0章：序章
${'守塔人听见第十三声钟，灯塔在那一夜熄灭。'.repeat(4)}`

    it('徽标是待生成、不算已确认；默认从第 1 章起接在序章之后写，起始章选 2 时说明要从第 1 章开始', async () => {
      core = { ...core, synopsis: `# 情节大纲

${LONG_PROLOGUE}` }
      await render()
      const outline = host!.querySelector('[data-section="synopsis"]')!
      expect(outline.querySelector('.arch-badge')?.textContent).toBe('待生成')
      expect(outline.querySelector('.arch-section-summary')?.textContent).toContain('守塔人')
      expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain('1 / 4 已确认')

      await openOutlineRegenerate()
      expect(document.querySelector('[data-step="synopsis"] .arch-step-status')?.textContent).toBe('待生成')
      expect(inputValue('本次生成范围的起始章')).toBe('1')
      expect(mark('synopsis')).toBe('续写')
      expect(effect()).toBe('接在序章之后写第 1–5 章，序章不动。')
      await range(2, 3)
      expect(mark('synopsis')).toBe('范围无效')
      expect(issue()).toBe('已有大纲只有序章，不能跳到第 2 章开始。请从第 1 章起生成，序章会原样保留。')
      expect(issue()).not.toContain('1–0')
      expect(submit().disabled).toBe(true)
    })

    it('序章加第 1–5 章重写其中几章：覆盖说明写明序章原样保留', async () => {
      core = { ...core, synopsis: `# 情节大纲

${LONG_PROLOGUE}

${outlineBody(1, 5)}` }
      await render()
      await openOutlineRegenerate()
      await range(3, 5)
      expect(effect()).toBe('第 3–5 章按本次结果替换，序章与第 1–2 章原样保留。')
      await range(1, 2)
      expect(effect()).toBe('第 1–2 章按本次结果替换，序章与第 3–5 章原样保留。')
      await range(1, 5)
      expect(effect()).toBe('第 1–5 章按本次结果替换，序章原样保留。')
    })
  })
})
