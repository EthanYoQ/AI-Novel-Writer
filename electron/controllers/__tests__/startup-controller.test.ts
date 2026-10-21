import { beforeEach, describe, expect, it } from 'vitest'
import { registerStartupController, type StartupEvent, type StartupSender } from '../startup-controller'
import { APPEARANCE_STORAGE_KEY } from '../../../src/shared/appearance-profile'

let handlers: Map<string, (event: StartupEvent, input?: unknown) => unknown>
let sender: StartupSender
let event: StartupEvent
let generation: string | null
let blocked: 'GLOBAL_DATA_BLOCKED' | undefined
const ack = (profileRevision = 1) => ({ storageKey: APPEARANCE_STORAGE_KEY, profileRevision, globalGeneration: '世代甲' })
beforeEach(() => {
  handlers = new Map()
  sender = { id: 1, mainFrame: { url: 'file:///isolated/index.html' }, isDestroyed: () => false }
  event = { sender, senderFrame: sender.mainFrame }
  generation = '世代甲'
  blocked = undefined
  registerStartupController({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    getTrustedSender: () => sender, rendererUrl: 'file:///isolated/index.html',
    getGlobalGeneration: () => generation, getBlockedCode: () => blocked })
})
const invoke = (channel: string, input?: unknown, from = event) => handlers.get(channel)!(from, input)

describe('真实启动来源与外观确认边界', () => {
  it('全局数据就绪才发布 ready，ready 里只有全局世代', () => {
    expect(invoke('startup:get-state')).toEqual({ state: 'ready', globalGeneration: '世代甲' })
    generation = null
    expect(invoke('startup:get-state')).toEqual({ state: 'pending' })
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    blocked = 'GLOBAL_DATA_BLOCKED'
    expect(invoke('startup:get-state')).toEqual({ state: 'blocked', code: 'GLOBAL_DATA_BLOCKED' })
  })
  it('窗口确认过外观后，ready 带上这个窗口已确认的修订号，供重载后的重置写得更大', () => {
    expect(invoke('startup:appearance-ack', ack(9))).toBe(true)
    expect(invoke('startup:get-state')).toEqual({ state: 'ready', globalGeneration: '世代甲', appearanceRevisionFloor: 9 })
    expect(invoke('startup:appearance-ack', ack(1))).toBe(false)
    expect(invoke('startup:appearance-ack', ack(10))).toBe(true)
  })
  it('不再提供皮肤快照通道', () => {
    expect([...handlers.keys()].sort()).toEqual(['startup:appearance-ack', 'startup:get-state'])
  })
  it('拒绝其他窗口、子框架、外部导航和已销毁窗口', () => {
    for (const untrusted of [{ sender: { ...sender }, senderFrame: sender.mainFrame }, { sender, senderFrame: { ...sender.mainFrame } }, { sender }]) {
      expect(invoke('startup:get-state', undefined, untrusted)).toEqual({ state: 'blocked' })
      expect(invoke('startup:appearance-ack', ack(), untrusted)).toBe(false)
    }
    sender.mainFrame.url = 'https://example.invalid/index.html'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    sender.mainFrame.url = 'file:///isolated/index.html'
    sender.isDestroyed = () => true
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
  })
  it('允许同一文档的内部路由但拒绝另一文档和查询来源', () => {
    sender.mainFrame.url += '#settings'
    expect(invoke('startup:appearance-ack', ack())).toBe(true)
    sender.mainFrame.url = 'file:///isolated/other.html'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    sender.mainFrame.url = 'file:///isolated/index.html?untrusted=1'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
  })
  it('全局世代在读取后变化时拒绝旧确认', () => {
    expect(invoke('startup:get-state')).toEqual({ state: 'ready', globalGeneration: '世代甲' })
    generation = '世代乙'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
  })
  it('仅确认 v3 规范键的有效版本，不接受旧键、皮肤或额外权限字段，也不接受版本倒退', () => {
    for (const value of [null, [], { ...ack(), storageKey: 'ai-novel-writer-appearance' }, { ...ack(), storageKey: 'ai-novel-writer-theme' },
      { ...ack(), profileRevision: 0 }, { ...ack(), profileRevision: 1.5 }, { ...ack(), skinRevision: 2 }, { ...ack(), dataRoot: '任意位置' }]) {
      expect(invoke('startup:appearance-ack', value)).toBe(false)
    }
    expect(invoke('startup:appearance-ack', ack(3))).toBe(true)
    expect(invoke('startup:appearance-ack', ack(2))).toBe(false)
    expect(invoke('startup:appearance-ack', ack(3))).toBe(true)
  })
  it('全局被阻塞时不能确认外观', () => {
    blocked = 'GLOBAL_DATA_BLOCKED'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
  })
})
