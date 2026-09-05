import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useThemeStore } from '../../../stores/theme-store'
import SettingsModal from '../SettingsModal'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hanPattern = /[\u3400-\u9fff]/u
let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(async () => {
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'config:get') return { autoOpenNextChapterAfterFinalize: false }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
    },
  })
  useLocaleStore.setState({ locale: 'en-US' })
  useLayoutStore.setState({ settingsSection: 'editor' })
  useThemeStore.setState({ uiFont: 'noto-sans-sc', writingFont: 'lxgw-wenkai' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<SettingsModal open onClose={() => {}} />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.restoreAllMocks()
})

describe('editor font locale', () => {
  it('keeps the English font selection and its opened options free of Chinese copy', async () => {
    const editor = container?.querySelector('main')
    expect(editor?.textContent).not.toMatch(hanPattern)

    const interfaceFontButton = [...(editor?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('Noto Sans SC'))
    expect(interfaceFontButton).toBeDefined()

    await act(async () => interfaceFontButton?.click())
    expect(editor?.textContent).not.toMatch(hanPattern)
  })
})
