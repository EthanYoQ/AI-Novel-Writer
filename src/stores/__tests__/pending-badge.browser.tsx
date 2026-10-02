/**
 * 「有新东西等着确认」的小红点 —— 未读水位的生命周期。
 *
 * 先生 2026-09-21：
 *   「有新的待确认的角色，候选，设定等内容的时候，可以在待确认、候选、待选等地方
 *     做个小红点？类似未读消息？让用户一看就知道这里有东西等着确认那种？」
 *
 * 本文件守四件事：
 *   ① 从没打开过、队列里有东西 → 亮（这正是「一看就知道」要的效果）；
 *   ② 打开过 → 灭；再来一条新的 → 又亮（只有「没见过」才算未读）；
 *   ③ 红点跨重启保留（localStorage），不能一重启就全又变成红的；
 *   ④ 换项目是另一套红点，localStorage 读坏了也只降级成「多亮一次」，绝不白屏。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  PENDING_BADGE_STORAGE_KEY,
  createPendingBadgeStore,
  pendingBadgeKey,
  readStoredPendingBadges,
  usePendingUnread,
} from '../pending-badge-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_A = 'C:\\novels\\project-a'
const PROJECT_B = 'C:\\novels\\project-b'

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  localStorage.removeItem(PENDING_BADGE_STORAGE_KEY)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = null
  container = null
  localStorage.removeItem(PENDING_BADGE_STORAGE_KEY)
})

/** 探针组件：把 hook 的两个出口都摆到 DOM 上，测试直接读它们。 */
function Probe({
  projectKey,
  queue,
  ids,
}: {
  projectKey: string
  queue: Parameters<typeof usePendingUnread>[1]
  ids: string[]
}) {
  const { unread, markSeen } = usePendingUnread(projectKey, queue, ids)
  return (
    <div>
      <span data-probe="state">{unread ? 'unread' : 'seen'}</span>
      <button type="button" onClick={markSeen}>mark</button>
    </div>
  )
}

async function mount(props: { projectKey: string; queue: Parameters<typeof usePendingUnread>[1]; ids: string[] }) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => root!.render(<Probe {...props} />))
}

function state(): string {
  return container?.querySelector('[data-probe="state"]')?.textContent ?? ''
}

async function clickMark(): Promise<void> {
  await act(async () => {
    container?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('待确认小红点的未读水位', () => {
  it('从没打开过、队列里有东西 → 亮', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1', '2'] })
    expect(state(), '作者还没见过这两条，红点必须亮').toBe('unread')
  })

  it('队列空着 → 不亮（空盒子不该冒红点）', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: [] })
    expect(state()).toBe('seen')
  })

  it('打开过就灭；再来一条新的 → 又亮', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1', '2'] })
    expect(state()).toBe('unread')

    await clickMark()
    expect(state(), '作者点开看过了，红点该灭').toBe('seen')

    // 定稿又提了一条新的（id 3）：只有它算未读
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1', '2', '3'] })
    expect(state(), '有新的一条就该重新亮').toBe('unread')

    await clickMark()
    expect(state()).toBe('seen')
  })

  it('处理掉旧条目不会把红点重新点亮', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1', '2'] })
    await clickMark()

    // 采纳掉 1，队列剩 [2]：它见过，红点不该回来
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['2'] })
    expect(state()).toBe('seen')
  })

  it('换项目是另一套红点（同一队列名互不串味）', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'sticky-tray', ids: ['a'] })
    await clickMark()
    expect(state()).toBe('seen')

    await mount({ projectKey: PROJECT_B, queue: 'sticky-tray', ids: ['a'] })
    expect(state(), '另一本书的待选箱从没打开过，该亮').toBe('unread')
  })

  it('不同队列各记一份（角色待确认亮了不代表待选箱也亮）', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1'] })
    await clickMark()

    await mount({ projectKey: PROJECT_A, queue: 'sticky-tray', ids: ['x'] })
    expect(state(), '待选箱是另一个队列，没打开过就该亮').toBe('unread')
  })

  it('水位写进 localStorage：重启应用后红点不会又全亮起来', async () => {
    await mount({ projectKey: PROJECT_A, queue: 'character-candidates', ids: ['1', '2'] })
    await clickMark()

    const raw = localStorage.getItem(PENDING_BADGE_STORAGE_KEY)
    expect(raw, '记号必须落盘').toBeTruthy()
    const stored = readStoredPendingBadges()
    expect(stored[pendingBadgeKey(PROJECT_A, 'character-candidates')]).toEqual(['1', '2'])

    // 模拟「重启」：用落盘的内容新建一个 store，再来一次同样的队列
    const revived = createPendingBadgeStore(readStoredPendingBadges())
    const seen = revived.getState().seen[pendingBadgeKey(PROJECT_A, 'character-candidates')]
    expect(seen, '重启后仍认得这两条是见过的').toEqual(['1', '2'])
  })

  it('localStorage 读坏了只降级成「没读过」，绝不抛错', () => {
    localStorage.setItem(PENDING_BADGE_STORAGE_KEY, '{不是 JSON')
    expect(readStoredPendingBadges()).toEqual({})

    localStorage.setItem(PENDING_BADGE_STORAGE_KEY, JSON.stringify({ [pendingBadgeKey(PROJECT_A, 'sticky-tray')]: 'not-an-array' }))
    expect(readStoredPendingBadges(), '值不是数组就整条丢掉').toEqual({})

    // zustand persist 外形也认
    localStorage.setItem(
      PENDING_BADGE_STORAGE_KEY,
      JSON.stringify({ state: { seen: { [pendingBadgeKey(PROJECT_A, 'sticky-tray')]: ['a'] } } }),
    )
    expect(readStoredPendingBadges()).toEqual({ [pendingBadgeKey(PROJECT_A, 'sticky-tray')]: ['a'] })
  })

  it('项目移除时能单独清掉它的水位', () => {
    const store = createPendingBadgeStore({})
    store.getState().markSeen(PROJECT_A, 'sticky-tray', ['a'])
    store.getState().markSeen(PROJECT_B, 'sticky-tray', ['b'])

    store.getState().forgetProject(PROJECT_A)

    expect(store.getState().seen[pendingBadgeKey(PROJECT_A, 'sticky-tray')]).toBeUndefined()
    expect(store.getState().seen[pendingBadgeKey(PROJECT_B, 'sticky-tray')]).toEqual(['b'])
  })
})
