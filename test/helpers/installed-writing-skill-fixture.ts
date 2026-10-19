import fs from 'node:fs'
import path from 'node:path'
import type {
  WritingSkillCompatibilityReason,
  WritingSkillInspection,
  WritingSkillLanguage,
  WritingSkillStage,
} from '../../src/shared/writing-skills'

/*
 * origin/master（d21207c8）上 inspectWritingSkillMarkdown 的逐字副本，作为对拍基准。
 * 没有安装清单的已安装 Skill（本地导入出现之前装的全部，以及 GitHub 导入）必须与它逐字节一致。
 * 不要随实现一起修改这里。
 */
const MASTER_STAGES = ['planning', 'drafting', 'review', 'refinement'] as const
const MASTER_MAX_SKILL_BYTES = 64 * 1024

function masterUnquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) return trimmed.slice(1, -1)
  return trimmed
}

function masterParseFrontmatter(raw: string): { fields: Record<string, string>; content: string } {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { fields: {}, content: raw.trim() }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\s*([^:#][^:]*):\s*(.*?)\s*$/)
    if (field) fields[field[1].trim().toLowerCase()] = masterUnquote(field[2])
  }
  return { fields, content: raw.slice(match[0].length).trim() }
}

function masterLanguage(value: string | undefined): WritingSkillLanguage {
  const normalized = value?.toLowerCase()
  if (normalized === 'en-us' || normalized === 'en' || normalized === 'english') return 'en-US'
  if (normalized === 'zh-cn' || normalized === 'zh' || normalized === 'chinese') return 'zh-CN'
  return 'bilingual'
}

function masterStage(value: string | undefined): WritingSkillStage | undefined {
  return MASTER_STAGES.find(stage => stage === value?.toLowerCase())
}

function masterSuggestedStage(fields: Record<string, string>, content: string): WritingSkillStage {
  const explicit = masterStage(fields.stage)
  if (explicit) return explicit
  const searchable = `${fields.name ?? ''} ${fields.description ?? ''} ${content.slice(0, 1000)}`.toLowerCase()
  if (/review|critique|审稿|审阅|检查/.test(searchable)) return 'review'
  if (/refin|polish|prose|润色|修稿|改写/.test(searchable)) return 'refinement'
  if (/plan|outline|architect|规划|大纲|设定/.test(searchable)) return 'planning'
  return 'drafting'
}

export function masterInspectWritingSkillMarkdown(raw: string): WritingSkillInspection {
  if (typeof raw !== 'string') throw new Error('SKILL.md content must be text')
  const { fields, content } = masterParseFrontmatter(raw)
  const name = fields.name?.trim() || 'unnamed-writing-skill'
  const reasons = new Set<WritingSkillCompatibilityReason>()
  const byteLength = new TextEncoder().encode(raw).byteLength
  const body = content.toLowerCase()
  const declaredCapabilities = Object.keys(fields).join(' ')

  if (byteLength > MASTER_MAX_SKILL_BYTES) reasons.add('content-too-large')
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

  const stage = masterSuggestedStage(fields, content)
  return {
    metadata: {
      name,
      displayName: fields.display_name || fields['display-name'],
      description: fields.description || `Writing skill: ${name}`,
      version: fields.version,
      language: masterLanguage(fields.language),
      stage: masterStage(fields.stage),
    },
    content,
    compatible: reasons.size === 0,
    reasons: [...reasons],
    suggestedStage: stage,
    utf8Bytes: new TextEncoder().encode(content).byteLength,
  }
}

/** 只取 master 检查结果里的字段，比对用户能看到的判定与提示词，不比新增的附带文件字段。 */
export function masterVisibleFields(inspection: WritingSkillInspection | undefined): Partial<WritingSkillInspection> | undefined {
  if (!inspection) return undefined
  const { metadata, content, compatible, reasons, suggestedStage, utf8Bytes } = inspection
  return { metadata, content, compatible, reasons, suggestedStage, utf8Bytes }
}

export interface LegacyInstalledSkillCase {
  label: string
  /** Skill 目录名，也是 frontmatter 里的 name。 */
  name: string
  skill: string
  /** 在 Skill 目录里放进被引用的文件；outside 是 Skill 目录之外的临时目录。 */
  plant?: (directory: string, outside: string) => void
}

function put(directory: string, relative: string, content: string): void {
  const target = path.join(directory, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

const frontmatter = (name: string) => `---\nname: ${name}\nlanguage: zh-CN\nstage: drafting\n---\n`
const twentyLinks = Array.from({ length: 20 }, (_, index) => `ref-${String(index + 1).padStart(2, '0')}.md`)

/**
 * 复审员列出的写法：Skill 目录里真有被引用的文件（旧版 ~/.vela 迁移会原样复制，用户也可能手动放），
 * 但目录里没有安装清单。按 master，这些文件一概不读。
 */
export const LEGACY_INSTALLED_SKILL_CASES: LegacyInstalledSkillCase[] = [
  {
    label: 'a plain link to a file that exists',
    name: 'plain-link',
    skill: `${frontmatter('plain-link')}按 [表单](forms.md) 的格式写。`,
    plant: directory => put(directory, 'forms.md', '表单按三栏写。'),
  },
  {
    label: 'an angle-bracket link to a file that exists',
    name: 'angle-link',
    skill: `${frontmatter('angle-link')}按 [表单](<forms.md>) 的格式写。`,
    plant: directory => put(directory, 'forms.md', '表单按三栏写。'),
  },
  {
    label: 'a link whose letter case differs from the file',
    name: 'case-variant',
    skill: `${frontmatter('case-variant')}按 [表单](Forms.md) 的格式写。`,
    plant: directory => put(directory, 'forms.md', '表单按三栏写。'),
  },
  {
    label: 'twenty links to files that exist',
    name: 'twenty-links',
    skill: `${frontmatter('twenty-links')}${twentyLinks.map(file => `[${file}](${file})`).join('\n')}`,
    plant: directory => { for (const file of twentyLinks) put(directory, file, `${file} 的规则。`) },
  },
  {
    label: 'a linked file that asks for a tool',
    name: 'tool-wording',
    skill: `${frontmatter('tool-wording')}按 [表单](forms.md) 的格式写。`,
    plant: directory => put(directory, 'forms.md', 'Use the bash tool to run the script first. 使用搜索工具。'),
  },
  {
    label: 'a linked file that cites references/',
    name: 'nested-reference',
    skill: `${frontmatter('nested-reference')}按 [表单](forms.md) 的格式写。`,
    plant: directory => put(directory, 'forms.md', 'Then read references/deep.md.'),
  },
  {
    label: 'a linked file over 64 KiB',
    name: 'oversized-link',
    skill: `${frontmatter('oversized-link')}按 [表单](forms.md) 的格式写。`,
    plant: directory => put(directory, 'forms.md', '长'.repeat(30_000)),
  },
  {
    label: 'a linked file that is a hard link',
    name: 'hard-link',
    skill: `${frontmatter('hard-link')}按 [表单](forms.md) 的格式写。`,
    plant: (directory, outside) => {
      put(outside, 'hard-target.md', '硬链接里的规则。')
      fs.linkSync(path.join(outside, 'hard-target.md'), path.join(directory, 'forms.md'))
    },
  },
  {
    label: 'a link through a junction directory',
    name: 'junction-link',
    skill: `${frontmatter('junction-link')}按 [笔记](notes/a.md) 写。`,
    plant: (directory, outside) => {
      put(outside, 'junction-target/a.md', '联接点里的规则。')
      fs.symlinkSync(path.join(outside, 'junction-target'), path.join(directory, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')
    },
  },
  {
    label: 'a link into a directory named like a file',
    name: 'dir-named-md',
    skill: `${frontmatter('dir-named-md')}按 [笔记](x.md/a.md) 写。`,
    plant: directory => put(directory, 'x.md/a.md', '目录里的规则。'),
  },
  {
    label: 'a link below SKILL.md itself',
    name: 'below-skill-md',
    skill: `${frontmatter('below-skill-md')}按 [笔记](SKILL.md/x.md) 写。`,
  },
  {
    label: 'a link to a missing file',
    name: 'missing-link',
    skill: `${frontmatter('missing-link')}按 [表单](missing.md) 的格式写。`,
  },
  {
    label: 'a ./ link to its own SKILL.md',
    name: 'self-dot',
    skill: `${frontmatter('self-dot')}保持视角。[回到开头](./SKILL.md)`,
  },
  {
    label: 'a plain link to its own SKILL.md',
    name: 'self-plain',
    skill: `${frontmatter('self-plain')}保持视角。[回到开头](SKILL.md#top)`,
  },
  {
    label: 'a ${SKILL_DIR} reference to a file that exists',
    name: 'skill-dir',
    skill: `${frontmatter('skill-dir')}先读 \${SKILL_DIR}/references/voice.md。`,
    plant: directory => put(directory, 'references/voice.md', '第三人称近距离。'),
  },
  {
    label: 'a bare references/ path to a file that exists',
    name: 'bare-reference',
    skill: `${frontmatter('bare-reference')}遵循 references/voice.md。`,
    plant: directory => put(directory, 'references/voice.md', '第三人称近距离。'),
  },
  {
    label: 'a link to a non-ASCII file name that exists',
    name: 'non-ascii',
    skill: `${frontmatter('non-ascii')}按 [风格](风格.md) 写。`,
    plant: directory => put(directory, '风格.md', '短句。'),
  },
  {
    label: 'a YAML block scalar whose indented lines look like keys',
    name: 'yaml-block',
    skill: '---\nname: yaml-block\nlanguage: en-US\ndescription: >-\n  Keeps the voice steady.\n  language: zh-CN\nstage: drafting\n---\n保持视角。',
  },
]

/** 在 skillsRoot/<name>/ 写出一个没有安装清单的旧式已安装 Skill。 */
export function plantLegacyInstalledSkill(skillsRoot: string, outside: string, testCase: LegacyInstalledSkillCase): string {
  const directory = path.join(skillsRoot, testCase.name)
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), testCase.skill)
  testCase.plant?.(directory, outside)
  return directory
}
