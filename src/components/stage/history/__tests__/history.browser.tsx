import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { toast } from '../../../ui/Toast'
import { withReducedMotion } from '../../../ui/__tests__/reduced-motion'
import StageHistory from '../StageHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }

interface Draft { id: number; chapterNumber: number; version: number; status: string; content: string }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useEditorStore, useDraftStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let drafts: Draft[]
let readGate: Promise<void> | null
let listGates: Map<number, Promise<void>>
let beforeCreate: (() => void) | null
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const meta = (draft: Draft) => ({ id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status,
  wordCount: draft.content.length, createdAt: `2026-10-0${draft.version} 21:05:00`, dependenciesStale: false })

beforeEach(() => {
  drafts = [
    { id: 11, chapterNumber: 3, version: 1, status: 'draft', content: '雨从傍晚开始就没有停过。\n林舟攥着那封灰色的信。' },
    { id: 12, chapterNumber: 3, version: 2, status: 'draft', content: '雨从傍晚开始就没有停过。\n林舟攥着那封没有署名的信。\n他想起母亲说过的话。' },
  ]
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 3, title: '雨夜车站' }, { chapterNumber: 4, title: '第三节车厢' }]
    if (channel === 'db:draft-list') {
      await listGates.get(args[0] as number)
      return drafts.filter(draft => draft.chapterNumber === args[0]).map(meta)
    }
    if (channel === 'db:draft-get-full') {
      if (readGate) await readGate
      return drafts.find(draft => draft.id === args[0]) ?? null
    }
    if (channel === 'db:draft-get-latest') {
      const own = drafts.filter(draft => draft.chapterNumber === args[0]).sort((a, b) => b.version - a.version)
      return own[0] ? meta(own[0]) : null
    }
    if (channel === 'db:draft-next-version') return Math.max(0, ...drafts.filter(draft => draft.chapterNumber === args[0]).map(draft => draft.version)) + 1
    if (channel === 'db:draft-create') {
      // 与 DraftRepository.create 一致：版本号在事务里按现有最大版本加一分配，不用调用方传的值。
      const input = args[0] as { chapterNumber: number; content: string }
      beforeCreate?.()
      const id = 100 + drafts.length
      const version = Math.max(0, ...drafts.filter(draft => draft.chapterNumber === input.chapterNumber).map(draft => draft.version)) + 1
      drafts.push({ id, chapterNumber: input.chapterNumber, version, status: 'draft', content: input.content })
      return { success: true, id }
    }
    if (channel === 'db:draft-list-all') return drafts.map(meta)
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  readGate = null
  listGates = new Map()
  beforeCreate = null
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 800px; display: flex'
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

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string' ? candidate.textContent?.trim() === name : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const channels = () => invoke.mock.calls.map(([channel]) => channel)

async function openChapterThree() {
  await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
  await click(/雨夜车站/)
  await vi.waitFor(() => expect(button(/草稿 v1/)).toBeTruthy())
}

describe('版本历史', () => {
  it('对比是只读的差异视图：标出增删、没有可编辑的地方、不打开修稿合并', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    const diff = await vi.waitFor(() => {
      const article = host!.querySelector('article[aria-readonly="true"]')
      expect(article).toBeTruthy()
      return article!
    })
    expect([...diff.querySelectorAll('del')].map(node => node.textContent).join('')).toContain('灰色的')
    expect([...diff.querySelectorAll('ins')].map(node => node.textContent).join('')).toContain('没有署名的')
    expect(diff.textContent).toContain('他想起母亲说过的话。')
    expect(host!.textContent).toContain('只读对比')

    const column = host!.querySelector('[aria-label="对比"]')!
    expect(column.querySelector('textarea, input, [contenteditable="true"], .cm-editor')).toBeNull()
    expect(host!.textContent).not.toContain('完成合并')
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(channels().filter(channel => channel === 'db:draft-create' || channel === 'db:draft-update-status')).toHaveLength(0)
  })

  it('回退到 v1 先说明会新建 v3，确认后新建回滚草稿，v1、v2 都保留', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')

    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('回退到草稿 v1？')
    expect(dialog.textContent).toContain('新建一份草稿 v3')
    expect(dialog.textContent).toContain('现在的草稿 v2和所有历史版本都会保留')
    expect(channels()).not.toContain('db:draft-create')

    await click('新建回滚草稿')
    await vi.waitFor(() => expect(button(/草稿 v3/)).toBeTruthy())
    const created = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')![1] as { chapterNumber: number; version: number; content: string }
    expect(created).toMatchObject({ chapterNumber: 3, version: 3, content: drafts[0].content })
    const timeline = host!.querySelector('[aria-label="版本时间线"]')!
    expect([...timeline.querySelectorAll('.stage-hist-version-name')].map(node => node.firstChild?.textContent)).toEqual(['草稿 v3', '草稿 v2', '草稿 v1'])
    expect(timeline.querySelector('li:first-child')!.textContent).toContain('当前')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('回退成功的提示用数据库实际分配的版本号', async () => {
    const success = vi.spyOn(toast, 'success')
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('新建一份草稿 v3')
    // 估算出 v3 之后、新建之前，后台运行又给这一章写了一稿 v3。
    beforeCreate = () => { drafts.push({ id: 13, chapterNumber: 3, version: 3, status: 'draft', content: '后台写的一稿' }) }
    await click('新建回滚草稿')
    await vi.waitFor(() => expect(button(/草稿 v4/)).toBeTruthy())
    expect(success).toHaveBeenCalledWith('已新建草稿 v4，原有各稿都保留')
  })

  it('回退读旧稿时作品已重新打开，就不再新建稿', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    let release: () => void = () => {}
    readGate = new Promise(resolve => { release = resolve })
    await click('新建回滚草稿')
    const reopened = { ...session, leaseId: '再次打开' }
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: reopened.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
    setActiveProjectSessionContext(reopened)
    await act(async () => { release(); await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(channels()).not.toContain('db:draft-next-version')
    expect(channels()).not.toContain('db:draft-create')
  })

  it('还没有任何稿的章节标「未开始」', async () => {
    useDraftStore.setState({ draftsByChapter: { 3: [{ id: 11 }, { id: 12 }] } as never, dataProjectSession: session })
    await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(button(/第三节车厢/)).toBeTruthy())
    expect(button(/雨夜车站/)!.textContent).toContain('2 稿')
    expect(button(/第三节车厢/)!.textContent).toContain('未开始')
    expect(button(/第三节车厢/)!.hasAttribute('data-empty')).toBe(true)
  })

  it('取消回退不写入任何稿', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(channels()).not.toContain('db:draft-create')
  })

  it('当前稿没有回退按钮', async () => {
    await openChapterThree()
    await click(/草稿 v2/)
    await vi.waitFor(() => expect(host!.textContent).toContain('与当前稿相同'))
    expect(button('回退到此版本…')).toBeUndefined()
  })

  const versionsColumn = () => document.querySelector('.stage-hist-versions')!.textContent ?? ''
  const gateList = (chapter: number) => {
    let release = () => {}
    listGates.set(chapter, new Promise<void>(resolve => { release = resolve }))
    return () => release()
  }

  it('再点一次当前章：各稿列表留着，不变成「这一章还没有稿」', async () => {
    await openChapterThree()
    await click(/雨夜车站/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(versionsColumn()).not.toContain('这一章还没有稿')
    expect(button(/草稿 v1/)).toBeTruthy()
    expect(button(/草稿 v2/)).toBeTruthy()
  })

  it('换章时各稿读到之前显示正在读取，不闪「这一章还没有稿」', async () => {
    await openChapterThree()
    const release = gateList(4)
    await click(/第三节车厢/)
    expect(versionsColumn()).not.toContain('这一章还没有稿')
    await vi.waitFor(() => expect(versionsColumn()).toContain('正在读取…'), { timeout: 1000 })
    expect(versionsColumn()).not.toContain('这一章还没有稿')
    await act(async () => release())
    await vi.waitFor(() => expect(versionsColumn()).toContain('这一章还没有稿'))
  })

  /** 作者看得见的「正在读取」：在页面上且不透明。 */
  const loadingShown = () => {
    const loading = host!.querySelector<HTMLElement>('[aria-label="这一章的各稿"] [role="status"]')
    return loading !== null && getComputedStyle(loading).opacity !== '0'
  }

  it.each([
    { motion: '正常动画', reduced: false },
    { motion: '减弱动画', reduced: true },
  ])('换章时「正在读取」读得快的章不闪一下，读得慢才出现（$motion）', async ({ reduced }) => {
    const run = async () => {
      await openChapterThree()
      const release = gateList(4)
      await click(/第三节车厢/)
      const clicked = performance.now()
      expect(loadingShown()).toBe(false)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
      if (performance.now() - clicked < 140) expect(loadingShown()).toBe(false)
      await vi.waitFor(() => expect(loadingShown()).toBe(true), { timeout: 1000 })
      expect(versionsColumn()).toContain('正在读取…')
      await act(async () => release())
    }
    if (reduced) await withReducedMotion(run)
    else await run()
  })

  it('连续点两章：先点那章的各稿晚到，不显示在后点那章下面', async () => {
    await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
    const release = gateList(3)
    await click(/雨夜车站/)
    await click(/第三节车厢/)
    await vi.waitFor(() => expect(versionsColumn()).toContain('这一章还没有稿'))
    await act(async () => release())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(document.querySelector('.stage-hist-chapter-title')?.textContent).toBe('第三节车厢')
    expect(versionsColumn()).toContain('这一章还没有稿')
    expect(button(/草稿 v1/)).toBeUndefined()
  })

  it('各稿时间按数据库的 UTC 换成本地时间显示', async () => {
    await openChapterThree()
    const expected = new Date(Date.UTC(2026, 9, 1, 21, 5)).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    expect(button(/草稿 v1/)!.querySelector('.stage-hist-meta')?.textContent).toBe(`${drafts[0].content.length} 字 · ${expected}`)
  })

  it('正文为空的一稿也能对比，不停在正在读取', async () => {
    drafts[0].content = ''
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    expect(document.querySelector('.stage-hist-diff')!.textContent).not.toContain('正在读取…')
  })

  it('正文为空的旧稿也能回退：确认后新建一份空的 v3，对话框关上', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => undefined)
    drafts[0].content = ''
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    await click('新建回滚草稿')
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('已新建草稿 v3，原有各稿都保留'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:draft-create').map(([, input]) => input))
      .toEqual([{ chapterNumber: 3, version: 3, source: 'rewrite', content: '', wordCount: 0 }])
  })

  it('读取这一稿失败时提示作者，对比区不停在正在读取', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    await openChapterThree()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:draft-get-full' ? Promise.reject(new Error('数据库忙')) : base(channel, ...args))
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('读取这一稿失败：数据库忙'))
    expect(document.querySelector('.stage-hist-diff')!.textContent).toBe('选一稿，与当前稿逐字对比。')
  })

  it('页面还开着时当前作品换成了别的作品：再选一章不停在正在读取', async () => {
    await openChapterThree()
    const other = { projectId: '晴天', projectPath: 'C:/novels/sunny', leaseId: '另一次打开' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: other.projectId, path: other.projectPath, sessionLease: other.leaseId, name: '晴天', novelConfig: {} } as unknown as ProjectData })
      setActiveProjectSessionContext(other)
    })
    await click(/第三节车厢/)
    await act(async () => { await Promise.resolve() })
    expect(host!.querySelector('[aria-label="这一章的各稿"]')!.textContent).not.toContain('正在读取…')
  })

  const reopenSameBook = () => act(async () => {
    const reopened = { ...session, leaseId: '再次打开' }
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: reopened.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
    setActiveProjectSessionContext(reopened)
  })

  it('读各稿时同一部作品被重新打开：读完不停在正在读取，按这次打开列出各稿', async () => {
    await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
    const release = gateList(3)
    await click(/雨夜车站/)
    await reopenSameBook()
    await act(async () => release())
    await vi.waitFor(() => expect([...document.querySelectorAll('.stage-hist-version-name')].map(node => node.firstChild?.textContent)).toEqual(['草稿 v2', '草稿 v1']))
    expect(versionsColumn()).not.toContain('正在读取…')
  })

  it('读各稿失败：只说这次没读出来、可以重新读取，不担保稿没有丢，不说这一章还没有稿；点「重新读取」读到就列出各稿', async () => {
    await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:draft-list' ? Promise.reject(new Error('数据库忙')) : base(channel, ...args))
    await click(/雨夜车站/)
    await vi.waitFor(() => expect(versionsColumn()).toContain('没能读出这一章的各稿'))
    expect(versionsColumn()).toContain('这次没读出来，可以重新读取。')
    expect(versionsColumn()).not.toContain('没有丢')
    expect(versionsColumn()).not.toContain('这一章还没有稿')
    expect(versionsColumn()).not.toContain('数据库忙')

    invoke.mockImplementation(base)
    await click('重新读取')
    await vi.waitFor(() => expect(button(/草稿 v1/)).toBeTruthy())
    expect(versionsColumn()).not.toContain('没能读出这一章的各稿')
  })

  it('点的那一稿已被删掉（列表还没刷新）：对比区说明这一稿已不存在，并刷新列表去掉它，不停在正在读取', async () => {
    await openChapterThree()
    drafts = drafts.filter(draft => draft.id !== 11)
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(document.querySelector('.stage-hist-diff')!.textContent).toBe('这一稿已不存在，可能已被删除。列表已刷新。'))
    await vi.waitFor(() => expect(button(/草稿 v1/)).toBeUndefined())
    expect(button(/草稿 v2/)).toBeTruthy()

    await click(/草稿 v2/)
    await vi.waitFor(() => expect(document.querySelector('.stage-hist-diff')!.textContent).toContain('与当前稿相同'))
  })

  it('当前稿查到了却读不出正文（刚被删掉）：说这一章还没有当前稿，不当成空正文对比', async () => {
    await openChapterThree()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:draft-get-full' && args[0] === 12 ? null : base(channel, ...args))
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    const column = document.querySelector('.stage-hist-diff')!
    expect(column.querySelector('article[aria-readonly="true"]')?.textContent ?? null).toBeNull()
    expect(column.querySelector('.stage-hist-help')?.textContent).toBe('这一章还没有当前稿。')
  })

  it.each([
    ['zh-CN', { success: false }, '回退失败：没有新建回滚草稿'],
    ['en-US', { success: false }, 'Could not revert: the rollback draft was not created'],
    ['zh-CN', new Error('数据库只读'), '回退失败：数据库只读'],
  ] as const)('%s 下新建回滚草稿失败（%o）：提示与界面语言一致，只写原因，不带 Error 前缀', async (locale, outcome, message) => {
    useLocaleStore.setState({ locale })
    const errors = vi.spyOn(toast, 'error').mockImplementation(() => undefined)
    await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
    await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
    await click(/雨夜车站/)
    await vi.waitFor(() => expect(button(/ v1/)).toBeTruthy())
    await click(/ v1/)
    const revert = locale === 'zh-CN' ? '回退到此版本…' : 'Revert to this version…'
    await vi.waitFor(() => expect(button(revert)).toBeTruthy())
    await click(revert)
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel !== 'db:draft-create') return base(channel, ...args)
      if (outcome instanceof Error) throw outcome
      return outcome
    })
    await click(locale === 'zh-CN' ? '新建回滚草稿' : 'Create rollback draft')
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(message))
    expect(drafts).toHaveLength(2)
  })

  it('回退已新建草稿但随后重读列表失败：照样关掉对话框并说已新建，不会让作者再点一次多建一稿', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => undefined)
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    const base = invoke.getMockImplementation()!
    beforeCreate = () => {
      invoke.mockImplementation(async (channel, ...args) => channel === 'db:draft-list' ? Promise.reject(new Error('数据库忙')) : base(channel, ...args))
    }
    await click('新建回滚草稿')
    await vi.waitFor(() => expect(success).toHaveBeenCalledWith('已新建回滚草稿，原有各稿都保留'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:draft-create')).toHaveLength(1)
  })
})
