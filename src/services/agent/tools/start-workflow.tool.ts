/**
 * start_workflow — 触发创作工作流
 */
import { buildAgentTool, createToolArtifact } from '../tool-registry'
import { launchCreativeWorkflow, type CreativeIntent } from '../../workflows/creative-workflow-launcher'
import { requireAgentProject } from './project-context'
import { DEFAULT_WRITING_LANGUAGE, writingLanguageText } from '../../../shared/writing-language'

export const startWorkflowTool = buildAgentTool({
  name: 'start_workflow',
  description: '触发 AI小说作家创作工作流。支持写稿、修稿、审稿、定稿、生成蓝图等工作流。这将在 AI 输出面板中执行对应的多步骤创作流程。',
  descriptionEn: 'Start an AI Novel Writer creative workflow for drafting, review, refinement, finalization, blueprint generation, or architecture generation.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: '工作流类型',
        descriptionEn: 'Workflow type',
        enum: ['generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint', 'generate_architecture'],
      },
      chapter_number: {
        type: 'number',
        description: '章节号（写稿/修稿/审稿/定稿必填）',
        descriptionEn: 'Chapter number, required for drafting, review, refinement, and finalization',
      },
    },
    required: ['workflow'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const writingLanguage = context?.writingLanguage ?? DEFAULT_WRITING_LANGUAGE
    const text = (zhCN: string, enUS: string) => writingLanguageText(writingLanguage, zhCN, enUS)
    const workflow = args.workflow as string
    const chapterNumber = args.chapter_number as number | undefined

    if (!workflow) {
      return { success: false, content: '', error: text('缺少 workflow 参数', 'The workflow argument is required') }
    }
    const { project, projectSession } = requireAgentProject(context)
    const projectPath = project.path
    const generationModelId = context?.selectedModelId?.trim() || undefined

    // 需要章节号的工作流
    const chapterWorkflows = ['generate_draft', 'review', 'refine', 'finalize']
    if (chapterWorkflows.includes(workflow) && chapterNumber === undefined) {
      return {
        success: false,
        content: '',
        error: text(
          `${workflow} 工作流需要指定 chapter_number 参数`,
          `The ${workflow} workflow requires a chapter_number argument`,
        ),
      }
    }

    const workflowNames: Record<string, readonly [string, string]> = {
      generate_draft: ['写稿', 'draft'],
      review: ['审稿', 'review'],
      refine: ['修稿', 'refinement'],
      finalize: ['定稿', 'finalization'],
      generate_blueprint: ['生成蓝图', 'blueprint generation'],
      generate_architecture: ['生成架构', 'architecture generation'],
    }

    const workflowName = workflowNames[workflow]
    const displayName = workflowName ? text(...workflowName) : workflow
    const chapterInfo = chapterNumber !== undefined
      ? text(`（第 ${chapterNumber} 章）`, ` (Chapter ${chapterNumber})`)
      : ''

    try {
      const receipt = await launchCreativeWorkflow({
        workflow,
        ...(chapterNumber === undefined ? {} : { chapterNumber }),
      } as CreativeIntent, projectSession, { generationModelId })

      return {
        success: true,
        content: text(
          `已启动「${displayName}${chapterInfo}」工作流（运行 ID：${receipt.runId}，状态：${receipt.status}）。`,
          `Started the ${displayName}${chapterInfo} workflow (run ID: ${receipt.runId}; status: ${receipt.status}).`,
        ),
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
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        content: '',
        error: writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail)
          ? `Could not start the ${displayName}${chapterInfo} workflow.`
          : detail,
      }
    }
  },
})
