/**
 * 意图路由 + / 命令解析
 *
 * 负责：
 * 1. 解析 /command 格式的斜杠命令
 * 2. 解析 @mention 格式的上下文提及
 * 3. 路由用户消息到对应的处理逻辑
 */

import { skillRegistry, type LoadedSkill } from './skill-registry'
import type { Locale } from '../../i18n/types'

// ===== 类型定义 =====

/** / 命令 */
export interface SlashCommand {
  /** 命令名（不含 /） */
  name: string
  /** 显示名称 */
  displayName: string
  /** 描述 */
  description: string
  /** 来源类型 */
  source: 'builtin_command' | 'skill'
  /** 关联的 Skill（如有） */
  skill?: LoadedSkill
}

/** @ 提及目标 */
export interface MentionTarget {
  /** 提及类型 */
  type: 'chapter' | 'character' | 'architecture' | 'blueprint' | 'knowledge' | 'file'
  /** 显示名称 */
  displayName: string
  /** 提及值（传递给 Tool） */
  value: string
}

/** 提及解析结果 */
export interface ParsedMention {
  target: MentionTarget
  /** 在原文中的起止位置 */
  start: number
  end: number
}

// ===== / 命令管理 =====

/** 内置 / 命令列表 */
function builtinCommands(locale: Locale): SlashCommand[] {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  return [
    {
      name: 'clear',
      displayName: text('清空对话', 'Clear conversation'),
      description: text('清空当前对话历史', 'Clear the current conversation history'),
      source: 'builtin_command',
    },
    {
      name: 'new',
      displayName: text('新对话', 'New conversation'),
      description: text('开始一个新的对话', 'Start a new conversation'),
      source: 'builtin_command',
    },
    {
      name: 'help',
      displayName: text('帮助', 'Help'),
      description: text('显示可用的命令和功能列表', 'Show available commands and features'),
      source: 'builtin_command',
    },
    {
      name: 'status',
      displayName: text('项目状态', 'Project status'),
      description: text('查看当前项目的状态和进度', 'View the current project status and progress'),
      source: 'builtin_command',
    },
  ]
}

/**
 * 获取所有可用的 / 命令（内置 + Skill）
 */
export function getAllSlashCommands(locale: Locale = 'zh-CN'): SlashCommand[] {
  const commands = builtinCommands(locale)

  // 把所有 Skill 也注册为 / 命令
  for (const skill of skillRegistry.listAll()) {
    if (skill.metadata.userInvocable !== false) {
      commands.push({
        name: skill.metadata.name,
        displayName: locale === 'en-US'
          ? (skill.writingSkill.metadata.displayName ?? skill.metadata.name)
          : (skill.metadata.displayName ?? skill.metadata.name),
        description: locale === 'en-US'
          ? skill.writingSkill.metadata.description
          : skill.metadata.description,
        source: 'skill',
        skill,
      })
    }
  }

  return commands
}

/**
 * 模糊搜索 / 命令
 */
export function searchSlashCommands(query: string, locale: Locale = 'zh-CN'): SlashCommand[] {
  const q = query.toLowerCase()
  return getAllSlashCommands(locale).filter(cmd =>
    cmd.name.toLowerCase().includes(q) ||
    cmd.displayName.toLowerCase().includes(q) ||
    cmd.description.toLowerCase().includes(q)
  )
}

/**
 * 判断用户输入是否以 / 开头
 */
export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith('/')
}

/**
 * 解析 / 命令
 */
export function parseSlashCommand(input: string, locale: Locale = 'zh-CN'): {
  command: SlashCommand | null
  args: string
} {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) {
    return { command: null, args: '' }
  }

  const withoutSlash = trimmed.slice(1)
  const spaceIndex = withoutSlash.indexOf(' ')
  const cmdName = spaceIndex > -1 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
  const args = spaceIndex > -1 ? withoutSlash.slice(spaceIndex + 1).trim() : ''

  const command = getAllSlashCommands(locale).find(c => c.name === cmdName) ?? null

  return { command, args }
}

// ===== @ 提及管理 =====

/**
 * 获取所有可 @ 提及的目标
 */
export function getAllMentionTargets(locale: Locale = 'zh-CN'): MentionTarget[] {
  const text = (zhCN: string, enUS: string) => locale === 'en-US' ? enUS : zhCN
  return [
    { type: 'architecture', displayName: text('故事架构', 'Story architecture'), value: 'architecture' },
    { type: 'character', displayName: text('角色卡', 'Character cards'), value: 'characters' },
    { type: 'blueprint', displayName: text('章节蓝图', 'Chapter blueprints'), value: 'blueprints' },
    { type: 'knowledge', displayName: text('知识库', 'Knowledge base'), value: 'knowledge' },
    { type: 'chapter', displayName: text('当前章节', 'Current chapter'), value: 'current_chapter' },
    { type: 'file', displayName: text('项目文件', 'Project file'), value: 'file' },
  ]
}

/**
 * 模糊搜索 @ 提及目标
 */
export function searchMentionTargets(query: string, locale: Locale = 'zh-CN'): MentionTarget[] {
  const q = query.toLowerCase()
  return getAllMentionTargets(locale).filter(t =>
    t.displayName.toLowerCase().includes(q) ||
    t.value.toLowerCase().includes(q)
  )
}

/**
 * 解析输入中的 @ 提及
 */
export function parseMentions(input: string, locale: Locale = 'zh-CN'): ParsedMention[] {
  const mentions: ParsedMention[] = []
  const regex = /@(\S+)/g
  let match: RegExpExecArray | null = null

  while ((match = regex.exec(input)) !== null) {
    const value = match[1]
    const target = getAllMentionTargets(locale).find(t =>
      t.value === value || t.displayName === value
    )
    if (target) {
      mentions.push({
        target,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return mentions
}

/**
 * 将提及转换为 Tool 调用上下文
 * 返回需要预先调用的 Tool 名称和参数列表
 */
export function mentionsToToolCalls(mentions: ParsedMention[]): Array<{
  toolName: string
  args: Record<string, unknown>
}> {
  return mentions.map(m => {
    switch (m.target.type) {
      case 'architecture':
        return { toolName: 'read_architecture', args: {} }
      case 'character':
        return { toolName: 'read_characters', args: {} }
      case 'blueprint':
        return { toolName: 'read_blueprint', args: {} }
      case 'knowledge':
        return { toolName: 'search_knowledge', args: { query: '' } }
      case 'chapter':
        return { toolName: 'list_chapters', args: {} }
      case 'file':
        return { toolName: 'read_file', args: { file_path: '' } }
      default:
        return { toolName: 'read_project_state', args: {} }
    }
  })
}
