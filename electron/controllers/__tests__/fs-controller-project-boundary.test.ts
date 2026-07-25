import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureFileCapability, WindowsSafeFileSystem } from '../../security/windows-safe-file-system'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  currentProjectPath: '',
  activeLeaseId: 'lease-A',
  assertCurrentProjectContext: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../database', () => ({
  getCurrentProjectPath: () => mocks.currentProjectPath,
}))

vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: mocks.assertCurrentProjectContext,
  },
}))

import { registerFSController } from '../fs-controller'

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-fs-controller-'))
const projectAPath = path.join(temporaryRoot, 'A')
const projectBPath = path.join(temporaryRoot, 'B')
fs.mkdirSync(projectAPath)
fs.mkdirSync(projectBPath)

function capabilityPath(capability: SecureFileCapability): string {
  return capability.relativePath
    ? path.join(capability.rootPath, ...capability.relativePath.split('\\'))
    : capability.rootPath
}

// The production controller has no Node fs fallback. This seam makes the lease
// timing visible while preserving the same beforeReplace commit boundary that
// the Windows handle helper exposes.
const testFileSystem: WindowsSafeFileSystem = {
  async readText(capability) {
    return fsPromises.readFile(capabilityPath(capability), 'utf8')
  },
  async writeTextAtomically(capability, content, beforeReplace) {
    const target = capabilityPath(capability)
    const temporary = `${target}.test-tmp`
    try {
      await fsPromises.writeFile(temporary, content, 'utf8')
      await beforeReplace?.()
      fs.renameSync(temporary, target)
    } finally {
      await fsPromises.unlink(temporary).catch(() => undefined)
    }
  },
  async mkdir(capability) {
    fs.mkdirSync(capabilityPath(capability), { recursive: true })
  },
  async exists(capability) {
    return fs.existsSync(capabilityPath(capability))
  },
  async listDirectory(capability) {
    return fs.readdirSync(capabilityPath(capability), { withFileTypes: true }).map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  },
}

function rawHandler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function handler(channel: string): IpcHandler {
  return handlerWithLease(channel, 'lease-A')
}

function handlerWithLease(channel: string, leaseId: string): IpcHandler {
  const registered = rawHandler(channel)
  return async (event, ...args) => registered(event, ...args, {
    projectId: 'project-A',
    leaseId,
    projectPath: mocks.currentProjectPath,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeAll(() => {
  registerFSController(testFileSystem)
})

beforeEach(() => {
  mocks.currentProjectPath = projectAPath
  mocks.activeLeaseId = 'lease-A'
  vi.clearAllMocks()
  mocks.assertCurrentProjectContext.mockImplementation((context: { projectPath?: string; leaseId?: string } | undefined, currentProjectPath: string) => {
    if (!context?.projectPath) throw new Error('缺少项目会话上下文，已拒绝操作')
    if (context.projectPath !== currentProjectPath) {
      throw new Error('项目会话与当前数据库不匹配，已拒绝操作')
    }
    if (context.leaseId !== mocks.activeLeaseId) {
      throw new Error('项目会话租约已失效，已拒绝操作')
    }
    return { rootPath: currentProjectPath }
  })
})

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('project-scoped filesystem boundary', () => {
  it('does not register legacy raw external filesystem channels', () => {
    expect(mocks.handlers.has('fs:external-read-file')).toBe(false)
    expect(mocks.handlers.has('fs:external-write-file')).toBe(false)
    expect(mocks.handlers.has('fs:external-list-dir')).toBe(false)
    expect(mocks.handlers.has('fs:external-mkdir')).toBe(false)
    expect(mocks.handlers.has('fs:external-check-exists')).toBe(false)
  })

  it('rejects project file access when the renderer omits project identity', async () => {
    await expect(rawHandler('fs:read-file')(
      {},
      path.join(projectAPath, 'chapter.md'),
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('缺少项目会话上下文'),
    })
  })

  it('rejects a matching filesystem path when its project session is omitted', async () => {
    const result = await rawHandler('fs:mkdir')(
      {},
      path.join(projectAPath, 'without-session'),
      projectAPath,
    )

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('项目会话'),
    })
  })

  it('rejects traversal and unrelated absolute paths before read or write', async () => {
    await expect(handler('fs:read-file')(
      {},
      path.join(projectAPath, '..', 'B', 'secret.md'),
      projectAPath,
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('超出当前项目'),
    })

    await expect(handler('fs:write-file')(
      {},
      path.join(projectBPath, 'secret.md'),
      'content',
      projectAPath,
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('超出当前项目'),
    })
  })

  it('rejects a project identity that no longer matches the active database', async () => {
    mocks.currentProjectPath = projectBPath

    await expect(handler('fs:read-file')(
      {},
      path.join(projectAPath, 'chapter.md'),
      projectAPath,
    )).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('跨项目读写'),
    })
  })

  it('propagates directory enumeration failures instead of returning an empty tree', async () => {
    await expect(handler('fs:list-dir')(
      {},
      path.join(projectAPath, 'missing'),
      projectAPath,
    )).rejects.toThrow()
  })

  it('rejects a delayed same-path read when the project is reopened with a new lease', async () => {
    const target = path.join(projectAPath, 'chapter.md')
    fs.writeFileSync(target, 'old content', 'utf8')
    const pendingRead = deferred<string>()
    const readSpy = vi.spyOn(fsPromises, 'readFile').mockImplementationOnce(async () => pendingRead.promise)

    const resultPromise = handlerWithLease('fs:read-file', 'lease-A')(
      {},
      target,
      projectAPath,
    )

    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledOnce())
    mocks.activeLeaseId = 'lease-B'
    pendingRead.resolve('stale content')

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('租约已失效'),
    })
  })

  it('rejects a delayed same-path write before it can replace the target after reopen', async () => {
    const target = path.join(projectAPath, 'chapter.md')
    fs.writeFileSync(target, 'original', 'utf8')
    const pendingWrite = deferred<void>()
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync')
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementationOnce(async () => pendingWrite.promise)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => undefined)

    const resultPromise = handlerWithLease('fs:write-file', 'lease-A')(
      {},
      target,
      'stale write',
      projectAPath,
    )

    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
    mocks.activeLeaseId = 'lease-B'
    pendingWrite.resolve()

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('租约已失效'),
    })
    expect(mkdirSpy).toHaveBeenCalledOnce()
    expect(renameSpy).not.toHaveBeenCalled()
    expect(fs.readFileSync(target, 'utf8')).toBe('original')
  })
})
