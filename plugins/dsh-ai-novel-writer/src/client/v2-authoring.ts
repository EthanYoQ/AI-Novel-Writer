/** Deterministic, local-only authoring prompts for the V2 proposal inbox. */

/** One model-assisted authoring path supported by the non-authoritative V2 inbox. */
export type NovelV2AuthoringStage =
  | 'project-refine'
  | 'architecture'
  | 'characters'
  | 'outline'
  | 'chapter-blueprint'
  | 'draft'
  | 'revision'
  | 'select-final'

/** Stages whose human input is a closed local field collection rather than prose. */
export type NovelV2StructuredAuthoringStage = Extract<NovelV2AuthoringStage,
  'project-refine' | 'architecture' | 'characters' | 'outline' | 'chapter-blueprint'>

/**
 * The one ephemeral human input accepted by the authoring flow.
 *
 * It is deliberately a discriminated value rather than a serialized JSON envelope: field text
 * remains in browser state until it is quoted into a Session prompt, and never becomes a write.
 */
export type NovelV2AuthoringInput =
  | {
    readonly kind: 'structured'
    readonly stage: NovelV2StructuredAuthoringStage
    readonly chapter: number | undefined
    readonly values: Readonly<Record<string, string>>
  }
  | {
    readonly kind: 'prose'
    readonly content: string
  }

/** Local UI state for authoring. It never represents a persisted proposal or a committed change. */
export interface NovelV2AuthoringState {
  readonly stage: NovelV2AuthoringStage | undefined
  readonly brief: string
  /** One browser-only human input, quoted verbatim to the Session but never directly written. */
  readonly input: NovelV2AuthoringInput | undefined
  readonly phase: 'idle' | 'editing' | 'submitting' | 'submitted' | 'reconciling' | 'error'
  readonly message: string | undefined
  readonly chapter: number | undefined
  readonly selectedArtifactId: string | undefined
  readonly selectedFinalArtifactId: string | undefined
  /** Browser-local source identity for replacing one still-pending generated draft. */
  readonly pendingProposalItem?: {
    readonly proposalId: string
    readonly itemId: string
  }
}

/** Local authoring state before a user selects a stage or asks the Session to work. */
export const EMPTY_V2_AUTHORING: NovelV2AuthoringState = {
  stage: undefined,
  brief: '',
  input: undefined,
  phase: 'idle',
  message: undefined,
  chapter: undefined,
  selectedArtifactId: undefined,
  selectedFinalArtifactId: undefined,
  pendingProposalItem: undefined,
}

/** A retryable author-facing explanation for a duplicate request still waiting in this browser Session. */
export const V2_DUPLICATE_QUEUED_AUTHORING_REQUEST_MESSAGE = '相同创作请求正在等待处理，请等待完成后再试。'

/**
 * @param phase Current local authoring phase.
 * @returns Whether the active Session turn owns the authoring controls.
 */
export function v2AuthoringBusy(phase: NovelV2AuthoringState['phase'] | undefined): boolean {
  return phase === 'submitting' || phase === 'submitted' || phase === 'reconciling'
}

/**
 * @param input Current local human input.
 * @returns Whether the input contains a non-whitespace value.
 */
export function v2AuthoringInputHasValue(input: NovelV2AuthoringInput | undefined): boolean {
  if (input === undefined) return false
  if (input.kind === 'prose') return input.content.trim() !== ''
  return Object.values(input.values).some(value => value.trim() !== '')
}

/** Render local human values for the Session without parsing, normalizing, or persisting them. */
function v2AuthoringInputText(input: NovelV2AuthoringInput | undefined): string {
  if (input === undefined) return ''
  if (input.kind === 'prose') return input.content
  return Object.entries(input.values)
    .map(([key, value]) => `【${authoringFieldLabel(input.stage, key)}】\n${value}`)
    .join('\n\n')
}

function authoringFieldLabel(stage: NovelV2StructuredAuthoringStage, key: string): string {
  const characterField = /^character-(\d+)-(name|role|summary|goal|currentState|notes)$/.exec(key)
  if (characterField !== null) {
    const labels: Readonly<Record<string, string>> = {
      name: '姓名', role: '角色', summary: '简介', goal: '目标', currentState: '当前状态', notes: '备注',
    }
    return `人物 ${Number(characterField[1]) + 1}：${labels[characterField[2]] ?? '内容'}`
  }
  const labels: Readonly<Record<string, string>> = {
    title: stage === 'chapter-blueprint' ? '章节标题' : '小说标题',
    language: '语言', genre: '类型', plannedChapters: '计划章数', targetWordsPerChapter: '每章目标字数',
    creativeStrategy: '创作策略', structureMode: '结构模式', narrativePov: '叙事视角', globalGuidance: '全局创作提示',
    premise: '故事前提', characterGraph: '人物关系', world: '世界设定', styleConstraints: '风格约束',
    referenceWorks: '参考作品', plotOutline: '全书纲要', relationships: '人物关系', newCharacters: '人物',
    purpose: '章节目的', plotBeats: '情节节拍', characters: '出场人物', keyEvents: '关键事件', suspense: '悬念钩子',
    status: '章节状态',
  }
  return labels[key] ?? '作者填写的内容'
}

export interface NovelV2AuthoringPromptInput {
  readonly stage: NovelV2AuthoringStage
  readonly mode: 'ai-draft' | 'manual-reproposal'
  /** Monotonic local request count, rendered as author-readable request text. */
  readonly requestNumber: number
  readonly brief: string
  readonly input: NovelV2AuthoringInput | undefined
  readonly chapter: number | undefined
  /** A current-snapshot prose version expressed without its internal artifact identity. */
  readonly selectedVersion?: {
    readonly ordinal: number
    readonly label: string
  }
}

interface StageGuide {
  readonly label: string
  readonly focus: string
  /** Plain-language boundary that keeps one author request to one creative stage. */
  readonly scope: string
}

const STAGE_GUIDES: Readonly<Record<NovelV2AuthoringStage, StageGuide>> = {
  'project-refine': {
    label: '项目设定优化',
    focus: '完善项目设置，并保留作者没有要求改动的内容。',
    scope: '本次只处理项目设置。不要起草或修改故事架构、人物设定、全书章节纲要、任何章节蓝图或正文。',
  },
  architecture: {
    label: '架构设计',
    focus: '完善故事的核心设定，让人物、世界与故事走向彼此一致。',
    scope: '本次只处理故事架构。不要起草或修改项目设置、人物设定、全书章节纲要、任何章节蓝图或正文。',
  },
  characters: {
    label: '角色设定',
    focus: '完善人物和人物关系，并保持角色设定前后一致。',
    scope: '本次只处理人物设定。不要起草或修改项目设置、故事架构、全书章节纲要、任何章节蓝图或正文。',
  },
  outline: {
    label: '全书大纲',
    focus: '整理全书故事走向，并延续已有设定。',
    scope: '本次只处理全书章节纲要。不要起草或修改项目设置、故事架构的其他内容、人物设定、任何章节蓝图或正文。',
  },
  'chapter-blueprint': {
    label: '章节蓝图',
    focus: '为指定章节准备完整的创作蓝图。',
    scope: '本次只处理本章蓝图。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或正文。',
  },
  draft: {
    label: '章节初稿',
    focus: '完成指定章节的初稿，并延续已有故事内容。',
    scope: '本次只处理本章正文初稿。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或章节蓝图。',
  },
  revision: {
    label: '章节修订',
    focus: '按作者的选择修订指定章节的正文。',
    scope: '本次只处理本章正文修订。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要或章节蓝图。',
  },
  'select-final': {
    label: '选择定稿',
    focus: '确认作者选定的正文作为本章定稿。',
    scope: '本次只处理本章定稿选择。不要起草或修改项目设置、故事架构、人物设定、全书章节纲要、章节蓝图或正文。',
  },
}

/**
 * @param input One local authoring action and its human guidance.
 * @returns The corresponding Session prompt.
 */
export function v2AuthoringPrompt(input: NovelV2AuthoringPromptInput): string {
  const guide = STAGE_GUIDES[input.stage]
  const authorInput = input.mode === 'manual-reproposal'
    ? `作者已完成以下人工修改。请保留其中的文字，不要擅自补充、删改或改写：\n${v2AuthoringInputText(input.input)}`
    : `作者的创作要求：\n${input.brief.trim() === '' ? '没有额外补充要求。' : input.brief}`
  const chapter = input.chapter === undefined ? '' : `本次创作对象：第 ${input.chapter} 章。\n\n`
  const request = input.mode === 'manual-reproposal' ? '人工修改提交' : ' AI 起草'
  const selectedVersion = input.selectedVersion === undefined ? ''
    : `\n\n请根据第 ${input.selectedVersion.ordinal} 个版本（${input.selectedVersion.label}）提出${input.stage === 'select-final' ? '定稿' : '修订'}建议；人工将在提案中核对目标版本后再应用。`
  return `这是第 ${input.requestNumber} 次${request}请求。

请为当前小说项目准备“${guide.label}”的创作建议。

${chapter}${guide.focus}

${guide.scope}

${authorInput}${selectedVersion}

请先阅读当前小说内容，确认建议符合作者要求。当前请求信息已足够。请在本回合直接完成一份完整、待审核的创作建议。将建议提交到审核队列。不要追问、给出选项或要求作者确认。不要只在对话文字中写出建议。不要直接改写小说内容。`
}
