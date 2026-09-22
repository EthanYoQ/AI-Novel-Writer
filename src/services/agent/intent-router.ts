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
  /**
   * 提及类型。
   *
   * `draft` / `manuscript`（具体某一稿 / 某一章定稿）**刻意不在
   * `getAllMentionTargets` 的静态列表里** —— 它们是「便利贴 · AI 灵感」专用的
   * 引用目标，由那个弹窗通过 `extraRootTargets` 传进来。
   *
   * 为什么不加进静态列表：助手侧的 @ 菜单会照单全收，而助手**没有读草稿的工具**，
   * `mentionsToToolCalls` 只能把它们落到 default 分支，等于给作者一个点了没用的项。
   */
  type: 'chapter' | 'character' | 'architecture' | 'blueprint' | 'knowledge' | 'file' | 'world-setting' | 'draft' | 'manuscript'
  /** 显示名称 */
  displayName: string
  /** 提及值（传递给 Tool） */
  value: string
  /**
   * 补充说明：动态目标（如某条世界观设定）用它标出归属分类，
   * 让作者在 @ 菜单里一眼分清同名条目。
   */
  hint?: string
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
    // 先生定的路线：世界观设定**不做全量注入**，靠作者主动 @ 或 AI 检索按需取用。
    // 这一项是「整类列出（摘要级）」，具体条目由 MentionMenu 动态补进来。
    { type: 'world-setting', displayName: text('世界观设定', 'World settings'), value: 'world_settings' },
    { type: 'chapter', displayName: text('当前章节', 'Current chapter'), value: 'current_chapter' },
    { type: 'file', displayName: text('项目文件', 'Project file'), value: 'file' },
  ]
}

/**
 * 模糊搜索 @ 提及目标
 *
 * `extraTargets` 用来并入**动态目标**（例如项目里已有的世界观设定条目）——
 * 静态列表是编译期常量，具体条目只有运行时才知道。
 */
export function searchMentionTargets(
  query: string,
  locale: Locale = 'zh-CN',
  extraTargets: MentionTarget[] = [],
): MentionTarget[] {
  const q = query.toLowerCase()
  return [...getAllMentionTargets(locale), ...extraTargets].filter(t =>
    t.displayName.toLowerCase().includes(q) ||
    t.value.toLowerCase().includes(q)
  )
}

/**
 * 解析输入中的 @ 提及
 *
 * 正则刻意在**中文标点**处收住：作者写「@青云宗，这场戏怎么写」时，
 * 提及应当是「青云宗」而不是连同后半句一起吞进去。
 */
export function parseMentions(
  input: string,
  locale: Locale = 'zh-CN',
  extraTargets: MentionTarget[] = [],
): ParsedMention[] {
  const mentions: ParsedMention[] = []
  const regex = /@([^\s，。、；：！？""''（）【】《》,.;:!?()[\]{}]+)/g
  let match: RegExpExecArray | null = null
  const targets = [...getAllMentionTargets(locale), ...extraTargets]

  while ((match = regex.exec(input)) !== null) {
    const value = match[1]
    const target = targets.find(t =>
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
 *
 * ⚠️ 同一轮对话内**必须去重**（先生定的铁律）：
 * 作者写「@故事架构 @故事架构 @故事架构」或反复点选同一条设定时，
 * 同一份内容只允许预取一次 —— 否则同一份全文会被重复拼进提示词，
 * 轻则白烧 token，重则直接把上下文预算击穿、让整轮请求失败。
 * 去重键 = 工具名 + 稳定序列化的参数（同一工具不同参数仍是不同内容，要各自保留）。
 */
export function mentionsToToolCalls(mentions: ParsedMention[]): Array<{
  toolName: string
  args: Record<string, unknown>
}> {
  const calls = mentions.map(m => {
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
      case 'world-setting':
        // 静态项「@世界观设定」→ 列出全部（摘要级）；动态项「@青云宗」→ 精确查那一条。
        return {
          toolName: 'search_world_settings',
          args: { query: m.target.value === 'world_settings' ? '' : m.target.displayName },
        }
      case 'file':
        return { toolName: 'read_file', args: { file_path: '' } }
      default:
        return { toolName: 'read_project_state', args: {} }
    }
  })

  return dedupeToolCalls(calls)
}

/**
 * 按「工具名 + 参数」去重，保留首次出现顺序。
 * 参数键排序后序列化，保证 `{a,b}` 与 `{b,a}` 视为同一调用。
 */
function dedupeToolCalls(
  calls: Array<{ toolName: string; args: Record<string, unknown> }>,
): Array<{ toolName: string; args: Record<string, unknown> }> {
  const seen = new Set<string>()
  const unique: Array<{ toolName: string; args: Record<string, unknown> }> = []
  for (const call of calls) {
    const key = `${call.toolName}:${stableArgsKey(call.args)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(call)
  }
  return unique
}

function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  return keys.map(key => `${key}=${String(args[key])}`).join('&')
}
