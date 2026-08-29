import type { NovelConfig } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { buildAgentTool } from '../tool-registry'
import { assertAgentProjectCurrent, requireAgentProject } from './project-context'

const STRING_FIELDS = new Set<keyof NovelConfig>([
  'genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'goldenFinger',
  'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks',
])
const NUMBER_FIELDS = new Set<keyof NovelConfig>(['totalChapters', 'wordsPerChapter'])
const ENUM_FIELDS: Partial<Record<keyof NovelConfig, readonly string[]>> = {
  plotStructure: ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'],
  narrativePOV: ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'],
  writingLanguage: ['zh-CN', 'en-US'],
}

export interface ProposalFieldDiff {
  field: string
  current: unknown
  proposed: unknown
}

export type NovelConfigProposal =
  | { valid: true; changes: Partial<NovelConfig>; diffs: ProposalFieldDiff[] }
  | { valid: false; error: string }

function plainChanges(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.changes
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function buildNovelConfigProposal(
  args: Record<string, unknown>,
  current: NovelConfig,
): NovelConfigProposal {
  const candidate = plainChanges(args)
  if (!candidate || Object.keys(candidate).length === 0) return { valid: false, error: '缺少小说配置变更字段' }
  const changes: Record<string, unknown> = {}
  for (const [field, proposed] of Object.entries(candidate)) {
    if (STRING_FIELDS.has(field as keyof NovelConfig)) {
      if (typeof proposed !== 'string') return { valid: false, error: `字段 ${field} 必须是文本` }
    } else if (NUMBER_FIELDS.has(field as keyof NovelConfig)) {
      if (!Number.isInteger(proposed) || (proposed as number) <= 0) return { valid: false, error: `字段 ${field} 必须是正整数` }
    } else if (field in ENUM_FIELDS) {
      if (!ENUM_FIELDS[field as keyof NovelConfig]?.includes(String(proposed))) {
        return { valid: false, error: `字段 ${field} 的值不受支持` }
      }
    } else {
      return { valid: false, error: `未知小说配置字段：${field}` }
    }
    changes[field] = proposed
  }
  return {
    valid: true,
    changes: changes as Partial<NovelConfig>,
    diffs: Object.entries(changes).map(([field, proposed]) => ({
      field,
      current: current[field as keyof NovelConfig],
      proposed,
    })),
  }
}

export const proposeNovelConfigTool = buildAgentTool({
  name: 'propose_novel_config',
  description: '提出小说配置字段变更。参数只包含候选值；应用会展示当前值与建议值，必须由用户批准后才写入。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      changes: { type: 'object', description: '小说配置允许字段及其建议值' },
    },
    required: ['changes'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args, context) => {
    const { project, projectSession } = requireAgentProject(context)
    const proposal = buildNovelConfigProposal(args, project.novelConfig)
    if (!proposal.valid) return { success: false, content: '', error: proposal.error }
    const nextConfig = { ...project.novelConfig, ...proposal.changes }
    const result = await ipc.invokeWithProjectSession(
      projectSession, 'project:update-config', project.id, { novelConfig: nextConfig }, project.path,
    )
    assertAgentProjectCurrent(context)
    if (!result.success) return { success: false, content: '', error: result.error ?? '小说配置写入失败' }
    useProjectStore.getState().updateNovelConfig(proposal.changes, projectSession)
    return { success: true, content: `小说配置已更新（${proposal.diffs.length} 个字段）` }
  },
})
