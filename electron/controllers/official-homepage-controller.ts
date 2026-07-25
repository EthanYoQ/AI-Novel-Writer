import { ipcMain, shell } from 'electron'

import { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

export { OFFICIAL_HOMEPAGE_URL } from '../services/official-homepage-navigation'

/** Registers the fixed, no-argument intent for opening the project's official homepage. */
export function registerOfficialHomepageController() {
  ipcMain.handle('official-homepage:open', async () => {
    try {
      await shell.openExternal(OFFICIAL_HOMEPAGE_URL)
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open official homepage.', error)
      return { success: false, error: 'Unable to open the official homepage.' }
    }
  })
}
