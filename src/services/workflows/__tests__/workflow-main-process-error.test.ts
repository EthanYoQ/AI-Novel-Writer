import { describe, expect, it } from 'vitest'

import type { WorkflowContext } from '../../../stores/workflow-store'
import { workflowMainProcessError } from '../workflow-project-session'

function contextIn(uiLocale: WorkflowContext['uiLocale']): WorkflowContext {
  return {
    runId: 'run-1',
    projectPath: 'C:\\tmp\\main-error',
    projectSession: { projectId: 'project-1', leaseId: 'lease-1', projectPath: 'C:\\tmp\\main-error' },
    writingLanguage: 'zh-CN',
    uiLocale,
    data: {},
    cancelled: false,
  }
}

const fail = (uiLocale: WorkflowContext['uiLocale'], error: unknown) =>
  workflowMainProcessError(contextIn(uiLocale), error, '定稿事务未提交', 'The finalization transaction was not committed.')

describe('workflow failures carrying a main-process error (#466)', () => {
  it('英文界面不转出主进程的中文原文，只给英文说明', () => {
    expect(fail('en-US', 'Error: 项目数据库未打开').message).toBe('The finalization transaction was not committed.')
  })

  it('中文界面在说明后附上主进程原文', () => {
    expect(fail('zh-CN', 'Error: 项目数据库未打开').message).toBe('定稿事务未提交：项目数据库未打开')
  })

  it('登记过的错误码按界面语言解释', () => {
    expect(fail('en-US', 'PROJECT_NOT_OPEN').message).toBe('The finalization transaction was not committed. Open a project first.')
    expect(fail('zh-CN', 'PROJECT_NOT_OPEN').message).toBe('定稿事务未提交：请先打开项目。')
  })

  it('带名字的错误类转来的会话失效码同样按界面语言解释（#474）', () => {
    const stale = 'ProjectSessionStaleError: PROJECT_SESSION_STALE'
    expect(fail('en-US', stale).message).toBe('The finalization transaction was not committed. The project was switched or reopened, and this action belonged to the earlier session, so it was rejected. Repeat it in the project that is open now.')
    expect(fail('zh-CN', stale).message).toBe('定稿事务未提交：项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。')
  })

  it('带名字的错误类转来的未登记码同样附上并保留在 code 上', () => {
    const failure = fail('en-US', 'PortableProjectArchiveError: PORTABLE_SOURCE_CHANGED')
    expect(failure.message).toBe('The finalization transaction was not committed. PORTABLE_SOURCE_CHANGED')
    expect(failure).toHaveProperty('code', 'PORTABLE_SOURCE_CHANGED')
  })

  it('未登记的错误码原样附上供反馈定位，并保留在 code 上', () => {
    const failure = fail('en-US', 'GENERATION_FINALIZATION_EFFECT_CONFLICT')
    expect(failure.message).toBe('The finalization transaction was not committed. GENERATION_FINALIZATION_EFFECT_CONFLICT')
    expect(failure).toHaveProperty('code', 'GENERATION_FINALIZATION_EFFECT_CONFLICT')
  })

  it('主进程没给原因时只给说明', () => {
    expect(fail('en-US', undefined).message).toBe('The finalization transaction was not committed.')
    expect(fail('zh-CN', '  ').message).toBe('定稿事务未提交')
  })
})
