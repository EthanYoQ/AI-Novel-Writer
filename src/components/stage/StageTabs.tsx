import { useEffect, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import type { EditorTab } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { stageTabName } from './stage-text'

interface StageTabsProps {
  tabs: readonly EditorTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  tabDomId: (tabId: string) => string
  panelId: string
}

/** 内容区标签条。只有一个标签时由外壳收起；←→ 在标签间移动，Delete 关闭当前聚焦的标签。 */
export default function StageTabs({ tabs, activeTabId, onSelect, onClose, tabDomId, panelId }: StageTabsProps) {
  const text = useLocaleStore(s => s.text)
  const list = useRef<HTMLDivElement>(null)

  // 标签条隐藏了滚动条，激活标签在可视区外时作者看不到它，也没有可拖的滚动条
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
      : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === 'Home' ? tabs[0]
          : event.key === 'End' ? tabs.at(-1)
            : undefined
    if (target) {
      event.preventDefault()
      onSelect(target.id)
      list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabDomId(target.id))}`)?.focus()
    } else if (event.key === 'Delete') {
      event.preventDefault()
      onClose(tabs[index].id)
    }
  }

  return (
    <div className="stage-tabs" role="tablist" aria-label={text('已打开的页面', 'Open pages')} ref={list}>
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId
        const name = stageTabName(tab, text)
        return (
          <div key={tab.id} className="stage-tab" role="presentation" data-active={active || undefined} data-dirty={tab.dirty || undefined}>
            <button
              type="button"
              role="tab"
              id={tabDomId(tab.id)}
              className="stage-tab-label"
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onKeyDown={event => onKeyDown(event, index)}
            >
              {name}
            </button>
            <button
              type="button"
              className="stage-tab-close"
              tabIndex={-1}
              aria-label={tab.dirty
                ? text(`关闭「${name}」，有未保存的修改`, `Close “${name}” (unsaved changes)`)
                : text(`关闭「${name}」`, `Close “${name}”`)}
              onClick={() => onClose(tab.id)}
            >
              <span className="stage-tab-dirty" aria-hidden="true" />
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
