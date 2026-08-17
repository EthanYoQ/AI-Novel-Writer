/** Browser-safe read model for the read-only novel context window. */

import type { AssetRef, CreativeStrategy, NovelProjectId, Revision } from './types.ts'

/** Exact path-free asset bytes returned to the browser editor. */
export interface NovelAssetReadWireResult {
  readonly target: AssetRef
  readonly revision: Revision
  readonly text: string
  readonly bytes: number
}

/** Project identity and writing settings shown by the context window. */
export interface NovelContextProject {
  readonly projectId: NovelProjectId
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: CreativeStrategy
  readonly updatedAt: string
}

/** One character summary suitable for the bounded context window. */
export interface NovelContextCharacter {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly summary: string
}

/** Story blueprint fields shown without an editing surface. */
export interface NovelContextStoryBlueprint {
  readonly premise: string
  readonly themes: readonly string[]
  readonly world: string
  readonly mainPlot: string
  readonly endingGoal: string
}

/** Selected chapter blueprint fields shown without an editing surface. */
export interface NovelContextChapterBlueprint {
  readonly chapter: number
  readonly title: string
  readonly purpose: string
  readonly beats: readonly string[]
  readonly characterIds: readonly string[]
  readonly continuityNotes: readonly string[]
  readonly status: 'planned' | 'drafting' | 'drafted' | 'revised' | 'final'
}

/** Bounded selected-chapter prose preview. */
export interface NovelContextDraft {
  readonly revision: Revision
  readonly preview: string
  readonly bytes: number
  readonly truncated: boolean
}

/** Complete initialized-project response from the loopback Host endpoint. */
export interface NovelContextReady {
  readonly status: 'ready'
  readonly project: NovelContextProject
  readonly progress: {
    readonly selectedChapter: number
    readonly plannedChapters: number
    readonly status: NovelContextChapterBlueprint['status'] | 'unplanned'
    readonly draftPresent: boolean
    readonly draftBytes: number
  }
  readonly characters: readonly NovelContextCharacter[]
  readonly storyBlueprint: NovelContextStoryBlueprint | null
  readonly chapterBlueprint: NovelContextChapterBlueprint | null
  readonly draft: NovelContextDraft | null
  readonly omittedSources: readonly string[]
}

/** Host response when the selected Workspace has no Harness novel project. */
export interface NovelContextNotInitialized {
  readonly status: 'not-initialized'
}

/** Every successful context-read response. */
export type NovelContextReadResult = NovelContextReady | NovelContextNotInitialized

function recordOf(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) throw invalidResponse()
  return record
}

function invalidResponse(): Error {
  return new Error('AI novel context response is invalid')
}

function stringOf(value: unknown): string {
  if (typeof value !== 'string') throw invalidResponse()
  return value
}

function integerOf(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw invalidResponse()
  return value as number
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw invalidResponse()
  return value
}

function revisionOf(value: unknown): Revision {
  if (value !== 'absent' && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw invalidResponse()
  return value as Revision
}

/**
 * Validate one untrusted discriminated asset reference at a wire boundary.
 *
 * @param value Unknown target received from Host RPC or browser transport.
 * @returns One recognized project-owned asset reference with no path fields.
 * @throws {Error} When the discriminant, chapter, or exact property set is invalid.
 */
export function parseNovelAssetRef(value: unknown): AssetRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const kind = (value as Record<string, unknown>).kind
  switch (kind) {
    case 'project':
    case 'characters':
    case 'story-blueprint': {
      recordOf(value, ['kind'])
      return { kind }
    }
    case 'chapter-blueprint':
    case 'chapter-draft': {
      const target = recordOf(value, ['kind', 'chapter'])
      return { kind, chapter: integerOf(target.chapter, 1) }
    }
    default: throw invalidResponse()
  }
}

/**
 * Validate one path-free exact asset response before it enters editable browser state.
 *
 * @param value Unknown response value from the generic Connection RPC client.
 * @returns Exact normalized text, revision, byte count, and recognized target.
 * @throws {Error} When any field or exact property set is invalid.
 */
export function parseNovelAssetReadResult(value: unknown): NovelAssetReadWireResult {
  const record = recordOf(value, ['target', 'revision', 'text', 'bytes'])
  const text = stringOf(record.text)
  const bytes = integerOf(record.bytes)
  if (new TextEncoder().encode(text).byteLength !== bytes) throw invalidResponse()
  return {
    target: parseNovelAssetRef(record.target),
    revision: revisionOf(record.revision),
    text,
    bytes,
  }
}

/**
 * Validate one untrusted loopback RPC value before it enters browser state.
 *
 * @param value Unknown response value from the generic Connection RPC client.
 * @returns A strict read-only novel context result with no path-bearing fields.
 * @throws {Error} When any required field, value, or exact property set is invalid.
 */
export function parseNovelContextReadResult(value: unknown): NovelContextReadResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const status = (value as Record<string, unknown>).status
  if (status === 'not-initialized') {
    recordOf(value, ['status'])
    return { status }
  }
  if (status !== 'ready') throw invalidResponse()
  const root = recordOf(value, [
    'status', 'project', 'progress', 'characters', 'storyBlueprint',
    'chapterBlueprint', 'draft', 'omittedSources',
  ])
  const project = recordOf(root.project, [
    'projectId', 'title', 'language', 'genre', 'plannedChapters', 'targetWordsPerChapter',
    'creativeStrategy', 'updatedAt',
  ])
  const strategies: readonly CreativeStrategy[] = [
    'auto', 'fluent-drafting', 'consistency-first', 'deep-planning',
  ]
  if (!strategies.includes(project.creativeStrategy as CreativeStrategy)) throw invalidResponse()
  const progress = recordOf(root.progress, [
    'selectedChapter', 'plannedChapters', 'status', 'draftPresent', 'draftBytes',
  ])
  const statuses: readonly NovelContextReady['progress']['status'][] = [
    'unplanned', 'planned', 'drafting', 'drafted', 'revised', 'final',
  ]
  if (!statuses.includes(progress.status as NovelContextReady['progress']['status'])) throw invalidResponse()
  if (typeof progress.draftPresent !== 'boolean') throw invalidResponse()
  if (!Array.isArray(root.characters)) throw invalidResponse()
  const characters = root.characters.map(value => {
    const character = recordOf(value, ['id', 'name', 'role', 'summary'])
    return {
      id: stringOf(character.id),
      name: stringOf(character.name),
      role: stringOf(character.role),
      summary: stringOf(character.summary),
    }
  })
  const storyBlueprint = root.storyBlueprint === null ? null : (() => {
    const story = recordOf(root.storyBlueprint, ['premise', 'themes', 'world', 'mainPlot', 'endingGoal'])
    return {
      premise: stringOf(story.premise),
      themes: stringsOf(story.themes),
      world: stringOf(story.world),
      mainPlot: stringOf(story.mainPlot),
      endingGoal: stringOf(story.endingGoal),
    }
  })()
  const chapterBlueprint = root.chapterBlueprint === null ? null : (() => {
    const chapter = recordOf(root.chapterBlueprint, [
      'chapter', 'title', 'purpose', 'beats', 'characterIds', 'continuityNotes', 'status',
    ])
    if (!statuses.slice(1).includes(chapter.status as NovelContextChapterBlueprint['status'])) throw invalidResponse()
    return {
      chapter: integerOf(chapter.chapter, 1),
      title: stringOf(chapter.title),
      purpose: stringOf(chapter.purpose),
      beats: stringsOf(chapter.beats),
      characterIds: stringsOf(chapter.characterIds),
      continuityNotes: stringsOf(chapter.continuityNotes),
      status: chapter.status as NovelContextChapterBlueprint['status'],
    }
  })()
  const draft = root.draft === null ? null : (() => {
    const value = recordOf(root.draft, ['revision', 'preview', 'bytes', 'truncated'])
    if (typeof value.truncated !== 'boolean') throw invalidResponse()
    return {
      revision: revisionOf(value.revision),
      preview: stringOf(value.preview),
      bytes: integerOf(value.bytes),
      truncated: value.truncated,
    }
  })()
  const parsedProject = {
    projectId: stringOf(project.projectId) as NovelProjectId,
    title: stringOf(project.title),
    language: stringOf(project.language),
    genre: stringOf(project.genre),
    plannedChapters: integerOf(project.plannedChapters, 1),
    targetWordsPerChapter: integerOf(project.targetWordsPerChapter, 1),
    creativeStrategy: project.creativeStrategy as CreativeStrategy,
    updatedAt: stringOf(project.updatedAt),
  }
  const updatedAtMilliseconds = Date.parse(parsedProject.updatedAt)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsedProject.projectId)
    || !Number.isFinite(updatedAtMilliseconds)
    || new Date(updatedAtMilliseconds).toISOString() !== parsedProject.updatedAt) throw invalidResponse()
  const parsedProgress = {
    selectedChapter: integerOf(progress.selectedChapter, 1),
    plannedChapters: integerOf(progress.plannedChapters, 1),
    status: progress.status as NovelContextReady['progress']['status'],
    draftPresent: progress.draftPresent,
    draftBytes: integerOf(progress.draftBytes),
  }
  if (parsedProgress.plannedChapters !== parsedProject.plannedChapters
    || parsedProgress.selectedChapter > parsedProject.plannedChapters
    || (chapterBlueprint !== null && chapterBlueprint.chapter !== parsedProgress.selectedChapter)
    || parsedProgress.draftPresent !== (draft !== null)
    || parsedProgress.draftBytes !== (draft?.bytes ?? 0)
    || draft?.revision === 'absent') throw invalidResponse()
  return {
    status,
    project: parsedProject,
    progress: parsedProgress,
    characters,
    storyBlueprint,
    chapterBlueprint,
    draft,
    omittedSources: stringsOf(root.omittedSources),
  }
}
