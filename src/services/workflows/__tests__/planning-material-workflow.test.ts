import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locale } from '../../../i18n/types'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'

const { invokeWithProjectSession } = vi.hoisted(() => ({ invokeWithProjectSession: vi.fn() }))

vi.mock('../../ipc-client', () => ({ ipc: { invoke: vi.fn(), invokeWithProjectSession } }))

import { createPlanningMaterialWorkflow } from '../planning-material-workflow'

const projectSession = { projectId: 'project-1', leaseId: 'lease-1', projectPath: 'C:\\novels\\A' }

async function importFailure(locale: Locale, result: Record<string, unknown>): Promise<string> {
  invokeWithProjectSession.mockResolvedValue(result)
  const workflow = createPlanningMaterialWorkflow({ projectSession, materials: [{ fileName: '设定.md', text: '' }] }, locale)
  const step = workflow.steps[0] as { executor: (...args: unknown[]) => Promise<unknown> }
  const callbacks = { log: vi.fn(), setProgress: vi.fn() }
  const failure = await step.executor(step, { projectPath: projectSession.projectPath }, callbacks).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  return (failure as Error).message
}

// 导入创作资料被主进程拒绝时，运行卡片按界面语言说明原因，不露错误码（#474 B3）。
describe('planning material import failures', () => {
  beforeEach(() => {
    invokeWithProjectSession.mockReset()
    useProjectStore.setState({ currentProject: { id: 'project-1', path: projectSession.projectPath, sessionLease: 'lease-1' } as ProjectData })
  })

  it('explains a registered main-process code in English', async () => {
    const message = await importFailure('en-US', { success: false, error: 'KNOWLEDGE_BASE_TEXT_EMPTY' })
    expect(message).toContain('Could not import 设定.md')
    expect(message).toContain('The material is empty')
    expect(message.replace('设定.md', '')).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
  })

  it('explains a registered main-process code in Chinese', async () => {
    const message = await importFailure('zh-CN', { success: false, error: 'KNOWLEDGE_BASE_TEXT_EMPTY' })
    expect(message).toContain('资料内容是空的')
    expect(message).not.toMatch(/[A-Z]{3,}_/u)
  })

  it('prefers errorCode over error text written in the system language', async () => {
    const message = await importFailure('en-US', {
      success: false,
      errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED',
      error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
    })
    expect(message).toContain('Legacy knowledge-base data must be repaired')
    expect(message.replace('设定.md', '')).not.toMatch(/\p{Script=Han}/u)
  })
})
