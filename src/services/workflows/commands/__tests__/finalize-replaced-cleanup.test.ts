import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowContext } from '../../../../stores/workflow-store'
import { buildFinalizePostProcessSteps, type FinalizePostProcessGeneration } from '../finalize-chapter.command'

const PROJECT_PATH = 'C:\\novels\\A'
const SESSION = { projectId: 'A', leaseId: 'lease-A', projectPath: PROJECT_PATH }
const generation: FinalizePostProcessGeneration = { complete: async () => { throw new Error('unused') } }

function steps(replacesEarlierFinal: boolean) {
  return buildFinalizePostProcessSteps({ path: PROJECT_PATH }, 1, '雾钟', '正文', generation, 42, [], 'zh-CN',
    undefined, undefined, undefined, replacesEarlierFinal)
}

function context(): WorkflowContext {
  return { runId: 'cleanup', projectPath: PROJECT_PATH, projectSession: SESSION, uiLocale: 'zh-CN', writingLanguage: 'zh-CN', data: {}, cancelled: false }
}

const callbacks = () => ({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('重开再定稿后的清理步骤（ADR-0024）', () => {
  it('本章有被替换的旧定稿时，生成章节要点与角色状态之后先删旧文档、再删旧文件；两步都不是关键步骤', () => {
    expect(steps(true).map(step => [step.key, step.critical])).toEqual([
      ['kb_import', true],
      ['chapter_notes', true],
      ['character_cards', false],
      ['remove_replaced_knowledge', false],
      ['remove_replaced_manuscripts', false],
    ])
    expect(steps(false).map(step => step.key)).toEqual(['kb_import', 'chapter_notes', 'character_cards'])
  })

  it('主进程报出的清理结果原样记进步骤，界面再按当时的语言说明；清理完成时写进日志', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'chapter:remove-replaced-manuscripts'
      ? { success: false, error: 'FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 雾钟.txt"]' }
      : { success: true })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
    const [knowledge, manuscripts] = steps(true).filter(step => step.key.startsWith('remove_replaced_'))
    const stepCallbacks = callbacks()

    await knowledge!.executor(stepCallbacks, context())
    await expect(manuscripts!.executor(callbacks(), context())).rejects.toThrow(/^FINALIZATION_REPLACED_MANUSCRIPT_KEPT:\["第1章 雾钟\.txt"\]$/u)

    expect(invoke.mock.calls).toEqual([
      ['chapter:remove-replaced-knowledge', 42, PROJECT_PATH, SESSION],
      ['chapter:remove-replaced-manuscripts', 42, PROJECT_PATH, SESSION],
    ])
    expect(stepCallbacks.log).toHaveBeenCalledWith('已删除被替换的旧版本收进知识库的文档')
  })

  it('缺工作流上下文与工作流已取消分开报，已取消按工作流记下的界面语言说明，都不请求主进程', async () => {
    const invoke = vi.fn()
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
    const [knowledge] = steps(true).filter(step => step.key.startsWith('remove_replaced_'))

    await expect(knowledge!.executor(callbacks(), undefined)).rejects.toThrow('定稿后处理缺少冻结工作流上下文')
    await expect(knowledge!.executor(callbacks(), { ...context(), uiLocale: 'en-US', cancelled: true })).rejects.toThrow(/^Workflow was cancelled\.$/u)
    expect(invoke).not.toHaveBeenCalled()
  })
})
