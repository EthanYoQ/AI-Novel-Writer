import { createHash } from 'node:crypto'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import type { CharacterProposalBatch, CharacterProposalSource } from '../../../../shared/character-proposal'

import { parseArchitectureCharacterProposal, parsePlanningMaterialCharacterProposal, parseMaterialExtraction } from '../../../../shared/character-proposal-parser'

export const proposalFixtureArtifacts = new Map<string, string>()
/** Test-only adapter: expose the durable identity contract on deterministic stream doubles. */
export function proposalRuntimeFixture(base = workflowRuntimeDependencies): WorkflowGenerationRuntimeDependencies {
  return { async createRuntime(options, main) {
    const runtime = await base.createRuntime(options, main)
    if (!main) return runtime
    const context = main.context
    const handle = { projectId: context.projectSession!.projectId, epoch: context.projectSession!.leaseId,
      rootActionId: `root:${context.runId}`, runId: `generation:${context.runId}` }
    context.mainGenerationRunHandle = handle
    await main.selection.onRunOpened?.(handle)
    return { ...runtime, async execute(operation) {
      return runtime.execute(({ session }) => operation({ session: {
        ...session, budget: session.budget,
        async complete(task, executionOptions) {
          const outcome = await session.complete(task, executionOptions)
          const artifactId = `fixture-artifact-${proposalFixtureArtifacts.size + 1}`
          proposalFixtureArtifacts.set(artifactId, outcome.content)
          outcome.receipt.visibleArtifact = { artifactId, attemptId: artifactId, revision: 1,
            textHash: createHash('sha256').update(outcome.content).digest('hex') }
          return outcome
        },
      } }))
    } }
  } }
}
export function proposalBatchFixture(source: CharacterProposalSource): CharacterProposalBatch {
  if (source.kind !== 'generation') throw new Error('FIXTURE_GENERATION_SOURCE_REQUIRED')
  const artifacts = source.artifacts.map(artifact => {
    const text = proposalFixtureArtifacts.get(artifact.artifactId)
    if (!text) throw new Error('FIXTURE_ARTIFACT_MISSING')
    return { artifactId: artifact.artifactId, text }
  })
  const items = source.inputKind === 'architecture'
    ? parseArchitectureCharacterProposal({ manifest: artifacts.find(item => item.artifactId === source.manifestArtifactId)!,
      details: artifacts.filter(item => item.artifactId !== source.manifestArtifactId) })
    : parsePlanningMaterialCharacterProposal({ artifacts,
      expectedSourceIds: artifacts.flatMap(item => parseMaterialExtraction(item.text).map(result => result.sourceId)) })
  return { proposalBatchId: 'fixture-proposals', revision: 0, status: 'pending-approval', source,
    items: items.map(item => ({ ...item, resolution: { status: 'unresolved', candidateIds: [] } })) }
}
