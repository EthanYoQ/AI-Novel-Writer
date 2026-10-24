import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { isComposing } from '../stage/shortcut-keys'
import type { DiscoveredModel } from '../../shared/ipc-channels'

function displayName(model: DiscoveredModel): string | undefined {
  return model.name !== model.value && model.name !== model.id ? model.name : undefined
}

function matches(model: DiscoveredModel, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || model.value.toLowerCase().includes(needle) || Boolean(displayName(model)?.toLowerCase().includes(needle))
}

export function ModelNameField({
  value, placeholder, candidates, refreshing, status, onInput, onSelect, onOpen, onRefresh,
}: {
  value: string
  placeholder: string
  candidates: readonly DiscoveredModel[]
  refreshing: boolean
  status: { text: string, tone: 'muted' | 'error' } | null
  onInput: (value: string) => void
  onSelect: (candidate: DiscoveredModel) => void
  onOpen: () => void
  onRefresh: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const inputId = useId()
  const listId = useId()
  const statusId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const visible = query === null ? candidates : candidates.filter(candidate => matches(candidate, query))
  const activeIndex = activeValue === null ? -1 : visible.findIndex(candidate => candidate.value === activeValue)
  const optionId = (index: number) => `${listId}-option-${index}`
  const listShown = open && visible.length > 0
  // 列表还没拉到时由状态行说明原因；这里只说明输入的名称没有匹配的候选。
  const emptyHint = open && !refreshing && !listShown && candidates.length > 0
    ? text('没有匹配的候选，将使用输入的名称。', 'No matching suggestions. The typed name will be used.')
    : null

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

  const show = (nextQuery: string | null, { autoFetch = true } = {}) => {
    if (!open && autoFetch) onOpen()
    setOpen(true)
    setQuery(nextQuery)
  }
  const hide = () => {
    setOpen(false)
    setQuery(null)
    setActiveValue(null)
  }
  const choose = (candidate: DiscoveredModel) => {
    if (refreshing) return
    onSelect(candidate)
    hide()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
      else if (!refreshing) hide()
    } else if (event.key === 'Escape' && open) {
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
            aria-expanded={listShown}
            aria-controls={listShown ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 && visible[activeIndex] ? optionId(activeIndex) : undefined}
            aria-describedby={status || emptyHint ? statusId : undefined}
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
            aria-label={listShown ? text('收起候选模型', 'Hide model suggestions') : text('展开候选模型', 'Show model suggestions')}
            aria-expanded={listShown}
            aria-controls={listShown ? listId : undefined}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              if (listShown) hide()
              else show(null)
              document.getElementById(inputId)?.focus()
            }}
            className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            <ChevronDown size={14} className={cn(listShown && 'rotate-180')} />
          </button>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="w-10 shrink-0 px-0"
          aria-label={text('获取模型列表', 'Refresh model list')}
          title={text('获取模型列表', 'Refresh model list')}
          onClick={() => {
            onRefresh()
            show(null, { autoFetch: false })
            setActiveValue(null)
            // 获取期间按钮会禁用，焦点留在上面会丢。
            document.getElementById(inputId)?.focus()
          }}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden />
        </Button>
      </div>
      {(status || emptyHint) && (
        <p id={statusId} role="status" className="mt-1 text-xs text-[var(--ink-3)]">
          {status && <span className={cn('block', status.tone === 'error' && 'text-[var(--danger)]')}>{status.text}</span>}
          {emptyHint && <span className="block">{emptyHint}</span>}
        </p>
      )}
      {listShown && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={text('候选模型', 'Model suggestions')}
          aria-busy={refreshing}
          onMouseDown={event => event.preventDefault()}
          className="mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border border-[var(--rule-strong)] bg-[var(--layer)] p-1"
        >
          {visible.map((candidate, index) => (
            <li
              key={candidate.value}
              id={optionId(index)}
              data-index={index}
              role="option"
              aria-selected={candidate.value === value}
              aria-disabled={refreshing || undefined}
              onClick={() => choose(candidate)}
              className={cn(
                'flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[length:var(--fs-14)] text-[var(--ink)]',
                refreshing ? 'cursor-default text-[var(--ink-3)]' : 'cursor-pointer hover:bg-[var(--wash)]',
                index === activeIndex && 'bg-[var(--wash)] shadow-[inset_0_0_0_2px_var(--accent)]',
                candidate.value === value && 'font-medium',
              )}
            >
              <span className="min-w-0 flex-1 break-words">{candidate.value}</span>
              {displayName(candidate) && <span className="min-w-0 shrink truncate text-[var(--ink-3)]">{displayName(candidate)}</span>}
              {candidate.value === value && <Check size={14} className="shrink-0" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
