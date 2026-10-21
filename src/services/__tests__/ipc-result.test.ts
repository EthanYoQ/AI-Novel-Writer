import { afterEach, expect, it } from 'vitest'
import { requireIpcSuccess } from '../ipc-result'
import { useLocaleStore } from '../../stores/locale-store'

const original = useLocaleStore.getState()
afterEach(() => useLocaleStore.setState(original, true))

it('explains a registered main-process code in the English interface (#474)', () => {
  useLocaleStore.setState({ locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false, error: 'Error: GENERATION_PROJECT_SESSION_STALE' }, '保存草稿'))
    .toThrow(/switched or reopened/iu)
})

it('falls back to English, not the Chinese action label, when the main process gives no reason (#474)', () => {
  useLocaleStore.setState({ locale: 'en-US' })
  expect(() => requireIpcSuccess({ success: false }, '保存草稿')).toThrow(/^The operation failed\.$/u)
  useLocaleStore.setState({ locale: 'zh-CN' })
  expect(() => requireIpcSuccess({ success: false }, '保存草稿')).toThrow(/^保存草稿失败$/u)
})
