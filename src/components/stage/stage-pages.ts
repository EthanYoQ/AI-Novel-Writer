import { lazyPage } from './lazy-page'

const setup = lazyPage(() => import('./setup/StageSetup'), 'StageSetup')
const settings = lazyPage(() => import('./settings/StageSettings'), 'StageSettings')

export const SetupPage = setup.Page
export const SettingsPage = settings.Page

/** 外壳空下来后预先载入设定页与设置页的代码。 */
export function preloadStagePages(): void {
  void setup.preload()
  void settings.preload()
}
