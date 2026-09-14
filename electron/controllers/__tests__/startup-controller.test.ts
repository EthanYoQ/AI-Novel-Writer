import { beforeEach, describe, expect, it } from 'vitest'
import { registerStartupController, type StartupEvent, type StartupSender } from '../startup-controller'
import type { AppearanceSkinSnapshot } from '../../../src/shared/startup-contract'

let handlers: Map<string, (event: StartupEvent, input?: unknown) => unknown>
let sender: StartupSender
let event: StartupEvent
let current: AppearanceSkinSnapshot | null
let blocked: 'GLOBAL_DATA_BLOCKED' | 'SKIN_NOT_READY' | undefined
const ack = (profileRevision = 1) => ({ storageKey: 'ai-novel-writer-appearance', profileRevision, globalGeneration: '世代甲', skinRevision: 2 })
beforeEach(() => {
  handlers = new Map()
  sender = { id: 1, mainFrame: { url: 'file:///isolated/index.html' }, isDestroyed: () => false }
  event = { sender, senderFrame: sender.mainFrame }
  current = { globalGeneration: '世代甲', skinRevision: 2, backgroundSkin: 'classic' }
  blocked = undefined
  registerStartupController({ ipc: { handle: (channel, handler) => { handlers.set(channel, handler) } },
    getTrustedSender: () => sender, rendererUrl: 'file:///isolated/index.html',
    getSnapshot: () => current, getBlockedCode: () => blocked })
})
const invoke = (channel: string, input?: unknown, from = event) => handlers.get(channel)!(from, input)

describe('真实启动来源与外观确认边界', () => {
  it('只有全局和皮肤均成功才发布 ready', () => {
    expect(invoke('startup:get-state')).toEqual({ state: 'ready', globalGeneration: '世代甲', skinRevision: 2 })
    current = null
    expect(invoke('startup:get-state')).toEqual({ state: 'pending' })
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    blocked = 'GLOBAL_DATA_BLOCKED'
    expect(invoke('startup:get-state')).toEqual({ state: 'blocked', code: 'GLOBAL_DATA_BLOCKED' })
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
  it('皮肤或全局世代在读取后变化时拒绝旧确认', () => {
    const ready = invoke('startup:get-state')
    expect(invoke('startup:skin-snapshot', ready)).toEqual(current)
    current = { ...current!, skinRevision: 3 }
    expect(() => invoke('startup:skin-snapshot', ready)).toThrow('启动快照已变化')
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    current = { ...current, skinRevision: 2, globalGeneration: '世代乙' }
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
  })
  it('仅确认规范键的有效版本，不接受额外权限字段或版本倒退', () => {
    for (const value of [null, [], { ...ack(), storageKey: 'ai-novel-writer-theme' }, { ...ack(), profileRevision: 0 }, { ...ack(), profileRevision: 1.5 }, { ...ack(), dataRoot: '任意位置' }]) {
      expect(invoke('startup:appearance-ack', value)).toBe(false)
    }
    expect(invoke('startup:appearance-ack', ack(3))).toBe(true)
    expect(invoke('startup:appearance-ack', ack(2))).toBe(false)
    expect(invoke('startup:appearance-ack', ack(3))).toBe(true)
  })
  it('全局被阻塞时不能借旧的有效皮肤快照完成确认', () => {
    blocked = 'SKIN_NOT_READY'
    expect(invoke('startup:appearance-ack', ack())).toBe(false)
    expect(() => invoke('startup:skin-snapshot', { state: 'ready', globalGeneration: '世代甲', skinRevision: 2 })).toThrow('启动快照访问被拒绝')
  })
})
