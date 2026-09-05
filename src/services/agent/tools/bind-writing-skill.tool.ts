import { WRITING_SKILL_STAGES, type WritingSkillStage } from '../../../shared/writing-skills'
import { saveWritingSkillBinding } from '../writing-skill-bindings'
import { skillRegistry } from '../skill-registry'
import { buildAgentTool } from '../tool-registry'
import { agentToolText, requireAgentProject } from './project-context'

export const bindWritingSkillTool = buildAgentTool({
  name: 'bind_writing_skill',
  userFacingName: '绑定写作 Skill',
  description: '在用户确认后，把一个已安装且兼容的写作 Skill 绑定到当前项目的一个创作阶段；同阶段原绑定会被替换。',
  descriptionEn: 'After explicit user confirmation, bind one installed, compatible writing Skill to one stage of the current project, replacing the previous binding for that stage.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: '已检查并安装的 Skill 标识，例如 user:scene-craft',
        descriptionEn: 'Identifier of an inspected and installed Skill, for example user:scene-craft',
      },
      stage: {
        type: 'string',
        enum: [...WRITING_SKILL_STAGES],
        description: 'planning、drafting、review 或 refinement',
        descriptionEn: 'One of planning, drafting, review, or refinement',
      },
    },
    required: ['skill_id', 'stage'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const skillId = args.skill_id
    const stage = args.stage
    if (typeof skillId !== 'string' || !WRITING_SKILL_STAGES.includes(stage as WritingSkillStage)) {
      return { success: false, content: '', error: text('skill_id 或 stage 无效', 'The skill_id or stage is invalid') }
    }
    const skill = skillRegistry.getById(skillId)
    if (!skill || !skill.writingSkill.compatible) {
      return { success: false, content: '', error: text('该 Skill 不存在或不兼容提示词型写作流程', 'The Skill does not exist or is incompatible with the prompt-only writing workflow') }
    }
    const { projectSession } = requireAgentProject(context)
    await saveWritingSkillBinding(projectSession, stage as WritingSkillStage, skillId)
    return {
      success: true,
      content: text(
        `已将“${skill.metadata.displayName ?? skill.metadata.name}”绑定到 ${stage} 阶段。`,
        `Bound "${skill.metadata.displayName ?? skill.metadata.name}" to the ${stage} stage.`,
      ),
    }
  },
})
