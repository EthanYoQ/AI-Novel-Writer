import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { EDITOR_INLINE_INSTRUCTION_MAX_LENGTH, type EditorInlineInput, type EditorInlineContext } from '../../src/shared/editor-inline-generation'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { composePromptSystemRole, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import { renderPrompt } from '../../src/shared/render-prompt'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { isDeepStrictEqual } from 'node:util'

const instructions = {
  refine: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'],
  expand: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'],
  continue: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'],
  dialogue: ['将这部分改写为有区分度、能推动冲突的自然对话。', 'Rewrite this passage as distinct, natural dialogue that advances the conflict.'],
} as const

const validInstruction = (input: EditorInlineInput) => input.action === 'instruct'
  ? typeof input.instruction === 'string' && input.instruction.trim().length > 0 && [...input.instruction].length <= EDITOR_INLINE_INSTRUCTION_MAX_LENGTH
  : typeof input.action === 'string' && Object.hasOwn(instructions, input.action) && !Object.hasOwn(input, 'instruction')

export function validateEditorInlineInput(input: EditorInlineInput): EditorInlineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'documentText', 'from', 'to', 'selectedText', 'instruction'].includes(key))
    || !validInstruction(input) || typeof input.documentText !== 'string' || typeof input.selectedText !== 'string'
    || !Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from
    || input.to > input.documentText.length || input.documentText.slice(input.from, input.to) !== input.selectedText
    || Buffer.byteLength(input.documentText, 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
  return structuredClone(input)
}
export function buildEditorInlineContext(input: EditorInlineInput, writingLanguage: WritingLanguage, template: PromptTemplate): EditorInlineContext {
  const valid = validateEditorInlineInput(input)
  if (template.key !== 'edit_selected_text' || typeof template.content !== 'string') throw new Error('GENERATION_EDITOR_TEMPLATE_INVALID')
  return { ...valid, kind: 'author-draft', documentHash: textHash(valid.documentText), writingLanguage, template: structuredClone(template) }
}
export function readEditorInlineContext(run: DurableGenerationRun): EditorInlineContext {
  const context = run.binding.sourceManifest.editorInlineContext as EditorInlineContext | undefined
  if (run.binding.sourceManifest.operation !== 'editor-inline' || !context
    || textHash(JSON.stringify(context)) !== run.binding.sourceManifest.editorInlineContextHash
    || textHash(context.documentText) !== context.documentHash) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  const input = validateEditorInlineInput(run.binding.sourceManifest.editorInlineInput as EditorInlineInput)
  const frozen = { action: context.action, documentText: context.documentText, from: context.from, to: context.to, selectedText: context.selectedText, ...(context.action === 'instruct' ? { instruction: context.instruction } : {}) }
  if (!isDeepStrictEqual(input, frozen)) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  return structuredClone(context)
}
export function readEditorInlineTask(run: DurableGenerationRun): GenerationTask {
  readEditorInlineContext(run)
  const task = run.binding.sourceManifest.editorInlineTask as GenerationTask | undefined
  if (!task || textHash(JSON.stringify(task)) !== run.binding.sourceManifest.editorInlineTaskHash) throw new Error('GENERATION_EDITOR_TASK_INVALID')
  return structuredClone(task)
}
function editInstruction(context: EditorInlineContext, english: boolean): string {
  if (context.action !== 'instruct') return instructions[context.action][english ? 1 : 0]
  return english
    ? `Revise this passage as the author's note asks. The note outranks every other preference.\n${context.instruction}`
    : `按作者意见修改这部分。作者意见优先于其他任何偏好。\n${context.instruction}`
}
function systemRole(context: EditorInlineContext): Pick<PromptTemplate, 'systemRole'> {
  if (context.action !== 'instruct') return context.template
  const rule = context.writingLanguage === 'en-US'
    ? "Where the author's note conflicts with the preservation requirements above, follow the note; keep everything the note does not mention."
    : '作者意见与上述保留要求冲突时，以作者意见为准；意见没提到的部分照常保留。'
  return { systemRole: [context.template.systemRole?.trim(), rule].filter(Boolean).join('\n') }
}
export function editorInlineTask(context: EditorInlineContext): GenerationTask {
  const { template, writingLanguage } = context
  return { purpose: `editor-ai-${context.action}`, reasoningStage: context.action === 'refine' ? 'review' : 'drafting', output: 'visible-text', messages: [
    { role: 'system', content: composePromptSystemRole(systemRole(context), writingLanguage) },
    { role: 'user', content: renderPrompt(template, { edit_instruction: editInstruction(context, writingLanguage === 'en-US'), selected_text: context.selectedText }, writingLanguage) },
  ] }
}
