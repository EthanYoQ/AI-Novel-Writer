/**
 * StickyNoteEditor — 便利贴编辑器。
 *
 * 先生（2026-09-20）：「看下草稿箱的编辑器这一块怎么设置处理的，我们完全一样处理不就行了？」
 * 于是本文件**逐行照 DraftEditor 的编辑器部分**写，只剥掉草稿专属的那些东西：
 *
 *   照搬的（一个都不改）：
 *     · 外层 `h-full flex flex-col overflow-hidden`
 *     · 顶栏 `flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0`
 *       + 底边框 + `--color-editor-bg` 底色
 *     · 编辑区 `flex-1 overflow-hidden relative`
 *     · CodeMirrorEditor **不传 key**、**显式 editable**、`mode="prose"`、`hideStatusBar`
 *     · 保存按钮**常驻在位**：改动过显示「保存」、没改动显示「已保存」并置灰
 *       （DraftEditor 的注释写着先生的原话：「早先这里是 {isDirty && 按钮}，
 *         一保存按钮整个消失，反馈无处可落」—— 便利贴正是那个旧写法）
 *
 *   剥掉的：修稿 / 审稿 / 定稿 / 待合并 / 后处理 —— 那些都会写创作事实，
 *   而便利贴是先生私人的本子，不参与任何创作链路。
 *
 *   加上的（先生 2026-09-20 第二次报障：「顶栏右上角没出现和 AI 互动的按钮」）：
 *   一颗「AI 灵感」按钮，就地抽卡，不必再回侧栏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Save, Sparkles } from 'lucide-react'

import { stickyNoteIdFromTabPath } from '../../shared/sticky-note'
import { useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useStickyNoteStore } from '../../stores/sticky-note-store'
import { useStickyDrawStore } from '../../stores/sticky-draw-store'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import CodeMirrorEditor from '../editor/CodeMirrorEditor'
import InspirationDrawDialog from '../dialogs/InspirationDrawDialog'

interface Props {
  tabId: string
  filePath: string
  content: string
}

export default function StickyNoteEditor({ tabId, filePath, content }: Props) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const noteId = stickyNoteIdFromTabPath(filePath)
  const noteTitle = useStickyNoteStore(s => (
    s.notes.find(note => note.noteId === noteId)?.title ?? ''
  ))

  const [charCount, setCharCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const currentBodyRef = useRef(content)

  useEffect(() => {
    currentBodyRef.current = content
  }, [content])

  const doSave = useCallback(async (next: string) => {
    if (!noteId) return
    setSaving(true)
    try {
      const tab = useEditorStore.getState().tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      const snapshot = { content: next, contentRevision: tab.contentRevision ?? 0 }
      // 会话校验在 store 里：切换项目后 saveBody 返回 null，这里就不会结算保存。
      const saved = await useStickyNoteStore.getState().saveBody(noteId, next)
      if (!saved) {
        toast.error(text('保存失败，请重试', 'Could not save. Please try again.'))
        return
      }
      useEditorStore.getState().settleTabSave(tabId, snapshot)
      setIsDirty(false)
    } finally {
      setSaving(false)
    }
  }, [noteId, tabId, text])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 —— 与 DraftEditor 同构 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{
          borderBottom: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-editor-bg)',
        }}
      >
        {/* 左侧：便利贴名 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text-secondary)' }}>
            {noteTitle.trim() || text('未命名便利贴', 'Untitled note')}
          </span>
          <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {text('便利贴', 'Note')}
          </span>
        </div>

        {/* 右侧：字数 + 脏标 + 保存（常驻）+ AI 灵感 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {charCount > 0 && (
            <span className="text-xs tabular-nums mr-1" style={{ color: 'var(--color-text-muted)' }}>
              {text(`${charCount.toLocaleString(locale)} 字`, `${charCount.toLocaleString(locale)} words`)}
            </span>
          )}

          {isDirty && (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0 mr-0.5"
              style={{ backgroundColor: 'var(--color-warning)' }}
              title={text('有未保存的修改', 'There are unsaved changes')}
            />
          )}

          {/*
            保存按钮**始终在位**：改过显示「保存」，没改显示「已保存」并置灰。
            这是照 DraftEditor 抄的 —— 先生的原话是「按钮整个消失，反馈无处可落」。
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void doSave(currentBodyRef.current) }}
            disabled={saving || !isDirty}
            title={text('保存（⌘S）', 'Save (Ctrl+S)')}
          >
            <Save size={12} />
            {isDirty ? text('保存', 'Save') : text('已保存', 'Saved')}
          </Button>

          {/*
            先生说这颗要和草稿的「AI 修稿」长一样才整齐 ——
            照 DraftEditor 那颗抄：variant="ai" + size="sm" + Sparkles 12。
          */}
          <Button
            variant="ai"
            size="sm"
            onClick={() => {
              /**
               * 开抽卡窗口走 store，不用本组件的 state。
               *
               * 先生切去看别的东西时，本编辑器（连同弹窗）会被卸载 ——
               * 状态放在 store 里，切回来才能照样看见那排牌面。
               */
              useStickyDrawStore.getState().openDialog()
            }}
            title={text('AI 灵感：按勾选的底稿与想法攒几条点子', 'AI ideas: draft several directions from what you include')}
          >
            <Sparkles size={12} />
            {text('AI 灵感', 'AI ideas')}
          </Button>
        </div>
      </div>

      {/* 编辑区 —— 与 DraftEditor 同构：relative 是给 CodeMirror 内部 absolute 层用的 */}
      <div className="flex-1 overflow-hidden relative">
        <CodeMirrorEditor
          mode="prose"
          content={content}
          filePath={filePath}
          editable
          /**
           * 先生：「便利贴毕竟不是正文或者草稿这种写文章的地方，而是个杂七杂八的帖子，
           * 因此不需要那种大红字。」—— 关掉首字下沉，正文与草稿的装帧一个字没动。
           */
          dropcap={false}
          hideStatusBar
          onCharCountChange={setCharCount}
          onChange={(next) => {
            currentBodyRef.current = next
            setIsDirty(true)
            useEditorStore.getState().updateTabContent(tabId, next)
          }}
          onSave={(next) => doSave(next)}
        />
      </div>

      {/*
        弹窗自己从 store 读开合与牌面。本编辑器切走时会被卸载、切回来重新挂载，
        而状态（drawing / result / cards）都活在 store 里，于是牌面一直在原处等着。
      */}
      <InspirationDrawDialog />
    </div>
  )
}
