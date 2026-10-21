import { useEffect, useRef } from 'react'
import { useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { refreshStageWork } from '../use-stage-work'
import CharacterProfile from './CharacterProfile'
import CharacterRoster from './CharacterRoster'
import CharacterSuggestions from './CharacterSuggestions'

/** 名单保存、删除或采纳建议后修订号前进；流程脊上架构的完成数含「角色名单」一节，随之重读。 */
function useRefreshSpineOnRosterChange(): void {
  const revision = useCharacterStore(s => s.rosterRevision)
  const seen = useRef(revision)
  useEffect(() => {
    if (revision === null || revision === seen.current) return
    seen.current = revision
    void refreshStageWork(useLocaleStore.getState().text)
  }, [revision])
}

/** 角色名单：架构阶段「角色名单」一节的完整页面。上方是待处理的角色建议，左侧名单，右侧档案与关系图谱。 */
export default function StageCharacters({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  useRefreshSpineOnRosterChange()
  return (
    <div className="cast-page" role="region" aria-label={text('角色名单', 'Cast')}>
      <CharacterSuggestions />
      <div className="cast-body">
        <CharacterRoster projectKey={projectKey} />
        <CharacterProfile projectKey={projectKey} />
      </div>
    </div>
  )
}
