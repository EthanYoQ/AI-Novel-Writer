import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { normalizeSourceEol } from '../../../test/source-contract'

function source(file: string) {
  return normalizeSourceEol(readFileSync(resolve(process.cwd(), file), 'utf8'))
}

describe('generated content deletion affordances', () => {
  it('exposes visible all-generated-content clearing from the project tree', () => {
    const projectTree = source('src/components/panels/sidebar/ProjectTree.tsx')

    expect(projectTree).toContain('清除全部')
    expect(projectTree).toContain('清除项目生成内容')
    expect(projectTree).toContain("text('工作流运行中，暂不能清除', 'A workflow is running. Project data cannot be cleared yet.')")
    expect(projectTree).toContain("text('清除项目生成内容', 'Clear generated project data')")
  })

  it('localizes architecture document fallback and refresh affordance', () => {
    const archFileViewer = source('src/components/editor/ArchFileViewer.tsx')

    expect(archFileViewer).toContain("text('架构文档', 'Architecture document')")
    expect(archFileViewer).toContain("text('从磁盘重新加载（AI 生成完成后可点击刷新）', 'Reload from disk (refresh after AI generation completes)')")
  })

  it('supports deleting one blueprint and clearing all blueprints through persisted IPC', () => {
    const chapterCards = source('src/components/editor/ChapterCardEditor.tsx')
    const dbController = source('electron/controllers/db-controller.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')

    expect(chapterCards).toContain('删除此章')
    expect(chapterCards).toContain('清空全部蓝图')
    expect(chapterCards).toContain('db:blueprint-delete')
    expect(dbController).toContain("'db:blueprint-delete'")
    expect(ipcChannels).toContain("'db:blueprint-delete'")
  })

  it('supports deleting generated drafts and finalized manuscript chapters through persisted IPC', () => {
    const draftBox = source('src/components/panels/sidebar/DraftBoxGroup.tsx')
    const manuscript = source('src/components/panels/sidebar/ManuscriptGroup.tsx')
    const finalizedDeletion = source('src/components/panels/sidebar/finalized-chapter-deletion.ts')
    const dbController = source('electron/controllers/db-controller.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')

    expect(draftBox).toContain('删除这一稿')
    expect(draftBox).toContain('db:draft-delete')
    expect(draftBox).toContain('deleteFinalizedChapter')
    expect(manuscript).toContain('删除正文')
    expect(manuscript).toContain('deleteFinalizedChapter')
    expect(manuscript).toContain('chapter:list-incomplete-deletions')
    expect(manuscript).toContain('chapter:retry-deletion')
    expect(manuscript).toContain('重试清理')
    expect(finalizedDeletion).toContain('chapter:delete-finalized')
    expect(finalizedDeletion).toContain('REFRESH_RESOURCE')
    expect(dbController).toContain("'db:draft-delete'")
    expect(ipcChannels).toContain("'chapter:delete-finalized'")
  })

  it('offers explicit legacy recovery and refreshes deletion receipts from both finalized surfaces', () => {
    const draftBox = source('src/components/panels/sidebar/DraftBoxGroup.tsx')
    const manuscript = source('src/components/panels/sidebar/ManuscriptGroup.tsx')
    const finalizedDeletion = source('src/components/panels/sidebar/finalized-chapter-deletion.ts')
    const eventBus = source('src/shared/event-bus.ts')

    expect(finalizedDeletion).toContain('chapter:confirm-legacy-knowledge-absent')
    expect(finalizedDeletion).toContain('我已人工核对/清理')
    expect(finalizedDeletion).toContain('I have manually checked or cleaned')
    expect(finalizedDeletion).toContain(String.raw`\n`)
    expect(finalizedDeletion).not.toContain(String.raw`\\n`)
    expect(finalizedDeletion).toContain("globalEventBus.emit('CHAPTER_DELETION_UPDATED'")
    expect(eventBus).toContain("| 'CHAPTER_DELETION_UPDATED'")
    expect(manuscript).toContain("globalEventBus.on('CHAPTER_DELETION_UPDATED'")
    expect(manuscript).toContain('确认人工核对并继续')
    expect(draftBox).not.toContain('reloadDrafts')
    expect(manuscript).not.toContain('reloadDrafts')
    expect(finalizedDeletion).not.toContain('reloadDrafts:')
  })

  it('supports clearing the entire knowledge base from the knowledge page', () => {
    const knowledgePage = source('src/components/pages/KnowledgeOverview.tsx')
    const knowledgeService = source('src/services/knowledge-service.ts')
    const kbController = source('electron/controllers/kb-controller.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')

    expect(knowledgePage).toContain('清空知识库')
    expect(knowledgePage).toContain('const handleClearKnowledgeBase = async () =>')
    expect(knowledgePage).toContain('captureProjectSession(currentProject)')
    expect(knowledgePage).toContain('isProjectSessionCurrent(projectSession)')
    expect(knowledgePage).toContain("'kb:clear-all'")
    expect(knowledgePage).toContain('ipc.invokeWithProjectSession(\n        projectSession,')
    expect(knowledgeService).toContain('kb:clear-all')
    expect(kbController).toContain("'kb:clear-all'")
    expect(ipcChannels).toContain("'kb:clear-all'")
  })

  it('supports deleting recent and current projects through persisted IPC', () => {
    const homeSidebar = source('src/components/panels/sidebar/HomeSidebarPanel.tsx')
    const projectStore = source('src/stores/project-store.ts')
    const projectController = source('electron/controllers/project-controller.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')

    expect(homeSidebar).toContain('删除项目')
    expect(projectStore).toContain('deleteProject')
    expect(projectController).toContain("'project:delete'")
    expect(ipcChannels).toContain("'project:delete'")
  })
})
