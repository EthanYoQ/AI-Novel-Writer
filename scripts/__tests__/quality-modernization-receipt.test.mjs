import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { test } from 'vitest'
import Database from 'better-sqlite3'
import { isVerifiedDirectPersistedDraftEvidence, projectRecoveryCandidateSupplement,
  readVerifiedDirectPersistedDraftEvidence, readVerifiedRecoveryCandidateSupplement,
  recordPersistedDraftObservation, safeReceiptDiagnostic } from '../quality-modernization-receipt.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')

test('real receipts preserve stable targeted-review failure codes without exposing free text', () => {
  assert.equal(safeReceiptDiagnostic(new Error('TARGETED_REVIEW_ITEM_MISSING'), 'real'), 'TARGETED_REVIEW_ITEM_MISSING')
  assert.equal(safeReceiptDiagnostic(new Error('provider said secret'), 'real'), 'REAL_PROVIDER_DIAGNOSTIC_REDACTED')
})

test('current receipts use 70%-130% while historical receipts retain 80%-120%', () => {
  for (const units of [1400, 2600]) assert.doesNotThrow(() => recordPersistedDraftObservation(
    { protocolRevision: 'draft-units-tolerance-30-v1', arm: 'candidate' }, { chapterNumber: 1, targetUnits: 2000, units, contentHash: 'a'.repeat(64) }))
  for (const units of [1399, 2601]) assert.throws(() => recordPersistedDraftObservation(
    { protocolRevision: 'draft-units-tolerance-30-v1', arm: 'candidate' }, { chapterNumber: 1, targetUnits: 2000, units, contentHash: 'a'.repeat(64) }))
  assert.throws(() => recordPersistedDraftObservation(
    { protocolRevision: 'draft-units-tolerance-30-v1', arm: 'baseline' }, { chapterNumber: 1, targetUnits: 2000, units: 1500, contentHash: 'a'.repeat(64) }))
  assert.throws(() => recordPersistedDraftObservation(
    { protocolRevision: 's10b-reference-baseline-v2' }, { chapterNumber: 1, targetUnits: 2000, units: 1599, contentHash: 'a'.repeat(64) }))
})

function evidence(units = 1599) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.runtime/.cache/novel-quality-modernization/recovery-projector-test-'))
  const projectRoot = path.join(root, 'project')
  fs.mkdirSync(projectRoot)
  const databaseDirectory = path.join(projectRoot, '.vela')
  fs.mkdirSync(databaseDirectory)
  const databasePath = path.join(databaseDirectory, 'vela.db')
  const operation = '长设定第三章正文', projectId = 'project', runId = 'run', attemptId = 'baseline:attempt'
  const invocationId = '11111111-1111-4111-8111-111111111111'
  const binding = { invocationId, arm: 'baseline', mode: 'real', operation, phase: 'early-context', caseId: '场景2/3',
    driverHash: 'd'.repeat(64), sourceHash: 's'.repeat(64), codeSha: 'a'.repeat(40), parityId: 'p'.repeat(64) }
  const request = { invocationId, mode: 'real', action: 'execute', phase: 'early-context', caseId: '场景2/3', chapterNumber: 3,
    driverHash: binding.driverHash, ledgerPath: path.join(root, 'ledger.jsonl'), receiptPath: path.join(root, 'execute-receipt.json'),
    operations: [{ id: operation, kind: 'draft' }], target: { arm: 'baseline', codeSha: binding.codeSha,
      isolationRoot: root, roots: { project: projectRoot }, driver: { sha256: binding.driverHash } } }
  const localDispatchGateRejection = { code: 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST', operationId: operation,
    reason: 'duplicate-operation', operation, runId, projectId, chapterNumber: 3, beforeDispatch: true }
  const receipt = { invocationId, arm: 'baseline', mode: 'real', status: 'failed', phase: request.phase, caseId: request.caseId,
    chapterNumber: request.chapterNumber, physicalModelRequests: 1, syntheticDispatches: 0, operations: [],
    attempts: [{ attemptId, binding }], physicalProject: { projectId, dbPath: databasePath } }
  const text = '甲'.repeat(units)
  const sourceSnapshot = JSON.stringify({ chapterNumber: 3, title: '章节' })
  const row = { candidate_id: 'candidate', run_id: runId, step_id: operation, project_id: projectId,
    chapter_number: 3, chapter_title: '章节', source_snapshot: sourceSnapshot, source_hash: sha(sourceSnapshot),
    visible_text: text, content_hash: sha(text), status: 'pending' }
  const rows = [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId },
    { type: 'settle', attemptId, finishReason: 'stop' }]
  const database = new Database(databasePath)
  database.exec(`CREATE TABLE recovery_candidates (
    candidate_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, project_id TEXT NOT NULL,
    chapter_number INTEGER NOT NULL, chapter_title TEXT NOT NULL, source_snapshot TEXT NOT NULL,
    source_hash TEXT NOT NULL, visible_text TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL
  )`)
  database.prepare(`INSERT INTO recovery_candidates (
    candidate_id, run_id, step_id, project_id, chapter_number, chapter_title,
    source_snapshot, source_hash, visible_text, content_hash, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.candidate_id, row.run_id, row.step_id, row.project_id,
    row.chapter_number, row.chapter_title, row.source_snapshot, row.source_hash, row.visible_text, row.content_hash, row.status)
  database.close()
  const input = { request, requestBytes: JSON.stringify(request), receipt, receiptBytes: JSON.stringify(receipt),
    ledgerBytes: rows.map(item => JSON.stringify(item)).join('\n') + '\n', recoveryRows: [row], targetUnits: 2000,
    isolationRoot: root, localDispatchGateRejection }
  fs.writeFileSync(path.join(root, 'execute-request.json'), input.requestBytes)
  fs.writeFileSync(request.receiptPath, input.receiptBytes)
  fs.writeFileSync(request.ledgerPath, input.ledgerBytes)
  return { root, input, row, rows }
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }) }

function directEvidence(units = 2401) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.runtime/.cache/novel-quality-modernization/direct-draft-test-'))
  const isolationRoot = path.join(root, 'invocation'), projectRoot = path.join(root, 'projects')
  const projectPath = path.join(projectRoot, 'novel'), databasePath = path.join(projectPath, '.vela', 'vela.db')
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  fs.mkdirSync(isolationRoot)
  const invocationId = '22222222-2222-4222-8222-222222222222', operation = '长设定第三章正文'
  const attemptId = 'baseline:direct', content = '甲'.repeat(units), contentHash = sha(content)
  const outputPath = path.join(isolationRoot, 'draft.txt'), ledgerPath = path.join(root, 'ledger.jsonl')
  const receiptPath = path.join(isolationRoot, 'execute-receipt.json')
  const manifestPath = path.join(isolationRoot, 'physical-project.json')
  const binding = { campaignId: 'novel-quality-program-v3-uncapped-v1', invocationId, arm: 'baseline', mode: 'real',
    protocolRevision: 's10b-reference-baseline-v2', protocolHash: 'e'.repeat(64), codeSha: 'a'.repeat(40),
    sourceHash: 's'.repeat(64), driverHash: 'd'.repeat(64), parityId: 'p'.repeat(64), phase: 'early-context',
    milestone: 'early', caseId: '场景2/3', operation }
  const request = { invocationId, mode: 'real', action: 'execute', protocolRevision: binding.protocolRevision,
    protocolHash: binding.protocolHash, scenarioRevision: 's10b-early-context-selection-difference-v3',
    phase: binding.phase, milestone: binding.milestone, caseId: binding.caseId, chapterNumber: 3,
    parityHash: binding.parityId, driverHash: binding.driverHash, ledgerPath, receiptPath,
    operations: [{ id: operation, kind: 'draft' }], target: { arm: 'baseline', codeSha: binding.codeSha,
      sourceHash: binding.sourceHash, protocolRevision: binding.protocolRevision, protocolHash: binding.protocolHash,
      isolationRoot, roots: { project: projectRoot }, driver: { sha256: binding.driverHash } } }
  const receipt = { invocationId, arm: 'baseline', mode: 'real', action: 'execute', status: 'failed',
    protocolRevision: binding.protocolRevision, protocolHash: binding.protocolHash, codeSha: binding.codeSha,
    phase: binding.phase, caseId: binding.caseId, chapterNumber: 3, physicalModelRequests: 1, syntheticDispatches: 0,
    operations: [{ operation, kind: 'draft', outputHash: contentHash, outputPath }],
    attempts: [{ attemptId, binding }], physicalProject: { path: projectPath, dbPath: databasePath,
      projectId: 'project', parityHash: binding.parityId },
    draftObservation: { chapterNumber: 3, targetUnits: 2000, units, contentHash, persisted: true },
    gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: units, targetUnits: 2000 },
    error: `TARGET_UNITS_FAILED:${units}/2000` }
  const ledger = [{ type: 'reserve', attemptId, binding }, { type: 'dispatch', attemptId },
    { type: 'settle', attemptId, finishReason: 'stop' }]
  const database = new Database(databasePath)
  database.exec(`CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE drafts (id INTEGER PRIMARY KEY, chapter_number INTEGER NOT NULL, version INTEGER NOT NULL,
      status TEXT, source TEXT, content_id INTEGER NOT NULL, word_count INTEGER);`)
  database.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, content)
  database.prepare(`INSERT INTO drafts (id, chapter_number, version, status, source, content_id, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(1, 3, 1, 'draft', 'write', 1, units)
  database.close()
  fs.writeFileSync(outputPath, content)
  fs.writeFileSync(path.join(isolationRoot, 'execute-request.json'), JSON.stringify(request))
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  fs.writeFileSync(manifestPath, JSON.stringify({ kind: 'manifest', projectId: 'project', rootPath: projectPath }))
  fs.writeFileSync(ledgerPath, ledger.map(row => JSON.stringify(row)).join('\n') + '\n')
  return { root, isolationRoot, projectPath, databasePath, outputPath, ledgerPath, receiptPath, manifestPath,
    request, receipt, ledger, rewriteReceipt: () => fs.writeFileSync(receiptPath, JSON.stringify(receipt)),
    rewriteRequest: () => fs.writeFileSync(path.join(isolationRoot, 'execute-request.json'), JSON.stringify(request)),
    rewriteLedger: () => fs.writeFileSync(ledgerPath, ledger.map(row => JSON.stringify(row)).join('\n') + '\n') }
}

test('direct persisted reader independently verifies the failed baseline artifact, ledger and draft row', () => {
  for (const units of [1599, 2401]) {
    const value = directEvidence(units)
    try {
      const projected = readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath })
      assert.equal(projected.directPersistedEvidence.identity.units, units)
      assert.equal(projected.directPersistedEvidence.identity.status, 'draft')
      assert.equal(projected.directPersistedEvidence.identity.version, 1)
      assert.equal(projected.operations[0].outputPath, value.outputPath)
      assert.equal('saved' in projected, false)
      assert.equal(isVerifiedDirectPersistedDraftEvidence(projected.directPersistedEvidence), true)
      assert.equal(isVerifiedDirectPersistedDraftEvidence(structuredClone(projected.directPersistedEvidence)), false)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader rejects receipt, artifact, ownership and saved counterexamples', () => {
  const mutations = [
    value => { value.receipt.saved = { chapterNumber: 3 }; value.rewriteReceipt() },
    value => { value.receipt.arm = 'candidate'; value.rewriteReceipt() },
    value => { value.receipt.draftObservation.units += 1; value.rewriteReceipt() },
    value => { value.receipt.operations[0].outputHash = '0'.repeat(64); value.rewriteReceipt() },
    value => { fs.appendFileSync(value.outputPath, '篡改') },
    value => {
      const outside = path.join(value.root, 'outside.txt')
      fs.copyFileSync(value.outputPath, outside)
      value.receipt.operations[0].outputPath = outside
      value.rewriteReceipt()
    },
    value => {
      const outside = path.join(value.root, 'outside-db')
      fs.mkdirSync(outside)
      fs.copyFileSync(value.databasePath, path.join(outside, 'vela.db'))
      fs.rmSync(path.dirname(value.databasePath), { recursive: true, force: true })
      fs.symlinkSync(outside, path.dirname(value.databasePath), process.platform === 'win32' ? 'junction' : 'dir')
    },
  ]
  for (const mutate of mutations) {
    const value = directEvidence()
    try {
      mutate(value)
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }), /DIRECT_/)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader binds driver, code, protocol, source, parity and request identity', () => {
  const mutations = [
    value => { value.request.driverHash = '0'.repeat(64); value.rewriteRequest() },
    value => { value.request.target.codeSha = 'b'.repeat(40); value.rewriteRequest() },
    value => { value.request.protocolHash = '0'.repeat(64); value.rewriteRequest() },
    value => { value.request.target.sourceHash = '0'.repeat(64); value.rewriteRequest() },
    value => { value.request.parityHash = '0'.repeat(64); value.rewriteRequest() },
    value => { value.receipt.caseId = 'other-case'; value.rewriteReceipt() },
    value => { value.receipt.physicalModelRequests = 2; value.rewriteReceipt() },
    value => { value.request.action = 'prepare'; value.rewriteRequest() },
  ]
  for (const mutate of mutations) {
    const value = directEvidence()
    try {
      mutate(value)
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }), /DIRECT_/)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader rejects missing, duplicate and mismatched draft rows', () => {
  const mutations = [
    database => database.prepare('DELETE FROM drafts').run(),
    database => {
      database.prepare('INSERT INTO contents (id, body) SELECT 2, body FROM contents WHERE id = 1').run()
      database.prepare(`INSERT INTO drafts (id, chapter_number, version, status, source, content_id, word_count)
        VALUES (2, 3, 2, 'draft', 'write', 2, 2401)`).run()
    },
    database => database.prepare("UPDATE contents SET body = body || '篡改' WHERE id = 1").run(),
    database => database.prepare("UPDATE drafts SET status = 'finalized'").run(),
    database => database.prepare('UPDATE drafts SET word_count = word_count + 1').run(),
    database => database.prepare('UPDATE drafts SET version = 0').run(),
  ]
  for (const mutate of mutations) {
    const value = directEvidence()
    try {
      const database = new Database(value.databasePath)
      try { mutate(database) } finally { database.close() }
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }), /DIRECT_/)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader requires one exact reserve-dispatch-settle(stop) attempt', () => {
  const mutations = [
    value => { value.ledger[1].attemptId = 'other-attempt' },
    value => { value.ledger[0].binding.invocationId = '33333333-3333-4333-8333-333333333333' },
    value => { [value.ledger[1], value.ledger[2]] = [value.ledger[2], value.ledger[1]] },
    value => { value.ledger.push({ type: 'reserve', attemptId: 'baseline:second', binding: { ...value.ledger[0].binding } }) },
    value => { value.ledger[2].finishReason = 'length' },
  ]
  for (const mutate of mutations) {
    const value = directEvidence()
    try {
      mutate(value)
      value.rewriteLedger()
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }), /DIRECT_/)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader requires non-empty receipt and ledger attempt ids', () => {
  for (const mutate of [
    value => { delete value.receipt.attempts[0].attemptId; value.rewriteReceipt() },
    value => { value.receipt.attempts[0].attemptId = null; value.rewriteReceipt() },
    value => { value.ledger[0].attemptId = null; value.rewriteLedger() },
    value => { value.ledger[1].attemptId = null; value.rewriteLedger() },
  ]) {
    const value = directEvidence()
    try {
      mutate(value)
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }),
        /DIRECT_LEDGER_ATTEMPT_ID_INVALID/)
    } finally { cleanup(value.root) }
  }
})

test('direct persisted reader binds the owned physical project manifest', () => {
  const mutations = [
    value => fs.rmSync(value.manifestPath),
    value => fs.writeFileSync(value.manifestPath, JSON.stringify({ kind: 'other', projectId: 'project', rootPath: value.projectPath })),
    value => fs.writeFileSync(value.manifestPath, JSON.stringify({ kind: 'manifest', projectId: 'other', rootPath: value.projectPath })),
    value => fs.writeFileSync(value.manifestPath, JSON.stringify({ kind: 'manifest', projectId: 'project', rootPath: value.root })),
    value => {
      const outside = path.join(value.root, 'outside-manifest.json')
      fs.writeFileSync(outside, JSON.stringify({ kind: 'manifest', projectId: 'project', rootPath: value.projectPath }))
      fs.rmSync(value.manifestPath)
      fs.symlinkSync(outside, value.manifestPath, 'file')
    },
  ]
  for (const mutate of mutations) {
    const value = directEvidence()
    try {
      mutate(value)
      assert.throws(() => readVerifiedDirectPersistedDraftEvidence({ receiptPath: value.receiptPath }), /DIRECT_MANIFEST_/)
    } finally { cleanup(value.root) }
  }
})

test('recovery projector exports only out-of-range review evidence and is idempotent', () => {
  for (const units of [1599, 2401]) {
    const value = evidence(units)
    try {
      const first = projectRecoveryCandidateSupplement(value.input)
      const projected = readVerifiedRecoveryCandidateSupplement({ receiptPath: value.input.request.receiptPath })
      const second = projectRecoveryCandidateSupplement(value.input)
      const laterBinding = { ...value.input.receipt.attempts[0].binding,
        arm: 'candidate', parityId: 'c'.repeat(64) }
      value.input.ledgerBytes += [{ type: 'reserve', attemptId: 'candidate:later', binding: laterBinding },
        { type: 'dispatch', attemptId: 'candidate:later' }, { type: 'settle', attemptId: 'candidate:later', finishReason: 'stop' }]
        .map(item => JSON.stringify(item)).join('\n') + '\n'
      fs.writeFileSync(value.input.request.ledgerPath, value.input.ledgerBytes)
      const afterAppend = projectRecoveryCandidateSupplement(value.input)
      const projectedAfterAppend = readVerifiedRecoveryCandidateSupplement({ receiptPath: value.input.request.receiptPath })
      const futureBinding = { ...value.input.receipt.attempts[0].binding,
        invocationId: '22222222-2222-4222-8222-222222222222', parityId: 'f'.repeat(64), sourceHash: 'u'.repeat(64) }
      value.input.ledgerBytes += [{ type: 'reserve', attemptId: 'future:baseline', binding: futureBinding },
        { type: 'dispatch', attemptId: 'future:baseline' }, { type: 'settle', attemptId: 'future:baseline', finishReason: 'stop' }]
        .map(item => JSON.stringify(item)).join('\n') + '\n'
      fs.writeFileSync(value.input.request.ledgerPath, value.input.ledgerBytes)
      const afterFutureInvocation = projectRecoveryCandidateSupplement(value.input)
      const projectedAfterFutureInvocation = readVerifiedRecoveryCandidateSupplement({ receiptPath: value.input.request.receiptPath })
      assert.equal(first.disposition, 'reference-nonconforming')
      assert.deepEqual(projected.draftObservation, first.draftObservation)
      assert.equal(projected.operations[0].recoverySupplement, true)
      assert.deepEqual(second.gateFailure, { code: 'TARGET_UNITS_FAILED', actualUnits: units, targetUnits: 2000 })
      assert.equal(first.formalSaved, false)
      assert.equal('saved' in first, false)
      assert.equal(fs.readFileSync(first.operation.outputPath, 'utf8'), value.row.visible_text)
      assert.equal(sha(fs.readFileSync(first.operation.outputPath)), first.operation.outputHash)
      assert.ok(path.resolve(first.operation.outputPath).startsWith(path.resolve(value.root)))
      assert.equal(first.ledger.events.join(','), 'reserve,dispatch,settle')
      assert.equal(first.ledger.finishReason, 'stop')
      assert.equal(afterAppend.ledger.sha256, first.ledger.sha256, 'append-only ledger growth must not rewrite frozen evidence')
      assert.equal(afterFutureInvocation.ledger.sha256, first.ledger.sha256,
        'the same operation in a later invocation must not invalidate the frozen invocation')
      assert.deepEqual(projectedAfterAppend.draftObservation, first.draftObservation)
      assert.deepEqual(projectedAfterFutureInvocation.draftObservation, first.draftObservation)
    } finally { cleanup(value.root) }
  }
  for (const units of [1600, 2400]) {
    const value = evidence(units)
    try { assert.throws(() => projectRecoveryCandidateSupplement(value.input), /RECOVERY_TARGET_UNITS_CONFORMING/) }
    finally { cleanup(value.root) }
  }
})

test('recovery projector fails closed on transport, settlement and duplicate-dispatch counterexamples', () => {
  const mutations = [
    input => { input.receipt.physicalModelRequests = 0 },
    input => { input.receipt.attempts = [] },
    input => { input.receipt.ipcFailures = [{ channel: 'db:draft-create' }]; input.recoveryRows = [] },
    input => { input.ledgerBytes = input.ledgerBytes.replace('"settle"', '"unknown"') },
    input => { input.ledgerBytes = input.ledgerBytes.replace('"finishReason":"stop"', '"finishReason":"length"') },
    input => {
      const changedBinding = { ...input.receipt.attempts[0].binding,
        parityId: 'q'.repeat(64), sourceHash: 't'.repeat(64) }
      input.ledgerBytes += `${JSON.stringify({ type: 'reserve', attemptId: 'baseline:second', binding: changedBinding })}\n`
        + `${JSON.stringify({ type: 'dispatch', attemptId: 'baseline:second' })}\n`
    },
  ]
  for (const mutate of mutations) {
    const value = evidence()
    try {
      mutate(value.input)
      value.input.receiptBytes = JSON.stringify(value.input.receipt)
      assert.throws(() => projectRecoveryCandidateSupplement(value.input), /RECOVERY_/)
    } finally { cleanup(value.root) }
  }
})

test('recovery projector rejects absent, duplicate, nonpending, identity, hash and path mismatches', () => {
  const mutations = [
    input => { input.recoveryRows = [] },
    input => { input.recoveryRows.push(structuredClone(input.recoveryRows[0])) },
    input => { input.recoveryRows[0].status = 'continued' },
    input => { input.recoveryRows[0].run_id = 'other-run' },
    input => { input.recoveryRows[0].project_id = 'other-project' },
    input => { input.recoveryRows[0].chapter_number = 2 },
    input => { input.recoveryRows[0].step_id = 'other-step' },
    input => { input.recoveryRows[0].content_hash = '0'.repeat(64) },
    input => { input.recoveryRows[0].source_hash = '0'.repeat(64) },
    input => { input.request.target.isolationRoot = path.dirname(input.isolationRoot) },
  ]
  for (const mutate of mutations) {
    const value = evidence()
    try {
      mutate(value.input)
      value.input.requestBytes = JSON.stringify(value.input.request)
      assert.throws(() => projectRecoveryCandidateSupplement(value.input), /RECOVERY_/)
    } finally { cleanup(value.root) }
  }
})

test('recovery projector never weakens candidate or formal-saved absolute gates', () => {
  for (const mutate of [
    input => { input.request.target.arm = 'candidate'; input.receipt.arm = 'candidate'; input.receipt.attempts[0].binding.arm = 'candidate' },
    input => { input.receipt.saved = { chapterNumber: 3 } },
  ]) {
    const value = evidence(1599)
    try {
      mutate(value.input)
      value.input.requestBytes = JSON.stringify(value.input.request)
      value.input.receiptBytes = JSON.stringify(value.input.receipt)
      assert.throws(() => projectRecoveryCandidateSupplement(value.input), /RECOVERY_ORIGINAL_RECEIPT_INVALID/)
    } finally { cleanup(value.root) }
  }
})

test('historical evidence without invocation and workflow-run identity fails closed', () => {
  const value = evidence(1599)
  try {
    delete value.input.request.invocationId
    delete value.input.receipt.invocationId
    delete value.input.receipt.attempts[0].binding.invocationId
    delete value.input.localDispatchGateRejection
    value.input.requestBytes = JSON.stringify(value.input.request)
    value.input.receiptBytes = JSON.stringify(value.input.receipt)
    assert.throws(() => projectRecoveryCandidateSupplement(value.input), /RECOVERY_ORIGINAL_RECEIPT_INVALID/)
  } finally { cleanup(value.root) }
})

test('verified supplement reader rejects missing and tampered evidence', () => {
  for (const tamper of [
    ({ supplementPath }) => fs.rmSync(supplementPath),
    ({ supplementPath }) => {
      const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'))
      supplement.draftObservation.units += 1
      fs.writeFileSync(supplementPath, JSON.stringify(supplement))
    },
    ({ supplementPath }) => {
      const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'))
      supplement.ledger.sha256 = '0'.repeat(64)
      fs.writeFileSync(supplementPath, JSON.stringify(supplement))
    },
    ({ supplementPath }) => {
      const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'))
      supplement.identity.runId = 'coordinated-run-tamper'
      supplement.localDispatchGateRejection.runId = 'coordinated-run-tamper'
      fs.writeFileSync(supplementPath, JSON.stringify(supplement))
    },
    ({ supplementPath, outputPath }) => {
      const supplement = JSON.parse(fs.readFileSync(supplementPath, 'utf8'))
      const tampered = '乙'.repeat(supplement.draftObservation.units)
      const tamperedHash = sha(tampered)
      fs.writeFileSync(outputPath, tampered)
      supplement.recoveryCandidate.contentHash = tamperedHash
      supplement.operation.outputHash = tamperedHash
      supplement.draftObservation.contentHash = tamperedHash
      fs.writeFileSync(supplementPath, JSON.stringify(supplement))
    },
    ({ root, databasePath }) => {
      const outside = path.join(root, 'outside-database')
      fs.mkdirSync(outside)
      fs.copyFileSync(databasePath, path.join(outside, 'vela.db'))
      fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
      fs.symlinkSync(outside, path.dirname(databasePath), process.platform === 'win32' ? 'junction' : 'dir')
    },
    ({ outputPath }) => fs.appendFileSync(outputPath, '篡改'),
  ]) {
    const value = evidence(1599)
    try {
      const created = projectRecoveryCandidateSupplement(value.input)
      tamper({ root: value.root, databasePath: value.input.receipt.physicalProject.dbPath,
        supplementPath: created.supplementPath, outputPath: created.operation.outputPath })
      assert.throws(() => readVerifiedRecoveryCandidateSupplement({ receiptPath: value.input.request.receiptPath }), /RECOVERY_/)
    } finally { cleanup(value.root) }
  }
})
