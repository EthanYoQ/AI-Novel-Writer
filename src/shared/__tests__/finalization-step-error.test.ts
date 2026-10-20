import { describe, expect, it } from 'vitest'
import { describeFinalizationStepError, finalizationStepErrorCode } from '../finalization-step-error'

const zh = (zhCNText: string) => zhCNText
const en = (_zhCNText: string, enUSText: string) => enUSText

describe('定稿后处理步骤错误', () => {
  it('去掉 IPC 包装后只认本流程的错误码', () => {
    expect(finalizationStepErrorCode("Error invoking remote method 'project-session:invoke': Error: ROOT_BUDGET_EXHAUSTED")).toBe('ROOT_BUDGET_EXHAUSTED')
    expect(finalizationStepErrorCode('FINALIZATION_GENERATION_INCOMPLETE')).toBe('FINALIZATION_GENERATION_INCOMPLETE')
    expect(finalizationStepErrorCode('network error: socket hang up')).toBeUndefined()
  })

  it('断流说明提示重试，额度用完说明不提示重试', () => {
    expect(describeFinalizationStepError('FINALIZATION_GENERATION_INCOMPLETE', zh)).toBe('模型这次没有返回完整结果（连接中断或输出被截断）。请点「重试」重新生成这一步。')
    expect(describeFinalizationStepError('ROOT_BUDGET_EXHAUSTED', zh)).toBe('这次后处理的模型调用额度已用完（请求超时或用量超出预留），再点「重试」也不会重新生成。')
    expect(describeFinalizationStepError('ROOT_BUDGET_EXHAUSTED', en)).not.toMatch(/Select Retry/)
  })

  it('生成记录不完整或已失效：给可读说明，不提示重试', () => {
    expect(finalizationStepErrorCode("Error invoking remote method 'project-session:invoke': Error: GENERATION_FINALIZATION_ARTIFACT_INVALID")).toBe('GENERATION_FINALIZATION_ARTIFACT_INVALID')
    expect(describeFinalizationStepError('GENERATION_FINALIZATION_ARTIFACT_INVALID', zh)).toContain('重新定稿本章')
    expect(describeFinalizationStepError('GENERATION_FINALIZATION_ARTIFACT_INVALID', en)).not.toMatch(/GENERATION_|Select Retry/)
  })

  it('生成记录写入失败阻断了 root：给可读说明，不提示重试', () => {
    expect(finalizationStepErrorCode("Error invoking remote method 'project-session:invoke': Error: GENERATION_STORAGE_FAILED")).toBe('GENERATION_STORAGE_FAILED')
    expect(describeFinalizationStepError('GENERATION_STORAGE_FAILED', zh)).toContain('再点「重试」也不会重新生成')
    expect(describeFinalizationStepError('GENERATION_STORAGE_FAILED', en)).not.toMatch(/GENERATION_STORAGE_FAILED|Select Retry/)
  })

  it('旧版本存下的带 IPC 包装的步骤错误也换成可读说明', () => {
    expect(describeFinalizationStepError("Error invoking remote method 'project-session:invoke': Error: FINALIZATION_GENERATION_INCOMPLETE", zh))
      .toBe(describeFinalizationStepError('FINALIZATION_GENERATION_INCOMPLETE', zh))
  })

  it('源变化与模型变化给同一说明，未知错误原样显示', () => {
    expect(describeFinalizationStepError('GENERATION_MODEL_CHANGED', en)).toBe(describeFinalizationStepError('FINALIZATION_GENERATION_SOURCE_CHANGED', en))
    expect(describeFinalizationStepError('GENERATION_SOURCE_CHANGED_MODEL', en)).toBe(describeFinalizationStepError('FINALIZATION_GENERATION_SOURCE_CHANGED', en))
    expect(describeFinalizationStepError('network error: socket hang up', en)).toBe('network error: socket hang up')
  })

  it('结果不可用不否认已发请求并提示重试；没发请求的情形保留原说明', () => {
    expect(finalizationStepErrorCode('FINALIZATION_GENERATION_RESULT_UNUSABLE')).toBe('FINALIZATION_GENERATION_RESULT_UNUSABLE')
    expect(describeFinalizationStepError('FINALIZATION_GENERATION_RESULT_UNUSABLE', zh)).toBe('模型返回了内容，但结果不可用（例如为空）。请点「重试」重新生成这一步。')
    expect(describeFinalizationStepError('FINALIZATION_GENERATION_RESULT_UNUSABLE', en)).not.toMatch(/no new model request/)
    expect(describeFinalizationStepError('FINALIZATION_GENERATION_ARTIFACT_REQUIRED', zh)).toContain('本次没有发出新的模型请求')
  })
})
