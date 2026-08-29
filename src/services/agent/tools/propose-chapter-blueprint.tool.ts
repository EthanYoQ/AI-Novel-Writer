import type { BlueprintData } from '../../../../electron/repositories/blueprint-repository'
import { ipc } from '../../ipc-client'
import { buildAgentTool } from '../tool-registry'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'
import type { ProposalFieldDiff } from './propose-novel-config.tool'

const STRING_FIELDS = new Set<keyof BlueprintData>([
  'title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes',
])

export type ChapterBlueprintProposal =
  | { valid: true; chapterNumber: number; changes: Partial<BlueprintData>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

function validateBlueprintChanges(args: Record<string, unknown>):
  | { valid: true; changes: Partial<BlueprintData> }
  | { valid: false; error: string } {
  const candidate = args.changes
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || Object.keys(candidate).length === 0) {
    return { valid: false, error: '缺少章节蓝图变更字段' }
  }
  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate as Record<string, unknown>)) {
    if (STRING_FIELDS.has(field as keyof BlueprintData)) {
      if (typeof proposed !== 'string') return { valid: false, error: `字段 ${field} 必须是文本` }
    } else if (field === 'characters') {
      if (!Array.isArray(proposed) || !proposed.every(item => typeof item === 'string')) {
        return { valid: false, error: '字段 characters 必须是文本数组' }
      }
    } else {
      return { valid: false, error: `未知章节蓝图字段：${field}` }
    }
    changes[field] = proposed
  }
  return { valid: true, changes: changes as Partial<BlueprintData> }
}

export function buildChapterBlueprintProposal(
  args: Record<string, unknown>,
  current: BlueprintData,
): ChapterBlueprintProposal {
  const chapterNumber = args.chapter_number
  if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0 || chapterNumber !== current.chapterNumber) {
    return { valid: false, error: '目标章节与当前蓝图不一致' }
  }
  const validated = validateBlueprintChanges(args)
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
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      chapter_number: { type: 'number', description: '目标章节号' },
      changes: { type: 'object', description: '章节蓝图允许字段及其建议值' },
    },
    required: ['chapter_number', 'changes'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const chapterNumber = args.chapter_number
    if (!Number.isInteger(chapterNumber) || (chapterNumber as number) <= 0) {
      return { success: false, content: '', error: '章节号无效' }
    }
    const validated = validateBlueprintChanges(args)
    if (!validated.valid) return { success: false, content: '', error: validated.error }
    const { project, projectSession } = requireAgentProject(context)
    const current = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-get', chapterNumber as number, project.path,
    )
    assertAgentProjectCurrent(context)
    if (!current) return { success: false, content: '', error: `第 ${chapterNumber} 章蓝图不存在` }
    const proposal = buildChapterBlueprintProposal(args, current)
    if (!proposal.valid) return { success: false, content: '', error: proposal.error }
    const result = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-upsert', { ...current, ...proposal.changes }, project.path,
    )
    assertAgentProjectCurrent(context)
    if (!result.success) return { success: false, content: '', error: result.error ?? '章节蓝图写入失败' }
    return { success: true, content: `第 ${chapterNumber} 章蓝图已更新（${proposal.diffs.length} 个字段）` }
  },
})
