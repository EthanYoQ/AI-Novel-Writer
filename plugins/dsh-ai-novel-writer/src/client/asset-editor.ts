/** Pure canonical asset codecs and editor models for the compact browser workbench. */

import type { AssetRef, CreativeStrategy, NovelProjectId, Revision } from '../types.ts'

/** Asset kinds editable in the current revision-aware workbench slice. */
export type NovelWorkbenchEditableTarget = Extract<
  AssetRef,
  { readonly kind: 'project' | 'characters' | 'story-blueprint' | 'chapter-blueprint' | 'chapter-draft' }
>

/** User-editable project settings; durable identity and timestamps remain controller-owned. */
export interface NovelProjectSettingsDraft {
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: string
  readonly targetWordsPerChapter: string
  readonly creativeStrategy: CreativeStrategy
}

/** User-editable projection of one canonical character record. */
export interface NovelCharacterDraft {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly summary: string
  readonly goal: string
  readonly relationshipsText: string
  readonly notes: string
}

/** User-editable story blueprint projection with one theme per line. */
export interface NovelStoryBlueprintDraft {
  readonly premise: string
  readonly themesText: string
  readonly world: string
  readonly mainPlot: string
  readonly endingGoal: string
}

/** Supported durable chapter planning state. */
export type NovelChapterStatus = 'planned' | 'drafting' | 'drafted' | 'revised' | 'final'

/** User-editable chapter blueprint projection with list fields one item per line. */
export interface NovelChapterBlueprintDraft {
  readonly title: string
  readonly purpose: string
  readonly beatsText: string
  readonly characterIdsText: string
  readonly continuityNotesText: string
  readonly status: NovelChapterStatus
}

/** Revision-aware editor phase shown without implying a disk write. */
export type NovelAssetEditorPhase =
  | 'clean'
  | 'editing'
  | 'preview'
  | 'submitting'
  | 'submitted'
  | 'stale'
  | 'error'

/** Session admission state for model-generated one-asset proposals. */
export type NovelAssetGenerationPhase = 'editing' | 'submitting' | 'submitted' | 'reconciling' | 'error'

/** User brief and visible outcome for model generation that never writes from the browser. */
export interface NovelAssetGenerationState {
  readonly brief: string
  readonly phase: NovelAssetGenerationPhase
  readonly message?: string
  /** CommitReceipt revision that identifies the approved canonical Host bytes. */
  readonly expectedRevision?: Revision
  readonly expectedReplacement?: string
}

/** Exact single-asset proposal generated before Session admission. */
export interface NovelAssetChangePreview {
  readonly prompt: string
  readonly replacement: string
}

interface NovelAssetEditorBase {
  readonly phase: NovelAssetEditorPhase
  readonly dirty: boolean
  readonly baseRevision: Revision
  readonly originalText: string
  readonly summary: string
  readonly replacement?: string
  readonly preview?: NovelAssetChangePreview
  readonly latestRevision?: Revision
  readonly message?: string
  readonly generation?: NovelAssetGenerationState
}

/** Project settings editor state backed by one exact manifest revision. */
export interface NovelProjectEditorScreen extends NovelAssetEditorBase {
  readonly kind: 'project'
  readonly draft: NovelProjectSettingsDraft
}

/** Complete characters asset editor state backed by one exact revision. */
export interface NovelCharactersEditorScreen extends NovelAssetEditorBase {
  readonly kind: 'characters'
  readonly characters: readonly NovelCharacterDraft[]
  readonly selectedId: string | undefined
  readonly search: string
  readonly visibleCharacterIds: readonly string[]
}

/** Complete story-blueprint editor state backed by one exact revision. */
export interface NovelStoryBlueprintEditorScreen extends NovelAssetEditorBase {
  readonly kind: 'story-blueprint'
  readonly draft: NovelStoryBlueprintDraft
}

/** One chapter-blueprint editor backed by its exact chapter and revision. */
export interface NovelChapterBlueprintEditorScreen extends NovelAssetEditorBase {
  readonly kind: 'chapter-blueprint'
  readonly chapter: number
  readonly draft: NovelChapterBlueprintDraft
}

/** Markdown chapter editor backed by its exact chapter and revision. */
export interface NovelChapterDraftEditorScreen extends NovelAssetEditorBase {
  readonly kind: 'chapter-draft'
  readonly chapter: number
  readonly text: string
}

/** Any open revision-aware single-asset editor. */
export type NovelAssetEditorScreen =
  | NovelProjectEditorScreen
  | NovelCharactersEditorScreen
  | NovelStoryBlueprintEditorScreen
  | NovelChapterBlueprintEditorScreen
  | NovelChapterDraftEditorScreen

/** Current compact drawer screen; it never represents a second application shell. */
export type NovelWorkbenchScreen =
  | { readonly kind: 'root' }
  | { readonly kind: 'asset-loading'; readonly target: NovelWorkbenchEditableTarget }
  | { readonly kind: 'asset-error'; readonly target: NovelWorkbenchEditableTarget; readonly message: string }
  | NovelAssetEditorScreen

/** Parsed immutable manifest fields retained across a project-settings proposal. */
export interface ProjectManifestEditorSource extends NovelProjectSettingsDraft {
  readonly formatVersion: 1
  readonly kind: 'harness-novel-project'
  readonly projectId: NovelProjectId
  readonly plannedChapters: string
  readonly targetWordsPerChapter: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface CharacterRelationship {
  readonly characterId: string
  readonly type: string
  readonly summary: string
}

function objectWithKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}格式无效`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`${label}字段无效`)
  return record
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}不能为空`)
  return value
}

function plainString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  return value
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`)
  return parsed
}

function parseCanonicalDate(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) throw new Error(`${label}格式无效`)
  return text
}

function validateProjectDraft(draft: NovelProjectSettingsDraft) {
  const fields = {
    title: draft.title.trim(),
    language: draft.language.trim(),
    genre: draft.genre.trim(),
    plannedChapters: positiveInteger(draft.plannedChapters, '计划章数'),
    targetWordsPerChapter: positiveInteger(draft.targetWordsPerChapter, '每章目标字数'),
    creativeStrategy: draft.creativeStrategy,
  }
  if (fields.title === '') throw new Error('小说标题不能为空')
  if (fields.language === '') throw new Error('语言不能为空')
  if (fields.genre === '') throw new Error('类型不能为空')
  return fields
}

/**
 * Parse one authoritative manifest into immutable identity plus editable settings.
 *
 * @param text Canonical JSON bytes returned by the Host exact-read endpoint.
 * @returns Strict manifest fields used to preserve identity during replacement.
 * @throws {Error} When durable JSON, exact fields, ids, settings, or timestamps are invalid.
 */
export function parseProjectManifest(text: string): ProjectManifestEditorSource {
  const record = objectWithKeys(JSON.parse(text), [
    'formatVersion', 'kind', 'projectId', 'title', 'language', 'genre', 'plannedChapters',
    'targetWordsPerChapter', 'creativeStrategy', 'createdAt', 'updatedAt',
  ], '项目设置')
  if (record.formatVersion !== 1 || record.kind !== 'harness-novel-project') throw new Error('项目格式不受支持')
  const projectId = nonEmptyString(record.projectId, '项目 ID')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error('项目 ID 格式无效')
  }
  const strategies: readonly CreativeStrategy[] = [
    'auto', 'fluent-drafting', 'consistency-first', 'deep-planning',
  ]
  if (!strategies.includes(record.creativeStrategy as CreativeStrategy)) throw new Error('创作策略不受支持')
  const plannedChapters = positiveInteger(String(record.plannedChapters), '计划章数')
  const targetWordsPerChapter = positiveInteger(String(record.targetWordsPerChapter), '每章目标字数')
  return {
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId: projectId as NovelProjectId,
    title: nonEmptyString(record.title, '小说标题'),
    language: nonEmptyString(record.language, '语言'),
    genre: nonEmptyString(record.genre, '类型'),
    plannedChapters: String(plannedChapters),
    targetWordsPerChapter: String(targetWordsPerChapter),
    creativeStrategy: record.creativeStrategy as CreativeStrategy,
    createdAt: parseCanonicalDate(record.createdAt, '创建时间'),
    updatedAt: parseCanonicalDate(record.updatedAt, '更新时间'),
  }
}

/** @param source Parsed manifest source. @returns Its user-editable settings projection. */
export function projectDraft(source: ProjectManifestEditorSource): NovelProjectSettingsDraft {
  return {
    title: source.title,
    language: source.language,
    genre: source.genre,
    plannedChapters: source.plannedChapters,
    targetWordsPerChapter: source.targetWordsPerChapter,
    creativeStrategy: source.creativeStrategy,
  }
}

/**
 * Render project settings as the exact canonical replacement while preserving identity.
 *
 * @param source Parsed immutable manifest source.
 * @param draft User-edited settings.
 * @param updatedAt Canonical timestamp generated when the proposal is previewed.
 * @returns Strict two-space JSON with one trailing LF.
 * @throws {Error} When edited settings or the timestamp are invalid.
 */
export function serializeProject(
  source: ProjectManifestEditorSource,
  draft: NovelProjectSettingsDraft,
  updatedAt: string,
): string {
  const validated = validateProjectDraft(draft)
  return `${JSON.stringify({
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId: source.projectId,
    title: validated.title,
    language: validated.language,
    genre: validated.genre,
    plannedChapters: validated.plannedChapters,
    targetWordsPerChapter: validated.targetWordsPerChapter,
    creativeStrategy: validated.creativeStrategy,
    createdAt: source.createdAt,
    updatedAt: parseCanonicalDate(updatedAt, '更新时间'),
  }, null, 2)}\n`
}

function parseRelationships(value: unknown, label: string): CharacterRelationship[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是列表`)
  return value.map((item, index) => {
    const record = objectWithKeys(item, ['characterId', 'type', 'summary'], `${label}第 ${index + 1} 项`)
    return {
      characterId: nonEmptyString(record.characterId, '关联人物 ID'),
      type: nonEmptyString(record.type, '关系类型'),
      summary: nonEmptyString(record.summary, '关系说明'),
    }
  })
}

function relationshipsText(relationships: readonly CharacterRelationship[]): string {
  return relationships.map(item => `${item.characterId} | ${item.type} | ${item.summary}`).join('\n')
}

function relationshipsFromText(text: string): CharacterRelationship[] {
  if (text.trim() === '') return []
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    const parts = line.split('|').map(part => part.trim())
    if (parts.length !== 3 || parts.some(part => part === '')) throw new Error(`人物关系第 ${index + 1} 行格式无效`)
    return { characterId: parts[0]!, type: parts[1]!, summary: parts[2]! }
  })
}

/**
 * Parse the authoritative complete characters asset into editable records.
 *
 * @param text Canonical JSON, or empty text for an absent asset.
 * @param revision Authoritative exact-read revision.
 * @returns Ordered character drafts with relationships represented one per line.
 * @throws {Error} When durable content violates the strict character schema.
 */
export function parseCharacters(text: string, revision: Revision): NovelCharacterDraft[] {
  if (revision === 'absent' && text === '') return []
  const record = objectWithKeys(JSON.parse(text), ['characters'], '人物设定')
  if (!Array.isArray(record.characters)) throw new Error('人物设定必须是列表')
  const ids = new Set<string>()
  return record.characters.map((item, index) => {
    const character = objectWithKeys(
      item,
      ['id', 'name', 'role', 'summary', 'goal', 'relationships', 'notes'],
      `第 ${index + 1} 个人物`,
    )
    const id = nonEmptyString(character.id, '人物 ID')
    if (ids.has(id)) throw new Error(`人物 ID 重复：${id}`)
    ids.add(id)
    return {
      id,
      name: nonEmptyString(character.name, '人物姓名'),
      role: nonEmptyString(character.role, '人物角色'),
      summary: nonEmptyString(character.summary, '人物摘要'),
      goal: nonEmptyString(character.goal, '人物目标'),
      relationshipsText: relationshipsText(parseRelationships(character.relationships, '人物关系')),
      notes: plainString(character.notes, '人物备注'),
    }
  })
}

/**
 * Render every character draft as the canonical complete asset.
 *
 * @param characters Ordered character drafts.
 * @returns Strict two-space JSON with one trailing LF.
 * @throws {Error} When ids, required fields, or relationship lines are invalid.
 */
export function serializeCharacters(characters: readonly NovelCharacterDraft[]): string {
  const ids = new Set<string>()
  const canonical = characters.map((character, index) => {
    const id = nonEmptyString(character.id, `第 ${index + 1} 个人物 ID`).trim()
    if (ids.has(id)) throw new Error(`人物 ID 重复：${id}`)
    ids.add(id)
    return {
      id,
      name: nonEmptyString(character.name, '人物姓名').trim(),
      role: nonEmptyString(character.role, '人物角色').trim(),
      summary: nonEmptyString(character.summary, '人物摘要').trim(),
      goal: nonEmptyString(character.goal, '人物目标').trim(),
      relationships: relationshipsFromText(character.relationshipsText),
      notes: character.notes,
    }
  })
  return `${JSON.stringify({ characters: canonical }, null, 2)}\n`
}

function linesFromText(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/**
 * Parse one authoritative story blueprint, including the explicit absent asset.
 *
 * @param text Canonical JSON, or empty text for an absent asset.
 * @param revision Authoritative exact-read revision.
 * @returns Editable blueprint fields with one theme per line.
 * @throws {Error} When durable content violates the strict story schema.
 */
export function parseStoryBlueprint(text: string, revision: Revision): NovelStoryBlueprintDraft {
  if (revision === 'absent' && text === '') {
    return { premise: '', themesText: '', world: '', mainPlot: '', endingGoal: '' }
  }
  const record = objectWithKeys(
    JSON.parse(text),
    ['premise', 'themes', 'world', 'mainPlot', 'endingGoal'],
    '故事蓝图',
  )
  if (!Array.isArray(record.themes) || record.themes.some(theme => typeof theme !== 'string')) {
    throw new Error('主题必须是文本列表')
  }
  return {
    premise: nonEmptyString(record.premise, '故事前提'),
    themesText: record.themes.join('\n'),
    world: nonEmptyString(record.world, '世界设定'),
    mainPlot: nonEmptyString(record.mainPlot, '主线'),
    endingGoal: nonEmptyString(record.endingGoal, '结局目标'),
  }
}

/**
 * Render a story blueprint as the canonical complete asset.
 *
 * @param draft Edited story fields.
 * @returns Strict two-space JSON with one trailing LF.
 * @throws {Error} When required fields are empty.
 */
export function serializeStoryBlueprint(draft: NovelStoryBlueprintDraft): string {
  return `${JSON.stringify({
    premise: nonEmptyString(draft.premise.trim(), '故事前提'),
    themes: linesFromText(draft.themesText),
    world: nonEmptyString(draft.world.trim(), '世界设定'),
    mainPlot: nonEmptyString(draft.mainPlot.trim(), '主线'),
    endingGoal: nonEmptyString(draft.endingGoal.trim(), '结局目标'),
  }, null, 2)}\n`
}

/**
 * Parse one authoritative chapter blueprint, including the explicit absent asset.
 *
 * @param text Canonical JSON, or empty text for an absent asset.
 * @param revision Authoritative exact-read revision.
 * @param chapter Chapter number encoded by the asset reference.
 * @returns Editable chapter fields with arrays represented one item per line.
 * @throws {Error} When durable content violates the strict chapter schema.
 */
export function parseChapterBlueprint(
  text: string,
  revision: Revision,
  chapter: number,
): NovelChapterBlueprintDraft {
  if (revision === 'absent' && text === '') {
    return {
      title: '', purpose: '', beatsText: '', characterIdsText: '', continuityNotesText: '', status: 'planned',
    }
  }
  const record = objectWithKeys(JSON.parse(text), [
    'chapter', 'title', 'purpose', 'beats', 'characterIds', 'continuityNotes', 'status',
  ], '章节蓝图')
  if (record.chapter !== chapter) throw new Error('章节蓝图编号与目标不一致')
  for (const [value, label] of [
    [record.beats, '情节节拍'],
    [record.characterIds, '人物引用'],
    [record.continuityNotes, '连续性备注'],
  ] as const) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label}必须是文本列表`)
  }
  const statuses: readonly NovelChapterStatus[] = ['planned', 'drafting', 'drafted', 'revised', 'final']
  if (!statuses.includes(record.status as NovelChapterStatus)) throw new Error('章节状态不受支持')
  return {
    title: nonEmptyString(record.title, '章节标题'),
    purpose: nonEmptyString(record.purpose, '章节目的'),
    beatsText: (record.beats as string[]).join('\n'),
    characterIdsText: (record.characterIds as string[]).join('\n'),
    continuityNotesText: (record.continuityNotes as string[]).join('\n'),
    status: record.status as NovelChapterStatus,
  }
}

/**
 * Render one chapter blueprint as the canonical complete asset.
 *
 * @param chapter Chapter number fixed by the asset reference.
 * @param draft Edited planning fields.
 * @returns Strict two-space JSON with one trailing LF.
 * @throws {Error} When the chapter or required fields are invalid.
 */
export function serializeChapterBlueprint(chapter: number, draft: NovelChapterBlueprintDraft): string {
  if (!Number.isSafeInteger(chapter) || chapter <= 0) throw new Error('章节编号无效')
  return `${JSON.stringify({
    chapter,
    title: nonEmptyString(draft.title.trim(), '章节标题'),
    purpose: nonEmptyString(draft.purpose.trim(), '章节目的'),
    beats: linesFromText(draft.beatsText),
    characterIds: linesFromText(draft.characterIdsText),
    continuityNotes: linesFromText(draft.continuityNotesText),
    status: draft.status,
  }, null, 2)}\n`
}

/** @param text Edited Markdown. @returns Markdown with canonical LF newlines. */
export function serializeChapterDraft(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Serialize the exact shallow Agent tool arguments for one replacement proposal.
 *
 * @param target Recognized editable asset.
 * @param baseRevision Revision read before editing.
 * @param baseText Exact original normalized text.
 * @param replacement Exact canonical replacement text.
 * @param summary User-visible modification summary.
 * @returns Deterministic model prompt using the Agent tool's `targetKind` field.
 * @throws {Error} When the summary is empty.
 */
export function assetProposalPrompt(
  target: NovelWorkbenchEditableTarget,
  baseRevision: Revision,
  baseText: string,
  replacement: string,
  summary: string,
): string {
  const json = JSON.stringify({
    kind: 'replace',
    targetKind: target.kind,
    ...('chapter' in target ? { chapter: target.chapter } : {}),
    baseRevision,
    baseText,
    replacement,
    summary: nonEmptyString(summary, '修改摘要').trim(),
  }, null, 2)
  return `请提交以下单资产小说修改。\n\n先调用 novel_read 重新读取目标资产并核对 revision。然后仅调用一次 novel_apply_change，并把以下 JSON 对象作为浅层参数原样传入；不要嵌套 request，不要改写任何值：\n\n${json}\n\n这只是提案。必须等待 Harness 原生审批，并且只有收到 CommitReceipt 后才能声明保存成功。`
}

/** @param left First complete character draft list. @param right Second list. @returns Whether ordered fields match exactly. */
export function sameCharacters(left: readonly NovelCharacterDraft[], right: readonly NovelCharacterDraft[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Filter character ids for the compact list without changing the complete asset.
 *
 * @param characters Complete ordered drafts.
 * @param search Case-insensitive id, name, role, summary, or goal query.
 * @returns Matching ids in durable order.
 */
export function visibleCharacterIds(characters: readonly NovelCharacterDraft[], search: string): string[] {
  const query = search.trim().toLocaleLowerCase()
  if (query === '') return characters.map(character => character.id)
  return characters.filter(character => [
    character.id, character.name, character.role, character.summary, character.goal,
  ].some(value => value.toLocaleLowerCase().includes(query))).map(character => character.id)
}
