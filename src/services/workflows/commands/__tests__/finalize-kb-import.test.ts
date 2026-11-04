import { afterEach, expect, it, vi } from 'vitest'

import type { WorkflowContext } from '../../../../stores/workflow-store'
import { buildFinalizePostProcessSteps, type FinalizePostProcessGeneration } from '../finalize-chapter.command'

const PROJECT_PATH = 'C:\novels\A'
const SESSION = { projectId: 'A', leaseId: 'lease-A', projectPath: PROJECT_PATH }
const generation: FinalizePostProcessGeneration = { complete: async () => { throw new Error('unused') } }

function context(): WorkflowContext {
  return { runId: 'kb-import', projectPath: PROJECT_PATH, projectSession: SESSION, uiLocale: 'zh-CN', writingLanguage: 'zh-CN', data: {}, cancelled: false }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('#571 导入知识库因磁盘不支持失败：登记码原样记进步骤，界面再按当时的语言说明', async () => {
  const invoke = vi.fn(async () => ({ success: false, error: 'KNOWLEDGE_BASE_VOLUME_UNSUPPORTED' }))
  vi.stubGlobal('window', { aiNovelAPI: { invoke } })
  const [kbImport] = buildFinalizePostProcessSteps({ path: PROJECT_PATH }, 1, '雾钟', '正文', generation, 42)

  await expect(kbImport!.executor({ log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }, context()))
    .rejects.toThrow(/^KNOWLEDGE_BASE_VOLUME_UNSUPPORTED$/u)
  expect(invoke).toHaveBeenCalledTimes(1)
})
