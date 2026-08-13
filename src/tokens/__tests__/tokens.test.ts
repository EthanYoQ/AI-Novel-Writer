import { describe, expect, it } from 'vitest'
import { tokens } from '../index'

describe('paper theme writer-studio tokens', () => {
  it('uses the accepted paper-ink palette', () => {
    expect(tokens.paper.color.bg).toBe('#F7F3E8')
    expect(tokens.paper.color.editorBg).toBe('#FCFAF3')
    expect(tokens.paper.color.sidebar).toBe('#F0EADA')
    expect(tokens.paper.color.activityBar).toBe('#F0EADA')
    expect(tokens.paper.color.accent).toBe('#B5402C')
    expect(tokens.paper.color.gold).toBe('#54666E')
    expect(tokens.paper.color.success).toBe('#527A5B')
    expect(tokens.paper.color.warning).toBe('#C68A3A')
    expect(tokens.paper.color.accent).not.toBe('#7A5732')
  })
})
