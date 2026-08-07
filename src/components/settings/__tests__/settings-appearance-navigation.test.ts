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
})
