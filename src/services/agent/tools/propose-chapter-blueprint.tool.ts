import type { BlueprintData } from '../../../../electron/repositories/blueprint-repository'
import { ipc } from '../../ipc-client'
import { buildAgentTool, type AgentExecutionContext } from '../tool-registry'
import { agentToolText, assertAgentProjectCurrent, requireAgentProject } from './project-context'
import type { ProposalFieldDiff } from './propose-novel-config.tool'

const STRING_FIELDS = new Set<keyof BlueprintData>([
  'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
])
const FIELD_ALIASES: Record<string, keyof BlueprintData> = {
  '作者微操指导': 'userGuidance',
  '用户指引': 'userGuidance',
}

export type ChapterBlueprintProposal =
  | { valid: true; chapterNumber: number; changes: Partial<BlueprintData>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

function validateBlueprintChanges(args: Record<string, unknown>, context?: AgentExecutionContext):
  | { valid: true; changes: Partial<BlueprintData> }
  | { valid: false; error: string } {
  const candidate = args.changes
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length === 0) {
    return { valid: false, error: agentToolText(context, '缺少章节蓝图变更字段', 'No chapter blueprint changes were provided') }
  }
  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate as Record<string, unknown>)) {
    const canonicalField = FIELD_ALIASES[field] ?? field
    if (STRING_FIELDS.has(canonicalField as keyof BlueprintData)) {
      if (typeof proposed !== 'string') return { valid: false, error: agentToolText(context, `字段 ${field} 必须是文本`, `Field ${field} must be text`) }
    } else if (canonicalField === 'characters') {
      if (!Array.isArray(proposed) || !proposed.every(item => typeof item === 'string')) {
        return { valid: false, error: agentToolText(context, '字段 characters 必须是文本数组', 'Field characters must be an array of text values') }
      }
    } else {
      return { valid: false, error: agentToolText(context, `未知章节蓝图字段：${field}`, `Unknown chapter blueprint field: ${field}`) }
    }
    changes[canonicalField] = proposed
  }
  return { valid: true, changes: changes as Partial<BlueprintData> }
}

export function buildChapterBlueprintProposal(
  args: Record<string, unknown>,
  current: BlueprintData,
  context?: AgentExecutionContext,
): ChapterBlueprintProposal {
  const chapterNumber = args.chapter_number
  if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0 || chapterNumber !== current.chapterNumber) {
    return { valid: false, error: agentToolText(context, '目标章节与当前蓝图不一致', 'The target chapter does not match the current blueprint') }
  }
  const validated = validateBlueprintChanges(args, context)
  if (!validated.valid) return validated
  const changes = validated.changes
  return {
    valid: true,
    chapterNumber: chapterNumber as number,
    changes,
    diffs: Object.entries(changes).map(([field, proposed]) => ({
      field,
      current: current[field as keyof BlueprintData],
      proposed,
    })),
  }
}

export const proposeChapterBlueprintTool = buildAgentTool({
  name: 'propose_chapter_blueprint',
  description: '提出一个现有章节蓝图的字段变更。应用会读取目标蓝图并展示当前值与建议值，必须由用户批准后才写入。',
  descriptionEn: 'Propose field changes to an existing chapter blueprint. The app shows the current and proposed values and writes only after user approval.',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      chapter_number: { type: 'number', description: '目标章节号', descriptionEn: 'Target chapter number' },
      changes: {
        type: 'object',
        description: '章节蓝图建议值。字段使用 title、role、purpose、keyEvents、characters、suspenseHook、userGuidance、notes；“作者微操指导”或“用户指引”也会规范化为 userGuidance。',
        descriptionEn: 'Proposed blueprint values. Use title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, and notes.',
      },
    },
    required: ['chapter_number', 'changes'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const text = (zhCN: string, enUS: string) => agentToolText(context, zhCN, enUS)
    const chapterNumber = args.chapter_number
    if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
      return { success: false, content: '', error: text('章节号无效', 'The chapter number is invalid') }
    }
    const validated = validateBlueprintChanges(args, context)
    if (!validated.valid) return { success: false, content: '', error: validated.error }
    const { project, projectSession } = requireAgentProject(context)
    const current = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-get', chapterNumber as number, project.path,
    )
    assertAgentProjectCurrent(context)
    if (!current) return { success: false, content: '', error: text(`第 ${chapterNumber} 章蓝图不存在`, `The blueprint for Chapter ${chapterNumber} does not exist`) }
    const proposal = buildChapterBlueprintProposal(args, current, context)
    if (!proposal.valid) return { success: false, content: '', error: proposal.error }
    const result = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-upsert', { ...current, ...proposal.changes }, project.path,
    )
    assertAgentProjectCurrent(context)
    if (!result.success) {
      const detail = result.error
      return {
        success: false,
        content: '',
        error: context?.writingLanguage === 'en-US' && /[\u3400-\u9fff]/u.test(detail ?? '')
          ? text('章节蓝图写入失败', 'Could not update the chapter blueprint')
          : detail ?? text('章节蓝图写入失败', 'Could not update the chapter blueprint'),
      }
    }
    return { success: true, content: text(`第 ${chapterNumber} 章蓝图已更新（${proposal.diffs.length} 个字段）`, `Chapter ${chapterNumber} blueprint updated (${proposal.diffs.length} fields)`) }
  },
})
