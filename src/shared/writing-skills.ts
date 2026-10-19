import type { WritingLanguage } from './writing-language'

export const WRITING_SKILL_STAGES = ['planning', 'drafting', 'review', 'refinement'] as const
export type WritingSkillStage = typeof WRITING_SKILL_STAGES[number]
export type WritingSkillLanguage = WritingLanguage | 'bilingual'
export type WritingSkillSource = 'builtin' | 'user' | 'project'
export type WritingSkillCompatibilityReason =
  | 'relative-reference'
  | 'script-dependency'
  | 'hook-dependency'
  | 'subagent-dependency'
  | 'tool-dependency'
  | 'content-too-large'
  /** 安装清单里的附带文件缺失、被改动或不再是普通文件。 */
  | 'bundle-damaged'

export interface WritingSkillMetadata {
  name: string
  displayName?: string
  description: string
  version?: string
  language: WritingSkillLanguage
  stage?: WritingSkillStage
}

export interface WritingSkillInspection {
  metadata: WritingSkillMetadata
  content: string
  compatible: boolean
  reasons: WritingSkillCompatibilityReason[]
  suggestedStage: WritingSkillStage
  utf8Bytes: number
}

/** 带附带文件的 Skill（本机导入的候选，或按清单安装的 Skill）的检查结果。 */
export interface WritingSkillPackageInspection extends WritingSkillInspection {
  /** 注入提示词的正文；附带文本按引用顺序并入末尾。 */
  content: string
  /** 已并入 content 的附带文件，相对 Skill 根目录的 POSIX 路径。 */
  bundledFiles: string[]
  /** 正文引用了、但没有并入的普通相对链接（如 `FORMS.md`、`image.png`）；模型看不到它们，但不影响兼容。 */
  unbundledReferences: string[]
}

/**
 * 按 Skill 根目录相对路径读取附带文本文件；不存在、不是文本或不安全时返回 undefined。
 * 传入的路径已规范化：只含安全片段，不含 `..`，扩展名属于 WRITING_SKILL_TEXT_EXTENSIONS。
 */
export type WritingSkillFileReader = (relativePath: string) => string | undefined

export interface LocalWritingSkillInspectOptions {
  readFile?: WritingSkillFileReader
  /** frontmatter 缺少 name 时使用，例如 Skill 文件夹名。 */
  fallbackName?: string
}

export interface WritingSkillBundledFile {
  /** 相对 Skill 根目录的 POSIX 路径。 */
  path: string
  content: string
}

/**
 * 已安装 Skill 的附带文件，以安装清单为准。
 * none：没有清单（本机导入出现之前装的 Skill、GitHub 导入），只看 SKILL.md，与旧版逐字节一致。
 */
export type InstalledWritingSkillBundle =
  | { status: 'none' }
  | { status: 'intact'; files: WritingSkillBundledFile[] }
  | { status: 'damaged' }

export interface GitHubWritingSkillLocation {
  owner: string
  repo: string
  ref?: string
  path: string
  sourceUrl: string
}

export interface RemoteWritingSkillInspection extends Omit<WritingSkillInspection, 'content'> {
  sourceUrl: string
  resolvedUrl: string
  contentSha256: string
}

export type LocalWritingSkillSourceKind = 'file' | 'folder'

/** 主进程读取本机文件或文件夹后的检查结果；渲染层只拿到候选 id，拿不到路径或读文件能力。 */
export interface LocalWritingSkillInspection extends Omit<WritingSkillPackageInspection, 'content'> {
  candidateId: string
  sourceKind: LocalWritingSkillSourceKind
  /** 所选文件或文件夹的名称（不含上级路径）。 */
  sourceName: string
  contentSha256: string
  /** 文件夹里不会安装的文件：脚本、二进制、未被 SKILL.md 引用的文本等。 */
  skippedFiles: string[]
}

export interface InstalledWritingSkill {
  name: string
  source: 'user'
  version?: string
  language: WritingSkillLanguage
  compatible: true
  utf8Bytes: number
}

export const MAX_WRITING_SKILL_BYTES = 64 * 1024
export const WRITING_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const WRITING_SKILL_TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const
export const MAX_WRITING_SKILL_BUNDLED_FILES = 16
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) return trimmed.slice(1, -1)
  return trimmed
}

/** blockScalars 只用于带附带文件的 Skill；只看 SKILL.md 的旧规则逐行解析，与 master 一致。 */
function parseFrontmatter(raw: string, blockScalars: boolean): { fields: Record<string, string>; content: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { fields: {}, content: raw.trim() }
  const fields: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const field = lines[index].match(/^\s*([^:#][^:]*):\s*(.*?)\s*$/)
    if (!field) continue
    const key = field[1].trim().toLowerCase()
    const blockStyle = blockScalars ? field[2].match(/^([>|])[+-]?$/)?.[1] : undefined
    if (!blockStyle) {
      fields[key] = unquote(field[2])
      continue
    }
    // Agent Skills 常用 YAML 块标量写多行 description：`>` 折叠成一行，`|` 保留换行。
    const block: string[] = []
    while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) {
      block.push(lines[++index].trim())
    }
    fields[key] = blockStyle === '>'
      ? block.filter(Boolean).join(' ')
      : block.join('\n').trim()
  }
  return { fields, content: raw.slice(match[0].length).trim() }
}

const LINK_TARGET = /\]\(\s*(<?)([^)\s>]+)/g
const BARE_REFERENCE = /(?:^|[\s`'"(])((?:\$\{skill_dir\}[/\\])?(?:references?|assets?)[/\\][^\s`'")]+)/gim
const SKILL_DIR_REFERENCE = /\$\{skill_dir\}(?:[/\\][^\s`'")]+)?/gi

// 这些写法明确要求模型去读 Skill 目录里的文件；读不到就不兼容。普通相对链接（如 `](FORMS.md)`）以前就放行，保持放行。
const DIRECTORY_REFERENCE = /^(?:\.\.?[/\\]|(?:references?|assets?)[/\\])|\$\{skill_dir\}/i

interface SkillReference {
  path: string
  /** 读不到时是否让 Skill 不兼容。尖括号链接 `](<./x.md>)` 以前从不拦截，只有其中的 ${SKILL_DIR} 才拦。 */
  blocking: boolean
}

/** 按出现顺序列出正文里的相对引用：Markdown 链接目标、references/ 与 assets/ 路径、${SKILL_DIR}。 */
function referencedPaths(text: string): SkillReference[] {
  const found: Array<SkillReference & { at: number }> = []
  for (const match of text.matchAll(LINK_TARGET)) {
    const [, angled, path] = match
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(path)) continue
    const blocking = angled ? /\$\{skill_dir\}/i.test(path) : DIRECTORY_REFERENCE.test(path)
    found.push({ at: match.index, path, blocking })
  }
  for (const match of text.matchAll(BARE_REFERENCE)) found.push({ at: match.index, path: match[1], blocking: true })
  for (const match of text.matchAll(SKILL_DIR_REFERENCE)) found.push({ at: match.index, path: match[0], blocking: true })
  return found.sort((left, right) => left.at - right.at).map(({ path, blocking }) => ({ path, blocking }))
}

/** 把引用解析成 Skill 根目录内的规范 POSIX 路径；越出根目录或含不安全片段时返回 null。 */
function resolveReference(reference: string, baseSegments: string[]): string | null {
  // 路径只取开头的 ASCII 路径字符：中文句读、锚点或查询串在此截断，非 ASCII 文件名留下的残段解析不到文本文件。
  const cleaned = reference
    .replace(/^\$\{skill_dir\}[/\\]?/i, '')
    .match(/^[A-Za-z0-9._/\\-]*/)![0]
    .replace(/[.]+$/, '')
    .replace(/\\/g, '/')
  if (!cleaned) return null
  const segments = [...baseSegments]
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) return null
      segments.pop()
      continue
    }
    if (!SAFE_SEGMENT.test(part)) return null
    segments.push(part)
  }
  const resolved = segments.join('/')
  return WRITING_SKILL_TEXT_EXTENSIONS.some(extension => resolved.toLowerCase().endsWith(extension)) ? resolved : null
}

/**
 * 运行时只把 Skill 当作一段提示词注入，读不到旁边的文件。被引用的附带文本因此在检查时就并入正文。
 * 并不进来的引用（缺失、越界、非文本）若是拦截型引用则让 Skill 不兼容，其余只列给用户看。
 */
function bundleReferencedFiles(body: string, readFile: WritingSkillFileReader | undefined): {
  files: WritingSkillBundledFile[]
  blocked: boolean
  unbundled: string[]
} {
  const files: WritingSkillBundledFile[] = []
  const unbundled = new Set<string>()
  // 已在包内的路径按小写比对：Windows 与 macOS 上大小写不同的写法是同一个文件。根 SKILL.md 本身就是正文，回链它不算附带文件。
  const included = new Set(['skill.md'])
  const queue = referencedPaths(body).map(reference => ({ ...reference, base: [] as string[] }))
  let blocked = false
  while (queue.length) {
    const { path: reference, blocking, base } = queue.shift()!
    const candidates = [...new Set([resolveReference(reference, base), resolveReference(reference, [])])]
      .filter((candidate): candidate is string => candidate !== null)
    if (candidates.some(candidate => included.has(candidate.toLowerCase()))) continue
    const bundled = files.length < MAX_WRITING_SKILL_BUNDLED_FILES
      ? candidates.map(path => ({ path, content: readFile?.(path) })).find(file => file.content !== undefined)
      : undefined
    if (!bundled) {
      const shown = reference.replace(/[#?].*$/, '')
      if (blocking) blocked = true
      else if (shown) unbundled.add(shown)
      continue
    }
    files.push({ path: bundled.path, content: bundled.content!.trim() })
    included.add(bundled.path.toLowerCase())
    const directory = bundled.path.split('/').slice(0, -1)
    queue.push(...referencedPaths(bundled.content!).map(reference => ({ ...reference, base: directory })))
  }
  return { files, blocked, unbundled: [...unbundled] }
}

function normalizedLanguage(value: string | undefined): WritingSkillLanguage {
  const normalized = value?.toLowerCase()
  if (normalized === 'en-us' || normalized === 'en' || normalized === 'english') return 'en-US'
  if (normalized === 'zh-cn' || normalized === 'zh' || normalized === 'chinese') return 'zh-CN'
  return 'bilingual'
}

function normalizedStage(value: string | undefined): WritingSkillStage | undefined {
  return WRITING_SKILL_STAGES.find(stage => stage === value?.toLowerCase())
}

function suggestedStage(fields: Record<string, string>, content: string): WritingSkillStage {
  const explicit = normalizedStage(fields.stage)
  if (explicit) return explicit
  const searchable = `${fields.name ?? ''} ${fields.description ?? ''} ${content.slice(0, 1000)}`.toLowerCase()
  if (/review|critique|审稿|审阅|检查/.test(searchable)) return 'review'
  if (/refin|polish|prose|润色|修稿|改写/.test(searchable)) return 'refinement'
  if (/plan|outline|architect|规划|大纲|设定/.test(searchable)) return 'planning'
  return 'drafting'
}

/** master 拦截的三种写法：要求模型去读 Skill 目录里的文件。 */
function citesSkillDirectory(content: string): boolean {
  return /\]\(\s*(?:\.\.?[/\\]|(?:references?|assets?)[/\\])/i.test(content)
    || /(?:^|[\s`'"(])(?:references?|assets?)[/\\][^\s`'")]+/im.test(content)
    || /\$\{skill_dir\}/i.test(content)
}

function inspectSkill(raw: string, parsed: {
  fields: Record<string, string>
  body: string
  files: WritingSkillBundledFile[]
  relativeReference: boolean
  fallbackName?: string
}): WritingSkillInspection {
  const { fields, body: skillBody, files } = parsed
  const name = fields.name?.trim() || parsed.fallbackName || 'unnamed-writing-skill'
  const reasons = new Set<WritingSkillCompatibilityReason>()
  const content = [skillBody, ...files.map(file => `---\n\n## ${file.path}\n\n${file.content}`)].join('\n\n')
  const utf8Bytes = new TextEncoder().encode(content).byteLength
  const body = content.toLowerCase()
  const declaredCapabilities = Object.keys(fields).join(' ')

  if (new TextEncoder().encode(raw).byteLength > MAX_WRITING_SKILL_BYTES || utf8Bytes > MAX_WRITING_SKILL_BYTES) {
    reasons.add('content-too-large')
  }
  if (parsed.relativeReference) reasons.add('relative-reference')
  if (/(?:^|[\s`'"(])scripts?[/\\][^\s`'")]+/im.test(content)
    || /\b(?:run|execute)\s+(?:the\s+)?script\b/i.test(content)
    || /运行.{0,12}脚本/.test(content)) reasons.add('script-dependency')
  if (/(?:^|[\s`'"(])hooks?[/\\][^\s`'")]+/im.test(content)
    || /\b(?:install|run|execute)\s+(?:the\s+)?hook\b/i.test(content)
    || /安装.{0,12}钩子/.test(content)) reasons.add('hook-dependency')
  if (/\bsub-?agents?\b|\bdelegate\b.{0,30}\bagents?\b|子代理|子智能体/.test(body)) {
    reasons.add('subagent-dependency')
  }
  if (/\ballowed[-_ ]?tools?\b|\btools?\b|\bmcp\b|\bhooks?\b|\bscripts?\b|\bsub-?agents?\b/.test(declaredCapabilities)
    || /\b(?:use|call|invoke)\s+(?:the\s+)?[a-z0-9_-]+\s+tools?\b/i.test(content)
    || /(?:使用|调用).{0,24}工具/.test(content)) reasons.add('tool-dependency')

  const stage = suggestedStage(fields, content)
  return {
    metadata: {
      name,
      displayName: fields.display_name || fields['display-name'],
      description: fields.description || `Writing skill: ${name}`,
      version: fields.version,
      language: normalizedLanguage(fields.language),
      stage: normalizedStage(fields.stage),
    },
    content,
    compatible: reasons.size === 0,
    reasons: [...reasons],
    suggestedStage: stage,
    utf8Bytes,
  }
}

/** 只看 SKILL.md：GitHub 导入、项目 Skill、内置 Skill 和没有安装清单的已安装 Skill 都走这条规则。 */
export function inspectWritingSkillMarkdown(raw: string): WritingSkillInspection {
  if (typeof raw !== 'string') throw new Error('SKILL.md content must be text')
  const { fields, content } = parseFrontmatter(raw, false)
  return inspectSkill(raw, { fields, body: content, files: [], relativeReference: citesSkillDirectory(content) })
}

/** 检查本机选中的 SKILL.md 或 Skill 文件夹：按引用读取附带文本并入正文。 */
export function inspectLocalWritingSkill(raw: string, options: LocalWritingSkillInspectOptions = {}): WritingSkillPackageInspection {
  if (typeof raw !== 'string') throw new Error('SKILL.md content must be text')
  const { fields, content: body } = parseFrontmatter(raw, true)
  const bundle = bundleReferencedFiles(body, options.readFile)
  return {
    ...inspectSkill(raw, { fields, body, files: bundle.files, relativeReference: bundle.blocked, fallbackName: options.fallbackName }),
    bundledFiles: bundle.files.map(file => file.path),
    unbundledReferences: bundle.unbundled,
  }
}

/**
 * 检查已安装的 Skill。没有清单时与 inspectWritingSkillMarkdown 相同。
 * 有清单时只并入清单里的文件、按清单顺序；引用只用来判断拦截型引用是否都落在清单里。
 */
/** fallbackName 只用于有清单的本机导入（安装时缺 name 的取了文件夹名）；没有清单时与旧版一样不用。 */
export function inspectInstalledWritingSkill(raw: string, bundle: InstalledWritingSkillBundle, fallbackName?: string): WritingSkillInspection {
  if (bundle.status === 'none') return inspectWritingSkillMarkdown(raw)
  if (typeof raw !== 'string') throw new Error('SKILL.md content must be text')
  const { fields, content: body } = parseFrontmatter(raw, true)
  const files = bundle.status === 'intact' ? bundle.files.map(file => ({ path: file.path, content: file.content.trim() })) : []
  // 安装时在大小写不敏感的文件系统上解析过引用，这里同样按小写对上清单。
  const listed = new Map(files.map(file => [file.path.toLowerCase(), file.content]))
  const references = bundleReferencedFiles(body, relativePath => listed.get(relativePath.toLowerCase()))
  const inspection: WritingSkillPackageInspection = {
    ...inspectSkill(raw, { fields, body, files, relativeReference: references.blocked, fallbackName }),
    bundledFiles: files.map(file => file.path),
    unbundledReferences: references.unbundled,
  }
  return bundle.status === 'damaged'
    ? { ...inspection, compatible: false, reasons: [...inspection.reasons, 'bundle-damaged'] }
    : inspection
}

function safePart(value: string, label: string): string {
  const decoded = decodeURIComponent(value)
  if (!SAFE_SEGMENT.test(decoded) || decoded === '.' || decoded === '..') {
    throw new Error(`Invalid GitHub ${label}`)
  }
  return decoded
}

function safePath(parts: string[]): string {
  const decoded = parts.map((part, index) => safePart(part, `path segment ${index + 1}`)).join('/')
  if (!decoded || !decoded.toLowerCase().endsWith('skill.md')) {
    throw new Error('The GitHub source must resolve to a SKILL.md file')
  }
  return decoded
}

export function parseGitHubWritingSkillUrl(value: string): GitHubWritingSkillLocation {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid GitHub URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Only public HTTPS GitHub URLs are supported')
  }
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.hostname === 'raw.githubusercontent.com') {
    if (parts.length < 4) throw new Error('Incomplete raw GitHub URL')
    return {
      owner: safePart(parts[0], 'owner'),
      repo: safePart(parts[1].replace(/\.git$/i, ''), 'repository'),
      ref: safePart(parts[2], 'ref'),
      path: safePath(parts.slice(3)),
      sourceUrl: url.toString(),
    }
  }
  if (url.hostname !== 'github.com' || parts.length < 2) {
    throw new Error('Only github.com and raw.githubusercontent.com are supported')
  }

  const owner = safePart(parts[0], 'owner')
  const repo = safePart(parts[1].replace(/\.git$/i, ''), 'repository')
  if (parts.length === 2) return { owner, repo, path: 'SKILL.md', sourceUrl: url.toString() }

  const kind = parts[2]
  if ((kind !== 'tree' && kind !== 'blob') || parts.length < 4) {
    throw new Error('Use a GitHub repository, directory, blob, or raw SKILL.md URL')
  }
  const ref = safePart(parts[3], 'ref')
  const targetParts = parts.slice(4)
  if (kind === 'tree') targetParts.push('SKILL.md')
  return { owner, repo, ref, path: safePath(targetParts), sourceUrl: url.toString() }
}
