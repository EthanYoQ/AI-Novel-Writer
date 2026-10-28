import { describe, expect, it } from 'vitest'
import {
  assignStageModel,
  parseStageModelIds,
  removeModelFromStages,
  routeStageModel,
  stageOfOperation,
  type GenerationOperation,
  type ModelRoutingState,
} from '../model-stage-routing'

const writer = { id: 'writer', purposes: ['generation'] }
const reviewer = { id: 'reviewer', purposes: ['generation'] }
const embedder = { id: 'embedder', purposes: ['embedding'] }

function state(overrides: Partial<ModelRoutingState> = {}): ModelRoutingState {
  return { models: [writer, reviewer, embedder], defaultModelId: 'writer', stageModelIds: {}, ...overrides }
}

describe('routeStageModel', () => {
  it('uses the default model for a stage with no assignment', () => {
    expect(routeStageModel('review', state())).toEqual({ stage: 'review', modelId: 'writer', source: 'default', staleAssignmentId: null })
  })

  it('uses the stage model when it is an available generation model', () => {
    expect(routeStageModel('review', state({ stageModelIds: { review: 'reviewer' } })))
      .toEqual({ stage: 'review', modelId: 'reviewer', source: 'stage', staleAssignmentId: null })
  })

  it('falls back to the default and reports the stale id when the assigned model was deleted', () => {
    expect(routeStageModel('review', state({ stageModelIds: { review: 'gone' } })))
      .toEqual({ stage: 'review', modelId: 'writer', source: 'default', staleAssignmentId: 'gone' })
  })

  it('never routes generation to an embedding-only model', () => {
    expect(routeStageModel('review', state({ stageModelIds: { review: 'embedder' } })))
      .toEqual({ stage: 'review', modelId: 'writer', source: 'default', staleAssignmentId: 'embedder' })
  })

  it('returns no model instead of picking the first one when the default is unusable too', () => {
    expect(routeStageModel('planning', state({ defaultModelId: 'gone', stageModelIds: { planning: 'embedder' } })))
      .toEqual({ stage: 'planning', modelId: null, source: 'none', staleAssignmentId: 'embedder' })
    expect(routeStageModel('planning', state({ defaultModelId: null })).modelId).toBeNull()
  })
})

describe('stageOfOperation', () => {
  it('maps operation families to their stage', () => {
    expect(stageOfOperation('generate-field:core-outline')).toBe('planning')
    expect(stageOfOperation('chapter-blueprint-directory')).toBe('planning')
    expect(stageOfOperation('chapter-draft')).toBe('drafting')
    expect(stageOfOperation('review-chapter')).toBe('review')
    expect(stageOfOperation('refine-from-review')).toBe('refinement')
    expect(stageOfOperation('finalized-character-state')).toBe('finalization')
  })

  it('throws for an operation that bypassed the type registry', () => {
    expect(() => stageOfOperation('made-up-operation' as GenerationOperation)).toThrow('MODEL_STAGE_UNREGISTERED')
    expect(() => stageOfOperation('toString' as GenerationOperation)).toThrow('MODEL_STAGE_UNREGISTERED')
  })
})

describe('stage mapping persistence helpers', () => {
  it('parses any stored shape into known stages with non-empty ids', () => {
    expect(parseStageModelIds(null)).toEqual({})
    expect(parseStageModelIds(['writer'])).toEqual({})
    expect(parseStageModelIds('writer')).toEqual({})
    expect(parseStageModelIds({ review: 'reviewer', drafting: '', planning: 7, unknown: 'writer', refinement: ' writer ' }))
      .toEqual({ review: 'reviewer', refinement: 'writer' })
  })

  it('removes a stage on null', () => {
    expect(assignStageModel({}, 'review', 'reviewer')).toEqual({ review: 'reviewer' })
    expect(assignStageModel({ review: 'reviewer', planning: 'writer' }, 'review', null)).toEqual({ planning: 'writer' })
    expect(assignStageModel({ review: 'reviewer' }, 'review', null)).toEqual({})
  })

  it('clears every stage that points at a deleted model', () => {
    expect(removeModelFromStages({ review: 'reviewer', refinement: 'reviewer', planning: 'writer' }, 'reviewer'))
      .toEqual({ next: { planning: 'writer' }, changed: true })
    expect(removeModelFromStages({ review: 'reviewer' }, 'reviewer')).toEqual({ next: {}, changed: true })
    expect(removeModelFromStages({ planning: 'writer' }, 'reviewer')).toEqual({ next: { planning: 'writer' }, changed: false })
  })
})
