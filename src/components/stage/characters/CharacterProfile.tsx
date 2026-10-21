import { useId, useState, type ReactNode } from 'react'
import { Ellipsis, Save, UserRound } from 'lucide-react'
import { CHARACTER_ROLES, getCharacterRoleLabels } from '../../../shared/character-role'
import { relationshipStorageFromEditor } from '../../../shared/relationship-presentation'
import { useCharacterStore, type CharacterCard } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { authorStateEdit, CHARACTER_STATE_FIELDS, stateFieldView } from '../../editor/character-state-fields'
import RelationshipGraph from '../../editor/RelationshipGraph'
import { useCharacterAvatar } from '../../editor/use-character-avatar'
import { useCharacterProfile } from '../../editor/use-character-profile'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { EmptyState } from '../../ui/EmptyState'
import { Menu } from '../../ui/Menu'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { pluralEn } from '../../../shared/plural-en'

type ProfileView = 'edit' | 'state' | 'graph'
type TextField = Exclude<keyof CharacterCard, 'name' | 'characterId' | 'role' | 'currentState'>

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="cast-field">
      <div className="cast-field-label">
        <label htmlFor={id}>{label}</label>
        {hint && <span className="cast-field-hint">{hint}</span>}
      </div>
      {children(id)}
    </div>
  )
}

/** 角色档案：基础设定、当前状态、关系图谱三个视图，保存与删除。数据与操作沿用 CharacterEditor 的 useCharacterProfile。 */
export default function CharacterProfile({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const profile = useCharacterProfile(projectKey)
  const currentDerivedFields = useCharacterStore(s => s.currentDerivedFields)
  const { characters, selectedId, selectedCard: card, dataReady, identityBusy } = profile
  const [view, setView] = useState<ProfileView>('edit')
  const [confirming, setConfirming] = useState<'selected' | 'all' | null>(null)
  const avatar = useCharacterAvatar(card?.characterId ?? null, dataReady && view === 'edit')
  const roleText = (role: unknown) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const name = card?.name || text('未命名', 'Untitled')

  const confirmDelete = async () => {
    const scope = confirming
    if (!scope) return
    const session = profile.beginDelete(scope)
    if (!session) return
    if (scope === 'selected') await profile.deleteSelected(session)
    else await profile.deleteAll(session)
  }

  const textArea = (field: TextField, label: string, rows: number, hint?: string) => (
    <Field label={label} hint={hint}>
      {id => (
        <textarea id={id} className="pi-input cast-input cast-textarea" rows={rows}
          value={card?.[field] ?? ''} onChange={event => profile.updateCurrentField(selectedId!, field, event.target.value)} />
      )}
    </Field>
  )

  const viewOptions = [
    { value: 'edit' as const, label: text('基础设定', 'Profile') },
    { value: 'state' as const, label: text('当前状态', 'Current state') },
    { value: 'graph' as const, label: text('关系图谱', 'Relationship graph') },
  ]

  const menu = (
    <Menu
      label={text('角色的更多操作', 'More for this character')}
      icon={<Ellipsis size={16} aria-hidden />}
      align="end"
      groups={[{ id: 'danger', label: text('危险', 'Danger'), tone: 'danger', items: [
        ...(card ? [{ id: 'delete', label: text(`删除角色「${name}」…`, `Delete “${name}”…`), disabled: identityBusy || !dataReady, onSelect: () => setConfirming('selected') }] : []),
        { id: 'delete-all', label: text('删除全部角色与关系…', 'Delete all characters and relationships…'), disabled: identityBusy || !dataReady || characters.length === 0, onSelect: () => setConfirming('all') },
      ] }]}
    />
  )

  return (
    <section className="cast-profile" aria-label={text('角色档案', 'Character profile')}>
      {card ? (
        <header className="cast-profile-head">
          {avatar.avatarUrl
            ? <img className="cast-profile-avatar" src={avatar.avatarUrl} alt={text(`${name}头像`, `${name} avatar`)} />
            : <span className="cast-profile-avatar" aria-hidden>{Array.from(card.name || '?')[0]}</span>}
          <div className="cast-profile-heading">
            <div className="cast-profile-titleline">
              <h1 className="cast-profile-name">{name}</h1>
              <span className="cast-role-badge">{roleText(card.role)}</span>
            </div>
            {card.currentState && card.currentState.updatedAtChapter > 0 && (
              <p className="cast-profile-sub">{text(`第 ${card.currentState.updatedAtChapter} 章更新了当前状态`, `Current state updated in chapter ${card.currentState.updatedAtChapter}`)}</p>
            )}
            {view === 'edit' && <div className="cast-avatar-actions">
              <Button variant="text" size="sm" disabled={avatar.busy || !card.characterId || card.characterId.startsWith('draft:')} onClick={() => { void avatar.chooseAvatar() }}>
                {avatar.avatarUrl ? text('更换头像', 'Replace avatar') : text('选择头像', 'Choose avatar')}
              </Button>
              {avatar.avatarUrl && <Button variant="text" size="sm" disabled={avatar.busy} onClick={avatar.stageRemoval}>{text('移除头像', 'Remove avatar')}</Button>}
              {avatar.staged && <Button variant="text" size="sm" disabled={avatar.busy} onClick={avatar.discardStaged}>{text('取消头像更改', 'Discard avatar change')}</Button>}
            </div>}
            {view === 'edit' && (!card.characterId || card.characterId.startsWith('draft:')) && <p className="cast-profile-note">{text('先保存角色，再选择头像。', 'Save the character before choosing an avatar.')}</p>}
            {avatar.staged && <p className="cast-profile-note">{text('头像更改在保存角色时提交。', 'The avatar change is committed when you save the character.')}</p>}
            {avatar.notice && <p className="cast-profile-error" role="alert">{avatar.notice}</p>}
            {profile.saveError && <p className="cast-profile-error" role="alert">{profile.saveError}</p>}
          </div>
          <div className="cast-profile-actions">
            <span className="cast-save-state" aria-live="polite">
              {profile.saving ? text('保存中…', 'Saving…') : profile.saveOutcome === 'failed' ? text('保存失败', 'Save failed') : profile.dirty ? text('未保存', 'Unsaved') : profile.saveOutcome === 'saved' ? text('已保存', 'Saved') : ''}
            </span>
            {menu}
            <Button variant="primary" disabled={identityBusy || !dataReady || profile.saving} onClick={() => { void profile.handleSave() }}>
              <Save size={14} aria-hidden />{text('保存角色', 'Save character')}
            </Button>
          </div>
        </header>
      ) : (
        <header className="cast-profile-head">
          <div className="cast-profile-heading"><h1 className="cast-profile-name">{text('角色档案', 'Character profile')}</h1></div>
          <div className="cast-profile-actions">{menu}</div>
        </header>
      )}

      <div className="cast-view-switch">
        <SegmentedControl label={text('档案视图', 'Profile view')} options={viewOptions} value={view} onChange={setView} />
        {view === 'state' && card && <span className="cast-view-note">{text('定稿后由 AI 按章节更新，也可以手动修正', 'Updated by AI after each finalized chapter; you can correct it by hand')}</span>}
      </div>

      <div className="cast-profile-body">
        {view === 'graph' ? (
          <div className="cast-graph">
            <RelationshipGraph
              characters={characters}
              selectedCharacterId={selectedId}
              onOpenCharacter={characterId => {
                useCharacterStore.getState().setSelectedId(characterId)
                setView('edit')
              }}
            />
          </div>
        ) : !card ? (
          <EmptyState
            icon={<UserRound size={22} aria-hidden />}
            heading={profile.lastError ? text('角色读取失败', 'Could not load characters') : text('选一位角色', 'Pick a character')}
            description={profile.lastError ?? text('在左侧名单里选一位角色查看和编辑档案，或新建一位。', 'Choose someone from the cast on the left, or add a new character.')}
            action={<Button variant="secondary" disabled={identityBusy || !dataReady} onClick={() => useCharacterStore.getState().addCharacter()}>{text('新建角色', 'New character')}</Button>}
          />
        ) : view === 'state' ? (
          <div className="cast-grid">
            {CHARACTER_STATE_FIELDS.map(([field, zh, en]) => {
              const state = stateFieldView(card, field, currentDerivedFields)
              const source = {
                historical: text('历史派生（非当前）', 'Historical derived value (not current)'),
                author: text('作者输入', 'Author input'),
                derived: text('定稿派生', 'Derived from finalized prose'),
                unknown: text('来源未知', 'Unknown source'),
              }[state.source]
              return (
                <Field key={field} label={text(zh, en)} hint={source}>
                  {id => (
                    <>
                      <textarea id={id} className="pi-input cast-input cast-textarea" rows={2} value={state.value}
                        onChange={event => profile.updateCurrentField(selectedId!, 'currentState', authorStateEdit(card, field, event.target.value))} />
                      {state.history && <p className="cast-field-history">{text('历史记录（来源已失效或未核验）：', 'History (source invalid or unverified): ')}{state.history}</p>}
                    </>
                  )}
                </Field>
              )
            })}
          </div>
        ) : (
          <div className="cast-grid">
            <div className="cast-row-fields">
              <Field label={text('姓名', 'Name')}>
                {id => <input id={id} className="pi-input cast-input" value={card.name} disabled={identityBusy}
                  onChange={event => profile.renameCurrentCharacter(selectedId!, event.target.value)} />}
              </Field>
              <Field label={text('性别', 'Gender')}>
                {id => <input id={id} className="pi-input cast-input" value={card.gender} onChange={event => profile.updateCurrentField(selectedId!, 'gender', event.target.value)} />}
              </Field>
              <Field label={text('年龄', 'Age')}>
                {id => <input id={id} className="pi-input cast-input" value={card.age} onChange={event => profile.updateCurrentField(selectedId!, 'age', event.target.value)} />}
              </Field>
              <Field label={text('定位', 'Role')}>
                {id => (
                  <select id={id} className="pi-input cast-input cast-select" value={card.role}
                    onChange={event => profile.updateCurrentField(selectedId!, 'role', event.target.value as CharacterCard['role'])}>
                    {CHARACTER_ROLES.map(role => <option key={role} value={role}>{roleText(role)}</option>)}
                  </select>
                )}
              </Field>
            </div>
            {textArea('appearance', text('外貌', 'Appearance'), 3)}
            {textArea('personality', text('性格', 'Personality'), 3)}
            {textArea('background', text('背景', 'Background'), 4)}
            {textArea('motivation', text('动机', 'Motivation'), 3)}
            {textArea('abilities', text('能力', 'Abilities'), 3)}
            <Field label={text('关系网', 'Relationships')} hint={text('每行一位', 'One per line')}>
              {id => (
                <textarea id={id} className="pi-input cast-input cast-textarea" rows={3} value={profile.relationshipEditorText}
                  placeholder={text('例如：陆云飞：竞争对手（权力斗争）', 'For example: Lu Yunfei: rival (power struggle)')}
                  onChange={event => profile.updateCurrentField(selectedId!, 'relationships', relationshipStorageFromEditor(event.target.value, {
                    identities: characters, selfCharacterId: card.characterId, selfName: card.name, previousStorage: card.relationships,
                  }))} />
              )}
            </Field>
            {textArea('arc', text('成长轨迹', 'Character arc'), 3)}
            {textArea('notes', text('备注', 'Notes'), 3, text('须在某章正文里明示的，另起一行写【第N章必现】具体要求', 'For a must-show requirement, use its own line: 【第N章必现】specific requirement'))}
          </div>
        )}
      </div>

      <DangerConfirm
        open={confirming !== null}
        onOpenChange={open => { if (!open) setConfirming(null) }}
        title={confirming === 'all' ? text('删除全部角色与关系？', 'Delete all characters and relationships?') : text(`删除角色「${name}」？`, `Delete “${name}”?`)}
        consequence={confirming === 'all'
          ? text(`将删除全部 ${characters.length} 位角色及其关系，角色名单全文与关系图谱随之清空。`, `${characters.length === 1 ? 'The only character and its relationships' : `All ${characters.length} ${pluralEn(characters.length, 'character')} and their relationships`} will be deleted. The cast text and the relationship graph are cleared with them.`)
          : text(`将从角色名单删除「${name}」和它的档案。`, `“${name}” and their profile will be removed from the cast.`)}
        recoverability={text('删除后无法撤销；做过项目备份的，可以从备份恢复。', 'This cannot be undone. If you made a project backup, you can restore from it.')}
        confirmLabel={confirming === 'all' ? text('删除全部', 'Delete all') : text('删除角色', 'Delete character')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { void confirmDelete() }}
      />
    </section>
  )
}
