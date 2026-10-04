import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

export interface EditorInlineInput {
  action: 'refine' | 'expand' | 'continue' | 'dialogue'
  documentText: string
  from: number
  to: number
  selectedText: string
}
export interface EditorInlineContext extends EditorInlineInput {
  kind: 'author-draft'
  documentHash: string
  writingLanguage: WritingLanguage
  template: PromptTemplate
}
export interface EditorInlineRecovery {
  view: MainGenerationRunView
  modelId: string
  context: EditorInlineContext
  sourceStatus: 'current' | 'conflict'
}
export interface EditorInlineGenerationChannels {
  'editor-inline:begin': { args: [{ input: EditorInlineInput; modelId: string; uiActionNonce: string }]; return: EditorInlineRecovery }
  'editor-inline:read-recovery': { args: [{ handle: MainGenerationRunHandle }]; return: EditorInlineRecovery }
  'editor-inline:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'editor-inline:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}
