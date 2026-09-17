/**
 * CharacterAvatarController — 角色自定义头像
 *
 * 形态对齐 skin-controller：renderer 只能说出「给哪个角色换头像」，
 * 路径与图片字节都只存在于主进程。选图 → 校验 → 落盘 → 记文件名，一步到位。
 *
 * 存储：<项目>/.vela/avatars/<sha1(角色名)[0:16]>.<ext>
 *   文件名与角色名解耦，因此角色改名后头像自然跟随（characters 行的 name
 *   改名时 avatar 列原样保留），也不会把中文名写进文件系统路径。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, dialog, ipcMain } from 'electron'

import type {
  CharacterAvatarChooseResponse,
  CharacterAvatarCommitResponse,
  CharacterAvatarError,
  CharacterAvatarErrorCode,
  CharacterAvatarReadResponse,
  CharacterAvatarRemoveResponse,
  CharacterAvatarView,
} from '../../src/shared/character-avatar'
import { MAX_CHARACTER_AVATAR_INPUT_BYTES } from '../../src/shared/character-avatar'
import { getCurrentProjectPath } from '../database'
import { mainText } from '../i18n'
import { CharacterRepository } from '../repositories/character-repository'
import { compressAvatarImage } from '../services/avatar-image'

type AvatarEvent = {
  sender?: {
    id?: number
    isDestroyed?: () => boolean
  }
}

const AVATAR_DIR_NAME = 'avatars'
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const
type AllowedExtension = typeof ALLOWED_EXTENSIONS[number]

/** 落盘文件名的严格形状：sha1 前 16 位十六进制 + 允许的扩展名。 */
const AVATAR_FILE_PATTERN = /^[0-9a-f]{16}\.(png|jpg|jpeg|webp)$/

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function errorFor(code: CharacterAvatarErrorCode): CharacterAvatarError {
  switch (code) {
    case 'INVALID_SENDER':
      return { code, message: text('当前窗口无权修改角色头像。', 'This window is not allowed to change character avatars.') }
    case 'INVALID_NAME':
      return { code, message: text('角色名无效，头像未修改。', 'The character name is invalid; the avatar was not changed.') }
    case 'PROJECT_NOT_OPEN':
      return { code, message: text('尚未打开项目，无法保存头像。', 'No project is open, so the avatar cannot be saved.') }
    case 'CHARACTER_NOT_FOUND':
      return { code, message: text('该角色已不存在，头像未修改。', 'That character no longer exists; the avatar was not changed.') }
    case 'IMAGE_READ_FAILED':
      return { code, message: text('无法读取所选图片，请重新选择。', 'The selected image could not be read. Please choose it again.') }
    case 'IMAGE_FORMAT_INVALID':
      return { code, message: text('请选择有效的 PNG、JPEG 或 WebP 图片。', 'Choose a valid PNG, JPEG, or WebP image.') }
    case 'IMAGE_TOO_LARGE':
      return { code, message: text('图片超过 4 MB，请换一张更小的。', 'The image is larger than 4 MB. Please choose a smaller one.') }
    case 'AVATAR_SAVE_FAILED':
      return { code, message: text('头像保存失败，原头像保持不变。', 'The avatar could not be saved; the previous avatar is unchanged.') }
  }
}

function validSender(event: AvatarEvent): boolean {
  const sender = event?.sender
  return Boolean(
    sender
    && typeof sender.id === 'number'
    && Number.isSafeInteger(sender.id)
    && sender.id > 0
    && typeof sender.isDestroyed === 'function'
    && !sender.isDestroyed(),
  )
}

function normalizeCharacterName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > 200) return null
  // 角色名会成为 SQL 参数，永远不会成为路径片段；这里只挡控制字符与目录分隔符。
  // 这个正则是**有意的安全防护**（拦控制字符注入），no-control-regex 在此属误伤。
  // eslint-disable-next-line no-control-regex -- 有意拦截控制字符，见上一行注释
  if (/[\u0000-\u001f/\\]/.test(name)) return null
  return name
}

function avatarsDirectory(projectPath: string): string {
  return path.join(projectPath, '.vela', AVATAR_DIR_NAME)
}

function avatarFileNameFor(characterName: string, extension: AllowedExtension): string {
  const digest = crypto.createHash('sha1').update(characterName, 'utf8').digest('hex').slice(0, 16)
  return `${digest}.${extension}`
}

function mimeForExtension(extension: string): string {
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/** 扩展名只作线索，真正的格式判断看魔数，避免伪造后缀的名不副实文件。 */
function detectExtension(bytes: Buffer): AllowedExtension | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg'
  }
  if (bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp'
  }
  return null
}

async function readSelectedImage(filePath: string): Promise<Buffer> {
  const selectedStat = await fs.promises.stat(filePath).catch(() => null)
  if (!selectedStat || !selectedStat.isFile() || !Number.isSafeInteger(selectedStat.size)) {
    throw new Error('IMAGE_READ_FAILED')
  }
  if (selectedStat.size <= 0) throw new Error('IMAGE_READ_FAILED')
  if (selectedStat.size > MAX_CHARACTER_AVATAR_INPUT_BYTES) throw new Error('IMAGE_TOO_LARGE')

  const handle = await fs.promises.open(filePath, 'r')
  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile() || openedStat.size !== selectedStat.size) {
      throw new Error('IMAGE_READ_FAILED')
    }
    if (openedStat.size > MAX_CHARACTER_AVATAR_INPUT_BYTES) throw new Error('IMAGE_TOO_LARGE')
    const bytes = Buffer.allocUnsafe(openedStat.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead <= 0) throw new Error('IMAGE_READ_FAILED')
      offset += bytesRead
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function viewOf(name: string, fileName: string, bytes: Buffer): CharacterAvatarView {
  const extension = path.extname(fileName).slice(1).toLowerCase()
  return { name, mime: mimeForExtension(extension), base64: bytes.toString('base64') }
}

function resolveStoredAvatarPath(projectPath: string, fileName: string): string | null {
  if (!AVATAR_FILE_PATTERN.test(fileName)) return null
  const directory = avatarsDirectory(projectPath)
  const resolved = path.resolve(directory, fileName)
  const root = path.resolve(directory)
  if (resolved !== path.join(root, fileName)) return null
  return resolved
}

/** 删除该角色此前可能存在的其它后缀头像，避免同一次更换留下孤儿文件。 */
async function removeOtherAvatarsFor(projectPath: string, characterName: string, keepFileName: string): Promise<void> {
  const directory = avatarsDirectory(projectPath)
  const digest = crypto.createHash('sha1').update(characterName, 'utf8').digest('hex').slice(0, 16)
  for (const extension of ALLOWED_EXTENSIONS) {
    const candidate = `${digest}.${extension}`
    if (candidate === keepFileName) continue
    await fs.promises.rm(path.join(directory, candidate), { force: true }).catch(() => undefined)
  }
}

export function registerCharacterAvatarController(): void {
  // 选图是异步的：把状态变更按到达顺序串行化，后一次选择始终是最终结果。
  let mutationTail: Promise<void> = Promise.resolve()
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const scheduled = mutationTail.then(operation, operation)
    mutationTail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }

  /**
   * 只选图：校验通过后回传预览字节，**不落盘、不写库**。
   * 落盘推迟到角色卡保存成功后的 commit，编辑中途放弃时不留任何痕迹。
   */
  ipcMain.handle('character-avatar:choose', (event: AvatarEvent, rawName: unknown): Promise<CharacterAvatarChooseResponse> => {
    return serializeMutation(async () => {
      if (!validSender(event)) return { success: false, error: errorFor('INVALID_SENDER') } as const
      const name = normalizeCharacterName(rawName)
      if (!name) return { success: false, error: errorFor('INVALID_NAME') } as const
      if (!getCurrentProjectPath()) return { success: false, error: errorFor('PROJECT_NOT_OPEN') } as const
      if (!CharacterRepository.getByName(name)) {
        return { success: false, error: errorFor('CHARACTER_NOT_FOUND') } as const
      }

      let selected: { canceled: boolean; filePaths: string[] }
      try {
        selected = await dialog.showOpenDialog({
          title: text(`为「${name}」选择头像图片`, `Choose an avatar image for "${name}"`),
          properties: ['openFile'],
          filters: [{ name: 'PNG / JPEG / WebP', extensions: [...ALLOWED_EXTENSIONS] }],
        })
      } catch {
        return { success: false, error: errorFor('IMAGE_READ_FAILED') } as const
      }
      if (selected.canceled || selected.filePaths.length === 0) {
        return { success: true, cancelled: true } as const
      }
      if (selected.filePaths.length !== 1) {
        return { success: false, error: errorFor('IMAGE_READ_FAILED') } as const
      }

      let bytes: Buffer
      try {
        bytes = await readSelectedImage(selected.filePaths[0])
      } catch (error) {
        const code = error instanceof Error && error.message === 'IMAGE_TOO_LARGE'
          ? 'IMAGE_TOO_LARGE'
          : 'IMAGE_READ_FAILED'
        return { success: false, error: errorFor(code) } as const
      }

      const extension = detectExtension(bytes)
      if (!extension) return { success: false, error: errorFor('IMAGE_FORMAT_INVALID') } as const

      return {
        success: true,
        cancelled: false,
        image: { name, mime: mimeForExtension(extension), base64: bytes.toString('base64') },
      } as const
    })
  })

  /** 真正落盘并记名 —— 只由角色卡保存成功后调用，与角色档案同进同退。 */
  ipcMain.handle('character-avatar:commit', (event: AvatarEvent, rawName: unknown, rawBase64: unknown): Promise<CharacterAvatarCommitResponse> => {
    return serializeMutation(async () => {
      if (!validSender(event)) return { success: false, error: errorFor('INVALID_SENDER') } as const
      const name = normalizeCharacterName(rawName)
      if (!name) return { success: false, error: errorFor('INVALID_NAME') } as const
      const projectPath = getCurrentProjectPath()
      if (!projectPath) return { success: false, error: errorFor('PROJECT_NOT_OPEN') } as const
      if (!CharacterRepository.getByName(name)) {
        return { success: false, error: errorFor('CHARACTER_NOT_FOUND') } as const
      }
      if (typeof rawBase64 !== 'string' || !rawBase64) {
        return { success: false, error: errorFor('IMAGE_FORMAT_INVALID') } as const
      }
      // 先挡超大负载：base64 约为原始字节的 4/3。
      if (rawBase64.length > Math.ceil(MAX_CHARACTER_AVATAR_INPUT_BYTES * 4 / 3) + 64) {
        return { success: false, error: errorFor('IMAGE_TOO_LARGE') } as const
      }

      let bytes: Buffer
      try {
        bytes = Buffer.from(rawBase64, 'base64')
      } catch {
        return { success: false, error: errorFor('IMAGE_FORMAT_INVALID') } as const
      }
      if (bytes.byteLength <= 0) return { success: false, error: errorFor('IMAGE_FORMAT_INVALID') } as const
      if (bytes.byteLength > MAX_CHARACTER_AVATAR_INPUT_BYTES) {
        return { success: false, error: errorFor('IMAGE_TOO_LARGE') } as const
      }
      // 二次确认魔数：渲染层回传的字节同样不可信。
      const extension = detectExtension(bytes)
      if (!extension) return { success: false, error: errorFor('IMAGE_FORMAT_INVALID') } as const

      /**
       * 落盘前压到最长边 256px（见 services/avatar-image.ts）。
       * 长篇后期角色可能上千个：原图直接存会把项目目录撑到 GB 级，
       * 关系图谱一次性读全员头像时也会把渲染层拖垮。
       * 压缩失败一律原样落盘 —— 宁可存一张大图，也不能让上传失败。
       */
      const compressed = compressAvatarImage(bytes, extension)
      const fileName = avatarFileNameFor(name, compressed.extension)
      try {
        const directory = avatarsDirectory(projectPath)
        await fs.promises.mkdir(directory, { recursive: true })
        await fs.promises.writeFile(path.join(directory, fileName), compressed.bytes)
        await removeOtherAvatarsFor(projectPath, name, fileName)
      } catch {
        return { success: false, error: errorFor('AVATAR_SAVE_FAILED') } as const
      }

      if (!CharacterRepository.setAvatar(name, fileName)) {
        return { success: false, error: errorFor('CHARACTER_NOT_FOUND') } as const
      }
      // 回传压缩后的字节：让渲染层的预览与磁盘上真正存的一致。
      return { success: true, avatar: viewOf(name, fileName, compressed.bytes) } as const
    })
  })

  ipcMain.handle('character-avatar:read', async (event: AvatarEvent, rawName: unknown): Promise<CharacterAvatarReadResponse> => {
    if (!validSender(event)) return { success: false, error: errorFor('INVALID_SENDER') }
    const name = normalizeCharacterName(rawName)
    if (!name) return { success: false, error: errorFor('INVALID_NAME') }
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: errorFor('PROJECT_NOT_OPEN') }

    const fileName = CharacterRepository.getAvatarFileName(name)
    if (!fileName) return { success: true, avatar: null }
    const avatarPath = resolveStoredAvatarPath(projectPath, fileName)
    if (!avatarPath) return { success: true, avatar: null }

    try {
      const bytes = await fs.promises.readFile(avatarPath)
      if (bytes.byteLength <= 0 || bytes.byteLength > MAX_CHARACTER_AVATAR_INPUT_BYTES) {
        return { success: true, avatar: null }
      }
      return { success: true, avatar: viewOf(name, fileName, bytes) }
    } catch {
      // 文件被外部删掉时按「无自定义头像」处理，回落到姓名首字头像，不打断创作界面。
      return { success: true, avatar: null }
    }
  })

  ipcMain.handle('character-avatar:remove', (event: AvatarEvent, rawName: unknown): Promise<CharacterAvatarRemoveResponse> => {
    return serializeMutation(async () => {
      if (!validSender(event)) return { success: false, error: errorFor('INVALID_SENDER') } as const
      const name = normalizeCharacterName(rawName)
      if (!name) return { success: false, error: errorFor('INVALID_NAME') } as const
      const projectPath = getCurrentProjectPath()
      if (!projectPath) return { success: false, error: errorFor('PROJECT_NOT_OPEN') } as const
      if (!CharacterRepository.getByName(name)) {
        return { success: false, error: errorFor('CHARACTER_NOT_FOUND') } as const
      }

      const fileName = CharacterRepository.getAvatarFileName(name)
      if (fileName) {
        const avatarPath = resolveStoredAvatarPath(projectPath, fileName)
        if (avatarPath) await fs.promises.rm(avatarPath, { force: true }).catch(() => undefined)
      }
      CharacterRepository.setAvatar(name, '')
      return { success: true } as const
    })
  })
}
