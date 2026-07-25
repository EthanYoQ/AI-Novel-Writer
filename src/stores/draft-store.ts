/**
 * 草稿状态管理 — 管理各章节草稿列表、定稿操作等
 *
 * 数据来源：drafts/ch{N}/index.json（md+json 分离方案）
 * .md 文件保持纯正文，元数据全部由 index.json 管理
 */
import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import {
  type DraftMeta,
} from '../services/draft-index'
import type { DraftStatus } from '../shared/draft-status'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import { useProjectStore } from './project-store'
import { requireIpcSuccess } from '../services/ipc-result'

let loadAllDraftsRequestSequence = 0

function currentDraftProjectSession(
  expectedProjectPath?: string,
  expectedProjectSession?: ProjectSessionContext,
): ProjectSessionContext | null {
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !projectSession
    || (expectedProjectPath && !sameProjectPathKey(project.path, expectedProjectPath))
    || (expectedProjectSession && !sameProjectSessionContext(expectedProjectSession, projectSession))
  ) return null
  return projectSession
}

function isDraftProjectSessionCurrent(projectSession: ProjectSessionContext): boolean {
  return sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )
}

function staleProjectError(): { success: false; error: string } {
  return { success: false, error: '项目会话已变化，已拒绝继续操作' }
}

// ===== 类型定义 =====

/** 单章下的草稿列表（key = chapterNumber） */
export type DraftsByChapter = Record<number, DraftMeta[]>

interface DraftState {
  /** 各章草稿列表（内存缓存），key = chapterNumber */
  draftsByChapter: DraftsByChapter
  /** 是否正在加载 */
  loading: boolean
  /** Project whose data is currently bound to draftsByChapter. */
  dataProjectKey: string | null
  /** Exact lease whose data is currently bound to draftsByChapter. */
  dataProjectSession: ProjectSessionContext | null
  /** Project currently being loaded, if any. */
  loadingProjectKey: string | null
  /** Exact lease currently loading, if known. */
  loadingProjectSession: ProjectSessionContext | null

  // ===== Actions =====
  /** Unbind old project data before publishing a newly opened project. */
  beginProjectLoad: (projectPath: string) => void
  /** 重置为初始状态（项目关闭时由 ProjectService 调用） */
  reset: () => void
  /** 加载某章的所有草稿 */
  loadChapterDrafts: (
    chapterNumber: number,
    expectedProjectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>
  /** 加载全部章节草稿（扫描 drafts/ 目录下所有 ch{NNN} 子目录） */
  loadAllDrafts: (
    expectedProjectPath?: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>

  /** 手动标记草稿状态（修稿/审稿后更新用） */
  markDraftStatus: (
    draftPath: string,
    chapterNumber: number,
    status: DraftStatus,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<void>
  /** 清除指定章节的缓存（下次访问时重新加载） */
  invalidateChapter: (chapterNumber: number) => void
  /** 应用合并后的修稿，更新文件和各类状态 */
  applyMergedRevision: (
    chapterDir: string,
    chapterNumber: number | undefined,
    filePath: string,
    revPath: string,
    mergedText: string,
    expectedProjectPath: string,
    expectedProjectSession?: ProjectSessionContext,
  ) => Promise<{ success: boolean; error?: string }>
}

export const useDraftStore = create<DraftState>()((set, get) => ({
  draftsByChapter: {},
  loading: false,
  dataProjectKey: null,
  dataProjectSession: null,
  loadingProjectKey: null,
  loadingProjectSession: null,

  beginProjectLoad: (projectPath) => {
    loadAllDraftsRequestSequence++
    set({
      draftsByChapter: {},
      loading: true,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: projectPath,
      loadingProjectSession: null,
    })
  },

  reset: () => {
    loadAllDraftsRequestSequence++
    set({
      draftsByChapter: {},
      loading: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
  },

  loadChapterDrafts: async (chapterNumber, expectedProjectPath, expectedProjectSession) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
    if (!project || !projectSession) return
    const projectPath = expectedProjectPath ?? project.path
    const requestId = loadAllDraftsRequestSequence

    try {
      // 直接调用后端 DB 获取列表，返回的结构已经转换为兼容的 DraftMeta 格式
      const list = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectPath)
      if (
        requestId !== loadAllDraftsRequestSequence
        || !sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) return
      const metas: DraftMeta[] = list.map((m) => ({
        ...m,
        status: m.status as DraftStatus,
        source: m.source as DraftMeta['source'],
        fileName: `draft_v${m.version}.md`,
        filePath: `vela://draft/${m.id}`
      }))

      // 按版本号排序（新 → 旧）
      metas.sort((a, b) => b.version - a.version)

      set(s => ({
        draftsByChapter: {
          ...(sameProjectSessionContext(s.dataProjectSession, projectSession) ? s.draftsByChapter : {}),
          [chapterNumber]: metas,
        },
        dataProjectKey: projectPath,
        dataProjectSession: projectSession,
      }))
    } catch {
      // 出错或不存在时跳过
    }
  },

  loadAllDrafts: async (expectedProjectPath, expectedProjectSession) => {
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
    if (!project || !projectSession) return
    const projectPath = expectedProjectPath ?? project.path
    const requestId = ++loadAllDraftsRequestSequence

    set(s => ({
      draftsByChapter: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? s.draftsByChapter
        : {},
      loading: true,
      dataProjectKey: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? projectPath
        : null,
      dataProjectSession: sameProjectSessionContext(s.dataProjectSession, projectSession)
        ? projectSession
        : null,
      loadingProjectKey: projectPath,
      loadingProjectSession: projectSession,
    }))
    try {
      const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectPath)
      const newDraftsByChapter: DraftsByChapter = {}

      for (const bp of blueprints) {
        const chNum = bp.chapterNumber
        const list = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chNum, projectPath)
        if (!list || list.length === 0) continue

        const metas: DraftMeta[] = list.map((m) => ({
          ...m,
          status: m.status as DraftStatus,
          source: m.source as DraftMeta['source'],
          fileName: `draft_v${m.version}.md`,
          filePath: `vela://draft/${m.id}`
        }))

        metas.sort((a, b) => b.version - a.version)
        newDraftsByChapter[chNum] = metas
      }

      if (
        requestId === loadAllDraftsRequestSequence
        && sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) {
        set({
          draftsByChapter: newDraftsByChapter,
          dataProjectKey: projectPath,
          dataProjectSession: projectSession,
        })
      }
    } finally {
      if (
        requestId === loadAllDraftsRequestSequence
        && sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )
      ) {
        set({ loading: false, loadingProjectKey: null, loadingProjectSession: null })
      }
    }
  },


  markDraftStatus: async (draftPath, chapterNumber, status, expectedProjectSession) => {
    // 从路径提取版本号
    const versionMatch = draftPath.match(/draft_v(\d+)\.md$/)
    const project = useProjectStore.getState().currentProject
    const projectSession = currentDraftProjectSession(project?.path, expectedProjectSession)
    if (!project || !projectSession) return
    const directDraftId = /^vela:\/(?:draft|manuscript)\/(\d+)$/.exec(draftPath)?.[1]
    let draftId = directDraftId ? Number(directDraftId) : undefined
    if (draftId === undefined) {
      if (!versionMatch) return
      const drafts = await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-list',
        chapterNumber,
        project.path,
      )
      if (!isDraftProjectSessionCurrent(projectSession)) return
      draftId = drafts.find(draft => draft.version === Number(versionMatch[1]))?.id
    }
    if (!draftId) return
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-update-status',
        draftId,
        status,
        undefined,
        project.path,
      ),
      '更新草稿状态',
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return
    // 重新加载该章草稿以刷新缓存
    await get().loadChapterDrafts(chapterNumber, project.path, projectSession)
  },

  invalidateChapter: (chapterNumber) => {
    set(s => {
      const next = { ...s.draftsByChapter }
      delete next[chapterNumber]
      return { draftsByChapter: next }
    })
  },

  applyMergedRevision: async (
    chapterDir,
    chapterNumber,
    filePath,
    revPath,
    mergedText,
    expectedProjectPath,
    expectedProjectSession,
  ) => {
    try {
      const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
      if (!projectSession) {
        return { success: false, error: '项目已切换，已拒绝跨项目合并' }
      }

      const versionMatch = filePath.match(/v(\d+)/)
      const version = versionMatch ? parseInt(versionMatch[1]) : 1

      let targetDraftId: number | undefined
      // 统一通过 DB 更新草稿内容
      if (filePath.startsWith('vela://draft/') || filePath.startsWith('vela://manuscript/')) {
        const prefix = filePath.startsWith('vela://draft/') ? 'vela://draft/' : 'vela://manuscript/'
        targetDraftId = parseInt(filePath.replace(prefix, ''))
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-update-content',
            targetDraftId,
            mergedText,
            mergedText.length,
            expectedProjectPath,
          ),
          '保存合并后的草稿',
        )
        if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
      } else {
        // 从 filePath 解析 chapterNumber 和 version，查出 draftId 再更新
        const chMatch = filePath.match(/ch(\d+)/)
        const chNum = chMatch ? parseInt(chMatch[1]) : chapterNumber
        if (chNum !== undefined) {
          const drafts = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chNum, expectedProjectPath)
          if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
          const target = drafts.find((draft) => draft.version === version)
          if (target) {
            targetDraftId = target.id
            requireIpcSuccess(
              await ipc.invokeWithProjectSession(
                projectSession,
                'db:draft-update-content',
                targetDraftId,
                mergedText,
                mergedText.length,
                expectedProjectPath,
              ),
              '保存合并后的草稿',
            )
            if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
          }
        }
      }

      // 更新草稿状态为 revised（直接调用 DB，不走 legacy index）
      if (targetDraftId && version) {
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-update-status',
            targetDraftId,
            'revised',
            mergedText.length,
            expectedProjectPath,
          ),
          '更新合并后的草稿状态',
        )
        if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
      }

      // 标记修稿为已合并
      const directRevisionId = /^vela:\/revision\/(\d+)$/.exec(revPath)?.[1]
      if (targetDraftId && directRevisionId) {
        requireIpcSuccess(
          await ipc.invokeWithProjectSession(
            projectSession,
            'db:revision-mark-merged',
            Number(directRevisionId),
            targetDraftId,
            expectedProjectPath,
          ),
          '标记修订稿已合并',
        )
        if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
      } else if (targetDraftId) {
        const revisionMatch = revPath.match(/v(\d+)_r(\d+)/)
        const chapterMatch = chapterDir.match(/ch(\d+)$/)
        if (revisionMatch && chapterMatch) {
          const drafts = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-list',
            Number(chapterMatch[1]),
            expectedProjectPath,
          )
          if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
          const baseDraft = drafts.find(draft => draft.version === Number(revisionMatch[1]))
          if (baseDraft) {
            const revisions = await ipc.invokeWithProjectSession(
              projectSession,
              'db:revision-list',
              baseDraft.id,
              expectedProjectPath,
            )
            if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
            const revision = revisions.find(item => item.revisionIndex === Number(revisionMatch[2]))
            if (revision) {
              requireIpcSuccess(
                await ipc.invokeWithProjectSession(
                  projectSession,
                  'db:revision-mark-merged',
                  revision.id,
                  targetDraftId,
                  expectedProjectPath,
                ),
                '标记修订稿已合并',
              )
              if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
            }
          }
        }
      }

      // 同步到编辑器（需通过 filePath 查找对应 tab 的 id）
      const { useEditorStore } = await import('./editor-store')
      if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
      const editorState = useEditorStore.getState()
      const targetTab = editorState.tabs.find(t =>
        t.projectKey === expectedProjectPath && t.filePath === filePath
      )
      if (targetTab) {
        editorState.syncTabContent(targetTab.id, mergedText)
        editorState.markTabSaved(targetTab.id)
      }

      if (chapterNumber !== undefined) {
        await get().loadChapterDrafts(chapterNumber, expectedProjectPath, projectSession)
      }
      if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()
      await useProjectStore.getState().refreshFileTree(
        expectedProjectPath,
        undefined,
        projectSession,
      )
      if (!isDraftProjectSessionCurrent(projectSession)) return staleProjectError()

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  },
}))

// ===== 辅助工具导出 =====

/**
 * 读取草稿文件正文（委托给 vela-protocol 统一路由）
 * @deprecated 建议直接使用 readVelaContent()
 */
export async function readDraftBody(
  filePath: string,
  expectedProjectPath: string,
  expectedProjectSession?: ProjectSessionContext,
): Promise<string> {
  const projectSession = currentDraftProjectSession(expectedProjectPath, expectedProjectSession)
  if (!projectSession) throw new Error('读取草稿时缺少匹配的冻结项目会话')

  if (filePath.startsWith('vela://draft/') || filePath.startsWith('vela://manuscript/')) {
    const prefix = filePath.startsWith('vela://draft/') ? 'vela://draft/' : 'vela://manuscript/'
    const full = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-full',
      parseInt(filePath.replace(prefix, '')),
      expectedProjectPath,
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return ''
    return full?.content ?? ''
  }

  if (filePath.startsWith('vela://revision/')) {
    const full = await ipc.invokeWithProjectSession(
      projectSession,
      'db:revision-get-full',
      parseInt(filePath.replace('vela://revision/', '')),
      expectedProjectPath,
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return ''
    return full?.content ?? ''
  }

  if (filePath.startsWith('vela://review/')) {
    const full = await ipc.invokeWithProjectSession(
      projectSession,
      'db:review-get-full',
      parseInt(filePath.replace('vela://review/', '')),
      expectedProjectPath,
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return ''
    return full?.content ?? ''
  }

  if (filePath.startsWith('vela://core/')) {
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      expectedProjectPath,
    )
    if (!isDraftProjectSessionCurrent(projectSession)) return ''
    const key = filePath.replace('vela://core/', '')
    const fields: Record<string, string | undefined> = {
      premise: core?.premise,
      worldbuilding: core?.worldbuilding,
      characters: core?.charactersArch,
      synopsis: core?.synopsis,
    }
    return fields[key] ?? ''
  }

  return ''
}

export type { DraftMeta, DraftStatus }
