import { describe, expect, it, vi } from 'vitest'
import type { GenerationRuntime } from '../generation/generation-runtime'
import type { GenerationTask } from '../generation/generation-harness'

import {
  createNarrativeThreadCandidateGenerator,
  NARRATIVE_THREAD_CANDIDATE_BUDGET,
  parseNarrativeThreadEventCandidates,
  parseNarrativeThreadPlanCandidates,
} from '../narrative-thread-candidate-generator'

describe('narrative thread AI candidate boundary', () => {
  it('keeps blueprint analysis as plan-only candidates even when the model claims an event already happened', () => {
    const candidates = parseNarrativeThreadPlanCandidates(JSON.stringify({
      candidates: [{
        title: '门框上的刻痕',
        type: '伏笔',
        targetStartChapter: 2,
        targetEndChapter: 8,
        authorIntent: '模型声称第一章已经埋设；作者仍需先确认人工计划。',
        eventType: 'planted',
        evidence: '门框已有三道刻痕。',
      }],
    }))

    expect(candidates).toEqual([{
      title: '门框上的刻痕',
      type: '伏笔',
      targetStartChapter: 2,
      targetEndChapter: 8,
      authorIntent: '模型声称第一章已经埋设；作者仍需先确认人工计划。',
    }])
    expect(candidates[0]).not.toHaveProperty('eventType')
    expect(candidates[0]).not.toHaveProperty('evidence')
  })

  it('accepts only bounded event candidates whose short evidence appears in the frozen finalized text', () => {
    const finalized = '林岚推开旧仓库的门，发现门框上有三道平行刻痕。她没有声张。'
    const candidates = parseNarrativeThreadEventCandidates(JSON.stringify({
      candidates: [
        { type: 'planted', evidence: '门框上有三道平行刻痕', reason: '第一章完成埋设。' },
        { type: 'resolved', evidence: '正文中不存在的银钥匙', reason: '不能确认。' },
        { type: 'planned', evidence: '她没有声张', reason: '非法事件类型。' },
      ],
    }), finalized)

    expect(candidates).toEqual([{
      type: 'planted',
      evidence: '门框上有三道平行刻痕',
      reason: '第一章完成埋设。',
    }])
  })

  it('freezes the user-selected model into one existing generation runtime request', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = {
      execute: vi.fn(async (operation) => operation({
        session: {
          budget: {
            maxAttempts: 1,
            maxRequestedOutputTokens: 4096,
            maxRequestedOutputTokensPerAttempt: 4096,
            deadlineAt: Date.now() + 120_000,
          },
          complete: vi.fn(async (task: GenerationTask) => {
            observedTask = task
            return {
              status: 'completed' as const,
              content: JSON.stringify({ candidates: [{
                title: '失踪的日志', type: '长期承诺', targetStartChapter: 2,
                targetEndChapter: 8, authorIntent: '第八章揭示伪造者。',
              }] }),
              finishReason: 'stop' as const,
              receipt: {} as never,
            }
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime
    const createRuntime = vi.fn().mockResolvedValue(runtime)
    const generator = createNarrativeThreadCandidateGenerator({ createRuntime })

    await expect(generator.generatePlanCandidates({
      modelId: 'grok-frozen',
      writingLanguage: 'zh-CN',
      blueprint: {
        chapterNumber: 2, title: '日志失踪', role: '发展', purpose: '引出伪造者',
        keyEvents: '航海日志从保险柜消失。', characters: ['林岚'], suspenseHook: '',
        userGuidance: '', notes: '', notesUpdatedAt: '',
      },
      signal: new AbortController().signal,
    })).resolves.toHaveLength(1)

    expect(createRuntime).toHaveBeenCalledWith({
      budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
      modelId: 'grok-frozen',
    })
    expect(observedTask).toMatchObject({
      purpose: 'narrative-thread-plan-candidate',
      reasoningStage: 'planning',
      output: 'structured-data',
    })
  })

  it('binds an event candidate to the supplied finalized source instead of trusting model identity fields', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = {
      execute: vi.fn(async (operation) => operation({
        session: {
          budget: {
            maxAttempts: 1, maxRequestedOutputTokens: 4096,
            maxRequestedOutputTokensPerAttempt: 4096, deadlineAt: Date.now() + 120_000,
          },
          complete: vi.fn(async (task: GenerationTask) => {
            observedTask = task
            return {
              status: 'completed' as const,
              content: JSON.stringify({ candidates: [{
                planId: 999, draftId: 999, chapterNumber: 999,
                type: 'progressing', evidence: '林岚把日志藏进抽屉', reason: '线索得到推进。',
              }] }),
              finishReason: 'stop' as const,
              receipt: {} as never,
            }
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime
    const createRuntime = vi.fn().mockResolvedValue(runtime)
    const generator = createNarrativeThreadCandidateGenerator({ createRuntime })

    await expect(generator.generateEventCandidates({
      modelId: 'glm-frozen',
      writingLanguage: 'zh-CN',
      plan: {
        id: 7, title: '失踪的日志', type: '长期承诺', targetStartChapter: 2,
        targetEndChapter: 8, authorIntent: '第八章揭示伪造者。', status: 'planted',
        dormantChapters: 0, overdue: false, events: [], createdAt: '', updatedAt: '',
      },
      draftId: 41,
      chapterNumber: 3,
      finalizedContent: '林岚把日志藏进抽屉，又故意把窗户留了一条缝。',
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      type: 'progressing', evidence: '林岚把日志藏进抽屉', reason: '线索得到推进。',
    }])

    expect(createRuntime).toHaveBeenCalledWith({
      budget: NARRATIVE_THREAD_CANDIDATE_BUDGET,
      modelId: 'glm-frozen',
    })
    expect(observedTask).toMatchObject({
      purpose: 'narrative-thread-event-candidate',
      reasoningStage: 'review',
      output: 'structured-data',
    })
  })
})
