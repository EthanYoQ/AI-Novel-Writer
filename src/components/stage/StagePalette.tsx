import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowUpDown, CornerDownLeft, Search } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { keepToastStackClickable } from '../ui/ToastStack'
import type { StagePalette as PaletteMode } from '../../stores/navigation/stage-store'
import { filterPalette, GROUP_LABELS, GROUP_ORDER, type PaletteItem } from './palette-filter'
import { commandLabel, isComposing } from './shortcut-keys'

interface StagePaletteProps {
  mode: PaletteMode | null
  items: readonly PaletteItem[]
  container: HTMLElement | null
  onClose: () => void
}

function PaletteBody({ mode, items, onClose }: { mode: PaletteMode; items: readonly PaletteItem[]; onClose: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const results = useMemo(() => filterPalette(items, query, mode), [items, query, mode])
  const optionId = (index: number) => `${listId}-option-${index}`
  const current = Math.min(active, Math.max(0, results.length - 1))

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return
    const last = results.length - 1
    const next = event.key === 'ArrowDown' ? (current >= last ? 0 : current + 1)
      : event.key === 'ArrowUp' ? (current <= 0 ? last : current - 1)
        : event.key === 'Home' && event.ctrlKey ? 0
          : event.key === 'End' && event.ctrlKey ? last
            : null
    if (next !== null && results.length > 0) {
      event.preventDefault()
      setActive(next)
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(results[current])
    }
  }

  const groups = mode === 'chapters' ? (['chapter'] as const) : GROUP_ORDER
  return (
    <>
      <div className="stage-palette-input">
        <Search size={16} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
          aria-label={mode === 'chapters' ? text('查找章节', 'Find a chapter') : text('搜索与跳转', 'Search and jump')}
          placeholder={mode === 'chapters'
            ? text('输入章号或标题，例如 3', 'Type a chapter number or title, e.g. 3')
            : text('搜索章节、角色，或跳转到任意阶段', 'Search chapters and characters, or jump to any stage')}
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        <kbd>{commandLabel(mode === 'chapters' ? 'p' : 'k')}</kbd>
      </div>
      <div className="stage-palette-list" id={listId} role="listbox" aria-label={text('结果', 'Results')}>
        {results.length === 0 && <p className="stage-palette-empty">{text('没有找到匹配的内容', 'No matches')}</p>}
        {groups.map(group => {
          const groupItems = results.filter(item => item.group === group)
          if (groupItems.length === 0) return null
          return (
            <div key={group} role="group" aria-label={text(...GROUP_LABELS[group])} className="stage-palette-group">
              {mode !== 'chapters' && <div className="stage-palette-group-label" aria-hidden="true">{text(...GROUP_LABELS[group])}</div>}
              {groupItems.map(item => {
                const position = results.indexOf(item)
                return (
                  <div
                    key={item.id}
                    id={optionId(position)}
                    role="option"
                    aria-selected={position === current}
                    className="stage-palette-option"
                    onPointerMove={() => setActive(position)}
                    onClick={() => choose(item)}
                  >
                    <span className="stage-palette-no" aria-hidden={item.chapter === undefined}>{item.chapter ?? ''}</span>
                    <span className="stage-palette-label">{item.label}</span>
                    {item.meta && <span className="stage-palette-meta">{item.meta}</span>}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="stage-palette-foot" aria-hidden="true">
        <span><kbd><ArrowUpDown size={11} /></kbd>{text('选择', 'Move')}</span>
        <span><kbd><CornerDownLeft size={11} /></kbd>{text('打开', 'Open')}</span>
        <span><kbd>Esc</kbd>{text('关闭', 'Close')}</span>
      </div>
    </>
  )
}

export default function StagePalette({ mode, items, container, onClose }: StagePaletteProps) {
  const text = useLocaleStore(s => s.text)
  return (
    <DialogPrimitive.Root open={mode !== null} onOpenChange={open => { if (!open) onClose() }}>
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Overlay className="stage-palette-scrim" />
        <DialogPrimitive.Content className="stage-palette" aria-describedby={undefined} onPointerDownOutside={keepToastStackClickable}>
          <DialogPrimitive.Title className="stage-visually-hidden">
            {mode === 'chapters' ? text('查找章节', 'Find a chapter') : text('搜索与跳转', 'Search and jump')}
          </DialogPrimitive.Title>
          {mode && <PaletteBody key={mode} mode={mode} items={items} onClose={onClose} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
