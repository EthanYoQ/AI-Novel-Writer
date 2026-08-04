import { ipcMain, shell } from 'electron'

import {
  isModelProviderResourceId,
  MODEL_PROVIDER_RESOURCE_URLS,
} from '../../src/shared/model-provider-resources'

export interface ModelProviderResourceControllerOptions {
  /** Injectable boundary for deterministic handling without exposing shell to the renderer. */
  openExternal?: (url: string) => Promise<void>
  ipc?: Pick<typeof ipcMain, 'handle'>
}

/** Opens only fixed, allowlisted model-provider destinations in the system browser. */
export function registerModelProviderResourceController({
  openExternal = url => shell.openExternal(url),
  ipc = ipcMain,
}: ModelProviderResourceControllerOptions = {}) {
  ipc.handle('model-provider-resource:open', async (_event, resource: unknown) => {
    if (!isModelProviderResourceId(resource)) {
      return { success: false, error: 'Unsupported model provider resource.' }
    }

    try {
      await openExternal(MODEL_PROVIDER_RESOURCE_URLS[resource])
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open model provider resource.', error)
      return { success: false, error: 'Unable to open the model provider resource.' }
    }
  })
}
