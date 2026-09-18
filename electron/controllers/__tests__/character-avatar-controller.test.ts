import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_CHARACTER_AVATAR_INPUT_BYTES } from '../../../src/shared/character-avatar'

type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
  projectPath: { value: null as string | null },
  /** 角色名 → 头像文件名，模拟 characters.avatar 列。 */
  characters: new Map<string, string>(),
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

vi.mock('../../i18n', () => ({
  mainText: (_locale: string, zh: string) => zh,
}))

vi.mock('../../database', () => ({
  getCurrentProjectPath: () => mocks.projectPath.value,
}))

vi.mock('../../repositories/character-repository', () => ({
  CharacterRepository: {
    getByName: (name: string) => (mocks.characters.has(name) ? { name } : null),
    getAvatarFileName: (name: string) => mocks.characters.get(name) ?? '',
    setAvatar: (name: string, fileName: string) => {
      if (!mocks.characters.has(name)) return false
      mocks.characters.set(name, fileName)
      return true
    },
  },
}))

import { registerCharacterAvatarController } from '../character-avatar-controller'

const temporaryRoots: string[] = []

function temporaryProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-avatar-'))
  temporaryRoots.push(root)
  return root
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, 0x01),
  ])
}

function writeSourceImage(bytes: Buffer, name = 'source.png'): string {
  const root = temporaryProject()
  const filePath = path.join(root, name)
  fs.writeFileSync(filePath, bytes)
  return filePath
}

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function liveEvent() {
  return { sender: { id: 17, isDestroyed: () => false } }
}

function avatarsDirectory(): string {
  return path.join(mocks.projectPath.value as string, '.vela', 'avatars')
}

function storedFiles(): string[] {
  return fs.existsSync(avatarsDirectory()) ? fs.readdirSync(avatarsDirectory()) : []
}

describe('character avatar IPC boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
    mocks.characters.clear()
    mocks.characters.set('李莉莉', '')
    mocks.projectPath.value = temporaryProject()
    registerCharacterAvatarController()
  })

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('registers the avatar channels: choose / commit / read / remove', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'character-avatar:choose',
      'character-avatar:commit',
      'character-avatar:read',
      'character-avatar:remove',
    ])
  })

  it('reports no custom avatar as a plain null instead of an error', async () => {
    const result = await handler('character-avatar:read')(liveEvent(), '李莉莉')
    expect(result).toEqual({ success: true, avatar: null })
  })

  it('rejects a dead sender, a non-string name, and a path-shaped name', async () => {
    const dead = { sender: { id: 17, isDestroyed: () => true } }
    expect(await handler('character-avatar:read')(dead, '李莉莉')).toMatchObject({
      success: false,
      error: { code: 'INVALID_SENDER' },
    })
    expect(await handler('character-avatar:read')(liveEvent(), 42)).toMatchObject({
      success: false,
      error: { code: 'INVALID_NAME' },
    })
    expect(await handler('character-avatar:read')(liveEvent(), '../../etc/passwd')).toMatchObject({
      success: false,
      error: { code: 'INVALID_NAME' },
    })
  })

  it('refuses to touch the disk when no project is open', async () => {
    mocks.projectPath.value = null
    expect(await handler('character-avatar:choose')(liveEvent(), '李莉莉')).toMatchObject({
      success: false,
      error: { code: 'PROJECT_NOT_OPEN' },
    })
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()
  })

  it('treats a cancelled picker as a consumable success', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await handler('character-avatar:choose')(liveEvent(), '李莉莉')).toEqual({
      success: true,
      cancelled: true,
    })
  })

  /**
   * 先生（头像逻辑）：编辑态选图只是草稿 —— 此刻绝不能落盘或写库，
   * 否则「放弃编辑」就会留下一张已经生效的头像。
   */
  it('choose returns preview bytes and writes nothing to disk or database', async () => {
    const bytes = pngBytes()
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [writeSourceImage(bytes)] })

    const result = await handler('character-avatar:choose')(liveEvent(), '李莉莉') as {
      success: true
      cancelled: false
      image: { name: string; mime: string; base64: string }
    }

    expect(result.success).toBe(true)
    expect(result.image.mime).toBe('image/png')
    expect(Buffer.from(result.image.base64, 'base64').equals(bytes)).toBe(true)
    expect(storedFiles()).toEqual([])
    expect(mocks.characters.get('李莉莉')).toBe('')
    // 渲染层只拿到 base64，从不接触落盘路径。
    expect(JSON.stringify(result)).not.toContain('.vela')
  })

  it('trusts the magic number over the file extension', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [writeSourceImage(Buffer.from('not an image'), 'fake.png')] })
    expect(await handler('character-avatar:choose')(liveEvent(), '李莉莉')).toMatchObject({
      success: false,
      error: { code: 'IMAGE_FORMAT_INVALID' },
    })
    expect(storedFiles()).toEqual([])
  })

  it('rejects an oversized image without writing anything', async () => {
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(MAX_CHARACTER_AVATAR_INPUT_BYTES + 1, 0x01),
    ])
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [writeSourceImage(oversized)] })
    expect(await handler('character-avatar:choose')(liveEvent(), '李莉莉')).toMatchObject({
      success: false,
      error: { code: 'IMAGE_TOO_LARGE' },
    })
    expect(storedFiles()).toEqual([])
  })

  it('commit stores the staged bytes under .vela/avatars and records only the file name', async () => {
    const bytes = pngBytes()
    const result = await handler('character-avatar:commit')(
      liveEvent(),
      '李莉莉',
      bytes.toString('base64'),
    ) as { success: true; avatar: { mime: string } }

    expect(result.success).toBe(true)
    expect(result.avatar.mime).toBe('image/png')

    const storedName = mocks.characters.get('李莉莉') as string
    expect(storedName).toMatch(/^[0-9a-f]{16}\.png$/)
    expect(fs.readFileSync(path.join(avatarsDirectory(), storedName)).equals(bytes)).toBe(true)
  })

  it('commit refuses bytes that are not a real image and leaves the archive untouched', async () => {
    expect(await handler('character-avatar:commit')(liveEvent(), '李莉莉', Buffer.from('nope').toString('base64')))
      .toMatchObject({ success: false, error: { code: 'IMAGE_FORMAT_INVALID' } })
    expect(await handler('character-avatar:commit')(liveEvent(), '李莉莉', '')).toMatchObject({
      success: false,
      error: { code: 'IMAGE_FORMAT_INVALID' },
    })
    expect(storedFiles()).toEqual([])
    expect(mocks.characters.get('李莉莉')).toBe('')
  })

  it('refuses a stored name that is not a bare avatar file name', async () => {
    mocks.characters.set('李莉莉', '../../../secrets.png')
    expect(await handler('character-avatar:read')(liveEvent(), '李莉莉')).toEqual({
      success: true,
      avatar: null,
    })
  })

  it('round-trips commit, read, and remove against the stored file', async () => {
    const bytes = pngBytes()
    await handler('character-avatar:commit')(liveEvent(), '李莉莉', bytes.toString('base64'))
    const storedName = mocks.characters.get('李莉莉') as string
    const storedPath = path.join(avatarsDirectory(), storedName)

    const read = await handler('character-avatar:read')(liveEvent(), '李莉莉') as {
      success: true
      avatar: { mime: string; base64: string }
    }
    expect(read.success).toBe(true)
    expect(read.avatar.mime).toBe('image/png')

    expect(await handler('character-avatar:remove')(liveEvent(), '李莉莉')).toEqual({ success: true })
    expect(mocks.characters.get('李莉莉')).toBe('')
    expect(fs.existsSync(storedPath)).toBe(false)
  })

  it('replaces the previous extension instead of leaving an orphan image behind', async () => {
    const png = pngBytes()
    await handler('character-avatar:commit')(liveEvent(), '李莉莉', png.toString('base64'))
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16, 0x02)])
    await handler('character-avatar:commit')(liveEvent(), '李莉莉', jpeg.toString('base64'))

    expect(storedFiles()).toEqual([mocks.characters.get('李莉莉')])
    expect(mocks.characters.get('李莉莉')).toMatch(/^[0-9a-f]{16}\.jpg$/)
  })

  it('falls back to the initial avatar when the stored file disappeared', async () => {
    const bytes = pngBytes()
    await handler('character-avatar:commit')(liveEvent(), '李莉莉', bytes.toString('base64'))
    const storedName = mocks.characters.get('李莉莉') as string
    fs.rmSync(path.join(avatarsDirectory(), storedName))

    expect(await handler('character-avatar:read')(liveEvent(), '李莉莉')).toEqual({
      success: true,
      avatar: null,
    })
  })
})
