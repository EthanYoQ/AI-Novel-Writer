import { describe, expect, it } from 'vitest'
import { inject, name } from '../src/agent-v2.ts'

describe('AI 小说作家 V2 agent entry', () => {
  it('declares its Workspace registry requirement without making V1 require it', () => {
    expect(name).toBe('dsh-ai-novel-writer-agent-v2')
    expect(inject).toEqual(['agents', 'systemPrompt', 'tools', 'workspaceRegistry'])
  })
})
