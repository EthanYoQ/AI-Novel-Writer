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

/**
 * 本地 SKILL.md 的检查结果。
 *
 * 与 GitHub 来源共用同一套内容检查（`inspectWritingSkillMarkdown`）；
 * 差别只在于「来源标识」是文件路径而非 URL，且导入时用 SHA-256 复核同一文件，
 * 保证「检查过的内容」与「导入的内容」一致（等价于远程路径的重新下载比对）。
 */
export interface LocalWritingSkillInspection extends Omit<WritingSkillInspection, 'content'> {
  fileName: string
  filePath: string
  contentSha256: string
  /** 界面显示名：优先取 frontmatter 的 display_name，缺失时退回声明名/文件名。 */
  displayName: string
  /** 写入技能库时使用的 ASCII 标识符（技能目录名与 `user:<id>` 绑定 id 都用它）。 */
  skillId: string
  /** frontmatter 声明的原始名称；标识符自动生成时它就是那个中文名。 */
  declaredName: string
  /** 声明名不可用作标识符（例如中文），标识符由名称派生而来。 */
  identifierGenerated: boolean
}

export interface InstalledWritingSkill {
  name: string
  source: 'user'
  version?: string
  language: WritingSkillLanguage
  compatible: true
  utf8Bytes: number
}

const MAX_SKILL_BYTES = 64 * 1024
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

function parseFrontmatter(raw: string): { fields: Record<string, string>; content: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { fields: {}, content: raw.trim() }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\s*([^:#][^:]*):\s*(.*?)\s*$/)
    if (field) fields[field[1].trim().toLowerCase()] = unquote(field[2])
  }
  return { fields, content: raw.slice(match[0].length).trim() }
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

export function inspectWritingSkillMarkdown(raw: string): WritingSkillInspection {
  if (typeof raw !== 'string') throw new Error('SKILL.md content must be text')
  const { fields, content } = parseFrontmatter(raw)
  const name = fields.name?.trim() || UNNAMED_WRITING_SKILL
  const reasons = new Set<WritingSkillCompatibilityReason>()
  const byteLength = new TextEncoder().encode(raw).byteLength
  const body = content.toLowerCase()
  const declaredCapabilities = Object.keys(fields).join(' ')

  if (byteLength > MAX_SKILL_BYTES) reasons.add('content-too-large')
  if (/\]\(\s*(?:\.\.?[/\\]|(?:references?|assets?)[/\\])/i.test(content)
    || /(?:^|[\s`'"(])(?:references?|assets?)[/\\][^\s`'")]+/im.test(content)
    || /\$\{skill_dir\}/i.test(content)) reasons.add('relative-reference')
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
    utf8Bytes: new TextEncoder().encode(content).byteLength,
  }
}

/** frontmatter 未声明 name 时使用的占位名。 */
export const UNNAMED_WRITING_SKILL = 'unnamed-writing-skill'

/** 技能标识符约束：技能目录名与 `user:<id>` 绑定 id 共用同一套规则。 */
export const WRITING_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidWritingSkillId(value: string): boolean {
  return WRITING_SKILL_ID.test(value) && value !== '.' && value !== '..'
}

/** FNV-1a：只要求稳定与低碰撞，不用于安全用途（共享模块不能依赖 node:crypto）。 */
function stableNameHash(value: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 把不可用作标识符的名称（例如中文）派生为稳定的 ASCII 标识符。
 * 同一名称永远得到同一标识符，重复导入与卸载才对得上同一个技能。
 * 名称里已有的 ASCII 片段会被保留：「Prose V2 润色」→「prose-v2-xxxxxxxx」。
 */
export function deriveWritingSkillId(declaredName: string): string {
  const ascii = declaredName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, 48)
  const digest = stableNameHash(declaredName)
  return ascii ? `${ascii}-${digest}` : `skill-${digest}`
}

export interface ResolvedWritingSkillIdentity {
  skillId: string
  displayName: string
  declaredName: string
  identifierGenerated: boolean
}

/**
 * 解析 SKILL.md 的最终身份：声明名已是合法标识符时原样沿用，
 * 否则派生一个标识符，并把原名留给界面显示。
 */
export function resolveWritingSkillIdentity(
  metadata: WritingSkillMetadata,
): ResolvedWritingSkillIdentity {
  const declaredName = metadata.name
  const identifierGenerated = !isValidWritingSkillId(declaredName)
  return {
    declaredName,
    identifierGenerated,
    skillId: identifierGenerated ? deriveWritingSkillId(declaredName) : declaredName,
    displayName: metadata.displayName ?? declaredName,
  }
}

/**
 * 把技能身份写回 frontmatter，供导入落库使用。
 *
 * 只有技能库里的副本会经过这里；作者磁盘上的源文件始终原样不动。
 */
export function rewriteWritingSkillIdentity(
  raw: string,
  identity: ResolvedWritingSkillIdentity,
): string {
  const frontmatter = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!frontmatter) {
    return `---\nname: ${identity.skillId}\ndisplay_name: ${identity.displayName}\n---\n\n${raw.trim()}\n`
  }
  const eol = frontmatter[0].includes('\r\n') ? '\r\n' : '\n'
  const body = raw.slice(frontmatter[0].length)
  let hasName = false
  let hasDisplayName = false
  const lines = frontmatter[1].split(/\r?\n/).map((line) => {
    const field = line.match(/^\s*([^:#][^:]*):\s*(.*?)\s*$/)
    if (!field) return line
    const key = field[1].trim().toLowerCase()
    if (key === 'name') {
      hasName = true
      return `name: ${identity.skillId}`
    }
    if (key === 'display_name' || key === 'display-name') {
      hasDisplayName = true
      return `display_name: ${identity.displayName}`
    }
    return line
  })
  if (!hasName) lines.unshift(`name: ${identity.skillId}`)
  if (!hasDisplayName) {
    const nameIndex = lines.findIndex(line => /^\s*name\s*:/iu.test(line))
    lines.splice(nameIndex < 0 ? 0 : nameIndex + 1, 0, `display_name: ${identity.displayName}`)
  }
  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`
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
