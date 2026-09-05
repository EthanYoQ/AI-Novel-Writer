/**
 * list_chapters — 列出所有章节状态概览
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'


export const listChaptersTool = buildAgentTool({
  name: 'list_chapters',
  description: '列出项目中所有章节的状态概览，包括哪些章节有蓝图、有草稿、已定稿等信息。用于了解项目整体进度。',
  descriptionEn: 'List every chapter and whether it has a blueprint, draft, or finalized manuscript to summarize overall project progress.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  requiresConfirmation: false,
  execute: async (_args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    try {
      const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', project.path)
      assertAgentProjectCurrent(context)
      const bpNums = new Set<number>((Array.isArray(blueprints) ? blueprints : []).map((b: unknown) => (b as { chapterNumber?: number }).chapterNumber).filter((n): n is number => n !== undefined))
      const { useDraftStore } = await import('../../../stores/draft-store')
      assertAgentProjectCurrent(context)
      const draftState = useDraftStore.getState()
      const draftsByChapter = (
        draftState.dataProjectKey === project.path
        && draftState.loadingProjectKey !== project.path
      ) ? draftState.draftsByChapter : {}
      const draftNums = new Set<number>(Object.keys(draftsByChapter).map(k => parseInt(k, 10)))

      // 定稿状态从 DB 查询而非 FS 扫描
      const msNums = new Set<number>()
      for (const bp of (Array.isArray(blueprints) ? blueprints : [])) {
        const finalized = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', bp.chapterNumber, project.path)
        assertAgentProjectCurrent(context)
        if (finalized) msNums.add(bp.chapterNumber)
      }

      // 合并所有出现过的章节号
      const allNums = new Set([...bpNums, ...draftNums, ...msNums])
      if (allNums.size === 0) {
        return { success: true, content: text(
          '📊 项目中暂无任何章节数据。建议先生成故事架构和章节蓝图。',
          '📊 This project has no chapter data yet. Generate the story architecture and chapter blueprints first.',
        ) }
      }

      const sortedNums = Array.from(allNums).sort((a, b) => a - b)

      const rows = sortedNums.map(num => {
        const hasBp = bpNums.has(num) ? '✅' : '❌'
        const hasDraft = draftNums.has(num) ? '✅' : '❌'
        const hasMs = msNums.has(num) ? '✅' : '❌'
        return `| ${num} | ${hasBp} | ${hasDraft} | ${hasMs} |`
      })

      const table = `${text('| 章节 | 蓝图 | 草稿 | 定稿 |', '| Chapter | Blueprint | Draft | Finalized |')}\n| --- | --- | --- | --- |\n${rows.join('\n')}`

      assertAgentProjectCurrent(context)
      return {
        success: true,
        content: text(
          `📊 章节进度概览\n\n${table}\n\n总计：${sortedNums.length} 个章节，${bpNums.size} 个蓝图，${draftNums.size} 个草稿，${msNums.size} 个定稿`,
          `📊 Chapter progress\n\n${table}\n\nTotal: ${sortedNums.length} chapters, ${bpNums.size} blueprints, ${draftNums.size} drafts, ${msNums.size} finalized`,
        ),
      }
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e)
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? text('获取章节进度失败', 'Could not load chapter progress')
          : text(`获取失败: ${detail}`, `Could not load chapter progress: ${detail}`),
      }
    }
  },
})
