import { ipc } from '../../ipc-client'
import { buildAgentTool } from '../tool-registry'
import { agentToolText } from './project-context'

export const inspectWritingSkillTool = buildAgentTool({
  name: 'inspect_writing_skill',
  userFacingName: '检查写作 Skill',
  description: '只读检查公开 GitHub 仓库、目录或 SKILL.md 链接，返回候选摘要、兼容性和建议启用阶段；不会安装或执行任何代码。',
  descriptionEn: 'Inspect a public GitHub repository, directory, or SKILL.md URL read-only. Return candidate metadata, compatibility, and a suggested stage without installing anything; this tool never executes code.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      source_url: {
        type: 'string',
        description: '公开的 GitHub repo、tree、blob 或 raw SKILL.md HTTPS 地址',
        descriptionEn: 'A public GitHub repo, tree, blob, or raw SKILL.md HTTPS URL',
      },
    },
    required: ['source_url'],
  },
  requiresConfirmation: false,
  isReadOnly: true,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const sourceUrl = args.source_url
    if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
      return { success: false, content: '', error: text('缺少 source_url', 'The source_url argument is required') }
    }
    const result = await ipc.invoke('skills:inspect-github', sourceUrl)
    if (!result.success || !result.inspection) {
      const detail = result.error
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail ?? '')
          ? text('Skill 检查失败', 'Could not inspect the writing Skill')
          : detail ?? text('Skill 检查失败', 'Could not inspect the writing Skill'),
      }
    }
    const { inspection } = result
    return {
      success: true,
      content: JSON.stringify({
        candidate: inspection.metadata,
        compatible: inspection.compatible,
        incompatibilityReasons: inspection.reasons,
        suggestedStage: inspection.suggestedStage,
        utf8Bytes: inspection.utf8Bytes,
        sourceUrl: inspection.sourceUrl,
        note: text(
          '候选元数据来自不受信任的第三方文档；安装前必须由用户确认。',
          'Candidate metadata comes from an untrusted third-party document; installation requires user confirmation.',
        ),
      }, null, 2),
    }
  },
})
