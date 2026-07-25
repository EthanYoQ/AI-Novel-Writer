/**
 * read_file — 读取项目内的文件内容
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { validatePath } from './safe-path'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'

export const readFileTool = buildAgentTool({
  name: 'read_file',
  description: '读取项目内指定文件的内容。支持读取架构文件、蓝图、角色卡、草稿、配置等任意文本文件。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录的文件路径，例如 "02_architecture/世界观.md"',
      },
    },
    required: ['file_path'],
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    const filePath = args.file_path as string
    const { project, projectSession } = requireAgentProject(context)

    // 路径安全校验
    const pathCheck = validatePath(project.path, filePath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: pathCheck.error }
    }

    const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-file', pathCheck.fullPath, project.path)
    assertAgentProjectCurrent(context)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? '文件读取失败' }
    }

    return { success: true, content: result.content }
  },
})
