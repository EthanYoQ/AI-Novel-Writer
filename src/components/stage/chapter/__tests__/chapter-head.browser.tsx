import { afterEach, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { Locale } from '../../../../i18n/types'
import { useLocaleStore } from '../../../../stores/locale-store'
import ChapterHead from '../ChapterHead'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const restoreLocale = (() => { const state = (useLocaleStore as StoreApi<unknown>).getState(); return () => (useLocaleStore as StoreApi<unknown>).setState(state, true) })()
let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  restoreLocale()
})

async function eyebrow(locale: Locale, role: string): Promise<string> {
  useLocaleStore.setState({ locale })
  await act(async () => root!.render(<ChapterHead chapterNumber={3} role={role} title="雾钟" version={null} step={0} focus={false} />))
  return host!.querySelector('.stage-ch-eyebrow')!.textContent ?? ''
}

it('章节头的定位按界面语言显示：内置定位在英文界面译出，自定义定位原样', async () => {
  expect(await eyebrow('en-US', '发展')).toBe('Chapter 3 · Development')
  expect(await eyebrow('en-US', '暗线回收')).toBe('Chapter 3 · 暗线回收')
  expect(await eyebrow('zh-CN', '发展')).toBe('第 3 章 · 发展')
})
