import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { requireIpcSuccess } from '../../../services/ipc-result'
import type { ProjectData } from '../../../shared/ipc-channels'
import { pluralEn } from '../../../shared/plural-en'
import { registerEditorExitSaveHandler, useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { toast } from '../../ui/Toast'
import { commandLabel } from '../shortcut-keys'
import { RECOVERY_PREFIX } from './chapter-tab-routing'

/**
 * 恢复候选可以编辑，保存只写回这份候选，不会写进正式草稿（F-072）；作者确认没问题后，再从章节里另起一稿。
 * 修稿只读：它已经合并或放弃，这里只供对照。
 */
export default function ProseDocument({ tab, project }: { tab: EditorTab; project: ProjectData }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const recovery = tab.filePath?.startsWith(RECOVERY_PREFIX) ?? false
  const [units, setUnits] = useState(0)
  const [saving, setSaving] = useState(false)
  const latest = useRef(tab.content ?? '')

  const persist = useCallback(async (content: string) => {
    const session = captureProjectSession(project)
    const candidateId = tab.filePath?.slice(RECOVERY_PREFIX.length)
    if (!session || !candidateId || !isProjectSessionPath(session, tab.projectKey)) return
    const current = useEditorStore.getState().tabs.find(candidate => candidate.id === tab.id)
    if (!current) return
    const snapshot = { content, contentRevision: current.contentRevision ?? 0 }
    const result = await ipc.invokeWithProjectSession(session, 'db:recovery-candidate-update', candidateId, content, session.projectPath)
    requireIpcSuccess(result, text('保存恢复候选', 'Save recovery candidate'))
    if (!isProjectSessionCurrent(session)) return
    useEditorStore.getState().settleTabSave(tab.id, snapshot)
  }, [project, tab.filePath, tab.id, tab.projectKey, text])

  const save = useCallback(async (content: string, propagate = false) => {
    setSaving(true)
    try {
      await persist(content)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : text('保存失败', 'Save failed'))
      if (propagate) throw error
    } finally {
      setSaving(false)
    }
  }, [persist, text])

  useEffect(() => {
    if (!recovery) return
    registerEditorExitSaveHandler({ tabId: tab.id, type: tab.type, projectKey: tab.projectKey, save: () => save(latest.current, true) })
  }, [recovery, save, tab.id, tab.projectKey, tab.type])

  const wordCount = text(`${units.toLocaleString(locale)} 字`, `${units.toLocaleString(locale)} ${pluralEn(units, 'word')}`)
  return (
    <div className="stage-ch stage-doc">
      <div className="stage-ch-scroll">
        <article className="stage-ch-page">
          <header className="stage-ch-head">
            <div className="stage-ch-kicker">
              <span className="stage-ch-eyebrow">{recovery ? text('正文 · 恢复候选', 'Manuscript · Recovery candidate') : text('正文 · 修稿', 'Manuscript · Revision')}</span>
            </div>
            <div className="stage-ch-titlerow">
              <h1 className="stage-ch-title stage-doc-title">{tab.name}</h1>
              {recovery && (
                <Button variant="primary" size="sm" disabled={saving || !tab.dirty} aria-busy={saving || undefined} title={commandLabel('s')} onClick={() => { void save(latest.current) }}>
                  {saving ? text('保存中…', 'Saving…') : text('保存候选', 'Save candidate')}
                </Button>
              )}
            </div>
            <p className="stage-doc-meta">{wordCount}</p>
          </header>
          <div className="stage-ch-notices">
            {recovery
              ? (
                <Notice title={text('项目恢复候选；不会自动写入正式草稿', 'Project recovery candidate; it is not written to the formal draft automatically')}>
                  {text('保存只更新这份候选。确认内容后，到这一章里另起一稿。', 'Saving only updates this candidate. When it reads right, start a new draft from the chapter.')}
                </Notice>
              )
              : <Notice title={text('这份修稿已经合并或放弃，只能查看', 'This revision was merged or discarded and is read-only')} />}
          </div>
          <div className="stage-ch-prose" data-readonly={!recovery || undefined}>
            <CodeMirrorEditor
              key={tab.id}
              mode="prose"
              fitContent
              paragraphIndent
              content={tab.content ?? ''}
              filePath={tab.filePath}
              editable={recovery}
              hideStatusBar
              onCharCountChange={setUnits}
              onChange={value => {
                if (!recovery) return
                latest.current = value
                useEditorStore.getState().updateTabContent(tab.id, value)
              }}
              onSave={recovery ? value => save(value) : undefined}
            />
          </div>
        </article>
      </div>
    </div>
  )
}
