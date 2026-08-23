/** Static contract checks for the installed V2 browser qualification journey. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { assertQualificationToolSchemas } from '../scripts/qualification-web-backend.mjs'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const browserJourney = join(packageRoot, 'scripts', 'qualification-browser.mjs')

describe('V2 browser qualification journey', () => {
  it('accepts the exact V2 tool contract regardless of DSH assembly order', () => {
    expect(() => assertQualificationToolSchemas([
      { name: 'novel_propose_change' },
      { name: 'novel_read' },
    ])).not.toThrow()
  })

  it.each([
    ['a duplicate tool', [{ name: 'novel_read' }, { name: 'novel_read' }]],
    ['an extra tool', [{ name: 'novel_read' }, { name: 'novel_propose_change' }, { name: 'shell' }]],
    ['a missing tool', [{ name: 'novel_read' }]],
    ['a non-array tool payload', undefined],
  ])('rejects %s', (_caseName, tools) => {
    expect(() => assertQualificationToolSchemas(tools)).toThrow(
      /Qualification model request must (?:contain V2 tool schemas|expose exactly novel_read and novel_propose_change)/,
    )
  })

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
      presetPreflight: { endpoint: 'agentPreset.list', requiredPresetId: 'ai-novel-writer-v2' },
    })
  })

  it('accepts the V2 preset only when the real agent preset roster exposes it', async () => {
    const response = {
      type: 'server-response',
      rpcId: 'qualification',
      result: {
        ok: true,
        value: {
          presets: [{ id: 'ai-novel-writer-v2', trust: 'user', isDefault: true }],
          authorable: true,
          hasDocument: true,
        },
      },
    }
    const result = await execFileAsync(process.execPath, [
      browserJourney, '--check-agent-preset-response', JSON.stringify(response),
    ], { cwd: packageRoot, encoding: 'utf8' })

    expect(JSON.parse(result.stdout)).toEqual({
      presetId: 'ai-novel-writer-v2',
      presetIds: ['ai-novel-writer-v2'],
    })
  })

  it('fails before opening the preset picker when the agent preset roster lacks V2', async () => {
    const response = {
      type: 'server-response',
      rpcId: 'qualification',
      result: {
        ok: true,
        value: {
          presets: [{ id: 'standard', trust: 'system', isDefault: false }],
          authorable: false,
          hasDocument: true,
        },
      },
    }

    await expect(execFileAsync(process.execPath, [
      browserJourney, '--check-agent-preset-response', JSON.stringify(response),
    ], { cwd: packageRoot, encoding: 'utf8' })).rejects.toMatchObject({
      stderr: expect.stringContaining('agentPreset.list did not expose ai-novel-writer-v2'),
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

  it('finds the localized Harness send-message control for the V2 proposal', async () => {
    const source = await readFile(browserJourney, 'utf8')
    expect(source).toContain('const SEND_MESSAGE_BUTTON_NAME = /^(?:发送(?:消息)?|Send(?: message)?)$/i')
    expect(source).toContain("page.getByRole('button', { name: SEND_MESSAGE_BUTTON_NAME })")
  })

  it('retries a freshly located review disclosure until the user-visible partial status is rendered', async () => {
    const source = await readFile(browserJourney, 'utf8')
    const apply = source.indexOf("await drawer.getByRole('button', { name: '依序应用未完成项', exact: true }).click()")
    const waitForResult = source.indexOf('await waitForVisiblePartialProposalResult(drawer)')
    const freshReview = source.indexOf('const review = drawer.locator(REVIEW_DISCLOSURE_SELECTOR)')
    const visible = source.indexOf("await review.getByText(PARTIAL_PROPOSAL_RESULT, { exact: false }).waitFor({ state: 'visible', timeout: attemptTimeout })")
    const staleAttachedWait = source.indexOf("await drawer.getByText('部分已应用', { exact: true }).waitFor({ state: 'attached', timeout: 60_000 })")
    const oldElementHandle = source.indexOf('previousReview')

    expect(apply).toBeGreaterThan(-1)
    expect(waitForResult).toBeGreaterThan(apply)
    expect(freshReview).toBeGreaterThan(-1)
    expect(visible).toBeGreaterThan(freshReview)
    expect(staleAttachedWait).toBe(-1)
    expect(oldElementHandle).toBe(-1)
  })

  it('scopes the chapter blueprint and prior-final assertions to the current authoring panels', async () => {
    const source = await readFile(browserJourney, 'utf8')
    expect(source).toContain("for (const required of ['潮汐来信', '部分已应用'])")
    expect(source).not.toContain("'已定稿'")
    expect(source).toContain("drawer.getByRole('region', { name: '当前创作步骤', exact: true })")
    expect(source).toContain("currentStage.getByRole('heading', { name: '第 2 章蓝图', exact: true, level: 3 })")
    expect(source).toContain("drawer.getByRole('region', { name: `第 ${chapter} 章的上一章定稿上下文`, exact: true })")
    expect(source.match(/chapterContextRegion\(drawer, 2\)\.getByText\('潮水退去，信件显露。', \{ exact: true \}\)/g)).toHaveLength(2)
  })

  it('qualifies wide, medium, and narrow focused layout without covering the native rail', async () => {
    const source = await readFile(browserJourney, 'utf8')
    expect(source).toContain('Math.abs(drawerBox.x - 386) > 1')
    expect(source).toContain("await page.setViewportSize({ width: 1360, height: 900 })")
    expect(source).toContain('Math.abs(wideBoundaryBox.width - 974) > 1')
    expect(source).toContain("await page.setViewportSize({ width: 1280, height: 900 })")
    expect(source).toContain('Math.abs(mediumBox.x - 56) > 1')
    expect(source).toContain("await page.setViewportSize({ width: 1024, height: 900 })")
    expect(source).toContain('Math.abs(mediumBoundaryBox.width - 968) > 1')
    expect(source).toContain('Math.abs(narrowBox.x - 56) > 1')
    expect(source).toContain('document.documentElement.scrollWidth - window.innerWidth')
    expect(source).toContain('narrowRootOverflow > 1')
    expect(source).toContain("await drawer.getByRole('button', { name: '关闭小说工作台', exact: true }).click()")
    expect(source).toContain("element.classList.contains('aiNovelWorkbenchFrameOpen')")
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
