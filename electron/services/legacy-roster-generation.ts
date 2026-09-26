import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { LegacyRosterGenerationArtifact } from '../../src/shared/legacy-roster-generation'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { CharacterProposalService } from './character-proposal-service'
import { readLegacyRosterGenerationContext, legacyRosterGenerationTask } from './legacy-roster-generation-context'
import { readLegacyRosterGenerationProof } from './legacy-roster-generation-proof'

interface StoredLegacyProposal { version:1; artifact:LegacyRosterGenerationArtifact; contextHash:string; proposalBatchId:string; sourceHash:string }
export class LegacyRosterGeneration {
  constructor(private readonly db:Database.Database,private readonly runs:GenerationRunRepository,private readonly projectId:string,
    private readonly proposals:CharacterProposalService) {}
  require(handle:MainGenerationRunHandle):DurableGenerationRun {
    if (!handle || Object.keys(handle).some(key=>!['projectId','epoch','rootActionId','runId'].includes(key))) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    const run=this.runs.get(handle.runId),context=readLegacyRosterGenerationContext(run)
    if (handle.projectId!==this.projectId || run.binding.projectId!==this.projectId || handle.rootActionId!==run.rootActionId
      || handle.epoch!==context.originEpoch && handle.epoch!==run.binding.epoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    return run
  }
  private handle(run:DurableGenerationRun):MainGenerationRunHandle {return {projectId:this.projectId,epoch:run.binding.epoch,rootActionId:run.rootActionId,runId:run.runId}}
  task(run:DurableGenerationRun) {return legacyRosterGenerationTask(readLegacyRosterGenerationContext(run))}
  artifactFor(run:DurableGenerationRun):LegacyRosterGenerationArtifact|undefined {
    const row=this.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(run.runId) as {attempt_id:string}|undefined
    if (!row) return
    const artifact=this.runs.receipt(row.attempt_id).artifact
    if (!artifact) return
    const reference={artifactId:artifact.artifactId,revision:artifact.revision,textHash:artifact.textHash}
    try {readLegacyRosterGenerationProof(this.db,this.runs,this.projectId,{kind:'legacy-roster-generation',handle:this.handle(run),artifact:reference});return reference}
    catch {return undefined}
  }
  private saved(run:DurableGenerationRun):StoredLegacyProposal|undefined {
    const context=readLegacyRosterGenerationContext(run)
    const rows=this.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as {attempt_id:string;usage_receipt_json:string}[]
    let result:StoredLegacyProposal|undefined
    for (const row of rows) {
      const effect=JSON.parse(row.usage_receipt_json).legacyRosterProposal as StoredLegacyProposal|undefined
      if (effect===undefined) continue
      if (result || effect.version!==1 || effect.contextHash!==textHash(JSON.stringify(context))) throw new Error('GENERATION_LEGACY_EFFECT_INVALID')
      const proof=readLegacyRosterGenerationProof(this.db,this.runs,this.projectId,{kind:'legacy-roster-generation',handle:this.handle(run),artifact:effect.artifact})
      const batch=this.proposals.read(effect.proposalBatchId),evidence=this.proposals.evidence(effect.proposalBatchId)
      if (proof.attemptId!==row.attempt_id || effect.sourceHash!==proof.proof.sourceHash || evidence.sourceHash!==effect.sourceHash
        || !isDeepStrictEqual(batch.source,proof.source)) throw new Error('GENERATION_LEGACY_EFFECT_INVALID')
      result=effect
    }
    return result
  }
  proposal(run:DurableGenerationRun) {const effect=this.saved(run);return effect?this.proposals.read(effect.proposalBatchId):undefined}
  assertMutable(run:DurableGenerationRun) {
    if (run.binding.sourceManifest.legacyRosterContext && this.saved(run)) throw new Error('GENERATION_LEGACY_EFFECT_SEALED')
  }
  stage(handle:MainGenerationRunHandle,artifact:LegacyRosterGenerationArtifact,assertSources:(run:DurableGenerationRun)=>void) {
    return this.db.transaction(()=>{
      const run=this.require(handle),previous=this.saved(run)
      if (previous) {
        if (!isDeepStrictEqual(previous.artifact,artifact)) throw new Error('GENERATION_LEGACY_EFFECT_CONFLICT')
        return this.proposals.read(previous.proposalBatchId)
      }
      if (!isDeepStrictEqual(this.artifactFor(run),artifact)) throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
      const proof=readLegacyRosterGenerationProof(this.db,this.runs,this.projectId,{kind:'legacy-roster-generation',handle,artifact})
      assertSources(run)
      const batch=this.proposals.stage(proof.source)
      const effect:StoredLegacyProposal={version:1,artifact:structuredClone(artifact),contextHash:textHash(JSON.stringify(proof.context)),proposalBatchId:batch.proposalBatchId,sourceHash:proof.proof.sourceHash}
      const usage=JSON.parse(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(proof.attemptId) as string)
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({...usage,legacyRosterProposal:effect}),proof.attemptId)
      return batch
    }).immediate()
  }
}
