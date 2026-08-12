/**
 * write_file — 写入或修改项目文件
 */
import { buildAgentTool, createToolArtifact } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { validatePath } from './safe-path'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'
import { projectFactWorkflowForFilePath } from '../../project-fact-targets'

export const writeFileTool = buildAgentTool({
  name: 'write_file',
  description: '写入或修改项目内的文件。可用于创建新文件或覆盖已有文件内容。这是一个写入操作，需要用户确认。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录的文件路径',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
    },
    required: ['file_path', 'content'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const filePath = args.file_path as string
    const content = args.content as string

    if (!filePath || content === undefined) {
      return { success: false, content: '', error: '缺少 file_path 或 content 参数' }
    }

    const reservedWorkflow = projectFactWorkflowForFilePath(filePath)
    if (reservedWorkflow) {
      return {
        success: false,
        content: '',
        error: `“${filePath}”是项目事实的保留语义目标；普通文件不会改变结构化项目。请改用 ${reservedWorkflow} 工作流。`,
      }
    }

    const { project, projectSession } = requireAgentProject(context)

    // 路径安全校验
    const pathCheck = validatePath(project.path, filePath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: pathCheck.error }
    }

    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:write-file',
      pathCheck.fullPath,
      content,
      project.path,
    )
    assertAgentProjectCurrent(context)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? '写入失败' }
    }

    return {
      success: true,
      content: `✅ 文件已写入：${filePath}（${content.length} 字符）`,
      artifacts: [createToolArtifact({
        type: 'file_modified',
        path: pathCheck.fullPath,
        name: filePath,
        projectPath: project.path,
        projectSession,
      })],
    }
  },
})
