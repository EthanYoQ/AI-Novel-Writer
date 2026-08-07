import { create } from 'zustand'

import { ipc } from '../services/ipc-client'
import type {
  SkinAsset,
  SkinCommand,
  SkinExecuteResponse,
  SkinId,
  SkinReadCustomAssetResponse,
  SkinState,
} from '../shared/skin-types'

const CLASSIC_SKIN_STATE: SkinState = {
  activeSkin: 'classic',
  customSkin: null,
}

export interface SkinNotice {
  zh: string
  en: string
}

export interface SkinTransport {
  invoke(channel: 'skin:get-state'): Promise<SkinState>
  invoke(channel: 'skin:execute', command: SkinCommand): Promise<SkinExecuteResponse>
  invoke(channel: 'skin:read-custom-asset'): Promise<SkinReadCustomAssetResponse>
}

export interface SkinStoreDependencies {
  transport?: SkinTransport
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

export interface SkinStoreState {
  skinState: SkinState
  /** 已解码为 renderer 可消费的临时 URL；classic 与未就绪状态均为 null。 */
  backgroundUrl: string | null
  /** 失败只在设置页显示为轻量提示，绝不阻断创作界面。 */
  notice: SkinNotice | null
  init: () => Promise<void>
  activateSkin: (skinId: SkinId) => Promise<boolean>
  importCustomSkin: () => Promise<boolean>
  removeCustomSkin: () => Promise<boolean>
  /** Browser image decoding/network failure after a successful IPC response. */
  recoverFromImageFailure: () => Promise<void>
  dismissNotice: () => void
  /** App 卸载时调用，确保 Blob URL 不会在 renderer 生命周期外残留。 */
  dispose: () => void
}

function invokeRendererSkin(channel: 'skin:get-state'): Promise<SkinState>
function invokeRendererSkin(channel: 'skin:execute', command: SkinCommand): Promise<SkinExecuteResponse>
function invokeRendererSkin(channel: 'skin:read-custom-asset'): Promise<SkinReadCustomAssetResponse>
function invokeRendererSkin(
  channel: 'skin:get-state' | 'skin:execute' | 'skin:read-custom-asset',
  command?: SkinCommand,
): Promise<unknown> {
  if (channel === 'skin:execute') return ipc.invoke('skin:execute', command as SkinCommand)
  if (channel === 'skin:get-state') return ipc.invoke('skin:get-state')
  return ipc.invoke('skin:read-custom-asset')
}

const rendererSkinTransport: SkinTransport = { invoke: invokeRendererSkin }

function isReadableAsset(response: SkinReadCustomAssetResponse): response is { success: true } & SkinAsset {
  return response.success
}

function sameAssetMetadata(state: SkinState, asset: SkinAsset): boolean {
  return state.customSkin?.revision === asset.revision
    && state.customSkin.mime === asset.mime
}

function fallbackNotice(): SkinNotice {
  return {
    zh: '图片皮肤无法加载，已恢复经典皮肤。',
    en: 'The image skin could not be loaded. Reverted to Classic.',
  }
}

/**
 * 为真实 renderer 和测试提供同一条状态边界。图片字节永不持久化到 Zustand；
 * renderer 只保存当前 Blob URL，且在替换或卸载时立即回收。
 */
export function createSkinStore(dependencies: SkinStoreDependencies = {}) {
  const transport = dependencies.transport ?? rendererSkinTransport
  const createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL)
  const revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL)

  return create<SkinStoreState>()((set, get) => {
    const revokeBackgroundUrl = (url = get().backgroundUrl) => {
      if (!url) return
      try {
        revokeObjectURL(url)
      } catch {
        // 浏览器已释放 URL 时不应让设置页产生新的阻断错误。
      }
    }

    const applyClassicFallback = (source: SkinState) => {
      revokeBackgroundUrl()
      set({
        skinState: { ...source, activeSkin: 'classic' },
        backgroundUrl: null,
        notice: fallbackNotice(),
      })
    }

    const applySkinState = async (nextState: SkinState): Promise<boolean> => {
      if (nextState.activeSkin !== 'custom') {
        revokeBackgroundUrl()
        set({ skinState: nextState, backgroundUrl: null, notice: null })
        return true
      }

      if (!nextState.customSkin) {
        applyClassicFallback(nextState)
        return false
      }

      const current = get()
      if (
        current.skinState.activeSkin === 'custom'
        && current.backgroundUrl
        && current.skinState.customSkin?.revision === nextState.customSkin.revision
      ) {
        set({ skinState: nextState, notice: null })
        return true
      }

      try {
        const response = await transport.invoke('skin:read-custom-asset')
        if (!isReadableAsset(response) || !sameAssetMetadata(nextState, response)) {
          applyClassicFallback(nextState)
          return false
        }

        const bytes = new Uint8Array(response.bytes.byteLength)
        bytes.set(response.bytes)
        const nextUrl = createObjectURL(new Blob([bytes], { type: response.mime }))
        revokeBackgroundUrl()
        set({ skinState: nextState, backgroundUrl: nextUrl, notice: null })
        return true
      } catch {
        applyClassicFallback(nextState)
        return false
      }
    }

    const execute = async (command: SkinCommand): Promise<boolean> => {
      try {
        const response = await transport.invoke('skin:execute', command)
        if (!response.success) {
          applyClassicFallback(response.state)
          return false
        }
        if (response.cancelled) {
          // 文件选择器取消是可消费的成功结果：保留当前预览和无错误状态。
          set({ skinState: response.state, notice: null })
          return true
        }
        return applySkinState(response.state)
      } catch {
        applyClassicFallback(get().skinState)
        return false
      }
    }

    return {
      skinState: CLASSIC_SKIN_STATE,
      backgroundUrl: null,
      notice: null,
      async init() {
        try {
          const nextState = await transport.invoke('skin:get-state')
          await applySkinState(nextState)
        } catch {
          applyClassicFallback(get().skinState)
        }
      },
      activateSkin: (skinId) => execute({ type: 'activate', skinId }),
      importCustomSkin: () => execute({ type: 'import-custom' }),
      removeCustomSkin: () => execute({ type: 'remove-custom' }),
      async recoverFromImageFailure() {
        const recovered = await execute({ type: 'activate', skinId: 'classic' })
        if (recovered) set({ notice: fallbackNotice() })
      },
      dismissNotice: () => set({ notice: null }),
      dispose() {
        revokeBackgroundUrl()
        set({ backgroundUrl: null })
      },
    }
  })
}

export const useSkinStore = createSkinStore()
