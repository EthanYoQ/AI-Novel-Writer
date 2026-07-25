import { readFileSync } from 'node:fs'
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

const files = [
  'src/components/layout/TitleBar.tsx',
  'src/components/layout/LeftToolWindowBar.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/pages/WelcomePage.tsx',
  'src/components/panels/sidebar/ProjectTree.tsx',
  'src/components/panels/AIPanel.tsx',
  'src/components/panels/AIOutputPanel.tsx',
  'src/components/panels/BottomPanel.tsx',
  'src/components/panels/agent/AgentHeader.tsx',
  'src/components/panels/agent/AgentConversation.tsx',
  'src/index.css',
]

const editorFiles = [
  'src/components/editor/DraftEditor.tsx',
  'src/components/editor/ChapterCardEditor.tsx',
  'src/components/editor/CharacterEditor.tsx',
  'src/components/editor/ReviewReport.tsx',
  'src/components/panels/sidebar/CharactersView.tsx',
  'src/components/editor/CodeMirrorEditor.tsx',
  'src/components/editor/MonacoDiffViewer.tsx',
  'src/components/editor/ThreeWayMerge.tsx',
]

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

describe('writer console visual fidelity contract', () => {
  it('uses the approved writer console token classes and no pseudo-icons', () => {
    const combined = files.map(source).join('\n')
    const titleBar = source('src/components/layout/TitleBar.tsx')
    expect(titleBar).toContain('writer-topbar')
    expect(source('src/components/layout/TitleBar.tsx')).toContain('writer-command-button')
    expect(source('src/components/panels/sidebar/ProjectTree.tsx')).toContain('writer-project-tree')
    expect(source('src/components/panels/BottomPanel.tsx')).toContain('writer-task-table')
    expect([
      source('src/components/panels/AIPanel.tsx'),
      source('src/components/panels/AIOutputPanel.tsx'),
    ].join('\n')).toContain('writer-ai-panel')
    expect(combined).not.toMatch(pseudoIconPattern)
    expect(combined).not.toMatch(/<svg\b|<path\b/)
  })

  it('keeps the custom title bar draggable while controls stay interactive', () => {
    const titleBar = source('src/components/layout/TitleBar.tsx')
    const css = source('src/index.css')

    expect(titleBar).toContain("WebkitAppRegion: 'drag'")
    expect(titleBar).not.toContain("style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}")
    expect(css).toContain('-webkit-app-region: no-drag')
    expect(css).toContain('.writer-command-button')
  })

  it('keeps visible editor and workflow UI on the Lucide icon system', () => {
    const visibleEditors = editorFiles.map(visibleJsxSource).join('\n')
    const visibleWorkflows = workflowFiles.map(visibleWorkflowSource).join('\n')
    const exportLogs = source('src/services/export-service.ts')

    expect(visibleEditors).not.toMatch(editorPseudoIconPattern)
    expect(visibleWorkflows).not.toMatch(editorPseudoIconPattern)
    expect(exportLogs).not.toMatch(editorPseudoIconPattern)
    expect(source('src/components/editor/DraftEditor.tsx')).not.toMatch(/<svg\b|<path\b/)
    expect(source('src/stores/character-store.ts')).not.toMatch(pseudoIconPattern)
  })
})
