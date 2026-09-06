/**
 * read_architecture — 读取故事架构文件
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'


export const readArchitectureTool = buildAgentTool({
  name: 'read_architecture',
  description: '读取小说的故事架构文件（四段式架构：故事前提、世界观、角色图谱、剧情大纲等）。是理解小说全局结构的核心工具。',
  descriptionEn: 'Read the story architecture, including the premise, worldbuilding, character graph, and plot synopsis.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_name: {
        type: 'string',
        description: '架构文件名（可选）。不填则列出所有架构文件。例如 "故事前提.md"、"世界观.md"',
        descriptionEn: 'Optional architecture file name. Omit it to list all architecture files, for example "premise.md" or "worldbuilding.md"',
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)

    const fileName = args.file_name as string | undefined

    try {
      const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', project.path)
      assertAgentProjectCurrent(context)
      if (!core) {
        return { success: false, content: '', error: text('项目架构未初始化', 'The project architecture has not been initialized') }
      }

      if (fileName) {
        // Find property based on suffix
        const isPremise = fileName.includes('前提') || fileName.includes('premise')
        const isWorld = fileName.includes('世界') || fileName.includes('world')
        const isChar = fileName.includes('角色') || fileName.includes('character')
        const isSynopsis = fileName.includes('大纲') || fileName.includes('synopsis')
        let property = ''
        if (isPremise) property = core.premise
        else if (isWorld) property = core.worldbuilding
        else if (isChar) property = core.charactersArch
        else if (isSynopsis) property = core.synopsis

        if (!property) {
          return { success: false, content: '', error: text(`架构文件内容为空：${fileName}`, `The architecture content is empty: ${fileName}`) }
        }
        return { success: true, content: text(`📐 架构文件：${fileName}\n\n${property}`, `📐 Architecture: ${fileName}\n\n${property}`) }
      }

      const contents: string[] = []
      if (core.premise) contents.push(`## 📄 premise.md\n\n${core.premise}`)
      if (core.worldbuilding) contents.push(`## 📄 worldbuilding.md\n\n${core.worldbuilding}`)
      if (core.charactersArch) contents.push(`## 📄 characters.md\n\n${core.charactersArch}`)
      if (core.synopsis) contents.push(`## 📄 synopsis.md\n\n${core.synopsis}`)

      if (contents.length === 0) {
        return { success: true, content: text('⚠️ 架构为空，暂无架构文件。建议通过工作流生成故事架构。', '⚠️ The architecture is empty. Generate the story architecture with the workflow first.') }
      }

      return { success: true, content: text(`📐 故事架构（${contents.length} 个文件）\n\n${contents.join('\n\n---\n\n')}`, `📐 Story architecture (${contents.length} files)\n\n${contents.join('\n\n---\n\n')}`) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? text('读取架构失败', 'Could not read the architecture')
          : text(`读取架构失败：${detail}`, `Could not read the architecture: ${detail}`),
      }
    }
  },
})
