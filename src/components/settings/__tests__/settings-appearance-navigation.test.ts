import { describe, expect, it } from 'vitest'

import { SETTINGS_SECTIONS } from '../SettingsModal'

describe('settings appearance navigation seam', () => {
  it('exposes Appearance alongside the existing settings areas', () => {
    const appearance = SETTINGS_SECTIONS.find((section) => section.id === 'appearance')

    expect(appearance).toMatchObject({
      id: 'appearance',
      label: '外观',
      labelEn: 'Appearance',
    })
  })

  it('places Appearance as the first tab in settings sections', () => {
    expect(SETTINGS_SECTIONS[0].id).toBe('appearance')
  })

  it('defaults openSettings to appearance and safely guards against synthetic event leakage', async () => {
    const { useLayoutStore } = await import('../../../stores/layout-store')

    // 默认不传参数调用
    useLayoutStore.getState().openSettings()
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useLayoutStore.getState().settingsSection).toBe('appearance')

    // 模拟 React onClick 透传的合成事件对象
    const fakeSyntheticEvent = { nativeEvent: {}, target: {}, type: 'click' }
    useLayoutStore.getState().openSettings(fakeSyntheticEvent as unknown)
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useLayoutStore.getState().settingsSection).toBe('appearance')
  })
})
