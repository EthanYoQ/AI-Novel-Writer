import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import { useLocaleStore } from '../../../../stores/locale-store'
import AgentMessage from '../AgentMessage'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentMessage copy action', () => {
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

  it.each(['user', 'assistant'] as const)('copies only the visible %s message content', async (role) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<AgentMessage message={{
      id: `${role}-1`, role, content: 'Visible message', createdAt: 1,
      ...(role === 'assistant' ? { toolCalls: [{
        id: 'hidden-tool', toolName: 'write_file', arguments: { secret: 'do not copy' }, status: 'completed' as const,
      }] } : {}),
    }} />))

    await act(async () => page.getByRole('button', { name: 'Copy message' }).click())

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('Visible message')
  })

  it('disables copying for empty streaming content', async () => {
    await act(async () => root.render(<AgentMessage message={{
      id: 'streaming', role: 'assistant', content: '', createdAt: 1, streaming: true,
    }} />))

    expect(page.getByRole('button', { name: 'Copy message' })).toBeDisabled()
  })

  it('shows a localized clipboard failure without hiding the message', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root.render(<AgentMessage message={{
      id: 'assistant-1', role: 'assistant', content: 'Keep this visible', createdAt: 1,
    }} />))

    await act(async () => page.getByRole('button', { name: 'Copy message' }).click())

    expect(page.getByRole('alert')).toHaveTextContent('Could not copy this message')
    expect(container.textContent).toContain('Keep this visible')
  })
})
