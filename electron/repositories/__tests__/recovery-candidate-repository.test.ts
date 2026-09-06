import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, initProjectDatabase } from '../../database'
import { searchKnowledge } from '../../knowledge-base'
import { BlueprintRepository } from '../blueprint-repository'
import { CharacterRepository } from '../character-repository'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { RecoveryCandidateRepository } from '../recovery-candidate-repository'
import { SummaryRepository } from '../summary-repository'

let projectRoot = ''

const source = {
  chapterNumber: 3,
  title: '失控列车',
  role: '发展',
  purpose: '揭示追踪者',
  keyEvents: '林岚发现列车没有司机',
  characters: ['林岚'],
  suspenseHook: '隧道尽头出现第二辆列车',
  userGuidance: '保持封闭空间压迫感',
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-recovery-'))
  initProjectDatabase(projectRoot)
  BlueprintRepository.upsert({
    ...source,
    notes: '',
    notesUpdatedAt: '',
  })
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('RecoveryCandidateRepository project-local seam', () => {
  it('persists only visible prose, survives reopen, and stays outside formal facts and search', async () => {
    const recorded = RecoveryCandidateRepository.record({
      runId: 'run-interrupted',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: 'reasoning: private chain</think>林岚推开驾驶室的门。',
      failureCode: 'PROVIDER_REQUEST_FAILED',
      failureReason: 'connection reset',
    })

    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(RecoveryCandidateRepository.listPending()).toEqual([
      expect.objectContaining({
        candidateId: recorded.candidateId,
        runId: 'run-interrupted',
        stepId: 'generate-draft',
        projectId: 'project-recovery',
        chapterNumber: 3,
        chapterTitle: source.title,
        visibleText: '林岚推开驾驶室的门。',
        failureCode: 'PROVIDER_REQUEST_FAILED',
        failureReason: 'connection reset',
        status: 'pending',
        sourceCurrent: true,
        replacesCandidateId: null,
      }),
    ])

    expect(DraftRepository.listAll()).toEqual([])
    expect(FinalizationRepository.listAuthoritativeForExport()).toEqual([])
    expect(CharacterRepository.getAll()).toEqual([])
    expect(SummaryRepository.listFinalizedContinuityBefore(4)).toEqual([])
    await expect(searchKnowledge(
      '驾驶室',
      projectRoot,
      'openai',
      { baseUrl: '', apiKey: '' },
    )).resolves.toEqual([])
  })

  it('drops every prefix before an orphan thinking close tag', () => {
    const recorded = RecoveryCandidateRepository.record({
      runId: 'run-hidden-prefix',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: 'Let me inspect the scene constraints first.</think>林岚推开驾驶室的门。',
      failureCode: 'PROVIDER_REQUEST_FAILED',
      failureReason: 'connection reset',
    })

    expect(recorded.visibleText).toBe('林岚推开驾驶室的门。')
  })

  it('updates a pending candidate durably without creating formal project facts', async () => {
    const recorded = RecoveryCandidateRepository.record({
      runId: 'run-editable',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: '初始恢复正文',
      failureCode: 'PROVIDER_REQUEST_FAILED',
      failureReason: 'connection reset',
    })

    RecoveryCandidateRepository.updatePending(recorded.candidateId, '作者编辑后的恢复正文')
    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(RecoveryCandidateRepository.listPending()).toEqual([
      expect.objectContaining({
        candidateId: recorded.candidateId,
        visibleText: '作者编辑后的恢复正文',
        status: 'pending',
      }),
    ])
    expect(DraftRepository.listAll()).toEqual([])
    expect(FinalizationRepository.listAuthoritativeForExport()).toEqual([])
    expect(CharacterRepository.getAll()).toEqual([])
    expect(SummaryRepository.listFinalizedContinuityBefore(4)).toEqual([])
    await expect(searchKnowledge(
      '作者编辑后的恢复正文',
      projectRoot,
      'openai',
      { baseUrl: '', apiKey: '' },
    )).resolves.toEqual([])
  })

  it('marks a candidate stale when its frozen chapter source changes', () => {
    const recorded = RecoveryCandidateRepository.record({
      runId: 'run-stale',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: '候选正文',
      failureCode: 'INCOMPLETE_LENGTH',
      failureReason: 'length',
    })
    BlueprintRepository.upsert({
      ...source,
      keyEvents: '作者已经修改关键事件',
      notes: '',
      notesUpdatedAt: '',
    })

    expect(RecoveryCandidateRepository.listPending()[0]?.sourceCurrent).toBe(false)
    expect(() => RecoveryCandidateRepository.resolve(recorded.candidateId, 'continued'))
      .toThrow(/源章节已变化/u)
    expect(() => RecoveryCandidateRepository.resolve(recorded.candidateId, 'discarded'))
      .not.toThrow()
  })

  it('rejects update and continue after the generation-start draft changes', () => {
    const sourceDraftId = DraftRepository.create({
      chapterNumber: 3,
      source: 'write',
      content: '生成开始时的草稿',
      wordCount: 8,
    })
    const recorded = RecoveryCandidateRepository.record({
      runId: 'run-draft-stale',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: { id: sourceDraftId, version: 1 },
      visibleText: '候选正文',
      failureCode: 'INCOMPLETE_LENGTH',
      failureReason: 'length',
    })

    expect(recorded.sourceCurrent).toBe(true)
    DraftRepository.create({
      chapterNumber: 3,
      source: 'rewrite',
      content: '后来保存的新版本',
      wordCount: 8,
    })

    expect(RecoveryCandidateRepository.listPending()[0]?.sourceCurrent).toBe(false)
    expect(() => RecoveryCandidateRepository.updatePending(recorded.candidateId, '编辑后的候选'))
      .toThrow(/源章节已变化/u)
    expect(() => RecoveryCandidateRepository.resolve(recorded.candidateId, 'continued'))
      .toThrow(/源章节已变化/u)
  })

  it('keeps the original-to-replacement relation and resolves explicitly', () => {
    const original = RecoveryCandidateRepository.record({
      runId: 'run-rewrite',
      stepId: 'generate-draft',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: '原始候选',
      failureCode: 'LENGTH_REPAIR_FAILED',
      failureReason: 'replacement failed',
    })
    const replacement = RecoveryCandidateRepository.record({
      runId: 'run-rewrite',
      stepId: 'length-repair',
      projectId: 'project-recovery',
      chapterNumber: 3,
      chapterTitle: source.title,
      source,
      sourceDraft: null,
      visibleText: '替代候选',
      failureCode: 'LENGTH_REPAIR_FAILED',
      failureReason: 'replacement failed',
      replacesCandidateId: original.candidateId,
    })

    expect(RecoveryCandidateRepository.listPending().map(candidate => ({
      candidateId: candidate.candidateId,
      replacesCandidateId: candidate.replacesCandidateId,
    }))).toEqual([
      { candidateId: original.candidateId, replacesCandidateId: null },
      { candidateId: replacement.candidateId, replacesCandidateId: original.candidateId },
    ])

    RecoveryCandidateRepository.resolve(original.candidateId, 'discarded')
    RecoveryCandidateRepository.resolve(replacement.candidateId, 'continued')

    expect(RecoveryCandidateRepository.listPending()).toEqual([])
  })
})
