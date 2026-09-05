import { afterEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  createChapterWorkflow,
  createFinalizeWorkflow,
  createRefineFromReviewWorkflow,
  createRefineOnlyWorkflow,
  createReviewOnlyWorkflow,
} from '../chapter-workflow'

const projectPath = 'C:\\novels\\english-chapter'
const projectSession: ProjectSessionContext = {
  projectId: 'english-chapter',
  leaseId: 'english-chapter-lease',
  projectPath,
}
const originalLocale = useLocaleStore.getState().locale

afterEach(() => useLocaleStore.setState({ locale: originalLocale }))

describe('chapter workflow locale', () => {
  it('freezes English titles, steps, descriptions, and completion copy for chapter workflows', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const workflows = [
      createChapterWorkflow({
        projectPath,
        chapterNumber: 2,
        title: 'A New Term',
        role: 'Development',
        purpose: 'Deepen the relationship',
        characters: ['Maya'],
        keyEvents: 'Maya joins the literature club.',
      }, projectSession),
      createReviewOnlyWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'vela://draft/2',
        draftContent: 'Draft',
      }, projectSession),
      createRefineOnlyWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'vela://draft/2',
        draftContent: 'Draft',
      }, projectSession),
      createRefineFromReviewWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'vela://draft/2',
        draftContent: 'Draft',
      }, projectSession),
      createFinalizeWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'vela://draft/2',
        draftContent: 'Draft',
      }, projectSession),
    ]

    expect(workflows.map(workflow => ({
      locale: workflow.uiLocale,
      title: workflow.title,
      step: workflow.steps[0].name,
      description: workflow.steps[0].description,
      completion: workflow.onComplete?.message,
    }))).toEqual([
      expect.objectContaining({ locale: 'en-US', title: 'Draft — Chapter 2 · A New Term', step: 'Draft chapter' }),
      expect.objectContaining({ locale: 'en-US', title: 'Review — Chapter 2 A New Term', step: 'Review chapter' }),
      expect.objectContaining({ locale: 'en-US', title: 'Revise — Chapter 2 A New Term', step: 'Revise draft' }),
      expect.objectContaining({ locale: 'en-US', title: 'Apply review — Chapter 2 A New Term', step: 'Revise from review' }),
      expect.objectContaining({ locale: 'en-US', title: 'Finalize — Chapter 2 A New Term', step: 'Finalize chapter' }),
    ])
    expect(workflows.flatMap(workflow => [
      workflow.title,
      workflow.steps[0].name,
      workflow.steps[0].description,
      workflow.onComplete?.message ?? '',
    ]).join('\n')).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})
