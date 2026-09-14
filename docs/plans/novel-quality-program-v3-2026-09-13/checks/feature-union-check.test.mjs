import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkFeatureUnion, checkEditorReceipt } from './feature-union-check.mjs';
const root = new URL('../', import.meta.url);
const plan = JSON.parse(fs.readFileSync(new URL('feature-union.json', root), 'utf8'));
const owners = JSON.parse(fs.readFileSync(new URL('dag.json', root), 'utf8')).nodes.map(n => n.id);
assert.equal(checkFeatureUnion(plan, { owners }).ok, true);
const clone = v => structuredClone(v);
const filled = clone(plan), expectedSha = 'a'.repeat(40);
for (const feature of filled.features) for (const action of feature.actions) {
  action.status = 'pass';
  for (const key of filled.executionRequiredFields) action.evidence[key] = 'synthetic-contract-fixture';
  Object.assign(action.evidence, { surface:'writer', testedSha:expectedSha, evidenceLevels:action.requiredEvidenceLevels, receipt:'synthetic-receipt', stepId:action.actionId });
}
let negativeCases = 0;
const reject = result => { assert.equal(result.ok,false); negativeCases++; };
const qualify = p => checkFeatureUnion(p, { mode:'qualification', owners, expectedSha });
assert.equal(qualify(filled).ok, true); // Shape only, never a product PASS.
let bad = clone(plan); bad.features[0].status = 'pass'; bad.features[0].actions[0] = filled.features[0].actions[0];
reject(qualify(bad));
bad = clone(filled); bad.features.at(-1).actions[0].owner = 'B02'; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[0].evidence.surface = 'classic'; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[1].actionId = bad.features[0].actions[0].actionId; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[0].evidence.receipt = null; reject(qualify(bad));
bad = clone(filled); bad.features[0].actions[1].evidence.stepId = bad.features[0].actions[0].evidence.stepId; reject(qualify(bad));
const timing = { production:true, writerLivePreview:true, imeExactMatch:true, imeLossCount:0, imeDuplicateCount:0, selectionUndoExact:true, rerunIndex:0, samples:{} };
for (const units of plan.editorProtocol.units) {
  timing.samples[units]={};
  for(const shell of ['classic','writer']) {
    timing.samples[units][shell]={};
    for(const action of plan.editorProtocol.actions) timing.samples[units][shell][action] = {warmupSamplesMs:[30,30,30],rawSamplesMs:[29,30,30,30,30,30,31],longTasksMs:[]};
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
bad = clone(timing); bad.samples[3000].classic.input.warmupSamplesMs.pop(); reject(checkTiming(bad));
bad = clone(timing); bad.samples[200000].writer.selection.longTasksMs=[70]; reject(checkTiming(bad));
console.log(JSON.stringify({status:'PASS',scope:'plan-contract fixtures only; product checks NOT RUN',groups:plan.features.length,actions:plan.features.reduce((n,f)=>n+f.actions.length,0),negativeCases,editorActions:plan.editorProtocol.actions,samplesPerAction:plan.editorProtocol.sampleCount}));
