import fs from 'node:fs'

import { app, dialog, ipcMain } from 'electron'

import type {
  SkinCommand,
  SkinError,
  SkinErrorCode,
  SkinExecuteResponse,
  SkinOperationFailure,
  SkinReadCustomAssetResponse,
  SkinState,
} from '../../src/shared/skin-types'
import { mainText } from '../i18n'
import {
  skinService,
  type SkinService,
  type SkinServiceAssetResult,
  type SkinServiceResult,
} from '../services/skin-service'

const CLASSIC_STATE: SkinState = { activeSkin: 'classic', customSkin: null }

type SkinEvent = {
  sender?: {
    id?: number
    isDestroyed?: () => boolean
  }
}

type SkinControllerService = Pick<
  SkinService,
  'getState' | 'activate' | 'importCustomAsset' | 'removeCustom' | 'readCustomAsset'
>

function text(zhCNText: string, enUSText: string): string {
  return mainText(app.getLocale(), zhCNText, enUSText)
}

function errorFor(code: SkinErrorCode): SkinError {
  switch (code) {
    case 'INVALID_COMMAND':
      return { code, message: text('皮肤操作无效，已拒绝执行。', 'The skin operation is invalid and was rejected.') }
    case 'INVALID_SENDER':
      return { code, message: text('当前窗口无权执行皮肤操作。', 'This window is not allowed to change the skin.') }
    case 'CUSTOM_SKIN_UNAVAILABLE':
      return { code, message: text('自定义皮肤不可用，请先导入图片。', 'The custom skin is unavailable. Import an image first.') }
    case 'CUSTOM_ASSET_UNAVAILABLE':
      return { code, message: text('自定义皮肤资源不可用，已切换为经典皮肤。', 'The custom skin asset is unavailable. The classic skin is active.') }
    case 'IMAGE_READ_FAILED':
      return { code, message: text('无法读取所选图片，请重新选择。', 'The selected image could not be read. Please choose it again.') }
    case 'IMAGE_FORMAT_INVALID':
      return { code, message: text('请选择有效的 PNG 或 JPEG 图片。', 'Choose a valid PNG or JPEG image.') }
    case 'IMAGE_TOO_LARGE':
      return { code, message: text('图片不能超过 20MB。', 'The image must not exceed 20MB.') }
    case 'IMAGE_DECODE_FAILED':
      return { code, message: text('图片无法解码，请重新选择。', 'The image could not be decoded. Please choose another one.') }
    case 'IMAGE_DIMENSIONS_INVALID':
      return { code, message: text('图片尺寸无效，无法作为皮肤使用。', 'The image dimensions are invalid for a skin.') }
    case 'SKIN_STORAGE_FAILED':
      return { code, message: text('保存皮肤失败，当前皮肤未改变。', 'The skin could not be saved; the current skin was not changed.') }
    case 'SKIN_SERVICE_UNAVAILABLE':
      return { code, message: text('皮肤服务暂不可用。', 'The skin service is unavailable.') }
  }
}

function validSender(event: SkinEvent): boolean {
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isSkinCommand(value: unknown): value is SkinCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const command = value as Record<string, unknown>
  if (command.type === 'activate') {
    return hasExactKeys(command, ['type', 'skinId'])
      && (command.skinId === 'classic' || command.skinId === 'anime' || command.skinId === 'custom')
  }
  return (command.type === 'import-custom' || command.type === 'remove-custom')
    && hasExactKeys(command, ['type'])
}

function failure(state: SkinState, code: SkinErrorCode): SkinOperationFailure {
  return { success: false, state, error: errorFor(code) }
}

function operationResponse(result: SkinServiceResult): SkinExecuteResponse {
  return result.success
    ? { success: true, state: result.state }
    : failure(result.state, result.code)
}

function assetResponse(result: SkinServiceAssetResult): SkinReadCustomAssetResponse {
  return result.success
    ? { success: true, ...result.asset }
    : failure(result.state, result.code)
}

function safeState(service: SkinControllerService): SkinState {
  try {
    return service.getState()
  } catch {
    return CLASSIC_STATE
  }
}

function safeOperation(
  service: SkinControllerService,
  operation: () => SkinServiceResult,
): SkinExecuteResponse {
  try {
    return operationResponse(operation())
  } catch {
    return failure(safeState(service), 'SKIN_SERVICE_UNAVAILABLE')
  }
}

function safeAssetResponse(service: SkinControllerService): SkinReadCustomAssetResponse {
  try {
    return assetResponse(service.readCustomAsset())
  } catch {
    return failure(safeState(service), 'SKIN_SERVICE_UNAVAILABLE')
  }
}

/**
 * The renderer can name a skin action but never provides a path or image bytes.
 * The only source path exists between Electron's file dialog and this controller.
 */
export function registerSkinController(service: SkinControllerService = skinService): void {
  ipcMain.handle('skin:get-state', (event: SkinEvent): SkinState => {
    return validSender(event) ? safeState(service) : CLASSIC_STATE
  })

  ipcMain.handle('skin:execute', async (event: SkinEvent, input: unknown): Promise<SkinExecuteResponse> => {
    const state = safeState(service)
    if (!validSender(event)) return failure(state, 'INVALID_SENDER')
    if (!isSkinCommand(input)) return failure(state, 'INVALID_COMMAND')

    if (input.type === 'activate') return safeOperation(service, () => service.activate(input.skinId))
    if (input.type === 'remove-custom') return safeOperation(service, () => service.removeCustom())

    let selected: { canceled: boolean; filePaths: string[] }
    try {
      selected = await dialog.showOpenDialog({
        title: text('选择自定义皮肤图片', 'Choose a custom skin image'),
        properties: ['openFile'],
        filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
      })
    } catch {
      return failure(safeState(service), 'IMAGE_READ_FAILED')
    }
    if (selected.canceled || selected.filePaths.length === 0) {
      return { success: true, cancelled: true, state: safeState(service) }
    }
    if (selected.filePaths.length !== 1) return failure(safeState(service), 'IMAGE_READ_FAILED')

    let bytes: Buffer
    try {
      bytes = fs.readFileSync(selected.filePaths[0])
    } catch {
      return failure(safeState(service), 'IMAGE_READ_FAILED')
    }
    return safeOperation(service, () => service.importCustomAsset(bytes))
  })

  ipcMain.handle('skin:read-custom-asset', (event: SkinEvent): SkinReadCustomAssetResponse => {
    const state = safeState(service)
    if (!validSender(event)) return failure(state, 'INVALID_SENDER')
    return safeAssetResponse(service)
  })
}
