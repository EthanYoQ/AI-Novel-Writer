import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import MentionMenu from '../agent/MentionMenu'
import { getAllMentionTargets } from '../../../services/agent/intent-router'

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
  '[\\u2190-\\u25FF]',
  '[\\u00AB\\u00BB]',
  '\\uFE0F',
].join('|'), 'u')

function source(file: string): string {
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

describe('data-driven menu icon contract', () => {
  it('keeps the active open-editor menu affordance free of Unicode pseudo-icons', () => {
    const visibleEditorArea = visibleJsxSource('src/components/panels/EditorArea.tsx')

    expect(visibleEditorArea).not.toMatch(pseudoIconPattern)
  })

  it('renders every @ mention target with shared icons instead of Unicode glyphs', () => {
    const targets = getAllMentionTargets()
    const markup = renderToStaticMarkup(createElement(MentionMenu, {
      query: '',
      onSelect: () => undefined,
      onClose: () => undefined,
    }))

    for (const target of targets) {
      expect(markup).toContain(target.displayName)
      expect(target).not.toHaveProperty('icon')
    }
    expect(JSON.stringify(targets)).not.toMatch(pseudoIconPattern)
    expect(markup).not.toMatch(pseudoIconPattern)
    expect(markup).toContain('<svg')
  })
})
