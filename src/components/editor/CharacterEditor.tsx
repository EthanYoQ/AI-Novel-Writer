import { useState } from 'react'
import { Save, Trash2, Users, Network, ClipboardList } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { confirm } from '../ui/Confirm'
import {
  useCharacterStore,
  EMPTY_STATE,
  type CharacterCard,
  type CharacterCurrentState,
} from '../../stores/character-store'
import RelationshipGraph from './RelationshipGraph'
import { EmptyState as BaseEmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { useLocaleStore } from '../../stores/locale-store'
import { CHARACTER_ROLES, getCharacterRoleLabels } from '../../shared/character-role'
import {
  formatRelationshipsForEditor,
  relationshipStorageFromEditor,
} from '../../shared/relationship-presentation'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'

/**
 * 角色卡编辑器 — 纯编辑区域（角色列表已移至侧栏）
 * 从 character-store 读取选中角色，仅渲染编辑表单。
 */
export default function CharacterEditor({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  const addLog = useWorkflowStore(s => s.addLog)
  const characters = useCharacterStore(s => s.characters)
  const dataProjectKey = useCharacterStore(s => s.dataProjectKey)
  const loadingProjectKey = useCharacterStore(s => s.loadingProjectKey)
  const lastError = useCharacterStore(s => s.lastError)
  const selectedName = useCharacterStore(s => s.selectedName)
  const saving = useCharacterStore(s => s.saving)
  const identityBusy = useCharacterStore(s => s.identityBusy)
  const renameCharacter = useCharacterStore(s => s.renameCharacter)
  const updateField = useCharacterStore(s => s.updateField)
  const deleteCharacter = useCharacterStore(s => s.deleteCharacter)
  const saveAll = useCharacterStore(s => s.saveAll)
  const [viewMode, setViewMode] = useState<'edit' | 'state' | 'graph'>('edit')
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const roleLabel = (role: CharacterCard['role']) => {
    const { zhCN, enUS } = getCharacterRoleLabels(role)
    return text(zhCN, enUS)
  }
  const projectMatches = currentProject?.path === projectKey
  const dataReady = Boolean(
    projectMatches
    && dataProjectKey === projectKey
    && loadingProjectKey === null
    && lastError === null,
  )

  // 数据由 ProjectService 统一加载，组件只消费 store 数据

  const selectedCard = dataReady
    ? characters.find((c) => c.name === selectedName) || null
    : null
  const relationshipEditorText = selectedCard
    ? formatRelationshipsForEditor(selectedCard.relationships, { locale })
    : ''

  const handleDelete = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!selectedCard || !projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const ok = await confirm(
      text(`确定要删除角色「${selectedCard.name || '未命名'}」吗？此操作不可撤销。`, `Delete character “${selectedCard.name || 'Untitled'}”? This cannot be undone.`),
      { title: text('删除角色', 'Delete character'), confirmText: text('删除', 'Delete'), danger: true }
    )
    if (!ok || !isProjectSessionCurrent(projectSession)) return
    const deleted = await deleteCharacter(selectedCard.name, projectKey)
    if (!isProjectSessionCurrent(projectSession)) return
    if (!deleted) {
      addLog(
        'error',
        text(
          '角色删除失败：项目可能已切换，请刷新后重试',
          'Could not delete the character. The project may have changed; refresh and try again.',
        ),
      )
    }
  }

  const handleSave = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    try {
      await saveAll(projectKey)
      if (!isProjectSessionCurrent(projectSession)) return
      addLog('info', text(`已保存 ${characters.length} 个角色卡`, `Saved ${characters.length} character cards`))
    } catch (error) {
      if (!isProjectSessionCurrent(projectSession)) return
      addLog('error', text(`角色卡保存失败：${error}`, 'Could not save character cards.'))
    }
  }

  const updateCurrentField = <K extends Exclude<keyof CharacterCard, 'name'>>(
    name: string,
    key: K,
    value: CharacterCard[K],
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    updateField(name, key, value)
  }

  const renameCurrentCharacter = (name: string, nextName: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    renameCharacter(name, nextName)
  }

  // ===== 渲染 =====

  if (!projectMatches) {
    return (
      <BaseEmptyState
        icon={<Users size={36} />}
        message={text('此标签属于另一个项目，请切回原项目后继续。', 'This tab belongs to another project. Switch back to continue.')}
        opacity={0.4}
      />
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* 统一顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
            {viewMode === 'graph'
              ? text('角色图谱', 'Character graph')
              : selectedCard
                ? `${selectedCard.name || text('新角色', 'New character')} ${viewMode === 'state' ? text('— 当前状态', '— Current state') : text('— 编辑档案', '— Edit profile')}`
                : text('角色档案', 'Character profile')}
          </span>
        </div>
        
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {viewMode === 'graph' ? (
            <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title={text('返回编辑', 'Return to editing')}>
              <Users size={12} /> {text('编辑模式', 'Edit mode')}
            </Button>
          ) : selectedCard ? (
            <>
              {viewMode === 'state' ? (
                <Button variant="outline" size="sm" onClick={() => setViewMode('edit')} title={text('返回基础设定', 'Return to core profile')}>
                  <Users size={12} /> {text('基础设定', 'Core profile')}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setViewMode('state')} title={text('查看当前进展/状态', 'View current state')}>
                  <ClipboardList size={13} /> {text('当前状态', 'Current state')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title={text('查看全员关系网', 'View all character relationships')}>
                <Network size={12} /> {text('关系图谱', 'Relationship graph')}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={identityBusy || !dataReady}>
                <Trash2 size={12} /> {text('删除', 'Delete')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleSave} disabled={identityBusy || !dataReady}>
                <Save size={12} /> {saving ? text('保存中...', 'Saving...') : text('保存', 'Save')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setViewMode('graph')} title={text('查看全员关系网', 'View all character relationships')}>
              <Network size={12} /> {text('关系图谱', 'Relationship graph')}
            </Button>
          )}
        </div>
      </div>

      {/* 主体区 */}
      <div className="flex-1 overflow-y-auto relative">
        {viewMode === 'graph' ? (
          <RelationshipGraph characters={characters} />
        ) : !selectedCard ? (
          <BaseEmptyState 
            icon={<Users size={36} />} 
            message={lastError
              ? text(`角色卡读取失败：${lastError}`, `Could not load character cards: ${lastError}`)
              : (currentProject ? text('在左侧选择或创建角色卡', 'Select or create a character card on the left') : text('请先打开项目', 'Open a project first'))}
            opacity={currentProject ? 0.3 : 0.4}
          />
        ) : viewMode === 'state' ? (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[var(--color-text)]">
                {text('当前状态档案', 'Current state profile')}
              </h3>
              <span className="text-xs text-[var(--color-text-secondary)]">
                {text(
                  `最后更新：第 ${selectedCard.currentState?.updatedAtChapter ?? 0} 章`,
                  `Last updated: Chapter ${selectedCard.currentState?.updatedAtChapter ?? 0}`,
                )}
              </span>
            </div>
            <div className="space-y-3">
              {([
                ['location', text('当前位置/阵营', 'Location / faction')],
                ['powerLevel', text('修为境界/能力等级', 'Power or ability level')],
                ['physicalState', text('身体状态（伤势/BUFF/外貌）', 'Physical state (injuries, effects, appearance)')],
                ['mentalState', text('心理状态（愿望/恐惧/心态）', 'Mental state (goals, fears, mindset)')],
                ['keyItems', text('关键道具/资源', 'Key items / resources')],
                ['recentEvents', text('最近重要事件', 'Recent important events')],
              ] as const).map(([field, label]) => (
                <div key={field}>
                  <Label>{label}</Label>
                  <Textarea
                    value={selectedCard.currentState?.[field]?.toString() ?? ''}
                    onChange={(e) => {
                      const cs: CharacterCurrentState = {
                        ...(selectedCard.currentState ?? EMPTY_STATE),
                        [field]: e.target.value,
                      }
                      updateCurrentField(selectedCard.name, 'currentState', cs)
                    }}
                    rows={2}
                    placeholder={`${label}...`}
                  />
                </div>
              ))}
            </div>
            {!selectedCard.currentState && (
              <div className="mt-4 p-3 rounded-lg bg-[var(--color-hover)] text-xs text-[var(--color-text-secondary)]">
                {text('当前状态档案将在章节定稿后由 AI 自动更新，也可手动填写初始状态。', 'AI updates this profile after a chapter is finalized. You can also enter an initial state manually.')}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto px-6 py-4">
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div><Label>{text('姓名', 'Name')}</Label><Input value={selectedCard.name} disabled={identityBusy} onChange={(e) => renameCurrentCharacter(selectedCard.name, e.target.value)} /></div>
                <div><Label>{text('性别', 'Gender')}</Label><Input value={selectedCard.gender} onChange={(e) => updateCurrentField(selectedCard.name, 'gender', e.target.value)} /></div>
                <div><Label>{text('年龄', 'Age')}</Label><Input value={selectedCard.age} onChange={(e) => updateCurrentField(selectedCard.name, 'age', e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{text('定位', 'Role')}</Label>
                  <NativeSelect value={selectedCard.role} onChange={(e) => updateCurrentField(selectedCard.name, 'role', e.target.value as typeof selectedCard.role)}>
                    {CHARACTER_ROLES.map(role => (
                      <option key={role} value={role}>{roleLabel(role)}</option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div><Label>{text('外貌描写', 'Appearance')}</Label><Textarea value={selectedCard.appearance} onChange={(e) => updateCurrentField(selectedCard.name, 'appearance', e.target.value)} rows={3} placeholder={text('输入外貌描写...', 'Describe appearance...')} /></div>
              <div><Label>{text('性格特征', 'Personality')}</Label><Textarea value={selectedCard.personality} onChange={(e) => updateCurrentField(selectedCard.name, 'personality', e.target.value)} rows={3} placeholder={text('输入性格特征...', 'Describe personality...')} /></div>
              <div><Label>{text('背景故事', 'Background')}</Label><Textarea value={selectedCard.background} onChange={(e) => updateCurrentField(selectedCard.name, 'background', e.target.value)} rows={4} placeholder={text('输入背景故事...', 'Describe background...')} /></div>
              <div><Label>{text('能力/技能', 'Abilities / skills')}</Label><Textarea value={selectedCard.abilities} onChange={(e) => updateCurrentField(selectedCard.name, 'abilities', e.target.value)} rows={3} placeholder={text('输入能力/技能...', 'Describe abilities or skills...')} /></div>
              <div><Label>{text('核心动机', 'Core motivation')}</Label><Textarea value={selectedCard.motivation} onChange={(e) => updateCurrentField(selectedCard.name, 'motivation', e.target.value)} rows={2} placeholder={text('输入核心动机...', 'Describe core motivation...')} /></div>
              <div>
                <Label>{text('关系网', 'Relationships')}</Label>
                <Textarea
                  value={relationshipEditorText}
                  onChange={(e) => updateCurrentField(
                    selectedCard.name,
                    'relationships',
                    relationshipStorageFromEditor(e.target.value, {
                      knownNames: characters.map((character) => character.name),
                      selfName: selectedCard.name,
                      previousStorage: selectedCard.relationships,
                    }),
                  )}
                  rows={3}
                  placeholder={text(
                    '每行一位角色，例如：陆云飞：竞争对手（权力斗争）',
                    'One character per line, for example: Lu Yunfei: rival (power struggle)',
                  )}
                />
              </div>
              <div><Label>{text('成长轨迹', 'Character arc')}</Label><Textarea value={selectedCard.arc} onChange={(e) => updateCurrentField(selectedCard.name, 'arc', e.target.value)} rows={3} placeholder={text('输入成长轨迹...', 'Describe the character arc...')} /></div>
              <div><Label>{text('备注', 'Notes')}</Label><Textarea value={selectedCard.notes} onChange={(e) => updateCurrentField(selectedCard.name, 'notes', e.target.value)} rows={2} placeholder={text('输入备注...', 'Enter notes...')} /></div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
