import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { ipc } from '../ipc-client'
import { readCoreContent, writeCoreContent } from '../vela-protocol'

vi.mock('../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: vi.fn(),
  },
}))

const projectSession: ProjectSessionContext = {
  projectId: 'roster-contract-project',
  leaseId: 'roster-contract-lease',
  projectPath: 'C:/projects/roster-contract',
}

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('vela core character roster seam', () => {
  beforeEach(() => {
    vi.mocked(ipc.invokeWithProjectSession).mockReset()
  })

  it('reads the ready deterministic roster projection instead of project-core charactersArch', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({
      status: 'ready',
      renderedMarkdown: '# 角色图谱\n\n## 主角：陆舟',
      legacyMarkdown: '不应读取的旧投影',
    } as never)

    await expect(readCoreContent('vela://core/characters', projectSession))
      .resolves.toBe('# 角色图谱\n\n## 主角：陆舟')
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledExactlyOnceWith(
      projectSession,
      'db:character-roster-read',
      projectSession.projectPath,
    )
  })

  it('only exposes preserved legacy evidence while the roster is not ready', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({
      status: 'legacy_repair_required',
      renderedMarkdown: '',
      legacyMarkdown: '旧角色图谱原文，供作者复制或显式修复。',
    } as never)

    await expect(readCoreContent('vela://core/characters', projectSession))
      .resolves.toBe('旧角色图谱原文，供作者复制或显式修复。')
    expect(vi.mocked(ipc.invokeWithProjectSession).mock.calls.map(([, channel]) => channel))
      .toEqual(['db:character-roster-read'])
  })

  it('rejects direct character-projection writes without reaching project-core IPC', async () => {
    await expect(writeCoreContent('vela://core/characters', '不能直接覆盖', projectSession))
      .resolves.toBe(false)
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })
})

describe('structured character roster static contract', () => {
  it('keeps retired mutation IPC, generic projection writes, and normal extraction paths closed', () => {
    const protocol = source('src/shared/ipc-channels.ts')
    const controller = source('electron/controllers/db-controller.ts')
    const projectCore = source('electron/repositories/project-core-repository.ts')
    const projectClear = source('electron/repositories/project-clear-repository.ts')
    const roster = source('electron/repositories/character-roster-repository.ts')
    const workflow = source('src/services/workflows/architecture-workflow.ts')
    const projectTree = source('src/components/panels/sidebar/ProjectTree.tsx')
    const worldBuilding = source('src/components/editor/WorldBuildingEditor.tsx')
    const archFileViewer = source('src/components/editor/ArchFileViewer.tsx')

    for (const channel of [
      'db:character-upsert',
      'db:character-save-all',
      'db:character-delete',
      'db:character-update-state',
    ]) {
      expect(protocol).not.toContain(channel)
      expect(controller).not.toContain(channel)
    }
    expect(protocol).toContain("'db:character-roster-commit'")
    expect(controller).toContain("ipcMain.handle('db:character-roster-commit'")
    expect(projectCore).toContain("Object.hasOwn(data, 'charactersArch')")
    expect(projectCore).not.toContain("charactersArch: 'characters_arch'")
    expect(projectClear).toContain("characters_arch = ''")
    expect(projectClear).toContain("DELETE FROM characters")
    expect(projectClear).toContain("DELETE FROM character_roster_meta")
    expect(projectClear).toContain("DELETE FROM character_roster_operations")
    expect(roster.match(/SET characters_arch\s*=/g)).toHaveLength(1)
    expect(workflow).not.toContain('runArchCharacterExtract')
    expect(workflow).not.toContain('createCharacterExtractSteps')
    expect(workflow).not.toContain('runPostProcessPipeline')
    expect(projectTree).toContain("const isCharacterProjection = f.key === 'characters'")
    expect(projectTree).toContain('...(isCharacterProjection ? [] : [')
    expect(worldBuilding).toContain('useCharacterRosterRepair')
    expect(archFileViewer).toContain('useCharacterRosterRepair')
    expect(worldBuilding).toContain("characters: rosterSnapshot?.status === 'ready'")
  })
})
