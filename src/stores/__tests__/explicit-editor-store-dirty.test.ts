import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../character-store'
import { useEditorStore } from '../editor-store'
import { useProjectStore } from '../project-store'
import {
  CHARACTER_DRAFT_TAB,
  CONFIG_DRAFT_TAB,
  getProjectEditorDraft,
  parseProjectEditorDraftLedger,
} from '../project-editor-draft-ledger'
import {
  getCharacterDraftRenames,
  rebuildCharacterRenamesAfterSave,
} from '../character-rename-ledger'

const { alertError, invoke } = vi.hoisted(() => ({
  alertError: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError }))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: async (_context: unknown, channel: string, ...args: unknown[]) => {
      const result = await invoke(channel, ...args)
      if (channel === 'db:character-roster-read' && Array.isArray(result)) {
        return {
          revision: 1,
          status: result.length > 0 ? 'ready' : 'empty',
          entries: result.map(card => {
            const relationshipText = typeof card.relationships === 'string' ? card.relationships.trim() : ''
            try {
              const relationships = relationshipText ? JSON.parse(relationshipText) : []
              return { ...card, relationships }
            } catch {
              return { ...card, relationships: [], legacyRelationshipNotes: relationshipText }
            }
          }),
        }
      }
      if (channel === 'db:character-roster-commit' && result?.success && !result.receipt) {
        const request = args[0] as { entries: unknown[]; expectedRevision: number }
        return {
          ...result,
          receipt: {
            revision: request.expectedRevision + 1,
            snapshot: { entries: request.entries },
          },
        }
      }
      return result
    },
  },
}))

function project(): ProjectData {
  return {
    id: 'project-a',
    name: '测试项目',
    path: 'C:\\novels\\project-a',
    sessionLease: 'lease-project-a',
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 100,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '原大纲',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  }
}

function projectB(): ProjectData {
  return {
    ...project(),
    id: 'project-b',
    name: '测试项目 B',
    path: 'C:\\novels\\project-b',
    sessionLease: 'lease-project-b',
  }
}

function projectSession(currentProject: ProjectData) {
  return {
    projectId: currentProject.id,
    leaseId: currentProject.sessionLease!,
    projectPath: currentProject.path,
  }
}

function character(name: string, notes = ''): CharacterCard {
  return {
    name,
    role: 'protagonist',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: '',
    arc: '',
    notes,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function draftLedgerContent(key: string): string | undefined {
  return useEditorStore.getState().draftLedgers[key]
}

function visibleEditor(type: 'character' | 'config') {
  return useEditorStore.getState().tabs.find(candidate => (
    candidate.type === type && candidate.projectKey === project().path
  ))
}

beforeEach(() => {
  alertError.mockReset()
  invoke.mockReset()
  useEditorStore.setState({
    tabs: [
      {
        id: 'config',
        name: '小说配置',
        type: 'config',
        projectKey: project().path,
      },
      {
        id: 'character-editor',
        name: '角色卡',
        type: 'character',
        projectKey: project().path,
      },
    ],
    activeTabId: 'config',
    draftLedgers: {},
  })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  useCharacterStore.setState({
    characters: [character('主角')],
    selectedName: '主角',
    saving: false,
    identityBusy: false,
    loaded: true,
    dataProjectKey: project().path,
    dataProjectSession: projectSession(project()),
    rosterRevision: 1,
    loadingProjectKey: null,
    loadingProjectSession: null,
    lastError: null,
  })
})

describe('explicit editor dirty integration', () => {
  it('unbinds project A character data before openProject publishes project B and loads B', async () => {
    const fileTree = deferred<[]>()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: true,
          project: projectB(),
          requestToken: args[1],
          activeProjectPath: projectB().path,
        }
      }
      if (channel === 'fs:list-dir') {
        expect(args[0]).toBe(projectB().path)
        return fileTree.promise
      }
      if (channel === 'db:character-roster-read') {
        expect(args).toEqual([projectB().path])
        return [character('项目 B 角色')]
      }
      if (channel === 'db:blueprint-get-all') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    const opening = useProjectStore.getState().openProject(projectB().path)
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'fs:list-dir',
        projectB().path,
        projectB().path,
      )
    })

    expect(useProjectStore.getState().currentProject?.path).toBe(projectB().path)
    expect(useCharacterStore.getState()).toMatchObject({
      characters: [],
      dataProjectKey: null,
      loadingProjectKey: projectB().path,
      loaded: false,
    })
    expect(useCharacterStore.getState().renameCharacter('主角', '不应发生')).toBe(false)
    await expect(useCharacterStore.getState().saveAll(projectB().path))
      .rejects.toThrow(/切换项目/)

    fileTree.resolve([])
    await expect(opening).resolves.toBe(true)
    expect(alertError).toHaveBeenCalledWith(
      expect.stringContaining('unexpected IPC'),
      expect.objectContaining({ title: '项目已打开，部分数据加载失败' }),
    )
    expect(useCharacterStore.getState()).toMatchObject({
      characters: [character('项目 B 角色')],
      dataProjectKey: projectB().path,
      loadingProjectKey: null,
      loaded: true,
    })
  })

  it('keeps configuration recoverable and dirty when saving fails', async () => {
    useProjectStore.getState().updateNovelConfig({ coreOutline: '未保存大纲' })
    invoke.mockResolvedValueOnce({ success: false, error: 'disk full' })

    await expect(useProjectStore.getState().saveProject()).resolves.toBe(false)

    const tab = visibleEditor('config')
    expect(tab?.dirty).toBe(true)
    const draft = getProjectEditorDraft(
      parseProjectEditorDraftLedger<ProjectData['novelConfig']>(draftLedgerContent(CONFIG_DRAFT_TAB.id)),
      project().path,
    )
    expect(draft?.draftValue.coreOutline).toBe('未保存大纲')
  })

  it('keeps configuration edits made while save is pending behind the update gate', async () => {
    useProjectStore.getState().updateNovelConfig({ coreOutline: '保存快照' })
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)

    const save = useProjectStore.getState().saveProject()
    useProjectStore.getState().updateNovelConfig({ coreOutline: '保存期间继续编辑' })
    pending.resolve({ success: true })
    await save

    const tab = visibleEditor('config')
    expect(tab?.dirty).toBe(true)
    const draft = getProjectEditorDraft(
      parseProjectEditorDraftLedger<ProjectData['novelConfig']>(draftLedgerContent(CONFIG_DRAFT_TAB.id)),
      project().path,
    )
    expect(draft?.baseValue.coreOutline).toBe('保存快照')
    expect(draft?.draftValue.coreOutline).toBe('保存期间继续编辑')
  })

  it('keeps character-card edits recoverable across an asynchronous save', async () => {
    useCharacterStore.getState().updateField('主角', 'notes', '保存快照')
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)

    const save = useCharacterStore.getState().saveAll(project().path)
    useCharacterStore.getState().updateField('主角', 'notes', '保存期间继续编辑')
    pending.resolve({ success: true })
    await save

    const tab = visibleEditor('character')
    expect(tab?.dirty).toBe(true)
    const draft = getProjectEditorDraft(
      parseProjectEditorDraftLedger<CharacterCard[]>(draftLedgerContent(CHARACTER_DRAFT_TAB.id)),
      project().path,
    )
    expect(draft?.baseValue[0]?.notes).toBe('保存快照')
    expect(draft?.draftValue[0]?.notes).toBe('保存期间继续编辑')
  })

  it('ignores project A character results that arrive after switching to project B', async () => {
    const projectAResult = deferred<CharacterCard[]>()
    const projectBResult = deferred<CharacterCard[]>()
    invoke
      .mockReturnValueOnce(projectAResult.promise)
      .mockReturnValueOnce(projectBResult.promise)

    const loadProjectA = useCharacterStore.getState().load()
    useProjectStore.setState({ currentProject: projectB() })
    const loadProjectB = useCharacterStore.getState().load()

    projectBResult.resolve([character('项目 B 角色')])
    await loadProjectB
    expect(useCharacterStore.getState().characters).toEqual([character('项目 B 角色')])

    projectAResult.resolve([character('项目 A 的迟到角色')])
    await loadProjectA
    expect(useCharacterStore.getState().characters).toEqual([character('项目 B 角色')])
    expect(useCharacterStore.getState().selectedName).toBe('项目 B 角色')
  })

  it('ignores a stale project A load failure after project B has loaded', async () => {
    let rejectProjectA!: (reason?: unknown) => void
    const projectAResult = new Promise<CharacterCard[]>((_, reject) => {
      rejectProjectA = reject
    })
    invoke
      .mockReturnValueOnce(projectAResult)
      .mockResolvedValueOnce([character('项目 B 角色')])

    const loadProjectA = useCharacterStore.getState().load()
    useProjectStore.setState({ currentProject: projectB() })
    await useCharacterStore.getState().load()

    rejectProjectA(new Error('项目 A 加载失败'))
    await loadProjectA

    expect(useCharacterStore.getState().characters).toEqual([character('项目 B 角色')])
    expect(useCharacterStore.getState().loaded).toBe(true)
  })

  it('does not let a stale project A save block loading project B or expose A in B', async () => {
    useCharacterStore.setState({
      characters: [character('项目 A 角色', '待保存')],
      selectedName: '项目 A 角色',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().updateField('项目 A 角色', 'notes', 'A 保存快照')
    const projectASave = deferred<{ success: boolean }>()
    invoke
      .mockReturnValueOnce(projectASave.promise)
      .mockResolvedValueOnce([character('项目 B 角色', 'B 数据')])

    const saveA = useCharacterStore.getState().saveAll(project().path)
    useProjectStore.setState({ currentProject: projectB() })
    useCharacterStore.getState().reset()
    expect(useCharacterStore.getState().saving).toBe(false)
    expect(useCharacterStore.getState().renameCharacter('项目 A 角色', '不应发生')).toBe(false)

    const loadB = useCharacterStore.getState().load(projectB().path)
    expect(invoke).toHaveBeenCalledTimes(2)

    projectASave.resolve({ success: true })
    await Promise.all([saveA, loadB])

    expect(invoke).toHaveBeenNthCalledWith(2, 'db:character-roster-read', projectB().path)
    expect(useCharacterStore.getState().characters).toEqual([
      character('项目 B 角色', 'B 数据'),
    ])
    expect(useCharacterStore.getState().selectedName).toBe('项目 B 角色')
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    // A 的完成回调已失去 lease，不能替 B 清理或改写 A 的待保存草稿。
    expect(getProjectEditorDraft(ledger, project().path)?.draftValue[0]?.notes)
      .toBe('A 保存快照')
  })

  it('does not let a delayed project A delete overwrite the loaded project B characters', async () => {
    useCharacterStore.setState({
      characters: [character('项目 A 待删除角色')],
      selectedName: '项目 A 待删除角色',
      saving: false,
      loaded: true,
    })
    const projectADelete = deferred<{ success: boolean }>()
    invoke
      .mockReturnValueOnce(projectADelete.promise)
      .mockResolvedValueOnce([character('项目 B 角色')])

    const deleteA = useCharacterStore.getState().deleteCharacter(
      '项目 A 待删除角色',
      project().path,
    )
    useProjectStore.setState({ currentProject: projectB() })
    useCharacterStore.getState().reset()
    useCharacterStore.setState({
      characters: [character('项目 B 角色')],
      selectedName: '项目 B 角色',
      loaded: true,
      dataProjectKey: projectB().path,
      dataProjectSession: projectSession(projectB()),
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
    useCharacterStore.getState().updateField('项目 B 角色', 'notes', 'B 删除等待期间编辑')
    const loadB = useCharacterStore.getState().load(projectB().path)
    expect(invoke).toHaveBeenCalledTimes(2)

    projectADelete.resolve({ success: true })
    await Promise.all([expect(deleteA).resolves.toBe(false), loadB])
    expect(useCharacterStore.getState().characters).toEqual([
      character('项目 B 角色', 'B 删除等待期间编辑'),
    ])
    expect(useCharacterStore.getState().selectedName).toBe('项目 B 角色')
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getProjectEditorDraft(ledger, projectB().path)?.draftValue).toEqual([
      character('项目 B 角色', 'B 删除等待期间编辑'),
    ])
  })

  it('preserves edits to another character while a same-project delete is pending', async () => {
    useCharacterStore.setState({
      characters: [
        character('待删除角色'),
        character('保留角色', '旧备注'),
      ],
      selectedName: '待删除角色',
      saving: false,
      loaded: true,
    })
    const pendingDelete = deferred<{ success: boolean }>()
    invoke
      .mockReturnValueOnce(pendingDelete.promise)
      .mockResolvedValueOnce([character('保留角色', '旧备注')])

    const deletion = useCharacterStore.getState().deleteCharacter(
      '待删除角色',
      project().path,
    )
    expect(useCharacterStore.getState().identityBusy).toBe(true)
    useCharacterStore.getState().addCharacter()
    expect(useCharacterStore.getState().renameCharacter('待删除角色', '新名字')).toBe(false)
    await expect(
      useCharacterStore.getState().deleteCharacter('待删除角色', project().path),
    ).resolves.toBe(false)
    await expect(
      useCharacterStore.getState().saveAll(project().path),
    ).rejects.toThrow(/身份操作正在进行/)
    const refresh = useCharacterStore.getState().load(project().path)
    useCharacterStore.getState().updateField('保留角色', 'notes', '删除等待期间编辑')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useCharacterStore.getState().characters).toHaveLength(1)

    pendingDelete.resolve({ success: true })
    await Promise.all([expect(deletion).resolves.toBe(true), refresh])

    expect(useCharacterStore.getState().characters).toEqual([
      character('保留角色', '删除等待期间编辑'),
    ])
    expect(useCharacterStore.getState().identityBusy).toBe(false)
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getProjectEditorDraft(ledger, project().path)?.baseValue).toEqual([
      character('保留角色', '旧备注'),
    ])
    expect(getProjectEditorDraft(ledger, project().path)?.draftValue).toEqual([
      character('保留角色', '删除等待期间编辑'),
    ])
  })

  it('rebases local character edits over fresh remote records during reload', async () => {
    useCharacterStore.setState({
      characters: [character('A', '旧 A'), character('B', '旧 B')],
      selectedName: 'A',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().updateField('A', 'notes', '本地 A')
    invoke.mockResolvedValueOnce([
      character('A', '旧 A'),
      character('B', '远端 B'),
      character('远端新增', '远端'),
    ])

    await useCharacterStore.getState().load(project().path)

    expect(useCharacterStore.getState().characters.map(card => [card.name, card.notes])).toEqual([
      ['A', '本地 A'],
      ['B', '远端 B'],
      ['远端新增', '远端'],
    ])
    const draft = getProjectEditorDraft(
      parseProjectEditorDraftLedger<CharacterCard[]>(draftLedgerContent(CHARACTER_DRAFT_TAB.id)),
      project().path,
    )
    expect(draft?.baseValue.map(card => [card.name, card.notes])).toEqual([
      ['A', '旧 A'],
      ['B', '远端 B'],
      ['远端新增', '远端'],
    ])
    expect(draft?.draftValue[0]?.notes).toBe('本地 A')
  })

  it('aligns a pending rename before merging clean remote character fields', async () => {
    useCharacterStore.setState({
      characters: [character('旧名', '旧备注')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    useCharacterStore.getState().updateField('新名', 'personality', '本地修改的性格')
    invoke.mockResolvedValueOnce([{
      ...character('旧名', '远端更新的备注'),
      personality: '',
      background: '远端更新的背景',
    }])

    await useCharacterStore.getState().load(project().path)

    expect(useCharacterStore.getState().characters).toEqual([
      expect.objectContaining({
        name: '新名',
        notes: '远端更新的备注',
        background: '远端更新的背景',
        personality: '本地修改的性格',
      }),
    ])
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getCharacterDraftRenames(ledger, project().path)).toEqual([
      { originalName: '旧名', newName: '新名' },
    ])
    expect(getProjectEditorDraft(ledger, project().path)?.baseValue[0]).toMatchObject({
      name: '旧名',
      notes: '远端更新的备注',
      background: '远端更新的背景',
    })
    expect(getProjectEditorDraft(ledger, project().path)?.draftValue[0]).toMatchObject({
      name: '新名',
      notes: '远端更新的备注',
      background: '远端更新的背景',
      personality: '本地修改的性格',
    })
  })

  it('restores the original-to-new character identity after a store reset and reload', async () => {
    useCharacterStore.setState({
      characters: [character('旧名')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    expect(useCharacterStore.getState().renameCharacter('旧名', '新名')).toBe(true)

    const beforeResetLedger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getCharacterDraftRenames(beforeResetLedger, project().path)).toEqual([
      { originalName: '旧名', newName: '新名' },
    ])

    useCharacterStore.getState().reset()
    invoke.mockResolvedValueOnce([character('旧名')])
    await useCharacterStore.getState().load(project().path)

    expect(useCharacterStore.getState().characters.map(card => card.name)).toEqual(['新名'])
    const restoredLedger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getCharacterDraftRenames(restoredLedger, project().path)).toEqual([
      { originalName: '旧名', newName: '新名' },
    ])
    expect(visibleEditor('character')?.dirty).toBe(true)
  })

  it('keeps rename identity and dirty state when the transaction fails', async () => {
    useCharacterStore.setState({
      characters: [character('旧名')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().renameCharacter('旧名', '冲突名')
    invoke.mockResolvedValueOnce({ success: false, error: '角色名已存在' })

    await expect(useCharacterStore.getState().saveAll(project().path)).rejects.toThrow(/已存在/)

    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(visibleEditor('character')?.dirty).toBe(true)
    expect(getCharacterDraftRenames(ledger, project().path)).toEqual([
      { originalName: '旧名', newName: '冲突名' },
    ])
    expect(useCharacterStore.getState().characters[0]?.name).toBe('冲突名')
  })

  it('settles a successful rename but keeps field edits made while saving', async () => {
    useCharacterStore.setState({
      characters: [character('旧名', '保存前')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)

    const save = useCharacterStore.getState().saveAll(project().path)
    useCharacterStore.getState().updateField('新名', 'notes', '保存期间继续编辑')
    pending.resolve({ success: true })
    await save

    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'manual_edit',
        entries: [expect.objectContaining({ name: '新名', notes: '保存前' })],
        renames: [{ originalName: '旧名', newName: '新名' }],
      }),
      project().path,
    )
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    const draft = getProjectEditorDraft(ledger, project().path)
    expect(draft?.baseValue[0]).toMatchObject({ name: '新名', notes: '保存前' })
    expect(draft?.draftValue[0]).toMatchObject({ name: '新名', notes: '保存期间继续编辑' })
    expect(getCharacterDraftRenames(ledger, project().path)).toEqual([])
    expect(visibleEditor('character')?.dirty).toBe(true)
  })

  it('blocks a second rename while the first rename transaction is saving', async () => {
    useCharacterStore.setState({
      characters: [character('旧名')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().renameCharacter('旧名', '中间名')
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)

    const save = useCharacterStore.getState().saveAll(project().path)
    expect(useCharacterStore.getState().renameCharacter('中间名', '最终名')).toBe(false)
    pending.resolve({ success: true })
    await save

    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      draftLedgerContent(CHARACTER_DRAFT_TAB.id),
    )
    expect(getProjectEditorDraft(ledger, project().path)).toBeUndefined()
    expect(getCharacterDraftRenames(ledger, project().path)).toEqual([])
    expect(useCharacterStore.getState().characters[0]?.name).toBe('中间名')
  })

  it('rebuilds an interrupted revert without mistaking a new duplicate-name draft for a rename', () => {
    const savedCharacters = [
      character('中间名', '第一位'),
      { ...character('配角', '第二位'), role: 'supporting' as const },
    ]
    const savedRenames = [{ originalName: '旧名', newName: ' 中间名 ' }]

    expect(rebuildCharacterRenamesAfterSave(
      savedCharacters,
      [character(' 旧名 ', '第一位'), savedCharacters[1]],
      savedRenames,
      [],
    )).toEqual([
      { originalName: '中间名', newName: '旧名' },
    ])

    expect(rebuildCharacterRenamesAfterSave(
      savedCharacters,
      [...savedCharacters, character('旧名', '新角色')],
      savedRenames,
      [],
    )).toEqual([])
  })

  it('blocks identity operations and refresh while a character transaction is pending', async () => {
    useCharacterStore.setState({
      characters: [character('旧名', '保存前')],
      selectedName: '旧名',
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    const pending = deferred<{ success: boolean }>()
    invoke
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([character('新名', '保存前')])

    const save = useCharacterStore.getState().saveAll(project().path)
    useCharacterStore.getState().addCharacter()
    expect(useCharacterStore.getState().renameCharacter('新名', '另一个名字')).toBe(false)
    await expect(
      useCharacterStore.getState().deleteCharacter('新名', project().path),
    ).resolves.toBe(false)
    const refresh = useCharacterStore.getState().load(project().path)
    useCharacterStore.getState().updateField('新名', 'notes', '保存期间字段仍可编辑')

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useCharacterStore.getState().characters).toEqual([
      expect.objectContaining({ name: '新名', notes: '保存期间字段仍可编辑' }),
    ])

    pending.resolve({ success: true })
    await Promise.all([save, refresh])
    expect(useCharacterStore.getState().characters).toEqual([
      expect.objectContaining({ name: '新名', notes: '保存期间字段仍可编辑' }),
    ])
  })

  it('reuses one in-flight character save when save is triggered twice', async () => {
    const pending = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(pending.promise)

    const firstSave = useCharacterStore.getState().saveAll(project().path)
    const secondSave = useCharacterStore.getState().saveAll(project().path)

    expect(secondSave).toBe(firstSave)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useCharacterStore.getState().saving).toBe(true)

    pending.resolve({ success: true })
    await Promise.all([firstSave, secondSave])
    expect(useCharacterStore.getState().saving).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('saves a newly added placeholder under its first chosen name without a rename transaction', async () => {
    useCharacterStore.setState({
      characters: [],
      selectedName: null,
      saving: false,
      loaded: true,
    })
    useCharacterStore.getState().addCharacter()
    const placeholderName = useCharacterStore.getState().selectedName
    expect(placeholderName).toBeTruthy()
    useCharacterStore.getState().renameCharacter(placeholderName!, '首个正式名字')
    invoke.mockResolvedValueOnce({ success: true })

    await useCharacterStore.getState().saveAll(project().path)

    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'manual_edit',
        entries: [expect.objectContaining({ name: '首个正式名字' })],
      }),
      project().path,
    )
    expect(visibleEditor('character')?.dirty).toBe(false)
  })
})
