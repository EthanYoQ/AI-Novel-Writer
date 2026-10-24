import { MoreHorizontal } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { Menu, type MenuGroupSpec } from '../../ui/Menu'
import { containsHan } from '../../../i18n/app-errors'
import { coverTone } from './shelf-format'
import type { ShelfBook as Book } from './use-shelf-overview'

interface ShelfBookProps {
  book: Book
  selected: boolean
  /** 封面左上角的小字，当前作品写类型。 */
  kicker?: string
  /** 封面底部的旧式数字，当前作品写「定稿 / 规划」。 */
  figure?: string
  caption: string
  menu: readonly MenuGroupSpec[]
  onSelect: () => void
  onOpen: () => void
}

/** 书架上的一本书：点封面只预览，双击或菜单里打开；更多操作在封面下的菜单里。 */
export default function ShelfBook({ book, selected, kicker, figure, caption, menu, onSelect, onOpen }: ShelfBookProps) {
  const text = useLocaleStore(s => s.text)
  return (
    <li className="stage-book" data-tone={coverTone(book.name)} data-selected={selected || undefined}>
      <button
        type="button"
        className="stage-book-cover"
        aria-label={text(`预览《${book.name}》`, `Preview “${book.name}”`)}
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onOpen}
      >
        {kicker && <span className="stage-book-kicker">{kicker}</span>}
        <span className="stage-book-title" data-script={containsHan(book.name) ? 'cjk' : 'latin'}>{book.name}</span>
        {figure && <span className="stage-book-figure pi-num">{figure}</span>}
      </button>
      <div className="stage-book-foot">
        <div className="stage-book-caption">
          <span className="stage-book-name">{book.name}</span>
          <span className="stage-book-meta">{caption}</span>
        </div>
        <Menu
          label={text(`《${book.name}》更多操作`, `More for “${book.name}”`)}
          icon={<MoreHorizontal size={16} aria-hidden="true" />}
          align="end"
          groups={menu}
        />
      </div>
    </li>
  )
}
