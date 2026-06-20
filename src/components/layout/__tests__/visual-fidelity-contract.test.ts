import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const files = [
  'src/components/layout/TitleBar.tsx',
  'src/components/layout/LeftToolWindowBar.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/pages/WelcomePage.tsx',
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
    expect(combined).toContain('writer-topbar')
    expect(combined).toContain('writer-command-button')
    expect(combined).toContain('writer-project-tree')
    expect(combined).toContain('writer-task-table')
    expect(combined).toContain('writer-ai-panel')
    expect(combined).not.toMatch(/[❤️☕✨✅❌]/)
    expect(combined).not.toMatch(/<svg\b|<path\b/)
  })
})
