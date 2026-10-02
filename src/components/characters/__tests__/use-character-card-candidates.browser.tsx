/* eslint-disable react-refresh/only-export-components -- 测试文件的 Harness 只是用例挂载壳，不是 HMR 目标 */
/**
 * 角色卡候选控制器的边界测试。
 *
 * 这一层负责的是「作者终于被问了」这件事本身，所以用例逐条钉住它的失败面：
 * 会话切换、0 条候选、作者放弃、提交失败后是否还能原地重试。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CharacterCardCandidateDialog from '../CharacterCardCandidateDialog'
import { useCharacterCardCandidates } from '../use-character-card-candidates'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { CharacterRosterEntry } from '../../../shared/character-roster'
import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'

const project = { id: 'candidates', path: 'C:\\novels\\candidates', sessionLease: 'lease-1' } as ProjectData
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const candidate: CharacterRosterEntry = {
  name: '林舟',
  role: 'protagonist',
  gender: '',
  age: '',
  appearance: '',
  personality: '',
  background: '旧港调查员',
  abilities: '',
  motivation: '',
  relationships: [],
  arc: '',
  notes: '',
}

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
const onCommitted = vi.fn<(savedCount: number) => void>()
let session: ProjectSessionContext

function Harness() {
  const flow = useCharacterCardCandidates({ onCommitted })
  return (
    <>
      <button type="button" onClick={() => flow.deliver([candidate], session)}>deliver</button>
      <button type="button" onClick={() => flow.deliver([], session)}>deliver-empty</button>
      <button type="button" onClick={() => flow.deliver([candidate], { ...session, leaseId: 'stale-lease' })}>deliver-stale</button>
      <CharacterCardCandidateDialog
        open={flow.open}
        candidates={flow.candidates}
        existingEntries={[]}
        busy={flow.busy}
        error={flow.error}
        onClose={flow.discard}
        onConfirm={(selected, overwriteExisting) => { void flow.submit(selected, overwriteExisting) }}
      />
    </>
  )
}

async function click(label: string) {
  const target = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
  expect(target, label).toBeTruthy()
  await act(async () => target!.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
}

beforeEach(async () => {
  vi.clearAllMocks()
  invoke = vi.fn().mockImplementation((channel: string) => {
    if (channel === 'db:character-roster-read') return Promise.resolve({ status: 'ready', revision: 5, entries: [] })
    if (channel === 'db:character-roster-commit') return Promise.resolve({ success: true, receipt: { idempotent: false } })
    return Promise.resolve(null)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() },
  })
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: project })
  session = { projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! }
  setActiveProjectSessionContext(session)
  onCommitted.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Harness />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState({ currentProject: null })
})

describe('角色卡候选控制器', () => {
  it('交付候选后弹面板，作者的确认才写入名单', async () => {
    await click('deliver')
    expect(document.body.textContent).toContain('待确认的角色卡')
    expect(document.body.textContent).toContain('旧港调查员')
    // 候选只是被"交付"，此时一次写入都还没发生。
    expect(invoke).not.toHaveBeenCalled()

    await click('写入所选的 1 张角色卡')
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-read',
      project.path,
      expect.anything(),
    )
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'novel_import',
        expectedRevision: 5,
        entries: [expect.objectContaining({ name: '林舟' })],
      }),
      project.path,
      expect.anything(),
    )
    expect(onCommitted).toHaveBeenCalledWith(1)
  })

  it('作者放弃候选时不发生任何写入', async () => {
    await click('deliver')
    await click('丢弃这批候选')
    expect(invoke).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('0 条候选不弹面板，也不会误报成功', async () => {
    await click('deliver-empty')
    expect(document.body.textContent).not.toContain('待写入的角色卡')
    expect(document.body.textContent).not.toContain('已写入')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('会话已失效时拒绝交付候选，绝不写进别的项目', async () => {
    await click('deliver-stale')
    expect(document.body.textContent).not.toContain('旧港调查员')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('写入失败时保留候选与原因，作者可原地重试', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:character-roster-read') return Promise.resolve({ status: 'ready', revision: 5, entries: [] })
      if (channel === 'db:character-roster-commit') {
        return Promise.resolve({ success: false, error: '角色名单 revision 已过期，已拒绝覆盖' })
      }
      return Promise.resolve(null)
    })

    await click('deliver')
    await click('写入所选的 1 张角色卡')

    expect(document.body.textContent).toContain('再次点击')
    // 候选仍在面板里：作者不必再花一次模型调用。
    expect(document.body.textContent).toContain('旧港调查员')
    expect(onCommitted).not.toHaveBeenCalled()

    // 第二次提交换用最新 revision，因此能成功写入。
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:character-roster-read') return Promise.resolve({ status: 'ready', revision: 6, entries: [] })
      if (channel === 'db:character-roster-commit') return Promise.resolve({ success: true, receipt: { idempotent: false } })
      return Promise.resolve(null)
    })
    await click('写入所选的 1 张角色卡')
    expect(onCommitted).toHaveBeenCalledWith(1)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({ expectedRevision: 6 }),
      project.path,
      expect.anything(),
    )
  })
})
