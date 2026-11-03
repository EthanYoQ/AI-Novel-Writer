import { describe, expect, it } from 'vitest'
import { narrativeEvidenceInText } from '../narrative-thread'

describe('线索证据是否在正文里', () => {
  it('忽略空白后逐字包含', () => {
    expect(narrativeEvidenceInText('林岚 捡到\n钥匙。', '雾里，林岚捡到钥匙。')).toBe(true)
    expect(narrativeEvidenceInText('林岚捡到地图。', '雾里，林岚捡到钥匙。')).toBe(false)
  })

  it('空的或只有空白的证据不算在正文里：库里的旧确认不能因此改挂到新定稿', () => {
    expect(narrativeEvidenceInText('', '雾里，林岚捡到钥匙。')).toBe(false)
    expect(narrativeEvidenceInText(' \n\t', '雾里，林岚捡到钥匙。')).toBe(false)
  })
})
