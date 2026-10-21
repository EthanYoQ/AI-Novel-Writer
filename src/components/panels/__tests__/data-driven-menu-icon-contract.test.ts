import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import MentionMenu from '../agent/MentionMenu'
import { getAllMentionTargets } from '../../../services/agent/intent-router'
import { useLocaleStore } from '../../../stores/locale-store'

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '[\\u2190-\\u25FF]',
  '[\\u00AB\\u00BB]',
  '\\uFE0F',
].join('|'), 'u')

describe('data-driven menu icon contract', () => {
  it('renders every @ mention target with shared icons instead of Unicode glyphs', () => {
    const targets = getAllMentionTargets(useLocaleStore.getInitialState().locale)
    const markup = renderToStaticMarkup(createElement(MentionMenu, {
      query: '',
      onSelect: () => undefined,
      onClose: () => undefined,
    }))

    for (const target of targets) {
      expect(markup).toContain(target.displayName)
      expect(target).not.toHaveProperty('icon')
    }
    expect(JSON.stringify(targets)).not.toMatch(pseudoIconPattern)
    expect(markup).not.toMatch(pseudoIconPattern)
    expect(markup).toContain('<svg')
  })
})
