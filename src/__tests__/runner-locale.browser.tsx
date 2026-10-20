import { afterEach, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../stores/locale-store'

afterEach(() => {
  Reflect.deleteProperty(window, 'aiNovelAPI')
  document.documentElement.lang = ''
})

it('starts in Chinese when the saved config has no locale, whatever language the runner system uses', async () => {
  // 与 App 挂载时一样：config 里没有 locale，语言初始化退回浏览器的 navigator.language。
  const invoke = vi.fn(async () => ({}))
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined, once: () => undefined, send: () => undefined } })

  await useLocaleStore.getState().init()

  expect(invoke).toHaveBeenCalledWith('config:get')
  expect(useLocaleStore.getState().text('设置', 'Settings')).toBe('设置')
  expect(document.documentElement.lang).toBe('zh-CN')
})
