import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DamagedTrashEntry, TrashedChapter } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'

export interface ChapterTrash {
  /** 新删的在前。 */
  entries: readonly TrashedChapter[]
  damaged: readonly DamagedTrashEntry[]
  /** 每章最近一次删除的那一项：蓝图页缺口卡只认它。 */
  byChapter: ReadonlyMap<number, TrashedChapter>
}

const EMPTY: ChapterTrash = { entries: [], damaged: [], byChapter: new Map() }

/** 通知回收站各处重读：删除、恢复、彻底删除、重试清理之后都发这一条。 */
export function announceTrashChanged(projectSession: ProjectSessionContext): void {
  globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath: projectSession.projectPath, projectSession })
}

/** 当前作品的回收站。读不到时当作空，不挡页面其余部分。 */
export function useChapterTrash(): ChapterTrash {
  const currentProject = useProjectStore(s => s.currentProject)
  const [state, setState] = useState<{ session: ProjectSessionContext | null; trash: ChapterTrash }>({ session: null, trash: EMPTY })
  const sequence = useRef(0)

  const load = useCallback(async (session: ProjectSessionContext) => {
    const request = ++sequence.current
    let trash = EMPTY
    try {
      const result = await ipc.invokeWithProjectSession(session, 'chapter:trash-list', session.projectPath)
      if (result.success) {
        const byChapter = new Map<number, TrashedChapter>()
        for (const entry of result.entries) if (!byChapter.has(entry.chapterNumber)) byChapter.set(entry.chapterNumber, entry)
        trash = { entries: result.entries, damaged: result.damaged, byChapter }
      }
    } catch {
      // 回收站读不到不影响写作，下次删除、恢复或重新打开作品时再读。
    }
    if (request === sequence.current && isProjectSessionCurrent(session)) setState({ session, trash })
  }, [])

  useEffect(() => {
    const session = captureProjectSession(currentProject)
    if (session) void load(session)
  }, [currentProject, load])

  useEffect(() => globalEventBus.on('CHAPTER_DELETION_UPDATED', ({ projectSession }) => {
    if (isProjectSessionCurrent(projectSession)) void load(projectSession)
  }), [load])

  const session = captureProjectSession(currentProject)
  const current = session && sameProjectSessionContext(state.session, session)
  return useMemo(() => current ? state.trash : EMPTY, [current, state.trash])
}
