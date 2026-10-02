import { useCallback } from 'react'
import { Network, Trash2, Users } from 'lucide-react'

import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useUiVersionStore, isModernShell } from '../../stores/ui-version-store'
import { openBuiltinEditor } from '../panels/sidebar/sidebar-file-openers'
import { Button } from '../ui/Button'
import { EmptyState as BaseEmptyState } from '../ui/EmptyState'
import RelationMap from './RelationMap'
import RelationshipGraph from './RelationshipGraph'
import { useClearAllCharacters } from './use-clear-all-characters'

/**
 * 人物关系图谱页（独立标签）。
 *
 * 先生：图谱不该塞在人物档案里 —— 那样打开之后就回不去档案了。所以它和档案一样
 * 由标签承载（对齐 demo 的 ensureTab({ id: 'relations', … })）：点「关系图谱」
 * 开一个标签，切走再回来关系还在，人物档案那个标签原地不动，点一下就回去。
 *
 * 界面版本分流与之前一致：
 *   · v2「墨纸书斋」→ RelationMap（视角权重化圈圈 + 右侧人物简介，移植自设计 demo）
 *   · v1 经典界面  → RelationshipGraph（产品原有的 Canvas 力导向图，保持原样）
 * 两者消费的是同一份角色数据与同一套关系解析，只读，不写库。
 */
export default function RelationsEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore((state) => state.currentProject)
  const characters = useCharacterStore((state) => state.characters)
  const selectedName = useCharacterStore((state) => state.selectedName)
  const identityBusy = useCharacterStore((state) => state.identityBusy)
  const dataProjectKey = useCharacterStore((state) => state.dataProjectKey)
  const loadingProjectKey = useCharacterStore((state) => state.loadingProjectKey)
  const lastError = useCharacterStore((state) => state.lastError)
  const setSelectedName = useCharacterStore((state) => state.setSelectedName)
  const isV2Ui = useUiVersionStore((state) => isModernShell(state.uiVersion))
  const text = useLocaleStore((state) => state.text)

  const dataReady = Boolean(
    currentProject?.path === projectKey
    && dataProjectKey === projectKey
    && loadingProjectKey === null
    && lastError === null,
  )
  const handleDeleteAll = useClearAllCharacters(projectKey)

  /**
   * 「查看详细档案」：把视角人物交给人物档案标签。
   * 之所以还是调用 openBuiltinEditor，是为了复用产品「同一页面只留一个标签」的规则 ——
   * 档案标签已开就激活它，没开才新建，绝不会堆出第二个档案标签。
   */
  const openProfile = useCallback((name: string) => {
    if (name) setSelectedName(name)
    openBuiltinEditor('character-editor', text('人物档案', 'Character profiles'), 'character')
  }, [setSelectedName, text])

  if (!dataReady || characters.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <BaseEmptyState
          icon={<Network size={36} />}
          message={lastError
            ? text(`角色卡读取失败：${lastError}`, `Could not load character cards: ${lastError}`)
            : (currentProject
              ? text('还没有角色卡，关系图谱是角色名单的投影', 'No character cards yet — the graph is a projection of the roster')
              : text('请先打开项目', 'Open a project first'))}
          opacity={currentProject ? 0.3 : 0.4}
        />
      </div>
    )
  }

  if (!isV2Ui) {
    /**
     * v1 经典界面保持原样：还是那条产品工具栏 + Canvas 力导向图。
     * 只有一处随「图谱独立成标签」而变 —— 原来的「编辑模式」（在同一页面内部换视图）
     * 换成「人物档案」：档案现在是自己的标签，点一下就切回去。
     */
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              {text('角色图谱', 'Character graph')}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteAll}
              disabled={identityBusy || !dataReady || characters.length === 0}
              title={text('清空图谱会删除作为事实源的全部角色', 'Clearing the graph deletes every character in the source roster')}
            >
              <Trash2 size={12} /> {text('删除全部角色与关系', 'Delete all characters and relationships')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openProfile(selectedName ?? '')}
              title={text('返回人物档案', 'Back to the character profile')}
            >
              <Users size={12} /> {text('人物档案', 'Character profiles')}
            </Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 relative">
          <RelationshipGraph characters={characters} />
        </div>
      </div>
    )
  }

  return (
    <RelationMap
      characters={characters}
      center={selectedName ?? ''}
      onSelectCenter={setSelectedName}
      onOpenProfile={openProfile}
      onDeleteAll={handleDeleteAll}
      deleteAllDisabled={identityBusy || !dataReady || characters.length === 0}
    />
  )
}
