/**
 * write_file — 写入或修改项目文件
 */
import { buildAgentTool, createToolArtifact } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { validatePath } from './safe-path'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'
import { projectFactWorkflowForFilePath } from '../../project-fact-targets'

export const writeFileTool = buildAgentTool({
  name: 'write_file',
  description: '写入或修改项目内的文件。可用于创建新文件或覆盖已有文件内容。这是一个写入操作，需要用户确认。',
  descriptionEn: 'Create or overwrite a file in the project after user confirmation.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录的文件路径',
        descriptionEn: 'File path relative to the project root',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
        descriptionEn: 'File content to write',
      },
    },
    required: ['file_path', 'content'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const filePath = args.file_path as string
    const content = args.content as string

    if (!filePath || content === undefined) {
      return { success: false, content: '', error: text('缺少 file_path 或 content 参数', 'The file_path and content arguments are required') }
    }

    const reservedWorkflow = projectFactWorkflowForFilePath(filePath)
    if (reservedWorkflow) {
      return {
        success: false,
        content: '',
        error: text(
          `“${filePath}”是项目事实的保留语义目标；普通文件不会改变结构化项目。请改用 ${reservedWorkflow} 工作流。`,
          `"${filePath}" is reserved for structured project facts. Writing a plain file will not update the project; use the ${reservedWorkflow} workflow instead.`,
        ),
      }
    }

    const { project, projectSession } = requireAgentProject(context)

    // 路径安全校验
    const pathCheck = validatePath(project.path, filePath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: text(
        pathCheck.error,
        `The path "${filePath}" is outside the project directory. Only project files can be written.`,
      ) }
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
      const detail = result.error
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail ?? '')
          ? text('写入失败', 'Could not write the file')
          : detail ?? text('写入失败', 'Could not write the file'),
      }
    }

    return {
      success: true,
      content: text(`✅ 文件已写入：${filePath}（${content.length} 字符）`, `✅ File written: ${filePath} (${content.length} characters)`),
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
