import { ipcMain, shell } from 'electron'

import { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

export { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

export interface OfficialHomepageControllerOptions {
  /** Test-only dependency seam used by the offline packaged qualification. */
  openExternal?: (url: string) => Promise<void>
  ipc?: Pick<typeof ipcMain, 'handle'>
}

/** Registers the fixed, no-argument intent for opening the project's official homepage. */
export function registerOfficialHomepageController({
  openExternal = url => shell.openExternal(url),
  ipc = ipcMain,
}: OfficialHomepageControllerOptions = {}) {
  ipc.handle('official-homepage:open', async () => {
    try {
      await openExternal(OFFICIAL_HOMEPAGE_URL)
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open official homepage.', error)
      return { success: false, error: 'Unable to open the official homepage.' }
    }
  })
}
