import { describe, expect, it } from 'vitest'

import {
  IMPORT_FILL_FIELDS,
  isImportFillValueEmpty,
  planImportFill,
  type ImportFillField,
  type ImportFillValues,
} from '../import-fill-empty'

const TEXT_FIELDS: ImportFillField[] = [
  'genre', 'subGenre', 'targetAudience', 'goldenFinger', 'globalGuidance', 'coreOutline',
  'worldSetting', 'protagonistProfile', 'premise', 'worldbuilding', 'synopsis', 'writingStyle',
]
const COUNT_FIELDS: ImportFillField[] = ['totalChapters', 'wordsPerChapter']
const CHOICE_FIELDS: ImportFillField[] = ['plotStructure', 'narrativePov']

const inferred: ImportFillValues = {
  genre: '悬疑', subGenre: '本格', targetAudience: '成人', totalChapters: 5, wordsPerChapter: 2400,
  plotStructure: 'heros_journey', narrativePov: 'first_person', goldenFinger: '过目不忘',
  globalGuidance: '冷静克制', coreOutline: '侦探追查旧案', worldSetting: '民国上海',
  protagonistProfile: '沈默，前巡捕', premise: '旧案重启', worldbuilding: '租界与华界',
  synopsis: '五章查清真相', writingStyle: '短句，白描',
}

describe('作者原稿反推的判空与补空计划', () => {
  it('覆盖反推会写的每一个字段', () => {
    expect([...IMPORT_FILL_FIELDS].sort()).toEqual([...TEXT_FIELDS, ...COUNT_FIELDS, ...CHOICE_FIELDS].sort())
  })

  it.each(TEXT_FIELDS)('文本字段 %s：空串、空白、null、undefined 算空，有字算非空', field => {
    for (const empty of ['', '  \n\t', null, undefined]) expect(isImportFillValueEmpty(field, empty)).toBe(true)
    expect(isImportFillValueEmpty(field, '有内容')).toBe(false)
  })

  it.each(CHOICE_FIELDS)('选项字段 %s：只有空才算空，新项目的默认值不算空', field => {
    for (const empty of ['', ' ', null, undefined]) expect(isImportFillValueEmpty(field, empty)).toBe(true)
    expect(isImportFillValueEmpty(field, field === 'plotStructure' ? 'three_act' : 'third_limited')).toBe(false)
  })

  it.each(COUNT_FIELDS)('数量字段 %s：null、0、负数、小数算空，正整数算非空', field => {
    for (const empty of [null, undefined, 0, -3, 2.5, Number.NaN]) expect(isImportFillValueEmpty(field, empty)).toBe(true)
    expect(isImportFillValueEmpty(field, 100)).toBe(false)
  })

  it('空项目：每个字段都补上，没有建议', () => {
    const empty = {
      genre: '', subGenre: null, targetAudience: '  ', totalChapters: 0, wordsPerChapter: null,
      plotStructure: '', narrativePov: '', goldenFinger: '', globalGuidance: '', coreOutline: '',
      worldSetting: '', protagonistProfile: '', premise: '', worldbuilding: '', synopsis: '', writingStyle: '',
    }
    const plan = planImportFill(IMPORT_FILL_FIELDS, empty, inferred)
    expect(plan.patch).toEqual(inferred)
    expect(plan.suggestions).toEqual([])
  })

  it('已有设定：非空字段一字不改，不同的进建议，相同的不进', () => {
    const current = {
      genre: '悬疑', subGenre: '社会派', targetAudience: '', totalChapters: 100, wordsPerChapter: 3000,
      plotStructure: 'three_act', narrativePov: 'first_person', goldenFinger: '', globalGuidance: '',
      coreOutline: '我写的大纲', worldSetting: '', protagonistProfile: '', premise: '', worldbuilding: '',
      synopsis: '', writingStyle: '长句',
    }
    const plan = planImportFill(IMPORT_FILL_FIELDS, current, inferred)
    expect(plan.patch).toEqual({
      targetAudience: '成人', goldenFinger: '过目不忘', globalGuidance: '冷静克制', worldSetting: '民国上海',
      protagonistProfile: '沈默，前巡捕', premise: '旧案重启', worldbuilding: '租界与华界', synopsis: '五章查清真相',
    })
    expect(plan.suggestions).toEqual([
      { field: 'subGenre', current: '社会派', inferred: '本格' },
      { field: 'wordsPerChapter', current: 3000, inferred: 2400 },
      { field: 'plotStructure', current: 'three_act', inferred: 'heros_journey' },
      { field: 'coreOutline', current: '我写的大纲', inferred: '侦探追查旧案' },
      { field: 'writingStyle', current: '长句', inferred: '短句，白描' },
    ])
  })

  it('导入章数不是计划总章数：已有总章数时既不覆盖也不建议', () => {
    const plan = planImportFill(['totalChapters'], { totalChapters: 100 }, { totalChapters: 5 })
    expect(plan).toEqual({ patch: {}, suggestions: [] })
  })

  it('比较前去掉首尾空白：只差空白不算不同；反推值为空时什么也不做', () => {
    expect(planImportFill(['genre'], { genre: ' 悬疑 ' }, { genre: '悬疑  ' })).toEqual({ patch: {}, suggestions: [] })
    expect(planImportFill(['genre'], { genre: '' }, { genre: '   ' })).toEqual({ patch: {}, suggestions: [] })
    expect(planImportFill(['genre'], { genre: '' }, { genre: ' 悬疑 ' }).patch).toEqual({ genre: '悬疑' })
  })
})
