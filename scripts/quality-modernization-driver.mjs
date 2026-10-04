import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { buildSync } from 'esbuild'
import { reconcileDispatchedAttempts } from './quality-modernization-run.mjs'
import { countProjectedDraftUnits, isExpectedReferenceEvidenceFailure, isVerifiedDirectPersistedDraftEvidence, isVerifiedRecoverySupplementEvidence,
  readVerifiedDirectPersistedDraftEvidence, readVerifiedRecoveryCandidateSupplement, targetUnitRange } from './quality-modernization-receipt.mjs'

const ADAPTER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The gate and post-run check use the same production parser as ReviewChapterCommand.
const reviewParserBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/review-generation-report.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { parseReviewGenerationResult, buildReviewGenerationReport } = await import(`data:text/javascript;base64,${Buffer.from(reviewParserBundle).toString('base64')}`)
// 压缩稿（此后被审；未修稿时即保存的正文）由主进程按同一份生产清洗从末次压缩原文组合（generation-run-repository 的 draft-visible-v1 组合）。
const draftVisibleBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/draft-visible-text.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { sanitizeDraftText, stripDraftThinkingTags, composeDraftVisibleContinuation } = await import(`data:text/javascript;base64,${Buffer.from(draftVisibleBundle).toString('base64')}`)
const appendBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/visible-continuation.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { composeVisibleContinuation } = await import(`data:text/javascript;base64,${Buffer.from(appendBundle).toString('base64')}`)
const blueprintBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/blueprint-semantic-contract.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { parseBlueprintSemanticResponseText } = await import(`data:text/javascript;base64,${Buffer.from(blueprintBundle).toString('base64')}`)
const costBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/services/workflows/blueprint-batch-policy.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const syntaxBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/services/workflows/structured-syntax-repair.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { preservesStructuredJsonEvidence } = await import(`data:text/javascript;base64,${Buffer.from(syntaxBundle).toString('base64')}`)
const { planBlueprintGenerationCost } = await import(`data:text/javascript;base64,${Buffer.from(costBundle).toString('base64')}`)
const policyBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'electron/services/main-generation-plan.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { MAIN_GENERATION_POLICY, newMainGenerationPolicy } = await import(`data:text/javascript;base64,${Buffer.from(policyBundle).toString('base64')}`)
const outlineBundle = buildSync({ entryPoints: [path.join(ADAPTER_ROOT, 'src/shared/plot-outline-contract.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text
const { PLOT_OUTLINE_PROTOCOL, PLOT_OUTLINE_CONTENT, DEFAULT_PLANNING_ACTION_CHAPTERS, DEFAULT_PLANNING_TARGET_UNITS,
  derivePlotOutlineCursor, joinPlotOutlineEntries, renderPlotOutlineSynopsis } = await import(`data:text/javascript;base64,${Buffer.from(outlineBundle).toString('base64')}`)
export const PRODUCTION_BRIDGE = 'scripts/fixtures/quality-modernization-production.fixture.mjs'
export const EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION = 's11-reference-no-actionable-review-v1'
export const REVIEWED_DRAFT_PROTOCOL_REVISION = 's14b-reviewed-draft-v1'
export const SPLIT_QUALITY_GATES_PROTOCOL_REVISION = 's14b-split-quality-gates-v1'
export const AI_REVIEW_FINAL_MANUSCRIPT_POLICY = Object.freeze({
  revision: 'ai-review-final-manuscript-v1',
  caseIds: ['C17-A', 'C17-B', 'C18-A', 'C18-B'],
  selection: 'formal-raw-ai-error-warning-and-valid-keyEvents-mustShow-unknown',
  softwareFindings: 'separate-frozen-consistency-preflight-provenance',
  confirmation: 'preauthorized-ai-only-persisted-original-items-with-native-findingIds',
  noAction: 'first-draft-endpoint-with-original-raw-and-saved-review',
  endpoint: 'native-merge-then-ordinary-full-review',
  automaticCeiling: 'pending-independent-oracle-review',
  physicalRequests: { sourceMinimum: 12, sourceMaximum: 48, manuscriptMinimum: 1,
    manuscriptMaximum: 8, minimum: 16, maximum: 80 },
})
export const R3_NATIVE_REVISION_DIAGNOSTIC = Object.freeze({
  "caseId": "R3",
  "caseIds": ["R3"],
  "sceneId": "场景1",
  "chapterNumber": 2,
  "milestone": "diagnostic",
  "arms": ["candidate"],
  "nonQualification": true,
  "scenarioRevision": "r3-native-official-flash-three-runs-v9",
  "minPhysicalRequests": 3,
  "maxPhysicalRequests": 8,
  "model": {"id":"7935a372-b853-4408-9374-9fdb272a78f9","name":"R3 official DeepSeek Flash native diagnostic","provider":"deepseek","protocol":"openai","modelName":"deepseek-flash","baseUrl":"https://api.deepseek.com","temperature":0,"maxTokens":16384,"purposes":["generation","refinement","summary"],"reasoningOverride":"high","capabilities":{"contextWindowTokens":1048576,"maxOutputTokens":393216,"reasoning":true,"structuredOutput":true,"usage":true},"capabilitySources":{"contextWindowTokens":"endpoint","maxOutputTokens":"endpoint","reasoning":"manual","structuredOutput":"manual","usage":"manual"},"reasoningMapping":{"adapter":"deepseek-v4-thinking","supportedEfforts":["off","low","high","max"],"providerValues":{"off":"disabled","low":"low","high":"high","max":"max"},"requestAliases":{"medium":"high"}}},
  "source": {"projectId":"efc9b59a-a9f8-4223-8c1c-add48b21d579","epoch":"86ef0216-7c47-4eed-b51f-3449aef0ca68","contentSha256":"7f35eabd2fcb65677bc7505c143255ee5aa36f0e664390879604d3091723efd4","contextSha256":"4cb5a188693d3293afa96f9d99c59c595c37ef48029d1afa1945d1b8a60a2a0b","exportManifestSha256":"1714681b52c97b16bd4405289184d13b9fab8a9ee8018e9b1176f35667896fb2","packetManifestSha256":"00517e3921cb6ffa1b6703b029e61c24fccd7cbd7ed1502d5ef8489bbd5e3877","assets":[{"path":".ai-novel/project.json","sha256":"2b5ad3984308abcc3a1c25177c52505f2360d69a2371d5bf82aa9fe0f756436b"},{"path":".ai-novel/portable-runtime-freeze.json","sha256":"108071a42d343cf145cd37f0fb2047f84fa8066886694157227ba88eb519de91"}]},
  "operations": [{"id":"R3普通首审","kind":"review"},{"id":"R3一次修稿","kind":"refine"},{"id":"R3普通末审","kind":"final-review"}],
  "attemptPolicy": {"milestone":"diagnostic","arms":["candidate"],"reviewRebuild":{"operationId":"R3普通首审","primaryPurpose":"review-chapter","repairPurpose":"review-chapter-rebuild","maxRepairAttempts":1,"maxLengthReplacements":1},"finalReviewRebuild":{"operationId":"R3普通末审","primaryPurpose":"review-chapter","repairPurpose":"review-chapter-rebuild","maxRepairAttempts":1,"maxLengthReplacements":1},"refinementRecovery":{"operationId":"R3一次修稿","purpose":"refine-from-review","maxAttempts":4,"trigger":"settled-length-same-confirmation-visible-append-with-progress"}},
  "evaluationPolicy": {"revision":"ai-review-final-manuscript-v1","caseIds":["R3"],"selection":"formal-raw-ai-error-warning-and-valid-keyEvents-mustShow-unknown","softwareFindings":"separate-frozen-consistency-preflight-provenance","confirmation":"preauthorized-ai-only-persisted-original-items-with-native-findingIds","noAction":"first-draft-endpoint-with-original-raw-and-saved-review","endpoint":"native-merge-then-ordinary-full-review","automaticCeiling":"pending-independent-oracle-review","physicalRequests":{"minimum":3,"maximum":8,"manuscriptMinimum":1,"manuscriptMaximum":8}},
  "closedInvocations": ["d12c4111-285e-41a7-8bcc-4b7f9afd0681","5d9f3a04-7111-4151-9323-55ec2d1141a6","2b5963de-23b3-4e5c-8c16-8997fa021aa0","6869a6a8-6bf4-4608-a7a1-d8fb67a9a469","ed4d076b-aa3f-40d6-8991-ce7df3915cf8","5331273c-d6f5-4019-82ce-15261ee03abb","352c14db-202f-4158-a295-dd8a68a21227","f4957c39-0be7-4d42-8492-b8f72fd20b95","5fc84331-ffc9-4b32-941c-5d11e1178bc5","9e1d7e92-ba12-48f9-bf57-e469b349bf6a","abb5c15a-e030-4a12-85d2-4416da1fedff","f4299c56-60a9-4911-b441-e6909c06abb0","fbbb909d-f2f6-449e-8af1-bbbc82d8bb20","a0ab647c-d914-4734-a704-4522da47807c","12baea73-3050-4f3e-b5a9-b4cae7abc179","e111a7c1-232d-40ae-8756-652314995816","820ab4bf-be8f-468f-b8b9-293dc444e10a","66ac671a-2481-4917-8272-6a2aeef62738","a3a8a3fe-7393-4260-8601-ef365f511872","07433184-dc4a-400d-9324-d331e0ddae60","73b0ca6a-a5bd-4493-a7b2-1e01d5eee005","580bf981-88fc-4020-bc83-f85b0150a1ef","c6a4ef7d-9dfb-4ec1-9913-fe2f8eca5036","b9bbf64e-86b4-4804-8f09-7db161ce6517"],
  "requiredProductSha": "69ed2a2f23699320a4758ce6e10ac893b2a84977",
  "profiles": {"flash":{"profileId":"7935a372-b853-4408-9374-9fdb272a78f9","configurationHash":"0eec6083f152f15548e9acf680803e79365d1d76a4763f2b1c58529451a244df","model":{"id":"7935a372-b853-4408-9374-9fdb272a78f9","name":"R3 official DeepSeek Flash native diagnostic","provider":"deepseek","protocol":"openai","modelName":"deepseek-flash","baseUrl":"https://api.deepseek.com","temperature":0,"maxTokens":16384,"purposes":["generation","refinement","summary"],"reasoningOverride":"high","capabilities":{"contextWindowTokens":1048576,"maxOutputTokens":393216,"reasoning":true,"structuredOutput":true,"usage":true},"capabilitySources":{"contextWindowTokens":"endpoint","maxOutputTokens":"endpoint","reasoning":"manual","structuredOutput":"manual","usage":"manual"},"reasoningMapping":{"adapter":"deepseek-v4-thinking","supportedEfforts":["off","low","high","max"],"providerValues":{"off":"disabled","low":"low","high":"high","max":"max"},"requestAliases":{"medium":"high"}}}}},
  "operationProfiles": {"R3普通首审":"flash","R3一次修稿":"flash","R3普通末审":"flash"},
  "runs": [{"run":1,"invocationId":"580bf981-88fc-4020-bc83-f85b0150a1ef"},{"run":2,"invocationId":"c6a4ef7d-9dfb-4ec1-9913-fe2f8eca5036"},{"run":3,"invocationId":"b9bbf64e-86b4-4804-8f09-7db161ce6517"}],
  "maxTotalPhysicalRequests": 24,
  "acceptance": {"minimumCompletedLoops":2,"maximumUnsupportedTimeChanges":0,"denominator":3,"automaticCeiling":"pending-independent-oracle-review","semanticRule":"delivery-plan-section-3-forward-2026-10-03","unsupportedTime":"forbid-asserted-fact-mandatory-fix-actual-revision-or-trusted-derivation","unadoptedWrongAlternative":{"allRequired":["autonomous-correct-localization","not-author-fact-or-mandatory-fix","complete-original-evidence-received","autonomous-rejection-by-revision","valid-final-manuscript-full-review-save-readback"],"retain":"first-review-quality-defect","exclude":"human-edited-opinions-replacement-answer-or-false-finding-closure"},"stop":"when-two-of-three-impossible-remaining-NOT_RUN-no-redraw","scope":"new-group-only-no-historical-reclassification-or-section-5-waiver","runtime":"existing-node-product-owner-commands-sqlite-not-electron-ui"},
})

export function r3DiagnosticInvocation(run) {
  const slot = R3_NATIVE_REVISION_DIAGNOSTIC.runs.find(item => String(item.run) === String(run))
  if (!slot) throw new Error('R3_NATIVE_RUN_NOT_REGISTERED')
  return slot.invocationId
}

export function r3ModelForOperation(operationId) {
  const profile = R3_NATIVE_REVISION_DIAGNOSTIC.profiles[R3_NATIVE_REVISION_DIAGNOSTIC.operationProfiles[operationId]]
  if (!profile) throw new Error('R3_NATIVE_OPERATION_MODEL_MISSING')
  return profile
}

// Forward qualification only. Historical Pro and R3 registrations retain their own identities.
export const QUALIFICATION_STAGE_MODELS = Object.freeze({
  revision: 'candidate-single-official-flash-cap32-v3',
  requiredProductSha: '8c1e74ae096863809a3821cddf5bf81e984823a9',
  scopes: [{ phase: 'c16-c18', milestone: 'final' }, { phase: 'full', milestone: 'final' },
    ...['early-budget', 'early-context', 'early-review'].map(phase => ({ phase, milestone: 'post-ui' }))],
  profiles: {
    flash: { profileId: '7935a372-b853-4408-9374-9fdb272a78f9',
      configurationHash: '9a36c2c26b83a0e2e4b3ab1bc0f998a366140c0a3bb91c8444699dd88e31ba44',
      model: {id: '7935a372-b853-4408-9374-9fdb272a78f9',name: 'R3 official DeepSeek Flash native diagnostic',provider: 'deepseek',protocol: 'openai',modelName: 'deepseek-flash',baseUrl: 'https://api.deepseek.com',temperature: 0,maxTokens: 32768,purposes: ['generation','refinement','summary'],reasoningOverride: 'high',capabilities: {contextWindowTokens: 1048576,maxOutputTokens: 393216,reasoning: true,structuredOutput: true,usage: true},capabilitySources: {contextWindowTokens: 'endpoint',maxOutputTokens: 'endpoint',reasoning: 'manual',structuredOutput: 'manual',usage: 'manual'},reasoningMapping: {adapter: 'deepseek-v4-thinking',supportedEfforts: ['off','low','high','max'],providerValues: {off: 'disabled',low: 'low',high: 'high',max: 'max'},requestAliases: {medium: 'high'}}} },
  },
  operationKinds: { directory: 'flash', draft: 'flash', chapter_notes: 'flash', character_cards: 'flash',
    review: 'flash', refine: 'flash', 'final-review': 'flash' },
})

export function qualificationModelForOperation(phase, milestone, operationId) {
  if (!QUALIFICATION_STAGE_MODELS.scopes.some(scope => scope.phase === phase && scope.milestone === milestone))
    throw new Error('QUALIFICATION_MODEL_SCOPE_MISMATCH')
  if (operationId === undefined) return QUALIFICATION_STAGE_MODELS.profiles.flash
  const kind = productionScenario(phase, milestone, CANDIDATE_ONLY_PROTOCOL_REVISION).operations.find(item => item.id === operationId)?.kind
  const profile = QUALIFICATION_STAGE_MODELS.profiles[QUALIFICATION_STAGE_MODELS.operationKinds[kind]]
  if (!profile) throw new Error('QUALIFICATION_OPERATION_MODEL_MISSING')
  return profile
}

export const SAVED_NATIVE_REVIEW_DIAGNOSTIC = Object.freeze({
  sceneId: '场景1', chapterNumber: 2, milestone: 'diagnostic', arms: ['candidate'], nonQualification: true,
  scenarioRevision: 'saved-native-review-two-cases-v1', formalDenominatorContribution: 0,
  expectedPhysicalRequests: 4, maxPhysicalRequests: 16,
  diagnosticInputHash: '0d1ceb6e9c24e612e5fb035e62bc293eb5b971aa64b97fa46d3178b5f6436041',
  caseIds: ['saved-c18-b-negative', 'saved-c17-a-control'],
  sources: [
    { caseId: 'saved-c18-b-negative', provenance: 'C18-B', invocationId: 'eb8a6d91-a23d-4f57-94ac-b07f8dc04d32',
      projectId: '607d093c-f681-4edc-a391-32624e39502d', epoch: '73236077-1daf-4089-8082-e8cf95c9e9d8',
      contentSha256: '4f0b7930b9c56a2520f5de1b12ab46d29ac4284932d6783b66c6b6d85f775a11' },
    { caseId: 'saved-c17-a-control', provenance: 'C17-A', invocationId: '284aa0cc-ae44-43a8-86d0-a7c7e403c8fb',
      projectId: '00c718a0-851d-43bf-8d66-a145210072ac', epoch: '70ffe6fb-ced1-43fb-9d4f-0faae3aa72b5',
      contentSha256: '80429e53ab637acddb37ea054a034998251e9306df4dac74c4dd71c79fa607e2' },
  ],
  operations: [
    { id: 'negative-review', kind: 'review', caseIds: ['saved-c18-b-negative'] },
    { id: 'negative-refine', kind: 'refine', caseIds: ['saved-c18-b-negative'] },
    { id: 'negative-final-review', kind: 'final-review', caseIds: ['saved-c18-b-negative'] },
    { id: 'control-review', kind: 'review', caseIds: ['saved-c17-a-control'] },
  ],
  attemptPolicy: { milestone: 'diagnostic', arms: ['candidate'],
    reviewRebuild: { operationId: 'negative-review', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1, maxLengthReplacements: 1 },
    finalReviewRebuild: { operationId: 'negative-final-review', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1, maxLengthReplacements: 1 },
    controlReviewRebuild: { operationId: 'control-review', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1, maxLengthReplacements: 1 },
    refinementRecovery: { operationId: 'negative-refine', purpose: 'refine-from-review', maxAttempts: 4, trigger: 'settled-length-same-confirmation-visible-append-with-progress' } },
  evaluationPolicy: { ...AI_REVIEW_FINAL_MANUSCRIPT_POLICY, caseIds: ['saved-c18-b-negative', 'saved-c17-a-control'],
    confirmation: 'agent-semantic-approval-references-original-report-and-native-findings',
    physicalRequests: { minimum: 1, maximum: 16, manuscriptMinimum: 1, manuscriptMaximum: 12 } },
  modelProfile: QUALIFICATION_STAGE_MODELS.profiles.flash,
  stop: 'negative-detection-or-closure-or-technical-failure-ends-check-control-NOT_RUN',
})

export function savedNativeOperations(caseId, action) {
  const policy = SAVED_NATIVE_REVIEW_DIAGNOSTIC
  if (!policy.caseIds.includes(caseId) || !['prepare', 'review', 'complete'].includes(action)
    || action === 'complete' && caseId !== policy.caseIds[0]) throw new Error('SAVED_NATIVE_SCOPE_MISMATCH')
  return policy.operations.filter(item => item.caseIds.includes(caseId)
    && (action === 'complete' ? item.kind !== 'review' : item.kind === 'review'))
}

export function planningNativeOperations(caseId, action, bridgeAction) {
  const policy = PLANNING_NATIVE_DIAGNOSTIC
  if (caseId !== policy.caseId || !['prepare', 'review', 'complete', 'resume-from-saved-outline'].includes(action)) throw new Error('PLANNING_NATIVE_SCOPE_MISMATCH')
  if (bridgeAction === 'resume-preflight') {
    if (action !== 'resume-from-saved-outline') throw new Error('PLANNING_NATIVE_SCOPE_MISMATCH')
    return []
  }
  if (action === 'resume-from-saved-outline') return policy.operations.filter(item => ['directory', 'draft', 'review'].includes(item.kind))
  return policy.operations.filter(item => action === 'complete' ? ['refine', 'final-review'].includes(item.kind)
    : !['refine', 'final-review'].includes(item.kind))
}

export function readPlanningResumeSource(file) {
  const bytes = fs.readFileSync(file), registration = PLANNING_NATIVE_DIAGNOSTIC.savedOutlineContinuation
  if (digest(bytes) !== registration.manifestHash) throw new Error('PLANNING_RESUME_MANIFEST_DRIFT')
  const manifest = JSON.parse(bytes)
  const evidence = Object.fromEntries(Object.entries(manifest.references).map(([key, reference]) => {
    const content = fs.readFileSync(reference.path)
    if (digest(content) !== reference.sha256) throw new Error('PLANNING_RESUME_SOURCE_DRIFT')
    return [key, JSON.parse(content)]
  }))
  const { baseTargets, execution, preparation, failedReview, templates, planningSource, physicalProject } = evidence
  const base = baseTargets.candidate, runtime = execution.target, policy = PLANNING_NATIVE_DIAGNOSTIC
  const artifact = failedReview.recovery?.artifacts?.find(item => item.artifactId === manifest.sixthArtifact.artifactId)
  if (manifest.continuationId !== registration.continuationId || manifest.invocationId !== policy.invocationId
    || manifest.caseId !== policy.caseId || manifest.sourceHash !== registration.sourceHash
    || manifest.project.projectId !== registration.projectId || digest(manifest.attempts) !== digest(registration.attempts)
    || baseTargets.baseline || digest(base) !== execution.targetHash || base.codeSha !== manifest.sourceSha
    || base.sourceHash !== manifest.sourceHash || templates.sourceSha !== manifest.sourceSha || templates.sourceArm !== 'candidate'
    || preparation.status !== 'prepared' || failedReview.status !== 'failed'
    || preparation.physicalProject.projectId !== manifest.project.projectId || physicalProject.projectId !== manifest.project.projectId
    || path.resolve(physicalProject.rootPath) !== path.resolve(manifest.project.path)
    || failedReview.projectEpoch !== manifest.project.epoch || digest(planningSource.roster) !== manifest.project.rosterHash
    || digest(failedReview.savedEvidence.core.synopsis) !== manifest.synopsisHash
    || artifact?.attemptId !== manifest.sixthArtifact.attemptId || digest(artifact?.text ?? '') !== manifest.sixthArtifact.textHash
    || execution.ledgerPath !== manifest.ledger.path) throw new Error('PLANNING_RESUME_SOURCE_MISMATCH')
  const roots = Object.fromEntries(Object.entries(base.roots).map(([key, directory]) => [key, path.join(directory, policy.invocationId.slice(0, 8))]))
  if (digest(runtime.roots) !== digest(roots) || runtime.isolationRoot !== path.join(base.isolationRoot, 'invocations', policy.invocationId)
    || digest(runtime.declaredRoots) !== digest(base.roots) || runtime.declaredIsolationRoot !== base.isolationRoot)
    throw new Error('PLANNING_RESUME_ROOTS_MISMATCH')
  const raw = fs.readFileSync(manifest.ledger.path, 'utf8'), lines = raw.split('\n')
  if (lines.length <= manifest.ledger.eventCount || digest(lines.slice(0, manifest.ledger.eventCount).join('\n') + '\n') !== manifest.ledger.rawBytesSha256)
    throw new Error('PLANNING_RESUME_LEDGER_DRIFT')
  return { manifest, ...evidence, manifestHash: registration.manifestHash }
}

export function planningResumeTarget(base, source) {
  if (base.sourceHash !== source.manifest.sourceHash
    || ['roots', 'isolationRoot', 'fixture', 'stageModels', 'modelId'].some(key => digest(base[key]) !== digest(source.baseTargets.candidate[key])))
    throw new Error('PLANNING_RESUME_TARGET_DRIFT')
  return { ...base, isolationRoot: source.execution.target.isolationRoot, roots: source.execution.target.roots,
    declaredIsolationRoot: base.isolationRoot, declaredRoots: base.roots }
}

export function planningSavedOutlineAttempts(binding, prior, statuses) {
  if (!binding.savedOutlineContinuation) return new Set()
  const registration = PLANNING_NATIVE_DIAGNOSTIC.savedOutlineContinuation
  if (stableEvidence(binding.savedOutlineContinuation) !== stableEvidence({ continuationId: registration.continuationId, manifestHash: registration.manifestHash })
    || binding.sourceHash !== registration.sourceHash || binding.actual.projectId !== registration.projectId
    || PLANNING_NATIVE_DIAGNOSTIC.operations.find(item => item.id === binding.operation)?.kind === 'outline'
    || registration.attempts.some(item => {
      const row = prior.find(value => value.attemptId === item.attemptId)
      return !row || digest(row.binding) !== item.bindingHash || statuses.get(item.attemptId) !== item.terminal
    })) throw new Error('PLANNING_RESUME_PREFIX_MISMATCH')
  return new Set(registration.attempts.map(item => item.attemptId))
}

export function readPlanningNativeSource(inputPath) {
  const bytes = fs.readFileSync(inputPath), policy = PLANNING_NATIVE_DIAGNOSTIC
  if (digest(bytes) !== policy.diagnosticInputHash) throw new Error('PLANNING_NATIVE_INPUT_DRIFT')
  const input = JSON.parse(bytes), values = {}
  for (const [key, entry] of Object.entries(policy.sources)) {
    const content = fs.readFileSync(path.join(path.dirname(inputPath), entry.name))
    if (digest(content) !== entry.sha256) throw new Error('PLANNING_NATIVE_SOURCE_DRIFT')
    values[key] = key === 'rows' ? JSON.parse(content) : content.toString('utf8')
  }
  if (input.totalChapters !== policy.totalChapters || input.wordsPerChapter !== policy.wordsPerChapter
    || stableEvidence(input.sources) !== stableEvidence(policy.sources)) throw new Error('PLANNING_NATIVE_SOURCE_MISMATCH')
  if (!Array.isArray(values.rows.core) || values.rows.core.length !== 1) throw new Error('PLANNING_NATIVE_SOURCE_CORE_MISMATCH')
  const core = values.rows.core[0]
  for (const [key, field] of [['premise', 'premise'], ['characters', 'characters_arch'], ['worldbuilding', 'worldbuilding']])
    if (values[key] !== core[field]) throw new Error('PLANNING_NATIVE_TEXT_SOURCE_MISMATCH')
  return { ...values, rows: { ...values.rows, core }, inputHash: digest(bytes), sourceHash: digest(policy.sources) }
}

export function readSavedNativeSource(inputPath, caseId) {
  const bytes = fs.readFileSync(inputPath), policy = SAVED_NATIVE_REVIEW_DIAGNOSTIC
  if (digest(bytes) !== policy.diagnosticInputHash) throw new Error('SAVED_NATIVE_INPUT_DRIFT')
  const input = JSON.parse(bytes), entry = input.cases.find(item => item.caseId === caseId)
  const source = policy.sources.find(item => item.caseId === caseId)
  if (!entry || !source) throw new Error('SAVED_NATIVE_CASE_MISMATCH')
  const read = (file, expected) => {
    const data = fs.readFileSync(file)
    if (digest(data) !== expected) throw new Error('SAVED_NATIVE_SOURCE_DRIFT')
    return data
  }
  const files = fs.readdirSync(entry.projectRoot, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => path.relative(entry.projectRoot, path.join(item.parentPath, item.name)).replaceAll('\\', '/')).sort()
  if (stableEvidence(files) !== stableEvidence(entry.files.map(item => item.path).sort())) throw new Error('SAVED_NATIVE_MANIFEST_DRIFT')
  const assets = entry.files.map(item => ({ ...item, bytes: read(path.join(entry.projectRoot, item.path), item.sha256) }))
  if (digest(read(entry.draftPath, entry.draftHash)) !== source.contentSha256
    || digest(entry.context.source.content) !== source.contentSha256) throw new Error('SAVED_NATIVE_SOURCE_DRIFT')
  return { inputHash: digest(bytes), source, context: entry.context, draft: entry.context.source, assets, packetFiles: [],
    original: JSON.parse(read(entry.originalReceipt, entry.originalReceiptHash)) }
}

// Only shape and standard terminal enums; never provider text, IDs or reasoning.
export function streamEventStructure(event) {
  const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const choice = event?.choices?.[0]
  const finish = choice?.finish_reason
  return { choicesType: type(event?.choices), choicesCount: Array.isArray(event?.choices) ? event.choices.length : null,
    finishType: type(finish), finish: ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'error', 'network_error'].includes(finish) ? finish : null,
    contentType: type(choice?.delta?.content), reasoningType: type(choice?.delta?.reasoning_content),
    usageType: type(event?.usage), errorType: type(event?.error) }
}

// Fixed historical input is read as bytes. Only a copied donor may be opened by SQLite.
export function readR3NativeSource(inputPath) {
  const policy = R3_NATIVE_REVISION_DIAGNOSTIC.source
  const read = (file, expected) => {
    const info = fs.lstatSync(file), bytes = fs.readFileSync(file)
    if (!info.isFile() || info.isSymbolicLink() || path.resolve(file) !== fs.realpathSync.native(file)
      || digest(bytes) !== expected) throw new Error('R3_NATIVE_SOURCE_DRIFT')
    return bytes
  }
  const contextBytes = read(inputPath, policy.contextSha256), context = JSON.parse(contextBytes)
  const exported = JSON.parse(read(path.join(path.dirname(inputPath), 'manifest.json'), policy.exportManifestSha256))
  const entry = exported.cases.find(item => item.id === 'R3')
  if (entry.context.sha256 !== policy.contextSha256 || digest(context.source.content) !== policy.contentSha256)
    throw new Error('R3_NATIVE_SOURCE_DRIFT')
  const packetRoot = path.dirname(path.dirname(entry.sourcePacket.path))
  read(entry.sourcePacket.path, entry.sourcePacket.sha256)
  const manifest = JSON.parse(read(path.join(packetRoot, 'manifest.json'), policy.packetManifestSha256))
  const stdout = JSON.parse(read(manifest.inputs.stdout.path, manifest.inputs.stdout.sha256))
  const original = stdout.results.find(item => item.caseId === 'C17-A')
  if (original.physicalProject.projectId !== policy.projectId || original.projectEpoch !== policy.epoch)
    throw new Error('R3_NATIVE_SOURCE_DRIFT')
  const copy = manifest.dbCopies.find(item => path.resolve(item.copy) === path.resolve(packetRoot, 'db-copies/C17-A/project.db'))
  const packetFiles = [{ name: 'project.db', bytes: read(copy.copy, copy.copiedSha256) },
    ...['-wal', '-shm'].map(suffix => ({ name: 'project.db' + suffix,
      bytes: read(copy.copy + suffix, copy.sourceFiles[suffix].sha256) }))]
  const assets = policy.assets.map(item => ({ ...item, bytes: read(path.join(original.physicalProject.path, item.path), item.sha256) }))
  return { inputHash: digest(contextBytes), context, draft: context.source, original, packetFiles, assets }
}

export const BOUNDED_REVISION_DIAGNOSTIC = Object.freeze({
  "caseId": "C17-A",
  "caseIds": [
    "C17-A"
  ],
  "sceneId": "场景1",
  "chapterNumber": 2,
  "milestone": "diagnostic",
  "arms": [
    "candidate"
  ],
  "nonQualification": true,
  "scenarioRevision": "c17-a-saved-bounded-revision-diagnostic-v1",
  "minPhysicalRequests": 3,
  "maxPhysicalRequests": 5,
  "actualMaxTokens": 16384,
  "source": {
    "invocationId": "a763f510-eac5-4368-967e-0abb630ff597",
    "testedSha": "889b5e23e57daa763c4e549e892afaa69d1da73c",
    "sourceHash": "b7bb85c2b1a8aadf0ef314fb5de06c50a1b4d2fabb60f1339ece977922f43083",
    "protocolHash": "9de2619fd8a998b626545c81368f57456a44dda7db854222489bd4dfce2d36a9",
    "manifestSha256": "24912361161361695647811c0ad4acccb6fcf1830985feca72a5b0afeefed3ec",
    "stdoutSha256": "60ac4a9bba19cf81bce03121b4939693c278da5b7f5bf9c804b7aabf5e328270",
    "semanticSha256": "defce5375fcbf5139219678b00006497bb826a7946c706c0e040e04e79a3f6dd",
    "caseDocumentSha256": "9fabbea09392e518f7dfca41bf0f879fb9bb6675a798b4d6ccadc754a39f7470",
    "projectId": "1db3c882-c2a3-4982-b428-ab7e3c6c7cca",
    "epoch": "abad0c94-6230-4be6-9b3c-12309367c81e",
    "draftId": 4,
    "chapterNumber": 2,
    "version": 1,
    "status": "draft",
    "contentSha256": "c8b29e929e34b57e7af41aae94cbc0f4c027eab21c0cfd4daf08a2501b21da66",
    "byteSize": 3889,
    "units": 1053,
    "packetFiles": [
      {
        "name": "project.db",
        "sha256": "29894f46a48e17d8967ad327e00015177d5f1c2e38841b980194ea1d932bb7fe",
        "bytes": 684032
      },
      {
        "name": "project.db-wal",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "bytes": 0
      },
      {
        "name": "project.db-shm",
        "sha256": "fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb",
        "bytes": 32768
      }
    ],
    "assets": [
      {
        "path": ".ai-novel/project.json",
        "sha256": "bd8db2b455b2a680b902ca0f39ba18b52e610babe8339a6cea106c2321342673",
        "bytes": 207
      },
      {
        "path": ".ai-novel/portable-runtime-freeze.json",
        "sha256": "a733557b80c14be843d4754a0abbfc231da8c07fee00cac6354a5116e5e7eff6",
        "bytes": 30282
      },
      {
        "path": ".ai-novel/portable-transfer-authority.json",
        "sha256": "0b96934e1c18d67c539d6a0b5522e248bcd3899d955859ab4c6269abfdb96625",
        "bytes": 828
      },
      {
        "path": ".ai-novel/portable-knowledge-source.json",
        "sha256": "b4ecc0da2f3630da440e64c2f2956ac0c96cc94bac4e2aefe0963dd3e960e915",
        "bytes": 29
      }
    ]
  },
  "authorItems": [
    {
      "category": "本章实际代价",
      "severity": "error",
      "description": "原稿只回顾前章已付六枚的支出或留下将来责任，尚未兑现本章新的具体已付出后果。只修复本章实际代价未兑现的问题，保留原作者事实，不指定代价金额、物品或发生方式。",
      "quote": "她低下头，从皮包里抽出记录本，翻到末尾，在“等待雨停”下面又添了一行字：午后二次申请，被拒。预约费六枚，已扣，不退。",
      "decision": "apply",
      "origin": "author"
    },
    {
      "category": "今天/明天矛盾",
      "severity": "error",
      "description": "同一记录日期同时写成今天与明天，表述互相矛盾。修正这两句的矛盾，保持前章异常类型和同日午后时点，不指定正确日期、异常原因或新增知情事实。",
      "quote": "“记录上写的是今天。”林澄说，“旧钟慢了一刻，记录却已经走到了明天。如果今天进不去，明天再核，记录上的日期就成真了。”",
      "decision": "apply",
      "origin": "author"
    }
  ],
  "attemptPolicy": {
    "milestone": "diagnostic",
    "arms": [
      "candidate"
    ],
    "operationId": "固定稿首审",
    "primaryPurpose": "review-chapter",
    "repairPurpose": "review-chapter-rebuild",
    "maxRepairAttempts": 1,
    "reviewRebuild": {
      "operationId": "修后完整复核",
      "primaryPurpose": "review-chapter",
      "repairPurpose": "review-chapter-rebuild",
      "maxRepairAttempts": 1
    }
  },
  "operations": [
    {
      "id": "固定稿首审",
      "kind": "review"
    },
    {
      "id": "作者确认一次修稿",
      "kind": "refine"
    },
    {
      "id": "修后完整复核",
      "kind": "final-review"
    }
  ],
  "finalUnitRange": {
    "minimum": 842,
    "maximum": 1170
  },
  "automatedOutcomeCeiling": "pending-independent-diagnostic-oracle-review"
})
export const CANDIDATE_QUALITY_COMPARISON_PROTOCOL_REVISION = 's14b-candidate-quality-and-comparison-v2'
export const CANDIDATE_ONLY_PROTOCOL_REVISION = 's14b-candidate-only-three-rounds-v1'
// 旧 v2（只采纳 error/warning）保留为历史 revision；按 v1→v2 先例不再作为可校验策略，旧目标因协议 hash 漂移拒绝。
export const POST_UI_REVIEW_POLICY = Object.freeze({ revision: 's14b-post-ui-reviewed-draft-must-show-unknown-v3',
  selection: 'all-error-warning-and-must-show-unknown-in-report-order', mustShowGoalId: '^ch\\d+:mustShow:\\d+$',
  confirmation: 'test-preauthorized-original-items',
  merge: 'accept-only-revision', finalReview: 'ordinary-full-review', noAction: 'retain-initial-draft',
  unknownOnly: 'retain-initial-draft-and-full-review-pending-independent-goal-proof',
  maxRevisions: 1, qualityDecision: 'independent-oracle-final-text',
  armAsymmetry: Object.freeze({
    baseline: 'baseline 2264390d 不识别【第N章必现】标记，只把该行当普通世界设定文本，首审不会产生 mustShow 项，其 unknown 只可能来自蓝图 keyEvents 或覆盖不完整且不被采纳；首审有 error/warning 时仍按原规则修稿一次，无 error/warning 时按 unknown-only 规则保留初稿',
    candidate: 'candidate 把该行冻结为 chN:mustShow:K 目标；首审为 unknown 时视为作者测试预授权补写，与 error/warning 按原报告顺序共用至多一次修稿和一次普通复评，不改称已确认错误',
    // 场景 v3（评分规则/场景变更）：候选臂登记产品原生的唯一压缩，baseline 没有该能力，不对称同样披露。
    condense: 'candidate（产品自 f00b612b 起）可对超出 draftTargetUnitRange 上限的首稿发一次产品原生压缩 chapter-draft-condense，并登记为「900单位正文」的正式效果；baseline 2264390d 没有该产品能力、不登记压缩，首稿超上限即按原字数门失败；两臂是否触发压缩及压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善',
    claim: '两臂是否触发修复分支的差异来自上述不对称，不得据此单独声称相对改善；首稿自然满足时记录修复分支未触发' }) })
const MUST_SHOW_GOAL_ID = new RegExp(POST_UI_REVIEW_POLICY.mustShowGoalId, 'u')
// early-budget 的登记：指定范围生成的一次结构化语法修复与成稿首审的一次重建。early 场景与 post-UI 共用同一份，milestone 限定 post-ui。
const structuredRecoveryPolicy = operationId => Object.freeze({ operationId, arms: Object.freeze(['baseline', 'candidate']),
  budget: 'planBlueprintGenerationCost', maxSyntaxRepairs: 1, maxCompactFallbacksPerChapter: 1,
  trigger: 'settled-length-or-production-blueprint-decode-failure', order: 'depth-first-half-split',
  armAsymmetry: 'Both arms use their existing structured executor; candidate now rebuilds value_too_long without mechanical truncation. No baseline product code is changed.' })
export const structuredRecoveryFor = (policy, arm, operationId) => {
  const value = Array.isArray(policy?.structuredRecovery)
    ? policy.structuredRecovery.find(item => item.operationId === operationId) : policy?.structuredRecovery
  return value?.arms.includes(arm) ? value : null
}
const draftRecoveryPolicy = operationIds => Object.freeze({ operationIds: Object.freeze(operationIds),
  arms: Object.freeze(['baseline', 'candidate']), maxAttempts: 8, maxContinuationRounds: 7, maxNoProgressRecoveries: 1,
  baselineMinimumRatio: 0.8, candidateMinimumRatio: 0.7, minimumProgressUnits: 300,
  trigger: 'settled-hash-verified-short-stop-or-length', formalEffect: 'last-attempt-only',
  armAsymmetry: 'baseline 2264390d uses its original 80% continuation minimum and has no upper-bound stop or condense; candidate uses draftTargetUnitRange and may condense the composed draft. Both retain their own eight-attempt root budget.' })
export const draftRecoveryFor = (policy, arm) => policy?.draftRecovery?.arms.includes(arm) ? policy.draftRecovery : null
const planningChapters = 6
const planningActions = ['outline', 'directory'].flatMap(kind => Array.from({ length: Math.ceil(planningChapters / DEFAULT_PLANNING_ACTION_CHAPTERS) }, (_, index) => {
  const from = index * DEFAULT_PLANNING_ACTION_CHAPTERS + 1, to = Math.min(planningChapters, from + DEFAULT_PLANNING_ACTION_CHAPTERS - 1)
  return { id: `planning-${kind}-${from === to ? from : `${from}-${to}`}`, kind, range: [from, to], targetUnits: DEFAULT_PLANNING_TARGET_UNITS }
}))
const planningRequestBounds = Object.freeze({ ...Object.fromEntries(planningActions.map(action => [action.id,
  action.kind === 'outline' ? (action.range[1] - action.range[0] + 1) * PLOT_OUTLINE_CONTENT.maxAttemptsPerChapter
    : planBlueprintGenerationCost(action.range[1] - action.range[0] + 1).recoveryCallBound])),
  'planning-draft': draftRecoveryPolicy([]).maxAttempts + 1,
  'planning-review': (SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy.reviewRebuild.maxRepairAttempts + 1)
    * (SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy.reviewRebuild.maxLengthReplacements + 1),
  'planning-refine': SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy.refinementRecovery.maxAttempts,
  'planning-final-review': (SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy.finalReviewRebuild.maxRepairAttempts + 1)
    * (SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy.finalReviewRebuild.maxLengthReplacements + 1) })
const planningMaximumRequests = Object.values(planningRequestBounds).reduce((sum, count) => sum + count, 0)
const planningModel = { ...QUALIFICATION_STAGE_MODELS.profiles.flash.model, maxTokens: 65536 }
const planningRootBudgets = Object.fromEntries(planningActions.map(action => {
  const [from, to] = action.range
  const selection = { operation: action.kind === 'outline' ? 'generate-plot-outline' : 'chapter-blueprint-directory', authorInputs: [
    { id: 'planning:target-units', text: String(action.targetUnits) },
    ...(action.kind === 'outline' ? [
      { id: 'architecture:author-config', text: JSON.stringify({ totalChapters: planningChapters }) },
      { id: 'architecture:planning-intent', text: JSON.stringify({ version: 'architecture-action-v1', priorSteps: [], synopsisRange: { from, to } }) },
    ] : [
      { id: 'directory:author-config', text: JSON.stringify({ totalChapters: planningChapters }) },
      { id: 'directory:requested-range', text: JSON.stringify({ mode: 'append', startChapter: from, endChapter: to }) },
    ]),
  ] }
  return [action.id, newMainGenerationPolicy(selection, planningModel).budget]
}))
export const PLANNING_NATIVE_DIAGNOSTIC = Object.freeze({
  savedOutlineContinuation: {
    "continuationId": "planning-six-chapters-saved-outline-v1",
    "manifestHash": "de0a2de0013447f214b88057456fca6fb099f9bd2dc91ba42b40e7aecd9a1d86",
    "sourceHash": "5be2790970555a59c29b73294f5b286721e3bbd392014f34c570904745735b75",
    "projectId": "c502670c-1694-4984-8155-95e6d934bb5a",
    "attempts": [
      {
        "attemptId": "candidate:fd293bd6-589f-47db-8947-30132684d0b0",
        "bindingHash": "dd0a7a01a836575e6a14a732c16b2427a28f2e4231b41d1966fdb3b78658e119",
        "terminal": "settle"
      },
      {
        "attemptId": "candidate:f04d0231-c110-47de-b137-055a72ba4f22",
        "bindingHash": "2843fa5a0bb44937aa5805a3d368fe567ce6607f77b51dc81c584f0b687686f5",
        "terminal": "settle"
      },
      {
        "attemptId": "candidate:3bd51970-2452-4264-b962-ba78fab1a0b6",
        "bindingHash": "0daa907997ca8c3a31a243e6a93f12bfab9d4fdbbf2991441a70c1628ce0e160",
        "terminal": "settle"
      },
      {
        "attemptId": "candidate:33e62580-80f6-4ca8-95da-ba13915f7cf8",
        "bindingHash": "55a96274dfc90e8c6abf93c8d5d4bbe458dbfe3ca5f90999001832953c4dc022",
        "terminal": "settle"
      },
      {
        "attemptId": "candidate:396d4123-5734-46d1-b569-8e1b497a4a5d",
        "bindingHash": "991e334452af667290f7d0fb059f5817a43049b693d351d0c1d91de7f94719d2",
        "terminal": "settle"
      },
      {
        "attemptId": "candidate:e3dad1bc-81bc-40f3-a214-1f4ed2ba39fa",
        "bindingHash": "d633fbe3aff9a38544d17ccbcaf6656d466adc9a4427a2a907279cfc54ba2fcd",
        "terminal": "unknown"
      }
    ]
  },
  sceneId: '场景1', caseId: 'planning-six-chapters', caseIds: ['planning-six-chapters'], chapterNumber: 1,
  milestone: 'diagnostic', arms: ['candidate'], nonQualification: true, allocation: 'nonQualificationDiagnostic',
  scenarioRevision: 'planning-six-chapters-native-cap64-v2', formalDenominatorContribution: 0,
  invocationId: '68fe991e-9b6b-4ba5-9734-2623477af7c1', totalChapters: planningChapters, wordsPerChapter: 1000,
  range: [1, planningChapters], expectedPhysicalRequests: planningActions.reduce((sum, action) => sum + (action.kind === 'outline'
    ? action.range[1] - action.range[0] + 1 : planBlueprintGenerationCost(action.range[1] - action.range[0] + 1).expectedCalls), 3),
  maxPhysicalRequests: planningMaximumRequests, physicalRequestBounds: planningRequestBounds, planningRootBudgets,
  identityPolicy: 'new-project-native-generated-ids-explicit-source-target-bijection-stable-through-journey',
  diagnosticInputHash: '713e14b031d3e373ed603f09b9c36a4ac32415bf3217ddae6961e6c71cb82ada',
  sources: {
    premise: { name: 'thread11-w4-premise-saved.md', sha256: '5682e67d6a450405b7ee695e5263da163a37c9bc501ec2e853c51cee4845820a' },
    characters: { name: 'thread11-w4-characters-saved.md', sha256: 'b025461e58fb7726e7c6bf445f4112bdcdca726fc6a2264544e0e565be238053' },
    worldbuilding: { name: 'thread11-w4-worldbuilding-saved.md', sha256: '5b082ea3b1447bd09e465a9bc7e43c05e057200513691b71b05959060d5e4549' },
    rows: { name: 'thread11-w4-blueprint-1791057053875-ce289708-saved-rows.json', sha256: '5d6e65d5e2566e765a0b317f86e43c63310eed1fc2c48e4192d802045d81ff11' },
  },
  operations: [...planningActions,
    { id: 'planning-draft', kind: 'draft' }, { id: 'planning-review', kind: 'review' },
    { id: 'planning-refine', kind: 'refine' }, { id: 'planning-final-review', kind: 'final-review' }],
  attemptPolicy: { milestone: 'diagnostic', arms: ['candidate'],
    outline: planningActions.filter(action => action.kind === 'outline').map(action => ({ operationId: action.id,
      range: action.range, protocol: PLOT_OUTLINE_PROTOCOL, ...PLOT_OUTLINE_CONTENT })),
    structuredRecovery: planningActions.filter(action => action.kind === 'directory').map(action => ({ ...structuredRecoveryPolicy(action.id),
      chapterNumbers: Array.from({ length: action.range[1] - action.range[0] + 1 }, (_, index) => action.range[0] + index), arms: ['candidate'],
      armAsymmetry: 'Candidate-only diagnostic. Complete long content is accepted; truncation or structural failure may trigger bounded recovery.' })),
    draftRecovery: { ...draftRecoveryPolicy(['planning-draft']), arms: ['candidate'] },
    draftCondense: { operationIds: ['planning-draft'], arms: ['candidate'], primaryPurpose: 'chapter-draft',
      condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
      trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum', formalEffect: 'last-attempt-only' },
    shortOutline: { purpose: 'chapter-draft-short-outline', operationIds: ['planning-draft'], maxAttempts: 1,
      trigger: 'new-draft-before-prose-same-root-native-artifact' },
    reviewRebuild: { operationId: 'planning-review', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1, maxLengthReplacements: 1 },
    finalReviewRebuild: { operationId: 'planning-final-review', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1, maxLengthReplacements: 1 },
    refinementRecovery: { operationId: 'planning-refine', purpose: 'refine-from-review', maxAttempts: 4,
      trigger: 'settled-length-same-confirmation-visible-append-with-progress' } },
  evaluationPolicy: { ...AI_REVIEW_FINAL_MANUSCRIPT_POLICY, caseIds: ['planning-six-chapters'],
    confirmation: 'agent-semantic-approval-references-original-report-and-native-findings',
    physicalRequests: { minimum: 11, maximum: planningMaximumRequests, manuscriptMinimum: 1, manuscriptMaximum: 12 },
    qualityDecision: 'diagnostic-only-no-new-literary-pass-gate' },
  modelProfile: { ...QUALIFICATION_STAGE_MODELS.profiles.flash,
    configurationHash: 'a1a2da6a780d8f54967bbaa20150235357684dd245f22f95e0fee772a25a1676',
    model: planningModel },
})
export const PLANNING_STAGE_MODELS = Object.freeze({ revision: 'planning-native-official-flash-cap64-v1',
  profiles: { flash: PLANNING_NATIVE_DIAGNOSTIC.modelProfile } })
const EARLY_BUDGET_ATTEMPT_POLICY = Object.freeze({ milestone: 'post-ui', arms: Object.freeze(['baseline', 'candidate']),
  operationId: '指定范围生成', primaryPurpose: 'chapter-blueprint-directory',
  repairPurpose: 'chapter-blueprint-directory:structured-syntax-repair', maxRepairAttempts: 1,
  reviewRebuild: Object.freeze({ operationId: '成稿首审', primaryPurpose: 'review-chapter',
    repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 }) })
/**
 * post-UI 场景 v3（评分规则/场景变更，与产品 f00b612b 的修复分开）：只为候选臂的「900单位正文」登记产品原生的唯一一次
 * 超长压缩，语义同 C16–C18 v2；early 里程碑的登记（EARLY_BUDGET_ATTEMPT_POLICY）不变。
 */
const POST_UI_ATTEMPT_POLICY = Object.freeze({ ...EARLY_BUDGET_ATTEMPT_POLICY,
  draftRecovery: draftRecoveryPolicy(['900单位正文']),
  structuredRecovery: structuredRecoveryPolicy('指定范围生成'),
  draftCondense: Object.freeze({ operationIds: Object.freeze(['900单位正文']), arms: Object.freeze(['candidate']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }) })
/**
 * full 场景 v2（评分规则/场景变更，与产品 f00b612b 的修复分开）：只为候选臂的「连续章节正文」登记产品原生的唯一一次超长压缩，
 * 语义同 post-UI v3；每章没有审修链，保存稿即压缩稿。baseline 恒无压缩；v3 另登记两臂既有有界续写、无进展恢复与结构化拆批/完整重建。
 */
const FULL_ATTEMPT_POLICY = Object.freeze({ milestone: 'final', arms: Object.freeze(['baseline', 'candidate']),
  draftRecovery: draftRecoveryPolicy(['连续章节正文']),
  structuredRecovery: structuredRecoveryPolicy('三章规划'),
  draftCondense: Object.freeze({ operationIds: Object.freeze(['连续章节正文']), arms: Object.freeze(['candidate']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }),
  armAsymmetry: 'candidate（产品自 f00b612b 起）可对超出 draftTargetUnitRange 上限的章节首稿发一次产品原生压缩 chapter-draft-condense，并登记为该章「连续章节正文」的正式效果；baseline 2264390d 没有该产品能力、不登记压缩，首稿超上限即按原字数门失败；两臂是否触发压缩及各章压缩后正文长度的差异来自该不对称，不得据此单独声称相对改善' })
export const POST_UI_BUDGET = Object.freeze({ scenarioRevision: 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v4',
  attemptPolicy: POST_UI_ATTEMPT_POLICY,
  evaluationPolicy: POST_UI_REVIEW_POLICY,
  operations: Object.freeze([{ id: '指定范围生成', kind: 'directory' }, { id: '900单位正文', kind: 'draft' },
    { id: '成稿首审', kind: 'review' }, { id: '成稿一次修稿', kind: 'refine' }, { id: '成稿完整复评', kind: 'final-review' }]) })
export const POST_UI_AI_REVIEW_SCENARIOS = Object.freeze(Object.fromEntries([
  ['early-budget', 6, 38, POST_UI_BUDGET.operations, POST_UI_ATTEMPT_POLICY],
  ['early-context', 4, 18, [{ id: '长设定第三章正文', kind: 'draft' }, ...POST_UI_BUDGET.operations.slice(2)], null],
  ['early-review', 2, 16, [{ id: '审稿', kind: 'review' }, { id: '定向修稿', kind: 'refine' }, { id: '一次复核', kind: 'final-review' }], null],
].map(([phase, minimumCalls, maximumPlannedCalls, operations, sourcePolicy]) => {
  const first = operations.find(item => item.kind === 'review'), final = operations.find(item => item.kind === 'final-review')
  const reviewPolicy = operationId => ({ operationId, primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 })
  return [phase, Object.freeze({ scenarioRevision: `s14b-post-ui-ai-review-final-${phase}-v1`, minimumCalls, maximumPlannedCalls,
    evaluationPolicy: { ...AI_REVIEW_FINAL_MANUSCRIPT_POLICY, caseIds: [phase === 'early-budget' ? '场景1/1' : phase === 'early-context' ? '场景2/3' : '场景3/2'],
      physicalRequests: { minimum: minimumCalls, maximum: maximumPlannedCalls, manuscriptMinimum: 1, manuscriptMaximum: 8 },
      armAsymmetry: { baseline: 'Native keyEvents only; no mustShow, findingId, targeted cycle or durable owner artifact; original 8192 per-request budget retained.',
        candidate: 'Native keyEvents/mustShow and actual persisted cycle findingIds; own root/model budgets retained.',
        claim: 'Record native selection, source, parameter and condense differences; no improvement claim from this asymmetry.' } },
    attemptPolicy: { ...(sourcePolicy ?? { milestone: 'post-ui', arms: ['baseline', 'candidate'], ...reviewPolicy(first.id) }),
      reviewRebuild: reviewPolicy(sourcePolicy ? first.id : final.id), ...(sourcePolicy ? { finalReviewRebuild: reviewPolicy(final.id) } : {}),
      refinementRecovery: { operationId: operations.find(item => item.kind === 'refine').id, purpose: 'refine-from-review', maxAttempts: 4,
        trigger: 'settled-length-same-confirmation-visible-append-with-progress' } }, operations })]
})))
// v3 只改登记（attemptPolicy 增加唯一压缩），作者世界设定输入与 v2 逐字相同：沿用语义源里登记给 v2 的同一条附加行，不改动冻结的语义源。
const AUTHOR_SETTING_LINES_REVISION = Object.freeze({
  's14b-post-ui-reviewed-budget-review-rebuild-must-show-v3': 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2',
  's14b-post-ui-reviewed-budget-review-rebuild-must-show-v4': 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2' })
/** 场景 revision 在语义源登记的作者设定附加行。 */
export const scenarioAuthorSettingLines = (scene, scenarioRevision) => {
  const sourceRevision = scenarioRevision?.replace(/-candidate-only-v[12]$/u, '')
  return sourceRevision ? scene?.scenarioAuthorSettingLines?.[sourceRevision === POST_UI_AI_REVIEW_SCENARIOS['early-budget'].scenarioRevision
    ? 's14b-post-ui-reviewed-budget-review-rebuild-must-show-v2' : AUTHOR_SETTING_LINES_REVISION[sourceRevision] ?? sourceRevision] ?? [] : []
}
/** 作者世界设定：只有登记了该场景 revision 附加行的场景才追加独立行，其余 revision 字节不变。 */
export function scenarioAuthorSetting(scene, scenarioRevision) {
  return [scene?.material, scene?.longSetting, ...scenarioAuthorSettingLines(scene, scenarioRevision)].filter(Boolean).join('\n')
}
export function reviewedDraftSelection(report) {
  if (!Array.isArray(report?.items) || report.items.length === 0
    || report.items.some(item => !['pass', 'error', 'warning', 'unknown'].includes(item?.severity))) throw new Error('REVIEWED_DRAFT_REPORT_INVALID')
  const selected = report.items.filter(item => item.severity === 'error' || item.severity === 'warning'
    || item.severity === 'unknown' && typeof item.goalId === 'string' && MUST_SHOW_GOAL_ID.test(item.goalId))
  return { selected, disposition: selected.length ? 'revised-once'
    : report.items.some(item => item.severity === 'unknown')
      ? 'no-actionable-review-with-unresolved-goals' : 'no-actionable-review' }
}

/** Select only discoveries present in the formal raw report; normalization is not a discovery. */
export function aiReviewFinalManuscriptSelection({ rawContent, savedContent, context, baselineContract }) {
  if (context?.operation !== 'review-chapter' || context.recheck || !context.source?.content)
    throw new Error('AI_REVIEW_CONTEXT_INVALID')
  const raw = (baselineContract?.parseReviewResult ?? parseReviewGenerationResult)(stripDraftThinkingTags(rawContent))
  const build = (content, frozenGoals = context.frozenGoals) => (baselineContract?.buildReport ?? buildReviewGenerationReport)({ content: stripDraftThinkingTags(content),
    sourceContent: context.source.content, frozenGoals, writingLanguage: context.writingLanguage,
    uiLocale: context.uiLocale, preflightFindings: context.preflightFindings })
  const report = build(rawContent)
  if (savedContent !== JSON.stringify(report, null, 2)) throw new Error('AI_REVIEW_SAVED_REPORT_MISMATCH')
  const eligibleGoals = new Set()
  for (const goal of context.frozenGoals.items) {
    const matches = Array.isArray(raw.goalReviews) ? raw.goalReviews.filter(item => item?.id === goal.id) : []
    if (matches.length !== 1 || !['unmet', 'unknown'].includes(matches[0].status)) continue
    const isolated = build(JSON.stringify({ ...raw, goalReviews: matches }),
      { ...context.frozenGoals, coverage: 'complete', items: [goal] }).goalReview
    if (isolated.coverage === 'complete' && isolated.items[0].status === matches[0].status
      && (matches[0].status === 'unmet' || /^ch\d+:(?:keyEvents|mustShow):\d+$/u.test(goal.id))) eligibleGoals.add(goal.id)
  }
  // General items retain parser order; goal projections retain frozen goal order. Preflight items remain separate.
  const aiItems = report.items.filter(item => raw.items.some(candidate => stableEvidence(candidate) === stableEvidence(item))
    && ['error', 'warning'].includes(item.severity) || item.goalId && eligibleGoals.has(item.goalId)
      && ['error', 'unknown'].includes(item.severity))
  const softwareItems = report.items.filter(item => item.stableFactKey && item.sourceChapter !== undefined)
  return { selected: aiItems, softwareItems, disposition: aiItems.length ? 'revised-once' : 'no-actionable-review' }
}
/** Baseline's private parser/presentation runs from its frozen source, without candidate goal projection. */
export function loadBaselineReviewContract(repositoryRoot) {
  const relative = 'src/services/workflows/commands/review-chapter.command.ts'
  const source = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
  const definitions = source.slice(source.indexOf('const REVIEW_SUMMARY_MAX_CHARACTERS'), source.indexOf('function formatFinalizedHistory'))
  const projection = source.slice(source.indexOf('    const goalReview = normalizeChapterGoalReview'), source.indexOf('    const blueprint = await ipc.invokeWithProjectSession'))
  if (!definitions.includes('function parseReviewResult') || !projection.includes('delete parsedResult.goalReviews'))
    throw new Error('BASELINE_REVIEW_CONTRACT_UNAVAILABLE')
  const bundle = buildSync({ stdin: { contents: `import {freezeChapterGoals,normalizeChapterGoalReview,chapterGoalReviewItems} from './src/shared/chapter-goal-review';
    import {mergeConsistencyFindingsIntoReview,findBlueprintContinuityRisks} from './src/shared/consistency-preflight';
    export {appendVisibleTextContinuation,redactVisibleCompletionText} from './src/services/workflows/bounded-completion';
    ${definitions}
    export {parseReviewResult,freezeChapterGoals,findBlueprintContinuityRisks};
    export function buildReport(input){let parsedResult=parseReviewResult(input.content);const draft=input.sourceContent,frozenGoals=input.frozenGoals,
      writingLanguage=input.writingLanguage,text=(zh,en)=>input.uiLocale==='en-US'?en:zh;
      ${projection}
      return mergeConsistencyFindingsIntoReview(parsedResult,input.preflightFindings??[],input.uiLocale??'zh-CN');}`, loader: 'ts', resolveDir: repositoryRoot },
    bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
  const module = { exports: {} }
  new Function('module', 'exports', bundle)(module, module.exports)
  return { ...module.exports, sourceHashes: Object.fromEntries([relative, 'src/shared/chapter-goal-review.ts', 'src/shared/consistency-preflight.ts',
    'src/shared/writing-language.ts', 'src/services/workflows/bounded-completion.ts', 'src/services/workflows/workflow-utils.ts']
    .map(file => [file, digest(fs.readFileSync(path.join(repositoryRoot, file)))])) }
}
/** The S14B endpoint is immutable evidence, not a second product revision workflow. */
export function validateReviewedDraft(result) {
  const fail = () => ({ valid: false, pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' })
  const chain = result?.reviewedDraft
  try {
    if (stableEvidence(result.evaluationPolicy) !== stableEvidence(POST_UI_REVIEW_POLICY) || !chain) return fail()
    const readArtifact = artifact => {
      if (!artifact || !CONTENT_HASH.test(artifact.contentHash ?? '') || typeof artifact.outputPath !== 'string') throw new Error('missing artifact')
      const content = fs.readFileSync(artifact.outputPath, 'utf8')
      if (digest(content) !== artifact.contentHash) throw new Error('changed artifact')
      return content
    }
    readArtifact(chain.initial)
    const report = JSON.parse(readArtifact(chain.review)), { selected, disposition } = reviewedDraftSelection(report)
    if (chain.review.sourceHash !== chain.initial.contentHash || chain.selectedCount !== selected.length
      || chain.selectedItemsHash !== digest(selected)) return fail()
    const revised = selected.length > 0
    if (chain.disposition !== disposition) return fail()
    if (revised) {
      const confirmation = JSON.parse(readArtifact(chain.confirmation))
      if (confirmation.sourceReviewId !== chain.review.reviewId || digest(confirmation.sourceDraft?.content ?? '') !== chain.initial.contentHash
        || confirmation.items?.length !== selected.length || confirmation.items.some((item, index) =>
          item.decision !== 'apply' || item.origin !== 'ai'
          || ['category', 'severity', 'description', 'quote', 'goalId', 'stableFactKey'].some(key => item[key] !== selected[index][key])
          // 非 baseline 臂采纳的必现 unknown 只能经产品 review-cycle finding 进入 apply；baseline 无 review-cycle，不要求。
          || result.arm !== 'baseline' && selected[index].severity === 'unknown' && MUST_SHOW_GOAL_ID.test(selected[index].goalId ?? '')
            && (typeof item.findingId !== 'string' || !item.findingId.trim()))) return fail()
      readArtifact(chain.revision)
      readArtifact(chain.finalReview)
      if (chain.mergeHash !== chain.revision.contentHash || chain.finalReview.sourceHash !== chain.mergeHash
        || chain.finalDraft.contentHash !== chain.mergeHash) return fail()
    } else if (chain.confirmation || chain.revision || chain.finalReview || chain.mergeHash
      || chain.finalDraft.contentHash !== chain.initial.contentHash) return fail()
    readArtifact(chain.finalDraft)
    if (chain.finalDraft.contentHash !== result.saved?.contentHash
      || chain.finalDraft.contentHash !== result.draftObservation?.contentHash) return fail()
    const operations = POST_UI_BUDGET.operations.slice(0, revised ? 5 : 3)
    if (stableEvidence(result.operations?.map(item => [item.operation, item.kind]))
      !== stableEvidence(operations.map(item => [item.id, item.kind]))) return fail()
    for (const [kind, artifact] of [['draft', chain.initial], ['review', chain.review],
      ...(revised ? [['refine', chain.revision], ['final-review', chain.finalReview]] : [])]) {
      if (result.operations.find(item => item.kind === kind)?.outputHash !== artifact.contentHash) return fail()
    }
    return { valid: true, operations, disposition: chain.disposition }
  } catch { return fail() }
}
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')

export function assertBoundedRevisionSource(draft) {
  const source = BOUNDED_REVISION_DIAGNOSTIC.source
  if (!draft || draft.id !== source.draftId || draft.chapterNumber !== source.chapterNumber
    || draft.version !== source.version || draft.status !== source.status
    || typeof draft.content !== 'string' || digest(draft.content) !== source.contentSha256
    || Buffer.byteLength(draft.content) !== source.byteSize || countProjectedDraftUnits(draft.content) !== source.units)
    throw new Error('BOUNDED_REVISION_SOURCE_MISMATCH')
}

/** Copy preparation reads frozen files only; SQLite may open only the later working donor. */
export function readBoundedRevisionSource(inputPath) {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')), source = BOUNDED_REVISION_DIAGNOSTIC.source
  const readFrozen = (file, expectedHash, bytes) => {
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || path.resolve(file) !== fs.realpathSync.native(file))
      throw new Error('BOUNDED_REVISION_UNSAFE_SOURCE')
    const body = fs.readFileSync(file)
    if (digest(body) !== expectedHash || bytes !== undefined && body.length !== bytes)
      throw new Error('BOUNDED_REVISION_SOURCE_FILE_DRIFT')
    return body
  }
  const manifest = JSON.parse(readFrozen(input.packetManifestPath, source.manifestSha256))
  const stdout = JSON.parse(readFrozen(input.stdoutPath, source.stdoutSha256))
  if (manifest.invocationId !== source.invocationId || stdout.invocationId !== source.invocationId
    || manifest.sourceHashes.codeSha !== source.testedSha || manifest.sourceHashes.sourceHash !== source.sourceHash
    || manifest.sourceHashes.protocolHash !== source.protocolHash) throw new Error('BOUNDED_REVISION_SOURCE_MISMATCH')
  const original = stdout.results.find(item => item.caseId === 'C17-A')
  if (original?.codeSha !== source.testedSha || original.sourceHash !== source.sourceHash
    || original.saved?.contentHash !== source.contentSha256 || original.saved.draftId !== source.draftId
    || original.saved.version !== source.version || original.saved.chapterNumber !== source.chapterNumber
    || original.saved.persistedBytes !== source.byteSize || original.saved.units !== source.units
    || original.physicalProject.projectId !== source.projectId || original.projectEpoch !== source.epoch
    || path.resolve(original.physicalProject.path) !== path.resolve(input.sourceProjectRoot))
    throw new Error('BOUNDED_REVISION_SOURCE_MISMATCH')
  const packetRoot = path.dirname(input.packetManifestPath)
  const db = manifest.dbCopies.find(item => path.resolve(item.original) === path.resolve(input.sourceProjectRoot, '.ai-novel/project.db'))
  if (!db || db.copiedSha256 !== source.packetFiles[0].sha256
    || path.resolve(db.copy) !== path.resolve(packetRoot, 'db-copies/C17-A/project.db'))
    throw new Error('BOUNDED_REVISION_SOURCE_MISMATCH')
  const packetFiles = source.packetFiles.map(item => ({ ...item, sourcePath: path.join(path.dirname(db.copy), item.name),
    bytes: readFrozen(path.join(path.dirname(db.copy), item.name), item.sha256, item.bytes) }))
  const assets = source.assets.map(item => ({ ...item,
    bytes: readFrozen(path.join(input.sourceProjectRoot, item.path), item.sha256, item.bytes) }))
  if (JSON.parse(assets.find(item => item.path.endsWith('/project.json')).bytes).projectId !== source.projectId)
    throw new Error('BOUNDED_REVISION_SOURCE_MISMATCH')
  readFrozen(path.join(packetRoot, 'semantic-source.json'), source.semanticSha256)
  const document = readFrozen(path.join(packetRoot, 'C17-A.md'), source.caseDocumentSha256).toString('utf8')
  const section = document.slice(document.indexOf('### 正式保存的第2章完整正文：'))
  const content = section.split('~~~~')[1]?.replace(/^\r?\n/u, '').replace(/\r?\n$/u, '')
  const draft = { id: source.draftId, chapterNumber: source.chapterNumber, version: source.version, status: source.status, content }
  assertBoundedRevisionSource(draft)
  for (const item of BOUNDED_REVISION_DIAGNOSTIC.authorItems)
    if (content.split(item.quote).length !== 2) throw new Error('BOUNDED_REVISION_AUTHOR_ANCHOR_MISMATCH')
  return { inputHash: digest(fs.readFileSync(inputPath)), draft, assets, packetFiles, original }
}

export function boundedRevisionItems(report, sourceReview, draft) {
  assertBoundedRevisionSource(draft)
  if (!sourceReview?.id || stableEvidence(sourceReview.sourceDraft) !== stableEvidence(draft)
    || !Array.isArray(report?.items)) throw new Error('BOUNDED_REVISION_CONFIRMATION_SOURCE_MISMATCH')
  return [...report.items.map(item => ({ ...item, decision: 'ignore', origin: 'ai' })),
    ...BOUNDED_REVISION_DIAGNOSTIC.authorItems]
}

export function validateBoundedRevisionDiagnostic(result) {
  try {
    const chain = result.boundedRevision, policy = BOUNDED_REVISION_DIAGNOSTIC
    const readArtifact = item => {
      const text = fs.readFileSync(item.outputPath, 'utf8')
      if (digest(text) !== item.contentHash) throw new Error('artifact')
      return text
    }
    if (result.arm !== 'candidate' || result.phase !== 'bounded-revision-diagnostic' || result.milestone !== 'diagnostic'
      || result.caseId !== policy.caseId || result.qualification !== 'non-qualification-diagnostic'
      || !chain || chain.source.contentHash !== policy.source.contentSha256
      || chain.source.draftId !== policy.source.draftId || chain.source.version !== policy.source.version)
      throw new Error('identity')
    const original = readArtifact(chain.source), first = JSON.parse(readArtifact(chain.review))
    const confirmation = JSON.parse(readArtifact(chain.confirmation))
    const frozen = { id: policy.source.draftId, chapterNumber: 2, version: 1, status: 'draft', content: original }
    assertBoundedRevisionSource(frozen)
    if (confirmation.kind !== 'human-confirmed-review' || confirmation.schemaVersion !== 1
      || confirmation.sourceReviewId !== chain.review.reviewId || !chain.confirmation.reviewId
      || stableEvidence(confirmation.sourceDraft) !== stableEvidence(frozen)
      || stableEvidence(confirmation.items) !== stableEvidence(boundedRevisionItems(first,
        { id: chain.review.reviewId, sourceDraft: frozen }, frozen))) throw new Error('confirmation')
    readArtifact(chain.revision)
    const finalText = readArtifact(chain.finalDraft), finalReview = readArtifact(chain.finalReview)
    if (!Array.isArray(JSON.parse(finalReview).items)) throw new Error('final-review')
    if (chain.review.sourceHash !== digest(original)
      || chain.finalReview.sourceHash !== chain.mergeHash || chain.revision.contentHash !== chain.mergeHash
      || chain.finalDraft.contentHash !== chain.mergeHash || result.saved?.contentHash !== chain.mergeHash
      || chain.mergeReceipt?.revisionId !== chain.revision.revisionId || chain.mergeReceipt.targetDraftId !== 4
      || chain.mergeReceipt.status !== 'revised' || chain.mergeReceipt.chapterNumber !== 2 || chain.mergeReceipt.version !== 1
      || chain.mergeReceipt.wordCount !== result.saved.units
      || result.saved.units < policy.finalUnitRange.minimum || result.saved.units > policy.finalUnitRange.maximum
      || countProjectedDraftUnits(finalText) !== result.saved.units) throw new Error('merge')
    if (stableEvidence(result.operations.map(item => [item.operation, item.kind]))
      !== stableEvidence(policy.operations.map(item => [item.id, item.kind]))) throw new Error('operations')
    if (result.attempts.length < 3 || result.attempts.length > 5 || result.ownerTerminal.length !== result.attempts.length
      || new Set(result.attempts.map(item => item.attemptId)).size !== result.attempts.length
      || new Set(result.ownerTerminal.map(item => item.attemptId)).size !== result.attempts.length
      || result.diagnosticInputHash !== chain.provenance.inputHash
      || chain.provenance.restoration.originProjectId !== policy.source.projectId
      || chain.provenance.restoration.targetProjectId !== result.physicalProject.projectId
      || result.physicalProject.projectId === policy.source.projectId || result.projectEpoch === policy.source.epoch)
      throw new Error('attempts')
    const ordered = []
    for (const operation of policy.operations) {
      const attempts = result.attempts.filter(item => item.binding.operation === operation.id)
      ordered.push(...attempts)
      const purposes = attempts.map(item => item.binding.actual?.purpose)
      if (stableEvidence(purposes) !== stableEvidence(operation.kind === 'refine' ? ['refine-from-review'] : ['review-chapter'])
        && stableEvidence(purposes) !== stableEvidence(operation.kind === 'refine' ? [] : ['review-chapter', 'review-chapter-rebuild']))
        throw new Error('purposes')
      const savedOperation = result.operations.find(item => item.operation === operation.id)
      const artifact = chain[operation.kind === 'review' ? 'review' : operation.kind === 'refine' ? 'revision' : 'finalReview']
      if (savedOperation.outputHash !== artifact.contentHash
        || attempts.length === 2 && !reviewParseFailure(fs.readFileSync(attempts[0].outputPath, 'utf8'))) throw new Error('operation-artifact')
      if (operation.kind !== 'refine') parseReviewGenerationResult(stripDraftThinkingTags(fs.readFileSync(attempts.at(-1).outputPath, 'utf8')))
      for (const attempt of attempts) {
        const actual = attempt.binding.actual, terminal = result.ownerTerminal.find(item => item.attemptId === actual?.attemptId)
        if (attempt.binding.invocationId !== result.invocationId || attempt.binding.phase !== result.phase
          || attempt.binding.codeSha !== result.codeSha || attempt.binding.sourceHash !== result.sourceHash
          || attempt.binding.driverHash !== result.driverHash || attempt.binding.protocolHash !== result.protocolHash
          || attempt.binding.diagnosticInputHash !== result.diagnosticInputHash
          || attempt.binding.diagnosticSourceHash !== digest(policy.source) || attempt.attemptId !== `candidate:${actual?.attemptId}`
          || actual.projectId !== result.physicalProject.projectId || actual.epoch !== result.projectEpoch
          || actual.runId !== savedOperation.handle?.runId || actual.rootActionId !== savedOperation.handle?.rootActionId
          || terminal?.status !== 'settled' || terminal.finishReason !== 'stop' || terminal.purpose !== actual.purpose
          || terminal.hasFormalEffect !== (attempt === attempts.at(-1)) || !terminal.artifactId
          || terminal.textHash !== attempt.visibleTextHash || attempt.finishReason !== 'stop'
          || attempt.nativePlannedAttempt?.requestedOutputTokens !== 16384 || attempt.nativePlannedAttempt.status !== 'dispatch-marked'
          || digest(fs.readFileSync(attempt.outputPath)) !== attempt.visibleTextHash || attempt.requestedOutputTokens !== 16384)
          throw new Error('owner')
      }
    }
    if (stableEvidence(ordered.map(item => item.attemptId)) !== stableEvidence(result.attempts.map(item => item.attemptId))) throw new Error('order')
    return { valid: true, status: policy.automatedOutcomeCeiling }
  } catch { return { valid: false, status: 'failed', code: 'BOUNDED_REVISION_EVIDENCE_INVALID' } }
}
export function productionBridgeHash() {
  return digest([PRODUCTION_BRIDGE, 'scripts/quality-modernization-driver.mjs'].map(file => [file, digest(fs.readFileSync(path.join(ADAPTER_ROOT, file)))]))
}
export function productionExecutionRuntime(target) {
  const require = createRequire(path.join(target.repositoryRoot, 'package.json'))
  return target.arm === 'baseline'
    ? { executable: require('electron'), electronRunAsNode: true }
    : { executable: process.execPath, electronRunAsNode: false }
}
export function selectOwnerDispatch(db, handle, session, body) {
  const rows = db.prepare("SELECT a.*,r.binding_json FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE json_extract(a.attempt_json,'$.status')='dispatch-marked'").all()
  if (rows.length !== 1) throw new Error('NON_UNIQUE_OWNER_DISPATCH')
  const row = rows[0], binding = JSON.parse(row.binding_json), attempt = JSON.parse(row.attempt_json)
  if (!handle || row.run_id !== handle.runId || row.root_action_id !== handle.rootActionId
    || handle.projectId !== session.projectId || handle.epoch !== session.leaseId
    || binding.projectId !== session.projectId || binding.epoch !== session.leaseId
    || attempt.attemptId !== row.attempt_id
    || attempt.requestedOutputTokens !== (body.max_tokens ?? body.max_completion_tokens)) throw new Error('OWNER_DISPATCH_IDENTITY_MISMATCH')
  return { attemptId: row.attempt_id, runId: row.run_id, rootActionId: row.root_action_id,
    projectId: binding.projectId, epoch: binding.epoch, purpose: JSON.parse(row.usage_receipt_json ?? '{}').purpose }
}

/**
 * 单个 attempt 的桥内结算预算。三个串行 attempt 的完整窗口必须短于父进程
 * spawn 预算，而 spawn 预算再短于 Vitest 超时，给 unknown 落账与进程收尾留出余量。
 */
export const BRIDGE_SETTLEMENT_DEADLINE_MS = 480_000
export const BRIDGE_SPAWN_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS * 3 + 60_000
export const BRIDGE_TEST_TIMEOUT_MS = BRIDGE_SPAWN_TIMEOUT_MS + 60_000
// post-UI 每臂最多 15 个登记 attempt：目录 3、正文 8、首审 2、修稿 1、复评 1；产品自身 root 预算仍先行约束。
export const BRIDGE_REVIEWED_TEST_TIMEOUT_MS = BRIDGE_SETTLEMENT_DEADLINE_MS * 15 + 120_000
const QUALIFICATION_WINDOW_HASH = '64d634a4fa20fbafbbe3103c43e4a2c9959e3a6be64aaed7404060ff5be5932b'

/** Resolve only the registered bridge fallback; native owner budgets and dispatch gates remain authoritative. */
export function qualificationBridgeWindows(request) {
  if (['saved-native-review-diagnostic', 'planning-native-diagnostic'].includes(request.phase)) {
    const planning = request.phase === 'planning-native-diagnostic'
    const policy = planning ? PLANNING_NATIVE_DIAGNOSTIC : SAVED_NATIVE_REVIEW_DIAGNOSTIC
    if (request.milestone !== 'diagnostic' || (request.arm ?? request.target?.arm) !== 'candidate'
      || request.scenarioRevision !== policy.scenarioRevision
      || stableEvidence(request.operations) !== stableEvidence((planning ? planningNativeOperations : savedNativeOperations)(request.caseId, request.nativeAction, request.action))
      || stableEvidence(request.attemptPolicy) !== stableEvidence(policy.attemptPolicy)
      || stableEvidence(request.evaluationPolicy) !== stableEvidence(policy.evaluationPolicy)
      || request.forwardQualificationWindow != null || Object.keys(request).some(key => /timeout|deadline/iu.test(key)))
      throw new Error('SAVED_NATIVE_SCOPE_MISMATCH')
    const attemptMs = MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs + 60_000
    const maxCalls = ['prepare', 'resume-preflight'].includes(request.action) ? 0 : planning
      ? request.operations.reduce((sum, item) => sum + policy.physicalRequestBounds[item.id], 0) : request.operations.length * 4
    return { attemptMs, spawnMs: Math.max(1, maxCalls) * attemptMs + 60_000,
      testMs: Math.max(1, maxCalls) * attemptMs + 120_000, maxCalls, revision: policy.scenarioRevision }
  }
  if (request.phase === 'r3-native-revision-diagnostic') {
    const policy = R3_NATIVE_REVISION_DIAGNOSTIC
    if (request.milestone !== 'diagnostic' || (request.arm ?? request.target?.arm) !== 'candidate'
      || request.caseId !== 'R3' || request.scenarioRevision !== policy.scenarioRevision
      || stableEvidence(request.operations) !== stableEvidence(policy.operations)
      || stableEvidence(request.attemptPolicy) !== stableEvidence(policy.attemptPolicy)
      || stableEvidence(request.evaluationPolicy) !== stableEvidence(policy.evaluationPolicy)
      || request.forwardQualificationWindow != null || Object.keys(request).some(key => /timeout|deadline/iu.test(key)))
      throw new Error('R3_NATIVE_SCOPE_MISMATCH')
    const attemptMs = MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs + 60_000
    return { attemptMs, spawnMs: attemptMs * policy.maxPhysicalRequests + 60_000,
      testMs: attemptMs * policy.maxPhysicalRequests + 120_000, maxCalls: policy.maxPhysicalRequests, revision: policy.scenarioRevision }
  }
  if (request.phase === 'separated-review-diagnostic') {
    const phase = JSON.parse(fs.readFileSync(path.join(ADAPTER_ROOT, 'docs/research/novel-quality-modernization/protocol.json'))).phases[request.phase]
    const slot = phase?.operations?.find(item => item.id === request.operationId)
    if (!slot || phase.diagnosticId !== request.diagnosticId || phase.nonQualification !== true
      || phase.maxPhysicalRequests !== 6 || phase.operations.length !== 6 || request.milestone !== 'diagnostic'
      || (request.arm ?? request.target?.arm) !== 'candidate' || request.caseId !== slot.sourceId
      || stableEvidence(request.operations) !== stableEvidence([slot]) || !['prepare', 'execute'].includes(request.action)
      || request.forwardQualificationWindow != null || Object.keys(request).some(key => /timeout|deadline/iu.test(key)))
      throw new Error('SEPARATED_REVIEW_DIAGNOSTIC_SCOPE_MISMATCH')
    const attemptMs = MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs + 60_000
    return { attemptMs, spawnMs: attemptMs + 60_000, testMs: attemptMs + 120_000,
      maxCalls: 1, revision: phase.diagnosticId }
  }
  const registration = request.forwardQualificationWindow
  if (registration == null) return { attemptMs: BRIDGE_SETTLEMENT_DEADLINE_MS,
    spawnMs: request.evaluationPolicy ? BRIDGE_REVIEWED_TEST_TIMEOUT_MS - 60_000 : BRIDGE_SPAWN_TIMEOUT_MS,
    testMs: request.evaluationPolicy ? BRIDGE_REVIEWED_TEST_TIMEOUT_MS : BRIDGE_TEST_TIMEOUT_MS,
    maxCalls: null, revision: null }
  if (digest(registration) !== QUALIFICATION_WINDOW_HASH
    || registration.revision !== 'native-budget-aligned-qualification-window-v5'
    || request.forwardReasoning?.revision !== 'fixed-high-zero-temperature-v1'
    || request.forwardReasoning.model?.temperature !== 0
    || request.phase !== 'bounded-revision-diagnostic' && (request.forwardReasoning.stageModels
      ? stableEvidence(request.forwardReasoning.stageModels) !== stableEvidence(QUALIFICATION_STAGE_MODELS)
        || modelConfigurationHash(request.forwardReasoning.model) !== QUALIFICATION_STAGE_MODELS.profiles.flash.configurationHash
      : request.forwardReasoning.model?.modelName !== 'deepseek-ai/DeepSeek-V4-Pro')
    || request.forwardReasoning.reasoningOverride !== 'high'
    || MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs !== 3_600_000)
    throw new Error('FORWARD_QUALIFICATION_WINDOW_REGISTRATION_MISMATCH')
  if (Object.keys(request).some(key => /timeout|deadline/iu.test(key)))
    throw new Error('FORWARD_QUALIFICATION_WINDOW_REQUEST_MISMATCH')
  const bounded = request.phase === 'bounded-revision-diagnostic'
  const scope = bounded ? { caseIds: BOUNDED_REVISION_DIAGNOSTIC.caseIds }
    : registration.scopes.find(item => item.phase === request.phase && item.milestone === request.milestone)
  const scenario = request.phase === 'full' && request.scenarioRevision === PHASE_SCENARIOS.full.scenarioRevision
    ? PHASE_SCENARIOS.full : productionScenario(request.phase, request.milestone, request.protocolRevision)
  if (!scope?.caseIds.includes(request.caseId) || !scenario
    || stableEvidence(request.attemptPolicy ?? null) !== stableEvidence(scenario.attemptPolicy ?? null)
    || stableEvidence(request.evaluationPolicy ?? null) !== stableEvidence(scenario.evaluationPolicy ?? null)
    || request.scenarioRevision !== scenario.scenarioRevision
    || !['baseline', 'candidate'].includes(request.arm ?? request.target?.arm)
    || bounded && (request.milestone !== 'diagnostic' || (request.arm ?? request.target?.arm) !== 'candidate'))
    throw new Error('FORWARD_QUALIFICATION_WINDOW_SCOPE_MISMATCH')
  const attemptMs = MAIN_GENERATION_POLICY.budget.maxActiveElapsedMs + 60_000
  if (request.action === 'prepare') {
    if (stableEvidence(request.operations) !== stableEvidence(request.phase === 'full' ? [] : scenario.operations))
      throw new Error('FORWARD_QUALIFICATION_WINDOW_SCOPE_MISMATCH')
    return { attemptMs, spawnMs: attemptMs + 60_000, testMs: attemptMs + 120_000,
      maxCalls: 1, revision: registration.revision }
  }
  const operations = request.operations
  const expected = request.phase === 'c16-c18' ? continuityCaseOperations(request.caseId)
    : request.phase === 'full' ? operations?.[0]?.kind === 'draft' && scenario.evaluationPolicy
      ? scenario.operations.slice(1) : scenario.operations.filter(item => item.id === operations?.[0]?.id && item.kind === operations?.[0]?.kind
        && (item.kind !== 'directory' || request.caseId.endsWith('/1')))
      : scenario.operations
  if (request.action !== 'execute' || stableEvidence(operations) !== stableEvidence(expected)
    || request.phase === 'full' && expected.length !== (operations?.[0]?.kind === 'draft' && scenario.evaluationPolicy ? 4 : 1))
    throw new Error('FORWARD_QUALIFICATION_WINDOW_SCOPE_MISMATCH')
  const arm = request.arm ?? request.target.arm
  const policy = request.attemptPolicy
  const count = operation => {
    if (bounded && ['review', 'final-review'].includes(operation.kind)) return 2
    if (request.evaluationPolicy?.revision === AI_REVIEW_FINAL_MANUSCRIPT_POLICY.revision) {
      if (['review', 'final-review'].includes(operation.kind)) return 2
      if (operation.kind === 'refine') return 4
    }
    if (operation.kind === 'character_cards' && request.phase === 'c16-c18') return 3
    if (operation.kind === 'directory' && structuredRecoveryFor(policy, arm)?.operationId === operation.id)
      return planBlueprintGenerationCost(request.phase === 'full' ? 3 : 1).maxCalls
    if (operation.kind === 'draft' && draftRecoveryFor(policy, arm)?.operationIds.includes(operation.id))
      return draftRecoveryFor(policy, arm).maxAttempts
    if (operation.kind === 'review' && policy?.reviewRebuild?.operationId === operation.id)
      return 1 + policy.reviewRebuild.maxRepairAttempts
    return 1
  }
  const maxCalls = operations.reduce((sum, operation) => sum + count(operation)
    + Number(Boolean(policy?.shortOutline?.operationIds.includes(operation.id))), 0)
  return { attemptMs, spawnMs: maxCalls * attemptMs + 60_000,
    testMs: maxCalls * attemptMs + 120_000, maxCalls, revision: registration.revision }
}

/** 只测规模、不落内容：返回提示词载荷的 UTF-8 字节数，绝不含提示词原文或凭据。 */
export function measurePromptBytes(messages) {
  return Buffer.byteLength(JSON.stringify(messages ?? []), 'utf8')
}

/** Deterministic outbound checks fail before campaign accounting and stay out of network diagnostics. */
export function createOutboundPreflightAssert(failures) {
  if (!Array.isArray(failures)) throw new Error('PREFLIGHT_FAILURES_REQUIRED')
  return (condition, code) => {
    if (condition) return
    failures.push(code)
    throw new Error(code)
  }
}

/** Forward-only experiment: verify the saved preference separately from each arm's natural wire. */
export function assertForwardReasoning(registration, { arm, phase, milestone, caseId, model, creativeStrategy, resolution, body, operationId }) {
  const planning = phase === 'planning-native-diagnostic'
  if (planning && (registration?.revision !== PLANNING_NATIVE_DIAGNOSTIC.scenarioRevision
    || milestone !== 'diagnostic' || caseId !== PLANNING_NATIVE_DIAGNOSTIC.caseId
    || operationId && !PLANNING_NATIVE_DIAGNOSTIC.operations.some(item => item.id === operationId)))
    throw new Error('PLANNING_NATIVE_MODEL_SCOPE_MISMATCH')
  const saved = phase === 'saved-native-review-diagnostic'
  if (saved && (registration?.revision !== SAVED_NATIVE_REVIEW_DIAGNOSTIC.scenarioRevision
    || milestone !== 'diagnostic' || !SAVED_NATIVE_REVIEW_DIAGNOSTIC.caseIds.includes(caseId)
    || operationId && !SAVED_NATIVE_REVIEW_DIAGNOSTIC.operations.some(item => item.id === operationId && item.caseIds.includes(caseId))))
    throw new Error('SAVED_NATIVE_MODEL_SCOPE_MISMATCH')
  const staged = registration?.stageModels
  if (staged && (stableEvidence(staged) !== stableEvidence(QUALIFICATION_STAGE_MODELS)
    || arm !== 'candidate' || !registration.scopes?.some(scope => scope.phase === phase && scope.milestone === milestone
      && (!caseId || scope.caseIds.includes(caseId))))) throw new Error('QUALIFICATION_MODEL_SCOPE_MISMATCH')
  const stageProfile = staged ? qualificationModelForOperation(phase, milestone, operationId) : null
  if (stageProfile && modelConfigurationHash(model) !== stageProfile.configurationHash) throw new Error('QUALIFICATION_MODEL_CONFIGURATION_DRIFT')
  if (planning || saved || phase === 'r3-native-revision-diagnostic' || stageProfile) {
    const profile = planning ? PLANNING_NATIVE_DIAGNOSTIC.modelProfile : saved ? SAVED_NATIVE_REVIEW_DIAGNOSTIC.modelProfile : stageProfile ?? r3ModelForOperation(operationId ?? R3_NATIVE_REVISION_DIAGNOSTIC.operations[0].id)
    const expected = profile.model
    if (arm !== 'candidate' || !planning && !saved && !staged && (milestone !== 'diagnostic' || caseId !== 'R3'
      || registration?.revision !== R3_NATIVE_REVISION_DIAGNOSTIC.scenarioRevision) || creativeStrategy !== 'auto'
      || modelConfigurationHash(model) !== profile.configurationHash) throw new Error('R3_NATIVE_MODEL_MISMATCH')
    if (body === undefined) return null
    const outputTokens = body.max_tokens ?? body.max_completion_tokens
    if (body.model !== expected.modelName || body.temperature !== expected.temperature
      || (stageProfile || saved || planning ? !Number.isSafeInteger(outputTokens) || outputTokens <= 0 || outputTokens > expected.maxTokens
        : outputTokens !== expected.maxTokens)
      || body.thinking?.type !== 'enabled' || body.reasoning_effort !== expected.reasoningOverride
      || Object.hasOwn(body, 'enable_thinking') || Object.hasOwn(body, 'thinking_budget')
      || resolution?.requested !== expected.reasoningOverride || resolution.effective !== expected.reasoningOverride
      || resolution.status !== 'mapped' || resolution.source !== 'model-override') throw new Error('R3_NATIVE_WIRE_MISMATCH')
    return { requested: expected.reasoningOverride, effective: expected.reasoningOverride, status: resolution.status, source: resolution.source,
      wire: { thinking: { present: true, value: { type: 'enabled' } }, reasoning_effort: { present: true, value: expected.reasoningOverride },
        enable_thinking: { present: false }, thinking_budget: { present: false } } }
  }
  const scope = registration?.scopes?.find(item => item.phase === phase && item.milestone === milestone)
  const effort = registration?.reasoningOverride
  if (!scope || caseId && !scope.caseIds.includes(caseId) || !['baseline', 'candidate'].includes(arm)
    || !(effort === 'max' || effort === 'high' && registration.revision === 'fixed-high-zero-temperature-v1'
      && registration.model?.temperature === 0)
    || effort === 'high' && phase !== 'bounded-revision-diagnostic' && registration.model?.modelName !== 'deepseek-ai/DeepSeek-V4-Pro'
    || registration.creativeStrategy !== 'auto' || registration.wireParity !== false
    || registration.wire?.candidate?.enable_thinking !== true || registration.wire.candidate.reasoning_effort !== effort
    || registration.wire?.baseline?.enable_thinking !== 'absent' || registration.wire.baseline.reasoning_effort !== 'absent'
    || !model || ['provider', 'protocol', 'baseUrl', 'modelName', 'temperature', 'maxTokens']
      .some(key => model[key] !== registration.model?.[key])
    || model.reasoningOverride !== registration.reasoningOverride || creativeStrategy !== registration.creativeStrategy)
    throw new Error('FORWARD_REASONING_CONFIG_MISMATCH')
  if (body === undefined) return null
  const present = key => Object.hasOwn(body, key)
  if (present('thinking_budget') || (arm === 'candidate'
    ? !present('enable_thinking') || body.enable_thinking !== true || !present('reasoning_effort') || body.reasoning_effort !== effort
    : present('enable_thinking') || present('reasoning_effort'))) throw new Error('FORWARD_REASONING_WIRE_MISMATCH')
  if (arm === 'candidate' && (resolution?.requested !== effort || resolution.effective !== effort
    || resolution.status !== 'mapped' || resolution.source !== 'model-override')) throw new Error('FORWARD_REASONING_RESOLUTION_MISMATCH')
  const observed = key => present(key) ? { present: true, value: body[key] } : { present: false }
  return { requested: effort, effective: arm === 'candidate' ? resolution.effective : null,
    status: arm === 'candidate' ? resolution.status : 'not-exposed-by-baseline',
    source: arm === 'candidate' ? resolution.source : 'profile-readback',
    wire: { enable_thinking: observed('enable_thinking'), reasoning_effort: observed('reasoning_effort'),
      thinking_budget: observed('thinking_budget') } }
}

/** One quoted-input extraction request; all checks run before the campaign reserve. */
export function assertSharedInputDiagnostic(registration, input, { arm, model, body, reserved, operation, inputHash }) {
  if (registration?.diagnosticId === 'separated-review-diagnostic-3x2-v1') {
    const slot = registration.operations?.find(item => item.id === operation)
    const supplied = input?.operations?.find(item => item.id === operation)
    const source = input?.sources?.find(item => item.id === slot?.sourceId)
    if (!slot || !supplied || !source || registration.nonQualification !== true || registration.maxPhysicalRequests !== 6
      || registration.responseFormat !== 'native-default' || input?.modelParameters?.responseFormat !== 'native-default'
      || arm !== 'candidate' || input?.diagnosticId !== registration.diagnosticId
      || !/^[a-f0-9]{64}$/u.test(registration.diagnosticInputHash ?? '') || inputHash !== registration.diagnosticInputHash
      || input.sources.length !== 3 || input.operations.length !== 6 || registration.operations.length !== 6
      || stableEvidence(input.operations.map(item => item.id)) !== stableEvidence(registration.operations.map(item => item.id))
      || ['sourceId', 'role', 'originalInvocationId', 'originalTestedSha', 'contentSha256', 'contextHash', 'materialsSha256', 'messagesSha256']
        .some(key => supplied[key] !== slot[key])
      || supplied.materialsSourceId !== source.id
      || typeof source.materials?.source?.content !== 'string' || !source.frozenContext || !source.materials
      || digest(source.materials?.source?.content) !== slot.contentSha256
      || digest(source.frozenContext) !== slot.contextHash || digest(source.materials) !== slot.materialsSha256
      || digest(supplied.messages) !== slot.messagesSha256
      || !Array.isArray(supplied.messages) || supplied.messages.length !== 2
      || supplied.messages[0].role !== 'system' || supplied.messages[1].role !== 'user'
      || supplied.messages.some(item => typeof item.content !== 'string' || !item.content.trim())
      || reserved !== undefined && reserved !== registration.operations.findIndex(item => item.id === operation))
      throw new Error('SEPARATED_REVIEW_DIAGNOSTIC_INPUT_MISMATCH')
    if (!model || registration.model?.temperature !== 0 || registration.model.reasoningOverride !== 'high'
      || registration.model.maxTokens !== 16384 || registration.model.creativeStrategy !== 'auto'
      || Object.entries(registration.model).some(([key, value]) => model[key] !== value))
      throw new Error('SEPARATED_REVIEW_DIAGNOSTIC_CONFIG_MISMATCH')
    if (body !== undefined && (body.model !== registration.model.modelName || body.temperature !== 0
      || digest(body.messages) !== slot.messagesSha256 || !Number.isSafeInteger(body.max_tokens)
      || body.max_tokens <= 0 || body.max_tokens > registration.model.maxTokens
      || body.enable_thinking !== true || body.reasoning_effort !== 'high' || Object.hasOwn(body, 'thinking_budget')
      || Object.hasOwn(body, 'response_format')
      || body.stream !== true || body.stream_options?.include_usage !== true))
      throw new Error('SEPARATED_REVIEW_DIAGNOSTIC_WIRE_MISMATCH')
    return supplied
  }
  const original = input?.originalMessages, messages = input?.messages
  const quote = input?.originalUserWrapper
  if (!registration?.nonQualification || registration.maxPhysicalRequests !== 1 || arm !== 'candidate' || reserved !== 0
    || input?.diagnosticId !== 'shared-input-fact-extraction-9337909d-v1'
    || input.originalMessagesSha256 !== registration.originalMessagesSha256
    || input.messagesSha256 !== registration.messagesSha256
    || digest(original) !== registration.originalMessagesSha256 || digest(messages) !== registration.messagesSha256
    || stableEvidence(input.materials) !== stableEvidence(registration.materials)
    || input.originalInvocationId !== registration.originalInvocationId || input.originalTestedSha !== registration.originalTestedSha
    || stableEvidence(input.originalCaseIds) !== stableEvidence(registration.originalCaseIds)
    || !Array.isArray(original) || original.length !== 2 || !Array.isArray(messages) || messages.length !== 2
    || original[0].role !== 'system' || original[1].role !== 'user'
    || messages[0].role !== 'system' || messages[1].role !== 'user'
    || typeof quote?.prefix !== 'string' || typeof quote?.suffix !== 'string'
    || quote.prefix + original[1].content + quote.suffix !== messages[1].content
    || !quote.prefix.includes(original[0].content) || quote.prefix.split(original[0].content).length !== 2
    || messages[1].content.split(original[1].content).length !== 2)
    throw new Error('SHARED_INPUT_DIAGNOSTIC_INPUT_MISMATCH')
  if (!model || Object.entries(registration.model).some(([key, value]) => model[key] !== value)
    || body?.model !== registration.model.modelName || body.temperature !== registration.model.temperature
    || digest(body.messages) !== registration.messagesSha256 || body.max_tokens !== registration.actualMaxTokens
    || body.enable_thinking !== true || body.reasoning_effort !== 'max' || Object.hasOwn(body, 'thinking_budget')
    || body.stream !== true || body.stream_options?.include_usage !== true)
    throw new Error('SHARED_INPUT_DIAGNOSTIC_WIRE_MISMATCH')
}

export function rejectOutsidePhysicalBoundary(receipt) {
  createOutboundPreflightAssert(receipt.preflightFailures ??= [])(false, 'NETWORK_OUTSIDE_PHYSICAL_BOUNDARY')
}
export function assertNoOutboundPreflightFailures(receipt) {
  if (receipt.preflightFailures?.length) throw new Error('OUTBOUND_PREFLIGHT_FAILURES')
}

/** The only place where provider transport failures enter fetchFailures. */
export async function fetchProviderResponse(fetcher, url, options, failures, diagnostic = value => String(value)) {
  if (typeof fetcher !== 'function' || !Array.isArray(failures)) throw new Error('PROVIDER_FETCH_ARGUMENTS_INVALID')
  let response
  try { response = await fetcher(url, options) }
  catch (error) {
    failures.push(diagnostic(error instanceof Error ? error.message : String(error)))
    throw error
  }
  if (!response?.ok || !response.body) {
    failures.push('PROVIDER_HTTP_FAILED')
    throw new Error('PROVIDER_HTTP_FAILED')
  }
  return response
}

/**
 * 桥自身的结算守护：每个 dispatch attempt 各自持有一个短于桥测试超时的截止时间。
 *
 * 桥测试的 120s 超时是进程内的 JS 计时器：它不投递任何信号，也不会先运行 finally，
 * 所以「等网络流结束后再写 settle/unknown」在供应商卡住时永远等不到——账本里只剩
 * reserve+dispatch，这次发送既不 settle 也不 unknown，花费不可审计，也违反了
 * 「dispatch 之后必须 settle 或 unknown，未知不得退款」的规则。这里让桥自己持有
 * 截止时间：
 *   - terminal(): 幂等。同一 attemptId 只写一条 settle/unknown，重复调用是 no-op，
 *     因此「刚写 unknown 又想把同一次发送改写为 settle」不可能发生。
 *   - 到点: 先为该 attempt 写 unknown（占用、不退款），再 abort 它的 fetch，
 *     让等待方以失败结束——先落账，后失败。后续 attempt 从各自 dispatch 起获得完整预算；
 *     dispatch 之前的取消仍然只走 cancel。
 *
 * 被拒绝的方案：改用 process 信号/退出钩子收尾。测试超时是进程内计时器，不发送任何
 * 信号，SIGTERM 处理器根本不会触发；'exit' 处理器必须同步、无法等待未决的流；而工作
 * 进程被强杀（SIGKILL/terminate）时两者都不会运行。守护计时器活在同一个事件循环里：
 * await 网络时事件循环是空闲的，所以它一定会跑；正常收尾时由 dispose() 明确清除。
 */
export function createAttemptSupervisor({ record, deadlineMs = BRIDGE_SETTLEMENT_DEADLINE_MS } = {}) {
  if (typeof record !== 'function') throw new Error('SUPERVISOR_RECORD_REQUIRED')
  const open = new Map()
  const closed = new Set()
  const timers = new Map()
  const expired = new Set()
  const terminal = (attemptId, type, extra = {}) => {
    if (closed.has(attemptId)) return false
    // 先写账本再记终态：写失败（例如 LEDGER_BUSY）不吞掉终态，调用方仍可重试。
    record({ type, attemptId, ...extra })
    closed.add(attemptId)
    open.delete(attemptId)
    const timer = timers.get(attemptId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(attemptId)
    return true
  }
  const expireAttempt = attemptId => {
    const controller = open.get(attemptId)
    if (!open.has(attemptId)) return
    expired.add(attemptId)
    try { terminal(attemptId, 'unknown', { reasonCode: 'BRIDGE_SETTLEMENT_DEADLINE_EXCEEDED' }) } catch { /* 账本暂不可写也必须继续 abort */ }
    try { controller?.abort?.(new Error('ATTEMPT_DEADLINE_EXCEEDED')) } catch { /* ignore */ }
  }
  return {
    watch(attemptId, controller) {
      open.set(attemptId, controller ?? null)
      if (deadlineMs > 0) timers.set(attemptId, setTimeout(() => expireAttempt(attemptId), deadlineMs))
    },
    terminal,
    dispose: () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear() },
    expired: attemptId => attemptId ? expired.has(attemptId) : expired.size > 0,
    openAttempts: () => open.size,
  }
}
export function writeProductionReceipt(file, receipt, secrets = []) {
  const bytes = secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), JSON.stringify(receipt, null, 2) + '\n')
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
  return bytes
}

function readBridgeReceipt(file) {
  if (!fs.existsSync(file)) return null
  try {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(receipt?.attempts) || receipt.attempts.some(attempt => !attempt?.attemptId || !attempt.binding)
      || new Set(receipt.attempts.map(attempt => attempt.attemptId)).size !== receipt.attempts.length)
      throw new Error('INVALID_ATTEMPTS')
    return receipt
  } catch (cause) { throw new Error('BRIDGE_RECEIPT_OWNERSHIP_INVALID', { cause }) }
}

function bridgeOwnedAttempts(request, receipt, previousIds) {
  if (!receipt) return []
  const owned = receipt.attempts.filter(attempt => !previousIds.has(attempt.attemptId))
  if (!owned.length) return []
  const expected = { ...Object.fromEntries(['invocationId', 'mode', 'phase', 'milestone', 'caseId', 'protocolRevision', 'protocolHash', 'driverHash']
    .map(key => [key, request[key]])), arm: request.target.arm, codeSha: request.target.codeSha, sourceHash: request.target.sourceHash }
  const reject = () => { throw new Error('BRIDGE_RECEIPT_OWNERSHIP_MISMATCH') }
  if (receipt.action !== request.action || Object.entries(expected).some(([key, value]) => !value || receipt[key] !== value)) reject()
  const physical = receipt.physicalProject
  if (!physical?.path || !physical.projectId || !receipt.projectEpoch || !physical.parityHash) reject()
  const projectPath = fs.realpathSync(physical.path)
  const relative = path.relative(fs.realpathSync(request.target.roots.project), projectPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) reject()
  if (receipt.restoration && (receipt.restoration.targetProjectId !== physical.projectId
    || !receipt.restoration.targetProjectRoot || fs.realpathSync(receipt.restoration.targetProjectRoot) !== projectPath)) reject()
  for (const attempt of owned) {
    const binding = attempt.binding, owner = request.target.arm === 'candidate' ? binding.actual : binding.baselineIpc
    if (Object.entries(expected).some(([key, value]) => binding[key] !== value)
      || !request.operations.some(operation => operation.id === binding.operation)
      || binding.parityId !== physical.parityHash
      || !owner || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch', 'purpose'].some(key => typeof owner[key] !== 'string' || !owner[key])
      || attempt.attemptId !== `${request.target.arm}:${owner.attemptId}`
      || owner.projectId !== physical.projectId || owner.epoch !== receipt.projectEpoch
      || request.target.arm === 'baseline' && owner.operationId !== binding.operation) reject()
  }
  return owned.map(({ attemptId, binding }) => ({ attemptId, binding }))
}

export function runProductionBridge(request) {
  const target = request.target
  const windows = qualificationBridgeWindows(request)
  const evidenceRoot = request.evidenceRoot ?? target.isolationRoot
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const runtime = productionExecutionRuntime(target)
  const testTimeout = windows.testMs
  const requestFile = path.join(evidenceRoot, `${request.action}-request.json`)
  const config = path.join(evidenceRoot, `${request.action}-production-bridge.vitest.config.mjs`)
  const report = path.join(evidenceRoot, `${request.action}-vitest.json`)
  request.receiptPath = path.join(evidenceRoot, `${request.action}-receipt.json`)
  const lock = `${request.receiptPath}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx') }
  catch (error) { if (error.code === 'EEXIST') throw new Error('PRODUCTION_BRIDGE_BUSY'); throw error }
  try {
    const previousIds = new Set((readBridgeReceipt(request.receiptPath)?.attempts ?? []).map(attempt => attempt.attemptId))
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2))
    fs.writeFileSync(config, `export default ${JSON.stringify({
      root: ADAPTER_ROOT,
      resolve: { alias: { vitest: path.join(target.repositoryRoot, 'node_modules/vitest/dist/index.js'),
        electron: path.join(target.repositoryRoot, 'node_modules/electron/index.js') } },
      test: { include: [PRODUCTION_BRIDGE], exclude: [], environment: 'node',
        globals: false, maxWorkers: 1, fileParallelism: false, testTimeout },
    })}\n`)
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(env, { QUALITY_BRIDGE_REQUEST: requestFile, QUALITY_USER_DATA: target.roots.userData,
      HOME: target.roots.userData, USERPROFILE: target.roots.userData, APPDATA: target.roots.userData, LOCALAPPDATA: target.roots.userData,
      TEMP: target.isolationRoot, TMP: target.isolationRoot, AI_NOVEL_APP_DATA_HOME: target.roots.config,
      AI_NOVEL_LEGACY_SOURCE_HOME: target.roots.legacySource,
      AI_NOVEL_VELA_HOME: target.arm === 'baseline' ? target.roots.config : target.roots.legacySource,
      ...(runtime.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) })
    const guard = path.join(evidenceRoot, `${request.action}-network-denied.mjs`)
    if (request.mode === 'synthetic') fs.writeFileSync(guard, "import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{throw new Error('NETWORK_FORBIDDEN')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;tls.connect=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;syncBuiltinESMExports();")
    const argv = [...(request.mode === 'synthetic' ? ['--import', pathToFileURL(guard).href] : []), path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=json', `--outputFile=${report}`]
    const result = spawnSync(runtime.executable, argv, { cwd: target.repositoryRoot, env, encoding: 'utf8',
      timeout: windows.spawnMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    let ownedAttempts = [], failure, output
    try {
      const receipt = readBridgeReceipt(request.receiptPath)
      if (request.action === 'execute') ownedAttempts = bridgeOwnedAttempts(request, receipt, previousIds)
      const secrets = request.mode === 'real'
        ? JSON.parse(fs.readFileSync(path.join(target.roots.config, 'models.json'), 'utf8')).map(model => model.apiKey).filter(Boolean) : []
      const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value ?? ''))
      fs.writeFileSync(path.join(evidenceRoot, `${request.action}-stdout.log`), redact(result.stdout))
      fs.writeFileSync(path.join(evidenceRoot, `${request.action}-stderr.log`), redact(result.stderr))
      if (secrets.length && fs.existsSync(report)) fs.writeFileSync(report, redact(fs.readFileSync(report, 'utf8')))
      if (receipt?.runtimePaths && request.phase === 'planning-native-diagnostic') {
        receipt.sourcePids = [...new Set([...receipt.sourcePids, result.pid])]
        const processes = receipt.sourcePids.map(pid => {
          try { process.kill(pid, 0); return { pid, exited: false } }
          catch (error) { return { pid, exited: error.code === 'ESRCH' } }
        })
        const wal = `${receipt.runtimePaths.databasePath}-wal`
        receipt.sourceClosure = { ...receipt.sourceClosure, processes, exitCode: result.status, signal: result.signal,
          parentObservedWalBytes: fs.existsSync(wal) ? fs.statSync(wal).size : 0 }
        receipt.sourceClosed = receipt.sourceClosure.databaseClosed === true && receipt.sourceClosure.walBytes === 0
          && receipt.sourceClosure.parentObservedWalBytes === 0 && processes.every(item => item.exited)
          && result.status !== null && result.signal === null
        writeProductionReceipt(request.receiptPath, receipt, secrets)
      }
      if (result.status !== 0 || !receipt || !['prepared', 'passed'].includes(receipt.status)) {
        throw Object.assign(new Error('PRODUCTION_BRIDGE_FAILED'), { detail: receipt?.error, receiptPath: request.receiptPath,
          exitCode: result.status, stderrPath: path.join(evidenceRoot, `${request.action}-stderr.log`) })
      }
      const testReport = JSON.parse(fs.readFileSync(report, 'utf8'))
      if (testReport.numPassedTests !== 1 || testReport.numTotalTests !== 1) throw new Error('PRODUCTION_BRIDGE_COVERAGE_MISMATCH')
      output = { ...receipt, command: { executable: runtime.executable, argv, cwd: target.repositoryRoot, shell: false }, receiptPath: request.receiptPath }
    } catch (error) { failure = error }
    try {
      if (request.action === 'execute') reconcileDispatchedAttempts(request.ledgerPath, request.mode, ownedAttempts)
    } catch (error) {
      if (failure) {
        const businessCode = ['PRODUCTION_BRIDGE_FAILED', 'PRODUCTION_BRIDGE_COVERAGE_MISMATCH'].includes(failure.message)
          ? failure.message : 'PRODUCTION_BRIDGE_ERROR'
        const cleanupCode = ['LEDGER_BUSY', 'LEDGER_OWNERSHIP_MISMATCH', 'INVALID_LEDGER_TRANSITION'].includes(error.message)
          ? error.message : 'LEDGER_RECONCILIATION_ERROR'
        failure = new AggregateError([failure, error], `${businessCode}_AND_${cleanupCode}`)
      } else failure = error
    }
    if (failure) throw Object.assign(failure, { receiptPath: request.receiptPath })
    return output
  } finally { try { fs.closeSync(fd) } finally { fs.unlinkSync(lock) } }
}

/**
 * C17/C18 续写的唯一一次原生超长压缩（评分规则变更，随产品修复登记）：只在同一 run/root/项目/epoch
 * 的 chapter-draft 首请求已结算为 stop、且其 hash 可复核的输出按生产计数超出 draftTargetUnitRange
 * 上限时，才许可一次 chapter-draft-condense；它不是任意失败的新重试权，正式效果只能落在末次 attempt。
 */
export const C16_C18_ATTEMPT_POLICY = Object.freeze({ milestone: 'final', arms: Object.freeze(['candidate']),
  operationId: '续写成稿首审', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1,
  trigger: 'settled-stop-parse-or-shape-failure-with-native-artifact-hash',
  reviewRebuild: Object.freeze({ operationId: '续写成稿完整复审', primaryPurpose: 'review-chapter',
    repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 }),
  refinementRecovery: Object.freeze({ operationId: '续写成稿一次修稿', purpose: 'refine-from-review', maxAttempts: 4,
    trigger: 'settled-length-same-confirmation-visible-append-with-progress' }),
  draftRecovery: draftRecoveryPolicy(['本地恢复后续写', 'DAV选定世代恢复后续写']),
  draftCondense: Object.freeze({ operationIds: Object.freeze(['本地恢复后续写', 'DAV选定世代恢复后续写']),
    primaryPurpose: 'chapter-draft', condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
    trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum',
    formalEffect: 'last-attempt-only' }),
})
/**
 * 登记的唯一压缩按臂生效：`draftCondense.arms` 缺省时沿用 attemptPolicy.arms（C16–C18 的单臂策略）；
 * post-UI v3 显式只给 candidate。未登记或该臂不在其中返回 null——baseline 因此从不获压缩许可。
 */
export const draftCondenseFor = (attemptPolicy, arm) => {
  const condense = attemptPolicy?.draftCondense
  return condense && (condense.arms ?? attemptPolicy.arms ?? []).includes(arm) ? condense : null
}
/**
 * 开发合成才登记超长首稿：默认让 C16–C18 的 C17-A、post-UI 的场景1/1、full 的场景1/2（候选的第 2 章，其后第 3 章可见
 * 前驱取压缩稿）走「超长首稿→唯一压缩→在范围」；显式 syntheticDraftCondense（如 still-over）原样通过。
 * 正式合成（无 development）与真实模式不给计划，其余阶段/里程碑也不给。
 */
export function syntheticDraftCondensePlan(options) {
  if (options?.mode !== 'synthetic' || options.development !== true) return {}
  const caseId = options.phase === 'c16-c18' ? 'C17-A'
    : options.phase === 'early-budget' && options.milestone === 'post-ui' ? '场景1/1'
      : options.phase === 'full' ? '场景1/2' : null
  return caseId ? { syntheticDraftCondense: options.syntheticDraftCondense ?? { caseId, outcome: 'in-range' } } : {}
}
// A phase scenario is the bridge-side counterpart of one preregistered protocol phase.
// The protocol stays the only authority for case ids and operation ids; this map only
// says which production commands realize them. The runner re-checks every field against
// the selected protocol phase before opening the gate, so a drift here fails closed
// instead of quietly running a different experiment.
export const PHASE_SCENARIOS = Object.freeze({
  'bounded-revision-diagnostic': BOUNDED_REVISION_DIAGNOSTIC,
  'r3-native-revision-diagnostic': R3_NATIVE_REVISION_DIAGNOSTIC,
  'c16-c18': Object.freeze({
    caseId: 'C16-A', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C', 'C17-A', 'C17-B', 'C18-A', 'C18-B']),
    sceneId: '场景1', chapterNumber: 2, milestone: 'final', arms: Object.freeze(['candidate']),
    scenarioRevision: 'c16-c18-candidate-production-path-v7',
    attemptPolicy: C16_C18_ATTEMPT_POLICY,
    evaluationPolicy: AI_REVIEW_FINAL_MANUSCRIPT_POLICY,
    // 新运行直接首稿；历史对账收据仍由原冻结协议识别，不在当前实验登记发送。
    // v4（用户批准的 harness 变更）：C17-B 恢复副本内重新定稿后按产品定稿路径紧接生产后处理，
    // notes/cards 各为独立登记 operation，与 C16 同一 RunFinalizePostProcessCommand 入口，绑定新 finalizationId。
    operations: Object.freeze([
      Object.freeze({ id: '定稿章节要点', kind: 'chapter_notes', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C']) }),
      Object.freeze({ id: '定稿角色状态', kind: 'character_cards', caseIds: Object.freeze(['C16-A', 'C16-B', 'C16-C']) }),
      Object.freeze({ id: '本地恢复后续写', kind: 'draft', restore: 'local', caseIds: Object.freeze(['C17-A', 'C17-B']) }),
      Object.freeze({ id: 'DAV选定世代恢复后续写', kind: 'draft', restore: 'webdav', caseIds: Object.freeze(['C18-A', 'C18-B']) }),
      Object.freeze({ id: '恢复副本重新定稿章节要点', kind: 'chapter_notes', caseIds: Object.freeze(['C17-B']) }),
      Object.freeze({ id: '恢复副本重新定稿角色状态', kind: 'character_cards', caseIds: Object.freeze(['C17-B']) }),
      ...[['续写成稿首审', 'review'], ['续写成稿一次修稿', 'refine'], ['续写成稿完整复审', 'final-review']]
        .map(([id, kind]) => Object.freeze({ id, kind, caseIds: AI_REVIEW_FINAL_MANUSCRIPT_POLICY.caseIds })),
    ]),
  }),
  full: Object.freeze({
    caseIds: Object.freeze(['场景1/1', '场景1/2', '场景1/3', '场景2/1', '场景2/2', '场景2/3', '场景3/1', '场景3/2', '场景3/3']),
    milestone: 'final', scenarioRevision: 's14b-full-continuous-project-v3',
    attemptPolicy: FULL_ATTEMPT_POLICY,
    operations: Object.freeze([
      Object.freeze({ id: '三章规划', kind: 'directory' }),
      Object.freeze({ id: '连续章节正文', kind: 'draft' }),
    ]),
  }),
  'early-budget': Object.freeze({
    caseId: '场景1/1',
    sceneId: '场景1',
    chapterNumber: 1,
    milestone: 'early',
    scenarioRevision: 's14b-post-ui-budget-syntax-repair-v1',
    attemptPolicy: EARLY_BUDGET_ATTEMPT_POLICY,
    operations: Object.freeze([
      Object.freeze({ id: '指定范围生成', kind: 'directory' }),
      Object.freeze({ id: '900单位正文', kind: 'draft' }),
    ]),
  }),
  'early-context': Object.freeze({
    caseId: '场景2/3',
    sceneId: '场景2',
    chapterNumber: 3,
    milestone: 'early',
    scenarioRevision: 's10b-early-context-selection-difference-v3',
    selectionDifference: Object.freeze({
      requireDifferentPromptHash: true,
      requireDifferentPromptBytes: true,
      requireCandidateBudgetOmission: true,
      requireCandidateRequiredCoverage: true,
      requireBaselineSentCandidateOmission: true,
      requirePhysicalProjectParity: true,
    }),
    operations: Object.freeze([
      Object.freeze({ id: '长设定第三章正文', kind: 'draft' }),
    ]),
  }),
  'early-review': Object.freeze({
    caseId: '场景3/2',
    sceneId: '场景3',
    chapterNumber: 2,
    milestone: 'early',
    scenarioRevision: 's11-early-review-per-attempt-deadline-v3',
    operations: Object.freeze([
      Object.freeze({ id: '审稿', kind: 'review' }),
      Object.freeze({ id: '定向修稿', kind: 'refine' }),
      Object.freeze({ id: '一次复核', kind: 'recheck' }),
    ]),
  }),
})
/**
 * 一个 c16-c18 案例实际执行的登记 operation：先该案登记的定稿后处理（notes→cards），再该案的恢复续写。
 * driver 选择与结果侧校验共用这一个函数，不按下标切片。
 */
export function continuityCaseOperations(caseId) {
  const operations = PHASE_SCENARIOS['c16-c18'].operations.filter(operation => operation.caseIds.includes(caseId))
  return [...operations.filter(operation => ['chapter_notes', 'character_cards'].includes(operation.kind)),
    ...operations.filter(operation => operation.restore),
    ...operations.filter(operation => ['review', 'refine', 'final-review'].includes(operation.kind))]
}
/** 登记为定稿角色状态的 operation（含 C17-B 重新定稿后处理）共用产品原生 repair 的门禁规则。 */
export const FINALIZED_CHARACTER_OPERATION_IDS = Object.freeze(PHASE_SCENARIOS['c16-c18'].operations
  .filter(operation => operation.kind === 'character_cards').map(operation => operation.id))
export function productionScenario(phase, milestone, protocolRevision) {
  if (phase === 'planning-native-diagnostic') return PLANNING_NATIVE_DIAGNOSTIC
  if (phase === 'saved-native-review-diagnostic') return SAVED_NATIVE_REVIEW_DIAGNOSTIC
  if (phase === 'r3-native-revision-diagnostic') return R3_NATIVE_REVISION_DIAGNOSTIC
  const scenario = PHASE_SCENARIOS[phase]
  if (!scenario) throw new Error('PHASE_PRODUCTION_ADAPTER_NOT_INTEGRATED')
  const selected = phase === 'full' && milestone === 'final' ? { ...scenario, ...FULL_AI_REVIEW_SCENARIO }
    : milestone === 'post-ui' && POST_UI_AI_REVIEW_SCENARIOS[phase] ? { ...scenario, ...POST_UI_AI_REVIEW_SCENARIOS[phase] } : scenario
  if (protocolRevision !== CANDIDATE_ONLY_PROTOCOL_REVISION || milestone === 'diagnostic') return selected
  const reviewLengthRecovery = Boolean(selected.evaluationPolicy && ['final', 'post-ui'].includes(milestone))
  const recoverReview = policy => reviewLengthRecovery && policy?.primaryPurpose === 'review-chapter'
    ? { ...policy, maxLengthReplacements: 1 } : policy
  const draftIds = selected.operations.filter(operation => operation.kind === 'draft').map(operation => operation.id)
  const counts = phase === 'c16-c18' ? [20, 84] : phase === 'full' ? [30, 180]
    : phase === 'early-budget' ? [4, 20] : phase === 'early-context' ? [3, 17] : [1, 8]
  return { ...selected, milestone, arms: ['candidate'], templateSource: 'candidate-native',
    minimumCalls: counts[0], maximumPlannedCalls: counts[1],
    ...(selected.evaluationPolicy ? { evaluationPolicy: { ...selected.evaluationPolicy,
      physicalRequests: { ...selected.evaluationPolicy.physicalRequests, minimum: counts[0], maximum: counts[1],
        ...(phase === 'c16-c18' ? { sourceMinimum: 16, sourceMaximum: 52 }
          : phase === 'full' ? { sourceMinimum: 21, sourceMaximum: 108 } : {}) },
      armAsymmetry: 'candidate-only; no comparative claim' } } : {}),
    scenarioRevision: `${selected.scenarioRevision}-candidate-only-${reviewLengthRecovery ? 'v2' : 'v1'}`,
    ...(selected.selectionDifference ? { selectionDifference: { ...selected.selectionDifference,
      requireDifferentPromptHash: false, requireDifferentPromptBytes: false,
      requireBaselineSentCandidateOmission: false, requirePhysicalProjectParity: false } } : {}),
    attemptPolicy: { ...recoverReview(selected.attemptPolicy), arms: ['candidate'], milestone,
      ...Object.fromEntries(['reviewRebuild', 'finalReviewRebuild'].filter(key => selected.attemptPolicy?.[key])
        .map(key => [key, recoverReview(selected.attemptPolicy[key])])),
      ...(draftIds.length ? { draftRecovery: { ...draftRecoveryPolicy(draftIds), arms: ['candidate'] },
        draftCondense: { operationIds: draftIds, arms: ['candidate'], primaryPurpose: 'chapter-draft',
          condensePurpose: 'chapter-draft-condense', maxCondenseAttempts: 1,
          trigger: 'settled-stop-or-length-hash-verified-composed-units-above-draftTargetUnitRange-maximum', formalEffect: 'last-attempt-only' } } : {}),
      shortOutline: { purpose: 'chapter-draft-short-outline', operationIds: draftIds, maxAttempts: 1,
        trigger: 'new-draft-before-prose-same-root-native-artifact' } } }
}

export const FULL_AI_REVIEW_SCENARIO = Object.freeze({
  scenarioRevision: 's14b-full-ai-review-final-manuscript-v1', minimumCalls: 42, maximumPlannedCalls: 342,
  evaluationPolicy: { ...AI_REVIEW_FINAL_MANUSCRIPT_POLICY, caseIds: PHASE_SCENARIOS.full.caseIds,
    physicalRequests: { minimum: 42, maximum: 342, sourceMinimum: 24, sourceMaximum: 198, manuscriptMinimum: 1, manuscriptMaximum: 8 },
    armAsymmetry: POST_UI_AI_REVIEW_SCENARIOS['early-context'].evaluationPolicy.armAsymmetry },
  attemptPolicy: { ...FULL_ATTEMPT_POLICY,
    reviewRebuild: { operationId: '成稿首审', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 },
    finalReviewRebuild: { operationId: '成稿完整复评', primaryPurpose: 'review-chapter', repairPurpose: 'review-chapter-rebuild', maxRepairAttempts: 1 },
    refinementRecovery: { operationId: '成稿一次修稿', purpose: 'refine-from-review', maxAttempts: 4,
      trigger: 'settled-length-same-confirmation-visible-append-with-progress' } },
  operations: [...PHASE_SCENARIOS.full.operations, ...POST_UI_BUDGET.operations.slice(2)],
})

// Keep this predicate byte-for-byte equivalent to the product's direct JSON syntax test.
const repairableDirectJsonSyntax = content => {
  const candidate = content.trim()
  if (!/^[{[]/u.test(candidate)) return false
  try { JSON.parse(candidate); return false } catch { return true }
}
const reviewParseFailure = content => {
  // The command strips thinking tags first; avoid classifying an unstripped artifact as a parse failure.
  if (/<\/?think>/iu.test(content)) return false
  try { parseReviewGenerationResult(content); return false }
  catch (error) {
    return error instanceof SyntaxError || [
      'invalid review contract',
      'AI 返回包含截断 JSON 对象片段',
      'AI 返回包含多个完整 JSON 对象，无法确定唯一结构化结果',
      'AI 返回未包含一个完整 JSON 对象',
    ].includes(error?.message)
  }
}
function verifiedPrimarySyntaxFailure(first, evidence, operationId, kind = 'directory', condense = null) {
  const attempt = evidence?.attempt, rows = evidence?.events
  const identity = attempt?.binding?.actual ?? attempt?.binding?.baselineIpc
  if (!attempt || !Array.isArray(rows) || rows.length !== 3 || !identity
    || attempt.binding.operation !== operationId || attempt.attemptId !== rows[0]?.attemptId
    || !attempt.attemptId.endsWith(`:${first.attemptId}`)
    || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch', 'purpose'].some(key => identity[key] !== first[key])
    || JSON.stringify(rows.map(row => row.type)) !== JSON.stringify(['reserve', 'dispatch', 'settle'])
    || rows[1].attemptId !== attempt.attemptId || rows[2].attemptId !== attempt.attemptId
    || rows[2].finishReason !== 'stop' || JSON.stringify(rows[0].binding) !== JSON.stringify(attempt.binding)
    || kind === 'review' && (evidence.reviewReportAbsent !== true
      || !first.reviewSource || !Number.isSafeInteger(first.reviewSource.draftId) || first.reviewSource.draftId <= 0
      || !/^[a-f0-9]{64}$/.test(first.reviewSource.contentHash ?? '')
      || first.reviewSource.version !== undefined && (!Number.isSafeInteger(first.reviewSource.version)
        || attempt.binding.actual && evidence.ownerArtifactHash !== attempt.visibleTextHash)
      || JSON.stringify(attempt.binding.reviewSource) !== JSON.stringify(first.reviewSource))
    || typeof attempt.outputPath !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.visibleTextHash ?? '')) return false
  try {
    const output = fs.readFileSync(attempt.outputPath, 'utf8')
    return digest(output) === attempt.visibleTextHash && (kind === 'cards'
      ? evidence.finalizedCharacterInvalid === true && evidence.ownerArtifactHash === attempt.visibleTextHash
      : kind === 'condense' ? evidence.ownerArtifactHash === attempt.visibleTextHash && typeof condense?.measureUnits === 'function'
        && Number.isSafeInteger(condense.maximum) && condense.maximum > 0 && condense.measureUnits(output) > condense.maximum
      : kind === 'review' ? reviewParseFailure(output) : repairableDirectJsonSyntax(output))
  } catch { return false }
}
export function structuredRequestRange(prompt, purpose) {
  const compact = /^chapter-blueprint-directory:compact-single:chapter-(\d+)(?::structured-syntax-repair)?$/u.exec(purpose)
  if (compact) return [Number(compact[1])]
  const repair = /本次必须且只能完整返回以下 chapterNumber：([\d、]+)\s*[。.]/u.exec(prompt)
  if (purpose.endsWith(':structured-syntax-repair') && repair) return repair[1].split('、').map(Number)
  const range = /第\s*(\d+)\s*章\s*到\s*第\s*(\d+)\s*章/u.exec(prompt)
  if (!range) throw new Error('STRUCTURED_REQUEST_RANGE_MISSING')
  const [start, end] = range.slice(1).map(Number)
  if (end < start || end - start > 49) throw new Error('STRUCTURED_REQUEST_RANGE_INVALID')
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}
const baselineDecoders = new Map()
/** The frozen baseline's private decoder includes historical truncation. Execute that source read-only, without copying its rules to candidate. */
export function blueprintRecoveryDecoder(repositoryRoot, arm) {
  if (arm !== 'baseline') return (output, range) => parseBlueprintSemanticResponseText(stripDraftThinkingTags(output), range)
  const directory = path.join(repositoryRoot, 'src/services/workflows/commands')
  const source = fs.readFileSync(path.join(directory, 'directory.command.ts'), 'utf8')
  const key = digest([repositoryRoot, source])
  if (!baselineDecoders.has(key)) {
    const start = source.indexOf('const GENERATED_BLUEPRINT_TEXT_LIMITS =')
    const end = source.indexOf('function buildCompactBlueprintTask(', start)
    if (start < 0 || end <= start) throw new Error('BASELINE_BLUEPRINT_DECODER_SOURCE_UNAVAILABLE')
    const contents = `import { parseTextBlueprintsStrict } from '../directory-workflow';
      import { BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST } from '../../../shared/blueprint-semantic-contract';
      import { structuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic';
      import { stripThinkingTags } from '../workflow-utils';
      ${source.slice(start, end)}; export { decodeGeneratedBlueprints };`
    const bundle = buildSync({ stdin: { contents, loader: 'ts', resolveDir: directory }, bundle: true,
      platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    const module = { exports: {} }
    new Function('module', 'exports', 'require', bundle)(module, module.exports, createRequire(path.join(repositoryRoot, 'package.json')))
    baselineDecoders.set(key, (output, range) => module.exports.decodeGeneratedBlueprints(output, range[0], range.at(-1)))
  }
  return baselineDecoders.get(key)
}
export function structuredRecoveryState(attempts, { chapterNumbers, decode = blueprintRecoveryDecoder(null, 'candidate') }, readOutput) {
  const pending = Array.from({ length: Math.ceil(chapterNumbers.length / 5) }, (_, index) =>
    ({ range: chapterNumbers.slice(index * 5, index * 5 + 5), purpose: 'chapter-blueprint-directory' }))
  const compact = new Set()
  let syntaxUsed = false, lastSyntaxSource = null
  const maxCalls = planBlueprintGenerationCost(chapterNumbers.length).maxCalls
  const rebuild = task => {
    if (task.range.length > 1) {
      const midpoint = Math.floor(task.range.length / 2)
      pending.unshift({ range: task.range.slice(0, midpoint), purpose: 'chapter-blueprint-directory' },
        { range: task.range.slice(midpoint), purpose: 'chapter-blueprint-directory' })
    } else if (!compact.has(task.range[0])) {
      compact.add(task.range[0])
      pending.unshift({ range: task.range, purpose: `chapter-blueprint-directory:compact-single:chapter-${task.range[0]}` })
    } else throw new Error('STRUCTURED_RECOVERY_EXHAUSTED')
  }
  for (const [index, owner] of attempts.entries()) {
    const task = pending.shift()
    if (!task || index >= maxCalls || owner.purpose !== task.purpose
      || JSON.stringify(owner.structuredRange) !== JSON.stringify(task.range)) throw new Error('STRUCTURED_RECOVERY_SEQUENCE_INVALID')
    const { output, finishReason } = readOutput(owner)
    if (!['stop', 'length'].includes(finishReason)) throw new Error('STRUCTURED_RECOVERY_UNSETTLED')
    const syntax = owner.purpose.endsWith(':structured-syntax-repair')
    if (finishReason === 'length') { rebuild(task); continue }
    if (!syntax && repairableDirectJsonSyntax(output) && !syntaxUsed) {
      syntaxUsed = true; lastSyntaxSource = output
      pending.unshift({ ...task, purpose: `${task.purpose}:structured-syntax-repair` })
      continue
    }
    // Production itself owns evidence-preserving syntax repair; the raw source and repaired output remain hash-bound.
    if (syntax && (!lastSyntaxSource || !preservesStructuredJsonEvidence(lastSyntaxSource, output)))
      throw new Error('STRUCTURED_REPAIR_EVIDENCE_CHANGED')
    try { decode(output, task.range) }
    catch { rebuild(task) }
  }
  return { next: attempts.length < maxCalls ? pending[0] ?? null : null, complete: pending.length === 0, maxCalls }
}
/** Replay only the product's bounded draft path from immutable raw-visible outputs. */
export function draftRecoveryState(attempts, { policy, targetUnits, arm, reconcileCount = 0 }, readOutput) {
  let text = '', lastFinish = null, pendingRecovery = false, recoveryUsed = false, stopped = false, condensed = false
  const minimum = Math.floor(targetUnits * (arm === 'baseline' ? policy.baselineMinimumRatio : policy.candidateMinimumRatio))
  const maximum = arm === 'candidate' ? Math.ceil(targetUnits * 1.3) : Infinity
  const allowed = () => {
    if (attempts.length === 0) return ['chapter-draft']
    if (condensed) return []
    if (countProjectedDraftUnits(text) > maximum) return ['chapter-draft-condense']
    if (stopped) return []
    if (pendingRecovery) return ['chapter-draft-no-progress-recovery']
    if (lastFinish === 'length' || lastFinish === 'stop' && countProjectedDraftUnits(text) < minimum)
      return ['chapter-draft-continuation']
    return []
  }
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index], purpose = attempt.purpose
    const expected = index === 0 ? ['chapter-draft'] : allowed()
    if (!expected.includes(purpose) || index + reconcileCount >= policy.maxAttempts
      || index > policy.maxContinuationRounds) throw new Error('DRAFT_RECOVERY_SEQUENCE_INVALID')
    const { output, finishReason } = readOutput(attempt)
    if (!['stop', 'length'].includes(finishReason)) throw new Error('DRAFT_RECOVERY_UNSETTLED')
    const clean = sanitizeDraftText(output)
    if (purpose === 'chapter-draft') text = clean
    else if (purpose === 'chapter-draft-condense') {
      text = clean; condensed = true
      if (finishReason !== 'stop') throw new Error('DRAFT_RECOVERY_CONDENSE_INCOMPLETE')
    } else {
      const composed = composeDraftVisibleContinuation(text, clean)
      const delta = countProjectedDraftUnits(composed) - countProjectedDraftUnits(text)
      if (finishReason === 'length' && delta < policy.minimumProgressUnits) {
        if (recoveryUsed) { stopped = true; pendingRecovery = false }
        else { recoveryUsed = true; pendingRecovery = true }
      } else {
        text = composed; pendingRecovery = false
        if (delta < policy.minimumProgressUnits) stopped = true
      }
    }
    lastFinish = finishReason
  }
  return { text, next: attempts.length + reconcileCount >= policy.maxAttempts ? [] : allowed(),
    complete: lastFinish === 'stop' && countProjectedDraftUnits(text) >= minimum && countProjectedDraftUnits(text) <= maximum,
    condensed }
}
function verifiedRecoveryOutput(owner, evidence, operationId) {
  const attempt = evidence?.attempt, events = evidence?.events
  const identity = attempt?.binding?.actual ?? attempt?.binding?.baselineIpc
  if (!identity || attempt.binding.operation !== operationId || !Array.isArray(events) || events.length !== 3
    || ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch', 'purpose'].some(key => identity[key] !== owner[key])
    || attempt.attemptId !== events[0]?.attemptId || !attempt.attemptId.endsWith(`:${owner.attemptId}`)
    || events.some(row => row.attemptId !== attempt.attemptId)
    || JSON.stringify(events.map(row => row.type)) !== JSON.stringify(['reserve', 'dispatch', 'settle'])
    || JSON.stringify(events[0].binding) !== JSON.stringify(attempt.binding)
    || !['stop', 'length'].includes(events[2].finishReason)) throw new Error('RECOVERY_SOURCE_UNVERIFIED')
  const output = fs.readFileSync(attempt.outputPath, 'utf8')
  if (digest(output) !== attempt.visibleTextHash
    || attempt.binding.actual && evidence.ownerArtifactHash !== attempt.visibleTextHash) throw new Error('RECOVERY_SOURCE_HASH_MISMATCH')
  return { output, finishReason: events[2].finishReason }
}
// R3 keeps its total eight-call budget; each native review purpose can replace one LENGTH result.
export function reviewRecoveryAllowed(history, purpose, policy) {
  if (!history.length) return purpose === policy.primaryPurpose
  const last = history.at(-1)
  if (last.finishReason === 'length') return policy.maxLengthReplacements === 1 && purpose === last.purpose
    && history.filter(item => item.purpose === purpose).length === 1
  return last.finishReason === 'stop' && last.purpose === policy.primaryPurpose && purpose === policy.repairPurpose
    && !history.some(item => item.purpose === policy.repairPurpose)
}

/** Only the forward candidate scenarios opt in; historical receipts keep their registered interpretation. */
export function reviewLengthRecoveryFor(result, operationId) {
  if (result.arm === 'baseline') return null
  let policy
  if (result.phase === 'planning-native-diagnostic') policy = PLANNING_NATIVE_DIAGNOSTIC.attemptPolicy
  else if (result.phase === 'saved-native-review-diagnostic') policy = SAVED_NATIVE_REVIEW_DIAGNOSTIC.attemptPolicy
  else if (result.phase === 'r3-native-revision-diagnostic') policy = R3_NATIVE_REVISION_DIAGNOSTIC.attemptPolicy
  else if (result.arm === 'candidate' && result.protocolRevision === CANDIDATE_ONLY_PROTOCOL_REVISION
    && ['final', 'post-ui'].includes(result.milestone)) {
    const scenario = productionScenario(result.phase, result.milestone, result.protocolRevision)
    if (result.scenarioRevision === scenario.scenarioRevision) policy = scenario.attemptPolicy
  }
  return [policy, policy?.reviewRebuild, policy?.finalReviewRebuild, policy?.controlReviewRebuild]
    .find(item => item?.operationId === operationId && item.maxLengthReplacements === 1) ?? null
}
export function planningOutlineState(attempts, range, read) {
  const replay = [], accepted = []
  let text = ''
  let cursor = derivePlotOutlineCursor({ from: range[0], to: range[1] }, 0, replay)
  for (const owner of attempts) {
    if (cursor.kind !== 'request' || owner.purpose !== `plot-outline:chapter:${cursor.chapterNumber}:${cursor.attempt}`)
      throw new Error('PLANNING_OUTLINE_SEQUENCE_INVALID')
    const evidence = read(owner)
    const artifactId = evidence.artifactId ?? owner.attemptId
    replay.push({ purpose: owner.purpose, status: 'settled', finishReason: evidence.finishReason,
      artifact: { artifactId, text: evidence.output, textHash: digest(evidence.output), revision: 1 } })
    cursor = derivePlotOutlineCursor({ from: range[0], to: range[1] }, accepted.length, replay)
    if (cursor.kind === 'accept') {
      accepted.push(...cursor.artifactIds)
      text = joinPlotOutlineEntries(text, cursor.text)
      cursor = derivePlotOutlineCursor({ from: range[0], to: range[1] }, accepted.length, replay)
    }
  }
  return { complete: cursor.kind === 'complete', cursor, artifactIds: accepted, text }
}

/**
 * Only a settled, hash-verified parse failure — or, for a registered draft operation, a settled
 * over-length primary draft — may add one physical request. `draftCondense.measureUnits` and
 * `draftCondense.maximum` come from the production counter and draftTargetUnitRange.
 */
export function createOperationDispatchGate({ onReject, repairPolicy, readPrimaryEvidence, finalizationRepair = false, draftCondense = null,
  draftRecovery = null, structuredRecovery = null, refinementRecovery = null, shortOutline = null, planningOutline = null } = {}) {
  const dispatched = new Map()
  const outlines = new Map()
  const draftAttempts = new Map()
  const structuredAttempts = new Map()
  const refinementAttempts = new Map()
  const reviewAttempts = new Map()
  const reject = (operationId, reason) => {
    const rejection = Object.freeze({ code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST',
      operationId: operationId || null, reason, beforeDispatch: true })
    onReject?.(rejection)
    throw Object.assign(new Error('MODEL_REQUEST_REJECTED'), { code: 'OPERATION_DISPATCH_REJECTED' })
  }
  const sameRun = (left, right) => left.runId === right.runId && left.rootActionId === right.rootActionId
    && left.projectId === right.projectId && left.epoch === right.epoch && left.attemptId !== right.attemptId
  return (operationId, owner, reviewSource) => {
    const first = dispatched.get(operationId)
    const outlinePolicy = Array.isArray(planningOutline) ? planningOutline.find(item => item.operationId === operationId) : planningOutline
    if (outlinePolicy?.operationId === operationId) {
      const history = outlines.get(operationId) ?? []
      try {
        if (!owner || !['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch'].every(key => typeof owner[key] === 'string' && owner[key])
          || history.some(prior => !sameRun(prior, owner))) throw new Error('PLANNING_OUTLINE_OWNER_MISMATCH')
        const state = planningOutlineState(history, outlinePolicy.range,
          prior => verifiedRecoveryOutput(prior, readPrimaryEvidence?.(prior), operationId))
        if (state.cursor.kind !== 'request' || owner.purpose !== `plot-outline:chapter:${state.cursor.chapterNumber}:${state.cursor.attempt}`)
          throw new Error('PLANNING_OUTLINE_SEQUENCE_INVALID')
        outlines.set(operationId, [...history, { ...owner }])
        return
      } catch { reject(operationId, 'planning-outline-scope') }
    }
    if (shortOutline?.operationIds.includes(operationId)) {
      const outline = outlines.get(operationId)
      if (owner?.purpose === shortOutline.purpose) {
        if (outline || first || shortOutline.maxAttempts !== 1) reject(operationId, 'short-outline-already-sent')
        outlines.set(operationId, { ...owner })
        return
      }
      try {
        if (!outline || !sameRun(outline, owner)) throw new Error('SHORT_OUTLINE_OWNER_MISMATCH')
        const evidence = readPrimaryEvidence?.(outline)
        const { output, finishReason } = verifiedRecoveryOutput(outline, evidence, operationId)
        if (finishReason !== 'stop' || !output.trim() || !evidence.ownerArtifactId) throw new Error('SHORT_OUTLINE_INCOMPLETE')
      } catch { reject(operationId, 'short-outline-not-completed') }
    }
    if (owner?.purpose?.startsWith('chapter-draft-reconcile')) reject(operationId, 'duplicate-operation')
    if (refinementRecovery?.operationId === operationId) {
      const history = refinementAttempts.get(operationId) ?? []
      try {
        if (!owner || owner.purpose !== refinementRecovery.purpose || history.length >= refinementRecovery.maxAttempts
          || !['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch'].every(key => typeof owner[key] === 'string' && owner[key])
          || ![reviewSource?.draftId, reviewSource?.version, reviewSource?.confirmationId].every(value => Number.isInteger(value) && value > 0)
          || !CONTENT_HASH.test(reviewSource.contentHash ?? '') || !CONTENT_HASH.test(reviewSource.confirmationHash ?? '')
          || history.some(prior => !sameRun(prior, owner) || stableEvidence(prior.reviewSource) !== stableEvidence(reviewSource)
            || prior.modelExecutionLeaseId !== owner.modelExecutionLeaseId))
          throw new Error('REFINEMENT_RECOVERY_OWNER_MISMATCH')
        let text = '', artifactIds = []
        for (const prior of history) {
          const evidence = readPrimaryEvidence?.(prior)
          const { output, finishReason } = verifiedRecoveryOutput(prior, evidence, operationId)
          if (finishReason !== 'length') throw new Error('REFINEMENT_RECOVERY_NOT_LENGTH')
          if (evidence.attempt.binding.actual && !evidence.ownerArtifactId) throw new Error('REFINEMENT_COMPOSITION_UNPROVEN')
          artifactIds.push(evidence.attempt.binding.actual ? evidence.ownerArtifactId : evidence.attempt.attemptId)
          const clean = (evidence.redactVisibleText ?? stripDraftThinkingTags)(output)
          const next = text ? (evidence.composeVisibleText ?? composeVisibleContinuation)(text, clean) : clean.trim()
          if ((next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0))
            throw new Error('REFINEMENT_RECOVERY_NO_PROGRESS')
          text = next
        }
        if (history.length) {
          const composition = readPrimaryEvidence?.(history.at(-1))?.composition
          if (composition?.algorithm !== 'visible-append-v1' || composition.textHash !== digest(text)
            || stableEvidence(composition.artifactIds ?? composition.attemptIds) !== stableEvidence(artifactIds)) throw new Error('REFINEMENT_COMPOSITION_UNPROVEN')
        }
        refinementAttempts.set(operationId, [...history, { ...owner, reviewSource }])
        return
      } catch { reject(operationId, 'refinement-recovery-not-authorized') }
    }
    const structured = Array.isArray(structuredRecovery) ? structuredRecovery.find(item => item.policy.operationId === operationId) : structuredRecovery
    if (structured?.policy.operationId === operationId) {
      const history = structuredAttempts.get(operationId) ?? []
      try {
        if (!owner || !['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch'].every(key => typeof owner[key] === 'string' && owner[key])
          || history.some(prior => !sameRun(prior, owner))) throw new Error('STRUCTURED_RECOVERY_OWNER_MISMATCH')
        const state = structuredRecoveryState(history, structured,
          prior => verifiedRecoveryOutput(prior, readPrimaryEvidence?.(prior), operationId))
        if (!state.next || owner.purpose !== state.next.purpose
          || JSON.stringify(owner.structuredRange) !== JSON.stringify(state.next.range)) throw new Error('STRUCTURED_RECOVERY_NOT_TRIGGERED')
        structuredAttempts.set(operationId, [...history, { ...owner }])
        dispatched.set(operationId, { ...owner })
        return
      } catch { reject(operationId, 'structured-recovery-not-authorized') }
    }
    if (draftRecovery?.policy.operationIds.includes(operationId)) {
      const history = draftAttempts.get(operationId) ?? []
      const validIdentity = owner && ['attemptId', 'runId', 'rootActionId', 'projectId', 'epoch'].every(key => typeof owner[key] === 'string' && owner[key])
      try {
        if (!validIdentity || history.some(prior => !sameRun(prior, owner))) throw new Error('DRAFT_RECOVERY_OWNER_MISMATCH')
        const state = history.length ? draftRecoveryState(history, draftRecovery,
          prior => verifiedRecoveryOutput(prior, readPrimaryEvidence?.(prior), operationId)) : { next: ['chapter-draft'] }
        if (!state.next.includes(owner.purpose)) throw new Error('DRAFT_RECOVERY_NOT_TRIGGERED')
        draftAttempts.set(operationId, [...history, { ...owner }])
        dispatched.set(operationId, { ...owner })
        return
      } catch { reject(operationId, 'draft-recovery-not-authorized') }
    }
    const cards = finalizationRepair && FINALIZED_CHARACTER_OPERATION_IDS.includes(operationId)
    const condensePolicy = draftCondense?.policy
    const condense = Boolean(condensePolicy?.maxCondenseAttempts === 1 && condensePolicy.operationIds?.includes(operationId))
    const finalReview = [repairPolicy?.reviewRebuild, repairPolicy?.finalReviewRebuild, repairPolicy?.controlReviewRebuild].find(item => item?.operationId === operationId)
    const review = finalReview || repairPolicy?.operationId === operationId && repairPolicy.primaryPurpose === 'review-chapter'
    const policy = finalReview ?? repairPolicy
    const policyApplies = policy?.operationId === operationId && policy.maxRepairAttempts === 1
    const identity = value => value && typeof value.attemptId === 'string' && value.attemptId
      && typeof value.runId === 'string' && value.runId && typeof value.projectId === 'string' && value.projectId
      && typeof value.epoch === 'string' && value.epoch
    if (review && policyApplies && policy.maxLengthReplacements === 1) {
      const history = reviewAttempts.get(operationId) ?? []
      try {
        if (!identity(owner) || !Number.isSafeInteger(reviewSource?.draftId) || reviewSource.draftId <= 0
          || !/^[a-f0-9]{64}$/.test(reviewSource.contentHash ?? '')) throw new Error('REVIEW_SOURCE_MISSING')
        const settled = history.map(previous => {
          const evidence = readPrimaryEvidence?.(previous)
          if (!sameRun(previous, owner) || JSON.stringify(previous.reviewSource) !== JSON.stringify(reviewSource)
            || JSON.stringify(evidence?.attempt?.binding.reviewSource) !== JSON.stringify(reviewSource)
            || evidence?.reviewReportAbsent !== true) throw new Error('REVIEW_SOURCE_CHANGED')
          return { purpose: previous.purpose, ...verifiedRecoveryOutput(previous, evidence, operationId) }
        })
        if (!reviewRecoveryAllowed(settled, owner.purpose, policy)
          || settled.at(-1)?.finishReason === 'stop' && !reviewParseFailure(settled.at(-1).output)) throw new Error('REVIEW_RECOVERY_UNREGISTERED')
        reviewAttempts.set(operationId, [...history, { ...owner, reviewSource }])
        return
      } catch { reject(operationId, 'review-recovery-unregistered') }
    }
    const hasSyntaxProof = () => {
      try { return verifiedPrimarySyntaxFailure(first, readPrimaryEvidence?.(first), operationId,
        cards ? 'cards' : condense ? 'condense' : review ? 'review' : 'directory', condense ? draftCondense : null) }
      catch { return false }
    }
    const repair = first && (policyApplies || cards || condense) && identity(first) && identity(owner)
      && (cards ? (first.ordinal ?? 0) < 2 && owner.purpose === `finalized-character-state:repair:${(first.ordinal ?? 0) + 1}`
        : condense ? first.purpose === condensePolicy.primaryPurpose && owner.purpose === condensePolicy.condensePurpose
        : first.purpose === policy.primaryPurpose && owner.purpose === policy.repairPurpose)
      && first.attemptId !== owner.attemptId && first.runId === owner.runId
      && first.rootActionId === owner.rootActionId && first.projectId === owner.projectId && first.epoch === owner.epoch
      && (!review || JSON.stringify(first.reviewSource) === JSON.stringify(reviewSource))
      && first.repairUsed !== true && hasSyntaxProof()
    if (!operationId || first && !repair || !first && (policyApplies || cards || condense)
      && (!identity(owner) || owner.purpose !== (cards ? 'finalized-character-state' : condense ? condensePolicy.primaryPurpose : policy.primaryPurpose)
        || review && (!Number.isSafeInteger(reviewSource?.draftId) || reviewSource.draftId <= 0
          || !/^[a-f0-9]{64}$/.test(reviewSource.contentHash ?? '')))) {
      reject(operationId, operationId ? 'duplicate-operation' : 'missing-operation')
    }
    if (repair && cards) dispatched.set(operationId, { ...owner, ordinal: (first.ordinal ?? 0) + 1 })
    else if (repair) first.repairUsed = true
    else dispatched.set(operationId, { ...owner, ...(review ? { reviewSource } : {}) })
  }
}

const validDraftObservation = observation => Number.isSafeInteger(observation?.chapterNumber) && observation.chapterNumber > 0
  && Number.isSafeInteger(observation?.units) && observation.units > 0
  && Number.isSafeInteger(observation?.targetUnits) && observation.targetUnits > 0
  && observation.persisted === true && /^[a-f0-9]{64}$/.test(observation.contentHash ?? '')
const withinTargetUnits = (observation, protocolRevision, arm) => {
  if (!validDraftObservation(observation)) return false
  const { minimum, maximum } = targetUnitRange(observation.targetUnits, protocolRevision, arm)
  return observation.units >= minimum && observation.units <= maximum
}
function hasReviewableDraft(result) {
  const observation = result?.draftObservation
  const output = result?.evaluationPolicy ? (result.aiReviewedDraft ?? result.reviewedDraft)?.finalDraft?.outputPath
    : result?.operations?.find(operation => operation.kind === 'draft')?.outputPath
  if (!validDraftObservation(observation) || typeof output !== 'string') return false
  try { return digest(fs.readFileSync(output, 'utf8')) === observation.contentHash } catch { return false }
}
const savedMatchesObservation = result => result?.saved?.chapterNumber === result?.draftObservation?.chapterNumber
  && result.saved.targetUnits === result.draftObservation.targetUnits && result.saved.units === result.draftObservation.units
  && result.saved.contentHash === result.draftObservation.contentHash
const stableEvidence = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item)
const CONTENT_HASH = /^[a-f0-9]{64}$/
const MATERIAL_METHOD = 'utf8-bytes-v1'
const MATERIAL_CATEGORIES = new Set(['author', 'finalized-history', 'future-plan', 'derived-locator', 'reference'])
const sourceIdentity = item => JSON.stringify([item?.sourceId, item?.revision, item?.contentHash])
const sourceIdentityWithReason = item => JSON.stringify([item?.sourceId, item?.revision, item?.contentHash, item?.reason])
const validCount = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
function structuredRecoveryReceiptFailure(result, operationId, chapterNumbers, arm) {
  const attempts = result.attempts.filter(item => item.binding?.operation === operationId)
  const identities = attempts.map(item => item.binding.actual ?? item.binding.baselineIpc)
  try {
    if (!identities[0] || identities.some(owner => ['runId', 'rootActionId', 'projectId', 'epoch'].some(key => owner[key] !== identities[0][key]))) throw new Error('owner')
    const state = structuredRecoveryState(identities, { chapterNumbers,
      decode: blueprintRecoveryDecoder(result.command?.cwd, arm) }, owner => {
      const attempt = attempts.find(item => (item.binding.actual ?? item.binding.baselineIpc).attemptId === owner.attemptId)
      const prompt = fs.readFileSync(attempt.structuredPrompt.outputPath, 'utf8')
      if (digest(prompt) !== attempt.structuredPrompt.contentHash
        || JSON.stringify(structuredRequestRange(prompt, owner.purpose)) !== JSON.stringify(owner.structuredRange)) throw new Error('scope')
      const output = fs.readFileSync(attempt.outputPath, 'utf8')
      if (digest(output) !== attempt.visibleTextHash) throw new Error('hash')
      if (arm === 'candidate') {
        const terminal = result.ownerTerminal?.find(item => item.attemptId === owner.attemptId)
        if (!terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash || terminal.finishReason !== attempt.finishReason
          || terminal.hasFormalEffect !== (attempt === attempts.at(-1))) throw new Error('effect')
      }
      return { output, finishReason: attempt.finishReason }
    })
    return state.complete ? null : 'STRUCTURED_RECOVERY_INCOMPLETE'
  } catch { return 'STRUCTURED_RECOVERY_EVIDENCE_INVALID' }
}
function draftRecoveryReceiptFailure(result, operationId, policy, arm, reviewed = false, reconcileCount = 0) {
  const attempts = result.attempts.filter(item => item.binding?.operation === operationId
    && (item.binding.actual ?? item.binding.baselineIpc)?.purpose !== 'chapter-draft-reconcile')
  const identities = attempts.map(item => item.binding.actual ?? item.binding.baselineIpc)
  if (!identities[0] || identities.some(owner => !owner || ['runId', 'rootActionId', 'projectId', 'epoch'].some(key => owner[key] !== identities[0][key]))
    || new Set(identities.map(owner => owner.attemptId)).size !== identities.length) return 'DRAFT_RECOVERY_OWNER_MISMATCH'
  try {
    const state = draftRecoveryState(identities, { policy, arm, targetUnits: result.draftObservation?.targetUnits, reconcileCount }, owner => {
      const attempt = attempts.find(item => (item.binding.actual ?? item.binding.baselineIpc).attemptId === owner.attemptId)
      const output = fs.readFileSync(attempt.outputPath, 'utf8')
      if (digest(output) !== attempt.visibleTextHash) throw new Error('hash')
      if (arm === 'candidate') {
        const terminal = result.ownerTerminal?.find(item => item.attemptId === owner.attemptId)
        if (!terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash || terminal.purpose !== owner.purpose
          || terminal.finishReason !== attempt.finishReason || terminal.hasFormalEffect !== (attempt === attempts.at(-1))) throw new Error('owner')
      }
      return { output, finishReason: attempt.finishReason }
    })
    const sourceHash = result.aiReviewedDraft?.initial?.contentHash ?? (reviewed ? result.reviewedDraft?.initial?.contentHash : result.saved?.contentHash ?? result.draftObservation?.contentHash)
    if (!state.complete || digest(state.text) !== sourceHash) return 'DRAFT_RECOVERY_SAVED_MISMATCH'
    return null
  } catch { return 'DRAFT_RECOVERY_EVIDENCE_INVALID' }
}
export function validatePairedReceipt(result, { mode, arm, phase, scenario, protocolRevision, protocolHash }) {
  const owned = ['early-review', 'full', 'planning-native-diagnostic'].includes(phase) || Boolean(scenario.evaluationPolicy)
  const invocationId = result?.invocationId
  if (typeof protocolRevision !== 'string' || !protocolRevision || !CONTENT_HASH.test(protocolHash ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId ?? '')
    || !result || result.mode !== mode || result.arm !== arm || result.phase !== phase
    || result.caseId !== scenario.caseId || result.protocolRevision !== protocolRevision || result.protocolHash !== protocolHash)
    return 'PAIR_BINDING_MISMATCH'
  if (!Array.isArray(result.attempts))
    return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
  if (phase === 'planning-native-diagnostic' && !scenario.evaluationPolicy
    && (scenario.operations.length > 1 || scenario.operations[0]?.kind === 'outline')) {
    if (result.attempts.some(attempt => !scenario.operations.some(operation => operation.id === attempt.binding?.operation))
      || new Set(result.attempts.map(attempt => attempt.attemptId)).size !== result.attempts.length
      || result.physicalModelRequests !== (mode === 'real' ? result.attempts.length : 0)
      || result.syntheticDispatches !== (mode === 'synthetic' ? result.attempts.length : 0)) return 'PLANNING_OPERATION_COVERAGE_MISMATCH'
    const roots = new Set()
    for (const operation of scenario.operations) {
      const attempts = result.attempts.filter(attempt => attempt.binding?.operation === operation.id)
      const persisted = result.operations?.find(item => item.operation === operation.id)
      const terminal = result.ownerTerminal?.filter(item => attempts.some(attempt => attempt.binding.actual?.attemptId === item.attemptId))
      if (!persisted?.handle || roots.has(persisted.handle.rootActionId)) return 'PLANNING_ACTION_ROOT_MISMATCH'
      roots.add(persisted.handle.rootActionId)
      if (operation.kind !== 'outline') {
        const failure = validatePairedReceipt({ ...result, attempts, operations: [persisted], ownerTerminal: terminal,
          physicalModelRequests: mode === 'real' ? attempts.length : 0, syntheticDispatches: mode === 'synthetic' ? attempts.length : 0 },
        { mode, arm, phase, protocolRevision, protocolHash, scenario: { ...scenario, operations: [operation],
          attemptPolicy: { ...scenario.attemptPolicy, structuredRecovery: structuredRecoveryFor(scenario.attemptPolicy, arm, operation.id) } } })
        if (failure) return failure
        continue
      }
      try {
        if (arm !== 'candidate' || !attempts.length || terminal?.length !== attempts.length) throw new Error('owner')
        const state = planningOutlineState(attempts.map(attempt => attempt.binding.actual), operation.range, owner => {
          const attempt = attempts.find(item => item.binding.actual.attemptId === owner.attemptId), binding = attempt.binding
          const saved = terminal.find(item => item.attemptId === owner.attemptId)
          if (attempt.attemptId !== `${arm}:${owner.attemptId}` || owner.runId !== persisted.handle.runId
            || owner.rootActionId !== persisted.handle.rootActionId || owner.projectId !== result.physicalProject?.projectId || owner.epoch !== result.projectEpoch
            || binding.mode !== mode || binding.arm !== arm || binding.phase !== phase || binding.caseId !== scenario.caseId
            || binding.invocationId !== invocationId || binding.protocolRevision !== protocolRevision || binding.protocolHash !== protocolHash
            || binding.codeSha !== result.codeSha || binding.sourceHash !== result.sourceHash || binding.driverHash !== result.driverHash
            || binding.parityId !== result.physicalProject?.parityHash || !saved?.artifactId || saved.hasFormalEffect
            || !['settled', 'unknown'].includes(saved.status) || saved.purpose !== owner.purpose
            || saved.finishReason !== attempt.finishReason || saved.textHash !== attempt.visibleTextHash) throw new Error('owner')
          const output = fs.readFileSync(attempt.outputPath, 'utf8')
          if (digest(output) !== attempt.visibleTextHash) throw new Error('hash')
          return { output, finishReason: attempt.finishReason, artifactId: saved.artifactId }
        })
        const proof = persisted.planningOutline, progress = proof?.progress
        if (!state.complete || progress?.protocol !== PLOT_OUTLINE_PROTOCOL || progress.cursor.kind !== 'complete'
          || stableEvidence(progress.range) !== stableEvidence({ from: operation.range[0], to: operation.range[1] })
          || progress.targetUnits !== operation.targetUnits || stableEvidence(progress.composition?.artifactIds) !== stableEvidence(state.artifactIds)) throw new Error('composition')
        const expected = renderPlotOutlineSynopsis(joinPlotOutlineEntries(progress.confirmedPrefix, state.text), operation.range[1], progress.sourceExpected)
        const saved = fs.readFileSync(proof.savedSynopsis.outputPath, 'utf8')
        if (saved !== expected || digest(saved) !== proof.savedSynopsis.contentHash) throw new Error('saved')
      } catch { return 'PLANNING_OUTLINE_EVIDENCE_INVALID' }
    }
    return null
  }
  if (scenario.attemptPolicy?.shortOutline && !scenario.evaluationPolicy) {
    const policy = scenario.attemptPolicy.shortOutline
    const outlines = result.attempts.filter(attempt => attempt.binding.actual?.purpose === policy.purpose)
    const drafts = scenario.operations.filter(operation => policy.operationIds.includes(operation.id))
    if (outlines.length !== drafts.length) return 'SHORT_OUTLINE_COVERAGE_MISMATCH'
    for (const operation of drafts) {
      const attempts = result.attempts.filter(attempt => attempt.binding.operation === operation.id)
      const outline = attempts[0], owner = outline?.binding.actual
      const terminal = result.ownerTerminal?.find(item => item.attemptId === owner?.attemptId)
      if (owner?.purpose !== policy.purpose || !terminal?.artifactId || terminal.status !== 'settled'
        || terminal.finishReason !== 'stop' || terminal.hasFormalEffect || terminal.textHash !== outline.visibleTextHash
        || attempts.length < 2 || attempts[1].binding.actual?.purpose !== 'chapter-draft'
        || attempts.some(attempt => ['runId', 'rootActionId', 'projectId', 'epoch'].some(key => attempt.binding.actual?.[key] !== owner[key])))
        return 'SHORT_OUTLINE_OWNER_MISMATCH'
      try { if (!fs.readFileSync(outline.outputPath, 'utf8').trim() || digest(fs.readFileSync(outline.outputPath)) !== outline.visibleTextHash) return 'SHORT_OUTLINE_ARTIFACT_MISMATCH' }
      catch { return 'SHORT_OUTLINE_ARTIFACT_MISSING' }
    }
    const prose = result.attempts.filter(attempt => !outlines.includes(attempt))
    const attemptPolicy = { ...scenario.attemptPolicy, shortOutline: undefined }
    return validatePairedReceipt({ ...result, attempts: prose,
      ownerTerminal: result.ownerTerminal?.filter(item => !outlines.some(attempt => attempt.binding.actual.attemptId === item.attemptId)),
      physicalModelRequests: mode === 'real' ? prose.length : 0, syntheticDispatches: mode === 'synthetic' ? prose.length : 0 },
    { mode, arm, phase, scenario: { ...scenario, attemptPolicy }, protocolRevision, protocolHash })
  }
  if (scenario.evaluationPolicy?.revision === AI_REVIEW_FINAL_MANUSCRIPT_POLICY.revision) {
    if (stableEvidence(result.evaluationPolicy) !== stableEvidence(scenario.evaluationPolicy)
      || result.aiReviewedDraft?.initial?.chapterNumber !== scenario.chapterNumber
      || new Set(result.attempts.map(item => item.attemptId)).size !== result.attempts.length
      || stableEvidence(result.operations?.map(item => [item.operation, item.kind])) !== stableEvidence(scenario.operations.map(item => [item.id, item.kind])))
      return 'AI_MANUSCRIPT_OPERATION_MISMATCH'
    for (const attempt of result.attempts) {
      const binding = attempt.binding, owner = binding?.actual ?? binding?.baselineIpc
      const operation = result.operations.find(item => item.operation === binding?.operation)
      if (!operation || !owner || attempt.attemptId !== `${arm}:${owner.attemptId}`
        || binding.mode !== mode || binding.arm !== arm || binding.phase !== phase || binding.caseId !== scenario.caseId
        || binding.invocationId !== invocationId || binding.protocolRevision !== protocolRevision || binding.protocolHash !== protocolHash
        || binding.codeSha !== result.codeSha || binding.sourceHash !== result.sourceHash || binding.driverHash !== result.driverHash
        || binding.parityId !== result.physicalProject?.parityHash || owner.projectId !== result.physicalProject?.projectId
        || owner.epoch !== result.projectEpoch || arm === 'candidate' && (owner.runId !== operation.handle?.runId || owner.rootActionId !== operation.handle?.rootActionId))
        return 'ATTEMPT_BINDING_MISMATCH'
    }
    const sourceOperations = scenario.operations.filter(item => !['review', 'refine', 'final-review'].includes(item.kind))
    const sourceAttempts = result.attempts.filter(item => sourceOperations.some(operation => operation.id === item.binding.operation))
    const sourceFailure = sourceOperations.length ? validatePairedReceipt({ ...result, attempts: sourceAttempts,
      operations: result.operations.filter(item => sourceOperations.some(operation => operation.id === item.operation)),
      ownerTerminal: result.ownerTerminal?.filter(item => sourceAttempts.some(attempt => attempt.binding.actual?.attemptId === item.attemptId)),
      physicalModelRequests: mode === 'real' ? sourceAttempts.length : 0, syntheticDispatches: mode === 'synthetic' ? sourceAttempts.length : 0 },
    { mode, arm, phase, protocolRevision, protocolHash, scenario: { ...scenario, evaluationPolicy: null, operations: sourceOperations,
      attemptPolicy: { ...scenario.attemptPolicy,
        operationId: sourceOperations.some(item => item.id === scenario.attemptPolicy.operationId) ? scenario.attemptPolicy.operationId : null } } }) : null
    if (sourceFailure) return sourceFailure
    if (result.physicalModelRequests !== (mode === 'real' ? result.attempts.length : 0)
      || result.syntheticDispatches !== (mode === 'synthetic' ? result.attempts.length : 0)) return 'PHYSICAL_CALL_COUNT_MISMATCH'
    return validateAiReviewedManuscript(result)
  }
  const policy = scenario.attemptPolicy
  const eligible = policy && result.milestone === policy.milestone && policy.arms.includes(arm)
  const repairMatches = eligible && policy.operationId ? result.attempts.filter(attempt => attempt?.binding?.operation === policy.operationId) : []
  const structuredPolicy = eligible ? structuredRecoveryFor(policy, arm) : null
  const structuredMatches = structuredPolicy ? result.attempts.filter(attempt => attempt.binding?.operation === structuredPolicy.operationId) : []
  const structuredUsed = structuredMatches.some(attempt => (attempt.binding.actual ?? attempt.binding.baselineIpc)?.structuredRange)
  const repairUsed = !structuredUsed && repairMatches.length === 2
  const reviewPolicy = eligible && scenario.evaluationPolicy ? policy.reviewRebuild : null
  const reviewMatches = reviewPolicy ? result.attempts.filter(attempt => attempt?.binding?.operation === reviewPolicy.operationId) : []
  const reviewUsed = reviewMatches.length === 2
  // post-UI v3 与 full v2：只有登记的臂（candidate）与 operation 可多出唯一一次压缩 attempt；baseline 与其余 operation 仍恰一次。
  const condensePolicy = eligible ? draftCondenseFor(policy, arm) : null
  const condenseMatches = condensePolicy
    ? result.attempts.filter(attempt => condensePolicy.operationIds.includes(attempt?.binding?.operation)) : []
  const recoveryPolicy = eligible ? draftRecoveryFor(policy, arm) : null
  const recoveryOperations = scenario.operations.filter(operation => recoveryPolicy?.operationIds.includes(operation.id))
  if (recoveryOperations.length && arm === 'candidate' && (result.ownerTerminal?.length !== result.attempts.length
    || result.attempts.some(attempt => {
      const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual?.attemptId)
      return !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
    }))) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
  const recoveryExtras = recoveryOperations.reduce((sum, operation) => sum + result.attempts.filter(attempt => attempt.binding?.operation === operation.id).length - 1, 0)
  const condenseUsed = recoveryOperations.length === 0 && condenseMatches.length === 2
  if (result.attempts.length !== scenario.operations.length + Number(repairUsed) + Number(reviewUsed) + Number(condenseUsed) + recoveryExtras + (structuredUsed ? structuredMatches.length - 1 : 0)
    || new Set(result.attempts.map(attempt => attempt?.attemptId)).size !== result.attempts.length)
    return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
  for (const operation of scenario.operations) {
    const matches = result.attempts.filter(attempt => attempt?.binding?.operation === operation.id)
    if (structuredUsed && structuredPolicy.operationId === operation.id) {
      const failure = structuredRecoveryReceiptFailure(result, operation.id, phase === 'planning-native-diagnostic'
        ? structuredPolicy.chapterNumbers : phase === 'full' ? [1, 2, 3] : [scenario.chapterNumber], arm)
      if (failure) return failure
    } else if (recoveryOperations.some(item => item.id === operation.id)) {
      const failure = draftRecoveryReceiptFailure(result, operation.id, recoveryPolicy, arm, Boolean(scenario.evaluationPolicy))
      if (failure) return failure
    } else if (matches.length !== (repairUsed && operation.id === policy.operationId
      || reviewUsed && operation.id === reviewPolicy.operationId
      || condenseUsed && condensePolicy.operationIds.includes(operation.id) ? 2 : 1)) return 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH'
    for (const match of matches) {
      const binding = match.binding
      if (binding.mode !== mode || binding.arm !== arm || binding.phase !== phase || binding.caseId !== scenario.caseId
        || binding.invocationId !== invocationId
        || binding.protocolRevision !== protocolRevision || binding.protocolHash !== protocolHash
        || owned && (binding.codeSha !== result.codeSha || binding.sourceHash !== result.sourceHash
          || binding.driverHash !== result.driverHash || binding.parityId !== result.physicalProject?.parityHash))
        return 'ATTEMPT_BINDING_MISMATCH'
      if (owned && arm === 'candidate') {
        const actual = binding.actual
        const persisted = result.operations?.find(item => item.operation === operation.id)
        if (!actual || !persisted?.handle
          || `${arm}:${actual.attemptId}` !== match.attemptId || actual.runId !== persisted.handle.runId
          || actual.rootActionId !== persisted.handle.rootActionId
          || actual.projectId !== result.physicalProject?.projectId || actual.epoch !== result.projectEpoch)
          return 'ACTUAL_OWNER_ATTEMPT_MISMATCH'
      }
    }
  }
  if (!structuredUsed && eligible && policy.operationId) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const primary = identity(repairMatches[0])
    if (!primary || primary.purpose !== policy.primaryPurpose || !primary.attemptId
      || repairMatches[0].attemptId !== `${arm}:${primary.attemptId}`
      || repairMatches[0].binding.milestone !== policy.milestone)
      return 'STRUCTURED_REPAIR_OWNER_MISMATCH'
  }
  if (reviewPolicy) {
    const primary = arm === 'candidate' ? reviewMatches[0]?.binding?.actual : reviewMatches[0]?.binding?.baselineIpc
    if (!primary || primary.purpose !== reviewPolicy.primaryPurpose || !primary.attemptId
      || reviewMatches[0].attemptId !== `${arm}:${primary.attemptId}`)
      return 'REVIEW_REBUILD_OWNER_MISMATCH'
  }
  if (repairUsed) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const [primary, repair] = repairMatches.map(identity)
    const persisted = result.operations?.find(item => item.operation === policy.operationId)
    if (!repair || repair.purpose !== policy.repairPurpose
      || !primary.attemptId || !repair.attemptId || primary.attemptId === repair.attemptId
      || primary.runId !== repair.runId || primary.rootActionId !== repair.rootActionId
      || primary.projectId !== repair.projectId || primary.epoch !== repair.epoch
      || primary.projectId !== result.physicalProject?.projectId || primary.epoch !== result.projectEpoch
      || arm === 'candidate' && (!persisted?.handle || primary.runId !== persisted.handle.runId
        || primary.rootActionId !== persisted.handle.rootActionId)
      || repairMatches.some(attempt => attempt.attemptId !== `${arm}:${identity(attempt).attemptId}`
        || attempt.binding.milestone !== policy.milestone
        || arm === 'baseline' && identity(attempt).operationId !== policy.operationId))
      return 'STRUCTURED_REPAIR_OWNER_MISMATCH'
    for (const [index, attempt] of repairMatches.entries()) {
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string')
        return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        if (index === 0 && !repairableDirectJsonSyntax(output)) return 'STRUCTURED_REPAIR_PRIMARY_NOT_SYNTAX_FAILURE'
      }
      catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    if (arm === 'candidate' && (result.ownerTerminal?.length !== result.attempts.length
      || repairMatches.some(attempt => {
        const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
        return !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
      }))) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
  }
  if (reviewUsed) {
    const identity = attempt => arm === 'candidate' ? attempt.binding.actual : attempt.binding.baselineIpc
    const [primary, rebuild] = reviewMatches.map(identity)
    const persisted = result.operations?.find(item => item.operation === reviewPolicy.operationId)
    const source = reviewMatches[0].binding.reviewSource
    if (!rebuild || rebuild.purpose !== reviewPolicy.repairPurpose
      || !primary.attemptId || !rebuild.attemptId || primary.attemptId === rebuild.attemptId
      || primary.runId !== rebuild.runId || primary.rootActionId !== rebuild.rootActionId
      || primary.projectId !== rebuild.projectId || primary.epoch !== rebuild.epoch
      || primary.projectId !== result.physicalProject?.projectId || primary.epoch !== result.projectEpoch
      || !Number.isSafeInteger(source?.draftId) || source.draftId <= 0
      || source.contentHash !== result.reviewedDraft?.initial?.contentHash
      || source.draftId !== result.reviewedDraft?.initial?.draftId
      || arm === 'candidate' && (!persisted?.handle || primary.runId !== persisted.handle.runId
        || primary.rootActionId !== persisted.handle.rootActionId)
      || reviewMatches.some(attempt => attempt.attemptId !== `${arm}:${identity(attempt).attemptId}`
        || attempt.binding.milestone !== policy.milestone
        || JSON.stringify(attempt.binding.reviewSource) !== JSON.stringify(source)
        || arm === 'baseline' && identity(attempt).operationId !== reviewPolicy.operationId))
      return 'REVIEW_REBUILD_OWNER_MISMATCH'
    for (const [index, attempt] of reviewMatches.entries()) {
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string')
        return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        if (index === 0 && !reviewParseFailure(output)) return 'REVIEW_REBUILD_PRIMARY_NOT_SYNTAX_FAILURE'
      } catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    if (arm === 'candidate' && (result.ownerTerminal?.length !== result.attempts.length
      || reviewMatches.some(attempt => {
        const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
        return !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
      }))) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
  }
  if (condenseUsed) {
    // 登记的唯一压缩：首稿→压缩同 run/root/项目/epoch；首稿 stop 且 hash 可复核、按生产计数超上限；正式效果只在末次压缩，被审稿是压缩稿。
    const [primary, condense] = condenseMatches.map(attempt => attempt.binding.actual)
    if (primary?.purpose !== condensePolicy.primaryPurpose || condense?.purpose !== condensePolicy.condensePurpose
      || ['runId', 'rootActionId', 'projectId', 'epoch'].some(key => primary[key] !== condense[key]))
      return 'DRAFT_CONDENSE_OWNER_MISMATCH'
    if (result.ownerTerminal?.length !== result.attempts.length) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
    let condensedOutput = ''
    for (const [index, attempt] of condenseMatches.entries()) {
      const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
      if (!terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash) return 'ACTUAL_OWNER_ARTIFACT_MISMATCH'
      if (terminal.finishReason !== 'stop' || terminal.purpose !== attempt.binding.actual.purpose
        || terminal.hasFormalEffect !== (index === 1)) return 'DRAFT_CONDENSE_OWNER_MISMATCH'
      if (!CONTENT_HASH.test(attempt.visibleTextHash ?? '') || typeof attempt.outputPath !== 'string') return 'PHYSICAL_OUTPUT_MISSING'
      try {
        const output = fs.readFileSync(attempt.outputPath, 'utf8')
        if (digest(output) !== attempt.visibleTextHash) return 'PHYSICAL_OUTPUT_HASH_MISMATCH'
        condensedOutput = output
      } catch { return 'PHYSICAL_OUTPUT_MISSING' }
    }
    // 压缩稿 = 末次压缩输出经生产清洗（主进程 draft-visible-v1 组合同一规则；干净输出即物理输出本身）。
    // 首稿是否超长按首稿物理输出判，压缩稿是否落入范围按压缩稿自身判；最终稿（有修稿时是修稿产物）的范围由原字数门另判。
    const condensed = sanitizeDraftText(condensedOutput)
    if (!verifiedCondensedDraft(condenseMatches[0], result, { ...result.draftObservation, units: countProjectedDraftUnits(condensed) }))
      return 'DRAFT_CONDENSE_NOT_REGISTERED'
    // post-UI：被审稿（reviewedDraft.initial）必须是压缩稿，而不是被压缩取代的首稿。无修稿时 initial == finalDraft == saved，同一条件
    // 即覆盖保存的正文；有修稿时 saved 是唯一修稿产物，其来源由 validateReviewedDraft 的审修链校验。
    // full：每章没有审修链，保存的正文（随后是下一章前驱）必须就是压缩稿。
    const reviewedSource = result.aiReviewedDraft?.initial?.contentHash
      ?? (scenario.evaluationPolicy ? result.reviewedDraft?.initial?.contentHash : result.saved?.contentHash)
    if (reviewedSource !== digest(condensed)) return 'DRAFT_CONDENSE_SAVED_MISMATCH'
  }
  const expectedPhysical = mode === 'real' ? result.attempts.length : 0
  const expectedSynthetic = mode === 'synthetic' ? result.attempts.length : 0
  if (result.physicalModelRequests !== expectedPhysical || result.syntheticDispatches !== expectedSynthetic)
    return 'PHYSICAL_CALL_COUNT_MISMATCH'
  return null
}

export function validateEarlyReviewChain(result, arm) {
  const fail = pairFailure => ({ valid: false, pairFailure })
  const lifecycle = result?.reviewLifecycle
  if (!lifecycle || !Array.isArray(result.operations) || result.operations.length !== 3
    || stableEvidence(result.operations.map(item => [item.operation, item.kind])) !== stableEvidence([
      ['审稿', 'review'], ['定向修稿', 'refine'], ['一次复核', 'recheck'],
    ])) return fail('REVIEW_CHAIN_OPERATION_MISMATCH')
  const hashes = [lifecycle.source?.contentHash, lifecycle.review?.contentHash,
    lifecycle.confirmation?.contentHash, lifecycle.confirmation?.selectedItemHash,
    lifecycle.revision?.contentHash, lifecycle.merge?.mergedHash,
    lifecycle.recheck?.contentHash]
  if (hashes.some(value => !CONTENT_HASH.test(value ?? ''))
    || lifecycle.review.contentHash !== result.operations[0]?.outputHash
    || lifecycle.revision.contentHash !== result.operations[1]?.outputHash
    || lifecycle.recheck.contentHash !== result.operations[2]?.outputHash
    || lifecycle.revision.contentHash !== lifecycle.merge.mergedHash) return fail('REVIEW_CHAIN_RECEIPT_INVALID')
  if (arm === 'candidate') {
    const roots = result.attempts.map(attempt => attempt.binding?.actual?.rootActionId)
    if (roots.some(root => typeof root !== 'string' || !root) || new Set(roots).size !== 1)
      return fail('REVIEW_CHAIN_ROOT_MISMATCH')
    if (!Array.isArray(lifecycle.confirmation.selectedFindingIds)
      || lifecycle.confirmation.selectedFindingIds.length !== 1
      || lifecycle.confirmation.selectedFindingIds.some(id => typeof id !== 'string' || !id)
      || !lifecycle.review.cycleId || lifecycle.review.cycleId !== lifecycle.confirmation.cycleId
      || lifecycle.review.cycleId !== lifecycle.merge.cycleId || lifecycle.review.cycleId !== lifecycle.recheck.cycleId
      || lifecycle.merge.disposition !== 'required' || lifecycle.recheck.recheckCount !== 1
      || lifecycle.recheck.disposition !== 'completed'
      || lifecycle.recheck.effect?.version !== 2 || lifecycle.recheck.effect.findingMappings !== 0
      || !lifecycle.recheck.statuses || Object.values(lifecycle.recheck.statuses)
        .some(value => !Number.isSafeInteger(value) || value < 0)
      || (lifecycle.recheck.statuses.resolved ?? 0) !== 0
      || !Number.isSafeInteger(lifecycle.recheck.statuses.unknown) || lifecycle.recheck.statuses.unknown < 1
      || Object.values(lifecycle.recheck.statuses).reduce((sum, value) => sum + value, 0) < 1)
      return fail('REVIEW_CYCLE_RECEIPT_INVALID')
    const reviewAttempt = result.attempts.find(attempt => attempt.binding?.operation === '审稿')
    const decision = reviewAttempt?.optionalMaterialEvidence?.materialDecision
    const decisionFailure = validateMaterialDecision(decision, [])
    if (decisionFailure) return fail('REVIEW_MATERIAL_DECISION_INVALID')
    const predecessors = result.physicalProject?.readback?.predecessors
    const requiredPredecessors = Array.isArray(predecessors) ? predecessors.filter(item => item?.required === true) : []
    const predecessor = requiredPredecessors[0]
    const included = decision.included.filter(item => item.required === true)
    const recorded = Array.isArray(result.materialDecisions)
      ? result.materialDecisions.filter(item => item?.operation === '审稿') : []
    if (requiredPredecessors.length !== 1 || included.length !== 1 || decision.omitted.length !== 0
      || decision.coverage.required !== 1 || decision.coverage.included !== 1 || decision.coverage.complete !== true
      || included[0].sourceId !== predecessor.sourceId || included[0].revision !== predecessor.revision
      || included[0].contentHash !== predecessor.contentHash || included[0].category !== 'finalized-history'
      || reviewAttempt.authorityEvidence?.predecessorHash !== predecessor.contentHash
      || reviewAttempt.userPromptHash !== decision.promptHash
      || recorded.length !== 1 || stableEvidence(recorded[0].receipt) !== stableEvidence(decision))
      return fail('REVIEW_MATERIAL_DECISION_MISMATCH')
  }
  return { valid: true }
}
function validateMaterialDecision(decision, registered) {
  if (!decision || decision.version !== 1 || decision.verdict !== 'admitted' || !CONTENT_HASH.test(decision.promptHash ?? '')
    || !decision.capacity || !validCount(decision.capacity.maxInputUnits, 1)
    || decision.capacity.methodVersion !== MATERIAL_METHOD || !validCount(decision.capacity.admittedUnits)
    || decision.capacity.admittedUnits > decision.capacity.maxInputUnits
    || !decision.coverage || !validCount(decision.coverage.required)
    || !validCount(decision.coverage.included) || decision.coverage.included > decision.coverage.required
    || typeof decision.coverage.complete !== 'boolean'
    || !Array.isArray(decision.included) || !Array.isArray(decision.omitted)) return 'MATERIAL_DECISION_RECEIPT_INVALID'
  const validateSource = (item, { included }) => Boolean(item && typeof item.sourceId === 'string' && item.sourceId.trim()
    && validCount(item.revision) && CONTENT_HASH.test(item.contentHash ?? '') && typeof item.category === 'string'
    && MATERIAL_CATEGORIES.has(item.category) && typeof item.required === 'boolean'
    && (!included || validCount(item.units, 1)) && (included ? true : typeof item.reason === 'string' && item.reason.trim()))
  if (decision.included.some(item => !validateSource(item, { included: true }))
    || decision.omitted.some(item => !validateSource(item, { included: false }))) return 'MATERIAL_DECISION_RECEIPT_INVALID'
  const includedKeys = new Set(decision.included.map(sourceIdentity))
  const omittedKeys = new Set(decision.omitted.map(sourceIdentityWithReason))
  if (includedKeys.size !== decision.included.length || omittedKeys.size !== decision.omitted.length
    || decision.included.some(item => decision.omitted.some(omitted => sourceIdentity(item) === sourceIdentity(omitted))))
    return 'MATERIAL_DECISION_DUPLICATE_SOURCE'
  const requiredKeys = new Set([...decision.included, ...decision.omitted].filter(item => item.required).map(sourceIdentity))
  const coveredRequired = decision.included.filter(item => item.required).length
  if (requiredKeys.size !== decision.coverage.required || coveredRequired !== decision.coverage.included
    || decision.included.reduce((sum, item) => sum + item.units, 0) !== decision.capacity.admittedUnits)
    return 'MATERIAL_DECISION_COVERAGE_MISMATCH'
  const registeredByKey = new Map(registered.map(item => [sourceIdentity(item), item]))
  for (const item of decision.omitted.filter(item => item.reason === 'budget')) {
    if (item.required || !registeredByKey.has(sourceIdentity(item))) return 'CANDIDATE_BUDGET_IDENTITY_MISMATCH'
  }
  return null
}
function validateSentEvidence(optional, registered) {
  if (!Array.isArray(optional?.sent) || !Array.isArray(optional.sentSourceIds)
    || optional.sentSourceIds.length !== optional.sent.length) return 'SENT_SOURCE_EVIDENCE_INVALID'
  const registeredByKey = new Map(registered.map(item => [sourceIdentity(item), item]))
  const sentKeys = new Set()
  for (const item of optional.sent) {
    const registeredItem = registeredByKey.get(sourceIdentity(item))
    if (!item || typeof item.sourceId !== 'string' || !validCount(item.revision) || !CONTENT_HASH.test(item.contentHash ?? '')
      || !CONTENT_HASH.test(item.persistedContentHash ?? '') || !validCount(item.persistedBytes, 1) || !CONTENT_HASH.test(item.markerHash ?? '')
      || !registeredItem || item.persistedContentHash !== registeredItem.persistedContentHash
      || item.persistedBytes !== registeredItem.persistedBytes || item.markerHash !== registeredItem.markerHash
      || sentKeys.has(sourceIdentity(item))) return 'SENT_SOURCE_EVIDENCE_INVALID'
    sentKeys.add(sourceIdentity(item))
  }
  if (stableEvidence(optional.sentSourceIds) !== stableEvidence(optional.sent.map(item => item.sourceId)))
    return 'SENT_SOURCE_EVIDENCE_INVALID'
  return { sentKeys }
}
export function validateEarlyContextSelectionDifference(baseline, candidate) {
  const baselineAttempt = baseline?.attempts?.find(attempt => attempt.binding?.operation === '长设定第三章正文')
  const candidateAttempt = candidate?.attempts?.find(attempt => attempt.binding?.operation === '长设定第三章正文')
  const fail = pairFailure => ({ valid: false, pairFailure })
  if (!baselineAttempt || !candidateAttempt
    || !/^[a-f0-9]{64}$/.test(baselineAttempt.compiledPromptHash ?? '')
    || !/^[a-f0-9]{64}$/.test(candidateAttempt.compiledPromptHash ?? '')
    || !Number.isSafeInteger(baselineAttempt.composedPromptBytes) || baselineAttempt.composedPromptBytes < 1
    || !Number.isSafeInteger(candidateAttempt.composedPromptBytes) || candidateAttempt.composedPromptBytes < 1)
    return fail('PROMPT_SELECTION_EVIDENCE_MISSING')
  if (baselineAttempt.compiledPromptHash === candidateAttempt.compiledPromptHash
    || baselineAttempt.composedPromptBytes === candidateAttempt.composedPromptBytes)
    return fail('PROMPT_SELECTION_NOT_DIFFERENT')
  if (!/^[a-f0-9]{64}$/.test(baseline?.physicalProject?.parityHash ?? '')
    || baseline.physicalProject.parityHash !== candidate?.physicalProject?.parityHash)
    return fail('ACTUAL_PROJECT_PARITY_FAILED')
  if (stableEvidence(baseline.promptMapping) !== stableEvidence(candidate.promptMapping))
    return fail('ACTUAL_TEMPLATE_PARITY_FAILED')
  const baselineOptional = baselineAttempt.optionalMaterialEvidence
  const candidateOptional = candidateAttempt.optionalMaterialEvidence
  if (!Array.isArray(baselineOptional?.registered) || baselineOptional.registered.length < 1
    || stableEvidence(baselineOptional.registered) !== stableEvidence(candidateOptional?.registered))
    return fail('OPTIONAL_MATERIAL_PARITY_FAILED')
  const validateRegistered = registered => {
    const keys = new Set()
    for (const item of registered) {
      if (!item || typeof item.sourceId !== 'string' || !item.sourceId.trim() || !validCount(item.revision)
        || !CONTENT_HASH.test(item.contentHash ?? '') || !CONTENT_HASH.test(item.persistedContentHash ?? '') || !validCount(item.persistedBytes, 1)
        || !CONTENT_HASH.test(item.markerHash ?? '') || keys.has(sourceIdentity(item))) return false
      keys.add(sourceIdentity(item))
    }
    return true
  }
  if (!validateRegistered(baselineOptional.registered)) return fail('REGISTERED_SOURCE_EVIDENCE_INVALID')
  const baselineSent = validateSentEvidence(baselineOptional, baselineOptional.registered)
  const candidateSent = validateSentEvidence(candidateOptional, candidateOptional.registered)
  if (!baselineSent || !candidateSent || !baselineSent.sentKeys || !candidateSent.sentKeys || baselineSent.sentKeys.size < 1) return fail('SENT_SOURCE_EVIDENCE_INVALID')
  const decision = candidateOptional?.materialDecision
  const decisionFailure = validateMaterialDecision(decision, candidateOptional.registered)
  if (decisionFailure) return fail(decisionFailure === 'MATERIAL_DECISION_RECEIPT_INVALID' ? 'MATERIAL_DECISION_EVIDENCE_MISSING' : decisionFailure)
  if (!CONTENT_HASH.test(candidateAttempt.userPromptHash ?? '') || candidateAttempt.userPromptHash !== decision.promptHash)
    return fail('MATERIAL_DECISION_PROMPT_HASH_MISMATCH')
  if (decision.coverage.complete !== (decision.coverage.included === decision.coverage.required)
    || !decision.included.some(item => item.required === true)) return fail('CANDIDATE_REQUIRED_COVERAGE_INCOMPLETE')
  const budgetOmissions = decision.omitted.filter(item => item.reason === 'budget' && item.required === false)
  if (budgetOmissions.length < 1) return fail('CANDIDATE_BUDGET_OMISSION_MISSING')
  const candidateBudgetSourceIds = [...new Set(budgetOmissions.map(item => item.sourceId))].sort()
  const provenBaselineSourceIds = budgetOmissions.filter(item => baselineSent.sentKeys.has(sourceIdentity(item)))
    .map(item => item.sourceId).filter((sourceId, index, values) => values.indexOf(sourceId) === index).sort()
  if (provenBaselineSourceIds.length < 1) return fail('BASELINE_OMITTED_SOURCE_NOT_SENT')
  if (budgetOmissions.some(item => candidateSent.sentKeys.has(sourceIdentity(item))))
    return fail('CANDIDATE_OMITTED_SOURCE_SENT')
  return { valid: true, baselinePromptHash: baselineAttempt.compiledPromptHash,
    candidatePromptHash: candidateAttempt.compiledPromptHash,
    baselinePromptBytes: baselineAttempt.composedPromptBytes, candidatePromptBytes: candidateAttempt.composedPromptBytes,
    candidateBudgetSourceIds, provenBaselineSourceIds,
    candidateRequiredCoverage: decision.coverage }
}
export function targetUnitsGateEvidence(error) {
  return error?.code === 'TARGET_UNITS_FAILED' && Number.isSafeInteger(error.actualUnits) && error.actualUnits > 0
    && Number.isSafeInteger(error.targetUnits) && error.targetUnits > 0
    ? { code: error.code, actualUnits: error.actualUnits, targetUnits: error.targetUnits } : null
}
function isReferenceTargetUnitsFailure(result) {
  const failure = result?.gateFailure, observation = result?.draftObservation
  const supplement = result?.supplementEvidence, direct = result?.directPersistedEvidence
  const directVerified = isVerifiedDirectPersistedDraftEvidence(direct)
    && direct?.identity?.invocationId === result.invocationId && direct.identity.arm === 'baseline'
    && direct.identity.chapterNumber === observation?.chapterNumber && direct.identity.units === observation?.units
    && direct.identity.targetUnits === observation?.targetUnits && direct.identity.contentHash === observation?.contentHash
  const recoveryVerified = isVerifiedRecoverySupplementEvidence(supplement)
    && CONTENT_HASH.test(supplement?.sha256 ?? '') && CONTENT_HASH.test(supplement?.originalReceiptSha256 ?? '')
    && supplement?.identity?.invocationId === result.invocationId && supplement.identity.arm === 'baseline'
  return result?.arm === 'baseline' && result.status === 'failed' && failure?.code === 'TARGET_UNITS_FAILED'
    && failure.actualUnits === observation?.units && failure.targetUnits === observation?.targetUnits
    && !withinTargetUnits(observation, result.protocolRevision, result.arm) && hasReviewableDraft(result)
    && (directVerified || recoveryVerified)
}
export function classifyProductionPair(results, { mode, phase }) {
  const baselineRows = Array.isArray(results) ? results.filter(result => result?.arm === 'baseline') : []
  const candidateRows = Array.isArray(results) ? results.filter(result => result?.arm === 'candidate') : []
  if (results?.length !== 2 || baselineRows.length !== 1 || candidateRows.length !== 1) {
    return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'INVALID_PAIR_RESULTS' }
  }
  const baseline = baselineRows[0], candidate = candidateRows[0]
  const aiReviewed = Boolean(POST_UI_AI_REVIEW_SCENARIOS[phase]) && baseline.milestone === 'post-ui'
    && baseline.evaluationPolicy?.revision === AI_REVIEW_FINAL_MANUSCRIPT_POLICY.revision
  const reviewed = !aiReviewed && phase === 'early-budget' && baseline.milestone === 'post-ui'
    && [REVIEWED_DRAFT_PROTOCOL_REVISION, SPLIT_QUALITY_GATES_PROTOCOL_REVISION,
      CANDIDATE_QUALITY_COMPARISON_PROTOCOL_REVISION].includes(baseline.protocolRevision)
  const scenario = aiReviewed ? productionScenario(phase, 'post-ui') : reviewed ? { ...PHASE_SCENARIOS[phase], ...POST_UI_BUDGET } : productionScenario(phase)
  const reviewedChains = reviewed ? [baseline, candidate].map(validateReviewedDraft) : []
  if (reviewedChains.some(chain => !chain.valid)) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
    pairFailure: 'REVIEWED_DRAFT_EVIDENCE_INVALID' }
  if (Array.isArray(baseline.attempts) && Array.isArray(candidate.attempts)) {
    if (baseline.invocationId !== candidate.invocationId)
      return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: 'PAIR_BINDING_MISMATCH' }
    const protocolRevision = baseline.protocolRevision
    const protocolHash = baseline.protocolHash
    const baselineBindingFailure = validatePairedReceipt(baseline, { mode, arm: 'baseline', phase,
      scenario: reviewed ? { ...scenario, operations: reviewedChains[0].operations } : aiReviewed
        ? { ...scenario, operations: scenario.operations.filter(item => !['refine', 'final-review'].includes(item.kind) || baseline.aiReviewedDraft?.selectedCount > 0) }
        : scenario, protocolRevision, protocolHash })
    const candidateBindingFailure = validatePairedReceipt(candidate, { mode, arm: 'candidate', phase,
      scenario: reviewed ? { ...scenario, operations: reviewedChains[1].operations } : aiReviewed
        ? { ...scenario, operations: scenario.operations.filter(item => !['refine', 'final-review'].includes(item.kind) || candidate.aiReviewedDraft?.selectedCount > 0) }
        : scenario, protocolRevision, protocolHash })
    if (baselineBindingFailure || candidateBindingFailure)
      return { status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure: baselineBindingFailure ?? candidateBindingFailure }
  }
  const selectionDifference = phase === 'early-context'
    ? validateEarlyContextSelectionDifference(baseline, candidate) : null
  const earlyReview = phase === 'early-review' && !aiReviewed
    ? { baseline: validateEarlyReviewChain(baseline, 'baseline'), candidate: validateEarlyReviewChain(candidate, 'candidate') }
    : null
  if (earlyReview && (!earlyReview.baseline.valid || !earlyReview.candidate.valid)) {
    return { status: 'failed', qualityQualification: 'automatic-gate-failed',
      pairFailure: earlyReview.baseline.pairFailure ?? earlyReview.candidate.pairFailure }
  }
  if (aiReviewed) {
    const valid = results.every(result => result.status === 'passed' && hasReviewableDraft(result) && savedMatchesObservation(result)
      && withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)) && (!selectionDifference || selectionDifference.valid)
    return { status: valid ? mode === 'real' ? 'pending-independent-oracle-review' : 'passed' : 'failed',
      qualityQualification: valid ? mode === 'real' ? 'pending-independent-oracle-review' : 'not-run' : 'automatic-gate-failed',
      ...(selectionDifference ? { selectionDifference } : {}),
      pendingOracleDimensions: ['raw-ai-finding-correctness', 'facts', 'required-events', 'recap', 'style'] }
  }
  if (mode !== 'real') {
    if (selectionDifference && !selectionDifference.valid) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
      pairFailure: selectionDifference.pairFailure }
    return { status: results.every(result => result.status === 'passed') ? 'passed' : 'failed',
      qualityQualification: 'not-run', ...(selectionDifference ? { selectionDifference } : {}),
      ...(earlyReview ? { earlyReview } : {}) }
  }
  if (phase === 'early-review') return {
    status: results.every(result => result.status === 'passed') ? 'pending-independent-oracle-review' : 'failed',
    qualityQualification: results.every(result => result.status === 'passed')
      ? 'pending-independent-oracle-review' : 'automatic-gate-failed',
    earlyReview,
    pendingOracleDimensions: ['targeted-finding-correctness', 'facts', 'required-events', 'style'],
  }
  if (phase !== 'early-context') {
    const automated = results.every(result => result.status === 'passed' && withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)
      && hasReviewableDraft(result) && savedMatchesObservation(result))
    return { status: automated ? 'pending-independent-oracle-review' : 'failed',
      qualityQualification: automated ? 'pending-independent-oracle-review' : 'automatic-gate-failed' }
  }
  const candidateConforming = candidate?.status === 'passed' && withinTargetUnits(candidate.draftObservation, candidate.protocolRevision, candidate.arm)
    && hasReviewableDraft(candidate) && savedMatchesObservation(candidate)
  const baselineDisposition = baseline?.status === 'passed' && withinTargetUnits(baseline.draftObservation, baseline.protocolRevision, baseline.arm)
    && hasReviewableDraft(baseline) && savedMatchesObservation(baseline)
    ? 'conforming-reference' : isReferenceTargetUnitsFailure(baseline) ? 'reference-nonconforming' : 'invalid-reference'
  if (!candidateConforming || baselineDisposition === 'invalid-reference') return { status: 'failed', qualityQualification: 'automatic-gate-failed', baselineDisposition }
  if (selectionDifference && !selectionDifference.valid) return { status: 'failed', qualityQualification: 'automatic-gate-failed',
    baselineDisposition, pairFailure: selectionDifference.pairFailure }
  return { status: 'pending-independent-oracle-review', qualityQualification: 'pending-independent-oracle-review', baselineDisposition,
    ...(selectionDifference ? { selectionDifference } : {}),
    pendingOracleDimensions: ['required-events', 'facts', 'recap', 'style'] }
}

export function adjudicateEarlyReviewReferenceNonconformance(results, {
  mode, phase, adjudicationRevision, baselineReviewArtifactText, ledgerEvents,
} = {}) {
  if (mode !== 'real' || phase !== 'early-review')
    return { overall: 'failed', originalPairFailure: null, pairFailure: 'ADJUDICATION_SCOPE_MISMATCH' }
  const original = classifyProductionPair(results, { mode, phase })
  const fail = pairFailure => ({ overall: 'failed', originalPairFailure: original.pairFailure ?? null, pairFailure })
  if (adjudicationRevision !== EARLY_REVIEW_REFERENCE_ADJUDICATION_REVISION) return fail('ADJUDICATION_REVISION_MISMATCH')
  if (original.pairFailure !== 'TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH') return fail('ORIGINAL_PAIR_FAILURE_MISMATCH')
  const baseline = results?.find(result => result?.arm === 'baseline')
  const candidate = results?.find(result => result?.arm === 'candidate')
  const baselineAttempt = baseline?.attempts?.[0]
  const baselineOperation = baseline?.operations?.[0]
  if (!baseline || !candidate || baseline.status !== 'failed' || baseline.error !== 'REAL_PROVIDER_DIAGNOSTIC_REDACTED'
    || baseline.mode !== mode || baseline.phase !== phase || baseline.physicalModelRequests !== 1 || baseline.syntheticDispatches !== 0
    || baseline.attempts?.length !== 1 || baseline.operations?.length !== 1
    || baselineAttempt?.binding?.operation !== '审稿' || baselineOperation?.operation !== '审稿'
    || baselineOperation.kind !== 'review' || !baselineAttempt.attemptId
    || baselineAttempt.binding.arm !== 'baseline' || baselineAttempt.binding.invocationId !== baseline.invocationId
    || baselineAttempt.binding.protocolRevision !== baseline.protocolRevision
    || baselineAttempt.binding.protocolHash !== baseline.protocolHash
    || baselineAttempt.binding.mode !== mode || baselineAttempt.binding.phase !== phase
    || baselineAttempt.binding.caseId !== baseline.caseId || baselineAttempt.binding.milestone !== 'early'
    || baselineAttempt.binding.codeSha !== baseline.codeSha || baselineAttempt.binding.sourceHash !== baseline.sourceHash
    || baselineAttempt.binding.driverHash !== baseline.driverHash
    || baselineAttempt.binding.parityId !== baseline.physicalProject?.parityHash)
    return fail('BASELINE_REVIEW_EVIDENCE_INVALID')
  if (typeof baselineReviewArtifactText !== 'string' || !baselineReviewArtifactText
    || !CONTENT_HASH.test(baselineOperation.returnedHash ?? '') || !CONTENT_HASH.test(baselineOperation.outputHash ?? '')
    || digest(baselineReviewArtifactText) !== baselineOperation.returnedHash
    || typeof baselineOperation.outputPath !== 'string' || !baselineOperation.outputPath)
    return fail('BASELINE_REVIEW_ARTIFACT_INVALID')
  let reviewArtifact
  try {
    const match = baselineReviewArtifactText.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    reviewArtifact = JSON.parse(match ? match[1] : baselineReviewArtifactText)
  } catch { return fail('BASELINE_REVIEW_ARTIFACT_INVALID') }
  if (!Array.isArray(reviewArtifact?.items) || reviewArtifact.items.length < 1
    || reviewArtifact.items.some(item => item?.severity !== 'pass'))
    return fail('BASELINE_ACTIONABLE_REVIEW_PRESENT')
  if (!Array.isArray(baseline.invocations) || baseline.invocations.at(-1) !== 'db:review-get-full'
    || baseline.invocations.filter(channel => channel === 'llm:generate-stream').length !== 1
    || baseline.invocations.filter(channel => channel === 'db:review-create').length !== 1)
    return fail('BASELINE_TERMINAL_TRACE_INVALID')

  const scenario = productionScenario(phase)
  if (baseline.invocationId !== candidate.invocationId || baseline.protocolRevision !== candidate.protocolRevision
    || baseline.protocolHash !== candidate.protocolHash
    || baseline.physicalProject?.parityHash !== candidate.physicalProject?.parityHash || candidate.status !== 'passed'
    || validatePairedReceipt(candidate, { mode, arm: 'candidate', phase, scenario,
      protocolRevision: baseline.protocolRevision, protocolHash: baseline.protocolHash }))
    return fail('CANDIDATE_TECHNICAL_EVIDENCE_INVALID')
  const candidateChain = validateEarlyReviewChain(candidate, 'candidate')
  if (!candidateChain.valid) return fail(candidateChain.pairFailure)

  const attempts = [baselineAttempt, ...candidate.attempts]
  const expectedAttemptIds = new Set(attempts.map(attempt => attempt.attemptId))
  const invocationReserves = Array.isArray(ledgerEvents)
    ? ledgerEvents.filter(event => event?.type === 'reserve' && event.binding?.invocationId === baseline.invocationId) : []
  if (expectedAttemptIds.size !== 4 || invocationReserves.length !== 4
    || invocationReserves.some(event => !expectedAttemptIds.has(event.attemptId))) return fail('LEDGER_BINDING_INVALID')
  for (const attempt of attempts) {
    const rows = ledgerEvents.filter(event => event?.attemptId === attempt.attemptId)
    if (stableEvidence(rows.map(row => row.type)) !== stableEvidence(['reserve', 'dispatch', 'settle'])
      || rows[2]?.finishReason !== 'stop'
      || stableEvidence(rows[0]?.binding) !== stableEvidence(attempt.binding))
      return fail('LEDGER_SETTLEMENT_INVALID')
  }
  return { invocationId: baseline.invocationId, originalPairFailure: original.pairFailure,
    derivedReason: 'baseline-all-pass-review-terminal',
    baselineDisposition: 'reference-nonconforming-no-actionable-review',
    candidateTechnicalQualification: 'passed', overall: 'pending-independent-oracle' }
}

export function readBaselineFailureEvidence(receipt, receiptPath) {
  const directShape = receipt?.operations?.length === 1 && receipt.draftObservation?.persisted === true
    && receipt.gateFailure?.code === 'TARGET_UNITS_FAILED'
  const recoveryShape = receipt?.operations?.length === 0 && receipt.attempts?.length === 1
    && receipt.draftObservation === undefined && receipt.gateFailure === undefined
  const verifier = directShape ? readVerifiedDirectPersistedDraftEvidence
    : recoveryShape ? readVerifiedRecoveryCandidateSupplement : null
  if (!verifier || typeof receiptPath !== 'string' || !receiptPath) return {}
  try { return verifier({ receiptPath }) }
  catch (error) {
    if (isExpectedReferenceEvidenceFailure(error)) return {}
    throw error
  }
}

export const modelConfigurationHash = model => digest(Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'apiKey')))

export function copyIsolatedRealModelConfig(original, roots, expectedHash) {
  // Copy only the approved generation profile; a default model would also start an unregistered embedding request.
  const models = JSON.parse(fs.readFileSync(path.join(original.roots.config, 'models.json'), 'utf8'))
  const registeredStages = original.stageModels?.revision === PLANNING_STAGE_MODELS.revision ? PLANNING_STAGE_MODELS : QUALIFICATION_STAGE_MODELS
  const profiles = original.stageModels ? Object.values(registeredStages.profiles) : original.r3StageProfiles
    ? Object.values(R3_NATIVE_REVISION_DIAGNOSTIC.profiles) : [{ profileId: original.modelId, configurationHash: expectedHash }]
  if (original.stageModels && (stableEvidence(original.stageModels) !== stableEvidence(registeredStages)
    || expectedHash && expectedHash !== digest(registeredStages.profiles))) throw new Error('QUALIFICATION_MODEL_CONFIGURATION_DRIFT')
  if (original.r3StageProfiles && stableEvidence(original.r3StageProfiles) !== stableEvidence(R3_NATIVE_REVISION_DIAGNOSTIC.profiles))
    throw new Error('R3_NATIVE_MODEL_MISMATCH')
  const selected = profiles.map(profile => {
    const model = (Array.isArray(models) ? models : [models]).find(value => value.id === profile.profileId)
    if (!model?.apiKey) throw new Error('SAFE_MODEL_UNAVAILABLE')
    if (profile.configurationHash && modelConfigurationHash(model) !== profile.configurationHash) throw new Error('CANDIDATE_MODEL_CONFIGURATION_DRIFT')
    return model
  })
  fs.writeFileSync(path.join(roots.config, 'models.json'), JSON.stringify(selected), { mode: 0o600 })
  fs.writeFileSync(path.join(roots.config, 'config.json'), JSON.stringify({ locale: 'zh-CN' }))
}

export function fullExecutionSchedule(order, protocolRevision) {
  const scenario = PHASE_SCENARIOS.full
  const candidateOnly = protocolRevision === CANDIDATE_ONLY_PROTOCOL_REVISION
  if (order?.seed !== 'program-v3-2026-09-13-fixed-v1' || order.armsByChapter?.length !== 9
    || order.armsByChapter.some((arms, index) => arms !== (candidateOnly ? 'candidate' : index % 2 ? 'candidate,baseline' : 'baseline,candidate')))
    throw new Error('FULL_ORDER_MISMATCH')
  const chapters = scenario.caseIds.flatMap((caseId, index) => order.armsByChapter[index].split(',').map(arm => ({
    caseId, sceneId: caseId.split('/')[0], chapterNumber: Number(caseId.split('/')[1]), arm,
    operation: scenario.operations[1],
  })))
  return [...chapters.filter(step => step.chapterNumber === 1).map(step => ({ ...step, operation: scenario.operations[0] })), ...chapters]
}

/** Verify the accepted same-arm DB source separately from the native excerpts sent to draft requests. */
export function validateFullAcceptedPredecessor(result, previous) {
  if (!previous) return result.acceptedPredecessor || result.attempts.some(item => item.predecessorConsumption)
    ? 'FULL_PREDECESSOR_MISMATCH' : null
  let db
  try {
    const { outputPath, ...identity } = result.acceptedPredecessor ?? {}
    if (stableEvidence(identity) !== stableEvidence(previous) || previous.arm !== result.arm
      || previous.projectId !== result.physicalProject.projectId || previous.chapterNumber !== result.chapterNumber - 1)
      return 'FULL_PREDECESSOR_MISMATCH'
    const content = fs.readFileSync(outputPath, 'utf8')
    db = new (createRequire(import.meta.url)('better-sqlite3'))(result.physicalProject.dbPath, { readonly: true, fileMustExist: true })
    const current = db.prepare('SELECT d.id,d.chapter_number,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC,d.id DESC LIMIT 1').get(previous.chapterNumber)
    if (digest(content) !== previous.contentHash || Buffer.byteLength(content, 'utf8') !== previous.persistedBytes
      || current?.id !== previous.draftId || current.version !== previous.version || current.status !== previous.status
      || current.body !== content) return 'FULL_ACCEPTED_PREDECESSOR_CHANGED'
    for (const operation of result.operations.filter(item => ['draft', 'review', 'final-review'].includes(item.kind))) {
      const attempts = result.attempts.filter(item => item.binding.operation === operation.operation)
      if (!attempts.length) return 'FULL_PREDECESSOR_CONSUMPTION_MISSING'
      for (const attempt of attempts) {
        const consumption = attempt.predecessorConsumption
        if (stableEvidence(consumption?.selected) !== stableEvidence(previous) || !Array.isArray(consumption?.ranges)
          || !consumption.ranges.length || consumption.ranges.some(range => !validCount(range.start) || !validCount(range.end, range.start + 1)
            || range.end > content.length || range.contentHash !== digest(content.slice(range.start, range.end))
            || range.bytes !== Buffer.byteLength(content.slice(range.start, range.end), 'utf8')))
          return 'FULL_PREDECESSOR_CONSUMPTION_MISMATCH'
        if (operation.kind !== 'draft') {
          if (consumption.mode !== (result.protocolRevision === CANDIDATE_ONLY_PROTOCOL_REVISION ? 'captured-predecessor' : 'reviewFocus-complete-body') || consumption.ranges.length !== 1
            || consumption.ranges[0].start !== 0 || consumption.ranges[0].end !== content.length)
            return 'FULL_REVIEW_PREDECESSOR_INCOMPLETE'
        } else if (consumption.mode !== 'native-paragraphs-and-ending'
          || result.arm === 'candidate' && (consumption.materialSource?.sourceId !== `candidate:${previous.draftId}`
            || consumption.materialSource.revision !== previous.version || !CONTENT_HASH.test(consumption.materialSource.contentHash ?? '')))
          return 'FULL_DRAFT_PREDECESSOR_MISMATCH'
      }
    }
    return null
  } catch { return 'FULL_PREDECESSOR_EVIDENCE_INVALID' }
  finally { db?.close() }
}

export function classifyFullProduction(results, { mode, order }) {
  const schedule = fullExecutionSchedule(order, results[0]?.protocolRevision)
  const aiReviewed = results.some(result => result.evaluationPolicy?.revision === AI_REVIEW_FINAL_MANUSCRIPT_POLICY.revision)
  const scenario = aiReviewed ? productionScenario('full', 'final', results[0]?.protocolRevision) : PHASE_SCENARIOS.full
  const fail = pairFailure => ({ status: 'failed', qualityQualification: 'automatic-gate-failed', pairFailure })
  if (results.length !== schedule.length) return fail('FULL_OPERATION_COVERAGE_MISMATCH')
  const projects = new Map(), predecessors = new Map()
  for (const [index, step] of schedule.entries()) {
    const result = results[index], key = `${step.sceneId}:${step.arm}`
    if (result?.status !== 'passed') return fail('FULL_OPERATION_FAILED')
    const operations = aiReviewed && step.operation.kind === 'draft'
      ? scenario.operations.slice(1).filter(item => !['refine', 'final-review'].includes(item.kind) || result.aiReviewedDraft?.selectedCount > 0) : [step.operation]
    const mismatch = validatePairedReceipt(result, { mode, arm: step.arm, phase: 'full',
      scenario: { ...scenario, caseId: step.caseId, chapterNumber: step.chapterNumber, operations,
        evaluationPolicy: step.operation.kind === 'draft' ? scenario.evaluationPolicy : undefined },
      protocolRevision: results[0].protocolRevision, protocolHash: results[0].protocolHash })
    if (mismatch) return fail(mismatch)
    if (result.invocationId !== results[0].invocationId || result.milestone !== 'final'
      || result.chapterNumber !== step.chapterNumber || result.sceneId !== step.sceneId
      || result.operations?.length !== operations.length || result.operations[0].operation !== step.operation.id)
      return fail('FULL_ORDER_MISMATCH')
    const projectId = result.physicalProject?.projectId
    if (!projectId || projects.has(key) && projects.get(key) !== projectId
      || !projects.has(key) && [...projects.values()].includes(projectId)) return fail('FULL_PROJECT_MISMATCH')
    const binding = result.attempts[0].binding
    const owner = step.arm === 'candidate' ? binding.actual : binding.baselineIpc
    if (!owner || owner.projectId !== projectId || owner.epoch !== result.projectEpoch
      || result.attempts[0].attemptId !== `${step.arm}:${owner.attemptId}`
      || binding.milestone !== 'final') return fail('FULL_OWNER_BINDING_MISMATCH')
    projects.set(key, projectId)
    if (step.operation.kind === 'directory') continue
    if (!Number.isSafeInteger(result.saved?.draftId) || result.saved.draftId <= 0
      || !Number.isSafeInteger(result.saved?.version) || result.saved.version <= 0
      || !Number.isSafeInteger(result.saved?.persistedBytes) || result.saved.persistedBytes <= 0
      || !hasReviewableDraft(result) || !savedMatchesObservation(result)
      || !withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)) return fail('FULL_DRAFT_INVALID')
    const previous = predecessors.get(key) ?? null
    if (stableEvidence(result.predecessor ?? null) !== stableEvidence(previous)) return fail('FULL_PREDECESSOR_MISMATCH')
    if (aiReviewed) {
      const failure = validateFullAcceptedPredecessor(result, previous)
      if (failure) return fail(failure)
    }
    predecessors.set(key, { projectId, chapterNumber: result.saved.chapterNumber, draftId: result.saved.draftId,
      version: result.saved.version, contentHash: result.saved.contentHash, persistedBytes: result.saved.persistedBytes,
      ...(aiReviewed ? { arm: result.arm, status: result.saved.status } : {}) })
  }
  return { status: mode === 'synthetic' ? 'passed' : 'pending-independent-oracle-review',
    qualityQualification: mode === 'synthetic' ? 'not-run' : 'pending-independent-oracle-review',
    pendingOracleDimensions: ['required-events', 'facts', 'recap', 'style'],
    ...(aiReviewed ? { evaluationPolicy: scenario.evaluationPolicy, discoveryQualification: 'pending-independent-oracle-review',
      finalManuscriptQualification: 'pending-independent-oracle-review' } : {}) }
}

export function executionRecordIdentity(options) {
  return digest(JSON.stringify({ invocationId: options.invocationId, protocolHash: options.protocolHash,
    sampling: options.sampling, phase: options.phase, mode: options.mode,
    ...(options.savedOutlineContinuation ? { savedOutlineContinuation: options.savedOutlineContinuation } : {}) }))
}
function executionRecord(options) {
  if (!options.executionRecordPath) return { results: {} }
  const identity = executionRecordIdentity(options)
  if (!fs.existsSync(options.executionRecordPath)) return { identity, results: {} }
  const record = JSON.parse(fs.readFileSync(options.executionRecordPath))
  if (record.identity !== identity) throw new Error('EXECUTION_RECORD_DRIFT')
  return record
}

function saveExecutionRecord(options, record) {
  if (!options.executionRecordPath) return
  const temporary = `${options.executionRecordPath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n')
  fs.renameSync(temporary, options.executionRecordPath)
}

/** Resume only unsent work. An interrupted sent step is retained, never blindly replayed. */
function executeRecordedStep(request, options, record, key, bridge) {
  if (record.results[key]) return record.results[key]
  const operations = new Set(request.operations.map(item => item.id))
  const ledger = fs.existsSync(request.ledgerPath) ? fs.readFileSync(request.ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const reserved = ledger.filter(row => row.type === 'reserve' && row.binding?.invocationId === request.invocationId
    && row.binding.caseId === request.caseId && operations.has(row.binding.operation))
  let result
  if (reserved.length) {
    const receiptPath = path.join(request.evidenceRoot ?? request.target.isolationRoot, 'execute-receipt.json')
    result = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath))
      : { status: 'failed', code: 'SENT_STEP_OUTCOME_UNKNOWN', receiptPath }
  } else {
    try { result = bridge({ ...request, action: 'execute' }) }
    catch (error) { result = { ...(error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath)) : {}),
      status: 'failed', code: error.message, receiptPath: error.receiptPath } }
  }
  result = { ...result, caseId: request.caseId, arm: request.target.arm, phase: request.phase,
    invocationId: result.invocationId ?? request.invocationId, mode: result.mode ?? request.mode,
    codeSha: result.codeSha ?? request.target.codeSha, sourceHash: result.sourceHash ?? request.target.sourceHash,
    protocolRevision: request.protocolRevision, protocolHash: request.protocolHash,
    ...(request.sampling ? { sampling: { ...request.sampling, slot: `${request.phase}:${request.caseId}` } } : {}) }
  record.results[key] = result
  saveExecutionRecord(options, record)
  return result
}

function runProductionFull(targets, options, bridge = runProductionBridge) {
  const scenario = options.evaluationPolicy ? productionScenario('full', 'final', options.protocolRevision) : PHASE_SCENARIOS.full
  const arms = scenario.arms ?? ['baseline', 'candidate']
  if (options.scenarioRevision !== scenario.scenarioRevision
    || stableEvidence(options.attemptPolicy ?? null) !== stableEvidence(scenario.attemptPolicy)
    || stableEvidence(options.evaluationPolicy ?? null) !== stableEvidence(scenario.evaluationPolicy ?? null) || options.milestone !== 'final'
    || !options.protocolRevision || !CONTENT_HASH.test(options.protocolHash ?? '')
    || arms.some(arm => targets[arm].protocolRevision !== options.protocolRevision
      || targets[arm].protocolHash !== options.protocolHash)) throw new Error('PROTOCOL_BINDING_MISMATCH')
  const schedule = fullExecutionSchedule(options.order, options.protocolRevision), invocationId = options.invocationId ?? randomUUID()
  const record = executionRecord(options)
  const executionTargets = new Map(record.targets ?? []), prepared = record.prepared ?? [], results = [], predecessors = new Map(), stopped = new Set()
  const common = { ...options, syntheticDraftCondense: undefined, ...syntheticDraftCondensePlan(options), invocationId, driverHash: productionBridgeHash(), phase: 'full' }
  if (!record.prepared) for (const [sceneIndex, sceneId] of ['场景1', '场景2', '场景3'].entries()) {
    for (const arm of arms) {
      const original = targets[arm], directoryId = `${invocationId.slice(0, 6)}${sceneIndex}`
      const roots = Object.fromEntries(Object.entries(original.roots).map(([name, directory]) => [name, path.join(directory, directoryId)]))
      const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId, String(sceneIndex))
      for (const directory of [isolationRoot, ...Object.values(roots)]) {
        if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
        fs.mkdirSync(directory, { recursive: true })
      }
      if (options.mode === 'real') copyIsolatedRealModelConfig(original, roots, options.sampling?.modelConfigurationHash)
      const target = { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }
      executionTargets.set(`${sceneId}:${arm}`, target)
      const preparation = bridge({ ...common, target, action: 'prepare', sceneId,
        chapterNumber: 1, caseId: `${sceneId}/1`, operations: [], templatesPath: `${options.templatesPath}.${sceneId}.json` })
      prepared.push(preparation)
      const peer = prepared.find(item => item.sceneId === sceneId && item.arm !== arm)
      if (peer && peer.physicalProject.parityHash !== preparation.physicalProject.parityHash) throw new Error('ACTUAL_PROJECT_PARITY_FAILED')
    }
  }
  record.targets = [...executionTargets]; record.prepared = prepared
  saveExecutionRecord(options, record)
  for (const [index, step] of schedule.entries()) {
    const key = `${step.sceneId}:${step.arm}`, target = executionTargets.get(key)
    if (stopped.has(key)) {
      const notRun = { status: 'not-run', code: 'PREDECESSOR_UNAVAILABLE', caseId: step.caseId, arm: step.arm,
        invocationId, phase: 'full', mode: options.mode, sourceHash: target.sourceHash,
        codeSha: target.codeSha, protocolRevision: options.protocolRevision, protocolHash: options.protocolHash,
        ...(options.sampling ? { sampling: { ...options.sampling, slot: `full:${step.caseId}` } } : {}) }
      results.push(notRun); record.results[String(index)] = notRun; saveExecutionRecord(options, record)
      continue
    }
    const request = { ...common, target, caseId: step.caseId, sceneId: step.sceneId,
      chapterNumber: step.chapterNumber, operations: step.operation.kind === 'draft' && scenario.evaluationPolicy ? scenario.operations.slice(1) : [step.operation],
      templatesPath: `${options.templatesPath}.${step.sceneId}.json`,
      evidenceRoot: path.join(target.isolationRoot, `step-${index}`),
      predecessor: predecessors.get(key) ?? null,
      parityHash: prepared.find(item => item.sceneId === step.sceneId && item.arm === step.arm).physicalProject.parityHash }
    try {
      const result = executeRecordedStep(request, options, record, String(index), bridge)
      results.push(result)
      if (result.status !== 'passed') {
        stopped.add(key)
        if (options.protocolRevision !== CANDIDATE_ONLY_PROTOCOL_REVISION) break
        continue
      }
      if (scenario.evaluationPolicy && step.operation.kind === 'draft') {
        const operations = request.operations.filter(item => !['refine', 'final-review'].includes(item.kind) || result.aiReviewedDraft?.selectedCount > 0)
        const failure = validatePairedReceipt(result, { mode: options.mode, arm: step.arm, phase: 'full',
          scenario: { ...scenario, caseId: step.caseId, chapterNumber: step.chapterNumber, operations },
          protocolRevision: options.protocolRevision, protocolHash: options.protocolHash })
          ?? validateFullAcceptedPredecessor(result, request.predecessor)
        if (failure) {
          result.status = 'failed'; result.code = failure; stopped.add(key); saveExecutionRecord(options, record)
          if (options.protocolRevision !== CANDIDATE_ONLY_PROTOCOL_REVISION) break
          continue
        }
      }
      if (step.operation.kind === 'draft') predecessors.set(key, { projectId: result.physicalProject.projectId,
        chapterNumber: result.saved.chapterNumber, draftId: result.saved.draftId, version: result.saved.version,
        contentHash: result.saved.contentHash, persistedBytes: result.saved.persistedBytes,
        ...(scenario.evaluationPolicy ? { arm: result.arm, status: result.saved.status } : {}) })
    } catch (error) {
      const receipt = error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath, 'utf8')) : {}
      results.push({ ...receipt, arm: step.arm, caseId: step.caseId, status: 'failed', code: error.message, receiptPath: error.receiptPath })
      stopped.add(key)
      if (options.protocolRevision !== CANDIDATE_ONLY_PROTOCOL_REVISION) break
    }
  }
  return { ...classifyFullProduction(results, options), phase: 'full', invocationId, order: options.order,
    ...(options.protocolRevision === CANDIDATE_ONLY_PROTOCOL_REVISION ? { continuationDecisions: results.filter(result => result.saved).map(result => ({
      caseId: result.caseId, saved: result.saved, currentReviewState: result.currentReviewState,
      choice: 'preauthorized-retain-saved-draft-with-unresolved-state' })) } : {}),
    qualification: options.development ? 'development-only-unfrozen' : `${options.mode}-production-path-only`,
    protocolRevision: options.protocolRevision, protocolHash: options.protocolHash, scenarioRevision: options.scenarioRevision,
    attemptPolicy: options.attemptPolicy, ...(scenario.evaluationPolicy ? { evaluationPolicy: scenario.evaluationPolicy } : {}), prepared, results, notRun: schedule.slice(results.length),
    physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0),
    syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0) }
}

export function runProductionPhasePair(targets, options, bridge = runProductionBridge) {
  if (['saved-native-review-diagnostic', 'planning-native-diagnostic'].includes(options.phase)) {
    const planning = options.phase === 'planning-native-diagnostic'
    const policy = planning ? PLANNING_NATIVE_DIAGNOSTIC : SAVED_NATIVE_REVIEW_DIAGNOSTIC, caseId = options.caseId, nativeAction = options.nativeAction
    if (options.syntheticPlanning !== undefined && (!planning || options.development !== true || options.mode !== 'synthetic'
      || !['empty-stop', 'empty-length', 'outline-recovery', 'blueprint-recovery'].includes(options.syntheticPlanning)))
      throw new Error('PLANNING_SYNTHETIC_SCOPE_MISMATCH')
    const operationsFor = planning ? planningNativeOperations : savedNativeOperations
    const operations = operationsFor(caseId, nativeAction)
    const source = planning ? readPlanningNativeSource(options.diagnosticInputPath) : readSavedNativeSource(options.diagnosticInputPath, caseId)
    const resume = options.resumeSourcePath ? readPlanningResumeSource(options.resumeSourcePath) : null
    if (resume && (!planning || !['resume-from-saved-outline', 'complete'].includes(nativeAction))
      || nativeAction === 'resume-from-saved-outline' && !resume) throw new Error('PLANNING_RESUME_SOURCE_REQUIRED')
    const original = targets.candidate, invocationId = planning ? policy.invocationId : source.source.invocationId
    if (!original || targets.baseline || original.protocolHash !== options.protocolHash
      || original.protocolRevision !== options.protocolRevision || options.mode === 'real' && original.developmentOnly)
      throw new Error('SAVED_NATIVE_TARGET_MISMATCH')
    const recordPath = id => resume ? `${resume.manifest.references.execution.path}.${resume.manifest.continuationId}.execution.json`
      : `${options.diagnosticInputPath}.${options.mode}.${id}.execution.json`
    if (resume && options.executionRecordPath && path.resolve(options.executionRecordPath) !== path.resolve(recordPath(caseId)))
      throw new Error('PLANNING_RESUME_RECORD_PATH_MISMATCH')
    const continuation = resume ? { continuationId: resume.manifest.continuationId, manifestHash: resume.manifestHash } : null
    const bound = { ...options, invocationId, executionRecordPath: recordPath(caseId), ...(resume ? { savedOutlineContinuation: continuation } : {}) }
    const record = executionRecord(bound)
    if (record.targetHash && record.targetHash !== digest(original)) throw new Error('SAVED_NATIVE_TARGET_DRIFT')
    const firstReviewKey = resume ? 'resume-from-saved-outline' : 'review'
    if (nativeAction === 'complete' && !record.results[firstReviewKey]) throw new Error('SAVED_NATIVE_FIRST_REVIEW_REQUIRED')
    let approval, firstReview
    if (nativeAction === 'complete' || !planning && nativeAction === 'review' && caseId === policy.caseIds[1]) {
      approval = JSON.parse(fs.readFileSync(options.approvalPath))
      const negativeRecord = caseId === policy.caseIds[0] ? record : JSON.parse(fs.readFileSync(recordPath(policy.caseIds[0])))
      const prior = negativeRecord.results[nativeAction === 'complete' ? firstReviewKey : 'complete']
      if (!prior?.receiptPath || path.resolve(approval.receiptPath) !== path.resolve(prior.receiptPath)) throw new Error('SAVED_NATIVE_APPROVAL_RECEIPT_MISMATCH')
      const bytes = fs.readFileSync(prior.receiptPath), receipt = JSON.parse(bytes)
      const review = nativeAction === 'complete' ? receipt.aiReviewedDraft?.review : receipt.aiReviewedDraft?.finalReview
      if (digest(bytes) !== approval.receiptHash || receipt.status !== 'passed' || !review
        || receipt.caseId !== policy.caseIds[0] || receipt.phase !== options.phase || receipt.protocolHash !== options.protocolHash
        || receipt.sourceHash !== original.sourceHash || receipt.driverHash !== productionBridgeHash()
        || review.reviewId !== approval.reviewId || review.contentHash !== approval.reportHash
        || digest(fs.readFileSync(review.outputPath)) !== approval.reportHash
        || approval.kind !== (planning ? 'planning-refinement' : nativeAction === 'complete' ? 'negative-detection' : 'negative-closure')
        || nativeAction === 'complete' && (!Array.isArray(approval.findingIds) || !planning && approval.findingIds.length === 0
          || new Set(approval.findingIds).size !== approval.findingIds.length)) throw new Error('SAVED_NATIVE_APPROVAL_MISMATCH')
      firstReview = nativeAction === 'complete' ? receipt : undefined
    } else if (options.approvalPath) throw new Error('SAVED_NATIVE_APPROVAL_SCOPE_MISMATCH')
    let target = record.target
    if (resume) {
      const expected = planningResumeTarget(original, resume)
      if (target && digest(target) !== digest(expected) || record.savedOutlineContinuation && stableEvidence(record.savedOutlineContinuation) !== stableEvidence(continuation)
        || path.resolve(options.ledgerPath) !== path.resolve(resume.manifest.ledger.path)) throw new Error('PLANNING_RESUME_TARGET_DRIFT')
      target = expected
      record.target = target; record.targetHash = digest(original); record.savedOutlineContinuation = continuation
      record.preparationSource = resume.manifest.references.preparation
      saveExecutionRecord(bound, record)
    }
    if (!target) {
      const directoryId = invocationId.slice(0, 8)
      const roots = Object.fromEntries(Object.entries(original.roots).map(([key, directory]) => [key, path.join(directory, directoryId)]))
      const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId)
      for (const directory of [isolationRoot, ...Object.values(roots)]) {
        if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
        fs.mkdirSync(directory, { recursive: true })
      }
      target = { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }
      record.target = target; record.targetHash = digest(original)
      saveExecutionRecord(bound, record)
    }
    const resumeEvidence = resume ? `${bound.executionRecordPath}.evidence` : null
    if (resume) fs.mkdirSync(resumeEvidence, { recursive: true })
    const templatesPath = path.join(resumeEvidence ?? target.isolationRoot, planning ? 'planning-native-templates.json' : 'saved-native-templates.json')
    const common = { ...options, ...bound, target, invocationId, nativeAction, caseId, operations, templatesPath,
      sceneId: policy.sceneId, chapterNumber: policy.chapterNumber, scenarioRevision: policy.scenarioRevision,
      attemptPolicy: policy.attemptPolicy, evaluationPolicy: policy.evaluationPolicy, driverHash: productionBridgeHash(),
      approval, firstReview, ledgerPath: record.ledgerPath ?? options.ledgerPath }
    if (record.ledgerPath && path.resolve(record.ledgerPath) !== path.resolve(options.ledgerPath)) throw new Error('SAVED_NATIVE_LEDGER_DRIFT')
    record.ledgerPath = options.ledgerPath
    if (resume && !record.preflight) {
      if (nativeAction === 'complete') throw new Error('SAVED_NATIVE_PREPARATION_REQUIRED')
      record.preflight = bridge({ ...common, parityHash: resume.preparation.physicalProject.parityHash,
        action: 'resume-preflight', mode: 'synthetic', operations: operationsFor(caseId, nativeAction, 'resume-preflight'),
        evidenceRoot: path.join(resumeEvidence, 'preflight') })
      record.templatesHash = digest(fs.readFileSync(templatesPath))
      saveExecutionRecord(bound, record)
    }
    if (!resume && !record.prepared) {
      if (nativeAction === 'complete') throw new Error('SAVED_NATIVE_PREPARATION_REQUIRED')
      record.prepared = bridge({ ...common, mode: 'synthetic', nativeAction: 'prepare', action: 'prepare',
        operations: operationsFor(caseId, 'prepare') })
      saveExecutionRecord(bound, record)
    }
    if (nativeAction === 'prepare') return { status: 'prepared', physicalModelRequests: 0, prepared: record.prepared,
      executionRecordPath: bound.executionRecordPath, qualification: 'non-qualification-diagnostic' }
    if (resume && digest(fs.readFileSync(templatesPath)) !== record.templatesHash) throw new Error('PLANNING_RESUME_TEMPLATE_DRIFT')
    if (!resume && options.mode === 'real' && !record.results[nativeAction]) copyIsolatedRealModelConfig(original, target.roots)
    const result = executeRecordedStep({ ...common, parityHash: (resume ? record.preflight : record.prepared).physicalProject.parityHash,
      evidenceRoot: path.join(resumeEvidence ?? target.isolationRoot, nativeAction) }, bound, record, nativeAction, bridge)
    const journey = resume ? fs.readFileSync(options.ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.type === 'reserve' && row.binding.invocationId === invocationId && row.binding.caseId === caseId) : []
    return { status: result.status === 'passed' ? 'pending-independent-oracle-review' : 'failed',
      qualification: 'non-qualification-diagnostic', formalDenominatorContribution: 0, results: [result],
      ...(resume ? { savedOutlineContinuation: continuation, journeyRequests: { historical: resume.manifest.attempts.length,
        continuation: new Set(journey.map(row => row.attemptId).filter(id => !resume.manifest.attempts.some(item => item.attemptId === id))).size,
        total: new Set(journey.map(row => row.attemptId)).size,
        historicalUnknown: resume.manifest.attempts.filter(item => item.terminal === 'unknown').map(item => item.attemptId) } } : {}),
      executionRecordPath: bound.executionRecordPath, physicalModelRequests: result.physicalModelRequests ?? 0,
      notRun: result.status === 'passed' ? [] : planning ? operations.filter(item => !result.operations?.some(done => done.operation === item.id)).map(item => item.id) : ['control-review'] }
  }
  if (options.phase === 'full') return runProductionFull(targets, options, bridge)
  const scenario = productionScenario(options.phase, options.milestone, options.protocolRevision)
  const arms = scenario.arms ?? ['baseline', 'candidate']
  if ((scenario.scenarioRevision ?? null) !== (options.scenarioRevision ?? null)
    || stableEvidence(scenario.selectionDifference ?? null) !== stableEvidence(options.selectionDifference ?? null)
    || stableEvidence(scenario.attemptPolicy ?? null) !== stableEvidence(options.attemptPolicy ?? null)
    || stableEvidence(scenario.evaluationPolicy ?? null) !== stableEvidence(options.evaluationPolicy ?? null))
    throw new Error('SCENARIO_PROTOCOL_MISMATCH')
  if (!options.protocolRevision || !/^[a-f0-9]{64}$/.test(options.protocolHash ?? '')
    || arms.some(arm => targets[arm].protocolRevision !== options.protocolRevision || targets[arm].protocolHash !== options.protocolHash)) throw new Error('PROTOCOL_BINDING_MISMATCH')
  const invocationId = options.invocationId ?? randomUUID()
  if (options.phase === 'r3-native-revision-diagnostic'
    && !R3_NATIVE_REVISION_DIAGNOSTIC.runs.some(item => item.invocationId === invocationId)) throw new Error('R3_NATIVE_RUN_NOT_REGISTERED')
  const record = executionRecord(options)
  const directoryId = invocationId.slice(0, 8)
  const executionTargets = record.targets ?? Object.fromEntries(arms.map(arm => {
    const original = targets[arm], roots = Object.fromEntries(Object.entries(original.roots).map(([key, directory]) => [key, path.join(directory, directoryId)]))
    const isolationRoot = path.join(original.isolationRoot, 'invocations', invocationId)
    for (const directory of [isolationRoot, ...Object.values(roots)]) if (fs.existsSync(directory)) throw new Error('INVOCATION_DIRECTORY_COLLISION')
    for (const directory of [isolationRoot, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
    if (options.mode === 'real') copyIsolatedRealModelConfig(original, roots, options.sampling?.modelConfigurationHash)
    return [arm, { ...original, isolationRoot, roots, declaredIsolationRoot: original.isolationRoot, declaredRoots: original.roots }]
  }))
  const common = { invocationId, mode: options.mode ?? 'synthetic', development: options.development === true,
    ...(options.sampling ? { sampling: options.sampling } : {}),
    protocolRevision: options.protocolRevision, protocolHash: options.protocolHash,
    forwardReasoning: options.forwardReasoning ?? null,
    forwardQualificationWindow: options.forwardQualificationWindow ?? null,
    scenarioRevision: options.scenarioRevision ?? null, selectionDifference: options.selectionDifference ?? null,
    attemptPolicy: options.attemptPolicy ?? null,
    evaluationPolicy: options.evaluationPolicy ?? null,
    ...(['bounded-revision-diagnostic', 'r3-native-revision-diagnostic'].includes(options.phase) ? { diagnosticInputPath: options.diagnosticInputPath } : {}),
    ...(options.mode === 'synthetic' && options.development ? { syntheticReviewedDraftCase: options.syntheticReviewedDraftCase ?? 'multiple' } : {}),
    // 开发合成才登记超长首稿（默认章见 syntheticDraftCondensePlan）；still-over 用于复现原失败语义。
    ...syntheticDraftCondensePlan({ ...options, milestone: options.milestone ?? scenario.milestone }),
    milestone: options.milestone ?? scenario.milestone,
    phase: options.phase, caseId: scenario.caseId, sceneId: scenario.sceneId, chapterNumber: scenario.chapterNumber,
    operations: scenario.operations, semanticPath: options.semanticPath, templatesPath: options.templatesPath,
    ledgerPath: options.ledgerPath, driverHash: productionBridgeHash() }
  const prepared = record.prepared ?? arms.map(arm => bridge({ ...common, target: executionTargets[arm], action: 'prepare' }))
  record.targets = executionTargets; record.prepared = prepared
  saveExecutionRecord(options, record)
  const parityHash = prepared[0].physicalProject.parityHash
  if (options.phase === 'bounded-revision-diagnostic') {
    let result
    try { result = runProductionBridge({ ...common, target: executionTargets.candidate, action: 'execute', parityHash,
      evidenceRoot: path.join(executionTargets.candidate.isolationRoot, 'execute') }) }
    catch (error) { result = { ...(error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath)) : {}),
      status: 'failed', code: error.message, receiptPath: error.receiptPath } }
    const decision = result.status === 'passed' ? validateBoundedRevisionDiagnostic(result) : { status: 'failed' }
    return { ...decision, invocationId, phase: options.phase, prepared, results: [result],
      qualification: 'non-qualification-diagnostic', qualityQualification: 'not-run', formalSampleQualification: 'not-run',
      physicalModelRequests: result.physicalModelRequests ?? null, syntheticDispatches: result.syntheticDispatches ?? 0 }
  }
  if (options.phase === 'c16-c18') {
    const results = []
    const cases = JSON.parse(fs.readFileSync(options.semanticPath)).continuityQualificationCases
    if (stableEvidence(cases?.map(item => item.id)) !== stableEvidence(scenario.caseIds)) throw new Error('CONTINUITY_CASES_NOT_REGISTERED')
    for (const [index, item] of cases.entries()) {
      const operations = continuityCaseOperations(item.id)
      // 抽取案恰为 notes/cards；恢复案恰一个同 kind 续写，只有带 sourceSuffix 的恢复案（C17-B）前置重新定稿后处理 notes/cards。
      const postProcess = operations.filter(operation => ['chapter_notes', 'character_cards'].includes(operation.kind)), restore = operations.filter(operation => operation.restore)
      if ((item.kind === 'extraction' ? restore.length !== 0 || postProcess.length !== 2
        : restore.length !== 1 || restore[0].restore !== item.kind || postProcess.length !== (item.sourceSuffix ? 2 : 0))
        || postProcess.some((operation, index) => operation.kind !== ['chapter_notes', 'character_cards'][index])) throw new Error('CONTINUITY_CASES_NOT_REGISTERED')
      try {
        results.push(executeRecordedStep({ ...common, caseId: item.id, target: executionTargets.candidate, operations,
          parityHash, evidenceRoot: path.join(executionTargets.candidate.isolationRoot, `step-${index}`) }, options, record, item.id, bridge))
      } catch (error) {
        results.push({ ...(error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath)) : {}),
          status: 'failed', code: error.message, receiptPath: error.receiptPath })
        if (options.protocolRevision !== CANDIDATE_ONLY_PROTOCOL_REVISION) break
      }
    }
    const validation = validateCandidateContinuityResults(results, common.mode,
      { sourceProjectId: prepared[0].physicalProject.projectId })
    return { ...validation, phase: options.phase, invocationId, parityHash, prepared, results,
      draftReconciliation: summarizeDraftReconciliation(results),
      qualification: options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
      qualityQualification: common.mode === 'synthetic' ? 'not-run' : validation.status,
      formalSampleQualification: common.mode === 'synthetic' ? 'not-run' : validation.status,
      operationCounts: scenario.operations.map(operation => ({ operation: operation.id,
        logical: results.flatMap(result => result.operations ?? []).filter(item => item.operation === operation.id).length,
        physical: results.flatMap(result => result.attempts ?? []).filter(item => item.binding?.operation === operation.id && common.mode === 'real').length,
        synthetic: results.flatMap(result => result.attempts ?? []).filter(item => item.binding?.operation === operation.id && common.mode === 'synthetic').length })),
      physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0),
      syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0) }
  }
  if (prepared[1] && prepared[1].physicalProject.parityHash !== parityHash) throw new Error('ACTUAL_PROJECT_PARITY_FAILED')
  const results = arms.map(arm => {
    try { return runProductionBridge({ ...common, target: executionTargets[arm], action: 'execute', parityHash }) }
    catch (error) {
      // A bridge refusal is a recorded outcome, not a harness crash: keep the receipt's
      // own reason (for example a chapter-material capacity conflict) next to the code.
      const receipt = error.receiptPath && fs.existsSync(error.receiptPath) ? JSON.parse(fs.readFileSync(error.receiptPath, 'utf8')) : {}
      let recoveryProjection = {}
      if (arm === 'baseline') recoveryProjection = readBaselineFailureEvidence(receipt, error.receiptPath)
      return { ...receipt, ...recoveryProjection, arm, status: 'failed', code: error.message,
        reason: receipt.error ?? null, receiptPath: error.receiptPath }
    }
  })
  const decision = arms.length === 1 ? classifyCandidateProduction(results[0], { mode: common.mode, phase: options.phase, scenario })
    : classifyProductionPair(results, { mode: common.mode, phase: options.phase })
  return { ...decision, qualification: options.phase === 'r3-native-revision-diagnostic' ? 'non-qualification-diagnostic' : options.development ? 'development-only-unfrozen' : `${common.mode}-production-path-only`,
    phase: options.phase, caseId: scenario.caseId, operations: scenario.operations.map(operation => operation.id),
    physicalModelRequests: results.reduce((sum, result) => sum + (result.physicalModelRequests ?? 0), 0), syntheticDispatches: results.reduce((sum, result) => sum + (result.syntheticDispatches ?? 0), 0),
    protocolRevision: common.protocolRevision, protocolHash: common.protocolHash,
    scenarioRevision: common.scenarioRevision, selectionDifferencePolicy: common.selectionDifference,
    ...(common.evaluationPolicy ? { evaluationPolicy: common.evaluationPolicy } : {}),
    invocationId, parityHash, prepared, results }
}

function classifyCandidateProduction(result, { mode, phase, scenario }) {
  const operations = scenario.operations.filter(item => !['refine', 'final-review'].includes(item.kind) || result.aiReviewedDraft?.selectedCount > 0)
  if (phase === 'r3-native-revision-diagnostic' && result.status === 'passed' && !result.aiReviewedDraft?.selectedCount)
    return { status: 'failed', code: 'R3_NATIVE_NO_ACTIONABLE_REVIEW', qualityQualification: 'not-run' }
  const failure = result.status !== 'passed' ? result.code ?? 'CANDIDATE_OPERATION_FAILED'
    : validatePairedReceipt(result, { mode, arm: 'candidate', phase, scenario: { ...scenario, operations },
      protocolRevision: result.protocolRevision, protocolHash: result.protocolHash })
  return failure ? { status: 'failed', qualityQualification: 'not-run', pairFailure: failure }
    : { status: mode === 'synthetic' ? 'passed' : 'pending-independent-oracle-review',
      qualityQualification: mode === 'synthetic' ? 'not-run' : 'pending-independent-oracle-review' }
}

/**
 * 结果侧复核：保存的原始可见输出按 hash 读回，以 harness 同一 v3 计数（与生产 countDraftUnits 相同）
 * 超出上限。产品先清洗再计数，清洗只删不增，因此这是产品触发压缩的必要条件，不放宽任何门。
 * `condensed` 是压缩稿的观察（须落入范围）；默认取 draftObservation——C16–C18 里保存稿即压缩稿。
 * post-UI 有修稿时 draftObservation 是修稿产物，调用方须传压缩稿自己的观察。
 */
function verifiedCondensedDraft(primary, result, condensed = result?.draftObservation) {
  const observation = result?.draftObservation
  if (!CONTENT_HASH.test(primary?.visibleTextHash ?? '') || typeof primary.outputPath !== 'string'
    || !withinTargetUnits(condensed, result.protocolRevision, 'candidate')) return false
  try {
    const output = fs.readFileSync(primary.outputPath, 'utf8')
    return digest(output) === primary.visibleTextHash
      && countProjectedDraftUnits(output) > targetUnitRange(observation.targetUnits, result.protocolRevision, 'candidate').maximum
  } catch { return false }
}
/**
 * C16-B 作者保护（评分规则变更，用户批准，c16-c18 v3）：作者值始终由桥断言保全；是否出现冲突候选
 * 只在模型正式生效输出确实提议改写 mentalState 时才要求。证据须绑定末次正式 attempt 的 hash 可复核产物，
 * 字段缺失或不一致一律失败。合成模式的 transport 必定提议冲突值，因此仍强制冲突候选。
 */
function authorProtectionSatisfied(result, mode) {
  const evidence = result.finalizationEvidence, protection = evidence?.authorProtection
  const operationId = PHASE_SCENARIOS['c16-c18'].operations.find(operation => operation.kind === 'character_cards').id
  const formal = result.attempts.filter(attempt => attempt.binding?.operation === operationId).at(-1)
  const terminal = result.ownerTerminal.find(item => item.attemptId === formal?.binding?.actual?.attemptId)
  if (typeof evidence?.authorProtected !== 'boolean' || !protection || typeof protection !== 'object'
    || typeof protection.proposed !== 'boolean' || protection.status !== (protection.proposed ? 'triggered' : 'untriggered')
    || protection.field !== 'mentalState' || protection.authorValue !== '谨慎'
    || protection.derivation !== 'formal-owner-artifact-production-parser'
    || !formal || protection.formalAttemptId !== formal.binding.actual?.attemptId
    || !CONTENT_HASH.test(protection.ownerArtifactHash ?? '') || protection.ownerArtifactHash !== formal.visibleTextHash
    || terminal?.hasFormalEffect !== true || terminal.textHash !== protection.ownerArtifactHash) return false
  try { if (digest(fs.readFileSync(formal.outputPath, 'utf8')) !== protection.ownerArtifactHash) return false } catch { return false }
  if (mode === 'synthetic' && !protection.proposed) return false
  return !protection.proposed || evidence.authorProtected === true
}
/** 案例内的定稿替换：C16-B/C16-C 在原项目重新定稿，C17-B 在恢复副本内重新定稿。 */
const continuitySourceReplacement = result => result?.sourceReplacement ?? result?.restoration?.sourceReplacement ?? null
const FINALIZED_SOURCE_KEYS = ['draftId', 'finalizationId', 'chapterNumber', 'contentHash']
const sameFinalizedSource = (left, right) => FINALIZED_SOURCE_KEYS.every(key => left?.[key] !== undefined && left[key] !== null && left[key] === right?.[key])
/**
 * v4：定稿后处理（notes/cards）必须绑定该案当前定稿来源。有替换时来源即替换后的新 finalizationId；
 * notes 持久投影与 cards derived provenance 均须回读到同一来源。
 */
function finalizationEvidenceBound(result) {
  const evidence = result.finalizationEvidence, replacement = continuitySourceReplacement(result)
  if (!evidence?.idempotent || !evidence.derivedApplied || evidence.effects?.length !== 2
    || stableEvidence(evidence.effects.map(effect => effect?.stepKey)) !== stableEvidence(['chapter_notes', 'character_cards'])) return 'FINALIZATION_EFFECT_MISSING'
  if (!FINALIZED_SOURCE_KEYS.every(key => evidence.source?.[key] !== undefined && evidence.source[key] !== null)
    || evidence.notesReadback?.draftId !== evidence.source.draftId || evidence.notesReadback.sourceFinalizationId !== evidence.source.finalizationId
    || evidence.notesReadback.sourceContentHash !== evidence.source.contentHash || evidence.notesReadback.sourceStatus !== 'current'
    || !CONTENT_HASH.test(evidence.notesReadback.chapterNotesHash ?? '')
    || evidence.cardsReadback?.sourceFinalizationId !== evidence.source.finalizationId
    || replacement && (!sameFinalizedSource(evidence.source, replacement.after)
      || replacement.after.finalizationId === replacement.before?.finalizationId)) return 'FINALIZATION_SOURCE_NOT_BOUND'
  return null
}
/**
 * v4：physicalProject.readback.predecessors 是续写实际纳入的必需前驱。C17-B 恢复副本重新定稿后，readback 与 parity
 * 改为替换后的来源（替换前另存），parityHash 仍须等于 readback 的 hash，续写 materialDecision 须纳入同一来源与 revision。
 */
function admittedPredecessorBound(result) {
  const readback = result.physicalProject?.readback, required = readback?.predecessors?.filter(item => item?.required === true)
  if (!readback || required?.length !== 1 || result.physicalProject.parityHash !== digest(readback)) return false
  const [predecessor] = required, replacement = result.restoration?.sourceReplacement
  if (replacement) {
    const before = result.restoration.predecessorsBeforeReplacement?.filter(item => item?.required === true)
    if (predecessor.sourceId !== `finalized:${replacement.draftId}` || predecessor.revision !== replacement.draftId
      || predecessor.version !== replacement.version || typeof replacement.content !== 'string'
      || predecessor.contentHash !== digest(replacement.content) || predecessor.persistedBytes !== Buffer.byteLength(replacement.content, 'utf8')
      || before?.length !== 1 || before[0].sourceId === predecessor.sourceId || before[0].sourceId !== `finalized:${replacement.before?.draftId}`
      || !CONTENT_HASH.test(result.restoration.parityHashBeforeReplacement ?? '')
      || result.restoration.parityHashBeforeReplacement === result.physicalProject.parityHash) return false
  }
  const drafts = result.attempts.filter(attempt => attempt.binding?.actual?.purpose?.startsWith('chapter-draft'))
  return drafts.length > 0 && drafts.every(attempt => attempt.optionalMaterialEvidence?.materialDecision?.included?.some(item =>
    item.sourceId === predecessor.sourceId && item.revision === predecessor.revision))
}
/** 评审包用的对账摘要：逐续写案如实列出注入与否、冲突数、失败原因与落盘路径/hash，不含判断。 */
export function summarizeDraftReconciliation(results) {
  return (Array.isArray(results) ? results : []).flatMap(result => result?.draftReconciliation ? [{ caseId: result.caseId,
    operation: result.draftReconciliation.operation, status: result.draftReconciliation.status,
    conflicts: result.draftReconciliation.conflicts, reason: result.draftReconciliation.reason ?? null,
    prompt: result.draftReconciliation.prompt ?? null, output: result.draftReconciliation.output ?? null,
    blockHash: result.draftReconciliation.blockHash ?? null }] : [])
}
export function validateAiReviewedManuscript(result) {
  const chain = result.aiReviewedDraft
  const read = item => {
    const body = fs.readFileSync(item.outputPath, 'utf8')
    if (digest(body) !== item.contentHash) throw new Error('AI_MANUSCRIPT_ARTIFACT_MISMATCH')
    return body
  }
  let db
  try {
    db = new (createRequire(import.meta.url)('better-sqlite3'))(result.physicalProject.dbPath, { readonly: true, fileMustExist: true })
    const baselineContract = result.arm === 'baseline' ? loadBaselineReviewContract(result.baselineReviewNative?.repositoryRoot) : null
    if (baselineContract && stableEvidence(baselineContract.sourceHashes) !== stableEvidence(result.baselineReviewNative.sourceHashes))
      throw new Error('BASELINE_AI_REVIEW_NATIVE_SOURCE_DRIFT')
    const initial = read(chain.initial), final = read(chain.finalDraft)
    const review = (kind, saved, source, evidence = result) => {
      const result = evidence
      const operation = result.operations.find(item => item.kind === kind), provenance = operation?.reviewProvenance
      const attempts = result.attempts.filter(item => item.binding.operation === operation?.operation)
      const recoveryPolicy = reviewLengthRecoveryFor(result, operation?.operation)
      if (attempts.length < 1 || attempts.length > (recoveryPolicy?.maxLengthReplacements === 1 ? 4 : 2)
        || (attempts[0].binding.actual ?? attempts[0].binding.baselineIpc)?.purpose !== 'review-chapter') throw new Error('AI_REVIEW_ATTEMPT_COUNT_MISMATCH')
      if (baselineContract) {
        const native = operation.baselineReviewProvenance, attempt = attempts.at(-1), owner = attempt.binding.baselineIpc
        const row = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,r.source_draft_status,r.source_content,c.body
          FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(saved.reviewId)
        const context = native?.context, raw = fs.readFileSync(attempt.outputPath, 'utf8')
        if (!row || native.reviewId !== saved.reviewId || native.attemptId !== attempt.attemptId || native.contentHash !== saved.contentHash
          || native.baseDraftId !== row.base_draft_id || native.sourceDraftHash !== digest(context?.source)
          || row.source_content !== source || row.source_draft_chapter_number !== context?.source?.chapterNumber
          || row.source_draft_version !== context?.source?.version || row.source_draft_status !== context?.source?.status
          || row.base_draft_id !== context?.source?.id || context.source.content !== source || row.body !== read(saved)
          || attempt.finishReason !== 'stop' || digest(raw) !== attempt.visibleTextHash
          || owner.purpose !== (attempts.length === 1 ? 'review-chapter' : 'review-chapter-rebuild')
          || attempts.some(item => ['runId', 'rootActionId', 'projectId', 'epoch', 'modelExecutionLeaseId'].some(key =>
            item.binding.baselineIpc[key] !== owner[key]) || stableEvidence(item.binding.reviewSource) !== stableEvidence(attempt.binding.reviewSource))
          || attempts.length === 2 && (attempts[0].finishReason !== 'stop' || attempts[0].binding.baselineIpc.purpose !== 'review-chapter'
            || !reviewParseFailure(fs.readFileSync(attempts[0].outputPath, 'utf8')))) throw new Error('BASELINE_AI_REVIEW_PROVENANCE_MISMATCH')
        return { ...aiReviewFinalManuscriptSelection({ rawContent: raw, savedContent: row.body, context, baselineContract }), context, report: JSON.parse(row.body) }
      }
      const formal = result.ownerTerminal.filter(item => attempts.some(attempt => attempt.binding.actual.attemptId === item.attemptId)
        && item.reviewRevisionEffect?.kind === 'review' && item.reviewRevisionEffect.id === saved.reviewId)
      if (formal.length !== 1 || formal[0].attemptId !== provenance?.attemptId) throw new Error('AI_REVIEW_FORMAL_EFFECT_NOT_UNIQUE')
      const terminal = formal[0], attempt = attempts.find(item => item.binding.actual.attemptId === terminal.attemptId)
      const row = db.prepare(`SELECT a.attempt_json,a.usage_receipt_json,g.artifact_json,r.binding_json,r.root_action_id
        FROM generation_attempts a JOIN generation_artifacts g ON g.attempt_id=a.attempt_id JOIN generation_runs r ON r.run_id=a.run_id
        WHERE a.attempt_id=? AND a.run_id=?`).get(terminal.attemptId, operation.handle.runId)
      if (!row) throw new Error('AI_REVIEW_OWNER_MISSING')
      const usage = JSON.parse(row.usage_receipt_json), artifact = JSON.parse(row.artifact_json), binding = JSON.parse(row.binding_json)
      const context = binding.sourceManifest.reviewRevisionContext, effect = usage.reviewRevisionEffect
      const reportBody = db.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?').pluck().get(saved.reviewId)
      if (JSON.parse(row.attempt_json).status !== 'settled' || terminal.status !== 'settled' || attempt.finishReason !== 'stop'
        || usage.result?.finishReason !== 'stop' || !['review-chapter', 'review-chapter-rebuild'].includes(usage.purpose)
        || usage.purpose !== attempt.binding.actual.purpose || binding.projectId !== result.physicalProject.projectId
        || binding.epoch !== result.projectEpoch || row.root_action_id !== operation.handle.rootActionId
        || stableEvidence(effect) !== stableEvidence(provenance.effect) || stableEvidence(effect) !== stableEvidence(terminal.reviewRevisionEffect)
        || effect.contentHash !== saved.contentHash || reportBody !== read(saved) || context.source.content !== source
        || context.sourceHash !== digest(source) || digest(context) !== effect.contextHash
        || effect.artifact.artifactId !== artifact.artifactId || effect.artifact.revision !== artifact.revision
        || effect.artifact.textHash !== artifact.textHash || artifact.textHash !== digest(artifact.text)
        || terminal.artifactId !== artifact.artifactId || terminal.artifactRevision !== artifact.revision
        || terminal.textHash !== attempt.visibleTextHash || artifact.textHash !== attempt.visibleTextHash
        || digest(fs.readFileSync(attempt.outputPath, 'utf8')) !== artifact.textHash) throw new Error('AI_REVIEW_PROVENANCE_MISMATCH')
      if (recoveryPolicy?.maxLengthReplacements === 1) {
        if (attempt !== attempts.at(-1)) throw new Error('AI_REVIEW_RECOVERY_PROVENANCE_MISMATCH')
        const history = []
        for (const item of attempts) {
          const actual = item.binding.actual
          if (!reviewRecoveryAllowed(history, actual.purpose, recoveryPolicy)
            || history.at(-1)?.finishReason === 'stop' && !reviewParseFailure(history.at(-1).output)
            || ['runId', 'rootActionId', 'projectId', 'epoch', 'modelExecutionLeaseId'].some(key => actual[key] !== attempt.binding.actual[key])
            || stableEvidence(item.binding.reviewSource) !== stableEvidence(attempt.binding.reviewSource)) throw new Error('AI_REVIEW_REBUILD_NOT_REGISTERED')
          const raw = fs.readFileSync(item.outputPath, 'utf8')
          if (item !== attempt) {
            const prefix = db.prepare(`SELECT a.attempt_json,a.usage_receipt_json,g.artifact_json,r.binding_json,r.root_action_id
              FROM generation_attempts a JOIN generation_artifacts g ON g.attempt_id=a.attempt_id JOIN generation_runs r ON r.run_id=a.run_id
              WHERE a.attempt_id=? AND a.run_id=?`).get(actual.attemptId, operation.handle.runId)
            const observed = result.ownerTerminal.find(value => value.attemptId === actual.attemptId)
            if (!prefix || !observed) throw new Error('AI_REVIEW_RECOVERY_PROVENANCE_MISMATCH')
            const priorUsage = JSON.parse(prefix.usage_receipt_json), priorArtifact = JSON.parse(prefix.artifact_json)
            if (JSON.parse(prefix.attempt_json).status !== 'settled' || observed.status !== 'settled'
              || !['stop', 'length'].includes(item.finishReason) || priorUsage.result?.finishReason !== item.finishReason
              || priorUsage.purpose !== actual.purpose || priorUsage.reviewRevisionEffect || observed.reviewRevisionEffect
              || prefix.binding_json !== row.binding_json || prefix.root_action_id !== row.root_action_id
              || priorArtifact.artifactId !== observed.artifactId || priorArtifact.revision !== observed.artifactRevision
              || priorArtifact.text !== raw || priorArtifact.textHash !== digest(raw)
              || item.visibleTextHash !== priorArtifact.textHash || observed.textHash !== priorArtifact.textHash)
              throw new Error('AI_REVIEW_RECOVERY_PROVENANCE_MISMATCH')
          }
          history.push({ purpose: actual.purpose, finishReason: item.finishReason, output: raw })
        }
      } else if (attempts.length === 2 && (attempts[0].binding.actual.purpose !== 'review-chapter'
        || attempt !== attempts[1] || attempt.binding.actual.purpose !== 'review-chapter-rebuild'
        || attempts[0].finishReason !== 'stop' || !reviewParseFailure(fs.readFileSync(attempts[0].outputPath, 'utf8'))))
        throw new Error('AI_REVIEW_REBUILD_NOT_REGISTERED')
      return { ...aiReviewFinalManuscriptSelection({ rawContent: artifact.text, savedContent: reportBody, context }), context, report: JSON.parse(reportBody) }
    }
    const savedNative = ['saved-native-review-diagnostic', 'planning-native-diagnostic'].includes(result.phase)
    let firstEvidence = result
    if (savedNative && result.nativeApproval) {
      const bytes = fs.readFileSync(result.nativeApproval.receiptPath)
      if (digest(bytes) !== result.nativeApproval.receiptHash) throw new Error('SAVED_NATIVE_APPROVAL_RECEIPT_MISMATCH')
      firstEvidence = JSON.parse(bytes)
      if (firstEvidence.physicalProject.dbPath !== result.physicalProject.dbPath
        || firstEvidence.physicalProject.projectId !== result.physicalProject.projectId) throw new Error('SAVED_NATIVE_APPROVAL_DATABASE_MISMATCH')
    }
    const first = review('review', chain.review, initial, firstEvidence)
    if (first.context.source.id !== chain.initial.draftId || first.context.source.chapterNumber !== chain.initial.chapterNumber
      || first.context.source.version !== chain.initial.version || first.context.source.status !== chain.initial.status
      || chain.finalDraft.draftId !== chain.initial.draftId) throw new Error('AI_MANUSCRIPT_SOURCE_IDENTITY_MISMATCH')
    if (savedNative && !result.nativeApproval) {
      if (chain.confirmation || chain.revision || chain.finalReview || final !== initial) throw new Error('SAVED_NATIVE_REVIEW_ONLY_MISMATCH')
    }
    if (!savedNative || result.nativeApproval) {
    if (savedNative) {
      const findings = firstEvidence.aiReviewedDraft.findings
      const approvedIndexes = result.nativeApproval.findingIds.map(id => findings.find(item => item.findingId === id)?.reviewItemIndex)
      if (approvedIndexes.some(index => !first.selected.some(item => stableEvidence(item) === stableEvidence(first.report.items[index]))))
        throw new Error('SAVED_NATIVE_APPROVAL_FINDING_MISMATCH')
      first.selected = approvedIndexes.map(index => first.report.items[index])
    }
    const selectedIndexes = first.report.items.flatMap((item, index) => first.selected.some(selected => stableEvidence(selected) === stableEvidence(item)) ? [index] : [])
    if (first.selected.length !== chain.selectedCount || digest(first.selected) !== chain.selectedItemsHash
      || stableEvidence(selectedIndexes) !== stableEvidence(chain.selectedIndexes)
      || stableEvidence(first.softwareItems) !== stableEvidence(chain.softwareItems) || first.disposition !== chain.disposition)
      throw new Error('AI_REVIEW_SELECTION_MISMATCH')
    if (first.selected.length === 0) {
      if (chain.confirmation || chain.revision || chain.finalReview || chain.mergeHash || chain.mergeReceipt || chain.composition || final !== initial)
        throw new Error('AI_REVIEW_NO_ACTION_MISMATCH')
    } else {
      const confirmationBody = read(chain.confirmation), confirmation = JSON.parse(confirmationBody)
      const persisted = db.prepare('SELECT c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?').pluck().get(chain.confirmation.reviewId)
      if (persisted !== confirmationBody || confirmation.sourceReviewId !== chain.review.reviewId
        || stableEvidence(confirmation.sourceDraft) !== stableEvidence(first.context.source)
        || confirmation.summary !== first.report.summary || stableEvidence(confirmation.goalReview) !== stableEvidence(first.report.goalReview)
        || confirmation.items?.length !== first.report.items.length) throw new Error('AI_REVIEW_CONFIRMATION_MISMATCH')
      for (const [index, item] of confirmation.items.entries()) {
        const { findingId, decision, origin, ...original } = item
        const finding = !baselineContract && findingId && db.prepare('SELECT problem_text,category FROM review_findings WHERE cycle_id=? AND finding_id=?')
          .get(confirmation.cycleId, findingId)
        if (origin !== 'ai' || decision !== (selectedIndexes.includes(index) ? 'apply' : 'ignore')
          || stableEvidence(original) !== stableEvidence(first.report.items[index])
          || baselineContract && (findingId !== undefined || confirmation.cycleId !== undefined)
          || !baselineContract && selectedIndexes.includes(index) && (!finding || finding.problem_text !== item.description || finding.category !== item.category))
          throw new Error('AI_REVIEW_CONFIRMATION_ITEMS_MISMATCH')
      }
      const revision = read(chain.revision), operation = result.operations.find(item => item.kind === 'refine')
      const attempts = result.attempts.filter(item => item.binding.operation === operation.operation)
      if (attempts.length < 1 || attempts.length > 4) throw new Error('AI_REVISION_ATTEMPT_COUNT_MISMATCH')
      let composed = ''
      for (const [index, attempt] of attempts.entries()) {
        const output = fs.readFileSync(attempt.outputPath, 'utf8'), previous = composed
        if (baselineContract) {
          const owner = attempt.binding.baselineIpc, source = attempt.binding.reviewSource
          const clean = baselineContract.redactVisibleCompletionText(output)
          composed = composed ? baselineContract.appendVisibleTextContinuation(composed, clean) : clean.trim()
          if (digest(output) !== attempt.visibleTextHash || owner.purpose !== 'refine-from-review' || !owner.modelExecutionLeaseId
            || attempt.finishReason !== (index === attempts.length - 1 ? 'stop' : 'length')
            || ['runId', 'rootActionId', 'projectId', 'epoch', 'modelExecutionLeaseId'].some(key => owner[key] !== attempts[0].binding.baselineIpc[key])
            || source.confirmationId !== chain.confirmation.reviewId || source.confirmationHash !== chain.confirmation.contentHash
            || source.draftId !== chain.initial.draftId || source.version !== chain.initial.version || source.contentHash !== chain.initial.contentHash
            || (composed.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (previous.match(/[\p{L}\p{N}]/gu)?.length ?? 0))
            throw new Error('BASELINE_AI_REVISION_COMPOSITION_MISMATCH')
          continue
        }
        const terminal = result.ownerTerminal.find(item => item.attemptId === attempt.binding.actual.attemptId)
        const row = db.prepare(`SELECT a.attempt_json,a.usage_receipt_json,g.artifact_json FROM generation_attempts a
          JOIN generation_artifacts g ON g.attempt_id=a.attempt_id WHERE a.attempt_id=? AND a.run_id=?`)
          .get(attempt.binding.actual.attemptId, operation.handle.runId)
        if (!row) throw new Error('AI_REVISION_OWNER_MISSING')
        const usage = JSON.parse(row.usage_receipt_json), artifact = JSON.parse(row.artifact_json)
        composed = composed ? composeVisibleContinuation(composed, stripDraftThinkingTags(output)) : stripDraftThinkingTags(output).trim()
        if (digest(output) !== attempt.visibleTextHash || attempt.binding.actual.purpose !== 'refine-from-review'
          || attempt.finishReason !== (index === attempts.length - 1 ? 'stop' : 'length')
          || JSON.parse(row.attempt_json).status !== 'settled' || terminal?.status !== 'settled'
          || usage.purpose !== attempt.binding.actual.purpose || usage.result?.finishReason !== attempt.finishReason
          || artifact.text !== output || artifact.textHash !== attempt.visibleTextHash || terminal.textHash !== artifact.textHash
          || terminal.artifactId !== artifact.artifactId || terminal.artifactRevision !== artifact.revision
          || attempt.binding.actual.runId !== operation.handle.runId || attempt.binding.actual.rootActionId !== operation.handle.rootActionId
          || (composed.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (previous.match(/[\p{L}\p{N}]/gu)?.length ?? 0)) throw new Error('AI_REVISION_COMPOSITION_MISMATCH')
      }
      if (baselineContract) {
        const persistedRevision = db.prepare('SELECT r.status,r.review_source_id,c.body FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?').get(chain.revision.revisionId)
        if (persistedRevision?.status !== 'merged' || persistedRevision.review_source_id !== chain.confirmation.reviewId
          || persistedRevision.body !== revision || composed !== revision || revision !== final
          || chain.composition?.algorithm !== 'visible-append-v1' || chain.composition.textHash !== digest(revision)
          || stableEvidence(chain.composition.attemptIds) !== stableEvidence(attempts.map(item => item.attemptId))
          || chain.mergeHash !== digest(final) || chain.mergeReceipt?.revisionId !== chain.revision.revisionId
          || chain.mergeReceipt.reviewCycle !== undefined) throw new Error('BASELINE_AI_REVISION_MERGE_MISMATCH')
      } else {
      const terminal = result.ownerTerminal.find(item => item.attemptId === attempts.at(-1).binding.actual.attemptId)
      const run = db.prepare('SELECT binding_json,root_action_id FROM generation_runs WHERE run_id=?').get(operation.handle.runId)
      const binding = JSON.parse(run.binding_json)
      const context = binding.sourceManifest.reviewRevisionContext
      const effects = db.prepare('SELECT usage_receipt_json,attempt_json FROM generation_attempts WHERE run_id=?').all(operation.handle.runId)
        .filter(row => JSON.parse(row.usage_receipt_json)?.reviewRevisionEffect)
      const persistedRevision = db.prepare('SELECT r.status,r.review_source_id,c.body FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?').get(chain.revision.revisionId)
      if (effects.length !== 1 || JSON.parse(effects[0].attempt_json).status !== 'settled'
        || stableEvidence(JSON.parse(effects[0].usage_receipt_json).reviewRevisionEffect) !== stableEvidence(terminal.reviewRevisionEffect)
        || binding.projectId !== result.physicalProject.projectId || binding.epoch !== result.projectEpoch || run.root_action_id !== operation.handle.rootActionId
        || persistedRevision?.status !== 'merged' || persistedRevision.review_source_id !== chain.confirmation.reviewId || persistedRevision.body !== revision
        || terminal.reviewRevisionEffect?.kind !== 'revision' || terminal.reviewRevisionEffect.id !== chain.revision.revisionId
        || terminal.reviewRevisionEffect.contentHash !== digest(revision) || digest(context) !== terminal.reviewRevisionEffect.contextHash
        || context.confirmation?.content !== confirmationBody || context.confirmation.reviewSourceId !== chain.confirmation.reviewId
        || context.confirmation.originalReviewContentHash !== chain.review.contentHash
        || stableEvidence(context.source) !== stableEvidence(first.context.source) || composed !== revision || revision !== final
        || chain.composition.algorithm !== 'visible-append-v1' || chain.composition.textHash !== digest(revision)
        || terminal.reviewRevisionEffect.compositionHash !== chain.composition.textHash
        || stableEvidence(JSON.parse(effects[0].usage_receipt_json).visibleComposition) !== stableEvidence(chain.composition)
        || stableEvidence(chain.composition.artifactIds) !== stableEvidence(attempts.map(attempt => result.ownerTerminal
          .find(item => item.attemptId === attempt.binding.actual.attemptId).artifactId))
        || chain.mergeHash !== digest(final) || chain.mergeReceipt?.revisionId !== chain.revision.revisionId
        || chain.mergeReceipt.reviewCycle?.cycleId !== confirmation.cycleId) throw new Error('AI_REVISION_MERGE_MISMATCH')
      }
      const finalReview = review('final-review', chain.finalReview, final)
      if (finalReview.context.recheck || chain.finalReview.reviewId === chain.review.reviewId
        || finalReview.context.source.id !== first.context.source.id || finalReview.context.source.chapterNumber !== first.context.source.chapterNumber
        || finalReview.context.source.version !== chain.finalDraft.version) throw new Error('AI_FINAL_REVIEW_NOT_ORDINARY')
      const units = countProjectedDraftUnits(final), sourceUnits = countProjectedDraftUnits(initial)
      if (units < Math.floor(sourceUnits * 0.8) || units > Math.ceil(sourceUnits * 1.2)) throw new Error('AI_REVISION_LENGTH_MISMATCH')
    }
    }
    const draft = db.prepare(`SELECT d.version,d.chapter_number${result.phase === 'full' ? ',d.status' : ''},c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?`).get(chain.finalDraft.draftId)
    if (result.protocolRevision === CANDIDATE_ONLY_PROTOCOL_REVISION) {
      const terminalReview = chain.finalReview ?? chain.review
      const cycleId = db.prepare('SELECT cycle_id FROM review_cycles WHERE review_id=?').pluck().get(terminalReview.reviewId)
      const current = { contentHash: digest(final), reviewId: terminalReview.reviewId, reviewContentHash: terminalReview.contentHash,
        cycleId, findings: db.prepare('SELECT finding_id AS findingId,status,target_id AS targetId FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(cycleId) }
      if (!cycleId || stableEvidence(result.currentReviewState) !== stableEvidence(current)) throw new Error('CURRENT_REVIEW_STATE_MISMATCH')
    }
    if (draft?.body !== final || draft.version !== chain.finalDraft.version || draft.chapter_number !== chain.initial.chapterNumber
      || chain.finalDraft.draftId !== result.saved?.draftId || chain.finalDraft.version !== result.saved?.version
      || chain.initial.chapterNumber !== result.saved?.chapterNumber || digest(final) !== result.saved?.contentHash
      || digest(final) !== result.draftObservation?.contentHash || countProjectedDraftUnits(final) !== result.saved.units
      || result.phase === 'full' && (draft.status !== result.saved.status || !['draft', 'revised'].includes(draft.status))
      || !withinTargetUnits(result.draftObservation, result.protocolRevision, result.arm)) throw new Error('AI_FINAL_DB_MISMATCH')
    return null
  } catch (error) { return error.message } finally { db?.close() }
}
export function validateCandidateContinuityResults(results, mode, scope = null) {
  const fail = code => ({ status: 'failed', candidateFailure: code })
  const currentScenario = productionScenario('c16-c18', 'final', results[0]?.protocolRevision)
  if (currentScenario.attemptPolicy.shortOutline && !scope?.caseIds) {
    const sourceProjectId = scope?.sourceProjectId
      ?? results.find(result => result.caseId?.startsWith('C16') && result.physicalProject?.projectId)?.physicalProject.projectId
    const caseOutcomes = currentScenario.caseIds.map(caseId => {
      const matching = results.filter(result => result.caseId === caseId)
      const outcome = matching.length === 1 ? validateCandidateContinuityResults(matching, mode,
        { caseIds: [caseId], sourceProjectId }) : fail('CANDIDATE_CASE_MISMATCH')
      return { caseId, ...outcome }
    })
    return { status: caseOutcomes.some(item => item.status === 'failed') ? 'failed'
      : mode === 'real' ? 'pending-independent-oracle-review' : 'passed', caseOutcomes }
  }
  if (currentScenario.attemptPolicy.shortOutline) {
    const projected = []
    for (const result of results) {
      if (result.status !== 'passed' || !Array.isArray(result.attempts) || !Array.isArray(result.ownerTerminal))
        return fail('CANDIDATE_OPERATION_MISSING')
      const draft = result.operations?.find(operation => operation.kind === 'draft')
      if (draft) {
        const attempts = result.attempts.filter(attempt => attempt.binding.operation === draft.operation)
        const failure = validatePairedReceipt({ ...result, attempts, operations: [draft],
          ownerTerminal: result.ownerTerminal.filter(item => attempts.some(attempt => attempt.binding.actual.attemptId === item.attemptId)),
          physicalModelRequests: mode === 'real' ? attempts.length : 0, syntheticDispatches: mode === 'synthetic' ? attempts.length : 0 },
        { mode, arm: 'candidate', phase: 'c16-c18', scenario: { ...currentScenario, caseId: result.caseId,
          operations: currentScenario.operations.filter(operation => operation.id === draft.operation), evaluationPolicy: null,
          attemptPolicy: { ...currentScenario.attemptPolicy, operationId: null } },
          protocolRevision: result.protocolRevision, protocolHash: result.protocolHash })
        if (failure) return fail(failure)
      }
      const outlines = result.attempts.filter(attempt => attempt.binding.actual?.purpose === 'chapter-draft-short-outline')
      if (!draft && outlines.length) return fail('UNREGISTERED_SHORT_OUTLINE')
      projected.push({ ...result, attempts: result.attempts.filter(attempt => !outlines.includes(attempt)),
        ownerTerminal: result.ownerTerminal.filter(item => !outlines.some(attempt => attempt.binding.actual.attemptId === item.attemptId)),
        physicalModelRequests: result.physicalModelRequests - (mode === 'real' ? outlines.length : 0),
        syntheticDispatches: result.syntheticDispatches - (mode === 'synthetic' ? outlines.length : 0) })
    }
    return validateContinuityCore(projected, mode, currentScenario, scope)
  }
  return validateContinuityCore(results, mode, currentScenario)
}
function validateContinuityCore(results, mode, currentScenario, scope = null) {
  const fail = code => ({ status: 'failed', candidateFailure: code })
  const condense = PHASE_SCENARIOS['c16-c18'].attemptPolicy.draftCondense
  const expectedCaseIds = scope?.caseIds ?? PHASE_SCENARIOS['c16-c18'].caseIds
  if (results.length !== expectedCaseIds.length || results.some(result => result.status !== 'passed' || result.arm !== 'candidate'
    || result.phase !== 'c16-c18' || result.mode !== mode)) return fail('CANDIDATE_OPERATION_MISSING')
  if (results.some(result => stableEvidence(result.evaluationPolicy) !== stableEvidence(currentScenario.evaluationPolicy)
    || result.invocationId !== results[0].invocationId || result.protocolHash !== results[0].protocolHash)) return fail('AI_MANUSCRIPT_POLICY_MISMATCH')
  if (stableEvidence(results.map(result => result.caseId)) !== stableEvidence(expectedCaseIds)) return fail('CANDIDATE_CASE_MISMATCH')
  const source = scope ? scope.sourceProjectId : results[0].physicalProject?.projectId
  if (!source || results.filter(result => result.caseId.startsWith('C16')).some(result => result.physicalProject?.projectId !== source)) return fail('FINALIZATION_EFFECT_MISSING')
  // 有定稿后处理 operation 的案例（C16 三案与 C17-B）逐案核对正式效果与来源绑定。
  for (const result of results.filter(item => continuityCaseOperations(item.caseId).some(operation => ['chapter_notes', 'character_cards'].includes(operation.kind)))) {
    const failure = finalizationEvidenceBound(result)
    if (failure) return fail(failure)
  }
  for (const result of results) {
    const index = PHASE_SCENARIOS['c16-c18'].caseIds.indexOf(result.caseId)
    const expected = continuityCaseOperations(result.caseId).filter(item => !['refine', 'final-review'].includes(item.kind) || result.aiReviewedDraft?.selectedCount > 0)
    if (stableEvidence(result.operations?.map(item => item.operation)) !== stableEvidence(expected.map(item => item.id))) return fail('CANDIDATE_OPERATION_MISMATCH')
    if (!Array.isArray(result.attempts) || !Array.isArray(result.ownerTerminal)
      || result.ownerTerminal.length !== result.attempts.length) return fail('ACTUAL_OWNER_ARTIFACT_MISMATCH')
    for (const operation of result.operations) {
      const all = result.attempts.filter(attempt => attempt.binding?.operation === operation.operation)
      const condensable = operation.kind === 'draft' && condense.operationIds.includes(operation.operation)
      if (all.some(attempt => attempt.binding?.actual?.purpose?.startsWith('chapter-draft-reconcile')) || result.draftReconciliation)
        return fail('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
      const attempts = all
      const recoveryPolicy = draftRecoveryFor(PHASE_SCENARIOS['c16-c18'].attemptPolicy, 'candidate')
      const recoverable = operation.kind === 'draft' && recoveryPolicy?.operationIds.includes(operation.operation)
      const manuscript = ['review', 'refine', 'final-review'].includes(operation.kind)
      const reviewRecovery = ['review', 'final-review'].includes(operation.kind) ? reviewLengthRecoveryFor(result, operation.operation) : null
      if (attempts.length < 1 || attempts.length > (recoverable ? recoveryPolicy.maxAttempts : operation.kind === 'character_cards' ? 3 : manuscript ? operation.kind === 'refine' || reviewRecovery ? 4 : 2 : condensable ? 2 : 1)) return fail('TARGET_OPERATION_ATTEMPT_COUNT_MISMATCH')
      const ownerMismatch = attempt => {
        const actual = attempt.binding?.actual, terminal = result.ownerTerminal.find(item => item.attemptId === actual?.attemptId)
        return !actual || actual.projectId !== result.physicalProject.projectId || actual.epoch !== result.projectEpoch
          || actual.runId !== operation.handle?.runId || actual.rootActionId !== operation.handle?.rootActionId
          || !terminal?.artifactId || terminal.textHash !== attempt.visibleTextHash
          || attempt.binding.phase !== 'c16-c18' || attempt.binding.arm !== 'candidate'
          || attempt.binding.invocationId !== result.invocationId || attempt.binding.parityId !== result.physicalProject.parityHash
          || terminal.purpose !== actual.purpose ? null : terminal
      }
      if (recoverable) {
        const failure = draftRecoveryReceiptFailure(result, operation.operation, recoveryPolicy, 'candidate')
        if (failure) return fail(failure)
      }
      for (const [ordinal, attempt] of attempts.entries()) {
        const actual = attempt.binding?.actual, terminal = ownerMismatch(attempt)
        if (recoverable) { if (!terminal) return fail('ACTUAL_OWNER_IDENTITY_MISMATCH'); continue }
        if (reviewRecovery) {
          if (!terminal || terminal.status !== 'settled' || terminal.finishReason !== attempt.finishReason
            || !(ordinal === attempts.length - 1 ? ['stop'] : ['stop', 'length']).includes(terminal.finishReason)
            || terminal.hasFormalEffect !== (ordinal === attempts.length - 1)
            || !reviewRecoveryAllowed(attempts.slice(0, ordinal).map(item => ({ purpose: item.binding.actual.purpose,
              finishReason: item.finishReason })), actual.purpose, reviewRecovery)) return fail('ACTUAL_OWNER_IDENTITY_MISMATCH')
          continue
        }
        if (!terminal || terminal.finishReason !== (operation.kind === 'refine' && ordinal < attempts.length - 1 ? 'length' : 'stop')
          || terminal.hasFormalEffect !== (ordinal === attempts.length - 1)
          || ordinal === 0 && actual.purpose !== (operation.kind === 'chapter_notes' ? 'finalized-chapter-notes'
            : operation.kind === 'character_cards' ? 'finalized-character-state' : operation.kind === 'refine' ? 'refine-from-review'
              : manuscript ? 'review-chapter' : 'chapter-draft')
          || ordinal > 0 && actual.purpose !== (operation.kind === 'refine' ? 'refine-from-review' : manuscript ? 'review-chapter-rebuild'
            : condensable ? condense.condensePurpose : `finalized-character-state:repair:${ordinal}`))
          return fail('ACTUAL_OWNER_IDENTITY_MISMATCH')
      }
      // 登记的唯一压缩：首稿 hash 可复核且超出上限（生产计数），末次压缩稿才是正式保存的在范围正文。
      if (!recoverable && condensable && attempts.length === 2 && !verifiedCondensedDraft(attempts[0], result)) return fail('DRAFT_CONDENSE_NOT_REGISTERED')

    }
    if (result.physicalModelRequests !== (mode === 'real' ? result.attempts.length : 0)
      || result.syntheticDispatches !== (mode === 'synthetic' ? result.attempts.length : 0)) return fail('PHYSICAL_CALL_COUNT_MISMATCH')
    if (index >= 3 && (result.restoration?.originProjectId !== source || result.restoration?.targetProjectId !== result.physicalProject.projectId
      || result.physicalProject.projectId === source || !result.restoration.transferReceiptHash
      || !result.restoration.sourceUnchanged || !result.restoration.oldWorkFrozen
      || !validDraftObservation(result.draftObservation)
      || index >= 5 && (!result.restoration.selectedGenerationId || result.restoration.bindingMode !== 'origin-readonly')))
      return fail('RESTORE_IDENTITY_MISMATCH')
    if (index >= 3 && !admittedPredecessorBound(result)) return fail('PREDECESSOR_AFTER_REPLACEMENT_MISMATCH')
    if (index >= 3) {
      const failure = validateAiReviewedManuscript(result)
      if (failure) return fail(failure)
    }
  }
  const restored = results.filter(result => !result.caseId.startsWith('C16'))
  if (new Set(restored.map(result => result.physicalProject.projectId)).size !== restored.length) return fail('RESTORE_IDENTITY_MISMATCH')
  if (results.some(result => result.caseId === 'C16-B' && (!authorProtectionSatisfied(result, mode) || !result.sourceReplacement)
    || result.caseId === 'C16-C' && !result.sourceReplacement
    || result.caseId === 'C17-B' && !result.restoration.sourceReplacement
    || result.caseId === 'C18-B' && result.restoration.branchGenerationIds?.length !== 2))
    return fail('CONTINUITY_CASE_EVIDENCE_MISSING')
  return { status: mode === 'real' ? 'pending-independent-oracle-review' : 'passed' }
}

// Existing command tests already inject the physical completion/IPC boundaries.
// Their product text is Chinese; selection deliberately excludes language cases.
export const COMMAND_PROBES = Object.freeze([
  { file: 'directory.command.test.ts', name: 'commits append generation as an exact replace-range operation' },
  { file: 'generate-draft.command.test.ts', name: 'accepts exactly 80% of the target without requesting a continuation' },
  { file: 'refine-draft.command.test.ts', name: 'uses finalized continuity as the only established-history source in the review request' },
])
export function runProductionCommandProbe(target, env, guard) {
  const report = path.join(target.isolationRoot, 'command-probe-vitest.json')
  if (fs.existsSync(report)) fs.unlinkSync(report)
  const probes = COMMAND_PROBES.map(test => test.file === 'generate-draft.command.test.ts' && target.arm !== 'baseline'
    ? { ...test, name: 'accepts exactly 70% of the target without requesting a continuation' } : test)
  const prefix = 'src/services/workflows/commands/__tests__/'
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(guard).href, path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    ...probes.map(test => prefix + test.file), '-t', probes.map(test => test.name).join('|'),
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${report}`,
  ], { cwd: target.repositoryRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(report)) throw new Error('COMMAND_PROBE_FAILED')
  const results = JSON.parse(fs.readFileSync(report, 'utf8'))
  const passed = results.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed')
  if (passed.length !== 3 || probes.some(test => !passed.some(row => row.title === test.name))) throw new Error('COMMAND_PROBE_COVERAGE_MISMATCH')
  return { status: 'passed', passed: passed.length, commands: ['GenerateDirectoryCommand', 'GenerateDraftCommand', 'ReviewChapterCommand'], evidenceLevel: 'production-command-with-injected-completion-and-IPC', physicalModelRequests: 0, limitations: ['持久结果仅由测试IPC断言，非真实数据库落盘', '不替代中文18章质量、Electron或安装版资格'], report }
}
