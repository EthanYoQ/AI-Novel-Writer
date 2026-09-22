/**
 * 便利贴状态管理 —— 便利贴列表、文件夹、待选箱、追加与找回。
 *
 * 会话纪律照 draft-store：**先冻结会话 → 异步 → 回来双闸门**（请求序号仍最新，
 * 且冻结会话仍是当前会话）才写进 store。先生要的「切换项目，本子也跟着换」
 * 靠的就是这一层，而不是靠组件自己去比路径。
 *
 * 换项目时先把上一本的 notes/folders/candidates 清空再置 loading —— 否则切过去的
 * 一瞬间侧栏会挂着上一本书的便利贴，看着像串了项目。
 */
import { create } from 'zustand'

import type { ProjectSessionContext } from '../shared/ipc-channels'
import type {
  StickyCandidate,
  StickyDraw,
  StickyDrawRecordRequest,
  StickyFolder,
  StickyIdeaAppendRequest,
  StickyNote,
} from '../shared/sticky-note'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { ipc } from '../services/ipc-client'
import { useProjectStore } from './project-store'

let loadRequestSequence = 0

/** 空数组常量：直接写 `?? []` 每次渲染都是新引用，会让依赖它的 useMemo 反复重算。 */
export const EMPTY_STICKY_NOTES: StickyNote[] = []
export const EMPTY_STICKY_FOLDERS: StickyFolder[] = []
export const EMPTY_STICKY_CANDIDATES: StickyCandidate[] = []

function currentStickySession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

function isStickySessionCurrent(session: ProjectSessionContext): boolean {
  return sameProjectSessionContext(session, currentStickySession())
}

interface StickyNoteState {
  notes: StickyNote[]
  /** 便利贴文件夹（只做一层） */
  folders: StickyFolder[]
  /** 待选箱内容（只含仍在箱里的） */
  candidates: StickyCandidate[]
  loading: boolean
  /** 这份数据属于哪个项目会话；与当前会话不符时界面一律当空处理 */
  dataProjectSession: ProjectSessionContext | null

  load: () => Promise<void>
  /**
   * 已经绑定了当前项目的本子就什么都不做。
   *
   * ProjectTree 的 refreshAll 会被工作流进度、资源刷新等事件频繁触发
   * （80ms 防抖），没有这道判断就会反复打 IPC、反复闪 loading。
   */
  loadIfNeeded: () => Promise<void>
  reset: () => void

  createNote: (title?: string, folderId?: string | null) => Promise<StickyNote | null>
  renameNote: (noteId: string, title: string) => Promise<StickyNote | null>
  saveBody: (noteId: string, body: string) => Promise<StickyNote | null>
  appendIdeas: (noteId: string, requests: StickyIdeaAppendRequest[]) => Promise<StickyNote | null>
  deleteNote: (noteId: string) => Promise<boolean>
  /** 把便利贴挪进文件夹（folderId = null 即挪回根下）。 */
  moveNote: (noteId: string, folderId: string | null) => Promise<StickyNote | null>

  createFolder: (name?: string) => Promise<StickyFolder | null>
  renameFolder: (folderId: string, name: string) => Promise<StickyFolder | null>
  deleteFolder: (folderId: string) => Promise<boolean>

  recordDraw: (request: StickyDrawRecordRequest) => Promise<StickyDraw | null>
  recordCandidates: (drawId: string, contents: string[]) => Promise<StickyCandidate[]>
  useCandidate: (candidateId: string, noteId: string) => Promise<StickyNote | null>
  clearCandidates: () => Promise<number | null>
}

/** 把更新后的便利贴写回列表；列表里没有它（本子被换掉了）就原样不动。 */
function replaceNote(notes: StickyNote[], next: StickyNote): StickyNote[] {
  const index = notes.findIndex(note => note.noteId === next.noteId)
  if (index < 0) return notes
  const copy = [...notes]
  copy[index] = next
  return copy
}

function replaceFolder(folders: StickyFolder[], next: StickyFolder): StickyFolder[] {
  const index = folders.findIndex(folder => folder.folderId === next.folderId)
  if (index < 0) return folders
  const copy = [...folders]
  copy[index] = next
  return copy
}

export const useStickyNoteStore = create<StickyNoteState>()((set, get) => ({
  notes: EMPTY_STICKY_NOTES,
  folders: EMPTY_STICKY_FOLDERS,
  candidates: EMPTY_STICKY_CANDIDATES,
  loading: false,
  dataProjectSession: null,

  load: async () => {
    const session = currentStickySession()
    if (!session) return
    const projectPath = session.projectPath
    const requestId = ++loadRequestSequence
    const bound = get().dataProjectSession
    const sameBook = sameProjectSessionContext(bound, session)

    set(state => ({
      notes: sameBook ? state.notes : EMPTY_STICKY_NOTES,
      folders: sameBook ? state.folders : EMPTY_STICKY_FOLDERS,
      candidates: sameBook ? state.candidates : EMPTY_STICKY_CANDIDATES,
      loading: true,
    }))

    try {
      const [notes, folders, tray] = await Promise.all([
        ipc.invokeWithProjectSession(session, 'db:sticky-note-list', projectPath),
        ipc.invokeWithProjectSession(session, 'db:sticky-folder-list', projectPath),
        ipc.invokeWithProjectSession(session, 'db:sticky-candidate-list', projectPath),
      ])
      if (requestId !== loadRequestSequence || !isStickySessionCurrent(session)) return
      set({ notes, folders, candidates: tray.candidates, dataProjectSession: session })
    } finally {
      if (requestId === loadRequestSequence && isStickySessionCurrent(session)) set({ loading: false })
    }
  },

  loadIfNeeded: async () => {
    const session = currentStickySession()
    if (!session) return
    // 正在加载就别叠一发；已经绑定同一本书也别重来。
    if (get().loading) return
    if (sameProjectSessionContext(get().dataProjectSession, session)) return
    await get().load()
  },

  /** 项目关闭时清空 —— 不留上一本书的本子在内存里。 */
  reset: () => {
    loadRequestSequence += 1
    set({
      notes: EMPTY_STICKY_NOTES,
      folders: EMPTY_STICKY_FOLDERS,
      candidates: EMPTY_STICKY_CANDIDATES,
      loading: false,
      dataProjectSession: null,
    })
  },

  createNote: async (title = '', folderId = null) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-create', title, folderId, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note) return null
    const note = result.note
    set(state => ({ notes: [...state.notes, note] }))
    return note
  },

  renameNote: async (noteId, title) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-rename', noteId, title, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note) return null
    const note = result.note
    set(state => ({ notes: replaceNote(state.notes, note) }))
    return note
  },

  saveBody: async (noteId, body) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-save-body', noteId, body, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note) return null
    const note = result.note
    set(state => ({ notes: replaceNote(state.notes, note) }))
    return note
  },

  appendIdeas: async (noteId, requests) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-append', noteId, requests, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note) return null
    const note = result.note
    set(state => ({ notes: replaceNote(state.notes, note) }))
    return note
  },

  deleteNote: async (noteId) => {
    const session = currentStickySession()
    if (!session) return false
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-delete', noteId, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return false
    if (!result.success) return false
    set(state => ({ notes: state.notes.filter(note => note.noteId !== noteId) }))
    return true
  },

  moveNote: async (noteId, folderId) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-note-move', noteId, folderId, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note) return null
    const note = result.note
    set(state => ({ notes: replaceNote(state.notes, note) }))
    return note
  },

  createFolder: async (name = '') => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-folder-create', name, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.folder) return null
    const folder = result.folder
    set(state => ({ folders: [...state.folders, folder] }))
    return folder
  },

  renameFolder: async (folderId, name) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-folder-rename', folderId, name, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.folder) return null
    const folder = result.folder
    set(state => ({ folders: replaceFolder(state.folders, folder) }))
    return folder
  },

  /**
   * 删文件夹：里面的便利贴**回到根下**，一条都不删。
   *
   * 主进程在同一个事务里做这两件事；这里只需把本地状态对齐 ——
   * 夹子从列表里去掉，属于它的本子改成「没有夹子」。
   */
  deleteFolder: async (folderId) => {
    const session = currentStickySession()
    if (!session) return false
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-folder-delete', folderId, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return false
    if (!result.success) return false
    set(state => ({
      folders: state.folders.filter(folder => folder.folderId !== folderId),
      notes: state.notes.map(note => (
        note.folderId === folderId ? { ...note, folderId: null } : note
      )),
    }))
    return true
  },

  recordDraw: async (request) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-draw-record', request, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.draw) return null
    return result.draw
  },

  recordCandidates: async (drawId, contents) => {
    const session = currentStickySession()
    if (!session) return []
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-candidate-record-many', drawId, contents, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return []
    if (!result.success || !result.candidates) return []
    const created = result.candidates
    set(state => ({ candidates: [...state.candidates, ...created] }))
    return created
  },

  /**
   * 找回一条待选点子：追加进便利贴，并从箱里移走。
   *
   * 两件事在主进程是同一个事务 —— 这里不做「先追加再删」的分步编排，
   * 免得中途失败留下重复或丢失。
   */
  useCandidate: async (candidateId, noteId) => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-candidate-use', candidateId, noteId, session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success || !result.note || !result.candidate) return null
    const note = result.note
    set(state => ({
      notes: replaceNote(state.notes, note),
      candidates: state.candidates.filter(candidate => candidate.candidateId !== candidateId),
    }))
    return note
  },

  /** 清空待选箱（物理删除，不可找回）。返回清掉的条数；失败返回 null。 */
  clearCandidates: async () => {
    const session = currentStickySession()
    if (!session) return null
    const result = await ipc.invokeWithProjectSession(
      session, 'db:sticky-candidate-clear', session.projectPath,
    )
    if (!isStickySessionCurrent(session)) return null
    if (!result.success) return null
    set({ candidates: EMPTY_STICKY_CANDIDATES })
    return result.cleared ?? 0
  },
}))
