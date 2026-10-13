import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import type { DirectoryGenerationCatalog } from '../../../shared/generation-owner-contract'
import DirectoryConfigDialog from '../DirectoryConfigDialog'
import '../../../index.css'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let root: Root
let container: HTMLDivElement
let catalog: DirectoryGenerationCatalog

beforeEach(() => {
  catalog = { progress: [], diagnostics: [] }
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: {
      id: 'directory-layout', sessionLease: 'layout-lease', name: 'Directory layout',
      path: 'C:\\novels\\directory-layout', characterStates: '',
      createdAt: '2026-10-13', updatedAt: '2026-10-13',
      novelConfig: {
        genre: '奇幻', subGenre: '', targetAudience: '', totalChapters: 1000, wordsPerChapter: 3000,
        plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '',
        worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
        writingLanguage: 'zh-CN',
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'generation:list-directory-progress') return catalog
        if (channel === 'config:get') return { blueprintTargetUnits: 572 }
        if (channel === 'config:set') return { success: true }
        if (channel === 'db:blueprint-character-sync-list-pending') return []
        if (channel === 'db:blueprint-get-all') {
          return Array.from({ length: 19 }, (_, index) => ({ chapterNumber: index + 1 }))
        }
        if (channel === 'db:draft-authority-sequence') return {
          status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1,
          duplicateChapterNumbers: [], authorityFingerprint: 'b'.repeat(64),
        }
        throw new Error(`Unexpected IPC ${channel}`)
      }),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

it.each([
  { count: 0, width: 1152, height: 720 },
  { count: 6, width: 1152, height: 720 },
  { count: 30, width: 1152, height: 720 },
  { count: 0, width: 666, height: 1107 },
  { count: 6, width: 666, height: 1107 },
  { count: 30, width: 666, height: 1107 },
])('keeps $count blueprint histories and actions reachable at $width x $height', async ({ count, width, height }) => {
  await page.viewport(width, height)
  const ranges = [[1, 5], [6, 10], [3, 7], [3, 9], [10, 14], [10, 19]]
  catalog.progress = Array.from({ length: count }, (_, index) => {
    const [startChapter, endChapter] = ranges[index % ranges.length]
    return {
      operationId: `operation-${index}`, payloadHash: 'a'.repeat(64),
      sourceHandle: { projectId: 'directory-layout', epoch: 'layout', rootActionId: `root-${index}`, runId: `run-${index}` },
      requestedRange: { startChapter, endChapter }, committedRange: { startChapter, endChapter }, remainingRange: null,
    }
  })
  if (count > 0) catalog.diagnostics = [{
    runId: 'invalid-history', kind: 'invalid', code: 'GENERATION_DIRECTORY_PROGRESS_INVALID',
  }]
  const onConfirm = vi.fn(async () => {})
  const onClose = vi.fn()
  function Harness() {
    const [isOpen, setOpen] = useState(true)
    return <>
      <button onClick={() => setOpen(true)}>重新打开</button>
      <DirectoryConfigDialog isOpen={isOpen} existingCount={19} onConfirm={onConfirm}
        onClose={() => { onClose(); setOpen(false) }} />
    </>
  }
  await act(async () => root.render(<Harness />))

  for (const action of ['取消', '开始生成']) {
    await expect.element(page.getByRole('button', { name: '开始生成', exact: true })).toBeEnabled()
    const dialog = page.getByRole('dialog').element()
    await act(async () => { await Promise.all(dialog.getAnimations().map(animation => animation.finished)) })
    expect([...dialog.querySelectorAll('p')].filter(p => p.textContent?.startsWith('已保存第'))).toHaveLength(count)
    if (count > 0) {
      await expect.element(page.getByText('旧蓝图生成进度校验失败，不能续接', { exact: true })).toBeInTheDocument()
    }
    const rect = dialog.getBoundingClientRect()
    expect(rect.top).toBeGreaterThan(0)
    expect(rect.bottom).toBeLessThan(height)
    expect(rect.left).toBeGreaterThan(0)
    expect(rect.right).toBeLessThan(width)
    dialog.scrollTo({ top: dialog.scrollHeight, behavior: 'instant' })
    if (count > 0) expect(dialog.scrollTop).toBeGreaterThan(0)
    const button = page.getByRole('button', { name: action, exact: true })
    const buttonRect = button.element().getBoundingClientRect()
    expect(buttonRect.top).toBeGreaterThanOrEqual(rect.top)
    expect(buttonRect.bottom).toBeLessThanOrEqual(rect.bottom)
    await act(async () => button.click())
    await act(async () => { await Promise.all(dialog.getAnimations().map(animation => animation.finished)) })
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    if (action === '取消') {
      expect(onConfirm).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledOnce()
      await act(async () => page.getByRole('button', { name: '重新打开', exact: true }).click())
    }
  }
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
    mode: 'append', startChapter: 20, count: 5, targetUnits: 572, pacingGuidance: undefined,
  })
  expect(onClose).toHaveBeenCalledTimes(2)
})
