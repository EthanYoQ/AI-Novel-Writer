import { describe, expect, it } from 'vitest'
import { describeFinalizationStepError, finalizationStepErrorCode, planFinalizationRetry } from '../finalization-step-error'

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

  it('#491 角色状态来源冲突：中英文都说明正文已保存、为何没更新角色卡、作者该做什么，不带错误码', () => {
    const raw = "Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_SOURCE_CONFLICT"
    expect(finalizationStepErrorCode(raw)).toBe('FINALIZED_CHARACTER_SOURCE_CONFLICT')
    const zhText = describeFinalizationStepError(raw, zh), enText = describeFinalizationStepError(raw, en)
    expect(zhText).toContain('正文定稿已保存')
    expect(zhText).toContain('后面章节')
    expect(zhText).toContain('「当前状态」')
    expect(enText).toContain('Current state')
    expect(zhText).toContain('从备份恢复')
    expect(enText).toContain('restored from a backup')
    expect(zhText).not.toContain('可以先点「重试」')
    expect(enText).not.toContain('Try Retry first')
    expect(zhText).toContain('重试仍失败')
    expect(enText).toContain('If Retry still fails')
    for (const text of [zhText, enText]) expect(text).not.toMatch(/即可完成|will finish this step/u)
    for (const text of [zhText, enText]) expect(text).not.toMatch(/Error invoking|FINALIZED_CHARACTER|请点「重试」|Select Retry/u)
  })

  it('#484 角色状态字段在生成期间被改动：记成码，中英文说明原因、重试无效和作者能做什么', () => {
    const raw = "Error invoking remote method 'project-session:invoke': Error: FINALIZED_CHARACTER_FIELD_CONFLICT"
    expect(finalizationStepErrorCode(raw)).toBe('FINALIZED_CHARACTER_FIELD_CONFLICT')
    const zhText = describeFinalizationStepError(raw, zh), enText = describeFinalizationStepError(raw, en)
    expect(zhText).toContain('正文定稿已保存')
    expect(zhText).toContain('「当前状态」')
    expect(enText).toContain('Current state')
    expect(zhText).toContain('再点「重试」结果也一样')
    expect(enText).toContain('Retrying gives the same result')
    expect(zhText).not.toBe(describeFinalizationStepError('FINALIZED_CHARACTER_SOURCE_CONFLICT', zh))
    for (const text of [zhText, enText]) expect(text).not.toMatch(/Error invoking|FINALIZED_CHARACTER|请点「重试」|Select Retry/u)
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

  describe('#512 提交时项目数据已变', () => {
    const IPC = "Error invoking remote method 'project-session:invoke': Error: "
    const failed = (error: string) => ({ ok: false, error })

    it.each([
      'GENERATION_FINALIZATION_NOTES_CHANGED',
      'GENERATION_FINALIZATION_IDENTITY_CHANGED',
      'FINALIZED_CHARACTER_CONTEXT_CHANGED',
      'FINALIZED_CHARACTER_ID_RETIRED',
    ])('%s：中英文都给作者能照着做的说明，不带错误码', code => {
      expect(finalizationStepErrorCode(`${IPC}${code}`)).toBe(code)
      for (const text of [describeFinalizationStepError(`${IPC}${code}`, zh), describeFinalizationStepError(code, en)]) {
        expect(text).not.toMatch(/Error invoking|GENERATION_|FINALIZED_/u)
      }
      expect(describeFinalizationStepError(code, en)).not.toMatch(/\p{Script=Han}/u)
    })

    it('章节要点在生成期间被作者改过：重试有用，说明写明重试会替换作者改的要点，不机械地补「请点重试」', () => {
      const plan = planFinalizationRetry({
        kb_import: { ok: true },
        chapter_notes: failed('GENERATION_FINALIZATION_NOTES_CHANGED'),
        character_cards: failed('GENERATION_FINALIZATION_PREDECESSOR_REQUIRED'),
      })
      expect([...plan.rows]).toEqual(['chapter_notes'])
      expect(plan.card).toEqual(['chapter_notes', 'character_cards'])
      const zhText = describeFinalizationStepError('GENERATION_FINALIZATION_NOTES_CHANGED', zh)
      const enText = describeFinalizationStepError('GENERATION_FINALIZATION_NOTES_CHANGED', en)
      expect(zhText).toContain('替换')
      expect(enText).toContain('replaces')
      expect(zhText).not.toContain('请点「重试」重新生成这一步')
      expect(enText).not.toContain('Select Retry to generate this step again')
    })

    it.each([
      'GENERATION_FINALIZATION_IDENTITY_CHANGED',
      'FINALIZED_CHARACTER_CONTEXT_CHANGED',
      'FINALIZED_CHARACTER_ID_RETIRED',
    ])('%s：重试也过不去，这一行和整卡都不重试，说明告诉作者重新定稿', code => {
      for (const stepKey of ['chapter_notes', 'character_cards']) {
        const plan = planFinalizationRetry({ kb_import: { ok: true }, chapter_notes: { ok: true }, [stepKey]: failed(`${IPC}${code}`) })
        expect({ rows: [...plan.rows], card: plan.card }).toEqual({ rows: [], card: [] })
      }
      expect(describeFinalizationStepError(code, zh)).toContain('重新定稿本章')
      expect(describeFinalizationStepError(code, en)).toContain('Finalize this chapter again')
      expect(describeFinalizationStepError(code, zh)).toContain('再点「重试」结果也一样')
    })

    it('没登记的错误在现有步骤上照常可以重试', () => {
      const plan = planFinalizationRetry({ kb_import: failed('向量服务没有响应'), chapter_notes: { ok: true }, character_cards: { ok: true } })
      expect({ rows: [...plan.rows], card: plan.card }).toEqual({ rows: ['kb_import'], card: ['kb_import'] })
    })
  })

  describe('#512 旧版本跑批里留下、现在流程已没有的步骤', () => {
    it('没登记的错误也不排进按行重试与整卡重试，单独列出', () => {
      const plan = planFinalizationRetry({
        kb_import: { ok: false, error: '向量服务没有响应' },
        chapter_notes: { ok: true },
        character_cards: { ok: true },
        style_analysis: { ok: false, error: '模型长时间没有响应' },
      })
      expect({ rows: [...plan.rows], card: plan.card, retired: [...plan.retired] })
        .toEqual({ rows: ['kb_import'], card: ['kb_import'], retired: ['style_analysis'] })
    })

    it('只有旧步骤失败时，整张卡没有可以重试的步骤', () => {
      const plan = planFinalizationRetry({ kb_import: { ok: true }, chapter_notes: { ok: true }, character_cards: { ok: true }, style_analysis: { ok: false } })
      expect({ rows: [...plan.rows], card: plan.card }).toEqual({ rows: [], card: [] })
    })
  })
})

