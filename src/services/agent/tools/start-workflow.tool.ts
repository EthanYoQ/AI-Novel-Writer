/**
 * start_workflow — 触发创作工作流
 */
import { buildAgentTool, createToolArtifact } from '../tool-registry'
import { launchCreativeWorkflow, type CreativeIntent } from '../../workflows/creative-workflow-launcher'
import { requireAgentProject } from './project-context'

export const startWorkflowTool = buildAgentTool({
  name: 'start_workflow',
  description: '触发 AI小说作家创作工作流。支持写稿、修稿、审稿、定稿、生成蓝图等工作流。这将在 AI 输出面板中执行对应的多步骤创作流程。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: '工作流类型',
        enum: ['generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint', 'generate_architecture'],
      },
      chapter_number: {
        type: 'number',
        description: '章节号（写稿/修稿/审稿/定稿必填）',
      },
    },
    required: ['workflow'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const workflow = args.workflow as string
    const chapterNumber = args.chapter_number as number | undefined

    if (!workflow) {
      return { success: false, content: '', error: '缺少 workflow 参数' }
    }
    const { project, projectSession } = requireAgentProject(context)
    const projectPath = project.path

    // 需要章节号的工作流
    const chapterWorkflows = ['generate_draft', 'review', 'refine', 'finalize']
    if (chapterWorkflows.includes(workflow) && chapterNumber === undefined) {
      return { success: false, content: '', error: `${workflow} 工作流需要指定 chapter_number 参数` }
    }

    const workflowNames: Record<string, string> = {
      generate_draft: '写稿',
      review: '审稿',
      refine: '修稿',
      finalize: '定稿',
      generate_blueprint: '生成蓝图',
      generate_architecture: '生成架构',
    }

    const displayName = workflowNames[workflow] ?? workflow
    const chapterInfo = chapterNumber !== undefined ? `（第 ${chapterNumber} 章）` : ''

    try {
      const receipt = await launchCreativeWorkflow({
        workflow,
        ...(chapterNumber === undefined ? {} : { chapterNumber }),
      } as CreativeIntent, projectSession)

      return {
        success: true,
        content: `已启动「${displayName}${chapterInfo}」工作流（运行 ID：${receipt.runId}，状态：${receipt.status}）。`,
        artifacts: [createToolArtifact({
          type: 'workflow_started',
          name: `${displayName}${chapterInfo}`,
          projectPath,
          projectSession,
          runId: receipt.runId,
          status: receipt.status,
        })],
      }
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : String(error) }
    }
  },
})
