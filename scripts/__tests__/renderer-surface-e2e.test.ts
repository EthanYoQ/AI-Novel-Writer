import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}

describe('renderer surface E2E runner contract', () => {
  it('publishes an independent local command with the frozen computed-style coverage', async () => {
    expect(packageJson.scripts?.['test:renderer-surface:e2e'])
      .toBe('node scripts/renderer-surface-e2e.mjs')

    const { RENDERER_SURFACE_E2E_CONTRACT } = await import('../renderer-surface-e2e.mjs')
    expect(RENDERER_SURFACE_E2E_CONTRACT).toEqual({
      smokeEnvironment: [
        'AI_NOVEL_VELA_HOME',
        'AI_NOVEL_SMOKE_OPEN_PROJECT',
        'AI_NOVEL_SMOKE_PROJECT_MARKER',
      ],
      themes: ['light', 'galaxy', 'paper', 'dark'],
      surfaces: {
        sidebar: { selector: '.skin-workspace-panel', alpha: 0.56 },
        page: { selector: '.skin-workspace-page', alpha: 0.60 },
        solid: { selector: '.skin-solid-surface', alpha: 0.88 },
      },
      routes: ['project', 'knowledge', 'characters', 'blueprint'],
      classicMustBeOpaque: true,
      classicThemeSurfaces: {
        themed: ['light', 'galaxy', 'dark'],
        paper: 'paper',
        surfaces: {
          topbar: { selector: '.writer-topbar', token: '--color-titlebar', textToken: '--color-titlebar-text', minHeight: 24 },
          leftRail: { selector: '.writer-left-rail', token: '--color-activity-bar', textToken: '--color-text-secondary', minWidth: 40 },
          projectTree: { selector: '.writer-project-tree', token: '--color-sidebar', textToken: '--color-text' },
          aiPanel: { selector: '.writer-ai-panel', token: '--color-panel', textToken: '--color-text' },
          taskTable: { selector: '.writer-task-table', token: '--color-panel', textToken: '--color-text' },
          workspacePage: { selector: '.skin-workspace-page', token: '--color-editor-bg', textToken: '--color-text' },
          statusbar: { selector: '.writer-statusbar', token: '--color-statusbar', textToken: '--color-text-secondary', minHeight: 20 },
        },
        statusbarHover: { selector: '.writer-statusbar-segment', token: '--color-hover' },
      },
    })
  })
})
