/**
 * 栏目开篇页的状态机契约。
 *
 * 两个容易写错、且写错了只在「连点栏目」时才暴露的点：
 *   · 连点两栏必须能覆盖第一次的过场（token 递增）
 *   · 第一次的定时器回来时，不得把第二次的过场关掉（close 认 token）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createMagOpenerStore } from '../mag-opener-store'

describe('栏目开篇页状态', () => {
  let store: ReturnType<typeof createMagOpenerStore>

  beforeEach(() => {
    store = createMagOpenerStore()
  })

  it('初始没有过场', () => {
    expect(store.getState().opening).toBeNull()
  })

  it('触发后带着栏目键与 token 进入「正在播」', () => {
    store.getState().open('characters')
    expect(store.getState().opening).toEqual({ key: 'characters', token: 1 })
  })

  it('连点两栏：token 递增，第二次覆盖第一次', () => {
    store.getState().open('characters')
    store.getState().open('world')
    expect(store.getState().opening).toEqual({ key: 'world', token: 2 })
  })

  it('过期的定时器关不掉新的过场', () => {
    store.getState().open('characters')
    store.getState().open('world')
    // 第一次触发的定时器此刻才回来
    store.getState().close(1)
    expect(store.getState().opening).toEqual({ key: 'world', token: 2 })
  })

  it('相符的定时器把过场摘掉', () => {
    store.getState().open('blueprint')
    store.getState().close(1)
    expect(store.getState().opening).toBeNull()
  })

  it('重复关闭不会抛错（无过场时收到迟到的 close）', () => {
    expect(() => store.getState().close(3)).not.toThrow()
    expect(store.getState().opening).toBeNull()
  })
})
