import assert from 'node:assert/strict'
import { test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { PLANNING_NATIVE_DIAGNOSTIC, planningNativeOperations, qualificationBridgeWindows } from '../quality-modernization-driver.mjs'
import { ROOT, CAMPAIGN_ID, hash, createProductionTargets, currentProtocolBinding, forwardReasoningFor } from '../quality-modernization-run.mjs'

test('saved six-chapter continuation selects no outline or prepare operation', () => {
  assert.deepEqual(planningNativeOperations(PLANNING_NATIVE_DIAGNOSTIC.caseId, 'resume-from-saved-outline')
    .map(item => item.kind), ['directory', 'directory', 'draft', 'review'])
})

test('preflight uses the same selector and has no dispatch allowance', () => {
  const policy = PLANNING_NATIVE_DIAGNOSTIC
  const request = { phase: 'planning-native-diagnostic', milestone: 'diagnostic', arm: 'candidate', caseId: policy.caseId,
    scenarioRevision: policy.scenarioRevision, attemptPolicy: policy.attemptPolicy, evaluationPolicy: policy.evaluationPolicy,
    nativeAction: 'resume-from-saved-outline', action: 'resume-preflight', operations: planningNativeOperations(policy.caseId, 'resume-from-saved-outline', 'resume-preflight') }
  assert.equal(qualificationBridgeWindows(request).maxCalls, 0)
  assert.throws(() => qualificationBridgeWindows({ ...request, operations: planningNativeOperations(policy.caseId, 'review') }), /SCOPE/)
})

const inputPath = process.env.QUALITY_PLANNING_RESUME_TEST_INPUT
test.skipIf(!inputPath)('saved-outline continuation uses real owners and SQLite with a synthetic provider', async () => {
  const evidence = process.env.QUALITY_PLANNING_RESUME_TEST_EVIDENCE
    ?? fs.mkdtempSync(path.join(ROOT, '.runtime/.cache/novel-quality-modernization/planning-resume-test-'))
  fs.mkdirSync(evidence, { recursive: true })
  const adapter = path.join(evidence, 'adapter')
  fs.mkdirSync(path.join(adapter, 'scripts/fixtures'), { recursive: true })
  for (const name of ['src', 'electron', 'node_modules', 'test']) fs.symlinkSync(path.join(ROOT, name), path.join(adapter, name), 'junction')
  for (const name of ['quality-modernization-driver.mjs', 'quality-modernization-run.mjs', 'quality-modernization-receipt.mjs'])
    fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(adapter, 'scripts', name))
  fs.copyFileSync(path.join(ROOT, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), path.join(adapter, 'scripts/fixtures/quality-modernization-production.fixture.mjs'))
  const protocolFile = path.join(adapter, 'docs/research/novel-quality-modernization/protocol.json')
  fs.mkdirSync(path.dirname(protocolFile), { recursive: true })
  const protocol = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/research/novel-quality-modernization/protocol.json')))
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
  write(protocolFile, protocol)
  const targetFile = path.join(ROOT, '.runtime/.cache/novel-quality-modernization', `resume-test-target-${path.basename(evidence)}.json`)
  const preparedTarget = createProductionTargets(undefined, targetFile, { development: true, phase: 'planning-native-diagnostic' })
  const target = preparedTarget.targets.candidate
  const policy = PLANNING_NATIVE_DIAGNOSTIC
  const roots = Object.fromEntries(Object.entries(target.roots).map(([key, directory]) => [key, path.join(directory, policy.invocationId.slice(0, 8))]))
  const isolationRoot = path.join(target.isolationRoot, 'invocations', policy.invocationId)
  for (const directory of [isolationRoot, ...Object.values(roots)]) fs.mkdirSync(directory, { recursive: true })
  const runtimeTarget = { ...target, roots, isolationRoot, declaredRoots: target.roots, declaredIsolationRoot: target.isolationRoot }
  const oldDriver = await import(pathToFileURL(path.join(adapter, 'scripts/quality-modernization-driver.mjs')).href)
  const ledger = path.join(adapter, '.runtime/.cache/novel-quality-modernization/ledger.jsonl')
  fs.mkdirSync(path.dirname(ledger), { recursive: true })
  const templates = path.join(isolationRoot, 'planning-native-templates.json')
  const common = { phase: 'planning-native-diagnostic', mode: 'synthetic', development: true, milestone: 'diagnostic',
    diagnosticInputPath: inputPath, caseId: policy.caseId, invocationId: policy.invocationId, sceneId: policy.sceneId, chapterNumber: policy.chapterNumber,
    scenarioRevision: policy.scenarioRevision, attemptPolicy: policy.attemptPolicy, evaluationPolicy: policy.evaluationPolicy,
    forwardReasoning: forwardReasoningFor(protocol, 'planning-native-diagnostic', 'diagnostic'), forwardQualificationWindow: null,
    ...currentProtocolBinding(), semanticPath: path.join(ROOT, protocol.fixturePath), ledgerPath: ledger,
    target: runtimeTarget, driverHash: oldDriver.productionBridgeHash(), templatesPath: templates }
  const prepared = oldDriver.runProductionBridge({ ...common, nativeAction: 'prepare', action: 'prepare',
    operations: planningNativeOperations(policy.caseId, 'prepare') })
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const db = new Database(prepared.runtimePaths.databasePath)
  const synopsis = Array.from({ length: 6 }, (_, i) => `## 第${i + 1}章：保存稿${i + 1}\n\n林砚核对第${i + 1}份维修记录并保留交付证据。`).join('\n\n')
  db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(synopsis)
  db.close()
  const projectId = prepared.physicalProject.projectId, oldEpoch = prepared.projectEpoch
  const rows = []
  for (let i = 0; i < 6; i++) {
    const attemptId = `candidate:synthetic-outline-${i + 1}`
    const binding = { campaignId: CAMPAIGN_ID, mode: 'synthetic', arm: 'candidate', ...currentProtocolBinding(),
      codeSha: target.codeSha, sourceHash: target.sourceHash, driverHash: oldDriver.productionBridgeHash(), parityId: prepared.physicalProject.parityHash,
      phase: common.phase, milestone: 'diagnostic', caseId: policy.caseId, invocationId: policy.invocationId,
      operation: i < 5 ? 'planning-outline-1-5' : 'planning-outline-6', planningRange: i < 5 ? [1, 5] : [6, 6],
      diagnosticInputHash: policy.diagnosticInputHash, diagnosticSourceHash: hash(policy.sources),
      stageModel: { profileId: policy.modelProfile.profileId, configurationHash: policy.modelProfile.configurationHash },
      actual: { attemptId: attemptId.slice(10), projectId, epoch: oldEpoch, runId: i < 5 ? 'outline-1-5' : 'outline-6',
        rootActionId: i < 5 ? 'outline-1-5' : 'outline-6', purpose: `plot-outline:chapter:${i + 1}:normal` } }
    rows.push({ type: 'reserve', attemptId, binding, allocation: 'nonQualificationDiagnostic' }, { type: 'dispatch', attemptId },
      { type: i === 5 ? 'unknown' : 'settle', attemptId, ...(i === 5 ? {} : { finishReason: 'stop', usage: { actualTokens: 100 + i } }) })
  }
  const oldRaw = rows.map(row => JSON.stringify(row) + '\n').join('')
  fs.writeFileSync(ledger, oldRaw)
  const sixth = { artifactId: 'synthetic-sixth-artifact', attemptId: 'synthetic-outline-6', text: '第六章完整保存产物' }
  const failed = { ...prepared, status: 'failed', code: 'RETAINED_SYNTHETIC_LEDGER_FAILURE', savedEvidence: { core: { synopsis } },
    recovery: { artifacts: [sixth] } }
  const failedPath = path.join(evidence, 'old-failure.json'); write(failedPath, failed)
  const executionPath = path.join(evidence, 'old-execution.json')
  write(executionPath, { target: runtimeTarget, targetHash: hash(target), prepared, results: { review: failed }, ledgerPath: ledger })
  const ref = file => ({ path: file, sha256: hash(fs.readFileSync(file)) })
  const attempts = rows.filter(row => row.type === 'reserve').map((row, i) => ({ attemptId: row.attemptId,
    bindingHash: hash(row.binding), terminal: i === 5 ? 'unknown' : 'settle' }))
  const manifest = { schemaVersion: 1, continuationId: policy.savedOutlineContinuation.continuationId,
    invocationId: policy.invocationId, caseId: policy.caseId, sourceSha: target.codeSha, sourceHash: target.sourceHash,
    references: { baseTargets: ref(targetFile), execution: ref(executionPath), preparation: ref(prepared.receiptPath),
      failedReview: ref(failedPath), templates: ref(templates), planningSource: ref(path.join(isolationRoot, 'planning-source.json')),
      physicalProject: ref(path.join(isolationRoot, 'physical-project.json')) },
    project: { projectId, path: prepared.physicalProject.path, epoch: oldEpoch, rosterHash: hash(prepared.planningSource.roster) },
    synopsisHash: hash(synopsis), sixthArtifact: { artifactId: sixth.artifactId, attemptId: sixth.attemptId, textHash: hash(sixth.text) },
    ledger: { path: ledger, eventCount: rows.length, rawBytesSha256: hash(oldRaw) }, attempts }
  const manifestFile = path.join(evidence, 'synthetic-manifest.json'); write(manifestFile, manifest)
  const registration = { continuationId: manifest.continuationId, manifestHash: hash(fs.readFileSync(manifestFile)), sourceHash: target.sourceHash, projectId, attempts }
  protocol.phases[common.phase].savedOutlineContinuation = registration
  write(protocolFile, protocol)
  const driverFile = path.join(adapter, 'scripts/quality-modernization-driver.mjs')
  let driverSource = fs.readFileSync(driverFile, 'utf8')
  const start = driverSource.indexOf('  savedOutlineContinuation: ', driverSource.indexOf('export const PLANNING_NATIVE_DIAGNOSTIC'))
  const end = driverSource.indexOf("  sceneId: '场景1', caseId: 'planning-six-chapters'", start)
  driverSource = driverSource.slice(0, start) + `  savedOutlineContinuation: ${JSON.stringify(registration)},\n` + driverSource.slice(end)
  fs.writeFileSync(driverFile, driverSource)
  const runnerFile = path.join(adapter, 'scripts/quality-modernization-run.mjs')
  const runnerSource = fs.readFileSync(runnerFile, 'utf8')
  fs.writeFileSync(runnerFile, runnerSource.replace("const planningBoundary = options.campaignMode === 'real' ? protocol.historicalPlanningSavedOutlineBoundary : options.historicalPlanningSavedOutlineBoundary",
    "const planningBoundary = options.campaignMode === 'real' ? protocol.historicalPlanningSavedOutlineBoundary : (options.historicalPlanningSavedOutlineBoundary ?? protocol.syntheticPlanningBoundary)"))
  protocol.syntheticPlanningBoundary = { fromEventCount: 0, eventCount: rows.length, rawBytesSha256: hash(oldRaw),
    protocolRevision: common.protocolRevision, protocolHash: common.protocolHash,
    reserveAttempts: attempts.map(item => ({ attemptId: item.attemptId, invocationId: policy.invocationId, terminal: item.terminal })) }
  write(protocolFile, protocol)
  const child = path.join(evidence, 'continue.mjs')
  const newTarget = { ...target, codeSha: 'b'.repeat(40), subjectSha: 'b'.repeat(40), protocolHash: hash(fs.readFileSync(protocolFile)) }
  const options = { ...common, ...newTarget, target: undefined, protocolHash: newTarget.protocolHash, nativeAction: 'resume-from-saved-outline',
    resumeSourcePath: manifestFile, driverHash: undefined }
  write(path.join(evidence, 'test-context.json'), { target: newTarget, options })
  fs.writeFileSync(child, `import fs from 'node:fs';
import {runProductionPhasePair} from ${JSON.stringify(pathToFileURL(driverFile).href)};
const {target,options}=JSON.parse(fs.readFileSync(new URL('./test-context.json',import.meta.url)));
const result=runProductionPhasePair({candidate:target},options);
fs.writeFileSync(new URL('./result.json',import.meta.url),JSON.stringify(result,null,2));
if(result.status!=='pending-independent-oracle-review') process.exitCode=1;
`)
  const run = spawnSync(process.execPath, [child], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  fs.writeFileSync(path.join(evidence, 'child-stdout.txt'), run.stdout ?? '')
  fs.writeFileSync(path.join(evidence, 'child-stderr.txt'), run.stderr ?? '')
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'))), receipt = result.results[0]
  assert.equal(receipt.physicalModelRequests, 0)
  assert.ok(receipt.syntheticDispatches > 0)
  assert.equal(receipt.attempts[0].binding.operation, 'planning-directory-1-5')
  assert.ok(receipt.attempts.every(item => !item.binding.operation.startsWith('planning-outline')))
  assert.equal(receipt.attempts[0].planningConsumption.find(item => item.field === 'synopsis').contentHash, hash(synopsis))
  assert.equal(receipt.attempts[0].planningConsumption.find(item => item.field === 'synopsis').completeTextSent, true)
  assert.equal(receipt.physicalProject.projectId, projectId)
  assert.notEqual(receipt.projectEpoch, oldEpoch)
  assert.equal(receipt.savedEvidence.core.synopsis, synopsis)
  assert.deepEqual(receipt.planningSource.roster, prepared.planningSource.roster)
  assert.deepEqual(receipt.saved.blueprintChapterNumbers, [1, 2, 3, 4, 5, 6])
  assert.equal(receipt.sourceClosed, true)
  assert.equal(result.journeyRequests.historical, 6)
  assert.equal(result.journeyRequests.continuation, receipt.attempts.length)
  assert.equal(result.journeyRequests.total, 6 + receipt.attempts.length)
  assert.equal(fs.readFileSync(ledger, 'utf8').slice(0, oldRaw.length), oldRaw)
  for (const reference of Object.values(manifest.references)) assert.equal(hash(fs.readFileSync(reference.path)), reference.sha256)
  const record = JSON.parse(fs.readFileSync(result.executionRecordPath))
  assert.equal(record.prepared, undefined)
  assert.equal(record.preflight.attempts.length, 0)
  assert.ok(!record.preflight.invocations.includes('db:project-core-update'))
  assert.equal(record.preflight.savedEvidence.draft, null)
  const snapshot = JSON.parse(fs.readFileSync(path.join(`${result.executionRecordPath}.evidence`, 'planning-native-templates.json')))
  assert.equal(snapshot.sourceSha, newTarget.codeSha)
  assert.deepEqual(snapshot.templates, JSON.parse(fs.readFileSync(templates)).templates)
  assert.equal(snapshot.predecessor.sourceSha, target.codeSha)
  const beforeReplay = fs.readFileSync(ledger)
  const replay = spawnSync(process.execPath, [child], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(replay.status, 0, replay.stderr)
  assert.deepEqual(fs.readFileSync(ledger), beforeReplay)
  const negativeFile = path.join(evidence, 'negative-matrix.mjs')
  fs.writeFileSync(negativeFile, `import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as d from ${JSON.stringify(pathToFileURL(driverFile).href)};
const {target,options}=JSON.parse(fs.readFileSync(new URL('./test-context.json',import.meta.url)));
const result=JSON.parse(fs.readFileSync(new URL('./result.json',import.meta.url)));
const source=d.readPlanningResumeSource(options.resumeSourcePath), manifest=source.manifest;
const recordBytes=fs.readFileSync(result.executionRecordPath), record=JSON.parse(recordBytes);
const ledgerBefore=fs.readFileSync(options.ledgerPath), checks=[];
let calls=0;
const forbidden=()=>{ calls++; throw Error('UNEXPECTED_BRIDGE'); };
const run=(nextTarget=target,nextOptions=options)=>d.runProductionPhasePair({candidate:nextTarget},nextOptions,forbidden);
assert.throws(()=>run({...target,roots:source.execution.target.roots}),/TARGET_DRIFT/); checks.push('runtime-as-base roots');
assert.throws(()=>run(target,{...options,executionRecordPath:result.executionRecordPath+'.other'}),/RECORD_PATH/); checks.push('replacement suffix');
for(const file of [options.resumeSourcePath,manifest.references.templates.path,path.join(result.executionRecordPath+'.evidence','planning-native-templates.json')]) {
  const bytes=fs.readFileSync(file); try { fs.writeFileSync(file,Buffer.concat([bytes,Buffer.from(' ')])); assert.throws(()=>run(),/DRIFT/); }
  finally {fs.writeFileSync(file,bytes);} }
checks.push('manifest, predecessor template and current snapshot drift');
const receiptPath=result.results[0].receiptPath, displaced=receiptPath+'.test-retained';
fs.renameSync(receiptPath,displaced);
try { delete record.results['resume-from-saved-outline']; fs.writeFileSync(result.executionRecordPath,JSON.stringify(record));
  assert.equal(run().results[0].code,'SENT_STEP_OUTCOME_UNKNOWN');
  assert.equal(run().results[0].code,'SENT_STEP_OUTCOME_UNKNOWN'); }
finally { fs.renameSync(displaced,receiptPath);fs.writeFileSync(result.executionRecordPath,recordBytes); }
checks.push('interrupted sent step is retained without replay');
assert.equal(calls,0);
const preflight=(name)=>d.runProductionBridge({...options,target:d.planningResumeTarget(target,source),
  nativeAction:'resume-from-saved-outline',action:'resume-preflight',mode:'synthetic',
  savedOutlineContinuation:{continuationId:manifest.continuationId,manifestHash:source.manifestHash},
  driverHash:d.productionBridgeHash(),operations:[],parityHash:source.preparation.physicalProject.parityHash,
  evidenceRoot:path.join(path.dirname(options.resumeSourcePath),'negative-'+name),
  templatesPath:path.join(path.dirname(options.resumeSourcePath),'negative-'+name+'-templates.json')});
const db=new Database(source.preparation.runtimePaths.databasePath);
const synopsis=db.prepare("SELECT synopsis FROM project_core WHERE id='main'").pluck().get();
db.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(synopsis+'\\n被编辑');db.close();
try { assert.throws(()=>preflight('synopsis'),/PRODUCTION_BRIDGE_FAILED/);
  const receipt=JSON.parse(fs.readFileSync(new URL('./negative-synopsis/resume-preflight-receipt.json',import.meta.url)));
  assert.match(receipt.error,/SYNOPSIS_DRIFT/);assert.equal(receipt.attempts.length,0); }
finally { const restore=new Database(source.preparation.runtimePaths.databasePath);restore.prepare("UPDATE project_core SET synopsis=? WHERE id='main'").run(synopsis);restore.close(); }
checks.push('changed synopsis rejects before dispatch even though parity omits synopsis');
const promptFile=path.join(source.execution.target.roots.config,'prompts/chapter_blueprint_chunk.json');
const promptBytes=fs.readFileSync(promptFile), prompt=JSON.parse(promptBytes);prompt.content+='\\nchanged';fs.writeFileSync(promptFile,JSON.stringify(prompt));
try { assert.throws(()=>preflight('template'),/PRODUCTION_BRIDGE_FAILED/);
  const receipt=JSON.parse(fs.readFileSync(new URL('./negative-template/resume-preflight-receipt.json',import.meta.url)));
  assert.match(receipt.error,/TEMPLATE_DRIFT/);assert.equal(receipt.attempts.length,0); }
finally { fs.writeFileSync(promptFile,promptBytes); }
checks.push('current resolver payload drift rejects before dispatch');
assert.deepEqual(fs.readFileSync(options.ledgerPath),ledgerBefore);
fs.writeFileSync(new URL('./negative-results.json',import.meta.url),JSON.stringify({status:'passed',checks,extraDispatches:0},null,2));
`)
  const negative = spawnSync(process.execPath, [negativeFile], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  fs.writeFileSync(path.join(evidence, 'negative-stderr.txt'), negative.stderr ?? '')
  assert.equal(negative.status, 0, negative.stderr)
  const review = receipt.aiReviewedDraft.review, approvalPath = path.join(evidence, 'approval.json')
  write(approvalPath, { kind: 'planning-refinement', receiptPath: receipt.receiptPath, receiptHash: hash(fs.readFileSync(receipt.receiptPath)),
    reviewId: review.reviewId, reportHash: review.contentHash, findingIds: receipt.aiReviewedDraft.findings.map(item => item.findingId) })
  write(path.join(evidence, 'test-context.json'), { target: newTarget, options: { ...options, nativeAction: 'complete', approvalPath } })
  const completed = spawnSync(process.execPath, [child], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  fs.writeFileSync(path.join(evidence, 'complete-stderr.txt'), completed.stderr ?? '')
  assert.equal(completed.status, 0, completed.stderr)
  const completion = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'))), last = completion.results[0]
  assert.deepEqual(last.attempts.map(item => item.binding.operation), ['planning-refine', 'planning-final-review'])
  assert.equal(last.nativeApproval.receiptHash, hash(fs.readFileSync(receipt.receiptPath)))
  assert.equal(last.aiReviewedDraft.review.reviewId, receipt.aiReviewedDraft.review.reviewId)
  assert.equal(last.sourceClosed, true)
  assert.equal(last.savedEvidence.core.synopsis, synopsis)
  assert.equal(last.savedEvidence.blueprints.length, 6)
  assert.ok(last.savedEvidence.reviews.length >= 2 && last.savedEvidence.revisions.length >= 1)
  assert.equal(completion.journeyRequests.total, 6 + receipt.attempts.length + last.attempts.length)
  assert.ok(!JSON.parse(fs.readFileSync(completion.executionRecordPath)).results.review)
  fs.copyFileSync(path.join(evidence, 'result.json'), path.join(evidence, 'complete-result.json'))
  for (const reference of Object.values(manifest.references)) assert.equal(hash(fs.readFileSync(reference.path)), reference.sha256)
  assert.equal(fs.readFileSync(ledger, 'utf8').slice(0, oldRaw.length), oldRaw)
  write(path.join(evidence, 'adapter-substitutions.json'), { driver: ['savedOutlineContinuation registration'],
    runner: ['synthetic historical-boundary option default from private protocol'], fixture: [],
    sourceInput: inputPath, repositoryRoot: ROOT, newCodeSha: newTarget.codeSha, limitations: 'Synthetic SHA and prefix authenticate only this test. Product command, owner, SQLite, selection and source validation functions are current implementations.' })
}, 180_000)
