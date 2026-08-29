import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SafeDiagnosticCopyButton } from '../BottomPanel'
import { useLocaleStore } from '../../../stores/locale-store'

describe('safe diagnostic copy action', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('copies a safe diagnostic from the selected existing call record', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<SafeDiagnosticCopyButton call={{
      id: 9,
      modelId: '2f491640-c201-4c6e-922b-3103e8c2c5f7',
      modelName: 'Grok 4',
      purpose: 'chapter-draft',
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
      durationMs: 900,
      success: true,
      createdAt: '2026-08-29T10:00:00.000Z',
    }} />))

    await page.getByRole('button', { name: 'Copy safe diagnostics' }).click()

    expect(writeText).toHaveBeenCalledOnce()
    const copied = writeText.mock.calls[0]?.[0] as string
    expect(copied).toContain('- Actual model: Grok 4')
    expect(copied).toContain('- Model ID: 2f491640-c201-4c6e-922b-3103e8c2c5f7')
    expect(copied).toContain('- Purpose: chapter-draft')
    expect(copied).not.toMatch(/sk-do-not-copy|Authorization|request body/)
  })
})
