/** Pure React bodies for the compact workbench and its Plugin Configuration evidence card. */

import type { ChangeEvent, ReactNode } from 'react'
import type { PresetSetupState } from './setup-store.ts'
import type {
  NovelCharacterDraft,
  NovelChapterBlueprintDraft,
  NovelAssetEditorScreen,
  NovelAssetEditorPhase,
  NovelProjectSettingsDraft,
  NovelStoryBlueprintDraft,
  NovelWorkbenchEditableTarget,
} from './asset-editor.ts'
import type { NovelInitializationDraft, NovelWorkbenchState } from './workbench-store.ts'
import type {
  NovelAggregateRef,
  NovelArchitectureAggregate,
  NovelArtifact,
  NovelArtifactProposalChange,
  NovelChapterAggregate,
  NovelChapterFinal,
  NovelChangeSet,
  NovelCharactersAggregate,
  NovelProjectAggregate,
  NovelProposalChange,
  NovelProposalItem,
  NovelProposalStatus,
} from '../novel-store.ts'
import type { NovelStateReadResult } from '../command-rpc.ts'
import type {
  NovelV2WorkbenchState,
  NovelV2WorkspaceInitializationDraft,
  NovelV2WorkspaceInitializationState,
} from './workbench-v2.ts'
import {
  V2_DUPLICATE_QUEUED_AUTHORING_REQUEST_MESSAGE,
  v2AuthoringBusy,
  v2AuthoringInputHasValue,
  type NovelV2AuthoringInput,
  type NovelV2AuthoringStage,
  type NovelV2AuthoringState,
  type NovelV2StructuredAuthoringStage,
} from './v2-authoring.ts'

export type { NovelV2AuthoringState } from './v2-authoring.ts'

function proposalStatusLabel(status: NovelProposalStatus): string {
  return ({ pending: '待处理', partial: '部分已应用', stale: '冲突', applied: '已应用', discarded: '已放弃', superseded: '已替代', failed: '失败' })[status]
}

function taskStatusLabel(status: 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'): string {
  return ({ pending: '等待', running: '进行中', blocked: '阻塞', succeeded: '完成', failed: '失败', cancelled: '已取消' })[status]
}

function taskKindLabel(kind: string): string {
  return ({
    architecture: '架构设计', chapter: '章节创作', review: '审稿', revision: '修订', finalization: '定稿',
  })[kind] ?? '创作任务'
}

function taskStageLabel(stage: string): string {
  return ({
    architecture: '架构设计', chapter: '章节创作', review: '审稿', revision: '修订', finalization: '定稿',
    planning: '规划中', drafting: '起草中', 'continuity-check': '连续性检查',
  })[stage] ?? '创作处理中'
}

function authorStatusLabel(status: string): string {
  const chapterStatus = ({ planned: '已规划', drafting: '起草中', reviewing: '审稿中', revising: '修订中', finalized: '已定稿' })[status]
  if (chapterStatus !== undefined) return chapterStatus
  return taskStatusLabel(status as 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled') ?? '处理中'
}

function authorFailureMessage(area: 'initialization' | 'workbench' | 'proposals' | 'proposal' | 'tasks' | 'task' | 'authoring' | 'context'): string {
  return ({
    initialization: '项目暂未创建成功。请检查创作起点后重试。',
    workbench: '暂时无法读取小说项目。请重试读取。',
    proposals: '暂时无法读取提案队列。请稍后重试。',
    proposal: '这项建议暂时未能完成。请重试、放弃或重新生成。',
    tasks: '暂时无法读取创作任务。请稍后重试。',
    task: '这项创作任务暂未完成。请稍后重新开始。',
    authoring: '这次创作请求暂时未完成。请稍后重试。',
    context: '上一章定稿暂时无法读取。请重新选择本章后重试。',
  })[area]
}

const AUTHOR_INITIALIZATION_VALIDATIONS = new Set([
  '请填写小说标题。', '请填写语言。', '请填写类型。', '计划章数必须是正整数。', '每章目标字数必须是正整数。',
  '创作策略无效。', '结构模式无效。', '叙事视角无效。',
])

function authorInitializationMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  return AUTHOR_INITIALIZATION_VALIDATIONS.has(message) ? message : authorFailureMessage('initialization')
}

function authoringMessage(phase: NovelV2AuthoringState['phase'], message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  if (message === V2_DUPLICATE_QUEUED_AUTHORING_REQUEST_MESSAGE) return message
  if (phase === 'error') return authorFailureMessage('authoring')
  if (phase === 'submitted') return '创作请求已提交，正在等待新的建议。'
  if (phase === 'reconciling') return '正在确认新的创作建议。'
  return '创作草稿已准备好。你可以继续修改，或让 AI 生成建议。'
}

function authorBlockerMessage(blocker: string | undefined): string | undefined {
  if (blocker === undefined) return undefined
  if (blocker.includes('只读')) return '当前项目为只读。请选择可编辑项目后继续。'
  if (blocker.includes('待处理') || blocker.includes('Proposal')) return '请先处理提案队列中的建议，再继续创作。'
  if (blocker.includes('上一章') || blocker.includes('定稿')) return '请先完成上一章定稿，再继续本章创作。'
  if (blocker.includes('蓝图') || blocker.includes('纲要')) return '请先完成上一阶段的创作准备，再继续。'
  return '当前还不能创建新的创作建议。请先完成上一步或稍后重试。'
}

function aggregateLabel(target: NovelAggregateRef): string {
  if (target.kind === 'chapter') return `第 ${target.chapter} 章`
  if (target.kind === 'task') return '创作任务'
  return ({ project: '项目设置', architecture: '故事架构', characters: '人物设定' })[target.kind]
}

function isArtifactProposalChange(change: NovelProposalChange | import('../novel-store.ts').NovelChangeSet): change is NovelArtifactProposalChange {
  return 'kind' in change && (change.kind === 'artifact/draft'
    || change.kind === 'artifact/review' || change.kind === 'artifact/revision' || change.kind === 'chapter/select-final')
}

function proposalCommandLabel(change: NovelArtifactProposalChange): string {
  switch (change.kind) {
    case 'artifact/draft': return `第 ${change.chapter} 章初稿建议`
    case 'artifact/review': return `第 ${change.chapter} 章审稿建议`
    case 'artifact/revision': return `第 ${change.chapter} 章修订建议`
    case 'chapter/select-final': return `第 ${change.chapter} 章定稿建议`
  }
}

function proposalReceiptLabel(change: NovelProposalChange | NovelChangeSet): string {
  return isArtifactProposalChange(change)
    ? `第 ${change.chapter} 章建议已应用。`
    : `${aggregateLabel(change.aggregate)}已应用。`
}

interface AuthorProseVersion {
  readonly ordinal: number
  readonly label: string
}

function authorProseVersion(artifacts: readonly NovelArtifact[], artifactId: string | undefined): AuthorProseVersion | undefined {
  if (artifactId === undefined) return undefined
  const versions = artifacts.filter(artifact => artifact.kind === 'draft' || artifact.kind === 'revision')
  const index = versions.findIndex(artifact => artifact.artifactId === artifactId)
  if (index < 0) return undefined
  const artifact = versions[index]!
  return {
    ordinal: index + 1,
    label: `第 ${artifact.chapter} 章${artifact.kind === 'draft' ? '初稿' : '修订稿'}`,
  }
}

function authorProseVersionLabel(version: AuthorProseVersion | undefined): string | undefined {
  return version === undefined ? undefined : `第 ${version.ordinal} 个版本（${version.label}）`
}

function ArtifactCommandDiff({ command, artifacts }: {
  readonly command: NovelArtifactProposalChange
  readonly artifacts: readonly NovelArtifact[]
}) {
  const content = command.kind === 'artifact/review' ? command.report
    : command.kind === 'chapter/select-final' ? undefined : command.content
  const targetVersion = command.kind === 'artifact/revision'
    ? authorProseVersion(artifacts, command.parentArtifactId)
    : command.kind === 'chapter/select-final' ? authorProseVersion(artifacts, command.artifactId) : undefined
  const targetVersionLabel = authorProseVersionLabel(targetVersion) ?? (targetVersion === undefined
    && (command.kind === 'artifact/revision' || command.kind === 'chapter/select-final') ? '所选正文版本' : undefined)
  return <section className="aiNovelV2CommandDiff" aria-label={proposalCommandLabel(command)}>
    <h4>{proposalCommandLabel(command)}</h4>
    <dl>
      <div><dt>章节</dt><dd>第 {command.chapter} 章</dd></div>
      {targetVersionLabel === undefined ? undefined : <div><dt>目标版本</dt><dd>{targetVersionLabel}</dd></div>}
      {command.kind === 'chapter/select-final' ? <div><dt>定稿选择</dt><dd>将该版本设为定稿</dd></div> : undefined}
      <div><dt>摘要</dt><dd>{command.summary}</dd></div>
    </dl>
    {content === undefined ? undefined : <section>
      <h5>{command.kind === 'artifact/review' ? '审稿报告' : '正文'}</h5><pre>{content}</pre>
    </section>}
    <p className="aiNovelContextMuted">这是待审核的创作建议；确认应用后才会更新项目。</p>
  </section>
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

function authorValue(key: string, value: unknown, characters?: NovelCharactersAggregate): string {
  if (value === undefined || value === null || value === '') return '未填写'
  if (typeof value === 'string') {
    if (key === 'kind') return taskKindLabel(value)
    if (key === 'stage') return taskStageLabel(value)
    if (key === 'status') return authorStatusLabel(value)
    return value
  }
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (!Array.isArray(value)) return '已更新'
  if (key === 'items') {
    const names = value.map(item => recordValue(item)?.name).filter((name): name is string => typeof name === 'string' && name !== '')
    return names.length === 0 ? '暂无人物' : names.join('、')
  }
  if (key === 'relationships') return value.length === 0 ? '暂无人物关系' : `${value.length} 组人物关系`
  if (key === 'characters') {
    const ids = value.filter((item): item is string => typeof item === 'string')
    return ids.length === 0 ? '暂无出场人物' : ids.map(characterId => characters === undefined ? '未命名人物' : authorCharacterName(characters, characterId)).join('、')
  }
  const entries = value.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
  return entries.length === 0 ? '未填写' : entries.join('、')
}

const AUTHOR_PROPOSAL_FIELDS: Readonly<Record<NovelAggregateRef['kind'], readonly { readonly key: string; readonly label: string }[]>> = {
  project: [
    { key: 'title', label: '小说标题' }, { key: 'language', label: '语言' }, { key: 'genre', label: '类型' },
    { key: 'plannedChapters', label: '计划章数' }, { key: 'targetWordsPerChapter', label: '每章目标字数' },
    { key: 'creativeStrategy', label: '创作策略' }, { key: 'structureMode', label: '结构模式' },
    { key: 'narrativePov', label: '叙事视角' }, { key: 'globalGuidance', label: '全局创作提示' },
  ],
  architecture: [
    { key: 'premise', label: '故事前提' }, { key: 'characterGraph', label: '角色关系' }, { key: 'world', label: '世界设定' },
    { key: 'plotOutline', label: '全书纲要' }, { key: 'styleConstraints', label: '文风要求' }, { key: 'referenceWorks', label: '参考作品' },
  ],
  characters: [{ key: 'items', label: '人物' }, { key: 'relationships', label: '人物关系' }],
  chapter: [
    { key: 'title', label: '章节标题' }, { key: 'purpose', label: '章节目的' }, { key: 'plotBeats', label: '情节节拍' },
    { key: 'characters', label: '出场人物' }, { key: 'keyEvents', label: '关键事件' }, { key: 'suspense', label: '悬念' }, { key: 'status', label: '创作进度' },
  ],
  task: [
    { key: 'kind', label: '任务类型' }, { key: 'stage', label: '当前环节' },
    { key: 'chapter', label: '章节' }, { key: 'status', label: '任务状态' },
  ],
}

function aggregateValue(snapshot: NovelStateReadResult, target: NovelAggregateRef): unknown {
  switch (target.kind) {
    case 'project': return snapshot.project
    case 'architecture': return snapshot.architecture
    case 'characters': return snapshot.characters
    case 'chapter': return snapshot.chapters.find(chapter => chapter.chapter === target.chapter)
    case 'task': return snapshot.tasks.find(task => task.taskId === target.taskId)
  }
}

/** Queue-local review for a persisted aggregate replacement; it never becomes an authoring editor. */
function AggregateProposalDiff({ change, current, characters }: {
  readonly change: Exclude<NovelProposalChange, NovelArtifactProposalChange>
  readonly current: unknown
  readonly characters: NovelCharactersAggregate | undefined
}) {
  const before = recordValue(current)
  const next = recordValue(change.nextValue)
  const fieldChanges = AUTHOR_PROPOSAL_FIELDS[change.aggregate.kind].flatMap(field => {
    const previous = authorValue(field.key, before?.[field.key], characters)
    const proposed = authorValue(field.key, next?.[field.key], characters)
    return previous === proposed ? [] : [{ ...field, previous, proposed }]
  })
  return <section className="aiNovelV2CommandDiff" aria-label={`${aggregateLabel(change.aggregate)}建议`}>
    <h4>{aggregateLabel(change.aggregate)}建议</h4>
    {fieldChanges.length === 0 ? <p className="aiNovelContextMuted">AI 建议更新这项创作信息。</p>
      : <dl className="aiNovelV2Summary">{fieldChanges.map(field => <div key={field.key}>
        <dt>{field.label}</dt><dd>当前：{field.previous}<br />建议：{field.proposed}</dd>
      </div>)}</dl>}
    <p className="aiNovelContextMuted">确认应用后才会更新项目。</p>
  </section>
}

function ProposalItemLifecycleActions({
  index,
  item,
  readOnly,
  retry,
  discard,
  regenerate,
}: {
  readonly index: number
  readonly item: NovelProposalItem
  readonly readOnly: boolean
  readonly retry: (index: number) => void
  readonly discard: (index: number) => void
  readonly regenerate: (index: number) => void
}) {
  return <div className="aiNovelWorkbenchActions aiNovelWorkbenchActionsInline" aria-label="建议恢复操作">
    <button type="button" onClick={() => { retry(index) }} disabled={readOnly || item.status !== 'failed'}>重试此项</button>
    <button type="button" onClick={() => { discard(index) }}
      disabled={readOnly || item.status === 'applied' || item.status === 'discarded' || item.status === 'superseded'}>放弃此项</button>
    <button type="button" onClick={() => { regenerate(index) }}
      disabled={readOnly || item.status === 'applied' || item.status === 'superseded'}>重新生成</button>
  </div>
}

function ArtifactVersionChain({
  artifacts,
  versionArtifacts,
  final,
  selectedArtifactId,
  selectedFinalArtifactId,
  selectArtifact,
  selectFinal,
  startDraft,
  authoringBlocker,
  disabled,
}: {
  readonly artifacts: readonly NovelArtifact[]
  readonly versionArtifacts: readonly NovelArtifact[]
  readonly final: NovelChapterFinal | undefined
  readonly selectedArtifactId: string | undefined
  readonly selectedFinalArtifactId: string | undefined
  readonly selectArtifact?: (artifactId: string | undefined) => void
  readonly selectFinal?: (artifactId: string | undefined) => void
  readonly startDraft?: (stage: NovelV2AuthoringStage, chapter?: number) => void
  readonly authoringBlocker?: (stage: NovelV2AuthoringStage, chapter?: number) => string | undefined
  readonly disabled: boolean
}) {
  const artifactLabel = (artifact: NovelArtifact): string => ({
    draft: '初稿', review: '审稿意见', revision: '修订稿',
  })[artifact.kind]
  const selectedArtifact = artifacts.find(artifact => artifact.artifactId === selectedArtifactId)
  const selectedFinal = selectedFinalArtifactId ?? final?.artifactId
  const finalAlreadyApplied = selectedFinalArtifactId === undefined && final?.artifactId === selectedArtifact?.artifactId
  const selectedVersion = authorProseVersion(versionArtifacts, selectedArtifactId)
  const selectedFinalVersion = authorProseVersion(versionArtifacts, selectedFinalArtifactId)
  const revisionBlocker = selectedArtifact === undefined ? undefined : authoringBlocker?.('revision', selectedArtifact.chapter)
  const finalBlocker = selectedArtifact === undefined ? undefined : authoringBlocker?.('select-final', selectedArtifact.chapter)
  return <section className="aiNovelV2ArtifactChain" aria-label="本章稿件">
    <h4>本章稿件</h4>
    {artifacts.length === 0 ? <p className="aiNovelContextMuted">本章还没有已应用的稿件。</p> : <ol>
      {artifacts.map(artifact => {
        const version = authorProseVersion(versionArtifacts, artifact.artifactId)
        return <li key={artifact.artifactId}>
          <h5>{version === undefined ? artifactLabel(artifact) : `第 ${version.ordinal} 个版本：${version.label}`}</h5>
          {artifact.content === undefined ? undefined : <section><h6>正文</h6><pre>{artifact.content}</pre></section>}
          {artifact.report === undefined ? undefined : <section><h6>审稿报告</h6><pre>{artifact.report}</pre></section>}
          <p>摘要：{artifact.summary}</p>
          <button type="button" aria-pressed={artifact.artifactId === selectedArtifactId}
            disabled={disabled || artifact.kind === 'review' || selectArtifact === undefined}
            onClick={() => { selectArtifact?.(artifact.artifactId) }}>
            {artifact.kind === 'review' ? '审稿意见仅供修订参考' : artifact.kind === 'revision' ? '选择修订稿' : '选择初稿'}
          </button>
        </li>
      })}</ol>}
    {final === undefined ? <p className="aiNovelContextMuted">尚未选择定稿。</p>
      : <p><strong>已定稿</strong> · {final.summary}</p>}
    {selectedArtifact === undefined ? <p className="aiNovelContextMuted">选择初稿或修订稿后，可将其提交为定稿建议。</p>
      : selectedArtifact.kind === 'review' ? <p className="aiNovelContextMuted">审稿报告只能作为修订依据，不能设为定稿。</p>
        : <div className="aiNovelV2AuthoringActions">
          {selectedVersion === undefined ? undefined : <p className="aiNovelContextMuted">请根据第 {selectedVersion.ordinal} 个版本提出修订建议；人工将在提案中核对目标版本后再应用。</p>}
          <button type="button" disabled={disabled || revisionBlocker !== undefined || startDraft === undefined}
            onClick={() => { startDraft?.('revision', selectedArtifact.chapter) }}>让 AI 修订所选稿件</button>
          <button type="button" disabled={disabled || selectFinal === undefined || selectedFinal === selectedArtifact.artifactId}
            onClick={() => { selectFinal?.(selectedArtifact.artifactId) }}>
            {finalAlreadyApplied ? '当前稿件已定稿' : selectedFinal === selectedArtifact.artifactId ? '已选为定稿候选' : '选择为定稿候选'}
          </button>
          {selectedFinalArtifactId !== selectedArtifact.artifactId ? undefined : <>
            {selectedFinalVersion === undefined ? undefined : <p className="aiNovelContextMuted">请根据第 {selectedFinalVersion.ordinal} 个版本提出定稿建议；人工将在提案中核对目标版本后再应用。</p>}
            <button type="button" disabled={disabled || finalBlocker !== undefined || startDraft === undefined}
              onClick={() => { startDraft?.('select-final', selectedArtifact.chapter) }}>提交定稿建议</button>
          </>}
        </div>}
    {revisionBlocker === undefined && finalBlocker === undefined ? undefined : <p role="status">{authorBlockerMessage(revisionBlocker ?? finalBlocker)}</p>}
  </section>
}

function authoringStageLabel(stage: NovelV2AuthoringState['stage']): string {
  if (stage === undefined) return '等待章节选择'
  switch (stage) {
    case 'project-refine': return '项目设定优化'
    case 'architecture': return '架构设计'
    case 'characters': return '角色设定'
    case 'outline': return '全书大纲'
    case 'chapter-blueprint': return '章节蓝图'
    case 'draft': return 'AI 起草'
    case 'revision': return '修订版本'
    case 'select-final': return '定稿选择'
    default: return assertNever(stage)
  }
}

function assertNever(value: never): never {
  throw new Error(`未支持的创作阶段：${String(value)}`)
}

type StructuredAuthoringStage = NovelV2StructuredAuthoringStage

interface StructuredAuthoringField {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly kind?: 'text' | 'number' | 'textarea' | 'select'
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

function structuredInputValues(
  authoring: NovelV2AuthoringState | undefined,
  stage: StructuredAuthoringStage,
  chapter: number | undefined,
  fields: readonly StructuredAuthoringField[],
): Readonly<Record<string, string>> {
  const fallback = Object.fromEntries(fields.map(field => [field.key, field.value]))
  const input = authoring?.input
  if (authoring?.stage !== stage || authoring.chapter !== chapter || input?.kind !== 'structured'
    || input.stage !== stage || input.chapter !== chapter) return fallback
  return Object.fromEntries(fields.map(field => [
    field.key,
    typeof input.values[field.key] === 'string' ? input.values[field.key] : field.value,
  ]))
}

function structuredInput(
  stage: StructuredAuthoringStage,
  chapter: number | undefined,
  values: Readonly<Record<string, string>>,
): NovelV2AuthoringInput {
  return { kind: 'structured', stage, chapter, values }
}

function StructuredAuthoringForm({
  title,
  stage,
  chapter,
  fields,
  authoring,
  readOnly,
  updateDraftBrief,
  startDraft,
  updateAuthoringInput,
  reproposeManualDraft,
  authoringBlocker,
}: {
  readonly title: string
  readonly stage: StructuredAuthoringStage
  readonly chapter?: number
  readonly fields: readonly StructuredAuthoringField[]
  readonly authoring: NovelV2AuthoringState | undefined
  readonly readOnly: boolean
  readonly updateDraftBrief?: (brief: string) => void
  readonly startDraft?: (stage: NovelV2AuthoringStage, chapter?: number) => void
  readonly updateAuthoringInput?: (input: NovelV2AuthoringInput) => void
  readonly reproposeManualDraft?: () => void
  readonly authoringBlocker?: (stage: NovelV2AuthoringStage, chapter?: number) => string | undefined
}) {
  const active = authoring?.stage === stage && authoring.chapter === chapter
  const busy = v2AuthoringBusy(authoring?.phase)
  const disabled = readOnly || busy
  const blocker = authoringBlocker?.(stage, chapter)
  const values = structuredInputValues(authoring, stage, chapter, fields)
  const authoringNotice = active
    ? authoringMessage(authoring?.phase ?? 'idle', authoring?.message)
    : undefined
  const update = (key: string, value: string): void => {
    updateAuthoringInput?.(structuredInput(stage, chapter, { ...values, [key]: value }))
  }
  return <section className="aiNovelV2Authoring aiNovelV2Editor" aria-label={`${title}创作表单`}>
    <h4>{title}</h4>
    <p className="aiNovelContextMuted">字段只保留在本地创作草稿中；AI 或手动修改均会生成待审核 Proposal，不会直接改写已保存的小说内容。</p>
    <div className="aiNovelV2AuthoringActions">
      <button type="button" disabled={disabled || blocker !== undefined || startDraft === undefined}
        onClick={() => { startDraft?.(stage, chapter) }}>让 AI 起草{title}</button>
    </div>
    {authoringNotice === undefined ? undefined : <p role={authoring?.phase === 'error' ? 'alert' : 'status'}>{authoringNotice}</p>}
    <label className="aiNovelWorkbenchField"><span>补充要求（可选）</span>
      <textarea className="aiNovelV2Brief" aria-label={`${title} AI 起草要求`} value={active ? authoring?.brief ?? '' : ''}
        disabled={disabled || !active || updateDraftBrief === undefined}
        onChange={event => { updateDraftBrief?.(event.currentTarget.value) }} />
    </label>
    <fieldset className="aiNovelV2StructuredFields" disabled={disabled || !active || updateAuthoringInput === undefined}>
      <legend>人工修改</legend>
      {fields.map(field => <label key={field.key} className={`aiNovelWorkbenchField aiNovelV2StructuredField${field.kind === 'textarea' ? ' aiNovelV2StructuredFieldWide' : ''}`}><span>{field.label}</span>
        {field.kind === 'textarea' ? <textarea aria-label={`${title}${field.label}`} value={values[field.key] ?? ''}
          onChange={event => { update(field.key, event.currentTarget.value) }} />
          : field.kind === 'select' ? <select aria-label={`${title}${field.label}`} value={values[field.key] ?? ''}
            onChange={event => { update(field.key, event.currentTarget.value) }}>
            {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
            : <input aria-label={`${title}${field.label}`} type={field.kind === 'number' ? 'number' : 'text'}
              min={field.kind === 'number' ? 1 : undefined} value={values[field.key] ?? ''}
              onChange={event => { update(field.key, event.currentTarget.value) }} />}
      </label>)}
    </fieldset>
    <div className="aiNovelV2AuthoringActions">
      <button type="button" disabled={disabled || blocker !== undefined || !active || !v2AuthoringInputHasValue(authoring?.input) || reproposeManualDraft === undefined}
        onClick={() => { reproposeManualDraft?.() }}>将人工修改重新提交为 Proposal</button>
    </div>
    {blocker === undefined ? undefined : <p role="status">{authorBlockerMessage(blocker)}</p>}
    {!active ? <p className="aiNovelContextMuted">请从左侧创作步骤选择此阶段后填写；已保存内容会预填在表单中。</p> : undefined}
  </section>
}

function projectAuthoringFields(project: NovelProjectAggregate): readonly StructuredAuthoringField[] {
  return [
    { key: 'title', label: '小说标题', value: project.title },
    { key: 'language', label: '语言', value: project.language },
    { key: 'genre', label: '类型', value: project.genre },
    { key: 'plannedChapters', label: '计划章数', value: String(project.plannedChapters), kind: 'number' },
    { key: 'targetWordsPerChapter', label: '每章目标字数', value: String(project.targetWordsPerChapter), kind: 'number' },
    { key: 'creativeStrategy', label: '创作策略', value: project.creativeStrategy, kind: 'select', options: [
      { value: 'auto', label: '自动平衡' }, { value: 'fluent-drafting', label: '流畅起草' },
      { value: 'consistency-first', label: '一致性优先' }, { value: 'deep-planning', label: '深度规划' },
    ] },
    { key: 'structureMode', label: '结构模式', value: project.structureMode, kind: 'select', options: [
      { value: 'episodic', label: '单元剧' }, { value: 'three-act', label: '三幕式' }, { value: 'multi-thread', label: '多线叙事' },
    ] },
    { key: 'narrativePov', label: '叙事视角', value: project.narrativePov, kind: 'select', options: [
      { value: 'first', label: '第一人称' }, { value: 'third-limited', label: '第三人称限知' },
      { value: 'third-omniscient', label: '第三人称全知' }, { value: 'multi-pov', label: '多视角' },
    ] },
    { key: 'globalGuidance', label: '全局创作提示', value: project.globalGuidance, kind: 'textarea' },
  ]
}

function architectureAuthoringFields(architecture: NovelArchitectureAggregate): readonly StructuredAuthoringField[] {
  return [
    { key: 'premise', label: '故事前提', value: architecture.premise, kind: 'textarea' },
    { key: 'characterGraph', label: '角色关系', value: architecture.characterGraph, kind: 'textarea' },
    { key: 'world', label: '世界设定', value: architecture.world, kind: 'textarea' },
    { key: 'styleConstraints', label: '风格约束', value: architecture.styleConstraints, kind: 'textarea' },
    { key: 'referenceWorks', label: '参考作品（每行一项）', value: architecture.referenceWorks.join('\n'), kind: 'textarea' },
  ]
}

function outlineAuthoringFields(architecture: NovelArchitectureAggregate): readonly StructuredAuthoringField[] {
  return [{ key: 'plotOutline', label: '全书纲要', value: architecture.plotOutline, kind: 'textarea' }]
}

function authorCharacterName(characters: NovelCharactersAggregate, characterId: string): string {
  const index = characters.items.findIndex(character => character.characterId === characterId)
  if (index < 0) return '未命名人物'
  const name = characters.items[index]?.name.trim()
  return name === '' ? `人物 ${index + 1}` : name
}

function localCharacterIndexes(authoring: NovelV2AuthoringState | undefined): readonly number[] {
  const input = authoring?.input
  if (authoring?.stage !== 'characters' || authoring.chapter !== undefined || input?.kind !== 'structured'
    || input.stage !== 'characters' || input.chapter !== undefined) return []
  const indexes = new Set<number>()
  for (const key of Object.keys(input.values)) {
    const match = /^character-(\d+)-(?:name|role|summary|goal|currentState|notes)$/.exec(key)
    if (match === null) continue
    const index = Number(match[1])
    if (Number.isSafeInteger(index) && index >= 0) indexes.add(index)
  }
  return [...indexes].toSorted((left, right) => left - right)
}

function characterAuthoringFields(
  characters: NovelCharactersAggregate,
  authoring: NovelV2AuthoringState | undefined,
): readonly StructuredAuthoringField[] {
  const indexes = new Set([...characters.items.keys(), ...localCharacterIndexes(authoring)])
  const items = [...indexes].toSorted((left, right) => left - right).flatMap(index => {
    const character = characters.items[index]
    return [
      { key: `character-${index}-name`, label: `人物 ${index + 1}：姓名`, value: character?.name ?? '' },
      { key: `character-${index}-role`, label: `人物 ${index + 1}：角色`, value: character?.role ?? '' },
      { key: `character-${index}-summary`, label: `人物 ${index + 1}：简介`, value: character?.summary ?? '', kind: 'textarea' as const },
      { key: `character-${index}-goal`, label: `人物 ${index + 1}：目标`, value: character?.goal ?? '', kind: 'textarea' as const },
      { key: `character-${index}-currentState`, label: `人物 ${index + 1}：当前状态`, value: character?.currentState ?? '', kind: 'textarea' as const },
      { key: `character-${index}-notes`, label: `人物 ${index + 1}：备注`, value: character?.notes ?? '', kind: 'textarea' as const },
    ]
  })
  const relationships: StructuredAuthoringField = {
    key: 'relationships', label: '人物关系（每行：人物 | 人物 | 关系 | 备注）', kind: 'textarea',
    value: characters.relationships.map(item => `${authorCharacterName(characters, item.fromCharacterId)} | ${authorCharacterName(characters, item.toCharacterId)} | ${item.relation} | ${item.notes}`).join('\n'),
  }
  return items.length === 0
    ? [{ key: 'newCharacters', label: '人物（每行：姓名 | 角色 | 简介）', value: '', kind: 'textarea' }, relationships]
    : [...items, relationships]
}

type ChapterBlueprintFormSource = Pick<NovelChapterAggregate,
  'title' | 'purpose' | 'plotBeats' | 'characters' | 'keyEvents' | 'suspense' | 'status'>

function chapterBlueprintAuthoringFields(
  chapter: ChapterBlueprintFormSource,
  characters?: NovelCharactersAggregate,
): readonly StructuredAuthoringField[] {
  return [
    { key: 'title', label: '章节标题', value: chapter.title },
    { key: 'purpose', label: '章节目的', value: chapter.purpose, kind: 'textarea' },
    { key: 'plotBeats', label: '情节节拍（每行一项）', value: chapter.plotBeats.join('\n'), kind: 'textarea' },
    {
      key: 'characters', label: '出场人物（每行一项）',
      value: chapter.characters.map(characterId => characters === undefined ? '未命名人物' : authorCharacterName(characters, characterId)).join('\n'),
      kind: 'textarea',
    },
    { key: 'keyEvents', label: '关键事件（每行一项）', value: chapter.keyEvents.join('\n'), kind: 'textarea' },
    { key: 'suspense', label: '悬念钩子', value: chapter.suspense, kind: 'textarea' },
    { key: 'status', label: '章节状态', value: chapter.status, kind: 'select', options: [
      { value: 'planned', label: '已规划' }, { value: 'drafting', label: '起草中' }, { value: 'reviewing', label: '审稿中' },
      { value: 'revising', label: '修订中' }, { value: 'finalized', label: '已定稿' },
    ] },
  ]
}

/** Blank form values for a planned chapter are local-only until its Proposal is applied by the Host. */
function plannedChapterBlueprintAuthoringFields(): readonly StructuredAuthoringField[] {
  return chapterBlueprintAuthoringFields({
    title: '', purpose: '', plotBeats: [], characters: [], keyEvents: [], suspense: '', status: 'planned',
  })
}

function isPlannedChapterNumber(chapter: number | undefined, plannedChapters: number): chapter is number {
  return chapter !== undefined && Number.isSafeInteger(chapter) && chapter > 0 && chapter <= plannedChapters
}

/** The next blueprint target is derived from the authoritative chapter snapshot, never a local chapter write. */
function firstUnpersistedPlannedChapter(
  chapters: readonly Pick<NovelChapterAggregate, 'chapter'>[],
  plannedChapters: number,
): number | undefined {
  const persisted = new Set(chapters.map(chapter => chapter.chapter))
  for (let chapter = 1; chapter <= plannedChapters; chapter += 1) {
    if (!persisted.has(chapter)) return chapter
  }
  return undefined
}

function ChapterAuthoringForm({
  chapter,
  authoring,
  readOnly,
  updateDraftBrief,
  startDraft,
  updateAuthoringInput,
  reproposeManualDraft,
  authoringBlocker,
}: {
  readonly chapter: number
  readonly authoring: NovelV2AuthoringState | undefined
  readonly readOnly: boolean
  readonly updateDraftBrief?: (brief: string) => void
  readonly startDraft?: (stage: NovelV2AuthoringStage, chapter?: number) => void
  readonly updateAuthoringInput?: (input: NovelV2AuthoringInput) => void
  readonly reproposeManualDraft?: () => void
  readonly authoringBlocker?: (stage: NovelV2AuthoringStage, chapter?: number, replacingPendingDraft?: boolean) => string | undefined
}) {
  const busy = v2AuthoringBusy(authoring?.phase)
  const disabled = readOnly || busy || authoring === undefined
  const draftBlocker = authoringBlocker?.('draft', chapter)
  const manualRevisionReady = authoring?.stage === 'revision' && authoring.selectedArtifactId !== undefined
  const manualBlocker = manualRevisionReady ? authoringBlocker?.('revision', chapter) : undefined
  const proseInput = authoring?.input?.kind === 'prose' ? authoring.input : undefined
  const pendingDraftReady = authoring?.stage === 'draft' && authoring.chapter === chapter && proseInput !== undefined
  const pendingDraftReplacement = pendingDraftReady && authoring.pendingProposalItem !== undefined
  const pendingDraftBlocker = pendingDraftReplacement ? authoringBlocker?.('draft', chapter, true) : draftBlocker
  return <section className="aiNovelV2Authoring aiNovelV2Editor" aria-labelledby="ai-novel-v2-authoring">
    <h4 id="ai-novel-v2-authoring">创作阶段：{authoringStageLabel(authoring?.stage)}</h4>
    <p className="aiNovelContextMuted">AI 起草、手动修改和定稿都先生成建议；审核并应用前，正文和定稿不会改变。</p>
    {authoringMessage(authoring?.phase ?? 'idle', authoring?.message) === undefined ? undefined : <p role={authoring?.phase === 'error' ? 'alert' : 'status'}>{authoringMessage(authoring?.phase ?? 'idle', authoring?.message)}</p>}
    <label className="aiNovelWorkbenchField"><span>起草要求（可选）</span>
      <textarea className="aiNovelV2Brief" aria-label={`第 ${chapter} 章起草要求`} value={authoring?.brief ?? ''}
        disabled={disabled || updateDraftBrief === undefined}
        placeholder="例如：加强冲突，延续上一章定稿中的悬念。"
        onChange={event => { updateDraftBrief?.(event.currentTarget.value) }} />
    </label>
    <div className="aiNovelV2AuthoringActions">
      <button type="button" disabled={disabled || draftBlocker !== undefined || startDraft === undefined}
        onClick={() => { startDraft?.('draft', chapter) }}>让 AI 起草第 {chapter} 章</button>
    </div>
    {pendingDraftReady ? <><label className="aiNovelWorkbenchField"><span>AI 生成的待审核初稿（未应用）</span>
      <textarea className="aiNovelV2ManualDraft" aria-label={`第 ${chapter} 章 AI 生成的待审核初稿`} value={proseInput.content}
        disabled={disabled || updateAuthoringInput === undefined}
        onChange={event => { updateAuthoringInput?.({ kind: 'prose', content: event.currentTarget.value }) }} />
    </label>
    <p className="aiNovelContextMuted">这份内容仅来自待审核 Proposal；应用后才会成为可修订的本章稿件。</p>
    <div className="aiNovelV2AuthoringActions">
      <button type="button" disabled={disabled || pendingDraftBlocker !== undefined || !v2AuthoringInputHasValue(authoring?.input) || reproposeManualDraft === undefined}
        onClick={() => { reproposeManualDraft?.() }}>{pendingDraftReplacement ? '用人工修改替换待审核初稿' : '将人工初稿提交为 Proposal'}</button>
    </div></> : manualRevisionReady ? <><label className="aiNovelWorkbenchField"><span>手动修改正文</span>
      <textarea className="aiNovelV2ManualDraft" aria-label={`第 ${chapter} 章手动修改正文`} value={proseInput?.content ?? ''}
        disabled={disabled || updateAuthoringInput === undefined}
        placeholder="在此修订正文；提交后会创建新的 Proposal，而不会直接覆盖已应用版本。"
        onChange={event => { updateAuthoringInput?.({ kind: 'prose', content: event.currentTarget.value }) }} />
    </label>
    <div className="aiNovelV2AuthoringActions">
      <button type="button" disabled={disabled || manualBlocker !== undefined || !v2AuthoringInputHasValue(authoring?.input) || reproposeManualDraft === undefined}
        onClick={() => { reproposeManualDraft?.() }}>将手动修改重新提交为 Proposal</button>
    </div></> : <p className="aiNovelContextMuted">选择本章的初稿或修订稿后，才能提交人工修订。</p>}
    {pendingDraftReady || (draftBlocker === undefined && manualBlocker === undefined) ? undefined : <p role="status">{authorBlockerMessage(draftBlocker ?? manualBlocker)}</p>}
    {authoring === undefined ? <p className="aiNovelContextMuted">本章创作暂未准备好。请稍后重试。</p>
      : authoring.stage === undefined ? <p className="aiNovelContextMuted">先让 AI 起草本章，或在本章稿件中选择初稿/修订稿，再重新提交手动修改。</p>
        : undefined}
  </section>
}

/** Props for the V2 shell; every action remains client-local or path-free. */
export interface NovelV2WorkbenchBodyProps {
  readonly state: NovelV2WorkbenchState
  readonly refresh: () => void
  readonly selectProposal: (proposalId: string | undefined) => void
  readonly openProposalChange: (index: number) => void
  readonly applySelectedProposal: () => void
  readonly retryProposalItem: (index: number) => void
  readonly discardProposalItem: (index: number) => void
  readonly regenerateProposalItem: (index: number) => void
  readonly selectTask: (taskId: string | undefined) => void
  readonly selectChapter: (chapter: number) => void
  /** Update the optional prompt brief used for the selected chapter's AI drafting stage. */
  readonly updateDraftBrief?: (brief: string) => void
  /** Select the local authoring stage and optional chapter without creating a proposal or write. */
  readonly prepareAuthoring?: (stage: NovelV2AuthoringStage, chapter?: number) => void
  /** Explain why a stage cannot currently create a Proposal; undefined means the action is available. */
  readonly authoringBlocker?: (stage: NovelV2AuthoringStage, chapter?: number, replacingPendingDraft?: boolean) => string | undefined
  /** Ask the current model to create one stage-specific Proposal for a chapter. */
  readonly startDraft?: (stage: NovelV2AuthoringStage, chapter?: number) => void
  /** Update the one typed local input that will be re-submitted as a manual Proposal. */
  readonly updateAuthoringInput?: (input: NovelV2AuthoringInput) => void
  /** Create a Proposal from the selected chapter's manual text; it never writes directly. */
  readonly reproposeManualDraft?: () => void
  /** Select an existing chapter artifact for review or finalization. */
  readonly selectArtifact?: (artifactId: string | undefined) => void
  /** Submit the selected eligible artifact as the chapter's final-selection Proposal. */
  readonly selectFinal?: (artifactId: string | undefined) => void
  /** User-entered draft fields for the closed one-time V2 workspace initialization command. */
  readonly updateInitialization?: (patch: Partial<NovelV2WorkspaceInitializationDraft>) => void
  /** Host-owned one-time V2 workspace initialization command. */
  readonly initializeWorkspace?: () => void
}

function V2WorkspaceInitializationForm({
  initialization,
  updateInitialization = () => {},
  initializeWorkspace = () => {},
}: {
  readonly initialization: NovelV2WorkspaceInitializationState
  readonly updateInitialization?: (patch: Partial<NovelV2WorkspaceInitializationDraft>) => void
  readonly initializeWorkspace?: () => void
}) {
  const { draft, phase, message } = initialization
  const submitting = phase === 'submitting'
  return <form className="aiNovelV2Workbench aiNovelWorkbenchForm" aria-labelledby="ai-novel-v2-initialize-title"
    onSubmit={event => { event.preventDefault(); initializeWorkspace() }}>
    <section className="aiNovelV2Panel">
      <h3 id="ai-novel-v2-initialize-title" data-ai-novel-screen-focus tabIndex={-1}>创建项目</h3>
      <p className="aiNovelContextMuted">先填写创作起点。创建后可让 AI 继续完善项目设定，并由你审核每项建议。</p>
      <label className="aiNovelWorkbenchField"><span>小说标题</span><input aria-label="小说标题" value={draft.title} disabled={submitting}
        onChange={event => { updateInitialization({ title: event.currentTarget.value }) }} /></label>
      <label className="aiNovelWorkbenchField"><span>类型</span><input aria-label="类型" value={draft.genre} disabled={submitting}
        onChange={event => { updateInitialization({ genre: event.currentTarget.value }) }} /></label>
      <label className="aiNovelWorkbenchField"><span>计划章数</span><input aria-label="计划章数" type="number" min={1} value={draft.plannedChapters} disabled={submitting}
        onChange={event => { updateInitialization({ plannedChapters: Number(event.currentTarget.value) }) }} /></label>
      <label className="aiNovelWorkbenchField"><span>每章目标字数</span><input aria-label="每章目标字数" type="number" min={1} value={draft.targetWordsPerChapter} disabled={submitting}
        onChange={event => { updateInitialization({ targetWordsPerChapter: Number(event.currentTarget.value) }) }} /></label>
      {authorInitializationMessage(message) === undefined ? undefined : <p role={phase === 'error' ? 'alert' : 'status'}>{authorInitializationMessage(message)}</p>}
      <div className="aiNovelWorkbenchActions"><button type="submit" disabled={submitting}>{submitting ? '正在创建项目…' : '创建项目'}</button></div>
    </section>
  </form>
}

/** The review lane keeps durable Proposal and task details out of the active authoring path. */
function V2ProposalReview({
  state,
  selectProposal,
  openProposalChange,
  applySelectedProposal,
  retryProposalItem,
  discardProposalItem,
  regenerateProposalItem,
  selectTask,
}: {
  readonly state: Extract<NovelV2WorkbenchState, { readonly status: 'ready' }>
  readonly selectProposal: (proposalId: string | undefined) => void
  readonly openProposalChange: (index: number) => void
  readonly applySelectedProposal: () => void
  readonly retryProposalItem: (index: number) => void
  readonly discardProposalItem: (index: number) => void
  readonly regenerateProposalItem: (index: number) => void
  readonly selectTask: (taskId: string | undefined) => void
}) {
  const selectedProposal = state.proposals.items.find(item => item.proposalId === state.proposals.selectedId)
  const selectedTask = state.tasks.items.find(item => item.taskId === state.tasks.selectedId)
  return <details className="aiNovelV2Review" data-ai-novel-proposal-dock aria-label="审核建议">
    <summary>审核建议（{state.proposals.items.length}）</summary>
    <div className="aiNovelV2ReviewBody">
      <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-proposals">
        <h3 id="ai-novel-v2-proposals">提案队列</h3>
        <p className="aiNovelContextMuted">先查看修改建议，再按顺序应用未完成项；失败的建议可重试、放弃或重新生成。</p>
        {state.proposals.message ? <p role="alert">{authorFailureMessage('proposals')}</p> : undefined}
        {state.proposals.items.length === 0 ? <p className="aiNovelContextMuted">没有待审提案。</p> : <ul className="aiNovelV2List">
          {state.proposals.items.map(proposal => <li key={proposal.proposalId}>
            <button type="button" aria-current={proposal.proposalId === state.proposals.selectedId || undefined}
              onClick={() => { selectProposal(proposal.proposalId) }}>
              {proposalStatusLabel(proposal.status)} · {proposal.items.length} 项修改建议
            </button>
          </li>)}
        </ul>}
        {selectedProposal ? <div className="aiNovelV2DetailList" aria-label="建议详情">
          {selectedProposal.items.map((item, index) => {
            const change = item.change
            const artifactCommand = isArtifactProposalChange(change)
            return <div key={item.itemId}>
              <button type="button" aria-current={state.proposals.selectedChange === index || undefined}
                onClick={() => { openProposalChange(index) }}>
                {artifactCommand
                  ? `查看 ${proposalCommandLabel(change)}`
                  : `查看 ${aggregateLabel(change.aggregate)}建议`}
              </button>
              <span> {proposalStatusLabel(item.status)}</span>
              {item.failure === undefined ? undefined : <p role="alert">{authorFailureMessage('proposal')}</p>}
              {item.receipt === undefined ? undefined : <p>{proposalReceiptLabel(change)}</p>}
              {item.regenerationTicket === undefined ? undefined : <p>已记录重新生成请求。</p>}
              {artifactCommand ? <ArtifactCommandDiff command={change} artifacts={state.workspace.snapshot.artifacts} />
                : state.proposals.selectedChange === index
                  ? <AggregateProposalDiff change={change} current={aggregateValue(state.workspace.snapshot, change.aggregate)} characters={state.workspace.snapshot.characters} />
                  : undefined}
              {state.proposals.selectedChange === index ? <ProposalItemLifecycleActions
                index={index} item={item} readOnly={state.workspace.readOnly}
                retry={retryProposalItem} discard={discardProposalItem} regenerate={regenerateProposalItem}
              /> : undefined}
            </div>
          })}
          <div className="aiNovelV2ReviewActions">
            <button type="button" onClick={applySelectedProposal}
              disabled={state.workspace.readOnly || selectedProposal.status === 'stale' || selectedProposal.status === 'discarded' || selectedProposal.status === 'superseded'}>
              依序应用未完成项
            </button>
          </div>
        </div> : undefined}
      </section>

      <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-tasks">
        <h3 id="ai-novel-v2-tasks">任务</h3>
        {state.tasks.message ? <p role="alert">{authorFailureMessage('tasks')}</p> : undefined}
        {state.tasks.items.length === 0 ? <p className="aiNovelContextMuted">当前没有任务。</p> : <ul className="aiNovelV2List">
          {state.tasks.items.map(task => <li key={task.taskId}>
            <button type="button" aria-current={task.taskId === selectedTask?.taskId || undefined}
              onClick={() => { void selectTask(task.taskId) }}>
              {taskKindLabel(task.kind)} · {taskStatusLabel(task.status)}
            </button>
            <p>当前环节：{taskStageLabel(task.stage)}</p>
            {task.failure !== '' ? <p role="alert">{authorFailureMessage('task')}</p> : undefined}
            {task.resumeCursor !== '' ? <p>可继续处理这项创作任务。</p> : undefined}
          </li>)}
        </ul>}
      </section>
    </div>
  </details>
}

/**
 * V2 single-column shell. It renders authoritative projections and local draft state only;
 * command preview, commit, and task execution remain explicitly out of this issue.
 */
export function NovelV2WorkbenchBody({
  state, refresh, selectProposal, openProposalChange, applySelectedProposal,
  retryProposalItem, discardProposalItem, regenerateProposalItem,
  selectTask, selectChapter, updateDraftBrief, startDraft, updateAuthoringInput,
  reproposeManualDraft, selectArtifact, selectFinal, prepareAuthoring, authoringBlocker, updateInitialization, initializeWorkspace,
}: NovelV2WorkbenchBodyProps) {
  if (state.status === 'not-initialized') return <V2WorkspaceInitializationForm
      initialization={state.initialization} updateInitialization={updateInitialization} initializeWorkspace={initializeWorkspace}
    />
  if (state.status === 'error') return <section className="aiNovelV2Workbench" data-ai-novel-v2-workbench>
      <h3 data-ai-novel-screen-focus tabIndex={-1}>工作台读取失败</h3>
      <p role="alert">{authorFailureMessage('workbench')}</p>
      <button type="button" onClick={refresh}>重试读取</button>
    </section>
  if (state.status !== 'ready') return state.status === 'idle'
    ? <p className="aiNovelContextMuted">请选择一个创作会话以打开小说工作台。</p>
    : <p className="aiNovelContextMuted" aria-live="polite">正在读取工作台状态…</p>

  const authoring = state.authoring
  const authoritativeChapters = state.workspace.snapshot.chapters ?? state.chapters.items
  const nextPlannedChapter = firstUnpersistedPlannedChapter(authoritativeChapters, state.workspace.project.plannedChapters)
  const chapterStageActive = authoring.stage === 'chapter-blueprint' || authoring.stage === 'draft'
    || authoring.stage === 'revision' || authoring.stage === 'select-final'
  const selectedChapter = chapterStageActive ? authoring.chapter ?? state.chapters.selected : undefined
  const openStructuredAuthoring = (stage: StructuredAuthoringStage, chapter?: number): void => {
    prepareAuthoring?.(stage, chapter)
    if (chapter !== undefined) selectChapter(chapter)
  }
  return <div className="aiNovelV2Workbench" data-ai-novel-v2-workbench>
    <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-overview">
      <h3 id="ai-novel-v2-overview" data-ai-novel-screen-focus="" tabIndex={-1}>项目概览</h3>
      <dl className="aiNovelV2Summary">
        <div><dt>项目</dt><dd>{state.workspace.project.title}</dd></div>
        <div><dt>类型</dt><dd>{state.workspace.project.genre}</dd></div>
        <div><dt>创作状态</dt><dd>{state.workspace.readOnly ? '只读' : '可创作'}</dd></div>
      </dl>
    </section>

    <section className="aiNovelV2StageShell" aria-label="小说创作步骤">
      <nav className="aiNovelV2StageNav" aria-labelledby="ai-novel-v2-assets">
      <h3 id="ai-novel-v2-assets">创作步骤</h3>
      <p className="aiNovelContextMuted">选择一个步骤后，直接查看已保存内容并继续起草或修改。</p>
      <div className="aiNovelV2AssetNav">
        <button type="button" aria-current={authoring.stage === 'project-refine' || undefined}
          onClick={() => { openStructuredAuthoring('project-refine') }}>项目设置</button>
        <button type="button" aria-current={authoring.stage === 'architecture' || undefined}
          onClick={() => { openStructuredAuthoring('architecture') }}>故事架构</button>
        <button type="button" aria-current={authoring.stage === 'characters' || undefined}
          onClick={() => { openStructuredAuthoring('characters') }}>人物设定</button>
        <button type="button" aria-current={authoring.stage === 'outline' || undefined}
          onClick={() => { openStructuredAuthoring('outline') }}>全书纲要</button>
        {state.chapters.items.map(chapter => <button type="button" key={chapter.chapter}
          aria-current={authoring.stage === 'chapter-blueprint' && authoring.chapter === chapter.chapter || undefined}
          onClick={() => { openStructuredAuthoring('chapter-blueprint', chapter.chapter) }}>
          第 {chapter.chapter} 章：{chapter.title}
        </button>)}
        {nextPlannedChapter === undefined ? undefined : <button type="button"
          aria-current={authoring.stage === 'chapter-blueprint' && authoring.chapter === nextPlannedChapter || undefined}
          onClick={() => { openStructuredAuthoring('chapter-blueprint', nextPlannedChapter) }}>
          创建下一章蓝图（第 {nextPlannedChapter} 章）
        </button>}
      </div>
      </nav>

      <section className="aiNovelV2StageContent" aria-label="当前创作步骤">
      {authoring.stage === undefined ? <section className="aiNovelV2StageEmpty" aria-live="polite">
        <h3>选择创作步骤</h3>
        <p>从创作步骤中选择项目设置、故事架构、人物设定、全书纲要或章节蓝图。已保存的内容会自动预填在表单中。</p>
      </section> : undefined}

    {authoring.stage === 'project-refine' ? <StructuredAuthoringForm
      title="项目设置" stage="project-refine" fields={projectAuthoringFields(state.workspace.snapshot.project)}
      authoring={authoring} readOnly={state.workspace.readOnly}
      updateDraftBrief={updateDraftBrief} startDraft={startDraft} updateAuthoringInput={updateAuthoringInput}
      reproposeManualDraft={reproposeManualDraft} authoringBlocker={authoringBlocker}
    /> : authoring.stage === 'architecture' ? <StructuredAuthoringForm
      title="故事架构" stage="architecture" fields={architectureAuthoringFields(state.workspace.snapshot.architecture)}
      authoring={authoring} readOnly={state.workspace.readOnly}
      updateDraftBrief={updateDraftBrief} startDraft={startDraft} updateAuthoringInput={updateAuthoringInput}
      reproposeManualDraft={reproposeManualDraft} authoringBlocker={authoringBlocker}
    /> : authoring.stage === 'outline' ? <StructuredAuthoringForm
      title="全书纲要" stage="outline" fields={outlineAuthoringFields(state.workspace.snapshot.architecture)}
      authoring={authoring} readOnly={state.workspace.readOnly}
      updateDraftBrief={updateDraftBrief} startDraft={startDraft} updateAuthoringInput={updateAuthoringInput}
      reproposeManualDraft={reproposeManualDraft} authoringBlocker={authoringBlocker}
    /> : authoring.stage === 'characters' ? <StructuredAuthoringForm
      title="人物设定" stage="characters" fields={characterAuthoringFields(state.workspace.snapshot.characters, authoring)}
      authoring={authoring} readOnly={state.workspace.readOnly}
      updateDraftBrief={updateDraftBrief} startDraft={startDraft} updateAuthoringInput={updateAuthoringInput}
      reproposeManualDraft={reproposeManualDraft} authoringBlocker={authoringBlocker}
    /> : undefined}

      {(() => {
      if (selectedChapter === undefined) return undefined
      const chapter = authoritativeChapters.find(item => item.chapter === selectedChapter)
      if (chapter === undefined) {
        if (!isPlannedChapterNumber(selectedChapter, state.workspace.project.plannedChapters)) return undefined
        return <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-chapter">
          <h3 id="ai-novel-v2-chapter">第 {selectedChapter} 章蓝图（待创建）</h3>
          <p className="aiNovelContextMuted">这是下一章的创作准备。填写后只会创建待审核建议，不会直接创建章节或改写现有稿件。</p>
          <StructuredAuthoringForm
            title={`第 ${selectedChapter} 章蓝图`}
            stage="chapter-blueprint"
            chapter={selectedChapter}
            fields={plannedChapterBlueprintAuthoringFields()}
            authoring={authoring}
            readOnly={state.workspace.readOnly}
            updateDraftBrief={updateDraftBrief}
            startDraft={startDraft}
            updateAuthoringInput={updateAuthoringInput}
            reproposeManualDraft={reproposeManualDraft}
            authoringBlocker={authoringBlocker}
          />
        </section>
      }
      const artifacts = (state.workspace.snapshot.artifacts ?? []).filter(item => item.chapter === chapter.chapter)
      const final = (state.workspace.snapshot.chapterFinals ?? []).find(item => item.chapter === chapter.chapter)
      const context = state.chapters.context ?? { phase: 'idle' as const, chapter: undefined, previousFinal: undefined, message: undefined }
      return <section className="aiNovelV2Panel" aria-labelledby="ai-novel-v2-chapter">
        <h3 id="ai-novel-v2-chapter">第 {chapter.chapter} 章蓝图</h3>
        <dl className="aiNovelV2Summary">
          <div><dt>标题</dt><dd>{chapter.title}</dd></div>
          <div><dt>目的</dt><dd>{chapter.purpose}</dd></div>
          <div><dt>状态</dt><dd>{authorStatusLabel(chapter.status)}</dd></div>
        </dl>
        <section aria-label={`第 ${chapter.chapter} 章情节节拍`}><h4>情节节拍</h4>
          {chapter.plotBeats.length === 0 ? <p className="aiNovelContextMuted">尚未记录情节节拍。</p> : <ul>{chapter.plotBeats.map(beat => <li key={beat}>{beat}</li>)}</ul>}
        </section>
        <section aria-label={`第 ${chapter.chapter} 章关键事件`}><h4>关键事件</h4>
          {chapter.keyEvents.length === 0 ? <p className="aiNovelContextMuted">尚未记录关键事件。</p> : <ul>{chapter.keyEvents.map(event => <li key={event}>{event}</li>)}</ul>}
        </section>
        {authoring.stage === 'chapter-blueprint' && authoring.chapter === chapter.chapter ? <StructuredAuthoringForm
          title={`第 ${chapter.chapter} 章蓝图`}
          stage="chapter-blueprint"
          chapter={chapter.chapter}
          fields={chapterBlueprintAuthoringFields(chapter, state.workspace.snapshot.characters)}
          authoring={authoring}
          readOnly={state.workspace.readOnly}
          updateDraftBrief={updateDraftBrief}
          startDraft={startDraft}
          updateAuthoringInput={updateAuthoringInput}
          reproposeManualDraft={reproposeManualDraft}
          authoringBlocker={authoringBlocker}
        /> : undefined}
        <ChapterAuthoringForm
          chapter={chapter.chapter}
          authoring={authoring}
          readOnly={state.workspace.readOnly}
          updateDraftBrief={updateDraftBrief}
          startDraft={startDraft}
          updateAuthoringInput={updateAuthoringInput}
          reproposeManualDraft={reproposeManualDraft}
          authoringBlocker={authoringBlocker}
        />
        <ArtifactVersionChain
          artifacts={artifacts}
          versionArtifacts={state.workspace.snapshot.artifacts}
          final={final}
          selectedArtifactId={authoring?.selectedArtifactId}
          selectedFinalArtifactId={authoring?.selectedFinalArtifactId}
          selectArtifact={selectArtifact}
          selectFinal={selectFinal}
          startDraft={startDraft}
          authoringBlocker={authoringBlocker}
          disabled={state.workspace.readOnly || v2AuthoringBusy(authoring?.phase)}
        />
        <section className="aiNovelV2ChapterContext" aria-label={`第 ${chapter.chapter} 章的上一章定稿上下文`}>
          <h4>第 {chapter.chapter} 章的上一章定稿上下文</h4>
          {context.chapter !== chapter.chapter || context.phase === 'idle' ? <p className="aiNovelContextMuted">尚未读取本章上下文。</p>
            : context.phase === 'loading' ? <p className="aiNovelContextMuted" aria-live="polite">正在读取上一章定稿上下文…</p>
              : context.phase === 'failed' ? <p role="alert">{authorFailureMessage('context')}</p>
                : context.previousFinal === undefined ? <p className="aiNovelContextMuted">没有上一章已定稿内容可带入本章。</p>
                  : <><p>第 {context.previousFinal.chapter} 章 · {context.previousFinal.summary}</p><pre>{context.previousFinal.content}</pre></>}
        </section>
      </section>
      })()}
      </section>

      <V2ProposalReview
        state={state}
        selectProposal={selectProposal}
        openProposalChange={openProposalChange}
        applySelectedProposal={applySelectedProposal}
        retryProposalItem={retryProposalItem}
        discardProposalItem={discardProposalItem}
        regenerateProposalItem={regenerateProposalItem}
        selectTask={selectTask}
      />
    </section>
  </div>
}

/** Props for the one-column workbench content. */
export interface NovelWorkbenchBodyProps {
  readonly state: NovelWorkbenchState
  readonly backIcon?: ReactNode
  readonly refresh: () => void
  readonly selectChapter: (chapter: number) => void
  readonly updateInitialization: (patch: Partial<NovelInitializationDraft>) => void
  readonly updateInitializationGenerationBrief: (brief: string) => void
  readonly generateInitialization: () => void
  readonly previewInitialization: () => void
  readonly submitInitialization: () => void
  readonly openAsset: (target: NovelWorkbenchEditableTarget) => void
  readonly backToAssets: () => void
  readonly updateProjectSettings: (patch: Partial<NovelProjectSettingsDraft>) => void
  readonly updateStoryBlueprint: (patch: Partial<NovelStoryBlueprintDraft>) => void
  readonly updateChapterBlueprint: (patch: Partial<NovelChapterBlueprintDraft>) => void
  readonly updateChapterDraft: (text: string) => void
  readonly updateAssetSummary: (summary: string) => void
  readonly updateAssetGenerationBrief: (brief: string) => void
  readonly generateAsset: () => void
  readonly previewAssetChange: () => void
  readonly submitAssetChange: () => void
  readonly discardAssetChanges: () => void
  readonly reloadStaleAsset: () => void
  readonly setCharacterSearch: (search: string) => void
  readonly selectCharacter: (id: string) => void
  readonly createCharacter: () => void
  readonly updateCharacter: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void
  readonly deleteCharacter: () => void
}

function TextList({ items, empty }: { readonly items: readonly string[]; readonly empty: string }) {
  if (items.length === 0) return <p className="aiNovelContextMuted">{empty}</p>
  return <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
}

function initializationField(
  label: string,
  name: keyof NovelInitializationDraft,
  value: string,
  update: (patch: Partial<NovelInitializationDraft>) => void,
  options: { readonly type?: 'text' | 'number'; readonly disabled?: boolean } = {},
) {
  const type = options.type ?? 'text'
  return (
    <label className="aiNovelWorkbenchField">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        disabled={options.disabled}
        value={value}
        min={type === 'number' ? 1 : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => { update({ [name]: event.currentTarget.value }) }}
      />
    </label>
  )
}

function characterField(
  label: string,
  name: keyof Omit<NovelCharacterDraft, 'id'>,
  value: string,
  update: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void,
) {
  return <label className="aiNovelWorkbenchField"><span>{label}</span><input
    value={value}
    onChange={event => { update({ [name]: event.currentTarget.value }) }}
  /></label>
}

interface CharacterRelationshipEditorRow {
  readonly characterId: string
  readonly type: string
  readonly summary: string
}

function relationshipRows(text: string): CharacterRelationshipEditorRow[] {
  if (text.trim() === '') return []
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => {
    const [characterId = '', type = '', summary = ''] = line.split('|').map(part => part.trim())
    return { characterId, type, summary }
  })
}

function relationshipText(rows: readonly CharacterRelationshipEditorRow[]): string {
  return rows.map(row => `${row.characterId} | ${row.type} | ${row.summary}`).join('\n')
}

function CharacterRelationshipsEditor({
  selected,
  characters,
  update,
}: {
  readonly selected: NovelCharacterDraft
  readonly characters: readonly NovelCharacterDraft[]
  readonly update: (patch: Partial<Omit<NovelCharacterDraft, 'id'>>) => void
}) {
  const rows = relationshipRows(selected.relationshipsText)
  const candidates = characters.filter(character => character.id !== selected.id)
  const replaceRow = (index: number, patch: Partial<CharacterRelationshipEditorRow>): void => {
    update({ relationshipsText: relationshipText(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)) })
  }
  return <fieldset className="aiNovelRelationshipEditor">
    <legend>人物关系</legend>
    {rows.length === 0 ? <p className="aiNovelContextMuted">尚未添加人物关系。</p> : rows.map((row, index) => <div className="aiNovelRelationshipRow" key={`${index}:${row.characterId}`}>
      <label className="aiNovelWorkbenchField"><span>关系人物 {index + 1}</span><select
        aria-label={`关系人物 ${index + 1}`}
        value={row.characterId}
        onChange={event => { replaceRow(index, { characterId: event.currentTarget.value }) }}
      >
        {candidates.some(character => character.id === row.characterId) ? undefined : <option value={row.characterId}>未找到的人物</option>}
        {candidates.map(character => <option value={character.id} key={character.id}>{character.name || '未命名人物'}{character.role === '' ? '' : ` · ${character.role}`}</option>)}
      </select></label>
      <label className="aiNovelWorkbenchField"><span>关系类型</span><input value={row.type} onChange={event => { replaceRow(index, { type: event.currentTarget.value }) }} /></label>
      <label className="aiNovelWorkbenchField"><span>关系说明</span><input value={row.summary} onChange={event => { replaceRow(index, { summary: event.currentTarget.value }) }} /></label>
      <button type="button" className="aiNovelPresetSecondary" onClick={() => { update({ relationshipsText: relationshipText(rows.filter((_row, rowIndex) => rowIndex !== index)) }) }}>删除关系</button>
    </div>)}
    <button
      type="button"
      className="aiNovelPresetSecondary"
      disabled={candidates.length === 0}
      onClick={() => { update({ relationshipsText: relationshipText([...rows, { characterId: candidates[0]!.id, type: '', summary: '' }]) }) }}
    >添加关系</button>
  </fieldset>
}

function ChapterCastEditor({
  characters,
  selectedIdsText,
  disabled,
  update,
}: {
  readonly characters: Extract<NovelWorkbenchState, { status: 'ready' }>['characters']
  readonly selectedIdsText: string
  readonly disabled: boolean
  readonly update: (characterIdsText: string) => void
}) {
  const selectedIds = selectedIdsText.split(/\r?\n/).map(id => id.trim()).filter(Boolean)
  const selected = new Set(selectedIds)
  const known = new Set(characters.map(character => character.id))
  const hiddenCount = selectedIds.filter(id => !known.has(id)).length
  return <fieldset className="aiNovelCastEditor" disabled={disabled}>
    <legend>出场人物</legend>
    {characters.length === 0 ? <p className="aiNovelContextMuted">请先建立人物设定。</p> : characters.map(character => <label key={character.id}>
      <input
        type="checkbox"
        checked={selected.has(character.id)}
        onChange={event => {
          const next = event.currentTarget.checked
            ? [...selectedIds, character.id]
            : selectedIds.filter(id => id !== character.id)
          update([...new Set(next)].join('\n'))
        }}
      />
      <span>{character.name || '未命名人物'}{character.role === '' ? '' : ` · ${character.role}`}</span>
    </label>)}
    {hiddenCount === 0 ? undefined : <p className="aiNovelContextMuted">已保留 {hiddenCount} 个当前人物列表中未显示的引用。</p>}
  </fieldset>
}

function AssetProposalFields({
  screen,
  disabled,
  updateSummary,
}: {
  readonly screen: NovelAssetEditorScreen
  readonly disabled: boolean
  readonly updateSummary: (summary: string) => void
}) {
  return <>
    <label className="aiNovelWorkbenchField"><span>修改摘要</span><textarea
      value={screen.summary}
      disabled={disabled}
      placeholder="说明本次单资产修改"
      onChange={event => { updateSummary(event.currentTarget.value) }}
    /></label>
    {screen.replacement === undefined ? undefined : <section className="aiNovelInitializationPreview" aria-label="即将提交的完整资产文本">
      <h4>即将提交的完整资产文本</h4>
      <p>审批前磁盘不会变化；提交后请回到对话处理原生 diff 审批。</p>
      <pre>{screen.replacement}</pre>
    </section>}
  </>
}

function AssetEditorFeedback({
  phase,
  message,
  reload,
}: {
  readonly phase: NovelAssetEditorPhase
  readonly message: string | undefined
  readonly reload: () => void
}) {
  if (message === undefined && phase !== 'submitted') return null
  if (phase === 'stale') return <div role="alert" className="aiNovelEditorNotice"><p>{message}</p><button type="button" className="aiNovelPresetSecondary" onClick={reload}>重新载入最新版本</button></div>
  return <p role={phase === 'error' ? 'alert' : 'status'}>{message ?? '修改提案已发送；请回到对话处理 Harness 原生审批。'}</p>
}

function assetEditorLocked(phase: NovelAssetEditorPhase): boolean {
  return phase === 'submitting' || phase === 'submitted' || phase === 'stale'
}

function generationLabel(screen: NovelAssetEditorScreen): string {
  switch (screen.kind) {
    case 'project': return '项目设置'
    case 'characters': return '人物设定'
    case 'story-blueprint': return '故事蓝图'
    case 'chapter-blueprint': return `第 ${screen.chapter} 章蓝图`
    case 'chapter-draft': return `第 ${screen.chapter} 章正文`
  }
}

function generationPending(screen: NovelAssetEditorScreen): boolean {
  return screen.generation?.phase === 'submitting'
    || screen.generation?.phase === 'submitted'
    || screen.generation?.phase === 'reconciling'
}

function AssetGenerationPanel({
  screen,
  blocker,
  updateBrief,
  generate,
}: {
  readonly screen: NovelAssetEditorScreen
  readonly blocker?: string
  readonly updateBrief: (brief: string) => void
  readonly generate: () => void
}) {
  const label = generationLabel(screen)
  const generation = screen.generation ?? { brief: '', phase: 'editing' as const }
  const pending = generationPending(screen)
  const manualBlocked = screen.phase !== 'clean' && screen.phase !== 'editing'
  return <section className="aiNovelGenerationPanel" aria-labelledby={`ai-novel-generate-${screen.kind}`}>
    <div className="aiNovelGenerationHeader">
      <h4 id={`ai-novel-generate-${screen.kind}`}>AI 生成{label}</h4>
      <p>只会生成当前资产，并通过对话展示原生审批。</p>
    </div>
    <p className="aiNovelContextMuted">原生审批就是对话中的单文件差异卡片。点击“允许一次”后会立即保存并回填本页字段，不会再出现第二次审批。</p>
    <label className="aiNovelWorkbenchField">
      <span>补充要求（可选）</span>
      <textarea
        aria-label={`${label} AI 生成要求`}
        value={generation.brief}
        disabled={pending}
        placeholder="例如：玄幻题材，主角林凡，保持现有世界观一致"
        onChange={event => { updateBrief(event.currentTarget.value) }}
      />
    </label>
    <p className="aiNovelContextMuted">留空时，模型会根据当前资产和项目上下文自动完善。</p>
    {screen.dirty && !manualBlocked && !pending
      ? <p className="aiNovelContextMuted">当前未提交表单会作为 AI 生成参考；模型结果仍需原生审批。</p>
      : undefined}
    {manualBlocked && !pending
      ? <p className="aiNovelContextMuted">当前手动修改已进入提案流程。请在底部提交手动修改到当前会话，或放弃修改后再生成。</p>
      : undefined}
    {blocker === undefined ? undefined : <p role="alert">{blocker}</p>}
    {generation.message !== undefined
      ? <p role={generation.phase === 'error' ? 'alert' : 'status'}>{generation.message}</p>
      : undefined}
    <button
      type="button"
      className="aiNovelPresetSecondary aiNovelGenerationButton"
      disabled={blocker !== undefined || pending || manualBlocked}
      onClick={generate}
    >{generation.phase === 'submitting' ? '正在发送生成请求…' : '让当前模型生成'}</button>
  </section>
}

function AssetEditorHeading({
  title,
  detail,
  back,
  blocked,
  icon,
}: {
  readonly title: string
  readonly detail: string
  readonly back: () => void
  readonly blocked: boolean
  readonly icon: ReactNode
}) {
  return <div className="aiNovelAssetHeading">
    <button type="button" className="aiNovelBackButton" aria-label="返回小说资产列表" disabled={blocked} onClick={back}>
      {icon}<span>返回小说资产</span>
    </button>
    <div><h3 data-ai-novel-screen-focus tabIndex={-1}>{title}</h3><p>{detail}</p></div>
  </div>
}

function AssetEditorActions({
  dirty,
  phase,
  hasPreview,
  refresh,
  discard,
}: {
  readonly dirty: boolean
  readonly phase: NovelAssetEditorPhase
  readonly hasPreview: boolean
  readonly refresh: () => void
  readonly discard: () => void
}) {
  const locked = assetEditorLocked(phase)
  return <div className="aiNovelWorkbenchActions">
    <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新读取</button>
    <button type="button" className="aiNovelPresetSecondary" disabled={!dirty || locked} onClick={discard}>放弃修改</button>
    <button type="submit" className="aiNovelPresetPrimary" disabled={!dirty || locked}>
      {phase === 'submitting' ? '正在发送提案…' : hasPreview ? '提交手动修改到当前会话' : '预览手动修改'}
    </button>
  </div>
}

/**
 * Render the initialization tracer bullet and the existing bounded project summary.
 *
 * @param props Workbench state and user actions.
 * @returns Accessible one-column drawer content.
 */
export function NovelWorkbenchBody({
  state,
  backIcon,
  refresh,
  selectChapter,
  updateInitialization,
  updateInitializationGenerationBrief,
  generateInitialization,
  previewInitialization,
  submitInitialization,
  openAsset,
  backToAssets,
  updateProjectSettings,
  updateStoryBlueprint,
  updateChapterBlueprint,
  updateChapterDraft,
  updateAssetSummary,
  updateAssetGenerationBrief,
  generateAsset,
  previewAssetChange,
  submitAssetChange,
  discardAssetChanges,
  reloadStaleAsset,
  setCharacterSearch,
  selectCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
}: NovelWorkbenchBodyProps) {
  switch (state.status) {
    case 'idle':
    case 'loading': return <p role="status">正在读取小说工作台…</p>
    case 'empty': return <p role="status">当前没有属于已注册工作区的会话。请先打开小说工作区中的会话。</p>
    case 'disconnected': return (
      <div role="alert">
        <p>Harness 连接已断开，恢复连接后才能读取或提交提案。</p>
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新连接后读取</button>
      </div>
    )
    case 'error': return (
      <div role="alert">
        <p>小说工作台读取失败：{state.message}</p>
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重试读取</button>
      </div>
    )
    case 'not-initialized': {
      const { blocker, draft, phase, message, preview } = state.initialization
      const generation = state.initialization.generation ?? { brief: '', phase: 'editing' as const }
      const generationPending = generation.phase === 'submitting'
        || generation.phase === 'submitted'
        || generation.phase === 'reconciling'
      const manuallyEdited = draft.title !== '' || draft.language !== 'zh-CN' || draft.genre !== ''
        || draft.plannedChapters !== '20' || draft.targetWordsPerChapter !== '3000' || draft.creativeStrategy !== 'auto'
      const disabled = blocker !== undefined || phase === 'submitting' || phase === 'submitted' || generationPending
      return (
        <form
          className="aiNovelWorkbenchForm"
          aria-labelledby="ai-novel-initialize-title"
          onSubmit={event => {
            event.preventDefault()
            if (preview === undefined) previewInitialization()
            else submitInitialization()
          }}
        >
          <div className="aiNovelWorkbenchIntro">
            <h3 id="ai-novel-initialize-title">初始化小说项目</h3>
            <p>填写项目设置后，工作台只会向当前会话发送一份初始化提案。文件仍需经过 Harness 原生审批才会创建。</p>
          </div>
          <section className="aiNovelGenerationPanel" aria-labelledby="ai-novel-generate-initialization">
            <div className="aiNovelGenerationHeader">
              <h4 id="ai-novel-generate-initialization">AI 生成项目设置</h4>
              <p>描述题材与主角，当前模型会生成一份初始化提案，并通过对话展示原生审批。</p>
            </div>
            <p className="aiNovelContextMuted">原生审批就是对话中的单文件差异卡片。点击“允许一次”后会创建项目并回填本页字段，不会再出现第二次审批。</p>
            <label className="aiNovelWorkbenchField"><span>生成要求（可选）</span><textarea
              aria-label="项目设置 AI 生成要求"
              value={generation.brief}
              disabled={generationPending}
              placeholder="例如：玄幻题材，主角林凡，规划 12 章"
              onChange={event => { updateInitializationGenerationBrief(event.currentTarget.value) }}
            /></label>
            <p className="aiNovelContextMuted">留空时，模型会根据当前表单和默认项目规模自动生成。</p>
            {manuallyEdited && !generationPending
              ? <p className="aiNovelContextMuted">当前手填项目设置会作为 AI 生成参考；模型结果仍需原生审批。</p>
              : undefined}
            {generation.message === undefined ? undefined
              : <p role={generation.phase === 'error' ? 'alert' : 'status'}>{generation.message}</p>}
            <button
              type="button"
              className="aiNovelPresetSecondary aiNovelGenerationButton"
              disabled={blocker !== undefined || generationPending}
              onClick={generateInitialization}
            >{generation.phase === 'submitting' ? '正在发送生成请求…' : '让当前模型生成'}</button>
          </section>
          {initializationField('小说标题', 'title', draft.title, updateInitialization, { disabled })}
          {initializationField('语言', 'language', draft.language, updateInitialization, { disabled })}
          {initializationField('类型', 'genre', draft.genre, updateInitialization, { disabled })}
          {initializationField('计划章数', 'plannedChapters', draft.plannedChapters, updateInitialization, { type: 'number', disabled })}
          {initializationField(
            '每章目标字数', 'targetWordsPerChapter', draft.targetWordsPerChapter, updateInitialization,
            { type: 'number', disabled },
          )}
          <label className="aiNovelWorkbenchField">
            <span>创作策略</span>
            <select
              name="creativeStrategy"
              value={draft.creativeStrategy}
              disabled={disabled}
              onChange={event => { updateInitialization({ creativeStrategy: event.currentTarget.value as NovelInitializationDraft['creativeStrategy'] }) }}
            >
              <option value="auto">自动平衡</option>
              <option value="fluent-drafting">流畅起草</option>
              <option value="consistency-first">一致性优先</option>
              <option value="deep-planning">深度规划</option>
            </select>
          </label>
          {blocker !== undefined ? <p role="alert">{blocker}</p> : undefined}
          {message !== undefined ? <p role={phase === 'error' ? 'alert' : 'status'}>{message}</p> : undefined}
          {preview !== undefined ? (
            <section className="aiNovelInitializationPreview" aria-labelledby="ai-novel-initialization-preview-title">
              <h4 id="ai-novel-initialization-preview-title">即将提交的完整值</h4>
              <p>项目 ID 与时间戳由插件自动生成；确认可读的小说设置后，再提交到当前会话。</p>
              <pre>{preview.json}</pre>
            </section>
          ) : undefined}
          {phase === 'submitted'
            ? <p role="status">初始化提案已发送。请回到对话查看并处理原生审批；批准后工作台会自动重新读取。</p>
            : undefined}
          {state.readFeedback !== undefined
            ? <p role={state.readFeedback.kind === 'error' || state.readFeedback.kind === 'disconnected' ? 'alert' : 'status'}>{state.readFeedback.message}</p>
            : undefined}
          <div className="aiNovelWorkbenchActions">
            <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>重新读取</button>
            <button type="submit" className="aiNovelPresetPrimary" disabled={disabled}>
              {phase === 'submitting'
                ? '正在发送提案…'
                : preview === undefined ? '预览初始化提案' : '提交到当前会话'}
            </button>
          </div>
        </form>
      )
    }
    case 'ready': {
      const screen = state.screen
      if (screen.kind === 'asset-loading') return <p role="status">正在读取资产的精确 revision…</p>
      if (screen.kind === 'asset-error') return (
        <div role="alert" className="aiNovelWorkbenchForm">
          <p>资产读取失败：{screen.message}</p>
          <div className="aiNovelWorkbenchActions aiNovelWorkbenchActionsInline">
            <button type="button" className="aiNovelPresetSecondary" onClick={backToAssets}>返回资产</button>
            <button type="button" className="aiNovelPresetPrimary" onClick={() => { openAsset(screen.target) }}>重试</button>
          </div>
        </div>
      )
      if (screen.kind === 'project') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="项目设置" detail={`基于 revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            {initializationField('小说标题', 'title', screen.draft.title, updateProjectSettings, { disabled })}
            {initializationField('语言', 'language', screen.draft.language, updateProjectSettings, { disabled })}
            {initializationField('类型', 'genre', screen.draft.genre, updateProjectSettings, { disabled })}
            {initializationField('计划章数', 'plannedChapters', screen.draft.plannedChapters, updateProjectSettings, { type: 'number', disabled })}
            {initializationField('每章目标字数', 'targetWordsPerChapter', screen.draft.targetWordsPerChapter, updateProjectSettings, { type: 'number', disabled })}
            <label className="aiNovelWorkbenchField"><span>创作策略</span><select
              value={screen.draft.creativeStrategy}
              disabled={disabled}
              onChange={event => { updateProjectSettings({ creativeStrategy: event.currentTarget.value as NovelProjectSettingsDraft['creativeStrategy'] }) }}
            ><option value="auto">自动平衡</option><option value="fluent-drafting">流畅起草</option><option value="consistency-first">一致性优先</option><option value="deep-planning">深度规划</option></select></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions
              dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined}
              refresh={refresh} discard={discardAssetChanges}
            />
          </form>
        )
      }
      if (screen.kind === 'characters') {
        const selected = screen.characters.find(character => character.id === screen.selectedId)
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="人物设定" detail={`${screen.characters.length} 人 · revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <div className="aiNovelCharacterToolbar">
              <label className="aiNovelWorkbenchField"><span>搜索人物</span><input value={screen.search} onChange={event => { setCharacterSearch(event.currentTarget.value) }} /></label>
              <button type="button" className="aiNovelPresetSecondary" disabled={disabled} onClick={createCharacter}>新建人物</button>
            </div>
            {screen.visibleCharacterIds.length === 0
              ? <p className="aiNovelContextMuted">没有匹配的人物。</p>
              : <ul className="aiNovelCharacterList" aria-label="人物列表">{screen.visibleCharacterIds.map(id => {
                  const character = screen.characters.find(item => item.id === id)!
                  return <li key={id}><button type="button" aria-current={id === screen.selectedId} onClick={() => { selectCharacter(id) }}><strong>{character.name || '未命名人物'}</strong><span>{character.role || '角色未填写'}</span></button></li>
                })}</ul>}
            {selected === undefined ? <p className="aiNovelContextMuted">选择或新建人物后编辑完整设定。</p> : <fieldset className="aiNovelCharacterEditor" disabled={disabled}>
              <legend>{selected.name || '新人物'}</legend>
              {characterField('姓名', 'name', selected.name, updateCharacter)}
              {characterField('角色', 'role', selected.role, updateCharacter)}
              {characterField('摘要', 'summary', selected.summary, updateCharacter)}
              {characterField('目标', 'goal', selected.goal, updateCharacter)}
              <CharacterRelationshipsEditor selected={selected} characters={screen.characters} update={updateCharacter} />
              <label className="aiNovelWorkbenchField"><span>备注</span><textarea value={selected.notes} onChange={event => { updateCharacter({ notes: event.currentTarget.value }) }} /></label>
              <button type="button" className="aiNovelDangerButton" onClick={deleteCharacter}>删除此人物</button>
            </fieldset>}
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'story-blueprint') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title="故事蓝图" detail={`revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>故事前提</span><textarea disabled={disabled} value={screen.draft.premise} onChange={event => { updateStoryBlueprint({ premise: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>主题（每行一项）</span><textarea disabled={disabled} value={screen.draft.themesText} onChange={event => { updateStoryBlueprint({ themesText: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>世界设定</span><textarea disabled={disabled} value={screen.draft.world} onChange={event => { updateStoryBlueprint({ world: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>故事主线</span><textarea disabled={disabled} value={screen.draft.mainPlot} onChange={event => { updateStoryBlueprint({ mainPlot: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>结局目标</span><textarea disabled={disabled} value={screen.draft.endingGoal} onChange={event => { updateStoryBlueprint({ endingGoal: event.currentTarget.value }) }} /></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'chapter-blueprint') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title={`第 ${screen.chapter} 章蓝图`} detail={`revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>章节标题</span><input disabled={disabled} value={screen.draft.title} onChange={event => { updateChapterBlueprint({ title: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>章节目的</span><textarea disabled={disabled} value={screen.draft.purpose} onChange={event => { updateChapterBlueprint({ purpose: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>情节节拍（每行一项）</span><textarea disabled={disabled} value={screen.draft.beatsText} onChange={event => { updateChapterBlueprint({ beatsText: event.currentTarget.value }) }} /></label>
            <ChapterCastEditor
              characters={state.characters}
              selectedIdsText={screen.draft.characterIdsText}
              disabled={disabled}
              update={characterIdsText => { updateChapterBlueprint({ characterIdsText }) }}
            />
            <label className="aiNovelWorkbenchField"><span>连续性备注（每行一项）</span><textarea disabled={disabled} value={screen.draft.continuityNotesText} onChange={event => { updateChapterBlueprint({ continuityNotesText: event.currentTarget.value }) }} /></label>
            <label className="aiNovelWorkbenchField"><span>章节状态</span><select disabled={disabled} value={screen.draft.status} onChange={event => { updateChapterBlueprint({ status: event.currentTarget.value as NovelChapterBlueprintDraft['status'] }) }}><option value="planned">已规划</option><option value="drafting">起草中</option><option value="drafted">已起草</option><option value="revised">已修订</option><option value="final">已定稿</option></select></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      if (screen.kind === 'chapter-draft') {
        const disabled = assetEditorLocked(screen.phase) || generationPending(screen)
        return (
          <form className="aiNovelWorkbenchForm" onSubmit={event => { event.preventDefault(); screen.preview === undefined ? previewAssetChange() : submitAssetChange() }}>
            <AssetEditorHeading title={`第 ${screen.chapter} 章正文`} detail={`Markdown · revision ${screen.baseRevision.slice(0, 12)}`} back={backToAssets} blocked={screen.dirty || disabled} icon={backIcon} />
            <label className="aiNovelWorkbenchField"><span>章节正文 Markdown</span><textarea
              className="aiNovelChapterDraftEditor"
              aria-label="章节正文 Markdown"
              disabled={disabled}
              value={screen.text}
              onChange={event => { updateChapterDraft(event.currentTarget.value) }}
            /></label>
            <AssetGenerationPanel screen={screen} blocker={state.submissionBlocker} updateBrief={updateAssetGenerationBrief} generate={generateAsset} />
            <AssetProposalFields screen={screen} disabled={disabled} updateSummary={updateAssetSummary} />
            <AssetEditorFeedback phase={screen.phase} message={screen.message} reload={reloadStaleAsset} />
            <AssetEditorActions dirty={screen.dirty} phase={screen.phase} hasPreview={screen.preview !== undefined} refresh={refresh} discard={discardAssetChanges} />
          </form>
        )
      }
      const blueprint = state.chapterBlueprint
      return (
        <div className="aiNovelContextSections">
          <section aria-labelledby="ai-novel-assets">
            <div className="aiNovelContextSectionHeader"><h3 id="ai-novel-assets" data-ai-novel-screen-focus tabIndex={-1}>小说资产</h3><button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新</button></div>
            <div className="aiNovelAssetList">
              <button type="button" onClick={() => { openAsset({ kind: 'project' }) }}><strong>项目设置</strong><span>标题、语言、类型、规模与创作策略</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'characters' }) }}><strong>人物设定</strong><span>{state.characters.length === 0 ? '尚未建立人物表' : `${state.characters.length} 个人物`}</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'story-blueprint' }) }}><strong>故事蓝图</strong><span>{state.storyBlueprint === null ? '尚未建立' : '前提、主题、世界与主线'}</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'chapter-blueprint', chapter: state.progress.selectedChapter }) }}><strong>章节蓝图</strong><span>第 {state.progress.selectedChapter} 章的目的、节拍与连续性</span></button>
              <button type="button" onClick={() => { openAsset({ kind: 'chapter-draft', chapter: state.progress.selectedChapter }) }}><strong>章节正文</strong><span>{state.progress.draftPresent ? `${state.progress.draftBytes} 字节` : `第 ${state.progress.selectedChapter} 章尚未创建`}</span></button>
            </div>
          </section>
          <section aria-labelledby="ai-novel-project-summary">
            <div className="aiNovelContextSectionHeader">
              <h3 id="ai-novel-project-summary">{state.project.title}</h3>
            </div>
            <dl className="aiNovelContextFacts">
              <div><dt>类型</dt><dd>{state.project.genre}</dd></div>
              <div><dt>语言</dt><dd>{state.project.language}</dd></div>
              <div><dt>创作策略</dt><dd>{state.project.creativeStrategy}</dd></div>
              <div><dt>目标字数</dt><dd>{state.project.targetWordsPerChapter}</dd></div>
            </dl>
          </section>
          <section aria-labelledby="ai-novel-chapter-progress">
            <div className="aiNovelContextSectionHeader">
              <h3 id="ai-novel-chapter-progress">章节进度</h3>
              <label>
                <span className="aiNovelContextSrOnly">选择章节</span>
                <input
                  type="number"
                  min={1}
                  max={state.progress.plannedChapters}
                  value={state.progress.selectedChapter}
                  aria-label="选择小说章节"
                  onChange={event => { selectChapter(Number(event.currentTarget.value)) }}
                />
              </label>
            </div>
            <p>第 {state.progress.selectedChapter} / {state.progress.plannedChapters} 章 · {state.progress.status}</p>
            <p className="aiNovelContextMuted">正文 {state.progress.draftPresent ? `${state.progress.draftBytes} 字节` : '尚未创建'}</p>
          </section>
          <section aria-labelledby="ai-novel-characters">
            <h3 id="ai-novel-characters">人物摘要</h3>
            {state.characters.length === 0
              ? <p className="aiNovelContextMuted">尚未建立人物表。</p>
              : <ul className="aiNovelContextCharacters">{state.characters.map(character => (
                  <li key={character.id}><strong>{character.name}</strong><span>{character.role}</span><p>{character.summary}</p></li>
                ))}</ul>}
          </section>
          <section aria-labelledby="ai-novel-story-blueprint">
            <h3 id="ai-novel-story-blueprint">故事蓝图</h3>
            {state.storyBlueprint === null
              ? <p className="aiNovelContextMuted">尚未建立故事蓝图。</p>
              : <>
                  <p>{state.storyBlueprint.premise}</p>
                  <TextList items={state.storyBlueprint.themes} empty="暂无主题" />
                  <p>{state.storyBlueprint.world}</p>
                  <p>{state.storyBlueprint.mainPlot}</p>
                  <p>{state.storyBlueprint.endingGoal}</p>
                </>}
          </section>
          <section aria-labelledby="ai-novel-chapter-blueprint">
            <h3 id="ai-novel-chapter-blueprint">章节蓝图</h3>
            {blueprint === null
              ? <p className="aiNovelContextMuted">本章尚未建立蓝图。</p>
              : <>
                  <h4>{blueprint.title}</h4>
                  <p>{blueprint.purpose}</p>
                  <TextList items={blueprint.beats} empty="暂无情节节拍" />
                  <TextList items={blueprint.continuityNotes} empty="暂无连续性备注" />
                </>}
          </section>
          <section aria-labelledby="ai-novel-draft-preview">
            <h3 id="ai-novel-draft-preview">正文预览</h3>
            {state.draft === null
              ? <p className="aiNovelContextMuted">本章尚未创建正文。</p>
              : <>
                  <pre className="aiNovelContextPreview">{state.draft.preview}</pre>
                  {state.draft.truncated ? <p role="status">预览已截断；完整正文仍保留在项目中。</p> : undefined}
                </>}
          </section>
          {state.omittedSources.length > 0
            ? <p role="status">读取预算已省略：{state.omittedSources.join('、')}</p>
            : undefined}
          {state.readFeedback !== undefined
            ? <p role={state.readFeedback.kind === 'error' || state.readFeedback.kind === 'disconnected' ? 'alert' : 'status'}>{state.readFeedback.message}</p>
            : undefined}
        </div>
      )
    }
  }
}

/** Props for the Plugin Configuration evidence card. */
export interface NovelPluginCardBodyProps {
  readonly setupState: PresetSetupState
  readonly workbenchState: NovelWorkbenchState | NovelV2WorkbenchState | undefined
  readonly workbenchMode: 'none' | 'v1' | 'v2'
  readonly openWorkbench: (returnFocus: HTMLButtonElement) => void
  readonly refresh: () => void
}

function hostStatus(state: PresetSetupState): string {
  return state.status === 'disconnected' ? 'Host 已断开' : 'Host 已连接'
}

function presetStatus(state: PresetSetupState): string {
  switch (state.status) {
    case 'installed': return 'Preset 已安装'
    case 'not-installed': return 'Preset 未安装'
    case 'conflict': return 'Preset 存在冲突'
    case 'disconnected': return 'Preset 状态不可用'
    case 'error': return 'Preset 检查失败'
    case 'idle':
    case 'loading': return '正在检查 Preset'
  }
}

function workspaceStatus(state: NovelWorkbenchState | NovelV2WorkbenchState | undefined, mode: 'none' | 'v1' | 'v2'): string {
  if (mode === 'none' || state === undefined) return '未绑定小说会话'
  if (mode === 'v2') {
    if (state.status === 'ready') return 'Workspace 已选择'
    if (state.status === 'loading') return '正在检查 Workspace'
    if (state.status === 'error') return 'Workspace 状态不可用'
    return 'Workspace 未选择'
  }
  const v1 = state as NovelWorkbenchState
  return v1.status === 'empty' || v1.status === 'idle' ? 'Workspace 未选择' : 'Workspace 已选择'
}

function projectStatus(state: NovelWorkbenchState | NovelV2WorkbenchState | undefined, mode: 'none' | 'v1' | 'v2'): string {
  if (mode === 'none' || state === undefined) return '请在当前会话选择 AI 小说作家 Preset'
  if (mode === 'v2') {
    if (state.status === 'ready') return '项目已加载（V2）'
    if (state.status === 'loading') return '正在检查项目'
    if (state.status === 'error') return state.message.includes('连接已断开') ? '项目状态不可用' : '项目读取失败'
    return '项目尚不可用'
  }
  const v1 = state as NovelWorkbenchState
  switch (v1.status) {
    case 'ready': return '项目已初始化'
    case 'not-initialized': return '项目未初始化'
    case 'loading': return '正在检查项目'
    case 'error': return '项目读取失败'
    case 'disconnected': return '项目状态不可用'
    case 'idle':
    case 'empty': return '项目尚不可用'
  }
}

/**
 * Render visible evidence that the browser plugin and its Host/Preset/project integrations are active.
 *
 * @param props Current setup and workbench state plus explicit actions.
 * @returns One Plugin Configuration list item.
 */
export function NovelPluginCardBody({
  setupState,
  workbenchState,
  workbenchMode,
  openWorkbench,
  refresh,
}: NovelPluginCardBodyProps) {
  return (
    <li className="aiNovelPluginCard">
      <div className="aiNovelPluginCardHeader">
        <div><strong>AI 小说作家</strong><p>{workbenchMode === 'v2' ? 'V2 单列工作台与只读项目投影' : workbenchMode === 'v1' ? '小说项目、专用 Preset 与审批式创作流程' : '当前会话未绑定小说 Preset；打开可查看首次使用引导并安装。'}</p></div>
        <span className="aiNovelPluginMounted">Client 已挂载</span>
      </div>
      <dl className="aiNovelPluginFacts">
        <div><dt>Host</dt><dd>{hostStatus(setupState)}</dd></div>
        <div><dt>Preset</dt><dd>{presetStatus(setupState)}</dd></div>
        <div><dt>工作台</dt><dd>{workbenchMode === 'v2' ? 'V2 单列工作台' : workbenchMode === 'v1' ? 'V1 紧凑编辑器' : '未绑定小说会话'}</dd></div>
        <div><dt>Workspace</dt><dd>{workspaceStatus(workbenchState, workbenchMode)}</dd></div>
        <div><dt>小说项目</dt><dd>{projectStatus(workbenchState, workbenchMode)}</dd></div>
      </dl>
      <div className="aiNovelPluginActions">
        <button type="button" className="aiNovelPresetSecondary" onClick={refresh}>刷新状态</button>
        <button
          type="button"
          className="aiNovelPresetPrimary"
          onClick={event => { openWorkbench(event.currentTarget) }}
        >打开小说工作台</button>
      </div>
    </li>
  )
}
