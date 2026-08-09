import type { CharacterRosterSnapshot } from '../../shared/character-roster'

type Text = (zhCNText: string, enUSText: string) => string

export type CharacterRosterRepairPresentationKind =
  | 'empty'
  | 'ready'
  | 'repair_required'
  | 'adoption_required'
  | 'inconsistent'
  | 'failed_with_data_preserved'

export interface CharacterRosterRepairPresentation {
  kind: CharacterRosterRepairPresentationKind
  label: string
  description: string
  actionLabel?: string
  actionTitle?: string
}

/**
 * 将持久化状态翻译为作者能理解的动作。这里不做任何数据访问或自动修复，
 * 组件必须显式调用 repairArchCharacterCards 才会产生写入。
 */
export function getCharacterRosterRepairPresentation(
  snapshot: CharacterRosterSnapshot | null,
  text: Text,
  failure?: string | null,
): CharacterRosterRepairPresentation | null {
  if (failure) {
    return {
      kind: 'failed_with_data_preserved',
      label: text('修复未完成，数据已保留', 'Repair did not complete; data was preserved'),
      description: text(
        `原角色图谱和已有角色卡均未被覆盖。原因：${failure}`,
        `The original graph and existing cards were not overwritten. Reason: ${failure}`,
      ),
      actionLabel: text('重试安全修复', 'Retry safe repair'),
      actionTitle: text('重试不会覆盖既有角色卡；仅在完整校验成功后原子提交', 'A retry preserves existing cards and commits only after complete validation'),
    }
  }
  if (!snapshot) return null

  switch (snapshot.status) {
    case 'empty':
      return {
        kind: 'empty',
        label: text('尚未生成角色名单', 'Character roster not generated'),
        description: text('请通过 AI 生成角色图谱，系统会同步建立角色卡。', 'Generate character dynamics with AI to create the roster and cards together.'),
      }
    case 'ready':
      return {
        kind: 'ready',
        label: text('角色名单已就绪', 'Character roster ready'),
        description: text('角色卡和角色图谱已通过同一份结构化名单同步。', 'Cards and the character graph are synchronized from the same structured roster.'),
      }
    case 'legacy_repair_required':
      return {
        kind: 'repair_required',
        label: text('旧项目需要安全修复', 'Legacy project needs safe repair'),
        description: text('检测到旧角色图谱但没有角色卡。原文已保留；修复会先校验完整 JSON，再一次性写入。', 'A legacy graph has no cards. Its original text is preserved; repair validates complete JSON before one atomic write.'),
        actionLabel: text('修复角色名单', 'Repair character roster'),
        actionTitle: text('从保留的旧图谱证据建立角色卡；失败时不覆盖任何数据', 'Build cards from preserved legacy evidence; failures overwrite no data'),
      }
    case 'inconsistent':
      if (snapshot.migrationState === 'legacy_cards_preserved' && snapshot.entries.length > 0) {
        return {
          kind: 'adoption_required',
          label: text('既有角色卡待验证', 'Existing character cards need validation'),
          description: text('已有角色卡受到保护。请显式重建只读角色图谱，不会从旧 Markdown 覆盖角色卡。', 'Existing cards are protected. Explicitly rebuild the read-only graph; legacy Markdown will not overwrite cards.'),
          actionLabel: text('重建只读图谱', 'Rebuild read-only graph'),
          actionTitle: text('只校验并采用现有角色卡；不会调用模型或改写角色卡', 'Validate and adopt existing cards only; no model call or card overwrite'),
        }
      }
      return {
        kind: 'inconsistent',
        label: text('角色名单状态异常', 'Character roster state is inconsistent'),
        description: text('为避免覆盖数据，系统不会自动修复。请保留项目并联系支持。', 'To avoid overwriting data, the app will not repair automatically. Preserve the project and contact support.'),
      }
  }
}

export function canExplicitlyRepairCharacterRoster(
  presentation: CharacterRosterRepairPresentation | null,
): boolean {
  return presentation?.kind === 'repair_required'
    || presentation?.kind === 'adoption_required'
    || presentation?.kind === 'failed_with_data_preserved'
}
