/**
 * planning-material-character-commit 的边界测试。
 *
 * 这一层的存在理由就是「让确认成为作者的动作」。因此这里逐条钉住失败面：
 * 会话切换、未勾选、名单状态不安全、乐观锁过期、主进程抛错、幂等回执 ——
 * 每一条都必须给出**明确出路**，而不是静默丢弃或把原始异常抛给作者。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../stores/project-store'
import { globalEventBus } from '../../shared/event-bus'
import type { CharacterRosterEntry } from '../../shared/character-roster'
import { CHARACTER_ROSTER_SCHEMA_VERSION } from '../../shared/character-roster'
import { commitPlanningMaterialCharacters } from '../planning-material-character-commit'

const projectPath = 'C:\\novels\\A'
const projectSession = { projectId: 'project-1', leaseId: 'lease-1', projectPath }

const entry: CharacterRosterEntry = {
  name: '周岚',
  role: 'supporting',
  gender: '',
  age: '45',
  appearance: '',
  personality: '',
  background: '守馆二十年',
  abilities: '',
  motivation: '保护幸存者',
  relationships: [{ target: '林晓', relation: '秘密保护' }],
  arc: '',
  notes: '',
}

function setCurrentProject(leaseId: string) {
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      name: 'A',
      path: projectPath,
      sessionLease: leaseId,
      novelConfig: { writingLanguage: 'zh-CN' },
    } as never,
  })
}

describe('planning material character commit', () => {
  let invoke: ReturnType<typeof vi.fn>
  let refreshEvents: Array<{ resources: string[]; projectPath: string }>
  let unsubscribe: () => void

  beforeEach(() => {
    invoke = vi.fn()
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() },
    })
    setCurrentProject(projectSession.leaseId)
    refreshEvents = []
    unsubscribe = globalEventBus.on('REFRESH_RESOURCE', payload => {
      refreshEvents.push(payload as { resources: string[]; projectPath: string })
    })
  })

  afterEach(() => {
    unsubscribe()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
  })

  it('提交前重新读取 revision，并以最新版本作为乐观锁依据', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
      if (channel === 'db:character-roster-commit') return { success: true, receipt: { idempotent: false } }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result).toEqual({ success: true, savedCount: 1, idempotent: false })
    expect(invoke).toHaveBeenNthCalledWith(1, 'db:character-roster-read', projectPath, projectSession)
    expect(invoke).toHaveBeenNthCalledWith(2, 'db:character-roster-commit', expect.objectContaining({
      operationId: 'planning-material-batch-1',
      expectedRevision: 7,
      schemaVersion: CHARACTER_ROSTER_SCHEMA_VERSION,
      intent: 'novel_import',
      entries: [expect.objectContaining({ name: '周岚', role: 'supporting' })],
    }), projectPath, projectSession)
    // 只有真正写入成功才广播刷新。
    expect(refreshEvents).toEqual([
      expect.objectContaining({ resources: ['characterCards'], projectPath }),
    ])
  })

  it('同名角色按作者选择覆盖时，把覆盖意图透传给名单仓库', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') {
        return { status: 'ready', revision: 9, entries: [{ ...entry, age: '18' }] }
      }
      if (channel === 'db:character-roster-commit') return { success: true, receipt: { idempotent: false } }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-overwrite-1',
      overwriteExisting: true,
    })

    expect(result).toEqual({ success: true, savedCount: 1, idempotent: false })
    expect(invoke).toHaveBeenNthCalledWith(2, 'db:character-roster-commit', expect.objectContaining({
      intent: 'novel_import',
      overwriteExisting: true,
    }), projectPath, projectSession)
  })

  it('没有选择覆盖时不携带覆盖意图，保持原有的保守合并', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 9, entries: [] }
      if (channel === 'db:character-roster-commit') return { success: true, receipt: { idempotent: false } }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-keep-1',
    })

    const commitCall = invoke.mock.calls.find(call => call[0] === 'db:character-roster-commit')
    expect(commitCall?.[1]).not.toHaveProperty('overwriteExisting')
  })

  it('项目已切换时不发起任何读写，也不广播刷新', async () => {
    setCurrentProject('lease-2')

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result).toEqual(expect.objectContaining({ success: false, retryable: false }))
    expect(invoke).not.toHaveBeenCalled()
    expect(refreshEvents).toEqual([])
  })

  it('没有勾选任何条目时不发起任何读写', async () => {
    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [],
      operationId: 'planning-material-batch-1',
    })

    expect(result).toEqual(expect.objectContaining({ success: false, retryable: false }))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('角色名单状态不安全时拒绝写入，并要求先修复旧数据', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'legacy_repair_required', revision: 3, entries: [] }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result).toEqual(expect.objectContaining({ success: false, retryable: false }))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(refreshEvents).toEqual([])
  })

  it('乐观锁过期时给出可重试的明确出路，而不是抛出原始错误', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 4, entries: [] }
      if (channel === 'db:character-roster-commit') {
        return { success: false, error: '角色名单 revision 已过期，已拒绝覆盖' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.retryable).toBe(true)
    expect(result.error).toContain('再次点击')
    expect(refreshEvents).toEqual([])
  })

  it('主进程抛错时也返回可读结果，不把异常漏给界面', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'empty', revision: 0, entries: [] }
      throw new Error('数据库连接已关闭')
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.error).toContain('数据库连接已关闭')
    expect(result.retryable).toBe(true)
  })

  it('读取角色名单失败时保留可重试语义', async () => {
    invoke.mockRejectedValue(new Error('IPC 通道不可用'))

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('unreachable')
    expect(result.retryable).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('幂等回执透传给调用方', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 9, entries: [] }
      if (channel === 'db:character-roster-commit') return { success: true, receipt: { idempotent: true } }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    const result = await commitPlanningMaterialCharacters({
      session: projectSession,
      entries: [entry],
      operationId: 'planning-material-batch-1',
    })

    expect(result).toEqual({ success: true, savedCount: 1, idempotent: true })
  })
})
