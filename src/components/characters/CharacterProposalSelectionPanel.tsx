import type { CharacterProposalBatch } from '../../shared/character-proposal'
import { CHARACTER_ROLES, getCharacterRoleLabels } from '../../shared/character-role'
import type { CharacterProposalChoices } from '../../services/character-proposal-choices'
import { useLocaleStore } from '../../stores/locale-store'
import { NativeSelect } from '../ui/NativeSelect'

const editableFields = [
  ['name', '姓名', 'Name'], ['gender', '性别', 'Gender'], ['age', '年龄', 'Age'],
  ['appearance', '外貌', 'Appearance'], ['personality', '性格', 'Personality'],
  ['background', '背景', 'Background'], ['abilities', '能力', 'Abilities'],
  ['motivation', '动机', 'Motivation'], ['arc', '弧光', 'Arc'], ['notes', '备注', 'Notes'],
] as const

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
      const editable = batch.source.kind === 'generation' && batch.source.inputKind === 'planning-material'
      const edit = choices.edits?.find(value => value.selectionKey === item.selectionKey)
      const updateField = (field: string, value: string) => {
        const changed = { ...edit?.fields } as Record<string, string>
        if (value === (item.fields[field as keyof typeof item.fields] ?? '')) delete changed[field]
        else changed[field] = value
        const edits = (choices.edits ?? []).filter(value => value.selectionKey !== item.selectionKey)
        if (Object.keys(changed).length) edits.push({ selectionKey: item.selectionKey, fields: changed })
        onChange({ ...choices, edits })
      }
      return <div className="block space-y-1" key={item.selectionKey}>
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
            onChange({ ...choices, selections,
              edits: selection.action === 'keep-unresolved' ? choices.edits?.filter(edit => edit.selectionKey !== item.selectionKey) : choices.edits,
              relationships: choices.relationships.filter(relation => adopted.has(relation.sourceSelectionKey) && !!relation.targetSelectionKey && adopted.has(relation.targetSelectionKey)) })
          }}>
          <option value="keep-unresolved">{text('暂不采用，保留候选', 'Keep unresolved')}</option>
          <option value="create">{text('新建独立角色', 'Create a separate character')}</option>
          {identities.map(identity => <option key={identity.characterId} value={`map:${identity.characterId}`}>{identity.name} · {identity.role ?? ''} · {identity.characterId.slice(-8)}</option>)}
        </NativeSelect>
        {editable && choice?.action !== 'keep-unresolved' && <details className="text-xs" onClick={event => event.stopPropagation()}>
          <summary className="cursor-pointer">{text('编辑导入候选', 'Edit imported candidate')}</summary>
          <div className="grid grid-cols-1 gap-2 pt-2">
            {editableFields.map(([field, zh, en]) => <label key={field} className="grid gap-1">
              <span>{text(zh, en)}</span>
              <input aria-label={text(`编辑候选${zh}：${item.selectionKey}`, `Edit candidate ${en}: ${item.selectionKey}`)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
                disabled={disabled || batch.status !== 'pending-approval'}
                value={edit?.fields[field] ?? item.fields[field] ?? ''}
                onChange={event => updateField(field, event.target.value)} />
            </label>)}
            <label className="grid gap-1"><span>{text('角色定位', 'Role')}</span>
              <NativeSelect aria-label={text(`编辑候选角色定位：${item.selectionKey}`, `Edit candidate role: ${item.selectionKey}`)}
                disabled={disabled || batch.status !== 'pending-approval'} value={edit?.fields.role ?? item.fields.role ?? ''}
                onChange={event => updateField('role', event.target.value)}>
                <option value="">{text('未指定', 'Unspecified')}</option>
                {CHARACTER_ROLES.map(role => { const label = getCharacterRoleLabels(role); return <option key={role} value={role}>{text(label.zhCN, label.enUS)}</option> })}
              </NativeSelect>
            </label>
          </div>
        </details>}
      </div>
    })}
    {relations.map((relation, index) => <label className="flex gap-2 text-xs" key={`${relation.sourceSelectionKey}:${relation.targetSelectionKey}:${index}`}>
      <input type="checkbox" disabled={disabled || batch.status !== 'pending-approval' || !active.has(relation.sourceSelectionKey) || !active.has(relation.targetSelectionKey)}
        checked={choices.relationships.some(value => value.sourceSelectionKey === relation.sourceSelectionKey && value.targetSelectionKey === relation.targetSelectionKey && value.relation === relation.relation)}
        onChange={event => onChange({ ...choices, relationships: event.target.checked ? [...choices.relationships, relation] : choices.relationships.filter(value => !(value.sourceSelectionKey === relation.sourceSelectionKey && value.targetSelectionKey === relation.targetSelectionKey && value.relation === relation.relation)) })} />
      {batch.items.find(item => item.selectionKey === relation.sourceSelectionKey)?.fields.name} → {batch.items.find(item => item.selectionKey === relation.targetSelectionKey)?.fields.name}：{relation.relation}
    </label>)}
  </section>
}
