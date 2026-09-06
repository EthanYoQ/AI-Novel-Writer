/**
 * read_characters — 读取角色卡档案
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'


export const readCharactersTool = buildAgentTool({
  name: 'read_characters',
  description: '读取小说的角色卡档案。可以获取所有角色列表或指定角色的详细信息（背景、性格、外貌、角色弧等）。',
  descriptionEn: 'Read character cards. List every character or retrieve one character\'s background, personality, appearance, and arc.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      character_name: {
        type: 'string',
        description: '角色名称（可选）。不填则列出所有角色。',
        descriptionEn: 'Optional character name. Omit it to list all characters.',
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const charName = args.character_name as string | undefined

    try {
      const charsResult = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', project.path)
      assertAgentProjectCurrent(context)
      const chars = (Array.isArray(charsResult) ? charsResult : []) as unknown as Array<Record<string, unknown>>
      if (!chars || chars.length === 0) {
        return { success: true, content: text('⚠️ 角色池为空，暂无角色卡。建议先创建角色卡。', '⚠️ The character roster is empty. Create character cards first.') }
      }

      if (charName) {
        // 查找指定角色
        const target = chars.find((c) =>
          String(c.name).toLowerCase().includes(charName.toLowerCase())
        )
        if (!target) {
          const available = chars.map((c) => String(c.name)).join(', ')
          return { success: false, content: '', error: text(`未找到角色 "${charName}"。可用角色：${available}`, `Character "${charName}" was not found. Available characters: ${available}`) }
        }

        const formatted = Object.entries(target)
          .filter(([k, v]) => v && k !== 'id')
          .map(([k, v]) => `**${k}**: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}`)
          .join('\n')
        return { success: true, content: text(`👤 角色卡：${target.name}\n\n${formatted}`, `👤 Character card: ${target.name}\n\n${formatted}`) }
      }

      // 列出所有角色
      const list = chars.map((c) => `  - ${c.name} (${c.role})`).join('\n')
      return { success: true, content: text(`👤 角色列表（${chars.length} 个）\n${list}\n\n使用 character_name 参数可以读取具体角色的详细信息。`, `👤 Character list (${chars.length})\n${list}\n\nUse character_name to read one character in detail.`) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? text('读取角色列表失败', 'Could not read the character list')
          : text(`读取角色列表失败：${detail}`, `Could not read the character list: ${detail}`),
      }
    }
  },
})
