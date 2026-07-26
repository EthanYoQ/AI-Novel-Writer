import { afterEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../src/stores/locale-store'
import { resetTestLocale } from './setup-locale'

describe('test locale setup', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })
  })

  it('starts each test with the Chinese-first renderer locale', () => {
    expect(useLocaleStore.getState()).toMatchObject({
      locale: 'zh-CN',
      initialized: false,
    })
  })

  it('restores the Chinese-first locale before the next test after English was selected', () => {
    expect(useLocaleStore.getState()).toMatchObject({
      locale: 'zh-CN',
      initialized: false,
    })
  })

  it('resets the renderer test locale to the project default without persisting it', () => {
    useLocaleStore.setState({ locale: 'en-US', initialized: true })

    resetTestLocale()

    expect(useLocaleStore.getState()).toMatchObject({
      locale: 'zh-CN',
      initialized: false,
    })
  })
})
