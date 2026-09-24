import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as editorChecker from './feature-union-check.mjs';
const { checkFeatureUnion, checkEditorReceipt } = editorChecker;
const root = new URL('../', import.meta.url);
const plan = JSON.parse(fs.readFileSync(new URL('feature-union.json', root), 'utf8'));
const owners = JSON.parse(fs.readFileSync(new URL('dag.json', root), 'utf8')).nodes.map(n => n.id);
assert.equal(checkFeatureUnion(plan, { owners }).ok, true);
assert.equal(typeof editorChecker.resolveEditorProtocol, 'function', 'protocol dispatch helper must exist');
assert.equal(editorChecker.resolveEditorProtocol(plan.editorProtocol, 'editor-absolute-v1'), plan.editorProtocol,
  'the frozen v1 protocol object remains the historical branch');
const resolvedV2 = editorChecker.resolveEditorProtocol(plan.editorProtocol, 'editor-interaction-v2');
assert.equal(resolvedV2.protocolId, 'editor-interaction-v2');
assert.equal(resolvedV2.measurementSource, 'renderer-capture-to-second-raf-dom-ready-v1');
assert.deepEqual([resolvedV2.maxMedianInputToPaintMs, resolvedV2.maxWorstValidInputToPaintMs], [100,250]);
assert.throws(() => editorChecker.resolveEditorProtocol(plan.editorProtocol, 'unknown-editor-protocol'), /unsupported editor protocol/u);
const clone = v => structuredClone(v);
const filled = clone(plan), expectedSha = 'a'.repeat(40);
for (const feature of filled.features) for (const action of feature.actions) {
  action.status = 'pass';
  for (const key of filled.executionRequiredFields) action.evidence[key] = 'synthetic-contract-fixture';
  Object.assign(action.evidence, { surface:'writer', testedSha:expectedSha, evidenceLevels:action.requiredEvidenceLevels, receipt:'synthetic-receipt', stepId:action.actionId });
}
filled.features[1].actions.find(action => action.actionId === 'U02.A02').evidence.migrationScenario = 'legacy-shell-preference-to-writer';
filled.features[1].actions.find(action => action.actionId === 'U02.A07').evidence.migrationScenario = 'legacy-shell-preference-with-project-state-to-writer';
let negativeCases = 0;
const reject = result => { assert.equal(result.ok,false); negativeCases++; };
const qualify = p => checkFeatureUnion(p, { mode:'qualification', owners, expectedSha });
assert.equal(qualify(filled).ok, true); // Shape only, never a product PASS.
let bad = clone(filled); bad.features[1].actions.find(action => action.actionId === 'U02.A07').evidence.migrationScenario = 'classic-toggle'; reject(qualify(bad));
bad = clone(filled); delete bad.features[1].actions.find(action => action.actionId === 'U02.A02').evidence.migrationScenario; reject(qualify(bad));
bad = clone(filled); bad.features[2].actions[0].evidence.evidenceLevels = ['browser'];
assert.equal(qualify(bad).ok, true); // U03.A01 is ordinary navigation.
bad = clone(filled); bad.features[0].actions[0].evidence.evidenceLevels = ['browser']; reject(qualify(bad));
bad = clone(filled); bad.features[2].actions[0].evidence.evidenceLevels = []; reject(qualify(bad));
const olderSha = 'b'.repeat(40), reused = clone(filled);
reused.features[2].actions[0].evidence.testedSha = olderSha;
reject(qualify(reused));
reused.features[2].actions[0].evidence.reuseDecision = { testedSha:olderSha, changedPaths:['docs/agents/delivery.md'], differences:'execution wording only', reason:'Writer navigation code and browser fixture unchanged; reviewer accepted reuse' };
assert.equal(qualify(reused).ok, true); // Shape only; reviewer must assess the claim.
bad = clone(reused); bad.features[2].actions[0].evidence.reuseDecision.changedPaths = []; reject(qualify(bad));
bad = clone(reused); bad.features[2].actions[0].evidence.reuseDecision.differences = ' '; reject(qualify(bad));
bad = clone(reused); bad.features[2].actions[0].evidence.reuseDecision.reason = ''; reject(qualify(bad));
bad = clone(reused); bad.features[2].actions[0].evidence.reuseDecision.testedSha = expectedSha; reject(qualify(bad));
bad = clone(plan); bad.features[0].status = 'pass'; bad.features[0].actions[0] = filled.features[0].actions[0];
reject(qualify(bad));
bad = clone(filled); bad.features.at(-1).actions[0].owner = 'B02'; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[0].evidence.surface = 'classic'; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[1].actionId = bad.features[0].actions[0].actionId; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[0].evidence.receipt = null; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[1].evidence.stepId = bad.features[0].actions[0].evidence.stepId; reject(qualify(bad));
const timing = { production:true, writerLivePreview:true, imeExactMatch:true, imeLossCount:0, imeDuplicateCount:0, selectionUndoExact:true, rerunIndex:0,
  samples:{}, baseline:{testedSha:'b'.repeat(40),receipt:'isolated-historical-classic-receipt',samples:{}} };
for (const units of plan.editorProtocol.units) {
  timing.samples[units]={};
  timing.baseline.samples[units]={};
  for(const shell of ['writer']) {
    timing.samples[units][shell]={};
    for(const action of plan.editorProtocol.actions) {
      timing.samples[units][shell][action] = {warmupSamplesMs:[30,30,30],rawSamplesMs:[29,30,30,30,30,30,31],longTasksMs:[]};
      timing.baseline.samples[units][action] = {warmupSamplesMs:[30,30,30],rawSamplesMs:[29,30,30,30,30,30,31],longTasksMs:[]};
    }
  }
}
const checkTiming = value => checkEditorReceipt(plan.editorProtocol,value);
assert.equal(checkTiming(timing).ok,true);
bad = clone(timing); for(const pair of Object.values(bad.samples)) for(const shell of Object.values(pair)) for(const action of Object.values(shell)) action.rawSamplesMs = [200,200,200,200,200,200,200];
reject(checkTiming(bad));
bad = clone(timing); bad.imeLossCount=1; reject(checkTiming(bad));
bad = clone(timing); bad.writerLivePreview=false; reject(checkTiming(bad));
bad = clone(timing); delete bad.samples[200000].writer.selection; reject(checkTiming(bad));
bad = clone(timing); bad.samples[3000].writer.input.rawSamplesMs.pop(); reject(checkTiming(bad));
bad = clone(timing); bad.unstable=false; bad.samples[3000].writer.input.rawSamplesMs=[10,20,25,30,35,40,45]; reject(checkTiming(bad));
bad = clone(timing); bad.samples[3000].writer.selection.rawSamplesMs=[40,40,40,40,40,40,40]; reject(checkTiming(bad));
bad = clone(timing); delete bad.samples[3000].writer.input; reject(checkTiming(bad));
bad = clone(timing); bad.baseline.testedSha=''; reject(checkTiming(bad));
bad = clone(timing); delete bad.baseline.samples[3000].input; reject(checkTiming(bad));
bad = clone(timing); bad.samples[200000].writer.selection.longTasksMs=[70]; reject(checkTiming(bad));
const v2Protocol = { protocolId:'editor-interaction-v2', measurementSource:'renderer-capture-to-second-raf-dom-ready-v1',
  units:[3000,200000], actions:['input','selection'], warmupCount:3,
  sampleCount:7, maxMedianInputToPaintMs:100, maxWorstValidInputToPaintMs:250, maxRerunIndex:1 };
const v2Receipt = { protocolId:'editor-interaction-v2', measurementSource:'renderer-capture-to-second-raf-dom-ready-v1',
  production:true, writerLivePreview:true, rerunIndex:0, samples:{} };
for (const units of v2Protocol.units) {
  v2Receipt.samples[units] = { writer:{} };
  for (const action of v2Protocol.actions) {
    const observation = { eventCapturedInRenderer:true, trustedEvent:true, targetIsEditor:true, capturePhase:true, preStateMatched:true,
      terminal:{ documentMatches:true, caretOrSelectionMatches:true, visibleDomMatches:true, secondRaf:true,
        nativeAnchor:action === 'input' ? 1 : 0, nativeHead:1, nativeRangeStart:action === 'input' ? 1 : 0,
        nativeRangeEnd:1, focused:true, visible:true } };
    v2Receipt.samples[units].writer[action] = { warmupSamplesMs:[30,31,29], rawSamplesMs:[28,30,32,31,29,33,35],
      longTasksMs:[900], warmupObservations:[observation,observation,observation],
      rawObservations:[observation,observation,observation,observation,observation,observation,observation] };
  }
}
assert.equal(checkEditorReceipt(v2Protocol, v2Receipt).ok, true,
  'v2 must qualify on its own absolute budgets without Classic, MAD, or long-task gates');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawObservations[0].terminal.documentMatches = false;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must reject a sample with an incorrect full-document terminal state');
bad = clone(v2Receipt); bad.samples[200000].writer.selection.rawObservations[0].terminal.nativeAnchor = 1;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must reject native DOM selection positions that differ from CodeMirror state');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawObservations[0].terminal.focused = false;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must reject a terminal state captured after focus loss');
bad = clone(v2Receipt); bad.measurementSource = 'synthetic-event-dispatch';
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must bind to the real renderer-capture measurement source');
bad = clone(v2Receipt); bad.protocolId = 'editor-absolute-v1';
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must reject a receipt relabeled with the frozen v1 protocol');
bad = clone(v2Receipt); bad.rerunIndex = 1;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 may rerun only after an environment INVALID');
bad = clone(v2Receipt); bad.rerunIndex = 1;
bad.priorReceipt = { outcome:'INVALID', invalidReason:'foreground window lost', sameConditions:true, rerunIndex:0 };
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, true, 'one same-condition environment rerun is allowed');
bad.priorReceipt.rerunIndex = 1;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'a second environment rerun is forbidden');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawObservations[2].eventCapturedInRenderer = false;
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 must reject samples without a renderer event');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawSamplesMs = [100,100,100,100,100,100,250];
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, true, 'v2 accepts the inclusive median and maximum budgets without MAD/long-task gates');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawSamplesMs = [101,101,101,101,101,101,101];
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 enforces the absolute median budget');
bad = clone(v2Receipt); bad.samples[3000].writer.input.rawSamplesMs = [1,2,3,4,5,6,251];
assert.equal(checkEditorReceipt(v2Protocol, bad).ok, false, 'v2 enforces the absolute worst-sample budget');
assert.throws(() => editorChecker.assertEditorReceipt(v2Protocol, bad), /absolute responsiveness failed/u,
  'a v2 budget failure must be throwable by the journey CLI');
const partialSamples = {}, sampleAttempts = [];
editorChecker.recordEditorAttempt(partialSamples, sampleAttempts, { units:3000, action:'input', index:0, phase:'warmup',
  result:{ elapsedMs:40, longTasksMs:[], observation:v2Receipt.samples[3000].writer.input.warmupObservations[0] } });
editorChecker.recordEditorAttempt(partialSamples, sampleAttempts, { units:3000, action:'selection', index:0, phase:'warmup',
  error:new Error('PERF_SELECTION_TERMINAL_STATE_TIMEOUT') });
assert.deepEqual(partialSamples[3000].writer.input.rawSamplesMs, []);
assert.deepEqual(partialSamples[3000].writer.input.warmupSamplesMs, [40], 'prior samples remain in the receipt after a later timeout');
assert.equal(sampleAttempts.length, 2);
assert.equal(sampleAttempts[1].outcome, 'FAIL');
assert.match(sampleAttempts[1].error, /TERMINAL_STATE_TIMEOUT/u, 'the timeout itself is retained');
const minimizedAfterEventFailure = { step:'U06.A08', sample:{ units:3000, action:'input', index:4, phase:'raw' },
  message:'PERF_INPUT_TERMINAL_STATE_TIMEOUT' };
assert.equal(editorChecker.isEditorEnvironmentInvalid(minimizedAfterEventFailure, [{ ...minimizedAfterEventFailure.sample,
  windowEvents:[{ type:'minimize', at:123 }] }]), true,
  'a minimize during a timed-out post-event wait is environmental INVALID');
assert.equal(editorChecker.isEditorEnvironmentInvalid(minimizedAfterEventFailure, [{ ...minimizedAfterEventFailure.sample,
  windowEvents:[] }]), false, 'a terminal timeout without focus-loss evidence remains FAIL');
const sourceBinding = { driverRepository:'C:/work/tree', sourceRoot:'C:/work/tree', executionHead:'a'.repeat(40),
  sourceHead:'a'.repeat(40), testedSha:'a'.repeat(40), executionDirty:false, sourceDirty:false };
assert.equal(editorChecker.checkEditorExecutionBinding(sourceBinding).ok, true);
for (const patch of [{ driverRepository:'C:/dirty/tree' }, { executionHead:'b'.repeat(40) },
  { sourceHead:'c'.repeat(40) }, { executionDirty:true }, { sourceDirty:true }]) {
  assert.equal(editorChecker.checkEditorExecutionBinding({ ...sourceBinding, ...patch }).ok, false,
    'U06 cannot bind a dirty or mismatched execution tree to a clean package source');
}
console.log(JSON.stringify({status:'PASS',scope:'plan-contract fixtures only; product checks NOT RUN',groups:plan.features.length,actions:plan.features.reduce((n,f)=>n+f.actions.length,0),negativeCases,editorActions:plan.editorProtocol.actions,samplesPerAction:plan.editorProtocol.sampleCount}));
