import { app, dialog, ipcMain } from 'electron'
import type { ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import type {
  CharacterAvatarBatchReadResponse,
  CharacterAvatarChooseResponse,
  CharacterAvatarCommitResponse,
  CharacterAvatarError,
  CharacterAvatarErrorCode,
  CharacterAvatarRemoveResponse,
  CharacterAvatarView,
} from '../../src/shared/character-avatar'
import { mainText } from '../i18n'
import type { CharacterAssetService } from '../services/character-asset-service'

interface AvatarEvent {
  sender?: { id?: number; isDestroyed?: () => boolean }
}

export interface CharacterAvatarControllerDependencies {
  /** Must validate event + projectId + leaseId + canonical root before returning. */
  resolveService(event: AvatarEvent, context: ProjectSessionContext): CharacterAssetService | null
}

function text(zh: string, en: string): string { return mainText(app.getLocale(), zh, en) }

function failure(code: CharacterAvatarErrorCode): CharacterAvatarError {
  const messages: Record<CharacterAvatarErrorCode, [string, string]> = {
    INVALID_SENDER: ['当前窗口无权访问角色头像。', 'This window cannot access character avatars.'],
    INVALID_CHARACTER_ID: ['角色身份无效，头像未修改。', 'The character identity is invalid.'],
    PROJECT_NOT_OPEN: ['尚未打开项目，无法访问头像。', 'No project is open.'],
    CHARACTER_NOT_FOUND: ['该角色已不存在，头像未修改。', 'That character no longer exists.'],
    IMAGE_READ_FAILED: ['无法读取所选图片，请重新选择。', 'The selected image could not be read.'],
    IMAGE_FORMAT_INVALID: ['请选择有效的 PNG、JPEG 或 WebP 图片。', 'Choose a valid PNG, JPEG, or WebP image.'],
    IMAGE_TOO_LARGE: ['图片超过 4 MB，请换一张更小的。', 'The image is larger than 4 MB.'],
    AVATAR_SAVE_FAILED: ['头像保存失败，原头像保持不变。', 'The avatar could not be saved; the previous avatar is unchanged.'],
  }
  const [zh, en] = messages[code]
  return { code, message: text(zh, en) }
}

function validSender(event: AvatarEvent): boolean {
  return Boolean(event.sender && Number.isSafeInteger(event.sender.id) && (event.sender.id ?? 0) > 0
    && typeof event.sender.isDestroyed === 'function' && !event.sender.isDestroyed())
}

function errorCode(error: unknown): CharacterAvatarErrorCode {
  if (error instanceof Error && [
    'INVALID_CHARACTER_ID', 'CHARACTER_NOT_FOUND', 'IMAGE_READ_FAILED', 'IMAGE_FORMAT_INVALID', 'IMAGE_TOO_LARGE',
  ].includes(error.message)) return error.message as CharacterAvatarErrorCode
  return 'AVATAR_SAVE_FAILED'
}
const CHARACTER_ID = /^[a-zA-Z0-9_-]{1,128}$/u

function serviceFor(deps: CharacterAvatarControllerDependencies, event: AvatarEvent, context: ProjectSessionContext): CharacterAssetService | null {
  if (!validSender(event) || !isProjectSessionContext(context)) return null
  return deps.resolveService(event, context)
}

export function registerCharacterAvatarController(deps: CharacterAvatarControllerDependencies): void {
  let mutationTail: Promise<void> = Promise.resolve()
  const cache = new Map<string, CharacterAvatarView>()
  let activeScope = ''
  const serialize = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const scheduled = mutationTail.then(operation, operation)
    mutationTail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }
  const scopePrefix = (context: ProjectSessionContext) => `${context.projectId}\u0000${context.leaseId}\u0000`
  const enterScope = (context: ProjectSessionContext) => {
    const next = scopePrefix(context)
    if (activeScope && activeScope !== next) cache.clear()
    activeScope = next
  }
  const invalidate = (context: ProjectSessionContext, characterId: string) => {
    const prefix = `${scopePrefix(context)}${characterId}\u0000`
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
  }

  ipcMain.handle('character-avatar:choose', (event: AvatarEvent, characterId: string, context: ProjectSessionContext): Promise<CharacterAvatarChooseResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, error: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, error: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    if (!service.hasCharacter(characterId)) return { success: false, error: failure('CHARACTER_NOT_FOUND') }
    let selection: Awaited<ReturnType<typeof dialog.showOpenDialog>>
    try { selection = await dialog.showOpenDialog({ title: text('选择角色头像', 'Choose a character avatar'),
      properties: ['openFile'], filters: [{ name: 'PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }) }
    catch { return { success: false, error: failure('IMAGE_READ_FAILED') } }
    if (selection.canceled || selection.filePaths.length === 0) return { success: true, cancelled: true }
    if (selection.filePaths.length !== 1) return { success: false, error: failure('IMAGE_READ_FAILED') }
    try { return { success: true, cancelled: false, image: await service.previewFile(characterId, selection.filePaths[0]!) } }
    catch (error) { return { success: false, error: failure(errorCode(error)) } }
  }))

  ipcMain.handle('character-avatar:commit', (event: AvatarEvent, characterId: string, base64: string, context: ProjectSessionContext): Promise<CharacterAvatarCommitResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, error: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, error: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try {
      const avatar = service.commit(characterId, base64)
      invalidate(context, characterId)
      return { success: true, avatar }
    } catch (error) { return { success: false, error: failure(errorCode(error)) } }
  }))

  ipcMain.handle('character-avatar:read-batch', async (event: AvatarEvent, characterIds: string[], context: ProjectSessionContext): Promise<CharacterAvatarBatchReadResponse> => {
    if (!validSender(event)) return { success: false, error: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, error: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try {
      if (!Array.isArray(characterIds) || characterIds.length > 256
        || characterIds.some(id => typeof id !== 'string' || !CHARACTER_ID.test(id))) throw new Error('INVALID_CHARACTER_ID')
      const records = service.repository.readMany([...new Set(characterIds)])
      const result: CharacterAvatarView[] = []
      const missing: string[] = []
      for (const record of records) {
        const key = `${scopePrefix(context)}${record.characterId}\u0000${record.assetRevision}`
        const cached = cache.get(key)
        if (cached) result.push(cached)
        else missing.push(record.characterId)
      }
      for (const avatar of missing.length ? service.readMany(missing) : []) {
        cache.set(`${scopePrefix(context)}${avatar.characterId}\u0000${avatar.assetRevision}`, avatar)
        if (cache.size > 512) cache.delete(cache.keys().next().value!)
        result.push(avatar)
      }
      return { success: true, avatars: result }
    } catch (error) { return { success: false, error: failure(errorCode(error)) } }
  })

  ipcMain.handle('character-avatar:remove', (event: AvatarEvent, characterId: string, context: ProjectSessionContext): Promise<CharacterAvatarRemoveResponse> => serialize(async () => {
    if (!validSender(event)) return { success: false, error: failure('INVALID_SENDER') }
    const service = serviceFor(deps, event, context)
    if (!service) return { success: false, error: failure('PROJECT_NOT_OPEN') }
    enterScope(context)
    try { service.remove(characterId); invalidate(context, characterId); return { success: true } }
    catch (error) { return { success: false, error: failure(errorCode(error)) } }
  }))
}
