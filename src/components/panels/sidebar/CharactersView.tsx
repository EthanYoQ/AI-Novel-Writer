/**
 * CharactersView — 角色管理列表视图
 */

import { useState } from 'react'
import { Users, RefreshCw, Plus, Search } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useCharacterStore } from '../../../stores/character-store'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { EmptyState } from '../../ui/EmptyState'
import { cn } from '../../../lib/utils'
import { useLocaleStore } from '../../../stores/locale-store'
import { getCharacterRoleLabels } from '../../../shared/character-role'

export default function CharactersView() {
  const [searchQuery, setSearchQuery] = useState('')
  const currentProject = useProjectStore(s => s.currentProject)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const selectedName = useCharacterStore(s => s.selectedName)
  const load = useCharacterStore(s => s.load)
  const setSelectedName = useCharacterStore(s => s.setSelectedName)
  const addCharacter = useCharacterStore(s => s.addCharacter)
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const lastError = useCharacterStore(s => s.lastError)
  const text = useLocaleStore(s => s.text)
  const roleLabel = (role: unknown) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const dataReady = Boolean(
    currentProject
    && dataProjectKey === currentProject.path
    && loadingProjectKey === null
    && lastError === null,
  )
  const visibleCharacters = dataReady ? characters : []
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const filteredCharacters = normalizedQuery
    ? visibleCharacters.filter(character => character.name.toLocaleLowerCase().includes(normalizedQuery))
    : visibleCharacters

  // 角色数据由 ProjectService 统一加载，组件只消费 store 数据

  if (!currentProject) {
    return (
      <EmptyState 
        icon={<Users size={36} />} 
        message={text('请先打开项目', 'Open a project first')}
        className="pb-[15vh]" 
        opacity={0.4} 
      />
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-3 h-9 flex-shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text)] flex items-center gap-1">
          <Users size={13} />
          {text(`角色列表（${visibleCharacters.length}）`, `Characters (${visibleCharacters.length})`)}
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => load(currentProject.path)} disabled={identityBusy || loadingProjectKey !== null} title={text('刷新列表', 'Refresh list')}>
            <RefreshCw size={14} strokeWidth={2} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={addCharacter} disabled={identityBusy || !dataReady} title={text('新建角色', 'New character')}>
            <Plus size={14} strokeWidth={2} />
          </Button>
        </div>
      </div>
      <div className="relative px-2 py-1.5 border-b border-[var(--color-border)]">
        <Search size={12} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <Input
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          aria-label={text('搜索角色', 'Search characters')}
          placeholder={text('搜索角色名称', 'Search character names')}
          className="h-7 pl-7 text-xs"
        />
      </div>
      {/* 角色列表 */}
      <div className="flex-1 overflow-y-auto p-1">
        {filteredCharacters.map((c) => (
          <div
            key={c.name}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs cursor-pointer mb-0.5',
              selectedName === c.name
                ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
            )}
            onClick={() => setSelectedName(c.name)}
          >
            <div className="font-medium">{c.name || text('未命名', 'Untitled')}</div>
            <div className="text-[0.7rem] mt-0.5 opacity-60">{roleLabel(c.role)}</div>
            {c.currentState && (
              <div className="text-[0.65rem] mt-0.5 opacity-50">
                {text(`第${c.currentState.updatedAtChapter}章更新`, `Updated in chapter ${c.currentState.updatedAtChapter}`)}
              </div>
            )}
          </div>
        ))}
        {visibleCharacters.length === 0 && (
          <div className="text-center py-6 opacity-50 text-xs">
            {lastError
                ? text(`角色列表读取失败：${lastError}`, 'Could not load character list.')
              : text('暂无角色', 'No characters')}
          </div>
        )}
        {visibleCharacters.length > 0 && filteredCharacters.length === 0 && (
          <div className="text-center py-6 opacity-50 text-xs">
            {text('没有匹配的角色', 'No matching characters')}
          </div>
        )}
      </div>
    </div>
  )
}
