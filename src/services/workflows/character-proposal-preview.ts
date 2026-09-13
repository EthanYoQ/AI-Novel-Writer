import type { CharacterProposalBatch } from '../../shared/character-proposal'
import { getCharacterRoleLabels } from '../../shared/character-role'

type Text = (zh: string, en: string) => string
/** Suggestions become effects only after the explicit approval step and main validation. */
export function defaultCharacterProposalSelections(batch: CharacterProposalBatch) {
  return batch.items.map(item => item.resolution.status === 'resolved'
    ? { selectionKey: item.selectionKey, action: 'map' as const, characterId: item.resolution.characterId }
    : item.resolution.status === 'unresolved' && item.resolution.candidateIds.length === 0
      ? { selectionKey: item.selectionKey, action: 'create' as const }
      : { selectionKey: item.selectionKey, action: 'keep-unresolved' as const })
}
/** Names are display labels. Only declared selection-key endpoints can become proposed edges. */
export function defaultCharacterProposalRelationships(batch: CharacterProposalBatch) {
  const adoptedKeys = new Set(defaultCharacterProposalSelections(batch)
    .filter(item => item.action !== 'keep-unresolved').map(item => item.selectionKey))
  return batch.items.flatMap(item => adoptedKeys.has(item.selectionKey)
    ? item.relationships.flatMap(relation => relation.targetSelectionKey && adoptedKeys.has(relation.targetSelectionKey)
      ? [{ sourceSelectionKey: item.selectionKey, targetSelectionKey: relation.targetSelectionKey, relation: relation.relation }]
      : []) : [])
}
export function formatCharacterProposalPreview(batch: CharacterProposalBatch, text: Text): string {
  if (!batch.items.length) return text('未发现明确角色，角色名单尚未更改。', 'No explicit characters were found; the roster is unchanged.')
  const labels: Record<string, string> = {
    role: text('角色定位', 'Role'), gender: text('性别', 'Gender'), age: text('年龄', 'Age'),
    appearance: text('外貌', 'Appearance'), personality: text('性格', 'Personality'),
    background: text('背景', 'Background'), abilities: text('能力', 'Abilities'),
    motivation: text('动机', 'Motivation'), arc: text('弧光', 'Arc'), notes: text('其他事实', 'Notes'),
  }
  const decisions = defaultCharacterProposalSelections(batch)
  return [batch.status === 'pending-approval' ? text('## 待确认角色提议', '## Character proposals awaiting confirmation')
    : text('## 已保存角色提议', '## Saved character proposals'),
    batch.status === 'pending-approval'
      ? text('候选已保存，尚未写入正式角色。确认仅采用以下明确项；身份不明的候选继续保留。',
        'Candidates are saved but are not formal characters. Confirmation adopts only clear items below; unresolved candidates remain available.')
      : batch.status === 'approved' ? text('采用决策已保存，未采用候选继续保留。', 'Adoption decisions are saved; unadopted candidates remain available.')
        : text('本次采用已取消，候选继续保留。', 'Adoption was cancelled; candidates remain available.'),
    ...batch.items.map((item, index) => [
      `### ${index + 1}. ${item.fields.name}`,
      `${text('来源', 'Source')}：${item.sourceId}`,
      batch.status !== 'pending-approval' ? '' : decisions[index].action === 'create' ? text('确认后：新建角色', 'On confirmation: create a character')
        : decisions[index].action === 'map' ? text('确认后：采用到已确定的角色', 'On confirmation: adopt into the identified character')
          : text('暂不采用：身份尚未明确，候选保持可读', 'Not adopted: identity is unresolved; the candidate remains readable'),
      ...Object.entries(item.fields).flatMap(([key, value]) => key !== 'name' && typeof value === 'string' && value
        ? [`- ${labels[key] ?? key}：${key === 'role' ? text(getCharacterRoleLabels(value).zhCN, getCharacterRoleLabels(value).enUS) : value}`] : []),
      ...item.relationships.map(relation => `- ${text('关系提议', 'Proposed relationship')}：${relation.targetName ?? batch.items.find(candidate => candidate.selectionKey === relation.targetSelectionKey)?.fields.name ?? text('待确认对象', 'Unresolved target')} · ${relation.relation}`),
    ].join('\n')),
  ].join('\n\n')
}
