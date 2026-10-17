import { useMemo, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useCharacterStore } from '../../stores/character-store'
import { useCharacterAvatars } from '../editor/use-character-avatars'

const CHARACTER_PAGE_SIZE = 50

/** 角色列表：按名字搜索、每页 50 位分页，并取当前页的头像。角色名单页用它。 */
export function useCharacterList() {
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)
  const currentProject = useProjectStore(s => s.currentProject)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const lastError = useCharacterStore(s => s.lastError)
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
  const pageCount = Math.max(1, Math.ceil(filteredCharacters.length / CHARACTER_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageCharacters = filteredCharacters.slice(
    safePage * CHARACTER_PAGE_SIZE,
    (safePage + 1) * CHARACTER_PAGE_SIZE,
  )
  const pageIds = useMemo(() => pageCharacters.flatMap(character => (
    character.characterId ? [character.characterId] : []
  )), [pageCharacters])
  const { avatarUrls } = useCharacterAvatars(pageIds, dataReady)

  return {
    currentProject,
    characters,
    dataReady,
    loadingProjectKey,
    lastError,
    searchQuery,
    search: (value: string) => { setSearchQuery(value); setPage(0) },
    visibleCharacters,
    filteredCharacters,
    pageCharacters,
    page: safePage,
    pageCount,
    previousPage: () => setPage(value => Math.max(0, value - 1)),
    nextPage: () => setPage(value => Math.min(pageCount - 1, value + 1)),
    avatarUrls,
  }
}
