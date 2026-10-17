import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('import novel imitation entry copy', () => {
  it('surfaces reference novel decomposition and imitation clearly in the UI', () => {
    const dialog = source('src/components/dialogs/ImportNovelDialog.tsx')
    const library = source('src/components/stage/library/StageLibrary.tsx')

    expect(dialog).toContain('小说拆解与仿写')
    expect(dialog).toContain('结构拆解、文风提取、蓝图反推')
    expect(library).toContain('小说拆解与仿写')
    expect(library).toContain('Novel breakdown & imitation')
  })
})
