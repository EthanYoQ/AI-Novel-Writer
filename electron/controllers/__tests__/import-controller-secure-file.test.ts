import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

import { registerImportController } from '../import-controller'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-secure-'))

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function event() {
  return { sender: { id: 29, once: vi.fn() } }
}

describe('novel import external-file capability', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
    registerImportController()
  })

  afterAll(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('still imports a normal user-selected text file through the secure reader', async () => {
    const selected = path.join(temporaryRoot, 'normal.txt')
    fs.writeFileSync(selected, '第1章 开始\n正常内容', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    await expect(handler('import:split-chapters')(event(), [selection[0].grantId])).resolves.toMatchObject({
      success: true,
      totalWords: '正常内容'.length,
      chapters: [{ number: 1, content: '正常内容' }],
    })
  })

  it('does not import outside content when the selected file parent becomes a junction after grant issuance', async () => {
    const selectedRoot = path.join(temporaryRoot, 'selected')
    const guardedDirectory = path.join(selectedRoot, 'guarded')
    const outsideDirectory = path.join(temporaryRoot, 'outside')
    const selected = path.join(guardedDirectory, 'novel.txt')
    fs.mkdirSync(guardedDirectory, { recursive: true })
    fs.mkdirSync(outsideDirectory)
    fs.writeFileSync(selected, '第1章 内部\n内部内容', 'utf8')
    fs.writeFileSync(path.join(outsideDirectory, 'novel.txt'), '第1章 外部\n外部内容', 'utf8')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })

    const selection = await handler('dialog:select-novel-files')(event()) as Array<{ grantId: string }>
    fs.rmSync(guardedDirectory, { recursive: true, force: true })
    fs.symlinkSync(outsideDirectory, guardedDirectory, 'junction')

    await expect(handler('import:split-chapters')(event(), [selection[0].grantId])).resolves.toMatchObject({
      success: false,
      chapters: [],
      totalWords: 0,
    })
  })
})
