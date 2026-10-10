import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import ArchitectureConfirmDialog from '../ArchitectureConfirmDialog'
import '../../../index.css'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: {
      id: 'guidance-layout', name: 'Guidance layout', path: 'C:\\novels\\guidance-layout',
      characterStates: '', createdAt: '2026-01-01', updatedAt: '2026-01-01',
      novelConfig: {
        genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 20, wordsPerChapter: 5000,
        plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '完整的故事构想',
        worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke: vi.fn(async () => ({})) },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

it.each([
  { width: 1440, height: 900, dismiss: 'close' },
  { width: 1152, height: 720, dismiss: 'cancel' },
  { width: 1152, height: 720, dismiss: 'escape' },
])('keeps expanded architecture guidance within $width x $height and dismisses with $dismiss', async ({ width, height, dismiss }) => {
  await page.viewport(width, height)
  const onConfirm = vi.fn(async () => {})
  const onClose = vi.fn()
  function DialogHarness() {
    const [isOpen, setOpen] = useState(true)
    return <ArchitectureConfirmDialog isOpen={isOpen} archStatus={{}} onConfirm={onConfirm} onClose={() => { onClose(); setOpen(false) }} />
  }
  await act(async () => root.render(<DialogHarness />))
  await act(async () => page.getByRole('button', { name: '为每个步骤添加补充指导（可选）' }).click())
  const dialog = page.getByRole('dialog').element()
  expect(dialog.querySelectorAll('textarea')).toHaveLength(4)
  await act(async () => { await Promise.all(dialog.getAnimations().map(animation => animation.finished)) })
  const rect = dialog.getBoundingClientRect()
  expect(rect.top).toBeGreaterThan(0)
  expect(rect.bottom).toBeLessThan(height)
  expect(rect.left).toBeGreaterThan(0)
  expect(rect.right).toBeLessThan(width)
  expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight)
  if (dismiss === 'escape') {
    await act(async () => userEvent.keyboard('{Escape}'))
  } else {
    if (dismiss === 'cancel') {
      dialog.scrollTo({ top: dialog.scrollHeight, behavior: 'instant' })
      expect(dialog.scrollTop).toBeGreaterThan(0)
    }
    const button = page.getByRole('button', { name: dismiss === 'cancel' ? '取消' : '关闭', exact: true })
    const buttonRect = button.element().getBoundingClientRect()
    expect(buttonRect.top).toBeGreaterThanOrEqual(rect.top)
    expect(buttonRect.bottom).toBeLessThanOrEqual(rect.bottom)
    await act(async () => button.click())
  }
  await act(async () => { await Promise.all(dialog.getAnimations().map(animation => animation.finished)) })
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})
