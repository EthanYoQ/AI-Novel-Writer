import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '\\uFE0F',
].join('|'), 'u')

const editorPseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '[\\u2190-\\u21FF]',
  '[\\u00AB\\u00BB]',
  '\\uFE0F',
].join('|'), 'u')

const workflowFiles = [
  'src/services/workflows/architecture-workflow.ts',
  'src/services/workflows/chapter-workflow.ts',
  'src/services/workflows/directory-workflow.ts',
]

const visibleWorkflowPropertyNames = new Set([
  'title',
  'name',
  'description',
  'label',
  'message',
])

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

/** 渲染进程里作者能看到界面文字的全部组件（不含测试）。图标只能来自 Lucide，不能用 Emoji 或字符充当。 */
function componentFiles(directory = 'src/components'): string[] {
  return readdirSync(resolve(process.cwd(), directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : componentFiles(path)
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.browser.tsx') ? [path] : []
  })
}

function visibleJsxSource(file: string): string {
  const content = source(file)
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visible: string[] = []

  function visit(node: ts.Node) {
    if (
      ts.isJsxText(node)
      || (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer))
      || (ts.isJsxExpression(node) && node.expression && (
        ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)
      ))
    ) {
      visible.push(node.getText(sourceFile))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return visible.join('\n')
}

function visibleWorkflowSource(file: string): string {
  const content = source(file)
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visible: string[] = []

  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && visibleWorkflowPropertyNames.has(node.name.getText(sourceFile))) {
      visible.push(node.initializer.getText(sourceFile))
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'cb'
      && ['log', 'appendText'].includes(node.expression.name.text)
    ) {
      for (const argument of node.arguments) {
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          visible.push(argument.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return visible.join('\n')
}

describe('界面图标只用 Lucide', () => {
  it('组件里作者看得到的文字不含 Emoji', () => {
    const files = componentFiles()
    expect(files.length).toBeGreaterThan(100)
    for (const file of files) expect(visibleJsxSource(file), file).not.toMatch(pseudoIconPattern)
  })

  it('编辑器里作者看得到的文字也不用箭头、书名号式符号充当图标', () => {
    for (const file of ['src/components/editor/CodeMirrorEditor.tsx', 'src/components/editor/ArchFileViewer.tsx', 'src/components/stage/chapter/ChapterView.tsx']) {
      expect(visibleJsxSource(file), file).not.toMatch(editorPseudoIconPattern)
    }
  })

  it('工作流步骤与导出日志的文案不含 Emoji 与充当图标的字符', () => {
    expect(workflowFiles.map(visibleWorkflowSource).join('\n')).not.toMatch(editorPseudoIconPattern)
    expect(source('src/services/export-service.ts')).not.toMatch(editorPseudoIconPattern)
    expect(source('src/stores/character-store.ts')).not.toMatch(pseudoIconPattern)
  })
})
