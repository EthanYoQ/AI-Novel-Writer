import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useThemeStore } from '../../../stores/theme-store'
import StageSettings from '../../stage/settings/StageSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hanPattern = /[\u3400-\u9fff]/u
let container: HTMLDivElement | undefined
let root: Root | undefined

beforeEach(async () => {
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'config:get') return { autoOpenNextChapterAfterFinalize: false }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
    },
  })
  useLocaleStore.setState({ locale: 'en-US' })
  useLayoutStore.setState({ settingsSection: 'appearance' })
  useThemeStore.setState({ uiFont: 'noto-sans-sc', writingFont: 'lxgw-wenkai' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<StageSettings library={false} />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.restoreAllMocks()
})

describe('editor font locale', () => {
  it('keeps the English font selection and its options free of Chinese copy', async () => {
    const appearance = container?.querySelector('.stage-set-body')
    expect(appearance?.querySelector('h1')?.textContent).toBe('Appearance')
    const fonts = [...(appearance?.querySelectorAll('select') ?? [])]
      .filter(select => [...select.options].some(option => option.value === 'noto-sans-sc'))
    expect(fonts.map(select => select.value)).toEqual(['noto-sans-sc', 'lxgw-wenkai'])
    expect(appearance?.textContent).not.toMatch(hanPattern)
  })
})
