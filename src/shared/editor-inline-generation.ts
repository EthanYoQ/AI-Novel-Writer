import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

/** 上限按码点计，不是 UTF-16 单元。 */
export const EDITOR_INLINE_INSTRUCTION_MAX_LENGTH = 2000
export type EditorInlineFixedAction = 'refine' | 'expand' | 'continue' | 'dialogue'
export type EditorInlineRequest = { action: EditorInlineFixedAction } | { action: 'instruct'; instruction: string }
export type EditorInlineInput = EditorInlineRequest & {
  documentText: string
  from: number
  to: number
  selectedText: string
}
export type EditorInlineContext = EditorInlineInput & {
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
