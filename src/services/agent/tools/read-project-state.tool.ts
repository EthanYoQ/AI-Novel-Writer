/**
 * read_project_state — 读取项目全局状态
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'
import { resolveWritingLanguage } from '../../../shared/writing-language'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'


export const readProjectStateTool = buildAgentTool({
  name: 'read_project_state',
  description: '读取项目的全局状态信息，包括小说配置、近章要点等。用于了解项目的整体概况。',
  descriptionEn: 'Read the project-wide state, including novel configuration and recent chapter notes, to understand the overall project context.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      include_config: {
        type: 'boolean',
        description: '是否包含完整的小说配置',
        descriptionEn: 'Include the complete novel configuration',
        default: true,
      },
      include_summary: {
        type: 'boolean',
        description: '是否包含近章要点',
        descriptionEn: 'Include recent chapter notes',
        default: true,
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const writingLanguage = resolveWritingLanguage(project.novelConfig.writingLanguage)
    const english = writingLanguage === 'en-US'

    const includeConfig = (args.include_config as boolean) !== false
    const includeSummary = (args.include_summary as boolean) !== false

    const parts: string[] = [english
      ? `# Project status: "${project.name}"\n`
      : `# 📊 项目状态：《${project.name}》\n`]

    if (includeConfig) {
      // 读取小说配置
      try {
        const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', project.path)
        assertAgentProjectCurrent(context)
        if (core) {
          const localizedFacts = localizeNovelConfigFacts({
            genre: core.genre,
            targetAudience: core.targetAudience,
            plotStructure: core.plotStructure,
            narrativePOV: core.narrativePov,
          }, writingLanguage)
          parts.push(`${english ? '## Novel configuration' : '## 小说配置'}\n\`\`\`json\n${JSON.stringify({
            projectName: core.projectName,
            genre: localizedFacts.genre,
            subGenre: core.subGenre,
            targetAudience: localizedFacts.targetAudience,
            totalChapters: core.totalChapters,
            wordsPerChapter: core.wordsPerChapter,
            plotStructure: localizedFacts.plotStructure,
            narrativePOV: localizedFacts.narrativePOV,
            writingStyle: core.writingStyle
          }, null, 2)}\n\`\`\``)
        }
      } catch {
        // Fallback
        parts.push(english
          ? '## Novel configuration\nFailed to load configuration.'
          : '## 小说配置\n⚠️ 获取配置失败')
      }
    }

    if (includeSummary) {
      // 读取最近 5 章蓝图的 notes 字段作为进度摘要
      const notesParts: string[] = []
      try {
        const bps = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', project.path)
        assertAgentProjectCurrent(context)
        if (bps && Array.isArray(bps)) {
          // 倒序遍历
          const sorted = bps.sort((a, b) => b.chapterNumber - a.chapterNumber)
          for (const bp of sorted) {
            if (bp.notes && bp.notes.trim()) {
              notesParts.unshift(english
                ? `### Chapter ${bp.chapterNumber} ${bp.title || ''}\n${bp.notes}`
                : `### 第${bp.chapterNumber}章 ${bp.title || ''}\n${bp.notes}`)
              if (notesParts.length >= 5) break
            }
          }
        }
      } catch { /* 忽略 */ }

      if (notesParts.length > 0) {
        parts.push(`${english ? '## Recent chapter notes' : '## 近章要点'}\n${notesParts.join('\n\n')}`)
      } else {
        parts.push(english
          ? '## Recent chapter notes\nNo chapter notes yet. Chapter notes are generated after finalization and saved to the blueprint.'
          : '## 近章要点\n暂无章节要点。章节要点会在定稿后自动生成并写入蓝图。')
      }
    }

    assertAgentProjectCurrent(context)
    return { success: true, content: parts.join('\n\n') }
  },
})
