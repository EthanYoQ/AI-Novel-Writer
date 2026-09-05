/**
 * read_drafts — 读取草稿内容及状态
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'


export const readDraftsTool = buildAgentTool({
  name: 'read_drafts',
  description: '读取指定章节的草稿内容。可以获取初稿、修订稿等不同版本。',
  descriptionEn: 'Read a chapter draft, including its initial or revised versions.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      chapter_number: {
        type: 'number',
        description: '章节号（必填）',
        descriptionEn: 'Chapter number',
      },
      draft_type: {
        type: 'string',
        description: '草稿类型',
        descriptionEn: 'Draft version type',
        enum: ['draft_v1', 'revised', 'latest'],
        default: 'latest',
      },
    },
    required: ['chapter_number'],
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const chapterNum = args.chapter_number as number
    const draftType = (args.draft_type as string) ?? 'latest'

    try {
      // 从数据库获取章节的草稿列表
      const draftsResult = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNum, project.path)
      assertAgentProjectCurrent(context)
      const drafts = (Array.isArray(draftsResult) ? draftsResult : []) as unknown as Array<Record<string, unknown>>
      if (!drafts || drafts.length === 0) {
        return { success: true, content: text(`第 ${chapterNum} 章暂无草稿。`, `Chapter ${chapterNum} has no drafts yet.`) }
      }

      let targetId: number | null = null
      let targetName = ''

      if (draftType === 'latest') {
        const latest = drafts[0] // 默认查询回来是按 version 倒序排列的
        targetId = latest.id as number
        targetName = `v${latest.version as number}`
      } else {
        // 查找指定类型的草稿
        const target = drafts.find(d => {
          if (draftType === 'draft_v1') return (d.version as number) === 1
          if (draftType === 'revised') return (d.version as number) > 1
          return false
        })

        if (!target) {
          const available = drafts.map(d => `v${d.version as number}`).join(', ')
          return { success: false, content: '', error: text(`未找到 "${draftType}" 类型的草稿。可用版本：${available}`, `No "${draftType}" draft was found. Available versions: ${available}`) }
        }
        targetId = target.id as number
        targetName = `v${target.version as number}`
      }

      const fullDraft = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', targetId as number, project.path) as { content?: string } | null
      assertAgentProjectCurrent(context)
      if (!fullDraft) {
        return { success: false, content: '', error: text(`读取草稿内容失败：id ${targetId}`, `Could not read draft content: id ${targetId}`) }
      }
      return { success: true, content: text(`📝 第 ${chapterNum} 章草稿（${targetName}）\n\n${fullDraft.content}`, `📝 Chapter ${chapterNum} draft (${targetName})\n\n${fullDraft.content}`) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? text('读取草稿失败', 'Could not read drafts')
          : text(`读取草稿失败：${detail}`, `Could not read drafts: ${detail}`),
      }
    }
  },
})
