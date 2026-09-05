import { ipc } from '../../ipc-client'
import { skillRegistry } from '../skill-registry'
import { buildAgentTool } from '../tool-registry'
import { agentToolText } from './project-context'

export const installWritingSkillTool = buildAgentTool({
  name: 'install_writing_skill',
  userFacingName: '安装写作 Skill',
  description: '在用户确认后，从已给出的公开 GitHub 地址重新检查并安装自包含的提示词型 Skill。不能接收或执行脚本、工具、hook 或子代理。',
  descriptionEn: 'After explicit user confirmation, re-inspect and install a self-contained prompt-only writing Skill from its public GitHub URL. A candidate must be inspected before installation. Scripts, tools, hooks, and subagents are rejected; this tool never executes code.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      source_url: {
        type: 'string',
        description: '此前已只读检查的公开 GitHub 地址；主进程会重新下载并验证',
        descriptionEn: 'The previously inspected public GitHub URL; the main process downloads and validates it again',
      },
    },
    required: ['source_url'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const sourceUrl = args.source_url
    if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
      return { success: false, content: '', error: text('缺少 source_url', 'The source_url argument is required') }
    }
    const result = await ipc.invoke('skills:install-github', sourceUrl)
    if (!result.success || !result.skill) {
      const detail = result.error
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail ?? '')
          ? text('Skill 安装失败', 'Could not install the writing Skill')
          : detail ?? text('Skill 安装失败', 'Could not install the writing Skill'),
      }
    }
    await skillRegistry.loadAll()
    return {
      success: true,
      content: text(
        `已安装写作 Skill“${result.skill.name}”。它尚未绑定到项目阶段。`,
        `Installed writing Skill "${result.skill.name}". It is not bound to a project stage yet.`,
      ),
    }
  },
})
