import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pseudoIconPattern = new RegExp([
  '[\\u2600-\\u27BF]',
  '[\\u{1F300}-\\u{1FAFF}]',
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

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('writer console visual fidelity contract', () => {
  it('uses the approved writer console token classes and no pseudo-icons', () => {
    const combined = files.map(source).join('\n')
    expect(source('src/components/layout/TitleBar.tsx')).toContain('writer-topbar')
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
})
