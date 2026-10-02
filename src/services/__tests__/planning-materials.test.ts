/**
 * 资料多次选择的累加边界。
 *
 * 先生的真实操作：先从"角色卡"文件夹挑几个，再回到别的文件夹挑几个 —— 第二次
 * 选择不能把第一次的结果顶掉。
 */
import { describe, expect, it } from 'vitest'

import { appendPlanningMaterials } from '../knowledge-service'

describe('appendPlanningMaterials', () => {
  it('累加多次选择的文件，而不是替换掉上一次的结果', () => {
    const first = [{ fileName: '岛崎刹那.txt', text: '姓名：岛崎刹那' }]
    const second = [{ fileName: '阿尔泰尔.txt', text: '姓名：阿尔泰尔' }]

    expect(appendPlanningMaterials(first, second)).toEqual({
      files: [
        { fileName: '岛崎刹那.txt', text: '姓名：岛崎刹那' },
        { fileName: '阿尔泰尔.txt', text: '姓名：阿尔泰尔' },
      ],
      skipped: 0,
    })
  })

  it('只跳过文件名与内容都完全相同的重复项', () => {
    const existing = [{ fileName: '岛崎刹那.txt', text: '姓名：岛崎刹那' }]
    const selected = [
      { fileName: '岛崎刹那.txt', text: '姓名：岛崎刹那' },
      { fileName: '布里茨·托卡.txt', text: '姓名：布里茨·托卡' },
    ]

    expect(appendPlanningMaterials(existing, selected)).toEqual({
      files: [
        { fileName: '岛崎刹那.txt', text: '姓名：岛崎刹那' },
        { fileName: '布里茨·托卡.txt', text: '姓名：布里茨·托卡' },
      ],
      skipped: 1,
    })
  })

  it('同名但内容不同的文件各自保留，不吞掉资料', () => {
    const existing = [{ fileName: '角色卡.txt', text: '第一版' }]
    const selected = [{ fileName: '角色卡.txt', text: '第二版' }]

    expect(appendPlanningMaterials(existing, selected)).toEqual({
      files: [
        { fileName: '角色卡.txt', text: '第一版' },
        { fileName: '角色卡.txt', text: '第二版' },
      ],
      skipped: 0,
    })
  })

  it('本次选择内部出现重复时也只保留一份', () => {
    const duplicated = [
      { fileName: '弥勒寺优夜.txt', text: '姓名：弥勒寺优夜' },
      { fileName: '弥勒寺优夜.txt', text: '姓名：弥勒寺优夜' },
    ]

    const result = appendPlanningMaterials([], duplicated)

    expect(result.files).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })
})
