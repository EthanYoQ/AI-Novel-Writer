/**
 * search_knowledge — 语义搜索知识库
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'

export const searchKnowledgeTool = buildAgentTool({
  name: 'search_knowledge',
  description: '在知识库中进行语义搜索，查找与查询相关的参考资料、设定文档等。适用于查找世界观设定、角色背景、故事素材等。',
  descriptionEn: 'Search the knowledge base semantically for reference material, worldbuilding notes, character backgrounds, and story material.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询语句，例如 "主角的金手指设定"',
        descriptionEn: 'Search query, for example "the protagonist\'s special ability"',
      },
      top_k: {
        type: 'number',
        description: '返回结果数量',
        descriptionEn: 'Number of results to return',
        default: 5,
      },
    },
    required: ['query'],
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const query = args.query as string
    const topK = (args.top_k as number) ?? 5

    if (!query) {
      return { success: false, content: '', error: text('缺少 query 参数', 'The query argument is required') }
    }

    const { project, projectSession } = requireAgentProject(context)
    const projectPath = project.path
    let results: Array<{ text: string; score: number; fileName: string }>
    try {
      results = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
        projectSession,
        'kb:search',
        query,
        topK,
        projectPath,
      ))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? text('知识库搜索失败', 'Could not search the knowledge base')
          : detail,
      }
    }
    assertAgentProjectCurrent(context)
    if (!results || results.length === 0) {
      return { success: true, content: text(
        '未找到相关结果。请尝试使用不同的关键词搜索，或尝试使用 read_architecture、read_characters 等工具直接读取项目数据。',
        'No relevant results were found. Try different keywords, or use read_architecture or read_characters to read project data directly.',
      ) }
    }

    const formatted = results.map((r, i) => text(
      `### 结果 ${i + 1} (相似度: ${r.score.toFixed(2)})\n来源: ${r.fileName}\n\n${r.text}`,
      `### Result ${i + 1} (similarity: ${r.score.toFixed(2)})\nSource: ${r.fileName}\n\n${r.text}`,
    )).join('\n\n---\n\n')

    assertAgentProjectCurrent(context)
    return { success: true, content: text(`找到 ${results.length} 条相关结果：\n\n${formatted}`, `Found ${results.length} relevant results:\n\n${formatted}`) }
  },
})
