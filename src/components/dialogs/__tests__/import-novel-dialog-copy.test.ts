import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('import novel imitation entry copy', () => {
  it('surfaces reference novel decomposition and imitation clearly in the UI', () => {
    const dialog = source('src/components/dialogs/ImportNovelDialog.tsx')
    const titleBar = source('src/components/layout/TitleBar.tsx')
    const welcome = source('src/components/pages/WelcomePage.tsx')

    expect(dialog).toContain('小说拆解与仿写')
    expect(dialog).toContain('结构拆解、文风提取、蓝图反推')
    expect(titleBar).toContain('拆解仿写')
    expect(welcome).toContain('拆解仿写')
  })
})
