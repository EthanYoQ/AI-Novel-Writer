/**
 * ChapterWorldSettingRefs — 章节蓝图页的「本章引用」区
 *
 * 先生定的形态：**一个框体装下全部**。
 *   · 已引用的设定以 chip 形式排在框**内**（不再单独占一行放在输入框上方）；
 *   · 框内可直接继续输入 @ 引用下一条；
 *   · 内容变多时**框内滚动**，右下角还能**拖拽放大**，再多也看得过来。
 *
 * 两个简化（先生要求）：
 *   · @ **不再弹类别菜单** —— 这里只允许引用世界观设定，直接进条目列表
 *     （MentionMenu 的 directTo），少点一层；
 *   · 菜单在框体**下方**展开，不会顶到表单顶部被切掉。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'

import MentionMenu, { type MentionAnchor } from '../panels/agent/MentionMenu'
import { toast } from '../ui/Toast'
import { useLocaleStore } from '../../stores/locale-store'
import { useWorldSettingStore } from '../../stores/world-setting-store'
import type { MentionTarget } from '../../services/agent/intent-router'

interface Props {
  /** 当前正在编辑的章节号。 */
  chapterNumber: number
}

/**
 * 没有引用的章节共用这一个空数组。
 * 直接写 `?? []` 每次渲染都是新引用，会让下面依赖它的 useMemo 每渲染一次就重算
 * （并且是「值没变但依赖变了」的假变化）。
 */
const EMPTY_CHAPTER_IDS: number[] = []

export default function ChapterWorldSettingRefs({ chapterNumber }: Props) {
  const text = useLocaleStore(s => s.text)
  const entries = useWorldSettingStore(s => s.entries)
  const chapterRefs = useWorldSettingStore(s => s.chapterRefs)
  const loadChapterRefs = useWorldSettingStore(s => s.loadChapterRefs)
  const addChapterRef = useWorldSettingStore(s => s.addChapterRef)
  const removeChapterRef = useWorldSettingStore(s => s.removeChapterRef)

  const [inputValue, setInputValue] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  /** 输入框在屏幕上的位置：@ 菜单贴着它展开。 */
  const [mentionAnchor, setMentionAnchor] = useState<MentionAnchor | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 中文输入法组合态：组合中不触发 @ 检测，避免拼音 / 上屏中途把 @ 与文字错位。 */
  const composingRef = useRef(false)

  useEffect(() => {
    if (Number.isInteger(chapterNumber)) void loadChapterRefs(chapterNumber)
  }, [chapterNumber, loadChapterRefs])

  const referencedIds = chapterRefs[chapterNumber] ?? EMPTY_CHAPTER_IDS
  const referencedEntries = useMemo(
    () => referencedIds
      .map(id => entries.find(entry => entry.id === id))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [referencedIds, entries],
  )

  /** 输入 @ 就弹菜单；这里只允许设定，所以菜单直接进分类层。 */
  const handleChange = (value: string) => {
    setInputValue(value)
    if (composingRef.current) return
    const atIndex = value.lastIndexOf('@')
    if (atIndex >= 0) {
      // 记下输入框位置：菜单贴着它展开
      const rect = inputRef.current?.getBoundingClientRect()
      if (rect && typeof window !== 'undefined') {
        setMentionAnchor({
          left: rect.left,
          top: rect.top,
          bottom: rect.bottom,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
        })
      }
      setMentionQuery(value.slice(atIndex + 1))
      setShowMention(true)
    } else {
      setShowMention(false)
      setMentionQuery('')
    }
  }

  const handleMentionSelect = (target: MentionTarget) => {
    setShowMention(false)
    setInputValue('')
    setMentionQuery('')
    const entry = entries.find(item => item.name === target.value && item.status !== 'pending')
    if (!entry) {
      toast.error(text('没有找到这条已确认的设定。', 'That confirmed entry could not be found.'))
      return
    }
    if (referencedIds.includes(entry.id)) {
      toast.info(text(`「${entry.name}」已经在本章引用里了`, `“${entry.name}” is already referenced`))
      return
    }
    void addChapterRef(chapterNumber, entry.id).then((ok) => {
      if (ok) toast.success(text(`已引用「${entry.name}」`, `Referenced “${entry.name}”`))
      else toast.error(text('引用失败，请重试', 'Could not add the reference. Please try again.'))
    })
  }

  return (
    <div className="fld">
      <div className="fh">
        <span className="fk">REF</span>
        <span className="fn">{text('本章引用的设定', 'Referenced settings')}</span>
        <span className="opt">{text('选填', 'Optional')}</span>
        <span className="hint">
          {text(
            '写这一章时会带上这些设定；输入 @ 继续引用',
            'These entries are included when this chapter is written; type @ to add more',
          )}
        </span>
      </div>

      {/* 菜单定位基准：菜单挂在框体下方展开 */}
      <div className="relative">
        <div
          className="flex flex-wrap items-center gap-1.5"
          onClick={() => inputRef.current?.focus()}
          style={{
            minHeight: 40,
            maxHeight: 240,
            padding: '7px 10px',
            borderRadius: 8,
            border: '1px solid var(--line2, rgba(0,0,0,.12))',
            backgroundColor: 'var(--panel, #FFFDF7)',
            /* 先生：给框体右下角留出可拖拽放大的能力，内容再多也看得过来 */
            resize: 'vertical',
            overflow: 'auto',
          }}
        >
          {/* 已引用的设定：就在框内，可逐个移除 */}
          {referencedEntries.map(entry => (
            <span
              key={entry.id}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs flex-shrink-0"
              style={{
                backgroundColor: 'var(--color-hover)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
              title={entry.summary || entry.name}
            >
              {entry.name}
              <button
                type="button"
                className="cursor-pointer opacity-60 hover:opacity-100"
                aria-label={text('移除引用', 'Remove reference')}
                onClick={(event) => {
                  event.stopPropagation()
                  void removeChapterRef(chapterNumber, entry.id).then((ok) => {
                    if (!ok) toast.error(text('移除失败，请重试', 'Could not remove. Please try again.'))
                  })
                }}
              >
                <X size={9} />
              </button>
            </span>
          ))}

          {/* 输入行：与 chip 同一排，框内继续追加 */}
          <input
            ref={inputRef}
            value={inputValue}
            onChange={event => handleChange(event.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={(event) => {
              composingRef.current = false
              handleChange(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              // 菜单打开时把方向键与回车让给菜单（它自己处理 window 级键盘）
              if (showMention && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return
              if (event.key === 'Escape') {
                setShowMention(false)
                setInputValue('')
              }
            }}
            onBlur={() => {
              if (!inputValue.trim()) setShowMention(false)
            }}
            placeholder={referencedEntries.length === 0
              ? text('输入 @ 引用世界观设定…', 'Type @ to reference a world-setting entry…')
              : text('@', '@')}
            aria-label={text('引用设定', 'Reference settings')}
            className="flex-1 border-0 outline-none bg-transparent py-1 text-xs"
            style={{
              minWidth: 140,
              color: 'var(--color-text)',
              /* 清掉全局 input:focus-visible 的光晕，避免框里套出一个小红框 */
              boxShadow: 'none',
            }}
          />
        </div>

        {showMention && (
          <MentionMenu
            query={mentionQuery}
            onSelect={handleMentionSelect}
            onClose={() => { setShowMention(false); setInputValue('') }}
            anchor={mentionAnchor}
            /* 跳过最外层类别，直接从「设定分类」开始（这里只引用世界观设定） */
            directTo="world-setting"
          />
        )}
      </div>
    </div>
  )
}
