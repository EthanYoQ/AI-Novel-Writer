import { describe, expect, it, vi } from 'vitest'
import type { GenerationSession, GenerationTask } from '../../../generation/generation-harness'
import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from '../base-command'

describe('BaseWorkflowCommand writing skill injection', () => {
  it('does not infer a writing skill from the model reasoning stage', async () => {
    const complete = vi.fn(async (task: GenerationTask) => {
      expect(task.purpose).toBe('workflow')
      return {
        content: 'analysis',
        finishReason: 'stop' as const,
        budget: {} as never,
        receipt: {
          model: {} as never,
          capabilities: {} as never,
          budget: {} as never,
          finishReason: 'stop' as const,
        },
      }
    })
    const session = { budget: {}, complete } as unknown as GenerationSession
    const dependencies: WorkflowGenerationRuntimeDependencies = {
      createRuntime: async () => ({
        execute: operation => operation({ session }),
        close: async () => {},
      }),
    }
    const { BaseWorkflowCommand } = await import('../base-command')
    class Probe extends BaseWorkflowCommand<string> {
      async execute(params: CommandExecuteParams) {
        return this.executeWithGenerationRuntime('text', params, () => this.callLLM(
          'ANALYZE STYLE',
          'SYSTEM',
          params.callbacks,
          { reasoningStage: 'review' },
          params.context,
        ))
      }
    }

    await new Probe(dependencies).execute({
      step: {},
      context: {
        runId: 'analysis-run', projectPath: 'C:/novels/project',
        projectSession: { projectId: 'project', projectPath: 'C:/novels/project', leaseId: 'lease' },
        writingLanguage: 'en-US', uiLocale: 'en-US', data: {}, cancelled: false,
        writingSkills: Object.freeze({
          review: Object.freeze({
            skillId: 'user:review-craft', name: 'Review craft', stage: 'review', source: 'user',
            writingLanguage: 'en-US', content: 'This must not be injected.', utf8Bytes: 26,
          }),
        }),
      },
      callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    })

    expect(complete.mock.calls[0]?.[0].messages[1].content).toBe('ANALYZE STYLE')
    expect(complete.mock.calls[0]?.[0].promptBudget).toBeUndefined()
  })

  it('freezes one stage skill, prepends it below author contracts, and attributes its budget', async () => {
    const frozenSkill = Object.freeze({
      skillId: 'user:scene-craft',
      name: 'Scene craft',
      stage: 'drafting',
      source: 'user',
      writingLanguage: 'en-US',
      content: 'Prefer concrete action and causal change.',
      utf8Bytes: 41,
    })
    const complete = vi.fn(async (task: GenerationTask) => {
      expect(task.messages).toHaveLength(2)
      return {
        content: 'chapter',
        finishReason: 'stop' as const,
        budget: {} as never,
        receipt: {
          model: {} as never,
          capabilities: {} as never,
          budget: {} as never,
          finishReason: 'stop' as const,
        },
      }
    })
    const session = { budget: {}, complete } as unknown as GenerationSession
    const dependencies: WorkflowGenerationRuntimeDependencies = {
      createRuntime: async () => ({
        execute: operation => operation({ session }),
        close: async () => {},
      }),
    }
    const { BaseWorkflowCommand } = await import('../base-command')
    class Probe extends BaseWorkflowCommand<string> {
      async execute(params: CommandExecuteParams) {
        return this.executeWithGenerationRuntime('text', params, () => this.callLLM(
          'AUTHOR FACTS\nOUTPUT CONTRACT',
          'HIDDEN SYSTEM CONTRACT',
          params.callbacks,
          { reasoningStage: 'drafting', writingSkillStage: 'drafting' },
          params.context,
        ))
      }
    }
    const callbacks = {
      log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), setPromptBudgetReport: vi.fn(),
    }
    await new Probe(dependencies).execute({
      step: {},
      context: {
        runId: 'skill-run', projectPath: 'C:/novels/project',
        projectSession: { projectId: 'project', projectPath: 'C:/novels/project', leaseId: 'lease' },
        writingLanguage: 'en-US', uiLocale: 'en-US', data: {}, cancelled: false,
        writingSkills: Object.freeze({ drafting: frozenSkill }),
      },
      callbacks,
    })

    const task = complete.mock.calls[0]?.[0]
    expect(task.messages[1].content).toMatch(/^\[Supplemental writing skill: Scene craft\]/)
    expect(task.messages[1].content.indexOf('Prefer concrete action'))
      .toBeLessThan(task.messages[1].content.indexOf('AUTHOR FACTS'))
    expect(task.promptBudget?.sections[0]).toMatchObject({
      sectionName: 'writing-skill',
      displayName: 'Scene craft',
      messageIndex: 1,
      finalText: expect.stringContaining('Prefer concrete action'),
    })
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('Scene craft'))
  })
})
