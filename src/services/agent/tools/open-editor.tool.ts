/**
 * open_editor — 在编辑器中打开文件
 */
import { buildAgentTool, createToolArtifact } from '../tool-registry'
import { useEditorStore } from '../../../stores/editor-store'
import { ipc } from '../../ipc-client'
import { validatePath } from './safe-path'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'

export const openEditorTool = buildAgentTool({
  name: 'open_editor',
  description: '在 AI小说作家编辑器中打开指定文件的 Tab 页。用户可以直接在编辑器中查看和编辑内容。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录的文件路径',
      },
      tab_type: {
        type: 'string',
        description: 'Tab 类型',
        enum: ['chapter', 'outline', 'character', 'config', 'arch-file'],
        default: 'chapter',
      },
    },
    required: ['file_path'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const filePath = args.file_path as string
    const tabType = (args.tab_type as string) ?? 'chapter'

    if (!filePath) {
      return { success: false, content: '', error: '缺少 file_path 参数' }
    }

    const { project, projectSession } = requireAgentProject(context)

    const fullPath_check = validatePath(project.path, filePath)
    if (!fullPath_check.valid) {
      return { success: false, content: '', error: fullPath_check.error }
    }
    const fullPath = fullPath_check.fullPath

    // 读取文件内容
    const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-file', fullPath, project.path)
    assertAgentProjectCurrent(context)
    if (!result.success) {
      return { success: false, content: '', error: `文件读取失败：${result.error}` }
    }

    // 在编辑器中打开
    const fileName = filePath.split('/').pop() ?? filePath
    useEditorStore.getState().openFile({
      id: `agent-${Date.now()}`,
      name: fileName,
      type: tabType as 'chapter' | 'outline' | 'character' | 'config' | 'arch-file',
      filePath: fullPath,
      content: result.content,
      savedContent: result.content,
      projectKey: project.path,
    })

    return {
      success: true,
      content: `已在编辑器中打开：${fileName}`,
      artifacts: [createToolArtifact({
        type: 'tab_opened',
        path: fullPath,
        name: fileName,
        projectPath: project.path,
        projectSession,
      })],
    }
  },
})
