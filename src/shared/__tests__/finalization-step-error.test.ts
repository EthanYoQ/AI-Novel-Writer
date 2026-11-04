import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describeFinalizationStepError, finalizationStepErrorCode, planFinalizationRetry } from '../finalization-step-error'
import { appErrorMessage } from '../../i18n/app-errors'

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

  // 合同解析函数抛出的每个码都会在提交时记到「角色状态更新」步骤上（#552）；从源码取全集，新增的码漏登记时这里先红。
  const contractCodes = [...new Set(readFileSync(new URL('../finalized-continuity.ts', import.meta.url), 'utf8').match(/FINALIZED_CHARACTER_[A-Z_]+[A-Z]/gu))]
  it('#552 IDENTITY_REQUIRED 在章节要点提交时也会出现：说明不能说成角色卡没更新', () => {
    const raw = "Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_IDENTITY_REQUIRED"
    for (const text of [describeFinalizationStepError(raw, zh), appErrorMessage('zh-CN', new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED'))]) {
      expect(text).toContain('对不上')
      expect(text).not.toContain('角色卡没有自动更新')
    }
    for (const text of [describeFinalizationStepError(raw, en), appErrorMessage('en-US', new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED'))]) {
      expect(text).toMatch(/did not match/u)
      expect(text).not.toContain('character cards were not updated')
    }
    expect(planFinalizationRetry({ kb_import: { ok: true }, chapter_notes: { ok: false, error: raw } }).rows).toEqual(new Set(['chapter_notes']))
  })

  it('#552 角色状态合同码全集：每个都有说明，告诉作者可以重试或换模型，不露原码', () => {
    expect(contractCodes).toHaveLength(8)
    for (const code of contractCodes) {
      const raw = `Error invoking remote method 'finalization-generation:commit': Error: ${code}`
      expect(finalizationStepErrorCode(raw), code).toBe(code)
      const zhText = describeFinalizationStepError(raw, zh), enText = describeFinalizationStepError(raw, en)
      expect(zhText, code).toContain('正文定稿已保存')
      expect(zhText, code).toContain('「分工模型」')
      expect(zhText, code).toContain('「定稿后处理」')
      expect(enText, code).toContain('Models by stage')
      expect(enText, code).toContain('After finalizing')
      for (const text of [zhText, enText]) expect(text, code).not.toMatch(/Error invoking|FINALIZED_CHARACTER/u)
      expect(planFinalizationRetry({ kb_import: { ok: true }, chapter_notes: { ok: true }, character_cards: { ok: false, error: code } }))
        .toMatchObject({ rows: new Set(['character_cards']), card: ['character_cards'] })
    }
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


describe('重开再定稿后清理旧版本（ADR-0024）', () => {
  const IPC = "Error invoking remote method 'project-session:invoke': Error: "
  const failed = (error: string) => ({ ok: false, error })
  const CODES = [
    'FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED',
    'FINALIZATION_REPLACED_KNOWLEDGE_EDITED',
    'FINALIZATION_REPLACED_KNOWLEDGE_NOT_REMOVED',
    'FINALIZATION_REPLACED_MANUSCRIPT_PUBLICATION_REQUIRED',
    'FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["Chapter 1.txt"]',
    'FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["Chapter 1.txt"]',
    'FINALIZATION_REPLACED_CLEANUP_PENDING',
  ]

  it.each(CODES)('%s：中英文都给作者能照着做的说明，不带错误码', code => {
    expect(finalizationStepErrorCode(`${IPC}${code}`)).toBe(code)
    for (const text of [describeFinalizationStepError(`${IPC}${code}`, zh), describeFinalizationStepError(code, en)]) {
      expect(text).not.toMatch(/Error invoking|FINALIZATION_|\{names\}/u)
    }
    expect(describeFinalizationStepError(code, en)).not.toMatch(/\p{Script=Han}/u)
  })

  it('留下的或删不掉的旧文件按名字列出', () => {
    const names = 'FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 雾钟.txt","第1章 雾钟 (2).txt"]'
    expect(describeFinalizationStepError(names, zh)).toContain('「第1章 雾钟.txt」、「第1章 雾钟 (2).txt」')
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["Chapter 1.txt"]', en)).toContain('“Chapter 1.txt”')
  })

  it('英文说明随文件数用单数或复数', () => {
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["a.txt"]', en)).toBe(
      "The replaced version's manuscript file “a.txt” was changed after it was finalized, so it was kept. If you no longer need it, delete or rename it yourself, then select Retry.")
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["a.txt","b.txt"]', en)).toBe(
      "The replaced versions' manuscript files “a.txt”, “b.txt” were changed after they were finalized, so they were kept. If you no longer need them, delete or rename them yourself, then select Retry.")
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["a.txt"]', en)).toBe(
      "The replaced version's manuscript file “a.txt” is open in another program or read-only, so it could not be deleted yet. Close that program or clear read-only, then select Retry.")
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_MANUSCRIPT_BUSY:["a.txt","b.txt"]', en)).toBe(
      "The replaced versions' manuscript files “a.txt”, “b.txt” are open in another program or read-only, so they could not be deleted yet. Close those programs or clear read-only, then select Retry.")
  })

  it('改过的旧知识库文档重试也不删，不摆重试；其余情形可以重试，新文档没导入时先重试导入', () => {
    const plan = planFinalizationRetry({
      kb_import: failed('向量服务没有响应'),
      remove_replaced_knowledge: failed('FINALIZATION_REPLACED_KNOWLEDGE_IMPORT_REQUIRED'),
      remove_replaced_manuscripts: failed('FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 雾钟.txt"]'),
      chapter_notes: { ok: true },
      character_cards: { ok: true },
    })
    expect({ rows: [...plan.rows], card: plan.card })
      .toEqual({ rows: ['kb_import', 'remove_replaced_manuscripts'], card: ['kb_import', 'remove_replaced_knowledge', 'remove_replaced_manuscripts'] })

    const edited = planFinalizationRetry({ kb_import: { ok: true }, remove_replaced_knowledge: failed('FINALIZATION_REPLACED_KNOWLEDGE_EDITED') })
    expect({ rows: [...edited.rows], card: edited.card }).toEqual({ rows: [], card: [] })
    expect(describeFinalizationStepError('FINALIZATION_REPLACED_KNOWLEDGE_EDITED', zh)).toContain('再点「重试」结果也一样')
  })

  it('文件名里有 $ 也原样写出', () => {
    const error = 'FINALIZATION_REPLACED_MANUSCRIPT_KEPT:["第1章 $& 与 $`.txt"]'
    expect(describeFinalizationStepError(error, zh)).toContain('「第1章 $& 与 $`.txt」')
    expect(describeFinalizationStepError(error, en)).toContain('“第1章 $& 与 $`.txt”')
  })
})

describe('#571 作品所在的磁盘不支持知识库的提交方式', () => {
  const raw = "Error invoking remote method 'project-session:invoke': Error: KNOWLEDGE_BASE_VOLUME_UNSUPPORTED"

  it('记成码；中英文说明正文已保存、原因与搬到哪种磁盘，不露原码，不追加「请点重试」', () => {
    expect(finalizationStepErrorCode(raw)).toBe('KNOWLEDGE_BASE_VOLUME_UNSUPPORTED')
    const zhText = describeFinalizationStepError(raw, zh), enText = describeFinalizationStepError(raw, en)
    expect(zhText).toContain('正文定稿已保存')
    expect(zhText).toMatch(/exFAT/u)
    expect(zhText).toMatch(/NTFS/u)
    expect(zhText).toMatch(/APFS/u)
    expect(zhText).toContain('「重试」')
    expect(enText).toMatch(/finalized chapter text is saved/u)
    expect(enText).toMatch(/NTFS/u)
    expect(enText).toMatch(/APFS/u)
    expect(enText).not.toMatch(/\p{Script=Han}/u)
    for (const text of [zhText, enText]) expect(text).not.toMatch(/KNOWLEDGE_BASE|LanceError|os error|请点「重试」重新生成|Select Retry to generate/u)
  })

  it('换到支持的磁盘后重试才有用：单步与整卡都还能重试', () => {
    expect(planFinalizationRetry({ kb_import: failedStep(raw), chapter_notes: { ok: true }, character_cards: { ok: true } }))
      .toMatchObject({ rows: new Set(['kb_import']), card: ['kb_import'] })
  })

  it('知识库页导入创作资料走同一个码，说明里没有定稿字样', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const text = appErrorMessage(locale, new Error('KNOWLEDGE_BASE_VOLUME_UNSUPPORTED'))
      expect(text).toMatch(/NTFS/u)
      expect(text).not.toMatch(/KNOWLEDGE_BASE|定稿|finalized/u)
    }
  })
})

function failedStep(error: string) { return { ok: false, error } }
