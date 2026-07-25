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

import { registerExternalFileGrantController } from '../external-file-grant-controller'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import type { AtomicWriteConstraints, WindowsSafeFileSystem } from '../../security/windows-safe-file-system'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-controller-'))

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function event(webContentsId = 17) {
  return {
    sender: {
      id: webContentsId,
      once: vi.fn(),
    },
  }
}

describe('external file grant IPC contract', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
    registerExternalFileGrantController(new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'export-directory-grant',
    }))
  })

  afterAll(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('选择导出目录只返回不透明授权，绝不返回绝对目录路径', async () => {
    const exportDirectory = path.join(temporaryRoot, 'exports')
    fs.mkdirSync(exportDirectory)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportDirectory],
    })

    const result = await handler('dialog:select-export-directory')(event()) as {
      grantId: string
      displayName: string
      directoryPath?: string
    }

    expect(result).toEqual({
      grantId: 'export-directory-grant',
      displayName: 'exports',
    })
    expect(result).not.toHaveProperty('directoryPath')
  })

  it('导出写入拒绝 grant 外的 traversal 相对路径', async () => {
    const exportDirectory = path.join(temporaryRoot, 'exports-safe')
    fs.mkdirSync(exportDirectory)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportDirectory],
    })
    const selection = await handler('dialog:select-export-directory')(event()) as { grantId: string }

    await expect(handler('fs:grant-write-file')(
      event(),
      selection.grantId,
      '../escape.txt',
      'should not write',
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('路径无效'),
    })
    expect(fs.existsSync(path.join(temporaryRoot, 'escape.txt'))).toBe(false)
  })

  it('在授权后目录被换成 junction 时，写入和建目录都不会越出用户选择的根', async () => {
    const exportDirectory = path.join(temporaryRoot, 'exports-reparse')
    const outsideDirectory = path.join(temporaryRoot, 'outside-reparse')
    const guardedDirectory = path.join(exportDirectory, 'guarded')
    fs.mkdirSync(guardedDirectory, { recursive: true })
    fs.mkdirSync(outsideDirectory)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportDirectory],
    })
    const selection = await handler('dialog:select-export-directory')(event()) as { grantId: string }

    // The grant is valid at this point. Replacing a child after that validation
    // used to redirect the later Node path-based I/O outside exportDirectory.
    fs.rmSync(guardedDirectory, { recursive: true, force: true })
    fs.symlinkSync(outsideDirectory, guardedDirectory, 'junction')

    await expect(handler('fs:grant-write-file')(
      event(),
      selection.grantId,
      'guarded/result.txt',
      'must not escape',
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('路径无效') })
    await expect(handler('fs:grant-mkdir')(
      event(),
      selection.grantId,
      'guarded/new-folder',
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('路径无效') })
    expect(fs.existsSync(path.join(outsideDirectory, 'result.txt'))).toBe(false)
    expect(fs.existsSync(path.join(outsideDirectory, 'new-folder'))).toBe(false)
  })

  it('仅 write 授权在 exists 后目标被删除时不能借原子替换重新创建文件', async () => {
    const exportDirectory = path.join(temporaryRoot, 'exports-write-only')
    fs.mkdirSync(exportDirectory, { recursive: true })
    fs.writeFileSync(path.join(exportDirectory, 'chapter.txt'), 'old content', 'utf8')
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'write-only-grant',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: exportDirectory,
      operations: ['write'],
      ttlMs: 60_000,
      maxUses: 2,
    })
    let targetExists = true
    const writeTextAtomically = vi.fn(async (
      _capability: unknown,
      _content: string,
      beforeReplace?: () => void | Promise<void>,
      constraints?: AtomicWriteConstraints,
    ) => {
      await beforeReplace?.()
      if (constraints?.mustAlreadyExist && !targetExists) {
        throw new Error('SECURE_FS_NOT_FOUND')
      }
      targetExists = true
    })
    const fileSystem = {
      readText: vi.fn(),
      writeTextAtomically,
      mkdir: vi.fn(),
      exists: vi.fn(async () => {
        const observed = targetExists
        // Deterministically models deletion immediately after the controller's
        // existence observation and before the helper commit point.
        targetExists = false
        return observed
      }),
      listDirectory: vi.fn(),
    } as unknown as WindowsSafeFileSystem
    mocks.handlers.clear()
    registerExternalFileGrantController(grants, fileSystem)

    await expect(handler('fs:grant-write-file')(
      event(),
      grant.grantId,
      'chapter.txt',
      'new content',
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('路径无效'),
    })
    expect(writeTextAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'chapter.txt' }),
      'new content',
      expect.any(Function),
      { mustAlreadyExist: true },
    )
    expect(targetExists).toBe(false)
  })

  it('同时具备 create 授权时允许在提交点创建已被删除的目标', async () => {
    const exportDirectory = path.join(temporaryRoot, 'exports-create-capable')
    fs.mkdirSync(exportDirectory, { recursive: true })
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'create-capable-grant',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: exportDirectory,
      operations: ['write', 'create'],
      ttlMs: 60_000,
      maxUses: 2,
    })
    let targetExists = true
    const writeTextAtomically = vi.fn(async (
      _capability: unknown,
      _content: string,
      beforeReplace?: () => void | Promise<void>,
      constraints?: AtomicWriteConstraints,
    ) => {
      await beforeReplace?.()
      if (constraints?.mustAlreadyExist && !targetExists) {
        throw new Error('SECURE_FS_NOT_FOUND')
      }
      targetExists = true
    })
    const fileSystem = {
      readText: vi.fn(),
      writeTextAtomically,
      mkdir: vi.fn(),
      exists: vi.fn(async () => {
        const observed = targetExists
        targetExists = false
        return observed
      }),
      listDirectory: vi.fn(),
    } as unknown as WindowsSafeFileSystem
    mocks.handlers.clear()
    registerExternalFileGrantController(grants, fileSystem)

    await expect(handler('fs:grant-write-file')(
      event(),
      grant.grantId,
      'chapter.txt',
      'new content',
    )).resolves.toEqual({ success: true })
    expect(writeTextAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'chapter.txt' }),
      'new content',
      expect.any(Function),
      { mustAlreadyExist: false },
    )
    expect(targetExists).toBe(true)
  })
})
