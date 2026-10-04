import type { MainGenerationRunHandle, MainGenerationRunView } from '../services/generation/generation-runtime'
import type { Locale } from '../i18n/types'

export interface AgentFrozenTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresConfirmation: boolean
  isReadOnly: boolean
  source: 'builtin' | 'mcp' | 'skill'
}
export interface AgentGenerationInput {
  mode: 'fast' | 'planning'
  uiLocale: Locale
  historyMessages: { role: 'user' | 'assistant'; content: string }[]
  userMessage: string
  /** Explicit editor selection/context, never a replacement for canonical project facts. */
  editorContext?: string
  tools: AgentFrozenTool[]
}
export interface AgentGenerationContext {
  version: 1
  input: AgentGenerationInput
  writingLanguage: 'zh-CN' | 'en-US'
  initialMessages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}
export interface AgentToolActionRef {
  handle: MainGenerationRunHandle
  attemptId: string
  toolCallId: string
}
export interface AgentToolAction {
  ref: AgentToolActionRef
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'declined' | 'failed' | 'unknown'
  observation?: string
  workflow?: AgentWorkflowRegistration
}
export interface AgentAuthorBlueprintProposal { name: 'propose_chapter_blueprint'; arguments: Record<string, unknown> }
export interface AgentToolClaim { action: AgentToolAction; execute: boolean }
export interface AgentDomainToolReceipt {
  kind: 'config' | 'blueprint'
  toolCallId: string
  changes: Record<string, unknown>
  chapterNumber?: number
  beforeHash: string
  afterHash: string
  /** Fresh read projection; historical ACK must not overwrite newer renderer edits. */
  current?: boolean
}
export interface AgentWorkflowRegistration {
  registrationId: string
  workflow: 'generate_draft' | 'generate_blueprint' | 'generate_architecture'
  chapterNumber?: number
  parentHandle: MainGenerationRunHandle
  modelId: string
  state: 'registered' | 'started'
  childHandles: MainGenerationRunHandle[]
}
export interface AgentGenerationRound {
  index: number
  handle: MainGenerationRunHandle
  attemptId?: string
  status: 'not-started' | 'completed' | 'incomplete' | 'unknown'
  visibleText: string
  /** Main reconstructs only the accepted protocol; hidden reasoning is never included. */
  protocolText: string
  actions: AgentToolAction[]
}
export interface AgentGenerationRecovery {
  handle: MainGenerationRunHandle
  modelId: string
  context: AgentGenerationContext
  rounds: AgentGenerationRound[]
  sourceStatus: 'current' | 'conflict'
  nextRound: number | null
  run: MainGenerationRunView
}
export interface AgentGenerationChannels {
  'agent-generation:begin': { args: [{ uiActionNonce: string; modelId: string; input: AgentGenerationInput }]; return: AgentGenerationRecovery }
  'agent-generation:read': { args: [{ handle: MainGenerationRunHandle }]; return: AgentGenerationRecovery }
  'agent-generation:resume': { args: [{ handle: MainGenerationRunHandle }]; return: AgentGenerationRecovery }
  'agent-generation:round': { args: [{ handle: MainGenerationRunHandle; index: number }]; return: AgentGenerationRecovery }
  'agent-generation:claim-tool': { args: [{ ref: AgentToolActionRef; confirmed: boolean; authorBlueprintProposals?: AgentAuthorBlueprintProposal[] }]; return: AgentToolClaim }
  'agent-generation:finish-tool': { args: [{ ref: AgentToolActionRef; status: 'completed' | 'failed' | 'unknown'; observation: string }]; return: AgentToolAction }
  'agent-generation:register-workflow': { args: [{ ref: AgentToolActionRef }]; return: AgentWorkflowRegistration }
  'agent-generation:commit-domain-tool': { args: [{ ref: AgentToolActionRef }]; return: AgentDomainToolReceipt }
}
