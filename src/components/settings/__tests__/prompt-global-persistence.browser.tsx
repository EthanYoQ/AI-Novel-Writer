import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { BUILTIN_PROMPTS } from '../../../services/prompt-templates'
import { useLocaleStore } from '../../../stores/locale-store'
import PromptSettings from '../PromptSettings'

const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLocaleStore.setState(originalLocaleState)
  const { useProjectStore } = await import('../../../stores/project-store')
  useProjectStore.setState({ currentProject: null })
})

describe('global prompt persistence at the settings boundary', () => {
  it('shows a globally saved template after a cold renderer start', async () => {
    const builtin = BUILTIN_PROMPTS.find((template) => template.key === 'generate_global_config')
    if (!builtin) throw new Error('Missing built-in prompt fixture')

    const persistedContent = '这是重启后仍应生效的全局提示词 {{user_idea}} {{number_of_chapters}} {{word_number}}'
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') {
        return { templates: [{ ...builtin, content: persistedContent }], diagnostics: [] }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
      invoke,
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    useLocaleStore.setState({ locale: 'zh-CN' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<PromptSettings />)
    })
    await act(async () => {
      await page.getByRole('button', { name: /全文配置生成/ }).click()
    })

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('prompt:load-global')
    })
    await expect.element(page.getByRole('textbox', { name: '补充创作指导' })).toHaveValue(persistedContent)
  })

})
