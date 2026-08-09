import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import {
  CHAPTER_CARD_TAB_ID,
  createEmptyChapterCardDraftLedger,
  getChapterCardProjectDraft,
  parseChapterCardDraftLedger,
  updateChapterCardProjectDraft,
} from '../../components/editor/chapter-card-draft-ledger'
import type { ChapterBlueprint } from '../../services/workflows/directory-workflow'
import {
  discardAndCloseEditorTab,
  discardCurrentProjectEditorChanges,
} from '../editor-discard'
import { useCharacterStore, type CharacterCard } from '../character-store'
import { useEditorStore } from '../editor-store'
import { countUnsavedEditorItems, countUnsavedEditorItemsForProject } from '../editor-unsaved'
import { useProjectStore } from '../project-store'
import {
  CHARACTER_DRAFT_TAB,
  CONFIG_DRAFT_TAB,
  getProjectEditorDraft,
  parseProjectEditorDraftLedger,
  setProjectEditorDraft,
} from '../project-editor-draft-ledger'
import { getCharacterDraftRenames } from '../character-rename-ledger'
import { discardChangesThenRequestInstall } from '../../components/updates/update-install-discard'

const { invoke, invokeWithProjectSession } = vi.hoisted(() => ({
  invoke: vi.fn(),
  invokeWithProjectSession: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke, invokeWithProjectSession },
}))

function project(key: 'A' | 'B'): ProjectData {
  return {
    id: key,
    name: `项目 ${key}`,
    path: `C:\\novels\\${key}`,
    sessionLease: `lease-${key}`,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: `已保存 ${key}`,
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function projectSession(key: 'A' | 'B') {
  const currentProject = project(key)
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

function chapter(chapterNumber: number, title: string): ChapterBlueprint {
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
  }
}

beforeEach(() => {
  invoke.mockReset()
  invokeWithProjectSession.mockReset()
  invokeWithProjectSession.mockImplementation(async (_context: unknown, channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args)
    if (channel === 'db:character-roster-commit' && result?.success && !result.receipt) {
      const request = args[0] as { entries: unknown[]; expectedRevision: number }
      return {
        ...result,
        receipt: { revision: request.expectedRevision + 1, snapshot: { entries: request.entries } },
      }
    }
    return result
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project('A'), fileTree: [], loading: false })
  useCharacterStore.setState({
    characters: [character('旧名')],
    selectedName: '旧名',
    saving: false,
    identityBusy: false,
    loaded: true,
    dataProjectKey: project('A').path,
    dataProjectSession: projectSession('A'),
    rosterRevision: 1,
    loadingProjectKey: null,
    loadingProjectSession: null,
    lastError: null,
  })
})

describe('editor discard semantics', () => {
  it('discards only project A character rename, preserves project B draft, and reopens without a duplicate rename', async () => {
    expect(useCharacterStore.getState().renameCharacter('旧名', '新名')).toBe(true)

    useProjectStore.setState({ currentProject: project('B') })
    useCharacterStore.setState({
      characters: [character('角色 B')],
      selectedName: '角色 B',
      dataProjectKey: project('B').path,
      dataProjectSession: projectSession('B'),
      loadingProjectSession: null,
    })
    useCharacterStore.getState().updateField('角色 B', 'notes', 'B 未保存')

    useProjectStore.setState({ currentProject: project('A') })
    useCharacterStore.setState({
      characters: [character('新名')],
      selectedName: '新名',
      dataProjectKey: project('A').path,
      dataProjectSession: projectSession('A'),
      loadingProjectSession: null,
    })
    useEditorStore.setState({
      tabs: [
        {
          id: 'character-a',
          name: '角色卡 A',
          type: 'character',
          projectKey: project('A').path,
          dirty: true,
        },
        {
          id: 'character-b',
          name: '角色卡 B',
          type: 'character',
          projectKey: project('B').path,
          dirty: true,
        },
      ],
      activeTabId: 'character-a',
    })

    discardAndCloseEditorTab('character-a', projectSession('A'))

    expect(useCharacterStore.getState().characters.map(card => card.name)).toEqual(['旧名'])
    expect(useCharacterStore.getState().selectedName).toBe('旧名')
    expect(useEditorStore.getState().tabs.map(tab => tab.id)).toEqual(['character-b'])
    const ledger = parseProjectEditorDraftLedger<CharacterCard[]>(
      useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
    )
    expect(getProjectEditorDraft(ledger, project('A').path)).toBeUndefined()
    expect(getCharacterDraftRenames(ledger, project('A').path)).toEqual([])
    expect(getProjectEditorDraft(ledger, project('B').path)?.draftValue[0]?.notes).toBe('B 未保存')

    invoke.mockResolvedValueOnce({ success: true })
    await useCharacterStore.getState().saveAll(project('A').path)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'manual_edit',
        entries: [expect.objectContaining({ name: '旧名' })],
      }),
      project('A').path,
    )
  })

  it('discards config and chapter-card drafts per project while retaining other projects', () => {
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'A 未保存' })
    useProjectStore.setState({ currentProject: project('B') })
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'B 未保存' })
    useProjectStore.setState({
      currentProject: {
        ...project('A'),
        novelConfig: {
          ...project('A').novelConfig,
          coreOutline: 'A 未保存',
        },
      },
    })

    let chapterLedger = updateChapterCardProjectDraft(
      createEmptyChapterCardDraftLedger(),
      project('A').path,
      [chapter(1, 'A 未保存')],
      new Set([1]),
    )
    chapterLedger = updateChapterCardProjectDraft(
      chapterLedger,
      project('B').path,
      [chapter(1, 'B 未保存')],
      new Set([1]),
    )
    useEditorStore.setState((state) => ({
      draftLedgers: {
        ...state.draftLedgers,
        [CHAPTER_CARD_TAB_ID]: JSON.stringify(chapterLedger),
      },
      tabs: [
        {
          id: 'config-a',
          name: '配置 A',
          type: 'config',
          projectKey: project('A').path,
          dirty: true,
        },
        {
          id: 'chapter-a',
          name: '蓝图 A',
          type: 'chapter-card',
          projectKey: project('A').path,
          dirty: true,
        },
        {
          id: 'chapter-b',
          name: '蓝图 B',
          type: 'chapter-card',
          projectKey: project('B').path,
          dirty: true,
        },
      ],
      activeTabId: 'config-a',
    }))

    discardAndCloseEditorTab('config-a', projectSession('A'))
    expect(useProjectStore.getState().currentProject?.novelConfig.coreOutline).toBe('已保存 A')
    const configLedger = parseProjectEditorDraftLedger<ProjectData['novelConfig']>(
      useEditorStore.getState().draftLedgers[CONFIG_DRAFT_TAB.id],
    )
    expect(getProjectEditorDraft(configLedger, project('A').path)).toBeUndefined()
    expect(getProjectEditorDraft(configLedger, project('B').path)?.draftValue.coreOutline).toBe('B 未保存')

    discardAndCloseEditorTab('chapter-a', projectSession('A'))
    const remainingChapterLedger = parseChapterCardDraftLedger(
      useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID],
    )
    expect(getChapterCardProjectDraft(remainingChapterLedger, project('A').path)).toBeUndefined()
    expect(getChapterCardProjectDraft(remainingChapterLedger, project('B').path)?.blueprints[0]?.title)
      .toBe('B 未保存')
    expect(useEditorStore.getState().tabs.map(tab => tab.id)).toEqual(['chapter-b'])
  })

  it('does not mutate drafts when the close confirmation is cancelled', () => {
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    useEditorStore.setState({
      tabs: [{
        id: 'character-a',
        name: '角色卡 A',
        type: 'character',
        projectKey: project('A').path,
        dirty: true,
      }],
      activeTabId: 'character-a',
    })
    const before = useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id]

    // 取消按钮只关闭确认对话框，不调用 discardAndCloseEditorTab。
    expect(useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id]).toBe(before)
    expect(useCharacterStore.getState().characters[0]?.name).toBe('新名')
    expect(useEditorStore.getState().tabs[0]?.id).toBe('character-a')
  })

  it('restores the dirty indicator when reopening and keeps hidden drafts in the update gate', () => {
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(countUnsavedEditorItems(
      useEditorStore.getState().tabs,
      useEditorStore.getState().draftLedgers,
    )).toBe(1)

    useEditorStore.getState().openFile({
      id: 'character-a',
      name: '角色卡 A',
      type: 'character',
      projectKey: project('A').path,
    })
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true)
    expect(countUnsavedEditorItems(
      useEditorStore.getState().tabs,
      useEditorStore.getState().draftLedgers,
    )).toBe(1)
  })

  it('discards current-project tabs and ledgers before requesting install, and stays discarded on failure', async () => {
    useCharacterStore.getState().renameCharacter('旧名', '新名')
    useProjectStore.getState().updateNovelConfig({ coreOutline: 'A 未保存' })
    let chapterLedger = updateChapterCardProjectDraft(
      createEmptyChapterCardDraftLedger(),
      project('A').path,
      [chapter(1, 'A 未保存')],
      new Set([1]),
    )
    chapterLedger = updateChapterCardProjectDraft(
      chapterLedger,
      project('B').path,
      [chapter(1, 'B 未保存')],
      new Set([1]),
    )
    const characterLedger = setProjectEditorDraft(
      parseProjectEditorDraftLedger<CharacterCard[]>(
        useEditorStore.getState().draftLedgers[CHARACTER_DRAFT_TAB.id],
      ),
      project('B').path,
      [character('角色 B')],
      [character('角色 B', 'B 未保存')],
    )
    const configLedger = setProjectEditorDraft(
      parseProjectEditorDraftLedger<ProjectData['novelConfig']>(
        useEditorStore.getState().draftLedgers[CONFIG_DRAFT_TAB.id],
      ),
      project('B').path,
      project('B').novelConfig,
      { ...project('B').novelConfig, coreOutline: 'B 未保存' },
    )
    useEditorStore.setState((state) => ({
      draftLedgers: {
        ...state.draftLedgers,
        [CHARACTER_DRAFT_TAB.id]: JSON.stringify(characterLedger),
        [CONFIG_DRAFT_TAB.id]: JSON.stringify(configLedger),
        [CHAPTER_CARD_TAB_ID]: JSON.stringify(chapterLedger),
      },
      tabs: [
        {
          id: 'arch-a',
          name: '故事前提 A',
          type: 'arch-file',
          projectKey: project('A').path,
          content: 'A 未保存',
          savedContent: 'A 已保存',
          dirty: true,
        },
        {
          id: 'pinned-a',
          name: '固定架构 A',
          type: 'arch-file',
          projectKey: project('A').path,
          content: 'A 未保存固定',
          savedContent: 'A 已保存固定',
          dirty: true,
          pinned: true,
        },
        {
          id: 'arch-b',
          name: '故事前提 B',
          type: 'arch-file',
          projectKey: project('B').path,
          content: 'B 未保存',
          savedContent: 'B 已保存',
          dirty: true,
        },
      ],
      activeTabId: 'arch-a',
    }))
    const requestInstall = vi.fn(async () => {
      expect(useCharacterStore.getState().characters[0]?.name).toBe('旧名')
      expect(useProjectStore.getState().currentProject?.novelConfig.coreOutline).toBe('已保存 A')
      expect(getChapterCardProjectDraft(
        parseChapterCardDraftLedger(useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID]),
        project('A').path,
      )).toBeUndefined()
      expect(countUnsavedEditorItems(
        useEditorStore.getState().tabs,
        useEditorStore.getState().draftLedgers,
      )).toBe(0)
      expect(useEditorStore.getState().tabs.find(tab => tab.id === 'arch-a')).toBeUndefined()
      expect(useEditorStore.getState().tabs.find(tab => tab.id === 'pinned-a')).toMatchObject({
        content: 'A 已保存固定',
        dirty: false,
      })
      throw new Error('安装请求失败')
    })

    await expect(discardChangesThenRequestInstall(requestInstall))
      .rejects.toThrow('安装请求失败')

    expect(requestInstall).toHaveBeenCalledOnce()
    expect(useEditorStore.getState().tabs.find(tab => tab.id === 'arch-a')).toBeUndefined()
    expect(useEditorStore.getState().tabs.find(tab => tab.id === 'arch-b')).toBeUndefined()
    expect(countUnsavedEditorItems(
      useEditorStore.getState().tabs,
      useEditorStore.getState().draftLedgers,
    )).toBe(0)
  })

  it('discards every counted item without a current project, including corrupt hidden ledgers', async () => {
    useProjectStore.setState({ currentProject: null })
    useEditorStore.setState({
      tabs: [
        { id: 'legacy-dirty', name: '未归属草稿', type: 'chapter', dirty: true },
      ],
      activeTabId: 'legacy-dirty',
      draftLedgers: {
        [CHARACTER_DRAFT_TAB.id]: 'corrupt character ledger',
        [CONFIG_DRAFT_TAB.id]: 'corrupt config ledger',
        [CHAPTER_CARD_TAB_ID]: JSON.stringify(updateChapterCardProjectDraft(
          createEmptyChapterCardDraftLedger(),
          project('B').path,
          [chapter(2, 'B 隐藏草稿')],
          new Set([2]),
        )),
      },
    })
    expect(countUnsavedEditorItems(
      useEditorStore.getState().tabs,
      useEditorStore.getState().draftLedgers,
    )).toBe(4)
    const requestInstall = vi.fn(async () => {
      expect(countUnsavedEditorItems(
        useEditorStore.getState().tabs,
        useEditorStore.getState().draftLedgers,
      )).toBe(0)
      throw new Error('仍未退出')
    })

    await expect(discardChangesThenRequestInstall(requestInstall)).rejects.toThrow('仍未退出')
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useEditorStore.getState().activeTabId).toBeNull()
    expect(countUnsavedEditorItems(
      useEditorStore.getState().tabs,
      useEditorStore.getState().draftLedgers,
    )).toBe(0)
  })

  it('can discard all current-project changes directly without touching another project', () => {
    useEditorStore.setState({
      tabs: [
        { id: 'a', name: 'A', type: 'arch-file', projectKey: project('A').path, dirty: true },
        { id: 'b', name: 'B', type: 'arch-file', projectKey: project('B').path, dirty: true },
      ],
      activeTabId: 'a',
    })

    discardCurrentProjectEditorChanges(project('A').path, projectSession('A'))

    expect(useEditorStore.getState().tabs.map(tab => tab.id)).toEqual(['b'])
    expect(useEditorStore.getState().activeTabId).toBe('b')
  })
})

describe('project-scoped unsaved counting', () => {
  it('counts only tabs and ledgers that closing the selected project will remove', () => {
    const projectA = 'C:\\novels\\A'
    const projectB = 'C:\\novels\\B'
    const tabs = [
      { id: 'a', name: 'A', type: 'config' as const, projectKey: projectA, dirty: true },
      { id: 'b', name: 'B', type: 'character' as const, projectKey: projectB, dirty: true },
    ]
    const draftLedgers = {
      config: JSON.stringify({
        version: 1,
        projects: [{ projectKey: projectA, baseValue: {}, draftValue: { genre: 'A' } }],
      }),
      'character-editor-drafts': JSON.stringify({
        version: 1,
        projects: [{ projectKey: projectB, baseValue: [], draftValue: [{ name: 'B' }] }],
      }),
    }

    expect(countUnsavedEditorItemsForProject(tabs, draftLedgers, projectA)).toBe(1)
    expect(countUnsavedEditorItemsForProject(tabs, draftLedgers, projectB)).toBe(1)
    expect(countUnsavedEditorItems(tabs, draftLedgers)).toBe(2)
  })
})
