/** Host-side projection for the read-only novel context window. */

import { openNovelProject } from './novel-project.ts'
import type {
  NovelContextChapterBlueprint,
  NovelContextCharacter,
  NovelContextReadResult,
  NovelContextStoryBlueprint,
} from './context-types.ts'
import type { CreativeStrategy, NovelAssetReadResult, NovelProjectId } from './types.ts'
import { NovelProjectError } from './types.ts'

function parseObject(asset: NovelAssetReadResult): Record<string, unknown> | undefined {
  if (asset.revision === 'absent' || asset.truncated) return undefined
  return JSON.parse(asset.text) as Record<string, unknown>
}

function charactersOf(asset: NovelAssetReadResult | undefined): readonly NovelContextCharacter[] {
  if (asset === undefined) return []
  const value = parseObject(asset)
  if (value === undefined) return []
  return (value.characters as Array<Record<string, unknown>>).map(character => ({
    id: character.id as string,
    name: character.name as string,
    role: character.role as string,
    summary: character.summary as string,
  }))
}

function storyOf(asset: NovelAssetReadResult | undefined): NovelContextStoryBlueprint | null {
  if (asset === undefined) return null
  const value = parseObject(asset)
  if (value === undefined) return null
  return {
    premise: value.premise as string,
    themes: value.themes as string[],
    world: value.world as string,
    mainPlot: value.mainPlot as string,
    endingGoal: value.endingGoal as string,
  }
}

function chapterOf(asset: NovelAssetReadResult | undefined): NovelContextChapterBlueprint | null {
  if (asset === undefined) return null
  const value = parseObject(asset)
  if (value === undefined) return null
  return {
    chapter: value.chapter as number,
    title: value.title as string,
    purpose: value.purpose as string,
    beats: value.beats as string[],
    characterIds: value.characterIds as string[],
    continuityNotes: value.continuityNotes as string[],
    status: value.status as NovelContextChapterBlueprint['status'],
  }
}

/**
 * Read one Workspace's bounded, non-mutating novel context projection.
 *
 * @param root Canonical Workspace directory resolved by the Host registry.
 * @param chapter Selected one-based chapter number.
 * @param signal Cancellation signal propagated through every project read.
 * @returns An initialized projection or an explicit not-initialized result.
 * @throws {@link NovelProjectError} when the project is invalid, unsafe, over budget, cancelled, or the chapter is outside the plan.
 */
export async function readNovelContext(
  root: string,
  chapter: number,
  signal: AbortSignal,
): Promise<NovelContextReadResult> {
  const project = openNovelProject(root)
  let manifestAsset: NovelAssetReadResult
  try {
    const result = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)
    if (result.kind !== 'asset') throw new Error('NovelProject returned a non-asset manifest result')
    manifestAsset = result
  } catch (error) {
    if (error instanceof NovelProjectError && error.code === 'NOT_INITIALIZED') {
      return { status: 'not-initialized' }
    }
    throw error
  }
  const manifest = JSON.parse(manifestAsset.text) as Record<string, unknown>
  const plannedChapters = manifest.plannedChapters as number
  if (!Number.isSafeInteger(chapter) || chapter <= 0 || chapter > plannedChapters) {
    throw new NovelProjectError('INVALID_CONTENT', `chapter must be between 1 and ${plannedChapters}`)
  }
  const result = await project.read({ kind: 'working-set', chapter }, signal)
  if (result.kind !== 'working-set') throw new Error('NovelProject returned a non-working-set context result')
  const bySource = new Map(result.assets.map(asset => [asset.source, asset]))
  const charactersAsset = bySource.get('.ai-novel/characters.json')
  const storyAsset = bySource.get('.ai-novel/blueprints/story.json')
  const chapterName = String(chapter).padStart(4, '0')
  const chapterAsset = bySource.get(`.ai-novel/blueprints/chapters/${chapterName}.json`)
  const draftAsset = bySource.get(`chapters/${chapterName}.md`)
  const chapterBlueprint = chapterOf(chapterAsset)
  const draftPresent = draftAsset !== undefined && draftAsset.revision !== 'absent'
  const omittedSources = [...new Set([
    ...result.omittedSources,
    ...result.assets.filter(asset => asset.truncated).map(asset => asset.source),
  ])]
  return {
    status: 'ready',
    project: {
      projectId: manifest.projectId as NovelProjectId,
      title: manifest.title as string,
      language: manifest.language as string,
      genre: manifest.genre as string,
      plannedChapters,
      targetWordsPerChapter: manifest.targetWordsPerChapter as number,
      creativeStrategy: manifest.creativeStrategy as CreativeStrategy,
      updatedAt: manifest.updatedAt as string,
    },
    progress: {
      selectedChapter: chapter,
      plannedChapters,
      status: chapterBlueprint?.status ?? 'unplanned',
      draftPresent,
      draftBytes: draftPresent ? draftAsset.bytes : 0,
    },
    characters: charactersOf(charactersAsset),
    storyBlueprint: storyOf(storyAsset),
    chapterBlueprint,
    draft: draftPresent
      ? {
          revision: draftAsset.revision,
          preview: draftAsset.text,
          bytes: draftAsset.bytes,
          truncated: draftAsset.truncated,
        }
      : null,
    omittedSources,
  }
}
