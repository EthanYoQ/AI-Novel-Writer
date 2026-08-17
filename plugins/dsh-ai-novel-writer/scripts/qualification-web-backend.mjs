/** Deterministic LLM adapter for packed-profile browser qualification. */

import { appendFile } from 'node:fs/promises'
import process from 'node:process'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

function fail(message) {
  throw new Error(message)
}

function allStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, output)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) allStrings(item, output)
  }
  return output
}

/**
 * Parse the latest workbench proposal and retain its durable message identity.
 * @param {unknown[]} messages Model request messages for one session turn.
 * @returns {{ prompt: string, request: Record<string, unknown>, key: string } | undefined} Parsed proposal or no proposal.
 * @throws {Error} When marked proposal text does not contain one valid JSON object.
 */
export function proposalFromMessages(messages) {
  const marker = '这只是提案。'
  let selected
  for (const [index, message] of messages.entries()) {
    const messageId = message !== null && typeof message === 'object' && typeof message.id === 'string'
      ? message.id
      : `request-message-${index}`
    for (const value of allStrings(message)) {
      if (value.includes(marker)) selected = { prompt: value, messageId }
    }
  }
  if (selected === undefined) return undefined
  const { prompt, messageId } = selected
  const start = prompt.indexOf('{')
  const end = prompt.lastIndexOf(`\n\n${marker}`)
  if (start < 0 || end <= start) fail('Qualification proposal prompt did not contain one JSON object')
  const request = JSON.parse(prompt.slice(start, end))
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    fail('Qualification proposal JSON must be an object')
  }
  return { prompt, request, key: `${messageId}:${prompt}` }
}

function toolCall(callId, name, args) {
  const id = CallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function readRequest(proposal) {
  if (proposal.kind === 'initialize') return { kind: 'working-set', chapter: 1 }
  if (proposal.kind !== 'replace' || typeof proposal.targetKind !== 'string') {
    fail('Qualification proposal must initialize or replace one recognized asset')
  }
  return {
    kind: 'asset',
    targetKind: proposal.targetKind,
    ...Number.isSafeInteger(proposal.chapter) ? { chapter: proposal.chapter } : {},
  }
}

class QualificationAdapter extends LlmAdapter {
  #steps = new Map()

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    const proposal = proposalFromMessages(options.messages)
    const novelTools = (options.tools ?? []).filter(tool => tool.name === 'novel_read' || tool.name === 'novel_apply_change')
    if (proposal === undefined || novelTools.length === 0) {
      for (const chunk of textResponse('AI 小说创作')) yield chunk
      return
    }
    const logPath = process.env.DSH_NOVEL_QUALIFICATION_LOG
    if (typeof logPath !== 'string' || logPath === '') fail('DSH_NOVEL_QUALIFICATION_LOG is required')
    await appendFile(logPath, `${JSON.stringify({
      type: 'model-request',
      request: {
        provider: options.provider,
        model: options.model,
        system: options.system ?? '',
        tools: options.tools ?? [],
        messages: options.messages,
      },
    })}\n`, 'utf8')
    const step = this.#steps.get(proposal.key) ?? 0
    this.#steps.set(proposal.key, step + 1)
    const chunks = step === 0
      ? toolCall(`qualification-read-${this.#steps.size}-${step}`, 'novel_read', readRequest(proposal.request))
      : step === 1
        ? toolCall(`qualification-apply-${this.#steps.size}-${step}`, 'novel_apply_change', proposal.request)
        : textResponse('已收到 CommitReceipt，小说资产已保存。')
    for (const chunk of chunks) yield chunk
  }
}

/** Cordis qualification fixture identity. */
export const name = 'ai-novel-qualification-web-backend'

/** Host service required to register the deterministic adapter. */
export const inject = ['llm']

/**
 * Register the keyless qualification route without answering approvals.
 * @param {import('@deepseek-ai/cordis').Context} ctx Settled disposable profile context.
 * @returns {void} Registration is owned by the plugin fiber.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['novel-qualification'], new QualificationAdapter()))
}
