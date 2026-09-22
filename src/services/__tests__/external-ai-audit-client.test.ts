import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isElectron: true,
}))

vi.mock('../ipc-client', () => ({
  ipc: {
    get isElectron() { return mocks.isElectron },
    invoke: (...args: unknown[]) => mocks.invoke(...args),
  },
}))

import { openExternalAiPage, writeClipboardText } from '../external-ai-audit-client'

function fakeClipboard(writeText: (value: string) => Promise<void>) {
  return { writeText } as unknown as Pick<Clipboard, 'writeText'>
}

/** 直到 execCommand('copy') 这一层的最小 document 替身。 */
function fakeDocument(execCommand: () => boolean) {
  const textarea = {
    value: '',
    style: {} as CSSStyleDeclaration,
    select: vi.fn(),
  }
  const body = {
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  }
  return {
    doc: {
      createElement: () => textarea,
      body,
      execCommand: vi.fn(execCommand),
    } as unknown as Document,
    textarea,
    body,
  }
}

describe('writeClipboardText', () => {
  it('uses the standard clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(writeClipboardText('草稿正文', { clipboard: fakeClipboard(writeText) })).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('草稿正文')
  })

  it('falls back to execCommand when the clipboard API rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('window is not focused'))
    const { doc, body } = fakeDocument(() => true)

    await expect(writeClipboardText('草稿正文', { clipboard: fakeClipboard(writeText), doc })).resolves.toBe(true)

    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    // 兜底用的临时输入框必须被收拾干净，不能留在 DOM 里
    expect(body.appendChild).toHaveBeenCalledTimes(1)
    expect(body.removeChild).toHaveBeenCalledTimes(1)
  })

  it('reports failure instead of throwing when neither path works', async () => {
    const { doc } = fakeDocument(() => false)

    await expect(writeClipboardText('草稿正文', { clipboard: fakeClipboard(vi.fn().mockRejectedValue(new Error('nope'))), doc }))
      .resolves.toBe(false)
  })

  it('reports failure when there is no document at all', async () => {
    await expect(writeClipboardText('草稿正文', { clipboard: undefined, doc: undefined })).resolves.toBe(false)
  })
})

describe('openExternalAiPage', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.isElectron = true
  })

  afterEach(() => {
    mocks.isElectron = true
  })

  it('asks the main process to open the page', async () => {
    mocks.invoke.mockResolvedValue({ success: true })

    await expect(openExternalAiPage('https://chat.deepseek.com/')).resolves.toEqual({ success: true })
    expect(mocks.invoke).toHaveBeenCalledWith('external-ai-audit:open', 'https://chat.deepseek.com/')
  })

  it('turns an IPC rejection into a controlled failure', async () => {
    mocks.invoke.mockRejectedValue(new Error('ipc unavailable'))

    await expect(openExternalAiPage('https://chat.deepseek.com/')).resolves.toMatchObject({
      success: false,
      error: 'ipc unavailable',
    })
  })

  it('opens a browser tab when there is no Electron shell around', async () => {
    mocks.isElectron = false
    const openWindow = vi.fn()

    await expect(openExternalAiPage('https://chat.deepseek.com/', { openWindow })).resolves.toEqual({ success: true })
    expect(openWindow).toHaveBeenCalledWith('https://chat.deepseek.com/')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
