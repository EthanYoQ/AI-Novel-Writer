// Plan-contract checker only. Valid structure is not proof that external receipts are genuine.
const LOCAL_ARCHIVE_ACTIONS = new Set(['U16.A01', 'U16.A02', 'U16.A08', 'U16.A11', 'U16.A12']);
export function checkFeatureUnion(plan, { mode = 'planning', owners = [], expectedSha } = {}) {
  const errors = [], seen = new Set(), steps = new Set(), groupStates = {};
  const known = new Set(owners);
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
      if (evidence.surface !== 'writer') errors.push(id + ': must use Writer entry');
      if (evidence.testedSha !== expectedSha) errors.push(id + ': wrong tested SHA');
      for (const level of action.requiredEvidenceLevels ?? []) {
        if (!evidence.evidenceLevels?.includes(level)) errors.push(id + ': missing evidence level ' + level);
      }
      const step = String(evidence.receipt) + '#' + String(evidence.stepId);
      if (steps.has(step)) errors.push(id + ': repeated receipt step');
      steps.add(step);
    }
    groupStates[feature.id] = actions.length && actions.every(a => a.status === 'pass') ? 'pass' : 'not-qualified';
  }
  return { ok: errors.length === 0, errors, groupStates };
}
export function checkEditorReceipt(protocol, receipt) {
  const errors = [], statistics = {};
  const median = values => {
    const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  };
  const validTimes = values => Array.isArray(values) && values.every(v=>Number.isFinite(v) && v>=0);
  if (!receipt.production || !receipt.writerLivePreview) errors.push('must use production editor with Writer preview on');
  if (!receipt.imeExactMatch || receipt.imeLossCount !== 0 || receipt.imeDuplicateCount !== 0 || !receipt.selectionUndoExact) errors.push('IME/selection/undo corruption');
  if (!Number.isInteger(receipt.rerunIndex) || receipt.rerunIndex < 0 || receipt.rerunIndex > protocol.maxRerunIndex) errors.push('invalid/excessive rerun');
  for (const units of protocol.units) {
    for (const shell of ['classic','writer']) for (const action of protocol.actions) {
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
      const classic = statistics[units+'/classic/'+action], writer = statistics[units+'/writer/'+action];
      if (classic && writer && writer.medianMs > classic.medianMs*(1+protocol.writerRelativeMedianRegressionMaxPercent/100)) errors.push(units+'/'+action+': relative regression');
    }
  }
  return { ok:errors.length===0, errors, statistics };
}
