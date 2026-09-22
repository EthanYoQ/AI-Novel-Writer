import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('import novel imitation entry copy', () => {
  it('surfaces reference novel decomposition and imitation clearly in the UI', () => {
    const dialog = source('src/components/dialogs/ImportNovelDialog.tsx')
    const zhCatalog = source('src/i18n/messages/zh-CN.ts')
    const enCatalog = source('src/i18n/messages/en-US.ts')
    const welcome = source('src/components/pages/WelcomePage.tsx')

    expect(dialog).toContain('小说导入与仿写')
    expect(dialog).toContain('结构拆解、文风提取、蓝图反推')
    expect(zhCatalog).toContain('拆解仿写')
    expect(enCatalog).toContain('Analyze & imitate')
    expect(welcome).toContain('拆解仿写')
  })

  /**
   * 先生：这类弹出来的子菜单要有统一规范与设计美感 —— 标头一律走各子菜单页头
   * （PageHead）那套「朱砂小字眉标 → 衬线标题 → 次要色说明」三层，
   * 而不是各写各的「图标 + 标题 + 描述」。没有这条契约，下次很容易又长回去。
   */
  it('gives both dialogs the shared page-head header', () => {
    const dialogs = [
      source('src/components/dialogs/ImportNovelDialog.tsx'),
      source('src/components/dialogs/NewProjectDialog.tsx'),
    ]

    for (const file of dialogs) {
      expect(file).toContain("import PageHead from '../ui/PageHead'")
      expect(file).toContain('className="app-dialog-head"')
      expect(file).toContain('<PageHead')
      expect(file).toContain('kicker=')
      // 无障碍名称不能丢：可见标题改由 PageHead 渲染，DialogTitle 退成屏幕阅读器专用。
      expect(file).toContain('<DialogTitle className="sr-only">')
    }

    expect(dialogs[0]).toContain("text('NOVEL IMPORT · 小说导入'")
    expect(dialogs[1]).toContain("text('NEW PROJECT · 新建项目'")
  })
})
