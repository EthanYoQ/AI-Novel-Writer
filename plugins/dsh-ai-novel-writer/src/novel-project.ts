import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type {
  AssetRef,
  CommitReceipt,
  CreativeStrategy,
  NovelApplyRequest,
  NovelAssetReadResult,
  NovelInitializeRequest,
  NovelProject,
  NovelProjectId,
  NovelReadRequest,
  NovelReadResult,
  Revision,
} from './types.ts'
import { NovelProjectError } from './types.ts'

const PROJECT_DIR = '.ai-novel'
const MANIFEST_PATH = '.ai-novel/project.json'
const FORMAT_VERSION = 1
const PROJECT_KIND = 'harness-novel-project'
const DEFAULT_ASSET_LIMIT = 512 * 1024
const DEFAULT_WORKING_SET_LIMIT = 512 * 1024
const DEFAULT_QUERY_LIMIT = 20

/** Deployment-varying bounds for one filesystem-backed project. */
export interface NovelProjectOptions {
  readonly assetBytes?: number
  readonly workingSetBytes?: number
  readonly queryMatches?: number
}

interface ProjectManifest {
  readonly formatVersion: 1
  readonly kind: 'harness-novel-project'
  readonly projectId: NovelProjectId
  readonly title: string
  readonly language: string
  readonly genre: string
  readonly plannedChapters: number
  readonly targetWordsPerChapter: number
  readonly creativeStrategy: CreativeStrategy
  readonly createdAt: string
  readonly updatedAt: string
}

/** Convert text to the canonical on-disk newline form. */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** Return the revision of exactly the UTF-8 bytes written to disk. */
function revisionOf(text: string): Revision {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex') as Revision
}

/** Serialize a JSON asset with stable indentation and one trailing newline. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new NovelProjectError('CANCELLED', 'novel project operation was cancelled')
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NovelProjectError('INVALID_CONTENT', `${field} must be a non-empty string`)
  }
}

function requirePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new NovelProjectError('INVALID_CONTENT', `${field} must be a positive integer`)
  }
}

function requireIsoTimestamp(value: unknown, field: string): asserts value is string {
  requireNonEmpty(value, field)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new NovelProjectError('INVALID_CONTENT', `${field} must be a canonical ISO-8601 timestamp`)
  }
}

function requireCreativeStrategy(value: unknown): asserts value is CreativeStrategy {
  const strategies: readonly CreativeStrategy[] = [
    'auto', 'fluent-drafting', 'consistency-first', 'deep-planning',
  ]
  if (!strategies.includes(value as CreativeStrategy)) {
    throw new NovelProjectError('INVALID_CONTENT', 'creativeStrategy is not supported')
  }
}

function requireLimit(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NovelProjectError('INVALID_CONTENT', `${field} must be a positive integer`)
  }
}

function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  let end = limit
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function parseManifest(text: string): ProjectManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new NovelProjectError('INVALID_CONTENT', 'project manifest is not valid JSON', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelProjectError('INVALID_CONTENT', 'project manifest must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const exactKeys = [
    'formatVersion', 'kind', 'projectId', 'title', 'language', 'genre', 'plannedChapters',
    'targetWordsPerChapter', 'creativeStrategy', 'createdAt', 'updatedAt',
  ]
  if (Object.keys(record).sort().join('\0') !== [...exactKeys].sort().join('\0')) {
    throw new NovelProjectError('INVALID_CONTENT', 'project manifest contains missing or unknown fields')
  }
  if (record.formatVersion !== FORMAT_VERSION || record.kind !== PROJECT_KIND) {
    throw new NovelProjectError('UNSUPPORTED_FORMAT', 'project manifest format is not supported')
  }
  requireNonEmpty(record.projectId, 'projectId')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.projectId)) {
    throw new NovelProjectError('INVALID_CONTENT', 'projectId must be a UUID')
  }
  requireNonEmpty(record.title, 'title')
  requireNonEmpty(record.language, 'language')
  requireNonEmpty(record.genre, 'genre')
  requirePositiveInteger(record.plannedChapters, 'plannedChapters')
  requirePositiveInteger(record.targetWordsPerChapter, 'targetWordsPerChapter')
  requireCreativeStrategy(record.creativeStrategy)
  requireIsoTimestamp(record.createdAt, 'createdAt')
  requireIsoTimestamp(record.updatedAt, 'updatedAt')
  return {
    formatVersion: FORMAT_VERSION,
    kind: PROJECT_KIND,
    projectId: record.projectId as NovelProjectId,
    title: record.title,
    language: record.language,
    genre: record.genre,
    plannedChapters: record.plannedChapters,
    targetWordsPerChapter: record.targetWordsPerChapter,
    creativeStrategy: record.creativeStrategy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new NovelProjectError('INVALID_CONTENT', `${label} is not valid JSON`, { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NovelProjectError('INVALID_CONTENT', `${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new NovelProjectError('INVALID_CONTENT', `${label} contains missing or unknown fields`)
  }
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new NovelProjectError('INVALID_CONTENT', `${field} must be an array of strings`)
  }
}

function canonicalCharacters(record: Record<string, unknown>): Record<string, unknown> {
  requireExactKeys(record, ['characters'], 'characters asset')
  if (!Array.isArray(record.characters)) {
    throw new NovelProjectError('INVALID_CONTENT', 'characters must be an array')
  }
  const ids = new Set<string>()
  const characters: Record<string, unknown>[] = []
  for (const [index, value] of record.characters.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new NovelProjectError('INVALID_CONTENT', `characters[${index}] must be an object`)
    }
    const character = value as Record<string, unknown>
    requireExactKeys(character, ['id', 'name', 'role', 'summary', 'goal', 'relationships', 'notes'], `characters[${index}]`)
    for (const field of ['id', 'name', 'role', 'summary', 'goal'] as const) requireNonEmpty(character[field], `characters[${index}].${field}`)
    if (ids.has(character.id as string)) throw new NovelProjectError('INVALID_CONTENT', `duplicate character id: ${character.id as string}`)
    ids.add(character.id as string)
    if (!Array.isArray(character.relationships)) {
      throw new NovelProjectError('INVALID_CONTENT', `characters[${index}].relationships must be an array`)
    }
    for (const [relationIndex, relation] of character.relationships.entries()) {
      if (typeof relation !== 'object' || relation === null || Array.isArray(relation)) {
        throw new NovelProjectError('INVALID_CONTENT', `relationship ${relationIndex} must be an object`)
      }
      const fields = relation as Record<string, unknown>
      requireExactKeys(fields, ['characterId', 'type', 'summary'], `relationship ${relationIndex}`)
      requireNonEmpty(fields.characterId, 'relationship.characterId')
      requireNonEmpty(fields.type, 'relationship.type')
      requireNonEmpty(fields.summary, 'relationship.summary')
    }
    if (typeof character.notes !== 'string') {
      throw new NovelProjectError('INVALID_CONTENT', `characters[${index}].notes must be a string`)
    }
    characters.push({
      id: character.id,
      name: character.name,
      role: character.role,
      summary: character.summary,
      goal: character.goal,
      relationships: character.relationships.map(relation => {
        const fields = relation as Record<string, unknown>
        return { characterId: fields.characterId, type: fields.type, summary: fields.summary }
      }),
      notes: character.notes,
    })
  }
  return { characters }
}

function canonicalStoryBlueprint(record: Record<string, unknown>): Record<string, unknown> {
  requireExactKeys(record, ['premise', 'themes', 'world', 'mainPlot', 'endingGoal'], 'story blueprint')
  requireNonEmpty(record.premise, 'premise')
  requireStringArray(record.themes, 'themes')
  requireNonEmpty(record.world, 'world')
  requireNonEmpty(record.mainPlot, 'mainPlot')
  requireNonEmpty(record.endingGoal, 'endingGoal')
  return {
    premise: record.premise,
    themes: record.themes,
    world: record.world,
    mainPlot: record.mainPlot,
    endingGoal: record.endingGoal,
  }
}

function canonicalChapterBlueprint(record: Record<string, unknown>, expectedChapter: number): Record<string, unknown> {
  requireExactKeys(
    record,
    ['chapter', 'title', 'purpose', 'beats', 'characterIds', 'continuityNotes', 'status'],
    'chapter blueprint',
  )
  requirePositiveInteger(record.chapter, 'chapter')
  if (record.chapter !== expectedChapter) {
    throw new NovelProjectError('INVALID_CONTENT', 'chapter blueprint number does not match its target')
  }
  requireNonEmpty(record.title, 'title')
  requireNonEmpty(record.purpose, 'purpose')
  requireStringArray(record.beats, 'beats')
  requireStringArray(record.characterIds, 'characterIds')
  requireStringArray(record.continuityNotes, 'continuityNotes')
  const statuses = ['planned', 'drafting', 'drafted', 'revised', 'final']
  if (typeof record.status !== 'string' || !statuses.includes(record.status)) {
    throw new NovelProjectError('INVALID_CONTENT', 'chapter blueprint status is not supported')
  }
  return {
    chapter: record.chapter,
    title: record.title,
    purpose: record.purpose,
    beats: record.beats,
    characterIds: record.characterIds,
    continuityNotes: record.continuityNotes,
    status: record.status,
  }
}

/**
 * Validate and render one replacement exactly as it would be stored.
 *
 * @param target Project-owned asset identity.
 * @param text Proposed UTF-8 text.
 * @returns Canonical LF text with schema-ordered JSON for structured assets.
 * @throws {@link NovelProjectError} when the proposed content is invalid.
 */
export function canonicalNovelAssetText(target: AssetRef, text: string): string {
  const normalized = normalizeText(text)
  if (target.kind === 'chapter-draft') return normalized
  const record = parseJsonObject(normalized, novelAssetSource(target))
  switch (target.kind) {
    case 'project': return stableJson(parseManifest(stableJson(record)))
    case 'characters': return stableJson(canonicalCharacters(record))
    case 'story-blueprint': return stableJson(canonicalStoryBlueprint(record))
    case 'chapter-blueprint': return stableJson(canonicalChapterBlueprint(record, target.chapter))
    default: return assertNever(target)
  }
}

/**
 * Validate and render an initialization request exactly as it will be stored.
 *
 * @param request Complete manifest identity and writing settings approved by the user.
 * @returns Canonical project-manifest bytes.
 * @throws {@link NovelProjectError} when any manifest field is invalid.
 */
export function canonicalNovelInitialization(request: NovelInitializeRequest): string {
  if (request.createdAt !== request.updatedAt) {
    throw new NovelProjectError('INVALID_CONTENT', 'createdAt and updatedAt must match during initialization')
  }
  return canonicalNovelAssetText({ kind: 'project' }, stableJson({
    formatVersion: FORMAT_VERSION,
    kind: PROJECT_KIND,
    projectId: request.projectId,
    title: request.title.trim(),
    language: request.language.trim(),
    genre: request.genre.trim(),
    plannedChapters: request.plannedChapters,
    targetWordsPerChapter: request.targetWordsPerChapter,
    creativeStrategy: request.creativeStrategy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  }))
}

function normalizeAssetContent(target: AssetRef, replacement: string, currentManifest: ProjectManifest): string {
  const canonical = canonicalNovelAssetText(target, replacement)
  if (target.kind !== 'project') return canonical
  const next = parseManifest(canonical)
  if (next.projectId !== currentManifest.projectId || next.createdAt !== currentManifest.createdAt) {
    throw new NovelProjectError('INVALID_CONTENT', 'project identity and createdAt are immutable')
  }
  if (next.title === currentManifest.title
    && next.language === currentManifest.language
    && next.genre === currentManifest.genre
    && next.plannedChapters === currentManifest.plannedChapters
    && next.targetWordsPerChapter === currentManifest.targetWordsPerChapter
    && next.creativeStrategy === currentManifest.creativeStrategy) {
    throw new NovelProjectError('INVALID_CONTENT', 'project settings replacement must change at least one visible field')
  }
  return canonical
}

function revisionMatches(current: NovelAssetReadResult, request: Extract<NovelApplyRequest, { kind: 'replace' }>): boolean {
  return current.revision === request.baseRevision
}

function validateAssetText(target: AssetRef, text: string): void {
  if (target.kind === 'chapter-draft') return
  if (target.kind === 'project') {
    parseManifest(text)
    return
  }
  const record = parseJsonObject(text, novelAssetSource(target))
  switch (target.kind) {
    case 'characters': canonicalCharacters(record); return
    case 'story-blueprint': canonicalStoryBlueprint(record); return
    case 'chapter-blueprint': canonicalChapterBlueprint(record, target.chapter); return
    default: assertNever(target)
  }
}

/**
 * Return the fixed project-relative path for one discriminated asset reference.
 *
 * @param target Project-owned asset identity.
 * @returns A normalized project-relative path that never contains caller-provided path segments.
 */
export function novelAssetSource(target: AssetRef): string {
  switch (target.kind) {
    case 'project': return MANIFEST_PATH
    case 'characters': return '.ai-novel/characters.json'
    case 'story-blueprint': return '.ai-novel/blueprints/story.json'
    case 'chapter-blueprint': return `.ai-novel/blueprints/chapters/${chapterName(target.chapter)}.json`
    case 'chapter-draft': return `chapters/${chapterName(target.chapter)}.md`
    default: return assertNever(target)
  }
}

function chapterName(chapter: number): string {
  if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 9_999) {
    throw new NovelProjectError('PATH_REJECTED', 'chapter must be an integer between 1 and 9999')
  }
  return chapter.toString().padStart(4, '0')
}

/** Filesystem implementation whose only mutation is an atomic single-asset commit. */
class FileNovelProject implements NovelProject {
  readonly #root: string
  readonly #assetLimit: number
  readonly #workingSetLimit: number
  readonly #queryLimit: number

  constructor(root: string, options: Required<NovelProjectOptions>) {
    if (!isAbsolute(root)) throw new NovelProjectError('PATH_REJECTED', 'workspace root must be absolute')
    this.#root = resolve(root)
    this.#assetLimit = options.assetBytes
    this.#workingSetLimit = options.workingSetBytes
    this.#queryLimit = options.queryMatches
  }

  async read(request: NovelReadRequest, signal: AbortSignal): Promise<NovelReadResult> {
    requireNotAborted(signal)
    await this.#requireCanonicalRoot()
    await this.#readManifest(signal)
    switch (request.kind) {
      case 'asset': return this.#readAsset(request.target, signal)
      case 'working-set': return this.#readWorkingSet(request.chapter, signal)
      case 'query': return this.#query(request.text, request.limit, signal)
      default: return assertNever(request)
    }
  }

  async apply(request: NovelApplyRequest, signal: AbortSignal): Promise<CommitReceipt> {
    requireNotAborted(signal)
    const root = await this.#requireCanonicalRoot()
    if (request.kind === 'replace') return this.#replace(root, request, signal)
    const text = canonicalNovelInitialization(request)
    const manifest = parseManifest(text)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#assetLimit) {
      throw new NovelProjectError('SIZE_LIMIT_EXCEEDED', `asset exceeds ${this.#assetLimit} bytes`)
    }
    const projectDir = join(root, PROJECT_DIR)
    await this.#rejectSymlinkChain(projectDir)
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    await this.#rejectSymlinkChain(projectDir)
    const filename = join(root, MANIFEST_PATH)

    return withFileLock(filename, async () => {
      requireNotAborted(signal)
      if (await this.#exists(filename)) {
        throw new NovelProjectError('ALREADY_INITIALIZED', 'novel project is already initialized')
      }
      requireNotAborted(signal)
      try {
        await writeFileAtomic(filename, text, { mode: 0o600, dirMode: 0o700 })
      } catch (cause) {
        throw new NovelProjectError('WRITE_FAILED', 'failed to initialize novel project', { cause })
      }
      return {
        projectId: manifest.projectId,
        target: { kind: 'project' },
        oldRevision: 'absent',
        newRevision: revisionOf(text),
        bytes,
      }
    })
  }

  async #replace(
    root: string,
    request: Extract<NovelApplyRequest, { kind: 'replace' }>,
    signal: AbortSignal,
  ): Promise<CommitReceipt> {
    requireNonEmpty(request.summary, 'summary')
    if (request.baseRevision !== 'absent' && !/^[a-f0-9]{64}$/.test(request.baseRevision)) {
      throw new NovelProjectError('INVALID_CONTENT', 'baseRevision must be absent or a SHA-256 digest')
    }
    const manifest = await this.#readManifest(signal)
    const nextText = normalizeAssetContent(request.target, request.replacement, manifest)
    const bytes = Buffer.byteLength(nextText, 'utf8')
    if (bytes > this.#assetLimit) {
      throw new NovelProjectError('SIZE_LIMIT_EXCEEDED', `asset exceeds ${this.#assetLimit} bytes`)
    }
    const source = novelAssetSource(request.target)
    const filename = join(root, source)
    const parent = resolve(filename, '..')
    const beforeLock = await this.#readAsset(request.target, signal)
    if (!revisionMatches(beforeLock, request)) {
      throw new NovelProjectError('STALE_REVISION', `${source} changed since it was read`)
    }
    await this.#rejectSymlinkChain(parent)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await this.#rejectSymlinkChain(parent)

    try {
      return await withFileLock(filename, async () => {
        requireNotAborted(signal)
        const current = await this.#readAsset(request.target, signal)
        if (!revisionMatches(current, request)) {
          throw new NovelProjectError('STALE_REVISION', `${source} changed since it was read`)
        }
        requireNotAborted(signal)
        try {
          await writeFileAtomic(filename, nextText, { mode: 0o600, dirMode: 0o700 })
        } catch (cause) {
          throw new NovelProjectError('WRITE_FAILED', `failed to replace ${source}`, { cause })
        }
        return {
          projectId: manifest.projectId,
          target: request.target,
          oldRevision: current.revision,
          newRevision: revisionOf(nextText),
          bytes,
        }
      })
    } catch (cause) {
      if (cause instanceof NovelProjectError) throw cause
      throw new NovelProjectError('WRITE_FAILED', `failed to coordinate replacement of ${source}`, { cause })
    }
  }

  async #readAsset(target: AssetRef, signal: AbortSignal): Promise<NovelAssetReadResult> {
    const source = novelAssetSource(target)
    const filename = join(this.#root, source)
    requireNotAborted(signal)
    let text: string
    try {
      await this.#rejectSymlinkChain(filename)
      text = normalizeText(await readFile(filename, { encoding: 'utf8', signal }))
    } catch (cause) {
      if (this.#isMissing(cause)) {
        if (target.kind === 'project') {
          throw new NovelProjectError('NOT_INITIALIZED', 'novel project is not initialized', { cause })
        }
        return { kind: 'asset', target, source, revision: 'absent', text: '', bytes: 0, truncated: false, omitted: false }
      }
      if (cause instanceof NovelProjectError) throw cause
      throw new NovelProjectError('INVALID_CONTENT', `failed to read ${source}`, { cause })
    }
    validateAssetText(target, text)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.#assetLimit) {
      throw new NovelProjectError('SIZE_LIMIT_EXCEEDED', `${source} exceeds ${this.#assetLimit} bytes`)
    }
    return {
      kind: 'asset', target, source, revision: revisionOf(text), text,
      bytes, truncated: false, omitted: false,
    }
  }

  async #readWorkingSet(chapter: number | undefined, signal: AbortSignal): Promise<NovelReadResult> {
    if (chapter !== undefined) chapterName(chapter)
    const targets: AssetRef[] = [
      { kind: 'project' },
      { kind: 'characters' },
      { kind: 'story-blueprint' },
    ]
    if (chapter !== undefined) {
      targets.push({ kind: 'chapter-blueprint', chapter }, { kind: 'chapter-draft', chapter })
    }
    const assets: NovelAssetReadResult[] = []
    const omittedSources: string[] = []
    let bytes = 0
    for (const target of targets) {
      requireNotAborted(signal)
      const asset = await this.#readAsset(target, signal)
      const remaining = this.#workingSetLimit - bytes
      if (remaining <= 0) {
        omittedSources.push(asset.source)
        continue
      }
      const returnedText = truncateUtf8(asset.text, remaining)
      const returnedBytes = Buffer.byteLength(returnedText, 'utf8')
      const truncated = returnedBytes < asset.bytes
      assets.push({ ...asset, text: returnedText, truncated })
      bytes += returnedBytes
      if (truncated) {
        for (const later of targets.slice(targets.indexOf(target) + 1)) omittedSources.push(novelAssetSource(later))
        break
      }
    }
    return {
      kind: 'working-set',
      assets,
      bytes,
      truncated: omittedSources.length > 0 || assets.some(asset => asset.truncated),
      omittedSources,
    }
  }

  async #query(text: string, requestedLimit: number | undefined, signal: AbortSignal): Promise<NovelReadResult> {
    requireNonEmpty(text, 'query text')
    if (requestedLimit !== undefined) requireLimit(requestedLimit, 'query limit')
    const limit = Math.min(requestedLimit ?? this.#queryLimit, this.#queryLimit)
    const matches: Array<{ source: string; revision: Revision; excerpt: string; truncated: boolean }> = []
    let truncated = false
    let limitReached = false
    for (const target of await this.#queryTargets()) {
      requireNotAborted(signal)
      const asset = await this.#readAsset(target, signal)
      if (asset.revision === 'absent') continue
      if (asset.truncated) truncated = true
      for (const line of asset.text.split('\n')) {
        if (!line.toLocaleLowerCase().includes(text.toLocaleLowerCase())) continue
        if (matches.length >= limit) {
          truncated = true
          limitReached = true
          break
        }
        const excerptTruncated = line.length > 240
        matches.push({
          source: asset.source,
          revision: asset.revision,
          excerpt: line.slice(0, 240),
          truncated: excerptTruncated,
        })
        if (excerptTruncated) truncated = true
      }
      if (limitReached) break
    }
    return { kind: 'query', matches, truncated }
  }

  async #queryTargets(): Promise<AssetRef[]> {
    const targets: AssetRef[] = [{ kind: 'project' }, { kind: 'characters' }, { kind: 'story-blueprint' }]
    const blueprints = await this.#numberedAssets(join(this.#root, '.ai-novel', 'blueprints', 'chapters'), '.json')
    const drafts = await this.#numberedAssets(join(this.#root, 'chapters'), '.md')
    for (const chapter of blueprints) targets.push({ kind: 'chapter-blueprint', chapter })
    for (const chapter of drafts) targets.push({ kind: 'chapter-draft', chapter })
    return targets
  }

  async #numberedAssets(directory: string, extension: string): Promise<number[]> {
    try {
      await this.#rejectSymlinkChain(directory)
      const entries = await readdir(directory, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile() && new RegExp(`^[0-9]{4}\\${extension}$`).test(entry.name))
        .map(entry => Number.parseInt(entry.name.slice(0, 4), 10))
        .sort((left, right) => left - right)
    } catch (cause) {
      if (this.#isMissing(cause)) return []
      throw cause
    }
  }

  async #readManifest(signal: AbortSignal): Promise<ProjectManifest> {
    const result = await this.#readAsset({ kind: 'project' }, signal)
    return parseManifest(result.text)
  }

  async #requireCanonicalRoot(): Promise<string> {
    let canonical: string
    try {
      canonical = await realpath(this.#root)
    } catch (cause) {
      throw new NovelProjectError('PATH_REJECTED', 'workspace root does not exist', { cause })
    }
    const rel = relative(this.#root, canonical)
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`))) {
      throw new NovelProjectError('PATH_REJECTED', 'workspace root resolves outside its configured path')
    }
    return canonical
  }

  async #rejectSymlink(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new NovelProjectError('PATH_REJECTED', `symbolic link is not allowed: ${path}`)
      }
    } catch (cause) {
      if (this.#isMissing(cause)) return
      throw cause
    }
  }

  async #rejectSymlinkChain(path: string): Promise<void> {
    const target = resolve(path)
    const rel = relative(this.#root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new NovelProjectError('PATH_REJECTED', `path escapes the workspace root: ${path}`)
    }
    let current = this.#root
    if (rel === '') {
      await this.#rejectSymlink(current)
      return
    }
    for (const segment of rel.split(sep)) {
      current = join(current, segment)
      try {
        await this.#rejectSymlink(current)
      } catch (cause) {
        if (this.#isMissing(cause)) return
        throw cause
      }
      if (!(await this.#exists(current))) return
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (cause) {
      if (this.#isMissing(cause)) return false
      throw cause
    }
  }

  #isMissing(cause: unknown): boolean {
    return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
  }
}

/**
 * Open the filesystem-backed implementation for a Harness workspace.
 *
 * @param root Absolute workspace directory; the project may be initialized after opening.
 * @param options Validated read, write, working-set, and query limits.
 * @returns A project implementation that performs bounded reads and atomic single-asset writes.
 * @throws {@link NovelProjectError} when the root or a configured limit is invalid.
 */
export function openNovelProject(root: string, options: NovelProjectOptions = {}): NovelProject {
  const resolved: Required<NovelProjectOptions> = {
    assetBytes: options.assetBytes ?? DEFAULT_ASSET_LIMIT,
    workingSetBytes: options.workingSetBytes ?? DEFAULT_WORKING_SET_LIMIT,
    queryMatches: options.queryMatches ?? DEFAULT_QUERY_LIMIT,
  }
  requireLimit(resolved.assetBytes, 'assetBytes')
  requireLimit(resolved.workingSetBytes, 'workingSetBytes')
  requireLimit(resolved.queryMatches, 'queryMatches')
  if (resolved.queryMatches > DEFAULT_QUERY_LIMIT) {
    throw new NovelProjectError('INVALID_CONTENT', `queryMatches must not exceed ${DEFAULT_QUERY_LIMIT}`)
  }
  return new FileNovelProject(root, resolved)
}
