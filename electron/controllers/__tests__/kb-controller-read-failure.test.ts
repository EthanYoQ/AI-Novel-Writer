import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  run: vi.fn(),
  importText: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../database', () => ({
  getCurrentProjectPath: () => 'C:/projects/A',
}))

vi.mock('../../services/project-access', () => ({
  projectAccess: {
    assertCurrentProjectContext: vi.fn(() => ({ rootPath: 'C:/projects/A' })),
  },
}))

vi.mock('../../services/project-storage-preflight', () => ({
  assertKnowledgeBaseStoragePathSupported: vi.fn(),
  projectStoragePreflightFailure: vi.fn(() => undefined),
}))

vi.mock('../../utils/config-utils', () => ({
  readJsonFile: vi.fn((_path: string, fallback: unknown) => fallback),
  GLOBAL_CONFIG_PATH: 'global.json',
  DEFAULT_GLOBAL_CONFIG: {},
  MODELS_CONFIG_PATH: 'models.json',
}))

vi.mock('../../services/knowledge-base-loader', () => ({
  knowledgeBaseLoader: { run: mocks.run },
}))

vi.mock('../../i18n', () => ({
  mainText: vi.fn((_locale: string, zh: string) => zh),
}))

import { registerKBController } from '../kb-controller'
import { externalFileGrants } from '../../services/external-file-grant-service'
import type { SecureFileCapability, WindowsSafeFileSystem } from '../../security/windows-safe-file-system'
import { READ_FAILURE_TEXT, expectedReadFailureText } from '../../../test/helpers/external-file-read-codes'

const invalidGrant = '外部文件授权无效或已失效，请重新选择。'
const webContentsId = 41
const fileSystem = {
  readText: vi.fn<(capability: SecureFileCapability) => Promise<string>>(),
  listDirectory: vi.fn<(capability: SecureFileCapability) => Promise<Array<{ name: string; isDirectory: boolean }>>>(),
}
let directory = ''

function event() {
  return { sender: { id: webContentsId, once: vi.fn() } }
}

function invoke(channel: string, grantId: string) {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered(event(), grantId, 'C:/projects/A', {
    projectId: 'project-A',
    leaseId: 'lease-A',
    projectPath: 'C:/projects/A',
  }) as Promise<{ success: boolean; error?: string; importedCount?: number; failedFiles?: string[] }>
}

function fileGrant(): string {
  return externalFileGrants.issueFile({
    webContentsId,
    filePath: path.join(directory, 'notes.txt'),
    operations: ['read'],
    ttlMs: 60_000,
    maxUses: 1,
  }).grantId
}

function folderGrant(): string {
  return externalFileGrants.issueDirectory({
    webContentsId,
    directoryPath: directory,
    operations: ['list', 'read'],
    ttlMs: 60_000,
    maxUses: 1,
  }).grantId
}

const namedCodes = Object.keys(READ_FAILURE_TEXT).filter(code => code !== 'generic')
const codeClasses = [...namedCodes, 'SECURE_FS_ROOT_CHANGED']

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-kb-read-failure-'))
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'text', 'utf8')
  registerKBController(fileSystem as unknown as WindowsSafeFileSystem)
})

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  fileSystem.readText.mockReset()
  fileSystem.listDirectory.mockReset()
  mocks.importText.mockResolvedValue({ success: true })
  mocks.run.mockImplementation(async (operation: (kb: { importText: typeof mocks.importText }) => unknown) => (
    operation({ importText: mocks.importText })
  ))
})

describe('kb:import-document 授权通过后读文件失败（#593）', () => {
  it.each(codeClasses)('%s 说读文件的原因，不说授权无效', async (code) => {
    fileSystem.readText.mockRejectedValue(new Error(code))

    await expect(invoke('kb:import-document', fileGrant())).resolves.toEqual({
      success: false,
      error: expectedReadFailureText(code),
    })
    expect(mocks.importText).not.toHaveBeenCalled()
  })

  it('授权本身无效时仍说授权无效，不去读文件', async () => {
    await expect(invoke('kb:import-document', 'never-issued')).resolves.toEqual({ success: false, error: invalidGrant })
    expect(fileSystem.readText).not.toHaveBeenCalled()
  })
})

describe('kb:import-folder 授权通过后读文件失败（#593）', () => {
  it.each(codeClasses)('列目录失败 %s 时说读文件的原因，不说授权无效', async (code) => {
    fileSystem.listDirectory.mockRejectedValue(new Error(code))

    await expect(invoke('kb:import-folder', folderGrant())).resolves.toEqual({
      success: false,
      importedCount: 0,
      failedFiles: [],
      error: expectedReadFailureText(code),
    })
  })

  it.each(codeClasses)('单个文件读失败 %s 时其余文件照常导入，读失败的文件列进 failedFiles', async (code) => {
    fileSystem.listDirectory.mockResolvedValue([
      { name: 'first.txt', isDirectory: false },
      { name: 'broken.md', isDirectory: false },
      { name: 'last.txt', isDirectory: false },
    ])
    fileSystem.readText.mockImplementation(async (capability) => {
      if (capability.relativePath.endsWith('broken.md')) throw new Error(code)
      return `content of ${path.basename(capability.relativePath)}`
    })

    await expect(invoke('kb:import-folder', folderGrant())).resolves.toEqual({
      success: true,
      importedCount: 2,
      failedFiles: ['broken.md'],
    })
    expect(mocks.importText.mock.calls.map(call => call[1])).toEqual(['first.txt', 'last.txt'])
  })

  it('授权本身无效时仍说授权无效，不去列目录', async () => {
    await expect(invoke('kb:import-folder', 'never-issued')).resolves.toEqual({
      success: false,
      importedCount: 0,
      failedFiles: [],
      error: invalidGrant,
    })
    expect(fileSystem.listDirectory).not.toHaveBeenCalled()
  })
})
