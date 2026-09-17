import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { GenerationBudgetDiagnostic } from '../../../services/generation/task-budget-planner'
import GenerationBudgetDiagnostics from '../GenerationBudgetDiagnostics'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function render(diagnostics: readonly GenerationBudgetDiagnostic[], locale: 'zh-CN' | 'en-US') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(
    <GenerationBudgetDiagnostics diagnostics={diagnostics} locale={locale} />,
  ))
}

describe('generation budget diagnostics', () => {
  it('shows requested, reserved, actual and unknown as separate Chinese states', async () => {
    await render([
      {
        attemptId: 'settled-attempt',
        plannerVersion: 's07-task-budget-v1',
        requestedOutputTokens: 7_712,
        reservedTokens: 9_224,
        actual: { input: 900, completion: 3_050, reasoning: 210, total: 4_160 },
        actualState: 'settled',
        finishReason: 'stop',
        failureCode: null,
        reasons: [],
      },
      {
        attemptId: 'unknown-attempt',
        plannerVersion: 's07-task-budget-v1',
        requestedOutputTokens: 4_096,
        reservedTokens: 8_192,
        actual: null,
        actualState: 'unknown',
        finishReason: null,
        failureCode: 'NETWORK_ERROR',
        reasons: [],
      },
      {
        attemptId: 'not-dispatched-attempt',
        plannerVersion: 's07-task-budget-v1',
        requestedOutputTokens: 4_096,
        reservedTokens: 8_192,
        actual: null,
        actualState: 'not-dispatched',
        finishReason: 'cancelled',
        failureCode: 'GENERATION_CANCELLED',
        reasons: [],
      },
    ], 'zh-CN')

    expect(container?.textContent).toContain('预算诊断')
    expect(container?.textContent).toContain('需求输出 7,712 tokens')
    expect(container?.textContent).toContain('总预留 9,224 tokens')
    expect(container?.textContent).toContain('实际总量 4,160 tokens')
    expect(container?.textContent).toContain('实际用量未知')
    expect(container?.textContent).toContain('请求未发送，预留已释放')
    expect(container?.querySelectorAll('[data-actual-state="settled"]')).toHaveLength(1)
    expect(container?.querySelectorAll('[data-actual-state="unknown"]')).toHaveLength(1)
    expect(container?.querySelectorAll('[data-actual-state="not-dispatched"]')).toHaveLength(1)
  })

  it('labels provider length and storage failures without exposing private request content', async () => {
    await render([
      {
        attemptId: 'length-attempt',
        requestedOutputTokens: 8_192,
        reservedTokens: 10_000,
        actual: { input: 1_000, completion: 8_192, reasoning: null, total: 9_192 },
        actualState: 'settled',
        finishReason: 'length',
        reasons: [],
      },
      {
        attemptId: 'storage-attempt',
        requestedOutputTokens: 2_048,
        reservedTokens: 4_096,
        actual: null,
        actualState: 'unknown',
        failureCode: 'SQLITE_FULL',
        reasons: [],
      },
    ], 'en-US')

    expect(container?.textContent).toContain('Provider length stop')
    expect(container?.textContent).toContain('Storage')
    expect(container?.textContent).not.toContain('author manuscript')
    expect(container?.textContent).not.toContain('api-key')
  })

  it('renders nothing without main-owned diagnostics', async () => {
    await render([], 'zh-CN')
    expect(container?.textContent).toBe('')
  })
})
