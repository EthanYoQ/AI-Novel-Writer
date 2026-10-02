/**
 * WorldSettingChapterRefDialog — 把一条世界观设定引用进某一章
 *
 * 先生要的：条目页在「@ 助手」旁边也要有「@ 章节蓝图」。
 *
 * 三条硬规矩：
 *   1. **已定稿 / 已归档的章节不出现在列表里** —— 那几章已入库，再挂引用没意义；
 *   2. **控件一律用项目自己的设计系统** —— 搜索框用 Input 组件、按钮用 .btn 系列、
 *      配色走主题变量，不再自己写一套（那种"照设计稿手搓"的写法会让弹窗与
 *      其它窗口格格不入）；
 *   3. 交互照设计稿：**多选后一次提交**，序号徽章与复选框保留（那是这套稿子的优点）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog'
import { Input } from '../ui/Input'
import PageHead from '../ui/PageHead'
import { toast } from '../ui/Toast'
import { ipc } from '../../services/ipc-client'
import { captureProjectSession } from '../project-session-gate'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorldSettingStore } from '../../stores/world-setting-store'
import { loadDirectoryBlueprints } from '../../services/workflows/directory-workflow'

interface ChapterOption {
  chapterNumber: number
  title: string
}

interface Props {
  open: boolean
  /** 要引用进章节的条目（未保存的新条目没有 id，此时传 null）。 */
  settingId: number | null
  settingName: string
  onClose: () => void
}

export default function WorldSettingChapterRefDialog({ open, settingId, settingName, onClose }: Props) {
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  const addChapterRef = useWorldSettingStore(s => s.addChapterRef)
  const [chapters, setChapters] = useState<ChapterOption[]>([])
  /** 被排除的章节数（已定稿/已归档）——让作者知道它们不是漏了。 */
  const [excludedCount, setExcludedCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    // 打开对话框 = 开始一次新的引用操作：上一轮的搜索词与勾选必须清掉，
    // 否则会带着上次的残留提交。这两项是用户输入的命令式状态，清空动作必须
    // 与紧随其后的章节读取发生在同一次 effect 里（同一提交、同一会话校验），
    // 无法拆成派生值。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置上一次的搜索与勾选（见上）
    setQuery('')
    setSelected(new Set())
    let cancelled = false
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) {
      setChapters([])
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const [blueprints, drafts] = await Promise.all([
          loadDirectoryBlueprints(projectSession.projectPath, projectSession),
          // 已定稿 / 已归档的章节不再改动，挂引用没有意义
          ipc.invokeWithProjectSession(projectSession, 'db:draft-list-all', projectSession.projectPath),
        ])
        if (cancelled) return
        const closedChapters = new Set(
          (Array.isArray(drafts) ? drafts : [])
            .filter(item => item.status === 'finalized' || item.status === 'archived')
            .map(item => item.chapterNumber),
        )
        const openChapters = blueprints.filter(item => !closedChapters.has(item.chapterNumber))
        setChapters(openChapters.map(item => ({ chapterNumber: item.chapterNumber, title: item.title ?? '' })))
        setExcludedCount(blueprints.length - openChapters.length)
      } catch {
        if (!cancelled) {
          setChapters([])
          setExcludedCount(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, currentProject])

  const visibleChapters = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return chapters
    return chapters.filter(chapter => (
      String(chapter.chapterNumber).includes(q)
      || chapter.title.toLocaleLowerCase().includes(q)
    ))
  }, [chapters, query])

  const toggle = (chapterNumber: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(chapterNumber)) next.delete(chapterNumber)
      else next.add(chapterNumber)
      return next
    })
  }

  const handleConfirm = async () => {
    if (settingId === null) {
      toast.error(text('先把这条设定保存下来，再引用到章节。', 'Save this entry first, then reference it into a chapter.'))
      return
    }
    if (selected.size === 0) {
      toast.info(text('请至少选择一个章节', 'Pick at least one chapter'))
      return
    }
    setBusy(true)
    let added = 0
    for (const chapterNumber of selected) {
      const ok = await addChapterRef(chapterNumber, settingId)
      if (ok) added += 1
    }
    setBusy(false)
    if (added > 0) toast.success(text(`已引用到 ${added} 章`, `Referenced into ${added} chapters`))
    else toast.error(text('引用失败，请重试', 'Could not add the references. Please try again.'))
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      {/* 先生：做宽一点更大气（窄框里那一列章节名显得局促） */}
      <DialogContent
        className="max-w-2xl"
        /* 先生：正在逐章挑该引用到哪一章，误点蒙版会白挑一遍。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {/*
          先生：标头沿用「GENERATION MODELS / AI 生成模型 / 配置用于…」那套设计语言 ——
          也就是项目 PageHead 的朱砂眉标 + 标题 + 说明三层。
          DialogTitle 保留为 sr-only，无障碍名称不至于丢。
        */}
        <DialogHeader>
          <DialogTitle className="sr-only">{text('引用到章节蓝图', 'Reference into a chapter')}</DialogTitle>
          <PageHead
            kicker={text('WORLD SETTING REF · 章节引用', 'WORLD SETTING REF')}
            title={text('引用到章节蓝图', 'Reference into a chapter')}
            description={[
              text(
                `把「${settingName}」挂到具体章节上，勾选后一次提交。`,
                `Attach “${settingName}” to chapters; tick the ones you need and submit once.`,
              ),
              excludedCount > 0
                ? text(`已定稿的 ${excludedCount} 章不在此列。`, `${excludedCount} finalized chapters are hidden.`)
                : '',
            ].filter(Boolean).join(' ')}
          />
        </DialogHeader>

        <div className="px-6 pt-4">
          {/* 搜索：用项目 Input 组件（与侧栏、设置里的搜索同一套规格） */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={text('搜索章节号或标题', 'Search chapter number or title')}
                aria-label={text('搜索章节', 'Search chapters')}
                className="h-9 pl-7 text-sm"
              />
            </div>
            <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--color-text-muted)]">
              {text(`可引用 ${visibleChapters.length} 章`, `${visibleChapters.length} available`)}
            </span>
          </div>
        </div>

        {/* 章节清单：序号徽章 + 复选框是这套稿子的优点，保留；颜色走主题变量 */}
        {/* 章节行距减半（先生：原先两行之间空得太开） */}
        <div className="px-6 pt-3 pb-1 flex flex-col gap-[3px] max-h-[40vh] overflow-y-auto">
          {loading && (
            <div className="py-4 text-center text-sm text-[var(--color-text-muted)]">
              {text('正在读取章节…', 'Loading chapters…')}
            </div>
          )}
          {!loading && chapters.length === 0 && (
            <div className="py-5 text-center text-sm text-[var(--color-text-muted)]">
              {text(
                '没有可引用的章节。可以先去「蓝图」新建几章，或那些章节都已定稿。',
                'No chapters available — create some in Blueprint, or they are all finalized.',
              )}
            </div>
          )}
          {!loading && chapters.length > 0 && visibleChapters.length === 0 && (
            <div className="py-5 text-center text-sm text-[var(--color-text-muted)]">
              {text('没有匹配的章节', 'No matching chapters')}
            </div>
          )}

          {visibleChapters.map((chapter) => {
            const isSelected = selected.has(chapter.chapterNumber)
            return (
              <button
                key={chapter.chapterNumber}
                type="button"
                onClick={() => toggle(chapter.chapterNumber)}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors"
                style={{
                  backgroundColor: isSelected ? 'var(--color-active)' : 'transparent',
                  color: 'var(--color-text)',
                }}
                onMouseEnter={event => {
                  if (!isSelected) event.currentTarget.style.backgroundColor = 'var(--color-hover)'
                }}
                onMouseLeave={event => {
                  if (!isSelected) event.currentTarget.style.backgroundColor = 'transparent'
                }}
              >
                {/*
                  先生：序号不要小方块底 —— 那个浅色底在章节名旁边很显眼，
                  去掉后数字直接落在纸面上，阅读才无感。选中时只用强调色区分。
                */}
                <span
                  className="flex-shrink-0 text-[12px] font-semibold tabular-nums transition-colors"
                  style={{
                    minWidth: 20,
                    textAlign: 'right',
                    color: isSelected ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  }}
                >
                  {chapter.chapterNumber}
                </span>

                <span className="flex-1 truncate">{chapter.title || text('未命名', 'Untitled')}</span>

                <span
                  className="flex-shrink-0 flex items-center justify-center rounded transition-colors"
                  style={{
                    width: 19,
                    height: 19,
                    border: `1.5px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    backgroundColor: isSelected ? 'var(--color-accent)' : 'transparent',
                  }}
                >
                  <Check
                    size={12}
                    aria-hidden="true"
                    style={{
                      color: '#fff',
                      opacity: isSelected ? 1 : 0,
                      transform: isSelected ? 'scale(1)' : 'scale(0.5)',
                      transition: 'all .18s cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                  />
                </span>
              </button>
            )
          })}
        </div>

        {/* 底部：项目标准按钮，主操作右对齐 */}
        <DialogFooter className="justify-end gap-2">
          <button
            className="btn ghost sm"
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ fontSize: '12.6px', padding: '0 14px' }}
          >
            {text('取消', 'Cancel')}
          </button>
          <button
            className="btn primary sm"
            type="button"
            onClick={() => { void handleConfirm() }}
            disabled={busy || selected.size === 0}
            style={{ fontSize: '12.6px', padding: '0 14px' }}
          >
            {selected.size > 0
              ? text(`完成（${selected.size} 章）`, `Done (${selected.size})`)
              : text('完成', 'Done')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
