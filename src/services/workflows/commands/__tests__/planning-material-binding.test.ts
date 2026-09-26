import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../../../../electron/migrations/baseline-schema'
import { buildGenerationSourceBinding, type GenerationSourceBindingResult } from '../../../../../electron/services/generation-source-binding'
import { generationOutputContract, type BeginGenerationRequest } from '../../../../shared/generation-owner-contract'
import { getBuiltinPromptTemplate } from '../../../builtin-prompt-templates'
import { ExtractPlanningMaterialCharactersCommand } from '../planning-material.command'
import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const originalProject = useProjectStore.getState().currentProject
const originalModel = useLLMStore.getState().defaultModelId
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: originalProject }); useLLMStore.setState({ defaultModelId: originalModel }) })

it.each([['人物设定.txt'], ['foo.txt'], ['人物设定.txt', '人物设定.txt']])('资料文件名 %j 经默认命令提交真实来源绑定', async (...names: string[]) => {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'material-binding-'))
  const db = new Database(':memory:')
  try {
    initializeLegacyBaselineSchema(db)
    db.prepare("INSERT INTO project_core(id,project_name) VALUES('main','合成资料项目')").run()
    const session = { projectId: '资料项目', leaseId: '资料会话', projectPath: root }
    useProjectStore.setState({ currentProject: { id: session.projectId, sessionLease: session.leaseId, path: root, novelConfig: {} } as never })
    useLLMStore.setState({ defaultModelId: '合成模型' })
    const materials = names.map((fileName, index) => ({ fileName, text: '  作者人物资料' + index + '。\r\n' }))
    let binding: GenerationSourceBindingResult | undefined
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel !== 'generation:begin') throw new Error('禁止物理生成：' + channel)
      const selection = args[0] as BeginGenerationRequest
      const h = 'a'.repeat(64)
      binding = buildGenerationSourceBinding({ db, projectStorageRoot: root, globalDataRoot: root,
        readBuiltinPrompt: (key, language) => JSON.stringify(getBuiltinPromptTemplate(key, language)) }, {
        ...selection, projectId: session.projectId, epoch: session.leaseId,
        modelReceipt: { modelId: '合成模型', provider: 'openai', protocol: 'openai', modelName: 'synthetic',
          modelRevision: h, endpointFingerprint: h, capabilityEvidence: { source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' },
            subjectFingerprint: h, contextWindowTokens: null, maxOutputTokens: 1000, reasoning: null, structuredOutput: null, usage: null } },
        policy: { version: 'synthetic-v1' }, outputContract: generationOutputContract(selection),
      })
      throw new Error('真实来源绑定完成，停止零模型探针')
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}) } })
    await expect(new ExtractPlanningMaterialCharactersCommand(materials).execute({ step: {},
      context: { runId: '资料动作', projectPath: root, projectSession: session, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false },
      callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() },
    })).rejects.toThrow('真实来源绑定完成')
    expect(invoke).toHaveBeenCalledOnce()
    const frozen = binding!.binding.sourceManifest.authorInputs as { id: string; text: string }[]
    expect(frozen.map(item => JSON.parse(item.text))).toEqual(materials)
    expect(new Set(frozen.map(item => item.id)).size).toBe(materials.length)
    expect(frozen.map(item => item.id)).toEqual(materials.map((_item, index) => 'planning-material:' + index))
    const sources = binding!.materials.filter(item => item.ref.sourceId.startsWith('author-action:'))
    expect(sources.map(item => item.text)).toEqual(frozen.map(item => item.text))
    for (const [index, source] of sources.entries()) {
      expect(source.ref.contentHash).toBe(createHash('sha256').update(frozen[index].text).digest('hex'))
      expect(source.ref.contentHash).not.toBe(createHash('sha256').update(materials[index].text).digest('hex'))
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
