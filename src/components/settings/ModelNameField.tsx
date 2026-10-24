import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { isComposing } from '../stage/shortcut-keys'
import type { ModelNameCandidate } from './model-name-candidates'

function matches(candidate: ModelNameCandidate, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || candidate.value.toLowerCase().includes(needle) || Boolean(candidate.label?.toLowerCase().includes(needle))
}

/** 模型名：始终可直接输入，候选列表按输入过滤，刷新按钮向端点重新获取。 */
export function ModelNameField({
  value, placeholder, candidates, refreshing, status, onInput, onSelect, onOpen, onRefresh,
}: {
  value: string
  placeholder: string
  candidates: readonly ModelNameCandidate[]
  refreshing: boolean
  status: { text: string, tone: 'muted' | 'error' } | null
  onInput: (value: string) => void
  onSelect: (candidate: ModelNameCandidate) => void
  /** 每次展开时调用，由表单决定是否自动获取端点列表。 */
  onOpen: () => void
  onRefresh: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const inputId = useId()
  const listId = useId()
  const [open, setOpen] = useState(false)
  // 展开时显示全部候选；作者开始输入后才按输入过滤，避免已填的完整模型名把列表筛到只剩一项。
  const [query, setQuery] = useState<string | null>(null)
  // 按模型 ID 记住高亮项：候选被替换（获取完成、刷新）后不在新列表里的高亮自然失效，不会让 Enter 选中别的模型。
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const visible = query === null ? candidates : candidates.filter(candidate => matches(candidate, query))
  const activeIndex = activeValue === null ? -1 : visible.findIndex(candidate => candidate.value === activeValue)
  const optionId = (index: number) => `${listId}-option-${index}`

  const pointerPressed = useRef(false)
  useEffect(() => {
    if (!open) return
    const press = () => { pointerPressed.current = true }
    const release = () => { pointerPressed.current = false }
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('pointerup', release, true)
    document.addEventListener('pointercancel', release, true)
    return () => {
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('pointerup', release, true)
      document.removeEventListener('pointercancel', release, true)
      pointerPressed.current = false
    }
  }, [open])

  useEffect(() => {
    if (open && activeIndex >= 0) {
      listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, activeIndex])

  const show = (nextQuery: string | null) => {
    if (!open) onOpen()
    setOpen(true)
    setQuery(nextQuery)
  }
  const hide = () => {
    setOpen(false)
    setQuery(null)
    setActiveValue(null)
  }
  const choose = (candidate: ModelNameCandidate) => {
    onSelect(candidate)
    hide()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法组合中的方向键与回车属于候选窗，不能拿来选模型或收起列表。
    if (isComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const list = open ? visible : candidates
      if (!open) show(null)
      if (!list.length) return
      const next = activeIndex < 0 || !open
        ? (step === 1 ? 0 : list.length - 1)
        : (activeIndex + step + list.length) % list.length
      setActiveValue(list[next].value)
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      const candidate = visible[activeIndex]
      if (candidate) choose(candidate)
      else hide()
    } else if (event.key === 'Escape' && open) {
      // 只收起候选列表，不让外层的设置侧页一起关闭。
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
  }

  return (
    <div
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        // 列表随文档流展开，收起会让下面的控件上移。鼠标按下引起的失焦要等这次点击完成再收起，
        // 否则按下与松开落在不同位置，点击会丢。
        if (pointerPressed.current) document.addEventListener('pointerup', () => window.setTimeout(hide, 0), { once: true, capture: true })
        else hide()
      }}
    >
      <Label htmlFor={inputId}>{text('model（模型名称）', 'model')}</Label>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={inputId}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 && visible[activeIndex] ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            className="pr-8"
            onChange={(event) => {
              onInput(event.target.value)
              show(event.target.value)
              setActiveValue(null)
            }}
            onKeyDown={handleKeyDown}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? text('收起候选模型', 'Hide model suggestions') : text('展开候选模型', 'Show model suggestions')}
            aria-expanded={open}
            aria-controls={listId}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              if (open) hide()
              else show(null)
              document.getElementById(inputId)?.focus()
            }}
            className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            <ChevronDown size={14} className={cn(open && 'rotate-180')} />
          </button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-label={text('获取模型列表', 'Refresh model list')}
          title={text('获取模型列表', 'Refresh model list')}
          onClick={() => {
            // 手动刷新本身就是一次获取，展开列表时不再经 onOpen 触发自动获取。
            onRefresh()
            setOpen(true)
            setQuery(null)
            setActiveValue(null)
            // 获取期间按钮会禁用，焦点留在上面会丢；交回输入框，方向键可以直接选。
            document.getElementById(inputId)?.focus()
          }}
          disabled={refreshing}
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} aria-hidden />
        </Button>
      </div>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={text('候选模型', 'Model suggestions')}
          className="mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-[var(--radius)] border border-[var(--rule-strong)] bg-[var(--layer)] p-1"
        >
          {visible.map((candidate, index) => (
            <li
              key={candidate.value}
              id={optionId(index)}
              data-index={index}
              role="option"
              aria-selected={candidate.value === value}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(candidate)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--ink)] hover:bg-[var(--wash)]',
                index === activeIndex && 'bg-[var(--wash)] shadow-[inset_0_0_0_2px_var(--accent)]',
                candidate.value === value && 'font-medium',
              )}
            >
              <span className="min-w-0 flex-1 break-all">{candidate.value}</span>
              {candidate.label && <span className="min-w-0 shrink truncate text-[var(--ink-3)]">{candidate.label}</span>}
              {candidate.recommended && (
                <span className="shrink-0 text-[var(--ink-3)]">{text('推荐', 'Recommended')}</span>
              )}
            </li>
          ))}
          {visible.length === 0 && (
            <li role="presentation" className="px-2 py-1.5 text-xs text-[var(--ink-3)]">
              {candidates.length === 0
                ? text('暂无候选模型，可直接输入模型名称。', 'No suggestions. Type a model name.')
                : text('没有匹配的候选，将使用输入的名称。', 'No matching suggestions. The typed name will be used.')}
            </li>
          )}
        </ul>
      )}
      {status && (
        <p
          role="status"
          className="mt-1 text-xs"
          style={{ color: status.tone === 'error' ? 'var(--color-error-text)' : 'var(--ink-3)' }}
        >
          {status.text}
        </p>
      )}
    </div>
  )
}
