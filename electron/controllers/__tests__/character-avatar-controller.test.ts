import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CharacterAssetService } from '../../services/character-asset-service'

type Handler = (...args: unknown[]) => Promise<unknown> | unknown
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)) },
}))
vi.mock('../../i18n', () => ({ mainText: (_locale: string, zh: string) => zh }))

import { registerCharacterAvatarController } from '../character-avatar-controller'

const event = { sender: { id: 9, isDestroyed: () => false } }
const context = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:\\Novel' }
const avatar = { characterId: 'stable-a', assetRevision: 1, mime: 'image/png' as const, base64: 'image' }

function fakeService() {
  return {
    hasCharacter: vi.fn(() => true),
    previewFile: vi.fn(async () => ({ characterId: 'stable-a', mime: 'image/png' as const, base64: 'preview' })),
    commit: vi.fn(() => avatar),
    remove: vi.fn(),
    readMany: vi.fn(() => [avatar]),
    repository: { readMany: vi.fn(() => [{ characterId: 'stable-a', assetRevision: 1 }]) },
  }
}

beforeEach(() => { mocks.handlers.clear(); mocks.showOpenDialog.mockReset() })

describe('character avatar controller', () => {
  it('registers choose/commit/batch/remove and treats picker cancellation as no mutation', async () => {
    const service = fakeService()
    registerCharacterAvatarController({ resolveService: () => service as unknown as CharacterAssetService })
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'character-avatar:choose', 'character-avatar:commit', 'character-avatar:read-batch', 'character-avatar:remove',
    ])
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await mocks.handlers.get('character-avatar:choose')!(event, 'stable-a', context)).toEqual({ success: true, cancelled: true })
    expect(service.previewFile).not.toHaveBeenCalled()
    expect(service.commit).not.toHaveBeenCalled()
  })

  it('requires a valid frozen project session before resolving a service', async () => {
    const resolveService = vi.fn(() => fakeService() as unknown as CharacterAssetService)
    registerCharacterAvatarController({ resolveService })
    expect(await mocks.handlers.get('character-avatar:read-batch')!(event, ['stable-a'], { projectId: 'project-a' })).toMatchObject({
      success: false, error: { code: 'PROJECT_NOT_OPEN' },
    })
    expect(resolveService).not.toHaveBeenCalled()
  })

  it('batch loads once and caches only within project/session/revision', async () => {
    const service = fakeService()
    registerCharacterAvatarController({ resolveService: () => service as unknown as CharacterAssetService })
    const read = mocks.handlers.get('character-avatar:read-batch')!
    expect(await read(event, ['stable-a'], context)).toEqual({ success: true, avatars: [avatar] })
    expect(await read(event, ['stable-a'], context)).toEqual({ success: true, avatars: [avatar] })
    expect(service.readMany).toHaveBeenCalledTimes(1)
    const other = { ...context, leaseId: 'lease-b' }
    expect(await read(event, ['stable-a'], other)).toEqual({ success: true, avatars: [avatar] })
    expect(service.readMany).toHaveBeenCalledTimes(2)
  })

  it('rejects an oversized batch before constructing a repository query', async () => {
    const service = fakeService()
    registerCharacterAvatarController({ resolveService: () => service as unknown as CharacterAssetService })
    const result = await mocks.handlers.get('character-avatar:read-batch')!(event,
      Array.from({ length: 257 }, (_, index) => `stable-${index}`), context)
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_CHARACTER_ID' } })
    expect(service.repository.readMany).not.toHaveBeenCalled()
  })
})
