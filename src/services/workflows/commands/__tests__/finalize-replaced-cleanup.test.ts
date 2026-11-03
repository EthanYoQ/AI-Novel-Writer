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
  it('本章有被替换的旧定稿时，导入知识库之后先删旧文档、再删旧文件，然后才生成章节要点；两步都不阻断', () => {
    expect(steps(true).map(step => [step.key, step.critical])).toEqual([
      ['kb_import', true],
      ['remove_replaced_knowledge', false],
      ['remove_replaced_manuscripts', false],
      ['chapter_notes', true],
      ['character_cards', false],
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
})
