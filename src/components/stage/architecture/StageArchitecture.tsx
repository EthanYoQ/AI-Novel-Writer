import { useState } from 'react'
import { ArrowRight, Ellipsis, Sparkles } from 'lucide-react'
import { ARCH_STEP_NAMES, type ArchStepKey } from '../../../services/architecture-step-selection'
import { useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { clearArchSection } from '../../editor/clear-arch-section'
import { ARCH_FILES, useArchitectureOverview } from '../../editor/use-architecture-overview'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { Menu } from '../../ui/Menu'
import { toast } from '../../ui/Toast'
import { refreshStageWork } from '../use-stage-work'
import ArchitectureGenerateDialog from './ArchitectureGenerateDialog'
import ArchitectureSection from './ArchitectureSection'
import { excerpt, mainAction, sectionBadge, SECTION_ORDER } from './architecture-sections'

/** 角色名单一节的摘要。角色卡在打开作品后单独载入（角色多时要几百毫秒），载完之前只这一节写「正在读取」，其余三节照常可用。 */
function useCastSummary(projectKey: string): { summary: string; loading: boolean } {
  const text = useLocaleStore(s => s.text)
  const characters = useCharacterStore(s => s.characters)
  const loaded = useCharacterStore(s => s.dataProjectKey === projectKey && s.loadingProjectKey === null)
  const error = useCharacterStore(s => s.lastError)
  if (!loaded) return { summary: text('正在读取角色名单…', 'Loading the cast…'), loading: true }
  if (error) return { summary: text(`角色名单读取失败：${error}`, 'Could not load the cast.'), loading: false }
  const names = characters.map(character => character.name).filter(Boolean)
  if (names.length === 0) return { summary: text('还没有角色。可以让 AI 按设定生成，也可以在角色名单里自己添加。', 'No characters yet. Let AI create them from the setup, or add them in the cast.'), loading: false }
  const shown = names.slice(0, 5).join(text('、', ', '))
  return { summary: text(`${names.length} 位角色：${shown}${names.length > 5 ? '……' : ''}`, `${names.length} ${names.length === 1 ? 'character' : 'characters'}: ${shown}${names.length > 5 ? '…' : ''}`), loading: false }
}

const openCast = (text: (zh: string, en: string) => string) => openBuiltinEditor('character-editor', text('角色名单', 'Cast'), 'character')

/**
 * 架构阶段：故事前提、角色名单、世界观、情节大纲四节。编辑一节打开它的文档标签，角色名单打开名单页；
 * 数据与操作来自 useArchitectureOverview。
 */
export default function StageArchitecture({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const overview = useArchitectureOverview(projectKey)
  const badges = Object.fromEntries(SECTION_ORDER.map(key => [key, sectionBadge(key, overview)])) as Record<ArchStepKey, ReturnType<typeof sectionBadge>>
  /** 页头计数与主按钮只数已确认的节（徽标「已确认」）：部分完成、不完整、待处理都不算。 */
  const filled = overview.loading ? null : SECTION_ORDER.filter(key => overview.confirmed[key]).length
  const cast = useCastSummary(projectKey)
  /** 清空确认打开时冻结的会话：确认时作品已换就什么也不写。 */
  const [clearing, setClearing] = useState<{ key: ArchStepKey; session: ProjectSessionContext } | null>(null)

  const total = SECTION_ORDER.length
  const action = mainAction(filled ?? 0, total)

  const reload = () => {
    void overview.loadStatus()
    void overview.roster.refresh()
    void refreshStageWork(text)
  }
  const editSection = (key: ArchStepKey) => {
    const file = ARCH_FILES.find(candidate => candidate.key === key)
    if (file) void overview.openArchFile(file)
  }

  const confirmClear = async () => {
    if (!clearing) return
    const { key, session } = clearing
    setClearing(null)
    if (!isProjectSessionPath(session, projectKey) || !isProjectSessionCurrent(session)) return
    const name = text(...ARCH_STEP_NAMES[key])
    const cleared = await clearArchSection(`ai-novel://core/${key}`, session)
    if (!isProjectSessionCurrent(session)) return
    if (!cleared) {
      toast.error(text(`清空「${name}」失败`, `Could not clear ${name}`))
      return
    }
    reload()
    toast.success(text(`已清空「${name}」`, `Cleared ${name}`))
  }

  const summary = (key: ArchStepKey) => {
    if (key === 'characters') return cast.summary
    const content = overview.contents[key] ?? ''
    return content.trim()
      ? excerpt(content, text('……', '…'))
      : text('还没有内容。可以让 AI 按设定生成，也可以自己写。', 'Nothing here yet. Let AI draft it from the setup, or write it yourself.')
  }

  const clearingName = clearing ? text(...ARCH_STEP_NAMES[clearing.key]) : ''

  return (
    <div className="arch-page" data-loading={overview.loading || undefined} data-cast-loading={cast.loading || undefined} data-status-unread={!overview.firstReadEnded || undefined}>
      <div className="arch-inner">
        <header className="arch-header">
          <div className="arch-heading">
            <p className="arch-eyebrow">{text('架构', 'Architecture')}{filled !== null && <span className="arch-progress"> · {text(`${filled} / ${total} 已确认`, `${filled} / ${total} confirmed`)}</span>}</p>
            <h1 className="arch-title">{text('故事的骨架', 'The bones of the story')}</h1>
            <p className="arch-lede">{text('前提、角色、世界观和情节大纲。四节都确认后，就可以逐章规划蓝图。', 'Premise, cast, world and outline. Once all four are confirmed, plan the chapters in the blueprint.')}</p>
          </div>
          <div className="arch-header-actions">
            <Menu
              label={text('架构的更多操作', 'More for architecture')}
              icon={<Ellipsis size={16} aria-hidden />}
              align="end"
              groups={[{ id: 'page', items: [
                { id: 'refresh', label: text('刷新状态', 'Refresh status'), onSelect: reload },
                ...(action === 'next' ? [{ id: 'generate', label: text('AI 生成架构…', 'Generate with AI…'), onSelect: () => overview.openGenerateDialog() }] : []),
              ] }]}
            />
            {action === 'next'
              ? (
                <Button variant="primary" onClick={() => navigate({ kind: 'stage', stage: 'blueprint' })}>
                  {text('下一步：章节蓝图', 'Next: chapter blueprint')}<ArrowRight size={14} aria-hidden />
                </Button>
              )
              : (
                <>
                  <Button variant="secondary" disabled title={text('四节都确认后才能进入蓝图', 'Confirm all four sections first')}>
                    {text('下一步：章节蓝图', 'Next: chapter blueprint')}<ArrowRight size={14} aria-hidden />
                  </Button>
                  <Button variant="primary" disabled={filled === null} onClick={() => overview.openGenerateDialog()}>
                    <Sparkles size={14} aria-hidden />
                    {action === 'generate' ? text('AI 生成架构', 'Generate architecture') : text('继续生成架构', 'Continue architecture')}
                  </Button>
                </>
              )}
          </div>
        </header>

        <div className="arch-sections">
          {SECTION_ORDER.map(key => (
            <ArchitectureSection
              key={key}
              sectionKey={key}
              overview={overview}
              badge={badges[key]}
              summary={summary(key)}
              onEdit={() => editSection(key)}
              onGenerate={() => overview.openGenerateDialog([key])}
              onClear={() => {
                const session = captureProjectSession(useProjectStore.getState().currentProject)
                if (session && isProjectSessionPath(session, projectKey)) setClearing({ key, session })
              }}
              onOpenCast={() => openCast(text)}
              onReload={reload}
            />
          ))}
        </div>
      </div>

      <ArchitectureGenerateDialog {...overview.generateDialog} />
      <DangerConfirm
        open={clearing !== null}
        onOpenChange={open => { if (!open) setClearing(null) }}
        title={text(`清空「${clearingName}」？`, `Clear ${clearingName}?`)}
        consequence={text(`将删除「${clearingName}」的全部文本。其他三节、蓝图和正文不受影响。`, `All text in ${clearingName} will be deleted. The other sections, blueprints and chapters are not affected.`)}
        recoverability={text('清空后无法撤销；做过项目备份的，可以从备份恢复。', 'This cannot be undone. If you made a project backup, you can restore from it.')}
        confirmLabel={text('清空此节', 'Clear section')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { void confirmClear() }}
      />
    </div>
  )
}
