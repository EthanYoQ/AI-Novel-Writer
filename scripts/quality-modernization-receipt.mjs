import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const REDACTED = 'REAL_PROVIDER_DIAGNOSTIC_REDACTED'
const CONTENT_HASH = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOCAL_DISPATCH_REJECTION = 'UNREGISTERED_ADDITIONAL_MODEL_REQUEST'
const THIRTY_PERCENT_TOLERANCE_REVISION = 'draft-units-tolerance-30-v1'
const verifiedSupplementEvidence = new WeakSet()
const verifiedDirectPersistedEvidence = new WeakSet()
const sha = value => createHash('sha256').update(value).digest('hex')
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
const inside = (root, value) => {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
class ReferenceEvidenceValidationError extends Error {}
const fail = code => { throw new ReferenceEvidenceValidationError(code) }
const targetUnitRange = (targetUnits, protocolRevision, arm) => protocolRevision === THIRTY_PERCENT_TOLERANCE_REVISION && arm !== 'baseline'
  ? { minimum: Math.floor(targetUnits * 0.7), maximum: Math.ceil(targetUnits * 1.3) }
  : { minimum: Math.floor(targetUnits * 0.8), maximum: Math.ceil(targetUnits * 1.2) }

export function isExpectedReferenceEvidenceFailure(error) {
  return error instanceof ReferenceEvidenceValidationError && error.message !== 'RECOVERY_DATABASE_READ_FAILED'
}

export function isVerifiedRecoverySupplementEvidence(value) {
  return value !== null && typeof value === 'object' && verifiedSupplementEvidence.has(value)
}

export function isVerifiedDirectPersistedDraftEvidence(value) {
  return value !== null && typeof value === 'object' && verifiedDirectPersistedEvidence.has(value)
}

class TargetUnitsGateFailure extends Error {
  constructor(actualUnits, targetUnits) {
    super(`TARGET_UNITS_FAILED:${actualUnits}/${targetUnits}`)
    this.code = 'TARGET_UNITS_FAILED'
    this.actualUnits = actualUnits
    this.targetUnits = targetUnits
  }
}

export function safeReceiptDiagnostic(value, mode) {
  const diagnostic = value instanceof Error ? value.message : String(value ?? '')
  if (mode !== 'real') return diagnostic
  if (value instanceof TargetUnitsGateFailure) return diagnostic
  // Exact internal error identities are safe and necessary for failure-lane triage.
  // Free text, paths, provider payloads, credentials, and suffixed codes stay redacted.
  return /^(?:GENERATION|REVIEW|SOURCE|ROOT|MODEL|PROJECT|MATERIAL|TARGET|TARGETED|RECEIPT|ATTEMPT|PROVIDER|NETWORK|LLM|UNREGISTERED|INVALID)_[A-Z0-9_]{2,72}$/u.test(diagnostic)
    ? diagnostic : REDACTED
}

export function recordPersistedDraftObservation(receipt, input) {
  const observation = { chapterNumber: input.chapterNumber, targetUnits: input.targetUnits,
    units: input.units, contentHash: input.contentHash, persisted: true }
  receipt.draftObservation = observation
  const range = targetUnitRange(input.targetUnits, receipt.protocolRevision, receipt.arm)
  const withinTargetRange = input.units >= range.minimum && input.units <= range.maximum
  if (!withinTargetRange) {
    throw new TargetUnitsGateFailure(input.units, input.targetUnits)
  }
  return observation
}

/** Keep the offline projector on the same v3 persisted-prose unit contract. */
export function countProjectedDraftUnits(text) {
  const normalized = text.normalize('NFC')
  const han = /\p{Script=Han}/gu
  const word = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}[\p{L}\p{M}]*)*/gu
  const ignored = /[\s\p{P}\p{S}]/gu
  const hanCount = normalized.match(han)?.length ?? 0
  const withoutHan = normalized.replace(han, ' ')
  const wordCount = withoutHan.match(word)?.length ?? 0
  return hanCount + wordCount + [...withoutHan.replace(word, '').replace(ignored, '')].length
}

function ledgerEvidence(ledgerBytes, attempt, prefix = 'RECOVERY') {
  if (typeof attempt?.attemptId !== 'string' || !attempt.attemptId.trim()) fail(`${prefix}_LEDGER_ATTEMPT_ID_INVALID`)
  const encodedLines = ledgerBytes.match(/[^\r\n]+(?:\r?\n|$)/gu) ?? []
  const rows = encodedLines.map(line => JSON.parse(line.trim()))
  if (rows.some(row => ['reserve', 'dispatch', 'settle'].includes(row?.type)
    && (typeof row.attemptId !== 'string' || !row.attemptId.trim()))) fail(`${prefix}_LEDGER_ATTEMPT_ID_INVALID`)
  const invocationReserves = rows.filter(row => row.type === 'reserve'
    && row.binding?.invocationId === attempt.binding.invocationId && row.binding?.arm === 'baseline')
  if (invocationReserves.length !== 1 || invocationReserves[0].attemptId !== attempt.attemptId)
    fail(`${prefix}_SECOND_DISPATCH_EVIDENCE`)
  const exact = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.attemptId === attempt.attemptId)
  if (exact.length !== 3 || stable(exact.map(({ row }) => row.type)) !== stable(['reserve', 'dispatch', 'settle'])
    || exact[2].row.finishReason !== 'stop' || stable(exact[0].row.binding) !== stable(attempt.binding)) fail(`${prefix}_LEDGER_ATTEMPT_INVALID`)
  const boundaryEventCount = exact[2].index + 1
  const boundaryBytes = encodedLines.slice(0, boundaryEventCount).join('')
  return { path: null, sha256: sha(boundaryBytes), boundary: { eventCount: boundaryEventCount, rawBytesSha256: sha(boundaryBytes) },
    attemptId: attempt.attemptId, events: ['reserve', 'dispatch', 'settle'], finishReason: 'stop' }
}

function ownedDirectory(root, value, code) {
  if (typeof root !== 'string' || typeof value !== 'string' || !inside(root, value)
    || !fs.existsSync(root) || !fs.existsSync(value)) fail(code)
  const resolvedRoot = path.resolve(root), resolvedValue = path.resolve(value)
  if (!fs.lstatSync(resolvedRoot).isDirectory() || fs.lstatSync(resolvedRoot).isSymbolicLink()
    || !fs.lstatSync(resolvedValue).isDirectory() || fs.lstatSync(resolvedValue).isSymbolicLink()) fail(code)
  const realRoot = fs.realpathSync(resolvedRoot), realValue = fs.realpathSync(resolvedValue)
  if (!inside(realRoot, realValue)) fail(code)
  for (let current = resolvedValue; ; current = path.dirname(current)) {
    if (!inside(resolvedRoot, current) || fs.lstatSync(current).isSymbolicLink()) fail(code)
    if (current === resolvedRoot) break
    if (current === path.dirname(current)) fail(code)
  }
  return realValue
}

function ownedRegularFile(root, value, code) {
  if (typeof value !== 'string' || !inside(root, value) || !fs.existsSync(value)) fail(code)
  ownedDirectory(root, path.dirname(path.resolve(value)), code)
  const stat = fs.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code)
  const realRoot = fs.realpathSync(root), realFile = fs.realpathSync(value)
  if (!inside(realRoot, realFile)) fail(code)
  return realFile
}

function writeIdenticalOrCreate(file, bytes) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) fail('RECOVERY_PATH_INVALID')
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== bytes) fail('RECOVERY_SUPPLEMENT_CONFLICT')
    return
  }
  fs.writeFileSync(file, bytes, { encoding: 'utf8', flag: 'wx' })
}

function readOwnedRecoveryCandidate({ projectRoot, databasePath, operation, projectId, chapterNumber }) {
  if (typeof projectRoot !== 'string' || typeof databasePath !== 'string'
    || !inside(projectRoot, databasePath) || !fs.existsSync(projectRoot) || !fs.existsSync(databasePath))
    fail('RECOVERY_DATABASE_PATH_INVALID')
  const projectStat = fs.lstatSync(projectRoot), databaseStat = fs.lstatSync(databasePath)
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink() || !databaseStat.isFile() || databaseStat.isSymbolicLink())
    fail('RECOVERY_DATABASE_PATH_INVALID')
  const resolvedRoot = path.resolve(projectRoot), realRoot = fs.realpathSync(projectRoot), realDatabase = fs.realpathSync(databasePath)
  if (!inside(realRoot, realDatabase)) fail('RECOVERY_DATABASE_PATH_INVALID')
  for (let current = path.dirname(path.resolve(databasePath)); current !== resolvedRoot; current = path.dirname(current)) {
    if (!inside(resolvedRoot, current) || current === path.dirname(current)) fail('RECOVERY_DATABASE_PATH_INVALID')
    if (fs.lstatSync(current).isSymbolicLink()) fail('RECOVERY_DATABASE_PATH_INVALID')
  }
  let database
  try {
    database = new Database(realDatabase, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    const rows = database.prepare(`
      SELECT candidate_id, run_id, step_id, project_id, chapter_number, chapter_title,
        source_snapshot, source_hash, visible_text, content_hash, status
      FROM recovery_candidates
      WHERE step_id = ? AND project_id = ? AND chapter_number = ?
    `).all(operation, projectId, chapterNumber)
    if (rows.length !== 1) fail('RECOVERY_DATABASE_CANDIDATE_NOT_UNIQUE')
    return rows[0]
  } catch (error) {
    if (error?.message?.startsWith('RECOVERY_')) throw error
    fail('RECOVERY_DATABASE_READ_FAILED')
  } finally { database?.close() }
}

function readOwnedPersistedDraft({ projectRoot, projectPath, databasePath, chapterNumber }) {
  ownedDirectory(projectRoot, projectPath, 'DIRECT_DATABASE_PATH_INVALID')
  const realDatabase = ownedRegularFile(projectPath, databasePath, 'DIRECT_DATABASE_PATH_INVALID')
  let database
  try {
    database = new Database(realDatabase, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    const rows = database.prepare(`
      SELECT d.id, d.chapter_number, d.version, d.status, d.source, d.word_count,
        d.content_id, c.body
      FROM drafts d
      JOIN contents c ON c.id = d.content_id
      WHERE d.chapter_number = ?
    `).all(chapterNumber)
    if (rows.length !== 1) fail('DIRECT_DATABASE_DRAFT_NOT_UNIQUE')
    return rows[0]
  } finally { database?.close() }
}

/**
 * Re-read a failed baseline's original receipt, artifact, ledger and SQLite row.
 * The returned marker is process-private review evidence; it is never a saved receipt.
 */
export function readVerifiedDirectPersistedDraftEvidence({ receiptPath }) {
  const isolationRoot = path.dirname(path.resolve(receiptPath))
  const requestPath = path.join(isolationRoot, 'execute-request.json')
  if (path.basename(receiptPath) !== 'execute-receipt.json'
    || path.resolve(receiptPath) !== path.join(isolationRoot, 'execute-receipt.json')) fail('DIRECT_RECEIPT_PATH_INVALID')
  ownedRegularFile(isolationRoot, receiptPath, 'DIRECT_RECEIPT_PATH_INVALID')
  ownedRegularFile(isolationRoot, requestPath, 'DIRECT_REQUEST_PATH_INVALID')
  const receiptBytes = fs.readFileSync(receiptPath, 'utf8'), requestBytes = fs.readFileSync(requestPath, 'utf8')
  const receipt = JSON.parse(receiptBytes), request = JSON.parse(requestBytes)
  if (request.mode !== 'real' || request.action !== 'execute' || request.target?.arm !== 'baseline'
    || path.resolve(request.target?.isolationRoot ?? '') !== isolationRoot
    || path.resolve(request.receiptPath ?? '') !== path.resolve(receiptPath)
    || !UUID.test(request.invocationId ?? '') || receipt.invocationId !== request.invocationId
    || receipt.arm !== 'baseline' || receipt.mode !== 'real' || receipt.action !== 'execute'
    || receipt.status !== 'failed' || receipt.physicalModelRequests !== 1 || receipt.syntheticDispatches !== 0
    || receipt.saved !== undefined || receipt.operations?.length !== 1 || receipt.attempts?.length !== 1)
    fail('DIRECT_RECEIPT_IDENTITY_INVALID')
  const operation = request.operations?.length === 1 && request.operations[0]
  const output = receipt.operations[0], attempt = receipt.attempts[0], binding = attempt?.binding
  if (typeof attempt?.attemptId !== 'string' || !attempt.attemptId.trim()) fail('DIRECT_LEDGER_ATTEMPT_ID_INVALID')
  if (!operation || operation.kind !== 'draft' || output?.kind !== 'draft' || output.operation !== operation.id
    || receipt.phase !== request.phase || receipt.caseId !== request.caseId || receipt.chapterNumber !== request.chapterNumber
    || receipt.protocolRevision !== request.protocolRevision || receipt.protocolHash !== request.protocolHash
    || request.target.protocolRevision !== request.protocolRevision || request.target.protocolHash !== request.protocolHash
    || receipt.codeSha !== request.target.codeSha || request.target.sourceHash !== binding?.sourceHash
    || request.driverHash !== request.target.driver?.sha256 || request.driverHash !== binding?.driverHash
    || request.target.codeSha !== binding?.codeSha || request.parityHash !== receipt.physicalProject?.parityHash
    || request.parityHash !== binding?.parityId || binding?.invocationId !== request.invocationId
    || binding?.arm !== 'baseline' || binding?.mode !== 'real' || binding?.phase !== request.phase
    || binding?.caseId !== request.caseId || binding?.operation !== operation.id
    || binding?.protocolRevision !== request.protocolRevision || binding?.protocolHash !== request.protocolHash
    || binding?.milestone !== request.milestone || typeof binding?.campaignId !== 'string' || !binding.campaignId)
    fail('DIRECT_ATTEMPT_BINDING_INVALID')

  const observation = receipt.draftObservation, gateFailure = receipt.gateFailure
  if (!observation || observation.persisted !== true || observation.chapterNumber !== request.chapterNumber
    || !Number.isSafeInteger(observation.units) || observation.units <= 0
    || !Number.isSafeInteger(observation.targetUnits) || observation.targetUnits <= 0
    || !CONTENT_HASH.test(observation.contentHash ?? '')
    || observation.units >= targetUnitRange(observation.targetUnits, request.protocolRevision, request.target.arm).minimum
      && observation.units <= targetUnitRange(observation.targetUnits, request.protocolRevision, request.target.arm).maximum
    || gateFailure?.code !== 'TARGET_UNITS_FAILED' || gateFailure.actualUnits !== observation.units
    || gateFailure.targetUnits !== observation.targetUnits || output.outputHash !== observation.contentHash
    || typeof output.outputPath !== 'string' || path.dirname(path.resolve(output.outputPath)) !== isolationRoot)
    fail('DIRECT_DRAFT_OBSERVATION_INVALID')
  const realOutput = ownedRegularFile(isolationRoot, output.outputPath, 'DIRECT_ARTIFACT_PATH_INVALID')
  const outputBytes = fs.readFileSync(realOutput), outputText = outputBytes.toString('utf8')
  if (sha(outputBytes) !== observation.contentHash || countProjectedDraftUnits(outputText) !== observation.units)
    fail('DIRECT_ARTIFACT_MISMATCH')

  const physicalProject = receipt.physicalProject
  if (typeof request.target.roots?.project !== 'string' || typeof physicalProject?.path !== 'string'
    || typeof physicalProject?.dbPath !== 'string' || typeof physicalProject?.projectId !== 'string'
    || !physicalProject.projectId) fail('DIRECT_DATABASE_IDENTITY_INVALID')
  const manifestPath = path.join(isolationRoot, 'physical-project.json')
  ownedRegularFile(isolationRoot, manifestPath, 'DIRECT_MANIFEST_PATH_INVALID')
  const manifestBytes = fs.readFileSync(manifestPath, 'utf8'), manifest = JSON.parse(manifestBytes)
  if (manifest?.kind !== 'manifest' || manifest.projectId !== physicalProject.projectId
    || typeof manifest.rootPath !== 'string' || path.resolve(manifest.rootPath) !== path.resolve(physicalProject.path))
    fail('DIRECT_MANIFEST_IDENTITY_INVALID')
  const row = readOwnedPersistedDraft({ projectRoot: request.target.roots.project, projectPath: physicalProject.path,
    databasePath: physicalProject.dbPath, chapterNumber: request.chapterNumber })
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.version) || row.version <= 0
    || !Number.isSafeInteger(row.content_id) || row.content_id <= 0 || row.chapter_number !== request.chapterNumber
    || row.status !== 'draft' || row.source !== 'write' || row.word_count !== observation.units
    || typeof row.body !== 'string' || row.body !== outputText || sha(row.body) !== observation.contentHash)
    fail('DIRECT_DATABASE_DRAFT_MISMATCH')

  const ledgerPath = request.ledgerPath
  if (typeof ledgerPath !== 'string' || !fs.existsSync(ledgerPath)
    || !fs.lstatSync(ledgerPath).isFile() || fs.lstatSync(ledgerPath).isSymbolicLink()) fail('DIRECT_LEDGER_PATH_INVALID')
  const ledger = ledgerEvidence(fs.readFileSync(ledgerPath, 'utf8'), attempt, 'DIRECT')
  const identity = Object.freeze({ invocationId: request.invocationId, arm: 'baseline', operation: operation.id,
    projectId: physicalProject.projectId, chapterNumber: request.chapterNumber,
    draftId: row.id, version: row.version, status: row.status, wordCount: row.word_count,
    targetUnits: observation.targetUnits, units: observation.units, contentHash: observation.contentHash })
  const evidence = Object.freeze({ receiptPath, receiptSha256: sha(receiptBytes), requestSha256: sha(requestBytes),
    physicalProjectManifestSha256: sha(manifestBytes),
    ledger: Object.freeze({ path: ledgerPath, attemptId: ledger.attemptId, boundary: Object.freeze(ledger.boundary) }), identity })
  verifiedDirectPersistedEvidence.add(evidence)
  return { operations: structuredClone(receipt.operations), draftObservation: structuredClone(observation),
    gateFailure: structuredClone(gateFailure), directPersistedEvidence: evidence }
}

/**
 * Export a review-only baseline artifact. It never changes the original receipt,
 * SQLite candidate, ledger, or formal saved-draft contract.
 */
export function projectRecoveryCandidateSupplement(input) {
  const { request, requestBytes, receipt, receiptBytes, ledgerBytes, recoveryRows, targetUnits, isolationRoot } = input
  if (request.mode !== 'real' || request.action !== 'execute' || request.target?.arm !== 'baseline'
    || !UUID.test(request.invocationId ?? '') || receipt.invocationId !== request.invocationId
    || receipt.arm !== 'baseline' || receipt.mode !== 'real' || receipt.status !== 'failed'
    || receipt.physicalModelRequests !== 1 || receipt.syntheticDispatches !== 0
    || receipt.saved !== undefined || receipt.operations?.length !== 0 || receipt.attempts?.length !== 1
    || stable(JSON.parse(receiptBytes)) !== stable(receipt) || stable(JSON.parse(requestBytes)) !== stable(request))
    fail('RECOVERY_ORIGINAL_RECEIPT_INVALID')
  if (!inside(isolationRoot, request.receiptPath) || path.resolve(isolationRoot) !== path.resolve(request.target.isolationRoot)
    || !inside(request.target.roots.project, receipt.physicalProject?.dbPath ?? '')) fail('RECOVERY_PATH_INVALID')
  const operation = request.operations?.length === 1 && request.operations[0]
  if (!operation || operation.kind !== 'draft' || receipt.phase !== request.phase || receipt.caseId !== request.caseId
    || receipt.chapterNumber !== request.chapterNumber || receipt.physicalProject?.projectId === undefined) fail('RECOVERY_IDENTITY_MISMATCH')
  const attempt = receipt.attempts[0]
  if (attempt.binding?.arm !== 'baseline' || attempt.binding?.mode !== 'real' || attempt.binding?.operation !== operation.id
    || attempt.binding?.phase !== request.phase || attempt.binding?.caseId !== request.caseId
    || attempt.binding?.invocationId !== request.invocationId
    || attempt.binding?.driverHash !== request.driverHash || attempt.binding?.codeSha !== request.target.codeSha) fail('RECOVERY_IDENTITY_MISMATCH')
  const ledger = ledgerEvidence(ledgerBytes, attempt)

  const matchingRows = recoveryRows.filter(row => row.step_id === operation.id
    && row.project_id === receipt.physicalProject.projectId && row.chapter_number === request.chapterNumber)
  if (matchingRows.length !== 1) fail('RECOVERY_CANDIDATE_NOT_UNIQUE')
  const row = matchingRows[0]
  if (row.status !== 'pending' || typeof row.visible_text !== 'string' || !row.visible_text.trim()
    || !CONTENT_HASH.test(row.content_hash ?? '') || sha(row.visible_text) !== row.content_hash
    || !CONTENT_HASH.test(row.source_hash ?? '') || sha(row.source_snapshot) !== row.source_hash) fail('RECOVERY_CANDIDATE_INVALID')
  let source
  try { source = JSON.parse(row.source_snapshot) } catch { fail('RECOVERY_CANDIDATE_INVALID') }
  if (source.chapterNumber !== request.chapterNumber || source.title !== row.chapter_title
    || !Number.isSafeInteger(targetUnits) || targetUnits <= 0) fail('RECOVERY_IDENTITY_MISMATCH')
  const units = countProjectedDraftUnits(row.visible_text)
  const range = targetUnitRange(targetUnits, request.protocolRevision, request.target.arm)
  if (units >= range.minimum && units <= range.maximum) fail('RECOVERY_TARGET_UNITS_CONFORMING')

  const localGate = input.localDispatchGateRejection
  if (!localGate || localGate.code !== LOCAL_DISPATCH_REJECTION || localGate.operation !== operation.id
      || localGate.runId !== row.run_id || localGate.projectId !== row.project_id
      || localGate.chapterNumber !== row.chapter_number || localGate.beforeDispatch !== true)
    fail('RECOVERY_LOCAL_GATE_EVIDENCE_MISSING')

  const artifactPath = path.join(isolationRoot, 'recovery-reviewable-output.txt')
  const supplementPath = path.join(isolationRoot, 'recovery-supplement.json')
  if (!inside(isolationRoot, artifactPath) || !inside(isolationRoot, supplementPath)
    || fs.realpathSync(path.dirname(artifactPath)) !== fs.realpathSync(isolationRoot)) fail('RECOVERY_PATH_INVALID')
  writeIdenticalOrCreate(artifactPath, row.visible_text)
  if (sha(fs.readFileSync(artifactPath)) !== row.content_hash) fail('RECOVERY_ARTIFACT_HASH_MISMATCH')
  const supplement = {
    schemaVersion: 1, kind: 'quality-recovery-candidate-supplement', disposition: 'reference-nonconforming',
    originalReceipt: { path: request.receiptPath, sha256: sha(receiptBytes) },
    request: { path: path.join(isolationRoot, 'execute-request.json'), sha256: sha(requestBytes) },
    ledger: { ...ledger, path: request.ledgerPath },
    identity: { invocationId: request.invocationId, arm: 'baseline', operation: operation.id,
      candidateId: row.candidate_id, runId: row.run_id, stepId: row.step_id,
      projectId: row.project_id, chapterNumber: row.chapter_number, status: row.status },
    recoveryCandidate: { sourceHash: row.source_hash, contentHash: row.content_hash },
    localDispatchGateRejection: localGate,
    operation: { kind: 'draft', outputPath: artifactPath, outputHash: row.content_hash, reviewOnly: true },
    draftObservation: { chapterNumber: row.chapter_number, targetUnits, units, contentHash: row.content_hash,
      persisted: true, source: 'recovery-candidate' },
    gateFailure: { code: 'TARGET_UNITS_FAILED', actualUnits: units, targetUnits },
    formalSaved: false,
  }
  if (fs.existsSync(supplementPath)) {
    if (fs.lstatSync(supplementPath).isSymbolicLink()) fail('RECOVERY_PATH_INVALID')
    const existing = JSON.parse(fs.readFileSync(supplementPath, 'utf8'))
    const currentForComparison = { ...supplement, ledger: { ...supplement.ledger, sha256: existing.ledger?.sha256 } }
    if (stable(existing) !== stable(currentForComparison)) fail('RECOVERY_SUPPLEMENT_CONFLICT')
    return { ...existing, supplementPath }
  }
  fs.writeFileSync(supplementPath, JSON.stringify(supplement, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return { ...supplement, supplementPath }
}

/** Validate a supplemental artifact before projecting it into an in-memory arm result. */
export function readVerifiedRecoveryCandidateSupplement({ receiptPath, supplementPath = path.join(path.dirname(receiptPath), 'recovery-supplement.json') }) {
  const isolationRoot = path.dirname(path.resolve(receiptPath))
  if (path.basename(receiptPath) !== 'execute-receipt.json'
    || path.resolve(supplementPath) !== path.join(isolationRoot, 'recovery-supplement.json')
    || [receiptPath, supplementPath].some(file => !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()))
    fail('RECOVERY_SUPPLEMENT_MISSING_OR_UNOWNED')
  const receiptBytes = fs.readFileSync(receiptPath, 'utf8')
  const supplementBytes = fs.readFileSync(supplementPath, 'utf8')
  const receipt = JSON.parse(receiptBytes), supplement = JSON.parse(supplementBytes)
  const requestPath = supplement.request?.path
  if (typeof requestPath !== 'string' || path.resolve(requestPath) !== path.join(isolationRoot, 'execute-request.json')
    || !fs.existsSync(requestPath) || fs.lstatSync(requestPath).isSymbolicLink()) fail('RECOVERY_SUPPLEMENT_REQUEST_INVALID')
  const requestBytes = fs.readFileSync(requestPath, 'utf8'), request = JSON.parse(requestBytes)
  if (supplement.schemaVersion !== 1 || supplement.kind !== 'quality-recovery-candidate-supplement'
    || supplement.disposition !== 'reference-nonconforming' || supplement.formalSaved !== false
    || supplement.saved !== undefined || supplement.originalReceipt?.path !== receiptPath
    || supplement.originalReceipt?.sha256 !== sha(receiptBytes) || supplement.request.sha256 !== sha(requestBytes)
    || request.mode !== 'real' || request.action !== 'execute' || request.target?.arm !== 'baseline'
    || path.resolve(request.target?.isolationRoot ?? '') !== isolationRoot
    || request.receiptPath !== receiptPath || !UUID.test(request.invocationId ?? '') || request.invocationId !== receipt.invocationId
    || supplement.identity?.invocationId !== request.invocationId || supplement.identity?.arm !== 'baseline'
    || receipt.arm !== 'baseline' || receipt.mode !== 'real' || receipt.status !== 'failed'
    || receipt.physicalModelRequests !== 1 || receipt.syntheticDispatches !== 0 || receipt.saved !== undefined
    || receipt.operations?.length !== 0 || receipt.attempts?.length !== 1) fail('RECOVERY_SUPPLEMENT_IDENTITY_INVALID')
  const operation = request.operations?.length === 1 && request.operations[0]
  const attempt = receipt.attempts[0]
  if (!operation || operation.kind !== 'draft' || supplement.identity.operation !== operation.id
    || supplement.identity.stepId !== operation.id || attempt.binding?.invocationId !== request.invocationId
    || attempt.binding?.arm !== 'baseline' || attempt.binding?.operation !== operation.id
    || supplement.identity.projectId !== receipt.physicalProject?.projectId
    || supplement.identity.chapterNumber !== request.chapterNumber
    || typeof supplement.identity.candidateId !== 'string' || !supplement.identity.candidateId
    || typeof supplement.identity.runId !== 'string' || !supplement.identity.runId) fail('RECOVERY_SUPPLEMENT_IDENTITY_INVALID')
  const row = readOwnedRecoveryCandidate({ projectRoot: request.target.roots?.project,
    databasePath: receipt.physicalProject?.dbPath, operation: operation.id,
    projectId: receipt.physicalProject?.projectId, chapterNumber: request.chapterNumber })
  if (supplement.identity.candidateId !== row.candidate_id || supplement.identity.runId !== row.run_id
    || supplement.identity.stepId !== row.step_id || supplement.identity.projectId !== row.project_id
    || supplement.identity.chapterNumber !== row.chapter_number || supplement.identity.status !== row.status
    || row.status !== 'pending' || typeof row.source_snapshot !== 'string' || !CONTENT_HASH.test(row.source_hash ?? '')
    || sha(row.source_snapshot) !== row.source_hash || supplement.recoveryCandidate?.sourceHash !== row.source_hash
    || typeof row.visible_text !== 'string' || !row.visible_text.trim() || !CONTENT_HASH.test(row.content_hash ?? '')
    || sha(row.visible_text) !== row.content_hash || supplement.recoveryCandidate?.contentHash !== row.content_hash)
    fail('RECOVERY_SUPPLEMENT_DATABASE_MISMATCH')
  let source
  try { source = JSON.parse(row.source_snapshot) } catch { fail('RECOVERY_SUPPLEMENT_DATABASE_MISMATCH') }
  if (source.chapterNumber !== request.chapterNumber || source.title !== row.chapter_title)
    fail('RECOVERY_SUPPLEMENT_DATABASE_MISMATCH')
  const ledgerPath = supplement.ledger?.path
  if (typeof ledgerPath !== 'string' || path.resolve(ledgerPath) !== path.resolve(request.ledgerPath)
    || !fs.existsSync(ledgerPath) || fs.lstatSync(ledgerPath).isSymbolicLink()) fail('RECOVERY_SUPPLEMENT_LEDGER_INVALID')
  const currentLedger = ledgerEvidence(fs.readFileSync(ledgerPath, 'utf8'), attempt)
  if (stable(currentLedger.boundary) !== stable(supplement.ledger.boundary)
    || currentLedger.attemptId !== supplement.ledger.attemptId || supplement.ledger.finishReason !== 'stop'
    || supplement.ledger.sha256 !== supplement.ledger.boundary?.rawBytesSha256)
    fail('RECOVERY_SUPPLEMENT_LEDGER_INVALID')
  const observation = supplement.draftObservation, gateFailure = supplement.gateFailure, output = supplement.operation
  if (!observation || observation.persisted !== true || observation.source !== 'recovery-candidate'
    || !Number.isSafeInteger(observation.chapterNumber) || observation.chapterNumber !== request.chapterNumber
    || !Number.isSafeInteger(observation.units) || observation.units <= 0
    || !Number.isSafeInteger(observation.targetUnits) || observation.targetUnits <= 0
    || !CONTENT_HASH.test(observation.contentHash ?? '')
    || observation.units >= targetUnitRange(observation.targetUnits, request.protocolRevision, request.target.arm).minimum
      && observation.units <= targetUnitRange(observation.targetUnits, request.protocolRevision, request.target.arm).maximum
    || gateFailure?.code !== 'TARGET_UNITS_FAILED' || gateFailure.actualUnits !== observation.units
    || gateFailure.targetUnits !== observation.targetUnits
    || observation.contentHash !== row.content_hash || observation.units !== countProjectedDraftUnits(row.visible_text)
    || output?.kind !== 'draft' || output.reviewOnly !== true || output.outputHash !== row.content_hash
    || typeof output.outputPath !== 'string' || !inside(isolationRoot, output.outputPath)
    || path.dirname(path.resolve(output.outputPath)) !== isolationRoot || !fs.existsSync(output.outputPath)
    || fs.lstatSync(output.outputPath).isSymbolicLink() || fs.readFileSync(output.outputPath, 'utf8') !== row.visible_text
    || sha(fs.readFileSync(output.outputPath)) !== row.content_hash)
    fail('RECOVERY_SUPPLEMENT_ARTIFACT_INVALID')
  const localGate = supplement.localDispatchGateRejection
  if (localGate?.code !== LOCAL_DISPATCH_REJECTION || localGate.beforeDispatch !== true
    || localGate.operationId !== operation.id || localGate.operation !== operation.id
    || localGate.runId !== supplement.identity.runId
    || localGate.projectId !== supplement.identity.projectId || localGate.chapterNumber !== supplement.identity.chapterNumber)
    fail('RECOVERY_SUPPLEMENT_GATE_INVALID')
  const evidence = Object.freeze({ path: supplementPath, sha256: sha(supplementBytes),
    identity: Object.freeze(structuredClone(supplement.identity)), originalReceiptSha256: supplement.originalReceipt.sha256 })
  verifiedSupplementEvidence.add(evidence)
  return {
    operations: [{ operation: operation.id, kind: 'draft', outputPath: output.outputPath,
      outputHash: output.outputHash, recoverySupplement: true }],
    draftObservation: structuredClone(observation), gateFailure: structuredClone(gateFailure),
    supplementEvidence: evidence,
  }
}
