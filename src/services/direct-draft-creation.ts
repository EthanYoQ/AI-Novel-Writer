/**
 * direct-draft-creation — 直接新增章节（粘贴导入为可编辑草稿）
 *
 * 作者在别处写好一章后，不经 AI 生成流程，直接把正文粘贴入库：
 * 1. 缺失时补一条最小章节蓝图（不覆盖已有蓝图）
 * 2. db:draft-create 存为该章草稿（版本号由服务端事务分配）
 * 3. 刷新文件树/草稿索引并在编辑器中打开
 */

import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import { countDraftUnits } from '../shared/draft-units'
import type { DraftStatus } from '../shared/draft-status'
import { formatResourceUri } from '../shared/project-paths'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { isProjectSessionCurrent } from '../components/project-session-gate'
import { useProjectStore } from '../stores/project-store'
import { useDraftStore } from '../stores/draft-store'
import { useEditorStore } from '../stores/editor-store'

export interface PastedDraftResult {
  id: number
  version: number
}

/** 缺失蓝图时补建的最小蓝图（与章节卡片「新建空章节」默认值一致） */
function minimalBlueprint(chapterNumber: number, title: string) {
  return {
    chapterNumber,
    title,
    role: '发展',
    purpose: '',
    keyEvents: '',
    characters: [],
    suspenseHook: '',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
    chapterOutline: '',
  }
}

/** 通道返回的 status 是宽类型 string，收窄为编辑器使用的 DraftStatus */
function normalizeDraftStatus(status: string | undefined): DraftStatus {
  const allowed: DraftStatus[] = ['draft', 'revised', 'reviewed', 'finalized', 'archived']
  return allowed.includes(status as DraftStatus) ? status as DraftStatus : 'draft'
}

/**
 * 把粘贴的章节正文存为草稿。
 * 会话失效（项目切换/租约变化）时返回 null，调用方应静默放弃。
 */
export async function createPastedDraft(input: {
  projectSession: ProjectSessionContext
  chapterNumber: number
  title: string
  content: string
}): Promise<PastedDraftResult | null> {
  const { projectSession, chapterNumber, content } = input
  const projectPath = projectSession.projectPath
  const trimmedTitle = input.title.trim()

  const existingBlueprint = await ipc.invokeWithProjectSession(
    projectSession,
    'db:blueprint-get',
    chapterNumber,
    projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) return null
  if (!existingBlueprint) {
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-upsert',
        minimalBlueprint(chapterNumber, trimmedTitle),
        projectPath,
      ),
      '保存章节蓝图',
    )
    if (!isProjectSessionCurrent(projectSession)) return null
  }

  // 版本号由 DraftRepository.create 在事务内分配（MAX+1），此处的 version 会被忽略
  const created = requireIpcSuccess(
    await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-create',
      {
        chapterNumber,
        version: 1,
        source: 'write',
        content,
        wordCount: countDraftUnits(content),
      },
      projectPath,
    ),
    '保存章节草稿',
  )
  if (!isProjectSessionCurrent(projectSession)) return null
  const draftId = created.id!

  const meta = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-get-meta',
    draftId,
    projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) return null

  await useProjectStore.getState().refreshFileTree(projectPath, undefined, projectSession)
  if (!isProjectSessionCurrent(projectSession)) return null
  try {
    await useDraftStore.getState().loadAllDrafts(projectPath, projectSession)
  } catch { /* 草稿索引刷新失败不阻塞打开编辑器 */ }
  if (!isProjectSessionCurrent(projectSession)) return null

  const pseudoPath = formatResourceUri({ kind: 'draft', id: draftId })
  const displayName = trimmedTitle
    ? `第${chapterNumber}章 ${trimmedTitle}`
    : `第${chapterNumber}章`
  useEditorStore.getState().openFile({
    id: pseudoPath,
    name: `${displayName} v${meta?.version ?? 1}`,
    type: 'chapter',
    filePath: pseudoPath,
    content,
    savedContent: content,
    draftId,
    chapterNumber,
    draftStatus: normalizeDraftStatus(meta?.status),
    projectKey: projectPath,
    projectSessionLease: projectSession.leaseId,
  })

  return { id: draftId, version: meta?.version ?? 1 }
}
