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
  const name = fields.name?.trim() || 'unnamed-writing-skill'
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
