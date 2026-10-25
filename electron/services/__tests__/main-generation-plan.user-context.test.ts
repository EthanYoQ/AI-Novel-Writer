import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { GenerationBudgetReceipt } from '../../repositories/generation-run-repository'
import { createModelExecutionLeaseReceipt } from '../model-execution-lease'
import { buildMainGenerationPlan, newMainGenerationPolicy } from '../main-generation-plan'
import { applyModelProfileSelection, createModelProfileDraft, modelCapabilitySource } from '../../../src/shared/model-profile-draft'
import { getBuiltinPromptTemplate } from '../../../src/services/builtin-prompt-templates'
import { ChapterPromptBuilder } from '../../../src/services/prompts/prompt-builder'
import { draftShortOutlinePrompt, draftShortOutlineTask } from '../../../src/shared/draft-short-outline'

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

const outlineTask = (content = OUTLINE_PROMPT): GenerationTask => draftShortOutlineTask('zh-CN', content)

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
  return buildMainGenerationPlan(profile, receipt, task, budget)
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
const cjkUnits = (text: string) => [...text].filter(char => /\p{Script=Han}/u.test(char)).length

describe('讨论区 #77：第 9 章短细纲在 DeepSeek 64K 用户上下文下的容量预检', () => {
  it('第 9 章短细纲实测 17,384 个输入 token，加上 1,712 的输出需求远小于 64K，应能发出', () => {
    expect([OUTLINE_PROMPT.length, cjkUnits(OUTLINE_PROMPT), bytes(OUTLINE_PROMPT)]).toEqual([24_080, 21_610, 71_540])
    expect(plan(deepseekProfile(65_536), outlineTask()).budgetDecision?.decision).toBe('ready')
  })
})

describe('讨论区 #77：上下文窗口设置不改变是否发出', () => {
  it('不填上下文窗口，或保留预设的 1,000,000，同一段输入都能发出', () => {
    expect(plan(deepseekProfile(null), outlineTask()).budgetDecision?.decision).toBe('ready')
    const preset = deepseekProfile()
    expect(preset.capabilities?.contextWindowTokens).toBe(1_000_000)
    expect(plan(preset, outlineTask()).budgetDecision?.decision).toBe('ready')
  })
})
