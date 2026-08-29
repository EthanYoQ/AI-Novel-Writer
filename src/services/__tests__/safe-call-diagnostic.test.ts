import { describe, expect, it } from 'vitest'
import { formatSafeCallDiagnostic, safeModelName } from '../safe-call-diagnostic'
import type { LLMCallRecord } from '../stats-service'

describe('formatSafeCallDiagnostic', () => {
  it('accepts common routed model names and rejects credential or path-shaped values', () => {
    expect(safeModelName('Grok 4')).toBe('Grok 4')
    expect(safeModelName('grok-4')).toBe('grok-4')
    expect(safeModelName('openai:gpt-5.2 (reasoning)')).toBe('openai:gpt-5.2 (reasoning)')
    expect(safeModelName('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b')
    expect(safeModelName('vendor/model:free')).toBe('vendor/model:free')
    expect(safeModelName('Authorization Bearer credential')).toBeUndefined()
    expect(safeModelName('C:\\private\\model')).toBeUndefined()
    expect(safeModelName('C:/private/model')).toBeUndefined()
    expect(safeModelName('/home/user/model')).toBeUndefined()
    expect(safeModelName('../private/model')).toBeUndefined()
    expect(safeModelName('vendor/../private')).toBeUndefined()
    expect(safeModelName('./local-model')).toBeUndefined()
    expect(safeModelName('file://private/model')).toBeUndefined()
    expect(safeModelName('safe-name\nAPI_KEY_LURE')).toBeUndefined()
  })

  it('copies only allowlisted call and workflow facts and renders missing facts as unknown', () => {
    const diagnostic = formatSafeCallDiagnostic({
      locale: 'en-US',
      appVersion: '0.8.6',
      platform: 'windows',
      call: {
        id: 42,
        modelId: '2f491640-c201-4c6e-922b-3103e8c2c5f7',
        modelName: 'Grok 4',
        purpose: 'chapter-draft',
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        durationMs: 1500,
        success: false,
        createdAt: '2026-08-29T10:00:00.000Z',
        errorMessage: 'Authorization: Bearer API_KEY_LURE; C:\\Users\\TestUser\\novel; SYSTEM PROMPT: lure',
      } as LLMCallRecord,
      workflow: {
        status: 'failed',
        failureCode: 'content_filter',
        stepName: 'Generate draft',
        stepStatus: 'failed',
        stepFailureCode: 'content_filter',
        finishReason: 'content_filter',
        promptBudgetReport: {
          totalUtf8Bytes: 1024,
          limitUtf8Bytes: 2048,
          reservedOutputTokens: 512,
          sections: [{ sectionName: 'continuity', utf8Bytes: 320 }],
        },
        // Lures prove the formatter never serializes arbitrary input fields.
        requestBody: { apiKey: 'sk-secret', prompt: 'complete prompt' },
        referenceText: 'private reference prose',
      },
    })

    expect(diagnostic).toContain('# AI Novel Writer safe diagnostics')
    expect(diagnostic).toContain('- Actual model: Grok 4')
    expect(diagnostic).toContain('- Model ID: 2f491640-c201-4c6e-922b-3103e8c2c5f7')
    expect(diagnostic).toContain('- Purpose: chapter-draft')
    expect(diagnostic).toContain('- Workflow failure code: content_filter')
    expect(diagnostic).toContain('- Step: Generate draft')
    expect(diagnostic).toContain('- Finish reason: content_filter')
    expect(diagnostic).toContain('| continuity | 320 |')
    expect(diagnostic).not.toMatch(/API_KEY_LURE|Authorization|Users\\TestUser|SYSTEM PROMPT|complete prompt|private reference prose/)
  })

  it.each([
    'narrative-thread-plan-candidate',
    'narrative-thread-event-candidate',
  ])('uses the generation receipt purpose rule for %s without a second purpose inventory', (purpose) => {
    const diagnostic = formatSafeCallDiagnostic({
      locale: 'en-US',
      call: {
        id: 7,
        modelName: 'Grok 4',
        purpose,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        durationMs: 250,
        success: true,
        createdAt: '2026-08-29T10:00:00.000Z',
      },
    })

    expect(diagnostic).toContain(`- Purpose: ${purpose}`)
  })

  it('does not echo unrecognized codes or unsafe free-form identity fields', () => {
    const diagnostic = formatSafeCallDiagnostic({
      locale: 'zh-CN',
      appVersion: '0.8.6\nAuthorization: secret',
      platform: 'win32 C:\\private',
      call: {
        id: 1,
        modelId: 'API_KEY_LURE',
        modelName: 'Bearer API_KEY_LURE C:\\private',
        purpose: 'unknown-purpose Authorization: secret',
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        durationMs: 0,
        success: false,
        createdAt: 'not-a-date',
        errorMessage: 'content_filter plus secret body',
      } as LLMCallRecord,
      workflow: {
        status: 'failed',
        failureCode: 'Authorization: secret',
        stepName: 'Authorization secret',
      },
    })

    expect(diagnostic).toContain('未知')
    expect(diagnostic).toContain('- 实际模型: 未知')
    expect(diagnostic).not.toMatch(/secret|API_KEY_LURE|C:\\private|content_filter plus/)
  })
})
