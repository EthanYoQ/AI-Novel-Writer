import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useLayoutStore, type SettingsSection } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import ProjectBackupPanel from '../../backups/ProjectBackupPanel'
import PromptSettings from '../../settings/PromptSettings'
import SkillSettings from '../../settings/SkillSettings'
import { leaveSettings, settleSettingsLeave, useSettingsLeave, useSettingsLeaveHost } from '../../settings/unsaved-settings'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { ErrorBoundary } from '../../ErrorBoundary'
import KnowledgeIndexSection from '../knowledge/KnowledgeIndexSection'
import { isComposing, isModalOpen } from '../shortcut-keys'
import AboutSection from './AboutSection'
import AppearanceSection from './AppearanceSection'
import ModelsSection from './ModelsSection'
import ProxySection from './ProxySection'
import StageModelsSection from './StageModelsSection'
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPageSpec } from './settings-pages'

interface RequiredState {
  missing: boolean
  label: string
}

/** 必需页的标签状态，非必需页为 null。配置载入前不下结论，只标「必需」。 */
function useRequiredState(spec: SettingsPageSpec): RequiredState | null {
  const text = useLocaleStore(s => s.text)
  const missing = useLLMStore(s => s.loaded && spec.required !== undefined && spec.required.missing(s))
  if (!spec.required) return null
  return { missing, label: missing ? text('未配置', 'Not set') : text('必需', 'Required') }
}

function RequiredMark({ state, decorative }: { state: RequiredState; decorative?: boolean }) {
  return <span className="stage-set-required" data-missing={state.missing || undefined} aria-hidden={decorative || undefined}>{state.label}</span>
}

/** 导航按钮的名字只是页名（读屏和按名定位都靠它），必需与否放进描述里读出。 */
function SettingsLink({ spec, current }: { spec: SettingsPageSpec; current: SettingsSection }) {
  const text = useLocaleStore(s => s.text)
  const required = useRequiredState(spec)
  return (
    <button
      type="button"
      className="stage-set-link"
      aria-current={spec.id === current ? 'page' : undefined}
      aria-description={required?.label}
      onClick={() => { if (spec.id !== current) leaveSettings(() => useLayoutStore.setState({ settingsSection: spec.id })) }}
    >
      <span className="stage-set-link-name">{text(...spec.name)}</span>
      {required && <RequiredMark state={required} decorative />}
    </button>
  )
}

function PageHeader({ page, action }: { page: SettingsSection; action?: ReactNode }) {
  const text = useLocaleStore(s => s.text)
  const spec = SETTINGS_PAGES.find(candidate => candidate.id === page)!
  const required = useRequiredState(spec)
  return (
    <header className="stage-set-head">
      <div className="stage-set-head-text">
        <div className="stage-set-titleline">
          <h1 className="stage-set-title">{text(...spec.name)}</h1>
          {required && <RequiredMark state={required} />}
        </div>
        <p className="stage-set-lede">{text(...spec.lede)}</p>
      </div>
      {action}
    </header>
  )
}

/** 旧组件（提示词模板、写作 Skills、项目备份）放进纸墨页面时仍读旧的颜色变量，由配色桥接到纸墨令牌。 */
function Legacy({ children }: { children: ReactNode }) {
  return <div className="stage-set-legacy">{children}</div>
}

function PageBody({ page }: { page: SettingsSection }) {
  switch (page) {
    case 'llm':
      return <ModelsSection purposes={['generation', 'refinement', 'summary']} header={action => <PageHeader page="llm" action={action} />} />
    case 'embedding':
      return (
        <>
          <ModelsSection purposes={['embedding']} header={action => <PageHeader page="embedding" action={action} />} />
          <KnowledgeIndexSection />
        </>
      )
    case 'appearance':
      return <><PageHeader page={page} /><AppearanceSection /></>
    case 'stage-models':
      return <><PageHeader page={page} /><StageModelsSection /></>
    case 'proxy':
      return <><PageHeader page={page} /><ProxySection /></>
    case 'prompts':
      return <><PageHeader page={page} /><Legacy><PromptSettings /></Legacy></>
    case 'skills':
      return <><PageHeader page={page} /><Legacy><SkillSettings /></Legacy></>
    case 'backup':
      return <><PageHeader page={page} /><Legacy><ProjectBackupPanel /></Legacy></>
    case 'about':
      return <><PageHeader page={page} /><AboutSection /></>
  }
}

const close = () => leaveSettings(() => useLayoutStore.getState().closeSettings())

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'password', 'number', 'tel'])

/** 打字的地方的 Esc 属于输入（撤销联想、清空搜索），不关闭设置页；下拉框、开关、复选框、按钮上的 Esc 照常关闭。 */
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)))

/**
 * 设置页：左侧按常用、高级、其他分组，右侧是当前一页。占满内容面板，书房与作品里都能打开；
 * 「返回」或 Esc 回到打开前的页面，有没保存的输入时先确认。当前分区记在 layout-store，书房与作品之间切换重挂后仍停在原处。
 */
export default function StageSettings({ library }: { library: boolean }) {
  const text = useLocaleStore(s => s.text)
  const page = useLayoutStore(s => s.settingsSection)
  const pendingLeave = useSettingsLeave(s => s.pending)
  useSettingsLeaveHost()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposing(event) || isModalOpen() || isTyping(event.target)) return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [page])

  return (
    <div className="stage-settings">
      <nav className="stage-set-nav" aria-label={text('设置分组', 'Settings sections')}>
        <Button variant="text" size="sm" className="stage-set-back" onClick={close}>
          <ArrowLeft size={14} aria-hidden="true" />
          {library ? text('返回书房', 'Back to library') : text('返回作品', 'Back to the book')}
        </Button>
        <p className="stage-set-nav-title">{text('设置', 'Settings')}</p>
        {SETTINGS_GROUPS.map(group => (
          <div key={group.id} className="stage-set-group" role="group" aria-label={text(...group.name)}>
            <p className="stage-set-group-label" aria-hidden="true">{text(...group.name)}</p>
            {group.pages.map(spec => <SettingsLink key={spec.id} spec={spec} current={page} />)}
          </div>
        ))}
      </nav>
      <div className="stage-set-body" ref={bodyRef}>
        <div className="stage-set-inner">
          <ErrorBoundary key={page} fallbackLabel={text('设置页渲染失败', 'Settings failed to render')}>
            <PageBody page={page} />
          </ErrorBoundary>
        </div>
      </div>
      <DangerConfirm
        open={pendingLeave !== null}
        onOpenChange={open => { if (!open) settleSettingsLeave(false) }}
        title={text('放弃未保存的修改？', 'Discard unsaved changes?')}
        consequence={text('这一页有还没保存的修改，离开后会丢失。', 'This page has changes that are not saved yet. Leaving discards them.')}
        recoverability={text('丢弃后无法恢复。想保留就选「继续编辑」，先保存再离开。', 'This cannot be undone. Choose “Keep editing” and save first to keep them.')}
        confirmLabel={text('放弃修改', 'Discard changes')}
        cancelLabel={text('继续编辑', 'Keep editing')}
        onConfirm={() => settleSettingsLeave(true)}
      />
    </div>
  )
}
