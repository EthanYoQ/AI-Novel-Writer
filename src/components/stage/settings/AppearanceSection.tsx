import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Minus, Moon, Plus, Sun } from 'lucide-react'
import type { Locale } from '../../../i18n/types'
import { useLocaleStore } from '../../../stores/locale-store'
import { FONT_OPTIONS, useThemeStore, type FontId } from '../../../stores/theme-store'
import { useAutoOpenNextChapter } from '../../settings/use-auto-open-next-chapter'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { commandLabel } from '../shortcut-keys'

/** 一行设置：左边标题与说明，右边控件与标题对齐；children（示例句、错误）占整行，放在下面。 */
function Row({ title, desc, control, children, htmlFor }: { title: string; desc?: ReactNode; control: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="stage-set-row">
      <div>
        {htmlFor ? <label className="stage-set-row-title" htmlFor={htmlFor}>{title}</label> : <p className="stage-set-row-title">{title}</p>}
        {desc && <p className="stage-set-row-desc">{desc}</p>}
      </div>
      <div className="stage-set-row-ctl">{control}</div>
      {children && <div className="stage-set-row-extra">{children}</div>}
    </div>
  )
}

const THEME_KEYS = new Set(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'])

/** 浅色与深色两张卡片的单选组：整组一个 Tab 停靠点，方向键换选并移动焦点（与 SegmentedControl 一致，带修饰键时不接管）。 */
function ThemeChoice() {
  const text = useLocaleStore(s => s.text)
  const theme = useThemeStore(s => s.theme)
  const setTheme = useThemeStore(s => s.setTheme)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const themes = [
    { id: 'light', icon: <Sun size={18} aria-hidden="true" />, name: text('浅色', 'Light'), desc: text('纸面与墨色', 'Paper and ink') },
    { id: 'dark', icon: <Moon size={18} aria-hidden="true" />, name: text('深色', 'Dark'), desc: text('夜里写作', 'For the night') },
  ] as const
  const selected = themes.findIndex(option => option.id === theme)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!THEME_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? themes.length - 1 : 1
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? themes.length - 1 : (selected + step) % themes.length
    if (next !== selected) setTheme(themes[next].id)
    radios.current[next]?.focus()
  }

  return (
    <div className="stage-set-themes" role="radiogroup" aria-label={text('主题', 'Theme')} onKeyDown={onKeyDown}>
      {themes.map((option, index) => (
        <button key={option.id} ref={element => { radios.current[index] = element }} type="button" role="radio"
          aria-checked={theme === option.id} tabIndex={index === selected ? 0 : -1} className="stage-set-theme"
          data-theme-option={option.id} onClick={() => { if (theme !== option.id) setTheme(option.id) }}>
          {option.icon}
          <span className="stage-set-theme-name">{option.name}</span>
          <span className="stage-set-theme-desc">{option.desc}</span>
        </button>
      ))}
    </div>
  )
}

function FontSelect({ id, value, onChange }: { id: string; value: FontId; onChange: (font: FontId) => void }) {
  const text = useLocaleStore(s => s.text)
  return (
    <select id={id} className="stage-select" value={value} onChange={event => onChange(event.target.value as FontId)}>
      {FONT_OPTIONS.map(option => <option key={option.id} value={option.id}>{text(option.label, option.labelEn)}</option>)}
    </select>
  )
}

/** 外观：主题、语言、字体、缩放与定稿后打开下一章。改动立即生效。 */
export default function AppearanceSection() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const setLocale = useLocaleStore(s => s.setLocale)
  const { zoom, zoomIn, zoomOut, zoomReset, uiFont, setUiFont, writingFont, setWritingFont } = useThemeStore()
  const autoOpenNext = useAutoOpenNextChapter()
  const languageId = useId()
  const uiFontId = useId()
  const writingFontId = useId()
  const writingFontFamily = FONT_OPTIONS.find(option => option.id === writingFont)?.family
  return (
    <div className="stage-set-rows">
      <Row title={text('主题', 'Theme')} control={<ThemeChoice />} />
      <Row htmlFor={languageId} title={text('界面语言', 'Interface language')}
        desc={text('菜单、按钮与提示的语言。AI 写作用的语言在作品设定里单独设置。', 'Menus, buttons and messages. The language AI writes in is set per book, in setup.')}
        control={(
          <select id={languageId} className="stage-select" value={locale} onChange={event => void setLocale(event.target.value as Locale)}>
            <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
            <option value="en-US">English</option>
          </select>
        )} />
      <Row htmlFor={uiFontId} title={text('界面字体', 'Interface font')} desc={text('菜单、表单和列表使用的字体。', 'Used for menus, forms and lists.')}
        control={<FontSelect id={uiFontId} value={uiFont} onChange={setUiFont} />} />
      <Row htmlFor={writingFontId} title={text('写作字体', 'Writing font')} desc={text('正文编辑区使用的字体。', 'Used in the manuscript editor.')}
        control={<FontSelect id={writingFontId} value={writingFont} onChange={setWritingFont} />}>
        <p className="stage-set-font-sample" style={{ fontFamily: writingFontFamily }}>
          {text('雨从傍晚开始就没有停过。林岚站在空荡的站台上。', 'The rain had not stopped since dusk. Lin Lan stood on the empty platform.')}
        </p>
      </Row>
      <Row
        title={text('界面缩放', 'Zoom')}
        desc={text(`也可以用 ${commandLabel('=')} 放大、${commandLabel('-')} 缩小、${commandLabel('0')} 还原。`, `Or press ${commandLabel('=')} to zoom in, ${commandLabel('-')} to zoom out, ${commandLabel('0')} to reset.`)}
        control={(
          <div className="stage-set-zoom" role="group" aria-label={text('界面缩放', 'Zoom')}>
            <Button variant="icon" size="sm" aria-label={text('缩小', 'Zoom out')} disabled={zoom <= 0.7} onClick={zoomOut}><Minus size={14} aria-hidden="true" /></Button>
            <output className="stage-set-zoom-value" aria-live="polite">{Math.round(zoom * 100)}%</output>
            <Button variant="icon" size="sm" aria-label={text('放大', 'Zoom in')} disabled={zoom >= 1.5} onClick={zoomIn}><Plus size={14} aria-hidden="true" /></Button>
            <Button variant="text" size="sm" disabled={zoom === 1} onClick={zoomReset}>{text('还原', 'Reset')}</Button>
          </div>
        )}
      />
      <Row
        title={text('定稿后打开下一章', 'Open the next chapter after finalizing')}
        desc={text('一章定稿与后处理都完成后，自动打开下一章的写作页。不会自动生成正文，也不会覆盖已有草稿。', 'When a chapter is finalized and processed, open the next planned chapter. It never starts writing or overwrites a draft.')}
        control={<Check kind="switch" checked={autoOpenNext.enabled} disabled={autoOpenNext.saving} onChange={checked => void autoOpenNext.set(checked)}
          label={<span className="stage-visually-hidden">{text('定稿后打开下一章', 'Open the next chapter after finalizing')}</span>} />}
      >
        {autoOpenNext.error && <p className="stage-set-error" role="alert">{autoOpenNext.error}</p>}
      </Row>
    </div>
  )
}
