import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { GenerationTask } from '../../../src/services/generation/generation-harness'
import type { BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { GenerationBudgetReceipt } from '../../repositories/generation-run-repository'
import { createModelExecutionLeaseReceipt } from '../model-execution-lease'
import { buildMainGenerationPlan, newMainGenerationPolicy } from '../main-generation-plan'
import { applyModelProfileSelection, createModelProfileDraft, modelCapabilitySource } from '../../../src/shared/model-profile-draft'
import { draftShortOutlineTask } from '../../../src/shared/draft-short-outline'
import { DRAFT_CONDENSE_PURPOSE } from '../../../src/shared/draft-visible-text'
import { assertReservation, type PhysicalAttempt } from '../../../src/shared/generation-contract'

function deepseek(context: 'preset' | number | null, maxOutput?: number): ModelProfile {
  const draft = { ...createModelProfileDraft({ id: 'deepseek', purposes: ['generation'] }), name: 'DeepSeek', apiKey: 'sk-synthetic' }
  const selected = applyModelProfileSelection(draft, { provider: 'deepseek', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-v4-flash' })
  if (context === 'preset' && maxOutput === undefined) return selected
  const capabilities = { ...selected.capabilities!,
    ...(context === 'preset' ? {} : { contextWindowTokens: context }),
    ...(maxOutput === undefined ? {} : { maxOutputTokens: maxOutput }) }
  const capabilitySources = Object.fromEntries(Object.keys(capabilities).map(key => [key,
    key === 'contextWindowTokens' && context !== 'preset' || key === 'maxOutputTokens' && maxOutput !== undefined
      ? 'manual' : modelCapabilitySource(selected, key as keyof typeof capabilities)]))
  return { ...selected, capabilities, capabilitySources, ...(maxOutput === undefined ? {} : { maxTokens: maxOutput }) }
}

const PROFILES = [
  ['预设 1M', deepseek('preset')],
  ['作者填 32K', deepseek(32_768)],
  ['作者不填', deepseek(null)],
] as const

const HUGE = '雨夜里铜钥匙落在门前，守夜人把灯又调亮了一点。'.repeat(17_000)
const SMALL = '雨夜，铜钥匙落在门前。'
const user = (content: string) => [{ role: 'user' as const, content }]

const TASKS: ReadonlyArray<[string, (content: string) => GenerationTask]> = [
  ['写稿首请求（短细纲）', content => draftShortOutlineTask('zh-CN', content)],
  ['写稿正文', content => ({ purpose: 'chapter-draft', output: 'visible-text', reasoningStage: 'drafting', messages: user(content),
    budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 4000, segmentable: false } })],
  ['续写', content => ({ purpose: 'chapter-draft-continuation', output: 'visible-text', reasoningStage: 'drafting', messages: user(content),
    budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 1500, segmentable: false } })],
  ['压缩', content => ({ purpose: DRAFT_CONDENSE_PURPOSE, output: 'visible-text', reasoningStage: 'drafting', messages: user(content),
    budgetDemand: { kind: 'draft-units', writingLanguage: 'zh-CN', requestedUnits: 4000, segmentable: false } })],
  ['审稿', content => ({ purpose: 'review-chapter', output: 'visible-text', reasoningStage: 'review', messages: user(content) })],
  ['定稿后处理', content => ({ purpose: 'finalization-chapter-notes', output: 'structured-data', reasoningStage: 'general', messages: user(content) })],
  ['蓝图', content => ({ purpose: 'chapter-blueprint-directory', output: 'structured-data', reasoningStage: 'planning', messages: user(content),
    budgetDemand: { kind: 'structured-items', writingLanguage: 'zh-CN', requestedItems: 10 } })],
  ['大纲', content => ({ purpose: 'generate-plot-outline', output: 'visible-text', reasoningStage: 'planning', messages: user(content) })],
]

const selection: BeginGenerationRequest = { operation: 'chapter-draft', chapterNumber: 9, uiActionNonce: 'd77', modelId: 'deepseek',
  selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['next_chapter_draft'], skillStages: ['drafting'], output: 'visible-text' }

function ledger(profile: ModelProfile, attempts: PhysicalAttempt[] = []): GenerationBudgetReceipt {
  return { root: { projectId: '项目', epoch: '会话', rootActionId: '根', operation: 'chapter-draft', uiActionNonce: 'd77',
    frozenInputHash: 'a'.repeat(64), status: 'active' }, policy: newMainGenerationPolicy(selection, profile).budget, attempts, activeElapsedMs: 0, blockedCode: null }
}

function plan(profile: ModelProfile, task: GenerationTask, budget = ledger(profile)) {
  const receipt = createModelExecutionLeaseReceipt(profile, { leaseId: 'd77', createdAt: 1, expiresAt: 1000 })
  return buildMainGenerationPlan(profile, receipt, task, budget)
}

describe('讨论区 #77：发送前不按自估 token 拒绝', () => {
  for (const [profileName, profile] of PROFILES) {
    it.each(TASKS)(`${profileName}：%s 的超长提示词照样发出`, (_name, build) => {
      const result = plan(profile, build(HUGE))
      expect(result.budgetDecision?.decision ?? 'ready').toBe('ready')
      expect(result.options.maxTokens).toBeGreaterThan(0)
    })
  }
})

describe('讨论区 #77：发给服务商的输出上限只来自模型或作者设置', () => {
  it.each(PROFILES)('%s：DeepSeek 预设最大输出 384K、作者默认 65,536，取 65,536，与输入长短无关', (_name, profile) => {
    for (const [, build] of TASKS) for (const content of [SMALL, HUGE]) {
      expect(plan(profile, build(content)).options.maxTokens).toBe(65_536)
    }
  })

  const custom = (): ModelProfile => ({ ...createModelProfileDraft({ id: 'custom', purposes: ['generation'] }), apiKey: 'sk-synthetic',
    provider: 'custom', protocol: 'openai', baseUrl: 'https://compatible.example/v1', modelName: 'hand-entered', maxTokens: 12_000,
    capabilities: { contextWindowTokens: 16_384, maxOutputTokens: 12_000, reasoning: false, structuredOutput: false, usage: false } })
  const unsplit = TASKS.filter(([name]) => name !== '蓝图')

  it.each([['作者把最大输出 Tokens 填成 8,000', deepseek(32_768, 8_000), 8_000], ['没有已验证预设的兼容端点，作者填 12,000', custom(), 12_000]] as const)(
    '%s 时，每个请求都传这个值', (_name, profile, limit) => {
      for (const [, build] of unsplit) for (const content of [SMALL, HUGE]) {
        expect(plan(profile, build(content)).options.maxTokens).toBe(limit)
      }
    })

  it.each([[deepseek(32_768, 8_000), '2'], [custom(), '3']] as const)('输出上限放不下 10 条蓝图时按输出上限切分，与输入长短无关', (profile, selected) => {
    const blueprint = TASKS.find(([name]) => name === '蓝图')![1]
    for (const content of [SMALL, HUGE]) expect(() => plan(profile, blueprint(content))).toThrow(`TASK_BUDGET_SCOPE_SPLIT_REQUIRED:${selected}`)
  })
})

describe('讨论区 #77：账本照记，token 额度不拒绝，次数刹车仍在', () => {
  const profile = deepseek(65_536)
  const attempt = (index: number, reservedTokens: number): PhysicalAttempt => ({ attemptId: `a${index}`, reservationId: `r${index}`,
    rootActionId: '根', status: 'unknown', reservedTokens, requestedOutputTokens: 65_536 })

  it('每次调用仍有完整预留：输入上界 + 输出上限 + 推理 + 安全余量', () => {
    const result = plan(profile, TASKS[1][1](HUGE))
    expect(result.reservedTokens).toBe(result.inputUpperBoundTokens + result.requestedOutputTokens + result.reasoningUpperBoundTokens + 512)
    expect(result.inputUpperBoundTokens).toBeGreaterThan(1_000_000)
  })

  it('已记账的 token 超过根账 token 上限后，下一次仍能规划并登记预留', () => {
    const budget = ledger(profile)
    const spent = Array.from({ length: 20 }, (_, index) => attempt(index, budget.policy.maxTokenLiability))
    const next = plan(profile, TASKS[1][1](HUGE), { ...budget, attempts: spent })
    const reservation: PhysicalAttempt = { attemptId: 'next', reservationId: 'next', rootActionId: '根', status: 'reserved',
      reservedTokens: next.reservedTokens, requestedOutputTokens: next.requestedOutputTokens }
    expect(() => assertReservation(budget.root, budget.policy, spent, reservation, 0)).not.toThrow()
  })

  it('物理请求达到 32 次时仍按 ROOT_BUDGET_EXHAUSTED 停止', () => {
    const budget = ledger(profile)
    expect(budget.policy.maxPhysicalRequests).toBe(32)
    const spent = Array.from({ length: 32 }, (_, index) => attempt(index, 1))
    const reservation: PhysicalAttempt = { attemptId: 'next', reservationId: 'next', rootActionId: '根', status: 'reserved',
      reservedTokens: 1, requestedOutputTokens: 1 }
    expect(() => assertReservation(budget.root, budget.policy, spent.slice(0, 31), reservation, 0)).not.toThrow()
    expect(() => assertReservation(budget.root, budget.policy, spent, reservation, 0)).toThrow('ROOT_BUDGET_EXHAUSTED')
  })
})
