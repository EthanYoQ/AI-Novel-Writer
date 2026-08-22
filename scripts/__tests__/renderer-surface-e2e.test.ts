import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
}
const VISUAL_EVIDENCE_PREFLIGHT_CHILD_TIMEOUT_MS = 10_000
// Four bounded child-process preflights can contend with the full parallel suite.
const VISUAL_EVIDENCE_PREFLIGHT_TEST_TIMEOUT_MS = 45_000

describe('renderer surface E2E runner contract', () => {
  it('rejects an Electron process that exited early without a clean zero-code exit', async () => {
    const { quitElectronApp } = await import('../renderer-surface-e2e.mjs')

    for (const child of [
      Object.assign(new EventEmitter(), { exitCode: 7, signalCode: null }),
      Object.assign(new EventEmitter(), { exitCode: null, signalCode: 'SIGTERM' }),
    ]) {
      const electronApp = {
        process: () => child,
        evaluate: async () => {
          throw new Error('already exited')
        },
      }

      await expect(quitElectronApp(electronApp, 'Test Electron QA session'))
        .rejects.toThrow(/cleanly|exit/i)
    }
  })

  it('accepts only code zero with no signal when Electron exits after quit', async () => {
    const { quitElectronApp } = await import('../renderer-surface-e2e.mjs')
    const makeElectronApp = (code: number | null, signal: NodeJS.Signals | null) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null })
      return {
        electronApp: {
          process: () => child,
          evaluate: async () => {
            queueMicrotask(() => {
              child.exitCode = code
              child.signalCode = signal
              child.emit('exit', code, signal)
            })
            return true
          },
        },
      }
    }

    await expect(quitElectronApp(makeElectronApp(0, null).electronApp, 'Clean Electron QA session'))
      .resolves.toBeUndefined()
    await expect(quitElectronApp(makeElectronApp(9, null).electronApp, 'Nonzero Electron QA session'))
      .rejects.toThrow(/cleanly|exit/i)
    await expect(quitElectronApp(makeElectronApp(null, 'SIGTERM').electronApp, 'Signaled Electron QA session'))
      .rejects.toThrow(/cleanly|exit/i)
  })

  it('leaves no renderer fixture when visual-evidence directory preflight rejects', () => {
    const repositoryRoot = resolve(process.cwd())
    const cacheRoot = resolve(repositoryRoot, '.runtime', '.cache')
    const fixtureRunsRoot = join(cacheRoot, 'renderer-surface-runs')
    const externalDirectory = resolve(repositoryRoot, '.runtime', `renderer-evidence-preflight-${process.pid}`)
    const missingOwnerDirectory = join(cacheRoot, `renderer-evidence-missing-owner-${process.pid}`)
    const invalidOwnerDirectory = join(cacheRoot, `renderer-evidence-invalid-owner-${process.pid}`)
    const configuredDirectories = [externalDirectory, missingOwnerDirectory, invalidOwnerDirectory]
    const cases = [
      { label: 'cache root', outputDirectory: cacheRoot },
      { label: 'outside cache', outputDirectory: externalDirectory },
      { label: 'missing owner receipt', outputDirectory: missingOwnerDirectory },
      { label: 'invalid owner receipt JSON', outputDirectory: invalidOwnerDirectory },
    ]
    const fixtureEntries = () => existsSync(fixtureRunsRoot) ? readdirSync(fixtureRunsRoot) : []
    const residue: Array<{ label: string; entries: string[] }> = []
    const statuses: Array<number | null> = []

    rmSync(externalDirectory, { recursive: true, force: true })
    rmSync(missingOwnerDirectory, { recursive: true, force: true })
    rmSync(invalidOwnerDirectory, { recursive: true, force: true })
    mkdirSync(missingOwnerDirectory, { recursive: true })
    writeFileSync(join(missingOwnerDirectory, 'unrelated.txt'), 'must survive')
    mkdirSync(invalidOwnerDirectory, { recursive: true })
    writeFileSync(join(invalidOwnerDirectory, '.vibe-owner.json'), '{not-json')

    try {
      for (const testCase of cases) {
        const before = new Set(fixtureEntries())
        const result = spawnSync(process.execPath, ['scripts/renderer-surface-e2e.mjs'], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            AI_NOVEL_RENDERER_VISUAL_EVIDENCE_DIR: testCase.outputDirectory,
          },
          encoding: 'utf8',
          timeout: VISUAL_EVIDENCE_PREFLIGHT_CHILD_TIMEOUT_MS,
          windowsHide: true,
        })
        statuses.push(result.status)
        const added = fixtureEntries().filter(entry => !before.has(entry))
        residue.push({ label: testCase.label, entries: added })
        for (const entry of added) {
          rmSync(join(fixtureRunsRoot, entry), { recursive: true, force: true })
        }
      }
    } finally {
      for (const directory of configuredDirectories) {
        rmSync(directory, { recursive: true, force: true })
      }
    }

    expect(statuses.every(status => status !== 0)).toBe(true)
    expect(residue).toEqual(cases.map(testCase => ({ label: testCase.label, entries: [] })))
  }, VISUAL_EVIDENCE_PREFLIGHT_TEST_TIMEOUT_MS)

  it('starts a fixed visual-evidence path as a fresh fail-closed run', async () => {
    const outputDirectory = resolve(process.cwd(), '.runtime', '.cache', 'renderer-evidence-contract-test')
    rmSync(outputDirectory, { recursive: true, force: true })
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(join(outputDirectory, '.vibe-owner.json'), JSON.stringify({
      owner: 'codex/paper-ink-visual-qa',
    }))
    writeFileSync(join(outputDirectory, 'manifest.json'), '{"stale":true}\n')
    writeFileSync(join(outputDirectory, '01-stale.png'), 'stale screenshot')

    try {
      const { prepareVisualEvidenceDirectory } = await import('../renderer-surface-e2e.mjs')
      expect(prepareVisualEvidenceDirectory(outputDirectory)).toBe(outputDirectory)
      expect(existsSync(join(outputDirectory, 'manifest.json'))).toBe(false)
      expect(existsSync(join(outputDirectory, '01-stale.png'))).toBe(false)
      expect(JSON.parse(readFileSync(join(outputDirectory, 'run-state.json'), 'utf8'))).toMatchObject({
        status: 'in-progress',
      })
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it('refuses to replace an evidence directory without the expected owner receipt', async () => {
    const outputDirectory = resolve(process.cwd(), '.runtime', '.cache', 'renderer-evidence-foreign-owner-test')
    rmSync(outputDirectory, { recursive: true, force: true })
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(join(outputDirectory, 'unrelated.txt'), 'must survive')

    try {
      const { prepareVisualEvidenceDirectory } = await import('../renderer-surface-e2e.mjs')
      expect(() => prepareVisualEvidenceDirectory(outputDirectory)).toThrow(/owner receipt/i)
      expect(readFileSync(join(outputDirectory, 'unrelated.txt'), 'utf8')).toBe('must survive')
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it('publishes a manifest only as the completion receipt for the current run', async () => {
    const outputDirectory = resolve(process.cwd(), '.runtime', '.cache', 'renderer-evidence-finalize-test')
    rmSync(outputDirectory, { recursive: true, force: true })

    try {
      const {
        prepareVisualEvidenceDirectory,
        finalizeVisualEvidenceRun,
      } = await import('../renderer-surface-e2e.mjs')
      prepareVisualEvidenceDirectory(outputDirectory)
      expect(existsSync(join(outputDirectory, 'manifest.json'))).toBe(false)

      const postprocess: string[] = []
      const manifest = await finalizeVisualEvidenceRun(outputDirectory, {
        schemaVersion: 1,
        kind: 'renderer-visual-qa',
        screenshots: [],
      }, async () => {
        expect(existsSync(join(outputDirectory, 'manifest.json'))).toBe(false)
        expect(JSON.parse(readFileSync(join(outputDirectory, 'run-state.json'), 'utf8')).status).toBe('in-progress')
        postprocess.push('electron-exited', 'node-abi-restored')
      })
      const runState = JSON.parse(readFileSync(join(outputDirectory, 'run-state.json'), 'utf8'))
      const persistedManifest = JSON.parse(readFileSync(join(outputDirectory, 'manifest.json'), 'utf8'))
      expect(postprocess).toEqual(['electron-exited', 'node-abi-restored'])
      expect(runState).toMatchObject({ status: 'completed', runId: manifest.runId })
      expect(persistedManifest.runId).toBe(runState.runId)
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed when Electron exit or Node ABI restoration fails after screenshots', async () => {
    const outputDirectory = resolve(process.cwd(), '.runtime', '.cache', 'renderer-evidence-postprocess-failure-test')
    rmSync(outputDirectory, { recursive: true, force: true })

    try {
      const {
        prepareVisualEvidenceDirectory,
        finalizeVisualEvidenceRun,
      } = await import('../renderer-surface-e2e.mjs')
      prepareVisualEvidenceDirectory(outputDirectory)
      await expect(finalizeVisualEvidenceRun(outputDirectory, {
        schemaVersion: 1,
        kind: 'renderer-visual-qa',
        screenshots: [],
      }, async () => {
        throw new Error('sensitive machine path C:\\Users\\person\\native.node failed')
      })).rejects.toThrow(/native\.node failed/)

      expect(existsSync(join(outputDirectory, 'manifest.json'))).toBe(false)
      expect(existsSync(join(outputDirectory, '.manifest-candidate.json'))).toBe(false)
      const runStateText = readFileSync(join(outputDirectory, 'run-state.json'), 'utf8')
      expect(JSON.parse(runStateText)).toMatchObject({
        status: 'failed',
        failureStage: 'postprocess',
      })
      expect(runStateText).not.toContain('C:\\Users\\person')
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it('does not publish a completed receipt when Electron exits nonzero', async () => {
    const outputDirectory = resolve(process.cwd(), '.runtime', '.cache', 'renderer-evidence-electron-exit-failure-test')
    rmSync(outputDirectory, { recursive: true, force: true })

    try {
      const {
        prepareVisualEvidenceDirectory,
        finalizeVisualEvidenceRun,
        quitElectronApp,
      } = await import('../renderer-surface-e2e.mjs')
      prepareVisualEvidenceDirectory(outputDirectory)
      const child = Object.assign(new EventEmitter(), { exitCode: 23, signalCode: null })

      await expect(finalizeVisualEvidenceRun(outputDirectory, {
        schemaVersion: 1,
        kind: 'renderer-visual-qa',
        screenshots: [],
      }, () => quitElectronApp({
        process: () => child,
        evaluate: async () => true,
      }, 'Final Electron QA session'))).rejects.toThrow(/cleanly|exit/i)

      expect(existsSync(join(outputDirectory, 'manifest.json'))).toBe(false)
      expect(existsSync(join(outputDirectory, '.manifest-candidate.json'))).toBe(false)
      expect(JSON.parse(readFileSync(join(outputDirectory, 'run-state.json'), 'utf8'))).toMatchObject({
        status: 'failed',
        failureStage: 'postprocess',
      })
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  })

  it('rejects relaunch evidence unless the frozen project state and every visible guard are fresh', async () => {
    const { assertVisualEvidenceObservation } = await import('../renderer-surface-e2e.mjs')
    const expectedProject = resolve(process.cwd(), '.runtime', '.cache', 'expected-project')
    const launchStartedAt = Date.now()
    const completeObservation = {
      projectPath: expectedProject,
      markerOpenedAt: new Date(launchStartedAt + 10).toISOString(),
      routeTitleVisible: true,
      panelsVisible: {
        projectTree: true,
        aiPanel: true,
        taskTable: true,
      },
      visibleDialogCount: 0,
      bodyText: '小说配置',
      theme: 'dark',
      imageSkin: 'custom',
      imageDecoded: true,
    }

    expect(() => assertVisualEvidenceObservation(completeObservation, {
      projectPath: expectedProject,
      launchStartedAt,
      theme: 'dark',
      imageSkin: 'custom',
    })).not.toThrow()

    for (const broken of [
      { ...completeObservation, routeTitleVisible: false },
      { ...completeObservation, panelsVisible: { ...completeObservation.panelsVisible, aiPanel: false } },
      { ...completeObservation, visibleDialogCount: 1 },
      { ...completeObservation, bodyText: '打开项目失败' },
      { ...completeObservation, markerOpenedAt: new Date(launchStartedAt - 2_000).toISOString() },
      { ...completeObservation, imageDecoded: false },
    ]) {
      expect(() => assertVisualEvidenceObservation(broken, {
        projectPath: expectedProject,
        launchStartedAt,
        theme: 'dark',
        imageSkin: 'custom',
      })).toThrow()
    }
  })

  it('rejects each pre-relaunch screenshot unless its route, panels, appearance, and image surface are valid', async () => {
    const { assertVisualEvidenceObservation } = await import('../renderer-surface-e2e.mjs')
    const expectedProject = resolve(process.cwd(), '.runtime', '.cache', 'expected-project')
    const launchStartedAt = Date.now()
    const classicObservation = {
      projectPath: expectedProject,
      markerOpenedAt: new Date(launchStartedAt + 10).toISOString(),
      routeTitleVisible: true,
      panelsVisible: { projectTree: true, aiPanel: true, taskTable: true },
      visibleDialogCount: 0,
      bodyText: '小说配置',
      theme: 'paper',
      imageSkin: 'classic',
      imageDecoded: null,
      workspaceAlpha: 1,
    }
    const expectedClassic = {
      projectPath: expectedProject,
      launchStartedAt,
      theme: 'paper',
      imageSkin: 'classic',
      imageSurface: 'opaque',
    }
    expect(() => assertVisualEvidenceObservation(classicObservation, expectedClassic)).not.toThrow()
    expect(() => assertVisualEvidenceObservation({ ...classicObservation, workspaceAlpha: 0.6 }, expectedClassic)).toThrow(/opaque/i)

    const imageObservation = {
      ...classicObservation,
      imageSkin: 'anime',
      imageDecoded: true,
      workspaceAlpha: 0.6,
    }
    const expectedImage = { ...expectedClassic, imageSkin: 'anime', imageSurface: 'decoded' }
    expect(() => assertVisualEvidenceObservation(imageObservation, expectedImage)).not.toThrow()
    expect(() => assertVisualEvidenceObservation({ ...imageObservation, visibleDialogCount: 1 }, expectedImage)).toThrow()
    expect(() => assertVisualEvidenceObservation({ ...imageObservation, routeTitleVisible: false }, expectedImage)).toThrow()
    expect(() => assertVisualEvidenceObservation({ ...imageObservation, imageDecoded: false }, expectedImage)).toThrow(/decode/i)
  })

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
      visualEvidence: {
        outputEnvironment: 'AI_NOVEL_RENDERER_VISUAL_EVIDENCE_DIR',
        viewport: { width: 1440, height: 900 },
        state: {
          project: 'isolated-open-project-fixture',
          route: 'project/novel-configuration',
          panels: ['project-tree', 'ai-panel', 'task-table'],
        },
        themes: ['light', 'galaxy', 'paper', 'dark'],
        imageSkins: ['classic', 'anime', 'custom'],
        sameStateSkinTheme: 'paper',
        persistence: {
          theme: 'dark',
          imageSkin: 'custom',
          relaunches: 1,
          stateProof: ['project-open-marker', 'app-skin-root'],
          requiresTreeReselection: false,
          failClosedGuards: [
            'fresh-project-marker',
            'no-visible-dialog',
            'no-project-open-failure',
            'novel-configuration-route-visible',
            'required-panels-visible',
            'matching-theme-and-image-skin',
            'background-image-decoded',
            'completed-current-run-receipt',
            'successful-electron-exit',
            'successful-node-abi-restore',
          ],
          manifestWrite: 'candidate-then-atomic-after-postprocess',
        },
      },
      classicThemeSurfaces: {
        themed: ['light', 'galaxy', 'paper', 'dark'],
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
        approvedComputed: {
          light: {
            topbar: ['#FCFAF3', '#2B2A26'], leftRail: ['#F0EADA', '#6E6A5F'],
            projectTree: ['#F0EADA', '#2B2A26'], aiPanel: ['#F0EADA', '#2B2A26'],
            taskTable: ['#F0EADA', '#2B2A26'], workspacePage: ['#FCFAF3', '#2B2A26'],
            statusbar: ['#FCFAF3', '#6E6A5F'], statusbarHover: '#EAE3D2',
          },
          galaxy: {
            topbar: ['#0A1628', '#8BA4BE'], leftRail: ['#071220', '#8BA4BE'],
            projectTree: ['#0E1B30', '#E0ECF4'], aiPanel: ['#0E1B30', '#E0ECF4'],
            taskTable: ['#0E1B30', '#E0ECF4'], workspacePage: ['#091525', '#E0ECF4'],
            statusbar: ['#071220', '#8BA4BE'], statusbarHover: '#142640',
          },
          paper: {
            topbar: ['#FCFAF3', '#2B2A26'], leftRail: ['#F0EADA', '#6E6A5F'],
            projectTree: ['#F0EADA', '#2B2A26'], aiPanel: ['#F0EADA', '#2B2A26'],
            taskTable: ['#F0EADA', '#2B2A26'], workspacePage: ['#FCFAF3', '#2B2A26'],
            statusbar: ['#FCFAF3', '#6E6A5F'], statusbarHover: '#EAE3D2',
          },
          dark: {
            topbar: ['#181818', '#CCCCCC'], leftRail: ['#333333', '#A0A0A0'],
            projectTree: ['#252526', '#D4D4D4'], aiPanel: ['#252526', '#D4D4D4'],
            taskTable: ['#252526', '#D4D4D4'], workspacePage: ['#1E1E1E', '#D4D4D4'],
            statusbar: ['#181818', '#A0A0A0'], statusbarHover: '#2A2D2E',
          },
        },
      },
    })
  })

  it('keeps visual QA records out of the public repository', () => {
    expect(existsSync(resolve(process.cwd(), 'design-qa.md'))).toBe(false)
  })
})
