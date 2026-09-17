import type { CharacterProposalBatch } from '../../shared/character-proposal'
import type { CharacterProposalChoices } from '../../services/character-proposal-choices'
import { useLocaleStore } from '../../stores/locale-store'
import { NativeSelect } from '../ui/NativeSelect'

/** Controlled author choices; the host owns confirmation, main owns the atomic effect. */
export function CharacterProposalSelectionPanel({ batch, identities, choices, onChange, disabled = false }: {
  batch: CharacterProposalBatch
  identities: Array<{ characterId: string; name: string; role?: string }>
  choices: CharacterProposalChoices
  onChange(choices: CharacterProposalChoices): void
  disabled?: boolean
}) {
  const text = useLocaleStore(state => state.text)
  if (choices.proposalBatchId !== batch.proposalBatchId || choices.revision !== batch.revision) return <p role="alert">{text('提议已改变，请重新载入选择。', 'The proposals changed. Reload the choices.')}</p>
  const active = new Set(choices.selections.filter(choice => choice.action !== 'keep-unresolved').map(choice => choice.selectionKey))
  const relations = batch.items.flatMap(item => item.relationships.flatMap(relation => relation.targetSelectionKey
    ? [{ sourceSelectionKey: item.selectionKey, targetSelectionKey: relation.targetSelectionKey, relation: relation.relation }] : []))
  return <section className="space-y-3" aria-label={text('批量选择角色采用方式', 'Choose character adoption in one batch')}>
    <p className="text-xs text-[var(--color-text-secondary)]">{text('同名或共享别名不会自动合并。可选择对应角色、新建或暂不采用；最后一次确认统一保存。', 'Matching names or shared aliases are not merged automatically. Choose a character, create one, or keep unresolved, then confirm the batch once.')}</p>
    {batch.items.map(item => {
      const choice = choices.selections.find(value => value.selectionKey === item.selectionKey)
      return <label className="block space-y-1" key={item.selectionKey}>
        <span>{item.fields.name} · {item.fields.role ?? text('角色候选', 'Character candidate')}</span>
        <span className="block text-xs text-[var(--color-text-secondary)]">{item.fields.background || item.sourceId}</span>
        <NativeSelect aria-label={text(`采用方式：${item.fields.name} · ${item.selectionKey}`, `Adoption: ${item.fields.name} · ${item.selectionKey}`)} disabled={disabled || batch.status !== 'pending-approval'}
          value={choice?.action === 'map' ? `map:${choice.characterId}` : choice?.action ?? 'keep-unresolved'}
          onChange={event => {
            const value = event.target.value
            const selection = value.startsWith('map:')
              ? { selectionKey: item.selectionKey, action: 'map' as const, characterId: value.slice(4) }
              : { selectionKey: item.selectionKey, action: value === 'create' ? 'create' as const : 'keep-unresolved' as const }
            const selections = choices.selections.filter(current => current.selectionKey !== item.selectionKey).concat(selection)
            const adopted = new Set(selections.filter(current => current.action !== 'keep-unresolved').map(current => current.selectionKey))
            onChange({ ...choices, selections, relationships: choices.relationships.filter(relation => adopted.has(relation.sourceSelectionKey) && !!relation.targetSelectionKey && adopted.has(relation.targetSelectionKey)) })
          }}>
          <option value="keep-unresolved">{text('暂不采用，保留候选', 'Keep unresolved')}</option>
          <option value="create">{text('新建独立角色', 'Create a separate character')}</option>
          {identities.map(identity => <option key={identity.characterId} value={`map:${identity.characterId}`}>{identity.name} · {identity.role ?? ''} · {identity.characterId.slice(-8)}</option>)}
        </NativeSelect>
      </label>
    })}
    {relations.map((relation, index) => <label className="flex gap-2 text-xs" key={`${relation.sourceSelectionKey}:${relation.targetSelectionKey}:${index}`}>
      <input type="checkbox" disabled={disabled || batch.status !== 'pending-approval' || !active.has(relation.sourceSelectionKey) || !active.has(relation.targetSelectionKey)}
        checked={choices.relationships.some(value => value.sourceSelectionKey === relation.sourceSelectionKey && value.targetSelectionKey === relation.targetSelectionKey && value.relation === relation.relation)}
        onChange={event => onChange({ ...choices, relationships: event.target.checked ? [...choices.relationships, relation] : choices.relationships.filter(value => !(value.sourceSelectionKey === relation.sourceSelectionKey && value.targetSelectionKey === relation.targetSelectionKey && value.relation === relation.relation)) })} />
      {batch.items.find(item => item.selectionKey === relation.sourceSelectionKey)?.fields.name} → {batch.items.find(item => item.selectionKey === relation.targetSelectionKey)?.fields.name}：{relation.relation}
    </label>)}
  </section>
}
