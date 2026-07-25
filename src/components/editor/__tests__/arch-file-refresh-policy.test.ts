import { describe, expect, it } from 'vitest'

import {
  createProjectArchTabId,
  ARCH_REFRESH_BLOCKED_MESSAGE,
  ArchReloadGate,
  archEditStoreAction,
  decideArchExternalRefresh,
  didArchSaveSettle,
  hasUnsavedArchEdit,
  isArchProjectCurrent,
  reassertBlockedArchEdit,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
  writeArchEditState,
} from '../arch-file-refresh-policy'

describe('architecture file external refresh protection', () => {
  it('isolates the same architecture resource by project and preserves the original draft', () => {
    const filePath = 'vela://core/premise'
    const projectA = 'C:\\novels\\A'
    const projectB = 'C:\\novels\\B'
    const projectATab = {
      id: createProjectArchTabId(projectA, filePath),
      projectKey: projectA,
      content: 'A 项目未保存内容',
      dirty: true,
    }

    const projectBTabId = createProjectArchTabId(projectB, filePath)

    expect(projectBTabId).not.toBe(projectATab.id)
    expect(shouldSyncProjectArchTab(projectATab, projectA)).toBe(false)
    expect(shouldSyncProjectArchTab(projectATab, projectB)).toBe(false)
    expect([projectATab].find(tab => tab.id === projectBTabId)).toBeUndefined()
    expect(projectATab).toMatchObject({
      content: 'A 项目未保存内容',
      dirty: true,
    })
  })

  it('rejects save and refresh work after the active project changes', () => {
    expect(isArchProjectCurrent('C:\\novels\\A', 'C:\\novels\\A')).toBe(true)
    expect(isArchProjectCurrent('C:\\novels\\A', 'C:\\novels\\B')).toBe(false)
    expect(isArchProjectCurrent('C:\\novels\\A', undefined)).toBe(false)
  })

  it('allows the original clean tab to refresh again after switching back', () => {
    const projectA = 'C:\\novels\\A'
    expect(shouldSyncProjectArchTab({
      projectKey: projectA,
      dirty: false,
    }, projectA)).toBe(true)
  })

  it('refreshes a silent architecture completion by project and run id without a live-run lookup', () => {
    const payload = {
      type: 'architecture_generation',
      projectPath: 'C:\\novels\\A',
      projectSession: {
        projectId: 'A',
        leaseId: 'lease-A',
        projectPath: 'C:\\novels\\A',
      },
      runId: 'silent-architecture-run',
    }
    const projectSession = {
      projectId: 'A',
      leaseId: 'lease-A',
      projectPath: 'C:\\novels\\A',
    }

    expect(shouldRefreshArchOnWorkflowComplete(payload, projectSession)).toBe(true)
    expect(shouldRefreshArchOnWorkflowComplete(
      payload,
      projectSession,
      'silent-architecture-run',
    )).toBe(false)
    expect(shouldRefreshArchOnWorkflowComplete(payload, {
      ...projectSession,
      leaseId: 'lease-A-reopened',
    })).toBe(false)
  })

  it('blocks generated or externally refreshed content while local edits are unsaved', () => {
    const snapshot = {
      savedContent: '磁盘上的旧架构',
      currentContent: '用户尚未保存的本地修改',
    }

    expect(hasUnsavedArchEdit(snapshot)).toBe(true)
    expect(decideArchExternalRefresh(snapshot, 'AI 刚生成的新架构')).toEqual({
      kind: 'blocked',
    })
    expect(ARCH_REFRESH_BLOCKED_MESSAGE).toContain('保留本地内容')
  })

  it('applies external content when the editor has no unsaved changes', () => {
    const snapshot = {
      savedContent: '磁盘上的旧架构',
      currentContent: '磁盘上的旧架构',
    }

    expect(decideArchExternalRefresh(snapshot, 'AI 刚生成的新架构')).toEqual({
      kind: 'apply',
      content: 'AI 刚生成的新架构',
    })
  })

  it('blocks an asynchronous reload result when editing starts during the read', () => {
    const snapshotAtReadStart = {
      savedContent: '读取开始时的架构',
      currentContent: '读取开始时的架构',
    }
    expect(hasUnsavedArchEdit(snapshotAtReadStart)).toBe(false)

    const snapshotWhenReadFinishes = {
      ...snapshotAtReadStart,
      currentContent: '读取期间输入的本地修改',
    }
    expect(decideArchExternalRefresh(
      snapshotWhenReadFinishes,
      '读取返回的 AI 新架构',
    )).toEqual({ kind: 'blocked' })
  })

  it('does not let a delayed reload overwrite content edited and saved while the read was pending', async () => {
    const gate = new ArchReloadGate()
    let resolveReload!: (content: string) => void
    const response = new Promise<string>(resolve => { resolveReload = resolve })
    let visibleContent = 'old disk content'
    const delayedReload = (async () => {
      const token = gate.begin()
      const content = await response
      if (gate.isCurrent(token)) visibleContent = content
    })()

    visibleContent = 'edited and saved content'
    gate.recordContentChange()
    // 保存开始与保存成功都会让此前的 reload 失效。
    gate.invalidate()
    gate.invalidate()
    resolveReload('stale reload content')
    await delayedReload

    expect(visibleContent).toBe('edited and saved content')
    expect(gate.isCurrent(gate.begin())).toBe(true)
  })

  it('ignores the editor store echo of the current local content', () => {
    const snapshot = {
      savedContent: '磁盘上的旧架构',
      currentContent: '用户尚未保存的本地修改',
    }

    expect(decideArchExternalRefresh(
      snapshot,
      '用户尚未保存的本地修改',
    )).toEqual({ kind: 'noop' })
  })

  it('keeps the editor dirty when new input arrives while a save is pending', () => {
    const contentWrittenBySave = '点击保存时的架构'

    expect(didArchSaveSettle(
      contentWrittenBySave,
      '保存期间继续输入的架构',
    )).toBe(false)
    expect(didArchSaveSettle(
      contentWrittenBySave,
      contentWrittenBySave,
    )).toBe(true)
  })

  it('marks the editor tab saved after content is fully reverted to the saved baseline', () => {
    expect(archEditStoreAction({
      savedContent: '已保存的架构',
      currentContent: '已保存的架构',
    })).toBe('sync-saved')
    expect(archEditStoreAction({
      savedContent: '已保存的架构',
      currentContent: '仍有修改',
    })).toBe('update-dirty')
  })

  it('reasserts the local draft after an external refresh cleared the tab dirty flag', () => {
    const tab = { content: '外部生成内容', dirty: false }
    const writer = {
      updateTabContent: (_filePath: string, content: string) => {
        tab.content = content
        tab.dirty = true
      },
      syncTabContent: (_filePath: string, content: string) => {
        tab.content = content
      },
      markTabSaved: () => {
        tab.dirty = false
      },
    }

    writeArchEditState(writer, 'vela://core/premise.md', '外部生成内容', 'sync-saved')
    expect(tab).toEqual({ content: '外部生成内容', dirty: false })

    reassertBlockedArchEdit(
      writer,
      'vela://core/premise.md',
      '用户尚未保存的本地修改',
    )
    expect(tab).toEqual({
      content: '用户尚未保存的本地修改',
      dirty: true,
    })
  })
})
