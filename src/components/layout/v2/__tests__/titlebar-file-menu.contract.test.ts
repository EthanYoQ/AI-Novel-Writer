import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 顶栏「文件」下拉的契约。
 *
 * 先生定名：
 *   · 「小说拆解」→「小说导入」—— 这个入口做的是「导进一本书、顺手把它拆开」，
 *     叫「导入」作者一眼才认得出是入口；
 *   · 「导出」→「导出小说」—— 菜单里同时有项目、备份与书稿几种东西，
 *     光写「导出」看不出导出的是什么。
 * 两项都必须真的接上对应的开关：只改名字、点了没反应是最容易犯的错。
 */
const source = readFileSync('src/components/layout/v2/TitleBarV2.tsx', 'utf8')

describe('title bar file menu', () => {
  it('calls the novel entry an import and the export entry a novel export', () => {
    expect(source).toContain("text('小说导入', 'Import novel')")
    expect(source).toContain("text('导出小说', 'Export novel')")
    expect(source).not.toContain('小说拆解')
  })

  it('keeps both entries wired to their real commands', () => {
    expect(source).toContain('openImportNovel()')
    expect(source).toContain('openExport()')
  })
})
