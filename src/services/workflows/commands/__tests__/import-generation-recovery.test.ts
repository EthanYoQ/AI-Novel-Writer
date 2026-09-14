import type { ImportGlobalFactsRequest } from '../../../../shared/import-global-facts'
import { afterEach, expect, it, vi } from 'vitest'
import { AnalyzeWritingStyleCommand } from '../analyze-style.command'
import { InferGlobalSettingsCommand, InferBlueprintsPerChapterCommand, importGenerationSelection } from '../import-novel.command'
import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { WorkflowContext } from '../../../../stores/workflow-store'

const oldProject = useProjectStore.getState().currentProject
const oldModel = useLLMStore.getState().defaultModelId
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: oldProject }); useLLMStore.setState({ defaultModelId: oldModel }) })

function validInference() {
  const card = (name: string, role: 'protagonist' | 'supporting' | 'antagonist') => ({
    name,
    role,
    gender: '未知',
    age: 18,
    appearance: '外貌明确',
    personality: '性格明确',
    background: '背景明确',
    abilities: '能力明确',
    motivation: '动机明确',
    relationships: [],
    arc: '角色弧光',
    notes: '待确认',
    currentState: {
      location: '城中',
      powerLevel: '普通',
      physicalState: '正常',
      mentalState: '警觉',
      keyItems: '无',
      recentEvents: '启程',
      updatedAtChapter: 1,
    },
  })
  return {
    novelConfig: {
      genre: '现实',
      subGenre: '讽刺',
      targetAudience: '通用',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '主角在冲突中逐步认识世界。',
      worldSetting: '现实社会。',
      goldenFinger: '无。',
      protagonistProfile: '敏感而倔强。',
      globalGuidance: '保持克制叙事。',
    },
    architectureFiles: {
      premise: '个人与环境持续冲突。',
      worldbuilding: '现实社会结构。',
      synopsis: '主角经历挫折并作出选择。',
    },
    characterCards: [
      card('陆舟', 'protagonist'),
      card('苏绾', 'supporting'),
      card('顾岩', 'antagonist'),
    ],
  }
}

it.each(['global', 'style', 'blueprints'] as const)('%s 恢复使用 main 冻结章节与模板，保留原运行和模型', async stage => {
  const session = { projectId: '导入项目', leaseId: '当前会话', projectPath: 'C:/合成导入' }
  const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: '原导入预算', runId: '原阶段运行' }
  const slot = { runId: '持久导入', stage, batchId: stage === 'blueprints' ? 'chapters:1:1' : 'done' }
  const view = { handle, status: 'running', nonReplayable: false, artifacts: [], budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 } }
  const key = stage === 'style' ? 'analyze_writing_style' : stage === 'global' ? 'infer_novel_config_with_vectors' : 'infer_single_chapter_blueprint'
  const frozenContext = { slot, manifestFingerprint: 'a'.repeat(64), totalChapters: 99, totalWords: 99000, core: { genre: '冻结类型' }, chapters: [{ number: 1, title: '冻结章节', content: '  不可替换的冻结正文  \r\n', wordCount: 10, contentFingerprint: 'b'.repeat(64) }], prompts: { [key]: { key, name: '冻结模板', content: '冻结模板正文 {{sample_text}} {{first_chapter}} {{sample_content}} {{chapter_content}} {{novel_config_summary}}', systemRole: '冻结身份' } } }
  useProjectStore.setState({ currentProject: { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, novelConfig: { writingStyle: '原文风' } } as never })
  useLLMStore.setState({ defaultModelId: '后来选择的模型' })
  const context: WorkflowContext = { runId: '重建后的UI运行', projectPath: session.projectPath, projectSession: session, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', cancelled: false, data: { importGenerationSlot: slot, importRunExecution: { ownerId: '当前执行' }, chapters: [{ number: 99, content: '不得使用的新章节', title: '后来内容', wordCount: 20 }], novelConfigSummary: '不得使用的新概要' } }
  const tasks: string[] = []
  const invoke = vi.fn(async (channel: string, request: unknown) => {
    if (channel === 'import-generation:read') { expect(request).toEqual({ slot }); return { view, modelId: '原模型', frozenContext } }
    if (channel === 'generation:read') return view
    if (channel === 'import-generation:execute') {
      const input = request as { handle: unknown; ordinal: number; task: unknown }
      expect(input.handle).toEqual(handle)
      expect(input.ordinal).toBe(tasks.length)
      tasks.push(JSON.stringify(input.task))
      return { run: view, outcome: { status: 'completed', content: stage === 'style' ? '恢复的文风' : stage === 'global' ? JSON.stringify(validInference()) : '不可解析的候选', finishReason: 'stop', receipt: { finishReason: 'stop' } } }
    }
    if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
    if (channel === 'kb:search') return { success: true, data: [] }
    throw new Error('不允许重建模型或读取当前模板: ' + channel)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  const effect = vi.fn(async () => {})
  const globalCommit = vi.fn(async (request: ImportGlobalFactsRequest) => {
    expect(request.generationRunHandle).toEqual(handle)
    expect(request.core).toMatchObject({ totalChapters: 99, wordsPerChapter: 1000, narrativePov: 'third_limited', genre: '现实' })
    expect(JSON.stringify(request)).not.toContain('不得使用')
    throw new Error('captured-actual-global-payload')
  })
  const command = stage === 'style' ? new AnalyzeWritingStyleCommand({ sampleText: '不得使用的新样本' }, undefined, effect) : stage === 'global' ? new InferGlobalSettingsCommand(undefined, globalCommit) : new InferBlueprintsPerChapterCommand()
  const result = command.execute({ step: {} as never, context, callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() } })
  if (stage === 'style') { await expect(result).resolves.toBe('恢复的文风'); expect(effect).toHaveBeenCalledExactlyOnceWith('恢复的文风', handle) }
  else await expect(result).rejects.toThrow(stage === 'global' ? 'captured-actual-global-payload' : undefined)
  if (stage === 'global') expect(globalCommit).toHaveBeenCalledTimes(1)
  expect(tasks.length).toBeGreaterThan(0)
  expect(tasks[0]).toContain('冻结模板正文')
  expect(tasks[0]).toContain('不可替换的冻结正文')
  expect(tasks[0]).not.toContain('不得使用')
  if (stage === 'style') { expect(tasks[0]).toContain('第1章 冻结章节'); expect(tasks[0]).not.toContain('  不可替换') }
  expect(context.generationModelId).toBe('原模型')
  expect(invoke.mock.calls.some(([channel]) => channel === 'generation:begin')).toBe(false)
})

it('导入 slot 缺执行权限或阶段不符时拒绝', () => {
  const context = { data: { importGenerationSlot: { runId: '导入', stage: 'global', batchId: 'done' } } } as unknown as WorkflowContext
  expect(() => importGenerationSelection(context, 'global')).toThrow('IMPORT_GENERATION_EXECUTION_REQUIRED')
  context.data.importRunExecution = { ownerId: '执行' }
  expect(() => importGenerationSelection(context, 'style')).toThrow('IMPORT_GENERATION_EXECUTION_REQUIRED')
})
