import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronUp, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { countDraftUnits } from '../../../shared/draft-units'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../../shared/narrative-thread'
import { resolveWritingLanguage, type WritingLanguage } from '../../../shared/writing-language'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { missingSetup, type SetupField } from '../../../stores/navigation/stage-progress'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { configFieldsToExpand, startConfigGeneration } from '../../dialogs/config-generation'
import { AUDIENCE_EN, GENRE_EN } from '../../editor/novel-config-labels'
import { NOVEL_GENRES, novelConfigSessionKey, useNovelConfigForm } from '../../editor/use-novel-config-form'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'
import ModelMissingNotice from '../ModelMissingNotice'
import { commandLabel } from '../shortcut-keys'
import { useModelMissing } from '../use-model-missing'
import { MORE_FIELDS, ONE_MISSING_HINT, POV_OPTIONS, REQUIRED_NAMES, STRUCTURE_OPTIONS, type MoreField } from './setup-fields'
import { pluralEn } from '../../../shared/plural-en'

type Form = ReturnType<typeof useNovelConfigForm>
type Text = (zh: string, en: string) => string
type PanelId = MoreField['id'] | 'advanced'

/** 作者此刻在哪：活动标签、书房还是作品、设置页开没开。 */
function authorPlace(): string {
  const { sidebarView, settingsOpen } = useLayoutStore.getState()
  return JSON.stringify([useEditorStore.getState().activeTabId, sidebarView, settingsOpen])
}

/** 设定页：一段核心大纲加类型、篇幅、目标读者三项必填即可往下走；其余设定收在「更多设定」与「高级」里。 */
export default function StageSetup({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  return <SetupSession key={novelConfigSessionKey(currentProject, projectKey)} projectKey={projectKey} />
}

/** 数字框允许暂时为空，失焦时回退到默认值。 */
function NumberInput({ id, value, fallback, min, max, label, onChange }: {
  id?: string
  value: number | ''
  fallback: number
  min: number
  max?: number
  label: string
  onChange: (value: number | '') => void
}) {
  return (
    <input
      id={id}
      className="stage-setup-num-input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-label={label}
      value={value}
      onChange={event => onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))}
      onBlur={() => { if (!(Number(value) >= min)) onChange(fallback) }}
    />
  )
}

/** 不可用按钮的原因藏在旁边，读屏用户聚焦按钮时能听到；看得见的原因在页面别处（缺模型提示条、必填标记）。 */
function DisabledReason({ id, reason }: { id: string; reason: string | null }) {
  return reason ? <span id={id} className="stage-visually-hidden">{reason}</span> : null
}

function AiButton({ field, label, form, disabledReason }: { field: GeneratableField; label: string; form: Form; disabledReason: string | null }) {
  const text = useLocaleStore(s => s.text)
  const reasonId = useId()
  const busy = form.generatingField === field
  const reason = disabledReason ?? (form.generatingField !== null && !busy ? text('正在生成另一项，完成后再试', 'Another field is generating. Try again when it finishes') : null)
  return (
    <>
      <Button
        variant="text"
        size="sm"
        className="stage-setup-ai"
        disabled={reason !== null || busy}
        aria-describedby={reason ? reasonId : undefined}
        aria-label={text(`AI 生成「${label}」`, `Generate “${label}” with AI`)}
        onClick={() => void form.generateField(field)}
      >
        {busy ? <LoaderCircle size={13} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
        {busy ? text('生成中…', 'Generating…') : text('AI 生成', 'Generate')}
      </Button>
      <DisabledReason id={reasonId} reason={reason} />
    </>
  )
}

/** 单项 AI 生成失败时写在那一项下面，直到下次生成。 */
function GenerateError({ field, label, form }: { field: GeneratableField; label: string; form: Form }) {
  const text = useLocaleStore(s => s.text)
  if (form.generateError?.field !== field) return null
  const reason = displayedErrorMessage(useLocaleStore.getState().locale, form.generateError.message)
  return (
    <p className="stage-setup-error" role="alert">
      {text(`「${label}」没有生成：${reason}。原来的内容没有改动。`, `“${label}” was not generated: ${reason}. Nothing was changed.`)}
    </p>
  )
}

/** 还空着的必填项写「必填」；alert 时（作者离开了空着的这一项，或只差这一项）转成危险色。 */
function RequiredLabel({ htmlFor, id, name, missing, alert }: { htmlFor?: string; id?: string; name: string; missing: boolean; alert: boolean }) {
  const text = useLocaleStore(s => s.text)
  return (
    <label className="stage-setup-label" htmlFor={htmlFor} id={id} data-missing={(missing && alert) || undefined}>
      {name}
      {missing && <span className="stage-setup-required-mark">{text(' · 必填', ' · required')}</span>}
    </label>
  )
}

function chipValue(field: MoreField, config: NovelConfig, text: Text): string {
  if (field.kind === 'pov') {
    const option = POV_OPTIONS.find(([value]) => value === (config.narrativePOV || 'third_limited'))
    return option ? text(...option[1]) : ''
  }
  if (field.kind === 'structure') {
    const option = STRUCTURE_OPTIONS.find(([value]) => value === (config.plotStructure || 'three_act'))
    return option ? text(...option[1]) : ''
  }
  if (field.kind === 'line') return config.subGenre?.trim() ?? ''
  return ''
}

function isFilled(field: MoreField, config: NovelConfig): boolean {
  if (field.kind === 'pov' || field.kind === 'structure') return true
  return Boolean((config[field.id] ?? '').trim())
}

/** 点开的面板可能落在底栏后面：挂上时滚进视野，焦点交给面板里的输入框。 */
function useRevealOnOpen() {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    panel.scrollIntoView({ block: 'nearest' })
    panel.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true })
  }, [])
  return ref
}

function MorePanel({ field, config, form, aiReason, onCollapse }: {
  field: MoreField
  config: NovelConfig
  form: Form
  aiReason: string | null
  onCollapse: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const ref = useRevealOnOpen()
  const controlId = useId()
  const name = text(...field.name)
  let control: ReactNode
  if (field.kind === 'pov') {
    control = (
      <select id={controlId} className="stage-select" value={config.narrativePOV || 'third_limited'}
        onChange={event => form.update('narrativePOV', event.target.value as NovelConfig['narrativePOV'])}>
        {POV_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
      </select>
    )
  } else if (field.kind === 'structure') {
    control = (
      <select id={controlId} className="stage-select" value={config.plotStructure || 'three_act'}
        onChange={event => form.update('plotStructure', event.target.value as NovelConfig['plotStructure'])}>
        {STRUCTURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
      </select>
    )
  } else if (field.kind === 'line') {
    control = (
      <input id={controlId} className="pi-input" value={config.subGenre ?? ''} placeholder={text(...field.placeholder)}
        onChange={event => form.update('subGenre', event.target.value)} />
    )
  } else {
    control = (
      <textarea id={controlId} className="stage-setup-textarea" value={config[field.id] ?? ''} placeholder={text(...field.placeholder)}
        onChange={event => form.update(field.id, event.target.value)} />
    )
  }
  return (
    <section ref={ref} className="stage-setup-panel" aria-label={name}>
      <div className="stage-setup-panel-head">
        <div>
          <label className="stage-setup-panel-title" htmlFor={controlId}>{name}</label>
          {field.kind === 'text' && <p className="stage-setup-panel-desc">{text(...field.desc)}</p>}
        </div>
        {field.kind === 'text' && field.aiField && <AiButton field={field.aiField} label={name} form={form} disabledReason={aiReason} />}
        <Button variant="icon" size="sm" aria-label={text(`收起「${name}」`, `Collapse “${name}”`)} onClick={onCollapse}>
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
      </div>
      {control}
      {field.kind === 'text' && field.aiField && <GenerateError field={field.aiField} label={name} form={form} />}
    </section>
  )
}

function AdvancedPanel({ config, form, onCollapse }: { config: NovelConfig; form: Form; onCollapse: () => void }) {
  const text = useLocaleStore(s => s.text)
  const ref = useRevealOnOpen()
  const inputId = useId()
  const threshold = resolveNarrativeThreadDormantThreshold(config.narrativeThreadDormantChapterThreshold)
  return (
    <section ref={ref} className="stage-setup-panel" aria-label={text('高级', 'Advanced')}>
      <div className="stage-setup-panel-head">
        <div>
          <p className="stage-setup-panel-title">{text('高级', 'Advanced')}</p>
          <p className="stage-setup-panel-desc">{text('只影响这部作品。', 'Applies to this book only.')}</p>
        </div>
        <Button variant="icon" size="sm" aria-label={text('收起「高级」', 'Collapse “Advanced”')} onClick={onCollapse}>
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
      </div>
      <div className="stage-setup-adv-row">
        <div>
          <label className="stage-setup-label" htmlFor={inputId}>{text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}</label>
          <p className="stage-setup-panel-desc">{text(
            `一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} 章。`,
            `The plot page flags a thread that has not moved for this many chapters. Default ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}.`,
          )}</p>
        </div>
        <div className="stage-setup-adv-ctl">
          <NumberInput id={inputId} value={config.narrativeThreadDormantChapterThreshold as unknown === '' ? '' : threshold}
            fallback={DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD} max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD} label={text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}
            onChange={value => form.update('narrativeThreadDormantChapterThreshold', (value === '' ? '' : resolveNarrativeThreadDormantThreshold(value)) as number)} />
          <Button variant="text" size="sm" disabled={threshold === DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}
            onClick={() => form.update('narrativeThreadDormantChapterThreshold', DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD)}>
            <RotateCcw size={13} aria-hidden="true" />{text('恢复默认', 'Restore default')}
          </Button>
        </div>
      </div>
    </section>
  )
}

function SetupSession({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const form = useNovelConfigForm(projectKey)
  const modelMissing = useModelMissing()
  const filling = useWorkflowStore(s => s.activeRuns.some(run => run.type === 'config_generation' && sameProjectPathKey(run.projectPath, projectKey)))
  const [open, setOpen] = useState<ReadonlySet<PanelId>>(() => new Set())
  const [expandFields, setExpandFields] = useState<string[] | null>(null)
  const [left, setLeft] = useState<ReadonlySet<SetupField>>(() => new Set())
  const outlineId = useId()
  const hintId = useId()
  const lengthId = useId()
  const fillReasonId = useId()

  const { config } = form
  if (!config) {
    return (
      <div className="stage-setup stage-setup--empty">
        <p className="stage-setup-lede">{form.projectMatches
          ? text('正在读取设定…', 'Loading setup…')
          : text('这个标签属于另一部作品，切回那部作品后再继续。', 'This tab belongs to another book. Switch back to it to continue.')}</p>
      </div>
    )
  }

  const missing = missingSetup(config)
  const isMissing = (field: SetupField) => missing.includes(field)
  const alert = (field: SetupField) => missing.length === 1 || left.has(field)
  const leave = (field: SetupField) => {
    if (isMissing(field) && !left.has(field)) setLeft(previous => new Set(previous).add(field))
  }
  const toggle = (id: PanelId) => setOpen(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const hint = missing.length === 0
    ? text('设定已齐，可以往下走', 'Setup is complete. Ready for the next step.')
    : missing.length === 1
      ? text(...ONE_MISSING_HINT[missing[0]])
      : text(`还差 ${missing.length} 项：${missing.map(field => REQUIRED_NAMES[field][0]).join('、')}`,
        `${missing.length} left: ${missing.map(field => REQUIRED_NAMES[field][1]).join(', ')}`)
  const aiReason = modelMissing ? text('先在设置里添加 AI 模型', 'Add an AI model in Settings first') : null
  const fillReason = aiReason ?? (config.coreOutline.trim() ? null : text('先写核心大纲，AI 按它补全其余设定', 'Write the core outline first; AI fills in the rest from it'))

  const startFill = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    if (startConfigGeneration({ idea: config.coreOutline, projectSession: session, onGenerated: form.applyGeneratedTo(session) })) setExpandFields(null)
  }
  const requestFill = () => {
    const fields = configFieldsToExpand(config, text)
    if (fields.length > 0) setExpandFields(fields)
    else startFill()
  }
  const goNext = async () => {
    if (form.dirty) {
      const before = authorPlace()
      try {
        if (!await form.save(true)) return
      } catch {
        return
      }
      // 保存期间作者可能回了书房、开了设置页或换到别的标签；这时不再把作者拉去架构。
      if (authorPlace() !== before) return
    }
    navigate({ kind: 'stage', stage: 'architecture' })
  }

  const genre = config.genre
  const audience = config.targetAudience
  return (
    <div className="stage-setup">
      <div className="stage-setup-scroll">
        <div className="stage-setup-inner">
          <header className="stage-setup-head">
            <div className="stage-setup-kicker">
              <span className="stage-setup-numeral" aria-hidden="true">i</span>
              <span className="stage-eyebrow">{text('第一步 · 设定', 'Step one · Setup')}</span>
            </div>
            <h1 className="stage-setup-title">{text('用一两句话，说说这个故事。', 'Tell this story in a sentence or two.')}</h1>
            <p className="stage-setup-lede">{text(
              '只要这一段和下面三项，就能往下走。其余设定可以交给 AI 补全，之后随时能改。',
              'This paragraph and the three fields below are all you need to move on. AI can fill in the rest, and you can change anything later.',
            )}</p>
          </header>

          {modelMissing && <ModelMissingNotice />}

          <section className="stage-setup-outline" data-missing={isMissing('coreOutline') || undefined}>
            <div className="stage-setup-outline-head">
              <RequiredLabel htmlFor={outlineId} name={text('核心大纲', 'Core outline')} missing={isMissing('coreOutline')} alert={alert('coreOutline')} />
              <AiButton field="coreOutline" label={text('核心大纲', 'Core outline')} form={form} disabledReason={aiReason} />
            </div>
            <textarea
              id={outlineId}
              className="stage-setup-outline-input"
              value={config.coreOutline}
              placeholder={text('谁，在哪里，想要什么，又被什么挡住了路。', 'Who, where, what they want, and what stands in the way.')}
              onChange={event => form.update('coreOutline', event.target.value)}
              onBlur={() => leave('coreOutline')}
            />
            <div className="stage-setup-outline-foot">
              <label className="stage-setup-language">
                {text('写作语言', 'Writing language')}
                <select value={resolveWritingLanguage(config.writingLanguage)} onChange={event => form.update('writingLanguage', event.target.value as WritingLanguage)}>
                  <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <span className="pi-num-ui">{text(`${countDraftUnits(config.coreOutline)} 字`, `${countDraftUnits(config.coreOutline)} ${pluralEn(countDraftUnits(config.coreOutline), 'word')}`)}</span>
            </div>
            <GenerateError field="coreOutline" label={text('核心大纲', 'Core outline')} form={form} />
          </section>

          <div className="stage-setup-required">
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${outlineId}-genre`} name={text('类型', 'Genre')} missing={isMissing('genre')} alert={alert('genre')} />
              <select id={`${outlineId}-genre`} className="stage-select" data-placeholder={!genre || undefined} value={genre}
                onChange={event => form.update('genre', event.target.value)} onBlur={() => leave('genre')}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {genre && !NOVEL_GENRES.includes(genre) && <option value={genre}>{genre}</option>}
                {NOVEL_GENRES.map(value => <option key={value} value={value}>{text(value, GENRE_EN[value] ?? value)}</option>)}
              </select>
            </div>
            <div className="stage-setup-field" role="group" aria-labelledby={lengthId}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave('length') }}>
              <RequiredLabel id={lengthId} name={text('篇幅', 'Length')} missing={isMissing('length')} alert={alert('length')} />
              <div className="stage-setup-length">
                <NumberInput value={config.totalChapters as number | ''} fallback={100} min={1} label={text('总章数', 'Total chapters')}
                  onChange={value => form.update('totalChapters', value as number)} />
                <span>{text('章 · 每章约', 'ch. ·')}</span>
                <NumberInput value={config.wordsPerChapter as number | ''} fallback={3000} min={100} label={text('每章字数', 'Words per chapter')}
                  onChange={value => form.update('wordsPerChapter', value as number)} />
                <span>{text('字', 'words')}</span>
              </div>
            </div>
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${outlineId}-audience`} name={text('目标读者', 'Target readers')} missing={isMissing('targetAudience')} alert={alert('targetAudience')} />
              <select id={`${outlineId}-audience`} className="stage-select" data-placeholder={!audience || undefined} value={audience}
                onChange={event => form.update('targetAudience', event.target.value)} onBlur={() => leave('targetAudience')}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {audience && !Object.hasOwn(AUDIENCE_EN, audience) && <option value={audience}>{audience}</option>}
                {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => <option key={value} value={value}>{text(value, labelEn)}</option>)}
              </select>
            </div>
          </div>

          <div className="stage-setup-chips" role="group" aria-label={text('更多设定', 'More settings')}>
            <span className="stage-setup-chips-label" aria-hidden="true">{text('更多设定', 'More settings')}</span>
            {MORE_FIELDS.map(field => {
              const value = chipValue(field, config, text)
              return (
                <button key={field.id} type="button" className="stage-chip" aria-expanded={open.has(field.id)}
                  data-filled={isFilled(field, config) || undefined} onClick={() => toggle(field.id)}>
                  {text(...field.name)}{value && <span className="stage-chip-value"> · {value}</span>}
                </button>
              )
            })}
            <button type="button" className="stage-chip" data-dashed aria-expanded={open.has('advanced')} onClick={() => toggle('advanced')}>
              {text('高级', 'Advanced')}
            </button>
          </div>

          {MORE_FIELDS.filter(field => open.has(field.id)).map(field => (
            <MorePanel key={field.id} field={field} config={config} form={form} aiReason={aiReason} onCollapse={() => toggle(field.id)} />
          ))}
          {open.has('advanced') && <AdvancedPanel config={config} form={form} onCollapse={() => toggle('advanced')} />}
        </div>
      </div>

      <footer className="stage-setup-foot">
        <Button variant="secondary" disabled={fillReason !== null || filling} aria-describedby={fillReason ? fillReasonId : undefined} onClick={requestFill}>
          {filling ? <LoaderCircle size={15} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={15} className="stage-setup-spark" aria-hidden="true" />}
          {filling ? text('AI 正在补全…', 'AI is filling in…') : text('AI 补全其余设定', 'Fill the rest with AI')}
        </Button>
        <DisabledReason id={fillReasonId} reason={fillReason} />
        {form.saveOutcome === 'failed'
          ? <span className="stage-setup-hint" id={hintId} data-tone="danger" role="alert">{text('没能保存。设定还在这一页，没有丢，可以再保存一次。', 'Could not save. Your setup is still on this page; try saving again.')}</span>
          : <span className="stage-setup-hint" id={hintId} data-ready={missing.length === 0 || undefined} role="status">{hint}</span>}
        {form.dirty && (
          <Button variant="text" disabled={form.saving} onClick={() => void form.save()}>
            {form.saving ? text('正在保存…', 'Saving…') : text('保存', 'Save')}<kbd>{commandLabel('s')}</kbd>
          </Button>
        )}
        <Button variant="primary" disabled={missing.length > 0 || form.saving} aria-describedby={hintId} onClick={() => void goNext()}>
          {text('下一步：故事架构', 'Next: story architecture')}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </footer>

      <InkDialog
        open={expandFields !== null}
        onOpenChange={next => { if (!next) setExpandFields(null) }}
        title={text('扩写已有的设定？', 'Expand what you have written?')}
        description={text('下面这些已经有你写的内容。AI 会保留原文，只在后面补充：', 'These already have your writing. AI keeps it and only adds to it:')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setExpandFields(null)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={startFill}>{text('继续扩写', 'Expand')}</Button>
          </>
        )}
      >
        <ul className="stage-setup-expand-list">
          {expandFields?.map(field => <li key={field}>{field}</li>)}
        </ul>
      </InkDialog>
    </div>
  )
}
