/** Static contract checks for the installed V2 browser qualification journey. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const browserJourney = join(packageRoot, 'scripts', 'qualification-browser.mjs')

describe('V2 browser qualification journey', () => {
  it('declares the path-free sidebar initialization, user-applied V2 proposal, and restart contract', async () => {
    const result = await execFileAsync(process.execPath, [browserJourney, '--check-static'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    expect(JSON.parse(result.stdout)).toEqual({
      kind: 'dsh-ai-novel-v2-browser-journey',
      browser: 'Google Chrome',
      workspaceStateEndpoint: 'workspace/state/read',
      initializeEndpoint: 'workspace/initialize',
      tools: ['novel_read', 'novel_propose_change'],
      phases: ['first', 'restart', 'reinstall'],
      output: ['phase', 'browser', 'pluginCard', 'geometry', 'screenshots'],
      proposalEnvironment: 'DSH_NOVEL_QUALIFICATION_PROPOSAL_JSON',
      finalArtifactId: 'qualification-chapter-1-draft',
      partialStopArtifactId: 'qualification-invalid-review',
      chapterContext: { chapter: 2, previousFinalArtifactId: 'qualification-chapter-1-draft' },
      requiresHarnessRoot: true,
      directStoreBootstrap: false,
      userAppliesProposal: true,
    })
  })

  it('does not retain the V1 proposal or direct-mutation browser journey', async () => {
    const source = await readFile(browserJourney, 'utf8')
    expect(source).toContain("workspace/state/read")
    expect(source).toContain("workspace/initialize")
    expect(source).toContain("创建 V2 项目")
    expect(source).toContain("依序应用未完成项")
    expect(source).toContain('qualification-invalid-review')
    expect(source).not.toContain('novel_apply_change')
    expect(source).not.toContain('预览初始化提案')
    expect(source).not.toContain('提交到当前会话')
  })

  it('reports an explicit non-passing skip without an installed Harness root', async () => {
    const result = await execFileAsync(process.execPath, [browserJourney, 'http://127.0.0.1:1', '.', '.', '.', 'first'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_HARNESS_ROOT: '' },
    })
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'skipped',
      reason: 'DSH_HARNESS_ROOT is required for installed-sidebar browser qualification',
      phase: 'first',
      browser: 'Google Chrome',
      pluginCard: null,
      geometry: null,
      screenshots: [],
    })
  })
})
