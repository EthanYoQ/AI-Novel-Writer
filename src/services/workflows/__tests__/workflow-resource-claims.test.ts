import { afterEach, describe, expect, it, vi } from 'vitest'

import { workflowResourceClaimsConflict } from '../../../shared/workflow-resource-claims'
import type { ImportPurpose, ImportRunSnapshot } from '../../../shared/import-run'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import {
  createArchitectureWorkflow,
  migrateLegacyCharacterRoster,
} from '../architecture-workflow'
import {
  createChapterWorkflow,
  createFinalizeWorkflow,
} from '../chapter-workflow'
import { createBatchChapterWorkflow } from '../batch-chapter-workflow'
import { createDirectoryWorkflow } from '../directory-workflow'
import { createImportWorkflow } from '../import-workflow'

vi.mock('../commands/legacy-character-roster-repair.command', () => ({
  RepairLegacyCharacterRosterCommand: class {
    async execute(): Promise<void> {}
  },
}))

const PROJECT_PATH = 'C:\\novels\\workflow-resource-claims'
const PROJECT_SESSION = Object.freeze({
  projectId: 'workflow-resource-claims',
  leaseId: 'lease-workflow-resource-claims',
  projectPath: PROJECT_PATH,
})

function setCurrentProject(): void {
  useProjectStore.setState({
    currentProject: {
      id: PROJECT_SESSION.projectId,
      name: 'Workflow resource claims',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: {
        totalChapters: 3,
        globalGuidance: '',
        genre: 'mystery',
      },
    } as never,
  })
}

function createFinalize(chapterNumber: number) {
  return createFinalizeWorkflow({
    projectPath: PROJECT_PATH,
    chapterNumber,
    chapterTitle: `Chapter ${chapterNumber}`,
    draftPath: `vela://draft/${chapterNumber}`,
    draftContent: `Draft ${chapterNumber}`,
  }, PROJECT_SESSION)
}

function createDraft(chapterNumber: number) {
  return createChapterWorkflow({
    projectPath: PROJECT_PATH,
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    role: 'development',
    purpose: 'advance the plot',
    characters: [],
    keyEvents: 'an event',
  }, PROJECT_SESSION)
}

function createImportRun(purpose: ImportPurpose, totalChapters = 1): ImportRunSnapshot {
  return {
    id: `import-${purpose}`,
    purpose,
    rootRunId: `import-${purpose}`,
    effectNamespace: `import:${purpose}:import-${purpose}`,
    sourceDisplay: [{ displayName: 'novel.txt', mediaType: 'text/plain', size: 20 }],
    locale: 'en-US',
    stage: purpose === 'author-manuscript' ? 'author-commit' : 'knowledge',
    status: 'running',
    completedBatches: {},
    lastError: '',
    resumable: true,
    cancelRequested: false,
    totalChapters,
    totalContentSize: 20,
    manifestChapterCount: totalChapters,
    manifestContentSize: 20,
    manifestWordCount: 20,
    completedChapters: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...(purpose === 'author-manuscript'
      ? { authorityFingerprint: 'a'.repeat(64), manifestFingerprint: 'b'.repeat(64) }
      : {}),
  }
}

function createImport(purpose: ImportPurpose, totalChapters = 1) {
  return createImportWorkflow({
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    run: createImportRun(purpose, totalChapters),
    executionOwner: 'resource-claim-test',
  })
}

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
})

describe('workflow factory resource claims', () => {
  it('serializes finalization against shared fact writers', () => {
    setCurrentProject()
    const firstFinalize = createFinalize(1)
    const secondFinalize = createFinalize(2)
    const directory = createDirectoryWorkflow(
      { mode: 'full' },
      PROJECT_PATH,
      PROJECT_SESSION,
    )

    expect(firstFinalize.resourceKeys).toEqual(expect.arrayContaining([
      'character-roster',
      'continuity',
      'chapter-summary',
    ]))
    expect(directory.resourceKeys).toContain('character-roster')
    expect(workflowResourceClaimsConflict(firstFinalize, secondFinalize)).toBe(true)
    expect(workflowResourceClaimsConflict(firstFinalize, directory)).toBe(true)
  })

  it('keeps different chapter drafts concurrent when neither writes shared facts', () => {
    expect(workflowResourceClaimsConflict(createDraft(1), createDraft(2))).toBe(false)
  })

  it('claims shared facts only for batch workflows that auto-finalize', () => {
    const autoFinalize = createBatchChapterWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      startChapterNumber: 1,
      chapterCount: 1,
      generationModelId: 'test-model',
      completionMode: 'auto_finalize',
    })
    const reviewDrafts = createBatchChapterWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      startChapterNumber: 3,
      chapterCount: 1,
      generationModelId: 'test-model',
      completionMode: 'draft_review',
    })

    expect(autoFinalize.resourceKeys).toEqual(expect.arrayContaining([
      'character-roster',
      'continuity',
      'chapter-summary',
    ]))
    expect(reviewDrafts.resourceKeys).toEqual(['chapter:3'])
    expect(workflowResourceClaimsConflict(autoFinalize, createFinalize(2))).toBe(true)
    expect(workflowResourceClaimsConflict(reviewDrafts, createFinalize(2))).toBe(false)
  })

  it('serializes character architecture against other character roster writers', () => {
    setCurrentProject()
    const architecture = createArchitectureWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      selectedSteps: ['characters'],
    })
    const finalize = createFinalize(1)
    const directory = createDirectoryWorkflow(
      { mode: 'full' },
      PROJECT_PATH,
      PROJECT_SESSION,
    )

    expect(architecture.resourceKeys).toContain('character-roster')
    expect(workflowResourceClaimsConflict(architecture, finalize)).toBe(true)
    expect(workflowResourceClaimsConflict(architecture, directory)).toBe(true)
  })

  it('does not claim the character roster when the character architecture step is omitted', () => {
    setCurrentProject()
    const premiseOnly = createArchitectureWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      selectedSteps: ['premise'],
    })

    expect(premiseOnly.resourceKeys).toEqual(['architecture'])
  })

  it('serializes the explicit legacy roster repair against roster writers', async () => {
    setCurrentProject()
    await migrateLegacyCharacterRoster(PROJECT_PATH)

    const repair = useWorkflowStore.getState().history.find(run => run.type === 'post_process')
    expect(repair).toBeDefined()
    expect(repair?.resourceKeys ?? []).toContain('character-roster')
    const architecture = createArchitectureWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      selectedSteps: ['characters'],
    })
    const directory = createDirectoryWorkflow(
      { mode: 'full' },
      PROJECT_PATH,
      PROJECT_SESSION,
    )
    expect(workflowResourceClaimsConflict(repair ?? {}, architecture)).toBe(true)
    expect(workflowResourceClaimsConflict(repair ?? {}, createFinalize(1))).toBe(true)
    expect(workflowResourceClaimsConflict(repair ?? {}, directory)).toBe(true)
  })

  it('serializes reference imports against every project-fact writer they overlap', () => {
    setCurrentProject()
    const referenceImport = createImport('reference')
    const architecture = createArchitectureWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      selectedSteps: ['characters'],
    })
    const directory = createDirectoryWorkflow(
      { mode: 'full' },
      PROJECT_PATH,
      PROJECT_SESSION,
    )

    expect(referenceImport.resourceKeys).toEqual([
      'novel-config',
      'architecture',
      'character-roster',
      'blueprints',
    ])
    expect(workflowResourceClaimsConflict(referenceImport, createFinalize(1))).toBe(true)
    expect(workflowResourceClaimsConflict(referenceImport, directory)).toBe(true)
    expect(workflowResourceClaimsConflict(referenceImport, architecture)).toBe(true)
  })

  it('serializes author imports on finalized facts while preserving an unrelated draft', () => {
    setCurrentProject()
    const authorImport = createImport('author-manuscript', 2)
    const architecture = createArchitectureWorkflow({
      projectPath: PROJECT_PATH,
      projectSession: PROJECT_SESSION,
      selectedSteps: ['characters'],
    })
    const directory = createDirectoryWorkflow(
      { mode: 'full' },
      PROJECT_PATH,
      PROJECT_SESSION,
    )

    expect(authorImport.resourceKeys).toEqual([
      'chapter:1',
      'chapter:2',
      'character-roster',
      'continuity',
      'chapter-summary',
    ])
    expect(workflowResourceClaimsConflict(authorImport, createFinalize(3))).toBe(true)
    expect(workflowResourceClaimsConflict(authorImport, directory)).toBe(true)
    expect(workflowResourceClaimsConflict(authorImport, architecture)).toBe(true)
    expect(workflowResourceClaimsConflict(authorImport, createDraft(3))).toBe(false)
  })
})
