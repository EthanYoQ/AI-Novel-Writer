import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { TaskBudgetDecision } from '../../../src/services/generation/task-budget-planner'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { GenerationBudgetReceipt } from '../../repositories/generation-run-repository'
import { createModelExecutionLeaseReceipt } from '../model-execution-lease'
import { buildMainGenerationPlan, newMainGenerationPolicy, TaskBudgetPreflightError } from '../main-generation-plan'
import { applyModelProfileSelection, createModelProfileDraft, modelCapabilitySource } from '../../../src/shared/model-profile-draft'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { ChapterPromptBuilder } from '../../../src/services/prompts/prompt-builder'
import { DRAFT_SHORT_OUTLINE_PURPOSE, draftShortOutlinePrompt } from '../../../src/shared/draft-short-outline'

// 讨论区 #77：DeepSeek 官方端点 + 作者在设置里手填较小的上下文窗口时，写稿的首个请求（短细纲）在预检阶段被拒。

const SENTENCES = [
  '雨从傍晚一直下到深夜，码头上的灯一盏接一盏熄灭。',
  '林岚把铜钥匙攥在掌心，指节被冰凉的金属硌得发白。',
  '旧港的钟楼比往常早响了一刻，像是在提醒谁该回家了。',
  '他没有回答，只是把伞往她那边又偏了一点。',
  '账簿上那一页被人撕走了，边缘还留着细小的毛刺。',
  '第三艘货船靠岸时，守夜人发现舱底的箱子是空的。',
  '她想起父亲临走前说过的话，心里忽然一紧。',
  '巷口的面摊还亮着，老板正把最后一碗汤倒进锅里。',
]

function chineseProse(units: number): string {
  let text = ''
  for (let index = 0; text.length < units; index++) text += SENTENCES[index % SENTENCES.length]
  return text.slice(0, units)
}

// 第 9 章写稿时实际拼进提示词的各块，按一部中等篇幅作品取字数。必需材料不受 8,000 字可选额度限制。
function chapterNineOutlinePrompt(): string {
  const architecture = [chineseProse(1_200), chineseProse(3_500), chineseProse(2_500)].join('\n\n---\n\n')
  const chapterInfo = { chapterNumber: 9, title: '空舱', keyEvents: chineseProse(300), characters: ['林岚', '周砚', '老韩'],
    userGuidance: chineseProse(120) }
  const template = getBuiltinPromptTemplate('next_chapter_draft', 'zh-CN')!
  const built = new ChapterPromptBuilder(template, 'zh-CN')
    .withArchitecture(architecture)
    .withGlobalGuidance(chineseProse(400))
    .withWritingStyle(chineseProse(200))
    .withNovelConfig(JSON.stringify({ genre: '悬疑', totalChapters: 120, chapterWords: 4000 }, null, 2))
    .withWordNumber(4000)
    .withChapterInfo(chapterInfo)
    .withCharacterStates('')
    .withFutureBlueprints('')
    .withFilteredContext('')
    .withUserGuidance(chapterInfo.userGuidance)
    .withGlobalSummary('')
    .withPreviousEnding('')
    .withShortSummary('')
    .build()
  const materials = [
    `【上一章定稿正文】\n${chineseProse(4_000)}`,
    `【角色档案】\n${chineseProse(2_400)}`,
    `【作者设定】\n${chineseProse(1_200)}`,
    `【后续计划】\n${chineseProse(600)}`,
    `【相关历史与线索】\n${chineseProse(6_000)}`,
  ].join('\n\n')
  return draftShortOutlinePrompt('zh-CN', [materials, built].join('\n\n'))
}

const OUTLINE_PROMPT = chapterNineOutlinePrompt()

// 与 generate-draft.command.ts 的短细纲请求同形：500 单位、规划阶段、单条 user 消息。
const outlineTask = (content = OUTLINE_PROMPT): GenerationTask => ({ purpose: DRAFT_SHORT_OUTLINE_PURPOSE, output: 'visible-text',
  reasoningStage: 'planning', messages: [{ role: 'user', content }],
  budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 500, segmentable: false } })

// 设置页的两步：从 DeepSeek 预设选 deepseek-v4-flash，再在「上下文窗口」框里手填。
function deepseekProfile(userContextWindowTokens?: number | null): ModelProfile {
  const draft = { ...createModelProfileDraft({ id: 'deepseek-作者', purposes: ['generation'] }), name: 'DeepSeek', apiKey: 'sk-synthetic' }
  const selected = applyModelProfileSelection(draft, { provider: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
  if (userContextWindowTokens === undefined) return selected
  const capabilities = { ...selected.capabilities!, contextWindowTokens: userContextWindowTokens }
  const capabilitySources = Object.fromEntries(Object.keys(capabilities).map(key => [key,
    key === 'contextWindowTokens' ? 'manual' : modelCapabilitySource(selected, key as keyof typeof capabilities)]))
  return { ...selected, capabilities, capabilitySources }
}

const selection: BeginGenerationRequest = { operation: 'chapter-draft', chapterNumber: 9, uiActionNonce: 'd77', modelId: 'deepseek-作者',
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['next_chapter_draft'], skillStages: ['drafting'], output: 'visible-text' }

function plan(profile: ModelProfile, task: GenerationTask) {
  const policy = newMainGenerationPolicy(selection, profile)
  const budget: GenerationBudgetReceipt = { root: { projectId: '项目', epoch: '会话', rootActionId: '根', operation: 'chapter-draft',
    uiActionNonce: 'd77', frozenInputHash: 'a'.repeat(64), status: 'active' }, policy: policy.budget, attempts: [], activeElapsedMs: 0, blockedCode: null }
  const receipt = createModelExecutionLeaseReceipt(profile, { leaseId: 'd77', createdAt: 1, expiresAt: 1000 })
  return buildMainGenerationPlan(profile, receipt, task, budget, 'auto', policy)
}

function rejection(profile: ModelProfile, task: GenerationTask): TaskBudgetDecision | null {
  try { plan(profile, task); return null } catch (error) {
    if (error instanceof TaskBudgetPreflightError) return error.decision
    throw error
  }
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const cjkUnits = (text: string) => [...text].filter(char => /\p{Script=Han}/u.test(char)).length

describe('讨论区 #77：第 9 章短细纲在 DeepSeek 64K 用户上下文下的容量预检', () => {
  // 2026-10-25 把这段提示词原样发给 DeepSeek 官方 deepseek-v4-flash，usage.prompt_tokens 为 17,384。
  it('第 9 章短细纲实测 17,384 个输入 token，加上 1,712 的输出需求远小于 64K，应能发出', () => {
    expect([OUTLINE_PROMPT.length, cjkUnits(OUTLINE_PROMPT), bytes(OUTLINE_PROMPT)]).toEqual([24_080, 21_610, 71_540])
    expect(plan(deepseekProfile(65_536), outlineTask()).budgetDecision?.decision).toBe('ready')
  })
})

describe('讨论区 #77：当前判定的机理（这些断言在 master 上成立）', () => {
  const profile = deepseekProfile(65_536)
  const inputUpperBound = bytes(OUTLINE_PROMPT) + bytes('user') + 32 + 32

  it('报错与截图的裁决依据逐项一致：用户上下文 64K 减去按 UTF-8 字节算的输入上界后没有输出空间', () => {
    expect(() => plan(profile, outlineTask())).toThrow(/^TASK_BUDGET_CAPACITY_CONFLICT: 任务需要输出额度 1,712；本次未发送。裁决依据：任务完整范围、输入估计上界、上下文安全余量、用户上下文设置、模型上下文剩余空间、父任务剩余额度、必需输入与输出空间冲突。$/u)
    const decision = rejection(profile, outlineTask())!
    expect(decision).toMatchObject({ decision: 'capacity-conflict', requestedQuantity: 500, requestedOutputTokens: 1712,
      inputUpperBoundTokens: inputUpperBound })
    const value = (code: string) => decision.reasons.find(reason => reason.code === code)
    expect(value('user-context-cap')).toEqual({ code: 'user-context-cap', valueTokens: 65_536, selected: true })
    expect(value('model-context-cap')).toEqual({ code: 'model-context-cap', valueTokens: Math.max(0, 65_536 - inputUpperBound - 512), selected: true })
    expect(value('root-remaining-cap')).toEqual({ code: 'root-remaining-cap', valueTokens: Math.max(0, 65_536 - inputUpperBound - 512), selected: true })
    expect(value('model-output-cap')).toEqual({ code: 'model-output-cap', valueTokens: 384_000, selected: false })
    expect(value('root-output-cap')).toEqual({ code: 'root-output-cap', valueTokens: 65_536, selected: false })
    expect(value('user-output-cap')).toEqual({ code: 'user-output-cap', valueTokens: 65_536, selected: false })
    expect(decision.reasons.some(reason => reason.code === 'model-capability-unknown' || reason.code === 'liability-bound-unknown')).toBe(false)
  })

  it('不填上下文窗口，或保留预设的 1,000,000，同一段输入都能发出', () => {
    expect(plan(deepseekProfile(null), outlineTask()).budgetDecision?.decision).toBe('ready')
    const preset = deepseekProfile()
    expect(preset.capabilities?.contextWindowTokens).toBe(1_000_000)
    expect(plan(preset, outlineTask()).budgetDecision?.decision).toBe('ready')
  })

  it('请求的输出额度与判定无关：把短细纲需求压到 1 个单位仍然冲突', () => {
    const tiny = { ...outlineTask(), budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 1, segmentable: false } } as GenerationTask
    expect(rejection(profile, tiny)?.decision).toBe('capacity-conflict')
  })

  it('不带语义需求的请求（审稿、定稿后处理的形状）走同一个字节上界，报 GENERATION_INPUT_CAPACITY_EXCEEDED', () => {
    const review: GenerationTask = { purpose: 'chapter-review', output: 'visible-text', reasoningStage: 'review',
      messages: [{ role: 'system', content: chineseProse(300) }, { role: 'user', content: OUTLINE_PROMPT }] }
    expect(() => plan(profile, review)).toThrow(/^GENERATION_INPUT_CAPACITY_EXCEEDED$/u)
    expect(plan(deepseekProfile(null), review).requestedOutputTokens).toBeGreaterThan(0)
  })

  it('开始失败的汉字数等于 (用户上下文 − 580 − 指令字节) / 3', () => {
    const instructionBytes = bytes(draftShortOutlinePrompt('zh-CN', ''))
    const firstFailing = (context: number) => {
      const candidate = deepseekProfile(context)
      let low = 1, high = 400_000
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (rejection(candidate, outlineTask(draftShortOutlinePrompt('zh-CN', chineseProse(middle))))) high = middle
        else low = middle + 1
      }
      return low
    }
    const table = [32_768, 65_536, 131_072, 1_000_000].map(context => ({ context, firstFailingHanChars: firstFailing(context) }))
    for (const row of table) expect(row.firstFailingHanChars).toBe(Math.ceil((row.context - 580 - instructionBytes) / 3))
    console.log(JSON.stringify({ instructionBytes, outlineHanChars: cjkUnits(OUTLINE_PROMPT), outlineChars: OUTLINE_PROMPT.length,
      outlineBytes: bytes(OUTLINE_PROMPT), inputUpperBound, table }))
  })
})
