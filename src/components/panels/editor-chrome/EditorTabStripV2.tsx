/**
 * 正文栏标签栏（v2「墨纸书斋」）。
 *
 * 结构完全照 demo 的 .tabbar（shell.css 161–180 行）：
 *
 *   <div class="tabbar">
 *     <div class="tabs">            ← 横向滚动区，滚动条隐藏
 *       <div class="tab on"> svg + .tn(标题) + .tx(关闭) </div>
 *     </div>
 *     <div class="tb-side"> …工具按钮 </div>
 *   </div>
 *
 * 之所以要真做一层 DOM，而不是继续给 v1 的内联样式打补丁：v2 此前的皮肤靠
 * `[style*='--color-tab-active']` 这类结构选择器穿透 React 内联样式，一改组件就会失配。
 * 现在标签栏自己带上 demo 的类名，样式由 shell.css 原生给出，不再依赖内联值。
 *
 * demo 的 .tb-side 只有「沉浸写作」一个按钮；产品的上一个/下一个编辑器、已打开列表
 * 是既有能力，换壳不删功能，统一收在同一侧区里。
 */
import { useEffect, useRef, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, MoreHorizontal, X } from 'lucide-react'
import type { EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { EditorTabIcon } from './tab-icons'

export interface EditorTabStripV2Props {
  tabs: EditorTab[]
  activeTabId: string | null
  /** 沉浸写作态：按钮显示「退出沉浸写作」 */
  focusMode: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onContextMenu: (tabId: string, event: MouseEvent<HTMLDivElement>) => void
  onPrev: () => void
  onNext: () => void
  /** 已打开的编辑器列表（三点菜单） */
  onOpenList: (event: MouseEvent<HTMLButtonElement>) => void
  onToggleFocus: () => void
}

export default function EditorTabStripV2({
  tabs,
  activeTabId,
  focusMode,
  onActivate,
  onClose,
  onContextMenu,
  onPrev,
  onNext,
  onOpenList,
  onToggleFocus,
}: EditorTabStripV2Props) {
  const text = useLocaleStore((s) => s.text)
  const activeRef = useRef<HTMLDivElement>(null)

  // 激活的标签始终滚进可视区（demo 的标签栏同样不会把当前页藏在滚动区外）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeTabId])

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : undefined}
              className={`tab${active ? ' on' : ''}`}
              title={tab.name}
              onClick={() => onActivate(tab.id)}
              onContextMenu={(event) => onContextMenu(tab.id, event)}
            >
              <EditorTabIcon type={tab.type} />
              <span className="tn">{tab.name}</span>
              {!tab.pinned && (
                <span
                  className="tx"
                  data-dirty={tab.dirty ? 'true' : undefined}
                  title={tab.dirty
                    ? text('有未保存的修改，点击关闭', 'Unsaved changes; click to close')
                    : text('关闭', 'Close')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose(tab.id)
                  }}
                >
                  {tab.dirty && <span className="tx-dot" aria-hidden="true" />}
                  <X size={10} className="tx-x" aria-hidden="true" />
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="tb-side">
        <button
          type="button"
          className="tb-btn"
          onClick={onToggleFocus}
          title={focusMode
            ? text('退出沉浸写作 · 展开侧栏与助手', 'Leave focus mode · show sidebar and assistant')
            : text('沉浸写作 · 收拢侧栏与助手', 'Focus mode · hide sidebar and assistant')}
        >
          {focusMode
            ? <Minimize2 size={13} strokeWidth={1.7} aria-hidden="true" />
            : <Maximize2 size={13} strokeWidth={1.7} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={onPrev}
          title={text('上一个编辑器', 'Previous editor')}
        >
          <ChevronLeft size={13} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={onNext}
          title={text('下一个编辑器', 'Next editor')}
        >
          <ChevronRight size={13} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={onOpenList}
          title={text('已打开的编辑器', 'Open editors')}
        >
          <MoreHorizontal size={13} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
