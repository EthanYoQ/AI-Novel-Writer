// Plan-contract checker only. Valid structure is not proof that external receipts are genuine.
import fs from 'node:fs';
const currentLevels = JSON.parse(fs.readFileSync(new URL('../../../research/novel-quality-modernization/feature-evidence-levels.json', import.meta.url), 'utf8'));
const LOCAL_ARCHIVE_ACTIONS = new Set(['U16.A01', 'U16.A02', 'U16.A08', 'U16.A11', 'U16.A12']);
export function resolveEditorProtocol(frozenProtocol, protocolId) {
  if (protocolId === 'editor-absolute-v1' && frozenProtocol.id === protocolId) return frozenProtocol;
  if (protocolId !== 'editor-interaction-v2' || frozenProtocol.id !== 'editor-absolute-v1') throw new Error('unsupported editor protocol');
  return { protocolId, measurementSource:'renderer-capture-to-second-raf-dom-ready-v1', units: frozenProtocol.units,
    actions: frozenProtocol.actions, warmupCount: frozenProtocol.warmupCount,
    sampleCount: frozenProtocol.sampleCount, maxMedianInputToPaintMs:100, maxWorstValidInputToPaintMs:250, maxRerunIndex:1 };
}
export function checkEditorExecutionBinding({ driverRepository, sourceRoot, executionHead, sourceHead, testedSha,
  executionDirty, sourceDirty }) {
  const errors = [];
  const normalize = value => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase();
  if (!normalize(driverRepository) || normalize(driverRepository) !== normalize(sourceRoot)) errors.push('driver/source repository mismatch');
  if (!/^[a-f0-9]{40}$/u.test(testedSha ?? '') || executionHead !== testedSha || sourceHead !== testedSha) errors.push('execution/source HEAD mismatch');
  if (executionDirty !== false || sourceDirty !== false) errors.push('execution/source tree is dirty');
  return { ok: errors.length === 0, errors };
}
export function recordEditorAttempt(samples, attempts, { units, action, index, phase, result, error }) {
  samples[units] ??= { writer: {} };
  samples[units].writer[action] ??= { warmupSamplesMs: [], rawSamplesMs: [], longTasksMs: [], warmupObservations: [], rawObservations: [] };
  const attempt = { units, action, index, phase, outcome: error ? 'FAIL' : 'PASS' };
  if (error) attempt.error = String(error?.message ?? error);
  else {
    const record = samples[units].writer[action];
    record[phase === 'warmup' ? 'warmupSamplesMs' : 'rawSamplesMs'].push(result.elapsedMs);
    record[phase === 'warmup' ? 'warmupObservations' : 'rawObservations'].push(result.observation);
    record.longTasksMs.push(...result.longTasksMs);
    attempt.elapsedMs = result.elapsedMs;
    attempt.observation = result.observation;
  }
  attempts.push(attempt);
  return attempt;
}
export function assertEditorReceipt(protocol, receipt) {
  const checked = checkEditorReceipt(protocol, receipt);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return checked;
}
export function isEditorEnvironmentInvalid(failure, attempts) {
  if (!failure) return false;
  if (/PERF_WINDOW_NOT_FOCUSED|PERF_(?:INPUT|SELECTION)_EVENT_NOT_CAPTURED/u.test(failure.message ?? '')) return true;
  const sample = failure.sample;
  return !!sample && attempts.some(attempt => attempt.units === sample.units && attempt.action === sample.action &&
    attempt.index === sample.index && attempt.phase === sample.phase &&
    attempt.windowEvents?.some(event => event.type === 'blur' || event.type === 'minimize'));
}
export function checkFeatureUnion(plan, { mode = 'planning', owners = [], expectedSha } = {}) {
  const errors = [], seen = new Set(), steps = new Set(), groupStates = {};
  const known = new Set(owners);
  const browserEligible = new Set(currentLevels.browserEligibleActionIds);
  const migrationScenarios = currentLevels.migrationScenarios ?? {};
  if (currentLevels.schemaVersion !== 1 || currentLevels.productShell !== 'writer' ||
      JSON.stringify(currentLevels.editorShells) !== '["writer"]' || currentLevels.editorRelativeBaseline !== 'historical-classic' ||
      browserEligible.size !== currentLevels.browserEligibleActionIds.length ||
      JSON.stringify(Object.keys(migrationScenarios).sort()) !== '["U02.A02","U02.A07"]') errors.push('invalid current evidence-level policy');
  for (const feature of plan.features ?? []) {
    if ('status' in feature || 'evidence' in feature) errors.push(feature.id + ': independent group status/evidence forbidden');
    const actions = feature.actions ?? [];
    if (!actions.length) errors.push(feature.id + ': missing actions');
    for (const action of actions) {
      const id = action.actionId;
      if (!id || seen.has(id)) errors.push('missing or duplicate actionId: ' + id);
      seen.add(id);
      if (!action.requiredInWriter) errors.push(id + ': Writer requirement weakened');
      for (const key of ['owner', 'uiOwner', 'qualificationOwner']) {
        if (!known.has(action[key])) errors.push(id + ': unknown ' + key);
      }
      if (feature.id === 'U16' && action.owner !== (LOCAL_ARCHIVE_ACTIONS.has(id) ? 'B01' : 'B02')) errors.push(id + ': wrong archive/network owner');
      if (mode === 'planning') {
        if (action.status !== 'not-run') errors.push(id + ': planning must not claim execution');
        continue;
      }
      if (!expectedSha || action.status !== 'pass') errors.push(id + ': not qualified');
      const evidence = action.evidence ?? {};
      for (const field of plan.executionRequiredFields ?? []) {
        if (evidence[field] == null || evidence[field] === '' || (Array.isArray(evidence[field]) && !evidence[field].length)) errors.push(id + ': missing ' + field);
      }
      if (evidence.surface !== currentLevels.productShell) errors.push(id + ': must use Writer entry');
      if (migrationScenarios[id] && evidence.migrationScenario !== migrationScenarios[id]) errors.push(id + ': wrong current migration scenario');
      if (evidence.testedSha !== expectedSha) {
        const reuse = evidence.reuseDecision;
        if (!reuse || reuse.testedSha !== evidence.testedSha || !/^[0-9a-f]{40}$/i.test(evidence.testedSha) ||
            !Array.isArray(reuse.changedPaths) || !reuse.changedPaths.length ||
            !reuse.changedPaths.every(path => typeof path === 'string' && path.trim()) ||
            typeof reuse.differences !== 'string' || !reuse.differences.trim() ||
            typeof reuse.reason !== 'string' || !reuse.reason.trim()) errors.push(id + ': wrong tested SHA without specific reuse decision');
      }
      const levels = browserEligible.has(id) ? ['browser'] : action.requiredEvidenceLevels ?? [];
      for (const level of levels) {
        if (level === 'browser' && evidence.evidenceLevels?.includes('electron')) continue;
        if (!evidence.evidenceLevels?.includes(level)) errors.push(id + ': missing evidence level ' + level);
      }
      const step = String(evidence.receipt) + '#' + String(evidence.stepId);
      if (steps.has(step)) errors.push(id + ': repeated receipt step');
      steps.add(step);
    }
    groupStates[feature.id] = actions.length && actions.every(a => a.status === 'pass') ? 'pass' : 'not-qualified';
  }
  if (seen.size !== currentLevels.actionCount) errors.push('current evidence-level policy: action count mismatch');
  for (const id of browserEligible) if (!seen.has(id)) errors.push(id + ': unknown browser-eligible action');
  return { ok: errors.length === 0, errors, groupStates };
}
export function checkEditorReceipt(protocol, receipt) {
  if (protocol.protocolId === 'editor-interaction-v2') return checkEditorInteractionV2(protocol, receipt);
  const errors = [], statistics = {};
  const median = values => {
    const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  };
  const validTimes = values => Array.isArray(values) && values.every(v=>Number.isFinite(v) && v>=0);
  if (!receipt.production || !receipt.writerLivePreview) errors.push('must use production editor with Writer preview on');
  if (!receipt.imeExactMatch || receipt.imeLossCount !== 0 || receipt.imeDuplicateCount !== 0 || !receipt.selectionUndoExact) errors.push('IME/selection/undo corruption');
  if (!Number.isInteger(receipt.rerunIndex) || receipt.rerunIndex < 0 || receipt.rerunIndex > protocol.maxRerunIndex) errors.push('invalid/excessive rerun');
  if (!/^[0-9a-f]{40}$/i.test(receipt.baseline?.testedSha ?? '') ||
      typeof receipt.baseline?.receipt !== 'string' || !receipt.baseline.receipt.trim()) errors.push('historical Classic baseline provenance missing');
  for (const units of protocol.units) {
    for (const shell of currentLevels.editorShells) for (const action of protocol.actions) {
      const key = units+'/'+shell+'/'+action, samples = receipt.samples?.[units]?.[shell]?.[action];
      if (!samples || !validTimes(samples.warmupSamplesMs) || samples.warmupSamplesMs.length !== protocol.warmupCount || !validTimes(samples.rawSamplesMs) || samples.rawSamplesMs.length !== protocol.sampleCount || !validTimes(samples.longTasksMs)) {
        errors.push(key+': missing action or invalid raw/warmup sample count');
        continue;
      }
      const middle = median(samples.rawSamplesMs), worst = Math.max(...samples.rawSamplesMs);
      const mad = median(samples.rawSamplesMs.map(v=>Math.abs(v-middle))), longTask = Math.max(0,...samples.longTasksMs);
      statistics[key] = { medianMs:middle, worstMs:worst, madMs:mad, madRatio:middle>0?mad/middle:Infinity, longTaskMs:longTask };
      if (middle<=0 || middle>protocol.maxMedianInputToPaintMs || worst>protocol.maxWorstValidInputToPaintMs || longTask>protocol.maxMainThreadLongTaskMs) errors.push(key+': absolute responsiveness failed');
      if (middle<=0 || mad/middle>protocol.maxMadToMedian) errors.push(key+': inconclusive unstable raw samples');
    }
    for (const action of protocol.actions) {
      const key = units+'/historical-classic/'+action, samples = receipt.baseline?.samples?.[units]?.[action];
      if (!samples || !validTimes(samples.warmupSamplesMs) || samples.warmupSamplesMs.length !== protocol.warmupCount ||
          !validTimes(samples.rawSamplesMs) || samples.rawSamplesMs.length !== protocol.sampleCount || !validTimes(samples.longTasksMs)) {
        errors.push(key+': missing baseline raw/warmup samples');
        continue;
      }
      const baselineMedian = median(samples.rawSamplesMs), baselineMad = median(samples.rawSamplesMs.map(v=>Math.abs(v-baselineMedian)));
      if (baselineMedian<=0 || baselineMad/baselineMedian>protocol.maxMadToMedian) errors.push(key+': inconclusive baseline samples');
      const writer = statistics[units+'/writer/'+action];
      if (writer && writer.medianMs > baselineMedian*(1+protocol.writerRelativeMedianRegressionMaxPercent/100)) errors.push(units+'/'+action+': relative regression');
    }
  }
  return { ok:errors.length===0, errors, statistics };
}

function checkEditorInteractionV2(protocol, receipt) {
  const errors = [], statistics = {};
  const median = values => {
    const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  };
  const validTimes = values => Array.isArray(values) && values.every(v=>Number.isFinite(v) && v>=0);
  if (receipt.protocolId !== protocol.protocolId) errors.push('editor protocol mismatch');
  if (protocol.measurementSource !== 'renderer-capture-to-second-raf-dom-ready-v1' || receipt.measurementSource !== protocol.measurementSource) {
    errors.push('wrong editor measurement source');
  }
  if (!receipt.production || !receipt.writerLivePreview) errors.push('must use production editor with Writer preview on');
  if (!Number.isInteger(receipt.rerunIndex) || receipt.rerunIndex < 0 || receipt.rerunIndex > 1) errors.push('invalid/excessive rerun');
  if (receipt.rerunIndex === 1 && !(receipt.priorReceipt?.outcome === 'INVALID' &&
      typeof receipt.priorReceipt.invalidReason === 'string' && receipt.priorReceipt.invalidReason.trim() &&
      receipt.priorReceipt.sameConditions === true && receipt.priorReceipt.rerunIndex === 0)) {
    errors.push('rerun requires a same-condition first-run environment INVALID receipt');
  }
  if (JSON.stringify(protocol.units) !== '[3000,200000]' || JSON.stringify(protocol.actions) !== '["input","selection"]' ||
      protocol.warmupCount !== 3 || protocol.sampleCount !== 7 || protocol.maxMedianInputToPaintMs !== 100 ||
      protocol.maxWorstValidInputToPaintMs !== 250) errors.push('invalid editor-interaction-v2 budgets');
  const observationValid = observation => observation?.eventCapturedInRenderer === true && observation?.trustedEvent === true &&
    observation?.targetIsEditor === true && observation?.capturePhase === true && observation?.preStateMatched === true &&
    observation?.terminal?.documentMatches === true && observation?.terminal?.caretOrSelectionMatches === true &&
    observation?.terminal?.visibleDomMatches === true && observation?.terminal?.secondRaf === true &&
    observation?.terminal?.focused === true && observation?.terminal?.visible === true;
  for (const units of protocol.units) for (const action of protocol.actions) {
    const key = `${units}/writer/${action}`, samples = receipt.samples?.[units]?.writer?.[action];
    if (!samples || !validTimes(samples.warmupSamplesMs) || samples.warmupSamplesMs.length !== protocol.warmupCount ||
        !validTimes(samples.rawSamplesMs) || samples.rawSamplesMs.length !== protocol.sampleCount ||
        !Array.isArray(samples.warmupObservations) || samples.warmupObservations.length !== protocol.warmupCount ||
        !samples.warmupObservations.every(observationValid) || !Array.isArray(samples.rawObservations) ||
        samples.rawObservations.length !== protocol.sampleCount || !samples.rawObservations.every(observationValid)) {
      errors.push(key + ': missing real event, pre-state, or terminal-state observations');
      continue;
    }
    const expectedAnchor = action === 'input' ? 1 : 0;
    if (![...samples.warmupObservations, ...samples.rawObservations].every(observation =>
      observation.terminal.nativeAnchor === expectedAnchor && observation.terminal.nativeHead === 1 &&
      observation.terminal.nativeRangeStart === expectedAnchor && observation.terminal.nativeRangeEnd === 1)) {
      errors.push(key + ': native DOM selection positions differ from expected editor positions');
      continue;
    }
    const middle = median(samples.rawSamplesMs), worst = Math.max(...samples.rawSamplesMs);
    statistics[key] = { medianMs:middle, worstMs:worst };
    if (middle <= 0 || middle > protocol.maxMedianInputToPaintMs || worst > protocol.maxWorstValidInputToPaintMs) {
      errors.push(key + ': absolute responsiveness failed');
    }
  }
  return { ok:errors.length===0, errors, statistics };
}
