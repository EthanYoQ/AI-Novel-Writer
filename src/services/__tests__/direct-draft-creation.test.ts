import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { countDraftUnits } from '../../shared/draft-units'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { createPastedDraft } from '../direct-draft-creation'

const PROJECT_PATH = 'C:\\novels\\direct-draft-creation'
const SESSION: ProjectSessionContext = {
  projectId: 'direct-draft-creation',
  leaseId: 'lease-1',
  projectPath: PROJECT_PATH,
}

const ORIGINAL_PROJECT_STATE = useProjectStore.getState()
const ORIGINAL_EDITOR_STATE = useEditorStore.getState()

interface IpcState {
  existingBlueprint: Record<string, unknown> | null
  createdId: number
  calls: Array<{ channel: string; args: unknown[] }>
  onDraftCreate?: () => void
}

let ipcState: IpcState
/** 每个测试内创建的 spy，afterEach 统一还原，避免污染被共享的 store 状态对象 */
let openFileSpy: ReturnType<typeof vi.spyOn> | undefined

function installIpc() {
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
        // invokeWithProjectSession 会把冻结会话追加为最后一个参数
        const payload = args.slice(0, -1)
        ipcState.calls.push({ channel, args: payload })
        if (channel === 'db:blueprint-get') return ipcState.existingBlueprint
        if (channel === 'db:blueprint-upsert') return { success: true }
        if (channel === 'db:draft-create') {
          ipcState.onDraftCreate?.()
          return { success: true, id: ipcState.createdId }
        }
        if (channel === 'db:draft-get-meta') {
          return {
            id: ipcState.createdId,
            chapterNumber: 2,
            version: 3,
            status: 'draft',
            source: 'write',
            contentId: 9,
            wordCount: 5,
            sourceDependencies: [],
            dependenciesStale: false,
            createdAt: '',
            updatedAt: '',
          }
        }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
    },
  })
}

beforeEach(() => {
  ipcState = { existingBlueprint: null, createdId: 101, calls: [] }
  // 先清 currentProject（订阅器会把激活会话同步为 currentProject 派生值），再登记会话
  useProjectStore.setState({ currentProject: null })
  setActiveProjectSessionContext(SESSION)
  installIpc()
})

afterEach(() => {
  openFileSpy?.mockRestore()
  openFileSpy = undefined
  setActiveProjectSessionContext(null)
  vi.unstubAllGlobals()
  useProjectStore.setState(ORIGINAL_PROJECT_STATE)
  useEditorStore.setState(ORIGINAL_EDITOR_STATE, true)
})

describe('createPastedDraft', () => {
  const content = '林岚推开门，雪落了满肩。'
  const input = () => ({
    projectSession: SESSION,
    chapterNumber: 2,
    title: '  风起  ',
    content,
  })

  it('creates a minimal blueprint with the trimmed title when none exists', async () => {
    await createPastedDraft(input())

    const upsert = ipcState.calls.find(call => call.channel === 'db:blueprint-upsert')
    expect(upsert).toBeDefined()
    expect(upsert!.args[0]).toEqual({
      chapterNumber: 2,
      title: '风起',
      role: '发展',
      purpose: '',
      keyEvents: '',
      characters: [],
      suspenseHook: '',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
      chapterOutline: '',
    })
  })

  it('keeps an existing blueprint untouched', async () => {
    ipcState.existingBlueprint = { chapterNumber: 2, title: '已有蓝图' }
    await createPastedDraft(input())

    expect(ipcState.calls.some(call => call.channel === 'db:blueprint-upsert')).toBe(false)
  })

  it('persists the draft as an original write with the prose unit count', async () => {
    await createPastedDraft(input())

    const create = ipcState.calls.find(call => call.channel === 'db:draft-create')
    expect(create).toBeDefined()
    expect(create!.args[0]).toEqual({
      chapterNumber: 2,
      version: 1, // 服务端事务内重分配，客户端传值仅为满足通道契约
      source: 'write',
      content,
      wordCount: countDraftUnits(content),
    })
  })

  it('opens the editor tab with the saved draft identity and returns its metadata', async () => {
    const openFile = openFileSpy = vi.spyOn(useEditorStore.getState(), 'openFile')

    const result = await createPastedDraft(input())

    expect(result).toEqual({ id: 101, version: 3 })
    expect(openFile).toHaveBeenCalledOnce()
    const tab = openFile.mock.calls[0][0]
    expect(tab.filePath).toBe('ai-novel://draft/101')
    expect(tab.draftId).toBe(101)
    expect(tab.chapterNumber).toBe(2)
    expect(tab.draftStatus).toBe('draft')
    expect(tab.projectKey).toBe(PROJECT_PATH)
    expect(tab.projectSessionLease).toBe('lease-1')
    expect(tab.savedContent).toBe(content)
  })

  it('aborts silently when the project session becomes stale mid-flight', async () => {
    ipcState.onDraftCreate = () => {
      setActiveProjectSessionContext({ ...SESSION, leaseId: 'lease-2' })
    }
    const openFile = openFileSpy = vi.spyOn(useEditorStore.getState(), 'openFile')

    const result = await createPastedDraft(input())

    expect(result).toBeNull()
    expect(ipcState.calls.some(call => call.channel === 'db:draft-get-meta')).toBe(false)
    expect(openFile).not.toHaveBeenCalled()
  })

  it('propagates persistence failures from the blueprint upsert', async () => {
    vi.stubGlobal('window', {
      aiNovelAPI: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'db:blueprint-get') return null
          if (channel === 'db:blueprint-upsert') return { success: false, error: '蓝图写入被拒绝' }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }),
        on: vi.fn(() => () => {}),
        once: vi.fn(),
        send: vi.fn(),
      },
    })

    await expect(createPastedDraft(input())).rejects.toThrow('蓝图写入被拒绝')
  })
})
