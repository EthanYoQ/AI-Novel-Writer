import { ChevronLeft, ChevronRight, Plus, RotateCw, Search } from 'lucide-react'
import { getCharacterRoleLabels } from '../../../shared/character-role'
import { characterSelectionKey, useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { CharacterCardImportButton } from '../../characters/CharacterCardImportButton'
import { useCharacterList } from '../../characters/use-character-list'
import { Button } from '../../ui/Button'

/** 角色名单左栏：搜索、新建、导入角色卡、按页列出角色、刷新。列表逻辑沿用旧侧栏的 useCharacterList。 */
export default function CharacterRoster({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const list = useCharacterList()
  const selectedId = useCharacterStore(s => s.selectedId)
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const { characters, pageCharacters, filteredCharacters, visibleCharacters } = list
  const roleLabel = (role: unknown) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const footCount = text(`${visibleCharacters.length} 位角色 · 第 ${list.page + 1} / ${list.pageCount} 页`,
    `${visibleCharacters.length} ${visibleCharacters.length === 1 ? 'character' : 'characters'} · page ${list.page + 1} / ${list.pageCount}`)

  return (
    <aside className="cast-roster" aria-label={text('角色名单', 'Cast')}>
      <div className="cast-roster-tools">
        <label className="cast-search">
          <Search size={14} aria-hidden />
          <input
            className="cast-search-input"
            value={list.searchQuery}
            onChange={event => list.search(event.target.value)}
            aria-label={text('搜索角色', 'Search characters')}
            placeholder={text('搜索角色', 'Search characters')}
          />
        </label>
        <div className="cast-roster-actions">
          <Button variant="secondary" size="sm" disabled={identityBusy || !list.dataReady} onClick={() => useCharacterStore.getState().addCharacter()}>
            <Plus size={14} aria-hidden />{text('新建角色', 'New character')}
          </Button>
          <CharacterCardImportButton projectKey={projectKey} disabled={identityBusy || !list.dataReady} />
        </div>
      </div>
      <ul className="cast-list">
        {pageCharacters.map(character => {
          const key = characterSelectionKey(character, characters.indexOf(character))
          const avatar = character.characterId ? list.avatarUrls[character.characterId] : undefined
          const duplicate = visibleCharacters.filter(item => item.name === character.name).length > 1
          return (
            <li key={key}>
              <button
                type="button"
                className="cast-row pi-focusable"
                data-character-id={character.characterId}
                aria-pressed={selectedId === key}
                onClick={() => useCharacterStore.getState().setSelectedId(key)}
              >
                {avatar
                  ? <img className="cast-avatar" src={avatar} alt="" />
                  : <span className="cast-avatar" aria-hidden>{Array.from(character.name || '?')[0]}</span>}
                <span className="cast-row-name">{character.name || text('未命名', 'Untitled')}</span>
                <span className="cast-row-role">
                  {roleLabel(character.role)}{duplicate ? ` · ${character.background || character.characterId?.slice(-8)}` : ''}
                </span>
              </button>
            </li>
          )
        })}
        {visibleCharacters.length === 0 && (
          <li className="cast-list-empty">
            {list.lastError
              ? text(`角色列表读取失败：${list.lastError}`, 'Could not load character list.')
              : text('还没有角色。新建一位，或导入角色卡。', 'No characters yet. Add one or import character cards.')}
          </li>
        )}
        {visibleCharacters.length > 0 && filteredCharacters.length === 0 && (
          <li className="cast-list-empty">{text('没有匹配的角色', 'No matching characters')}</li>
        )}
      </ul>
      <footer className="cast-roster-foot">
        <span title={footCount}>{footCount}</span>
        <Button variant="icon" size="sm" aria-label={text('上一页角色', 'Previous character page')} disabled={list.page === 0} onClick={list.previousPage}><ChevronLeft size={14} /></Button>
        <Button variant="icon" size="sm" aria-label={text('下一页角色', 'Next character page')} disabled={list.page + 1 >= list.pageCount} onClick={list.nextPage}><ChevronRight size={14} /></Button>
        <Button variant="icon" size="sm" aria-label={text('刷新列表', 'Refresh list')} disabled={identityBusy || list.loadingProjectKey !== null}
          onClick={() => { void useCharacterStore.getState().load(projectKey) }}>
          <RotateCw size={14} />
        </Button>
      </footer>
    </aside>
  )
}
