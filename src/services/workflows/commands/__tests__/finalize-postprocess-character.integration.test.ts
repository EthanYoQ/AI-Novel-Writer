import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../../../../electron/database'
import { CharacterRepository } from '../../../../../electron/repositories/character-repository'
import { CharacterRosterRepository } from '../../../../../electron/repositories/character-roster-repository'
import { PostProcessRepository } from '../../../../../electron/repositories/post-process-repository'
import { ProjectCoreRepository } from '../../../../../electron/repositories/project-core-repository'
import {
  invalidateContinuityProjectionFrom,
  SummaryRepository,
} from '../../../../../electron/repositories/summary-repository'
import type {
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from '../../../../shared/finalized-continuity'
import type { CharacterRosterCommitRequest } from '../../../../shared/character-roster'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { RunFinalizePostProcessCommand } from '../finalize-chapter.command'
import { GenerateDraftCommand } from '../generate-draft.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

let projectPath = ''
let cardResponse = '{"updates":[]}'
let workflowContext: WorkflowContext
let observedCharacterPrompt = ''
let observedChapterNotesPrompt = ''

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function initialRosterRequest(): CharacterRosterCommitRequest {
  return {
    operationId: 'initial-roster',
    expectedRevision: 0,
    schemaVersion: 1,
    entries: [{
      name: 'Lin Lan',
      role: 'protagonist',
      gender: 'female',
      age: '29',
      appearance: 'author-written silver coat',
      personality: 'careful',
      background: 'author-written courier history',
      abilities: 'navigation',
      motivation: 'protect the archive',
      relationships: [],
      arc: 'learns to delegate',
      notes: 'author static note',
      currentState: {
        location: 'old station',
        powerLevel: 'ordinary',
        physicalState: 'tired',
        mentalState: 'alert',
        keyItems: 'brass key',
        recentEvents: 'found the sealed map',
        updatedAtChapter: 1,
        provenance: {
          location: {
            kind: 'derived',
            source: {
              draftId: 1,
              finalizationId: 'finalization-1',
              chapterNumber: 1,
              contentHash: '1'.repeat(64),
            },
          },
          recentEvents: {
            kind: 'derived',
            source: {
              draftId: 1,
              finalizationId: 'finalization-1',
              chapterNumber: 1,
              contentHash: '1'.repeat(64),
            },
          },
          keyItems: { kind: 'author', chapterNumber: 1 },
        },
      },
    }],
  }
}

function insertFinalizedDraft(
  draftId: number,
  chapterNumber: number,
  content = `Chapter ${chapterNumber} finalized content`,
): void {
  const db = getProjectDb()!
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
  const existing = db.prepare('SELECT content_id AS contentId FROM drafts WHERE id = ?')
    .get(draftId) as { contentId: number } | undefined
  if (existing) {
    db.prepare('UPDATE contents SET body = ? WHERE id = ?').run(content, existing.contentId)
    db.prepare(`
      UPDATE finalization_outbox
      SET content_hash = ?, content_snapshot = ?
      WHERE draft_id = ?
    `).run(contentHash, content, draftId)
    return
  }
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)')
    .run(draftId, content)
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, version, status, content_id, word_count)
    VALUES (?, ?, 1, 'finalized', ?, 0)
  `).run(draftId, chapterNumber, draftId)
  db.prepare(`
    INSERT INTO finalization_outbox (
      finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, content_snapshot, target_file_name, publication_status
    ) VALUES (?, ?, ?, '', ?, 0, ?, ?, 'published')
  `).run(`finalization-${draftId}`, draftId, chapterNumber, contentHash, content, `chapter-${chapterNumber}.txt`)
}

function installRealRepositoryIpc(): void {
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: async (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'prompt:load-global':
            return { templates: [], diagnostics: [] }
          case 'fs:check-exists':
            return false
          case 'db:draft-get-latest':
            return null
          case 'kb:import-text':
            return { success: true, chunkCount: 1, docId: 'doc-1' }
          case 'db:finalization-link-knowledge-document':
            return { success: true }
          case 'db:continuity-save-finalized':
            try {
              SummaryRepository.saveFinalizedContinuity(args[0] as SaveFinalizedContinuityRequest)
              return { success: true }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:continuity-save-character-state-candidates':
            try {
              SummaryRepository.saveFinalizedCharacterStateCandidates(
                args[0] as SaveFinalizedCharacterStateCandidatesRequest,
              )
              return { success: true }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:continuity-read-source':
            return SummaryRepository.readFinalizedSource(Number(args[0]))
          case 'db:blueprint-update-notes':
            return { success: true, updated: false }
          case 'db:project-core-get':
            return ProjectCoreRepository.get()
          case 'db:character-get-all':
            return CharacterRepository.getAll()
          case 'fs:list-dir':
          case 'db:blueprint-get-all':
          case 'db:narrative-thread-list-relevant':
            return []
          case 'db:continuity-list-before':
            return SummaryRepository.listFinalizedContinuityBefore(Number(args[0]))
          case 'kb:search-writing-context':
            return { success: true, value: [] }
          case 'db:blueprint-get':
            return null
          case 'db:draft-get-finalized':
            return getProjectDb()?.prepare(`
              SELECT id FROM drafts
              WHERE chapter_number = ? AND status = 'finalized'
              ORDER BY version DESC, id DESC LIMIT 1
            `).get(Number(args[0])) ?? null
          case 'db:character-roster-read':
            return CharacterRosterRepository.read()
          case 'db:character-roster-commit':
            try {
              return {
                success: true,
                receipt: CharacterRosterRepository.commit(args[0] as CharacterRosterCommitRequest),
              }
            } catch (error) {
              return { success: false, error: String(error) }
            }
          case 'db:post-process-get-latest-run':
            return PostProcessRepository.getLatestRun(String(args[0]), String(args[1]))
          case 'db:post-process-create-run':
            return {
              success: true,
              id: PostProcessRepository.createRun(args[0] as Parameters<typeof PostProcessRepository.createRun>[0]),
            }
          case 'db:post-process-get-steps':
            return PostProcessRepository.getSteps(String(args[0]))
          case 'db:post-process-mark-step-ok':
            PostProcessRepository.markStepOk(String(args[0]), String(args[1]))
            return { success: true }
          case 'db:post-process-mark-step-failed':
            PostProcessRepository.markStepFailed(String(args[0]), String(args[1]), String(args[2]))
            return { success: true }
          default:
            throw new Error(`unexpected IPC: ${channel}`)
        }
      },
    },
  })
}

function installModel(): void {
  useLLMStore.setState({
    defaultModelId: 'test-model',
    generateStream: vi.fn(async (messages, streamCallbacks) => {
      const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
      if (system.includes('character records') || system.includes('角色档案')) {
        observedCharacterPrompt = messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? ''
        streamCallbacks.onDone?.(cardResponse, undefined, 'stop')
      } else {
        observedChapterNotesPrompt = messages.find((message: { role: string; content: string }) => message.role === 'user')?.content ?? ''
        streamCallbacks.onDone?.('Lin Lan hands the brass key to Zhou Yan.', undefined, 'stop')
      }
      return `request-${Date.now()}`
    }),
  })
}

function command(draftContent: string, overrides: { onlyFailed?: boolean; stepKey?: string } = {}) {
  insertFinalizedDraft(7, 2, draftContent)
  return new RunFinalizePostProcessCommand({
    project: { path: projectPath },
    chapterNumber: 2,
    chapterTitle: 'The Handoff',
    draftContent,
    draftId: 7,
    finalizedSource: {
      draftId: 7,
      finalizationId: 'finalization-7',
      chapterNumber: 2,
      contentHash: createHash('sha256').update(draftContent, 'utf8').digest('hex'),
    },
    sourceLabel: 'Chapter 2 finalization',
    ...overrides,
  }, workflowRuntimeDependencies)
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-finalize-character-'))
  initProjectDatabase(projectPath)
  const db = CharacterRosterRepository.read()
  expect(db.status).toBe('empty')
  const projectDb = getProjectDb()
  projectDb?.prepare("INSERT OR IGNORE INTO project_core (id, project_name, writing_language) VALUES ('main', 'Test', 'en-US')").run()
  CharacterRosterRepository.commit(initialRosterRequest())
  workflowContext = {
    runId: 'finalize-character-run',
    projectPath,
    projectSession: { projectId: 'test', leaseId: 'lease-test', projectPath },
    writingLanguage: 'en-US',
    uiLocale: 'en-US',
    data: {},
    cancelled: false,
  }
  useProjectStore.setState({
    currentProject: {
      id: 'test',
      sessionLease: 'lease-test',
      name: 'Test',
      path: projectPath,
      novelConfig: { writingLanguage: 'en-US', wordsPerChapter: 3000 },
    } as never,
  })
  cardResponse = '{"updates":[]}'
  observedCharacterPrompt = ''
  observedChapterNotesPrompt = ''
  installRealRepositoryIpc()
  installModel()
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: null })
})

describe('RunFinalizePostProcessCommand character-state persistence', () => {
  it('rejects a later-chapter summary whose frozen generation changed during the model call', async () => {
    const content = 'Chapter 2 finalized content'
    insertFinalizedDraft(7, 2, content)
    const initialSource = SummaryRepository.readFinalizedSource(7)
    if (initialSource.status !== 'valid') throw new Error('expected valid finalized source')
    SummaryRepository.saveFinalizedContinuity({
      draftId: 7,
      chapterNumber: 2,
      chapterNotes: 'Existing projection remains available only as stale material.',
      facts: [],
      projectionGeneration: initialSource.snapshot.projectionGeneration,
      source: initialSource.snapshot.source,
    })

    let invalidatedDuringNotes = false
    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        if (!invalidatedDuringNotes) {
          invalidateContinuityProjectionFrom(getProjectDb()!, 1)
          invalidatedDuringNotes = true
          streamCallbacks.onDone?.('Stale in-flight notes must not be saved.', undefined, 'stop')
        } else {
          streamCallbacks.onDone?.('{"updates":[]}', undefined, 'stop')
        }
        return 'request-stale-generation'
      }),
    })

    const staleRun = await command(content).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })
    expect(invalidatedDuringNotes).toBe(true)
    expect(staleRun.steps.chapter_notes).toMatchObject({
      ok: false,
      error: expect.stringContaining('失效水位已推进'),
    })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: 'Existing projection remains available only as stale material.',
      sourceStatus: 'stale',
    })

    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('Fresh notes use the advanced generation.', undefined, 'stop')
        return 'request-fresh-generation'
      }),
    })
    const freshRun = await command(content, {
      onlyFailed: true,
      stepKey: 'chapter_notes',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })
    expect(freshRun.steps.chapter_notes).toMatchObject({ ok: true })
    expect(SummaryRepository.listFinalizedContinuityBefore(3)[0]).toMatchObject({
      chapterNotes: 'Fresh notes use the advanced generation.',
      sourceStatus: 'current',
    })
  })

  it.each([
    ['missing updates', '{}', 'updates'],
    ['non-array updates', '{"updates":{}}', 'updates'],
    ['invalid member state', '{"updates":[{"name":"Lin Lan","currentState":{"location":7}}]}', 'location'],
    ['unknown character', '{"updates":[{"name":"Zhou Yan","currentState":{"location":"harbor"}}]}', '未知角色'],
    ['duplicate identity', '{"updates":[{"name":"Lin Lan","currentState":{"location":"harbor"}},{"name":" lin lan ","currentState":{"location":"station"}}]}', '同名冲突'],
  ])('records %s as a retryable failed step without changing the real roster', async (_label, response, errorFragment) => {
    cardResponse = response

    const status = await command('A complete finalized chapter.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({
      ok: false,
      attemptCount: 1,
      error: expect.stringContaining(errorFragment),
    })
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '2')).not.toBeNull()
    expect(PostProcessRepository.getSteps(
      PostProcessRepository.getLatestRun('chapter_finalize', '2')!.id,
    ).find(step => step.stepKey === 'character_cards')).toMatchObject({ ok: false, attemptCount: 1 })
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 1,
      entries: [expect.objectContaining({
        name: 'Lin Lan',
        currentState: expect.objectContaining({ keyItems: 'brass key' }),
      })],
    })
  })

  it('covers the full finalized source and atomically persists one valid state change', async () => {
    insertFinalizedDraft(7, 2)
    const draftContent = Array.from({ length: 2350 }, (_, index) => {
      if (index === 0) return 'HEAD_FACT'
      if (index === 1175) return 'MIDDLE_ONLY_HANDOFF_FACT_LIN_LAN_GIVES_BRASS_KEY_TO_ZHOU_YAN'
      if (index === 2349) return 'TAIL_FACT'
      return `word${index}`
    }).join(' ')
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          location: 'harbor',
          keyItems: '',
          recentEvents: 'handed the brass key to Zhou Yan',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command(draftContent).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(observedCharacterPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(draftContent)
    expect(observedChapterNotesPrompt).toContain(
      'an explicitly stated cause, location, witness, or source of knowledge',
    )
    expect(observedChapterNotesPrompt).toContain(
      'Do not infer missing details or require every note to contain all of these elements',
    )
    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(CharacterRepository.getByName('Lin Lan')).toMatchObject({
      appearance: 'author-written silver coat',
      notes: 'author static note',
      currentState: {
        location: 'harbor',
        powerLevel: 'ordinary',
        physicalState: 'tired',
        mentalState: 'alert',
        keyItems: 'brass key',
        recentEvents: 'handed the brass key to Zhou Yan',
        updatedAtChapter: 2,
      },
    })
    expect(CharacterRosterRepository.read().revision).toBe(2)

    let nextChapterPrompt = ''
    const draftDependencies = {
      createRuntime: async () => ({
        execute: async (operation: (scope: { session: unknown }) => Promise<unknown>) => operation({
          session: {
            budget: {},
            complete: async (task: { messages: Array<{ role: string; content: string }> }) => {
              nextChapterPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
              throw new Error('next-chapter-prompt-captured')
            },
          },
        }),
        close: async () => {},
      }),
    }
    await expect(new GenerateDraftCommand({
      projectPath,
      chapterNumber: 3,
      title: 'After the Handoff',
      role: 'development',
      purpose: 'continue after the handoff',
      keyEvents: 'Zhou Yan leaves with the key',
      characters: ['Lin Lan'],
      userGuidance: '',
      wordsTarget: 100,
    }, { dependencies: draftDependencies as never }).execute({
      step: {},
      context: { ...workflowContext, runId: 'next-chapter-probe' },
      callbacks: { ...callbacks(), replaceText: vi.fn() },
    })).rejects.toThrow('next-chapter-prompt-captured')
    expect(nextChapterPrompt).toContain('Lin Lan (protagonist)')
    expect(nextChapterPrompt).toContain('keyItems@chapter1: brass key')
    expect(nextChapterPrompt).not.toContain('handed the brass key to Zhou Yan')
  })

  it('keeps protected author and legacy state while retaining source-only lookup candidates', async () => {
    const draftContent = [
      'Lin Lan places the brass key in Zhou Yan\'s palm at New Harbor.',
      '',
      'She checks the tide ledger before dawn.',
    ].join('\n')
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          keyItems: '',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command(draftContent).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({ ok: true })
    expect(CharacterRepository.getByName('Lin Lan')?.currentState).toMatchObject({
      keyItems: 'brass key',
    })
    expect(CharacterRosterRepository.read().revision).toBe(2)
    const frozenSource = SummaryRepository.readFinalizedSource(7)
    if (frozenSource.status !== 'valid') throw new Error('expected valid finalized source')
    SummaryRepository.saveFinalizedContinuity({
      draftId: 7,
      chapterNumber: 2,
      chapterNotes: 'The locator candidate remains separate from confirmed continuity facts.',
      facts: [],
      projectionGeneration: frozenSource.snapshot.projectionGeneration,
      source: frozenSource.snapshot.source,
    })
    const projection = SummaryRepository.listFinalizedContinuityBefore(3)[0]!
    expect(projection.facts).toEqual([])
    expect(projection.characterStateCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        characterName: 'Lin Lan',
        field: 'keyItems',
        value: '',
      }),
    ]))
    insertFinalizedDraft(8, 3, 'Chapter 3 ends with Lin Lan opening the tide ledger before dawn.')

    let nextChapterPrompt = ''
    const draftDependencies = {
      createRuntime: async () => ({
        execute: async (operation: (scope: { session: unknown }) => Promise<unknown>) => operation({
          session: {
            budget: {},
            complete: async (task: { messages: Array<{ role: string; content: string }> }) => {
              nextChapterPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
              throw new Error('candidate-source-prompt-captured')
            },
          },
        }),
        close: async () => {},
      }),
    }
    await expect(new GenerateDraftCommand({
      projectPath,
      chapterNumber: 4,
      title: 'Before Dawn',
      role: 'development',
      purpose: 'continue the tide investigation',
      keyEvents: 'Lin Lan reads the ledger two chapters after the handoff',
      characters: ['Lin Lan'],
      userGuidance: '',
      wordsTarget: 100,
    }, { dependencies: draftDependencies as never }).execute({
      step: {},
      context: { ...workflowContext, runId: 'candidate-source-probe' },
      callbacks: { ...callbacks(), replaceText: vi.fn() },
    })).rejects.toThrow('candidate-source-prompt-captured')
    expect(nextChapterPrompt).toContain('Lin Lan places the brass key in Zhou Yan\'s palm at New Harbor.')
    expect(nextChapterPrompt).toContain('keyItems@chapter1: brass key')
    expect(nextChapterPrompt).not.toContain('"field":"keyItems"')
    expect(nextChapterPrompt).not.toContain('finalized#2:evidence-not-locatable')
  })

  it('rejects an older Chinese chapter retry after a newer character state is committed', async () => {
    workflowContext.writingLanguage = 'zh-CN'
    insertFinalizedDraft(7, 2)
    insertFinalizedDraft(8, 3)
    const beforeChapterThree = CharacterRosterRepository.read()
    const existing = beforeChapterThree.entries[0]
    const chapterThree = CharacterRosterRepository.commit({
      operationId: '第三章角色进度',
      expectedRevision: beforeChapterThree.revision,
      schemaVersion: 1,
      intent: 'chapter_progress',
      source: {
        draftId: 8,
        finalizationId: 'finalization-8',
        chapterNumber: 3,
        contentHash: createHash('sha256').update('Chapter 3 finalized content', 'utf8').digest('hex'),
      },
      entries: [{
        ...existing,
        currentState: {
          location: '新港',
          powerLevel: '普通人',
          physicalState: '疲惫',
          mentalState: '警觉',
          keyItems: '',
          recentEvents: '第三章已经交出黄铜钥匙',
          updatedAtChapter: 3,
          provenance: {
            location: { kind: 'derived', source: {
              draftId: 8,
              finalizationId: 'finalization-8',
              chapterNumber: 3,
              contentHash: createHash('sha256').update('Chapter 3 finalized content', 'utf8').digest('hex'),
            } },
            recentEvents: { kind: 'derived', source: {
              draftId: 8,
              finalizationId: 'finalization-8',
              chapterNumber: 3,
              contentHash: createHash('sha256').update('Chapter 3 finalized content', 'utf8').digest('hex'),
            } },
          },
        },
      }],
    })
    cardResponse = JSON.stringify({
      updates: [{
        name: 'Lin Lan',
        currentState: {
          location: '旧站',
          keyItems: '黄铜钥匙',
          recentEvents: '第二章准备交出钥匙',
          updatedAtChapter: 2,
        },
      }],
    })

    const status = await command('第二章定稿：林岚准备交出黄铜钥匙。', {
      onlyFailed: true,
      stepKey: 'character_cards',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(status.steps.character_cards).toMatchObject({
      ok: false,
      error: expect.stringContaining('较新章节'),
    })
    expect(CharacterRosterRepository.read()).toEqual(chapterThree.snapshot)
    expect(CharacterRepository.getByName('Lin Lan')?.currentState).toMatchObject({
      location: '新港',
      keyItems: 'brass key',
      recentEvents: '第三章已经交出黄铜钥匙',
      updatedAtChapter: 3,
    })
  })

  it('keeps a legal empty update successful without creating a roster revision', async () => {
    const chineseChapter = [
      '头部事实：林岚抵达旧站。',
      '雨水冲刷石阶。'.repeat(1200),
      '中段事实：林岚检查封印但没有改变角色状态。',
      '列车穿过山谷。'.repeat(1200),
      '尾部事实：林岚仍在旧站。',
    ].join('\n')
    const status = await command(chineseChapter).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(observedCharacterPrompt).toContain(chineseChapter)
    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })

  it('cancels before commit and safely retries only the unfinished post-process step', async () => {
    insertFinalizedDraft(7, 2)
    let cancelledOnce = false
    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        const system = messages.find((message: { role: string; content: string }) => message.role === 'system')?.content ?? ''
        if (system.includes('character records')) {
          if (!cancelledOnce) {
            cancelledOnce = true
            workflowContext.cancelled = true
          }
          streamCallbacks.onDone?.(JSON.stringify({
            updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
          }), undefined, 'stop')
        } else {
          streamCallbacks.onDone?.('The handoff is complete.', undefined, 'stop')
        }
        return 'request-cancellation'
      }),
    })

    await expect(command('The brass key changes hands.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })).rejects.toThrow(/cancelled/i)
    expect(CharacterRosterRepository.read().revision).toBe(1)
    const interruptedRun = PostProcessRepository.getLatestRun('chapter_finalize', '2')
    expect(interruptedRun).not.toBeNull()
    expect(PostProcessRepository.getSteps(interruptedRun!.id)
      .find(step => step.stepKey === 'character_cards')).toMatchObject({ ok: false, attemptCount: 0 })

    workflowContext.cancelled = false
    cardResponse = JSON.stringify({
      updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
    })
    installModel()
    const status = await command('The brass key changes hands.', { onlyFailed: true }).execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })

    expect(status.steps.character_cards).toMatchObject({ ok: true, attemptCount: 1 })
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 2,
      entries: [expect.objectContaining({
        currentState: expect.objectContaining({ location: 'harbor', keyItems: 'brass key' }),
      })],
    })
    expect(PostProcessRepository.getLatestRun('chapter_finalize', '2')?.id).toBe(interruptedRun!.id)
  })

  it('retries one selected failed step without invoking successful steps again', async () => {
    insertFinalizedDraft(7, 2)
    cardResponse = '{}'
    const initial = await command('The brass key changes hands.').execute({
      step: {}, context: workflowContext, callbacks: callbacks(),
    })
    expect(initial.steps.character_cards.ok).toBe(false)
    expect(initial.steps.kb_import.ok).toBe(true)
    expect(initial.steps.chapter_notes.ok).toBe(true)

    cardResponse = JSON.stringify({
      updates: [{ name: 'Lin Lan', currentState: { location: 'harbor' } }],
    })
    const generateStream = useLLMStore.getState().generateStream as ReturnType<typeof vi.fn>
    generateStream.mockClear()

    const repaired = await command('The brass key changes hands.', {
      onlyFailed: true,
      stepKey: 'character_cards',
    }).execute({ step: {}, context: workflowContext, callbacks: callbacks() })

    expect(generateStream).toHaveBeenCalledOnce()
    const messages = generateStream.mock.calls[0]?.[0] as Array<{ role: string; content: string }>
    expect(messages.find(message => message.role === 'system')?.content).toMatch(/character records|角色档案/)
    expect(repaired.steps.character_cards.ok).toBe(true)
    expect(repaired.steps.kb_import.ok).toBe(true)
    expect(repaired.steps.chapter_notes.ok).toBe(true)
  })
})
