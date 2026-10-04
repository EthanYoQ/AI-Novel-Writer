import { parsePlanningTargetUnits, DEFAULT_PLANNING_TARGET_UNITS } from '../../src/shared/plot-outline-contract';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VisibleCompositionReceipt, VisibleCompositionAlgorithm, DirectoryGenerationProgress, PlanningContinuationReceipt, BlueprintAuthorEditReceipt, GenerationAuthorInput } from '../../src/shared/generation-owner-contract';
import { composeVisibleContinuation, VISIBLE_CONTINUATION_VERSION } from '../../src/shared/visible-continuation';
import { composeDraftVisibleContinuation, DRAFT_CONDENSE_PURPOSE, isDraftVisibleTextVersion, sanitizeDraftText } from '../../src/shared/draft-visible-text';
import { DRAFT_RECONCILE_PURPOSE } from '../../src/shared/draft-reconciliation';
import { DRAFT_SHORT_OUTLINE_PURPOSE } from '../../src/shared/draft-short-outline';
import { countDraftUnits, draftTargetUnitRange } from '../../src/shared/draft-units';
import { getProjectDb } from '../database';
import type { PortableRuntimeFreezeTable } from '../services/portable-runtime-freeze';
import { assertReservation, assertAttemptTransition, rootActionIdempotencyKey, type RootAction, type RootBudget, type PhysicalAttempt, type VisibleArtifact, type ProviderUsagePolicy } from '../../src/shared/generation-contract';
import { isContentHash, sameProjectEpoch, type FrozenInputFingerprint, type SourceRef, type ProjectEpoch } from '../../src/shared/source-ref';
import { PLOT_OUTLINE_PROTOCOL, plotOutlinePolicy, plotOutlineExpected, plotOutlineConfirmedPrefix, derivePlotOutlineCursor, parsePlotOutlinePurpose, plotOutlinePurpose, validPlotOutlineEntry, joinPlotOutlineEntries, plotOutlineRequestContract, type PlotOutlineProgress, type PlotOutlineAuthorEditReceipt, type PlotOutlineRange } from '../../src/shared/plot-outline-contract';
export interface RunBinding extends ProjectEpoch {
    fingerprint: FrozenInputFingerprint;
    contextSnapshotId: string;
    sourceManifest: Readonly<Record<string, unknown>>;
    sourceRefs: readonly SourceRef[];
}
export interface OpenGenerationRunRequest extends RunBinding {
    operation: string;
    uiActionNonce: string;
    frozenInputHash: string;
    budget: RootBudget;
    parentRootActionId?: string;
}
export interface DurableGenerationRun {
    runId: string;
    rootActionId: string;
    binding: RunBinding;
    status: string;
}
export interface GenerationBudgetReceipt {
    root: RootAction;
    policy: RootBudget;
    activeElapsedMs: number;
    attempts: PhysicalAttempt[];
    blockedCode: string | null;
}
export interface GenerationUsageReceipt {
    policy: ProviderUsagePolicy;
    inputTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    actualTokens?: number;
    trusted: boolean;
    /** Main-parsed execution control, never part of the visible novel artifact. */
    agentResponse?: { version: 1; visibleText: string; toolCalls: { name: string; arguments: Record<string, unknown> }[] };
}
export interface GenerationExecutionReceipt {
    diagnostics?: import('../../src/shared/generation-contract').GenerationTransportDiagnostics;
    budgetDecision?: import('../../src/services/generation/task-budget-planner').TaskBudgetDecision;
    run: DurableGenerationRun;
    attempt: PhysicalAttempt;
    artifact: VisibleArtifact | null;
    budget: GenerationBudgetReceipt;
    result: {
        finishReason: string | null;
        usage: GenerationUsageReceipt | null;
    } | null;
    unsavedTail?: string;
    failureCode?: string;
}
interface ReceiptRow {
    attempt_id: string; run_id: string; ordinal: number; attempt_json: string; usage_receipt_json: string;
    artifact_id: string | null; artifact_run_id: string | null; artifact_json: string | null; revision: number | null; artifact_status: string | null;
}
interface ReceiptUsage {
    purpose?: string;
    artifactIdentity?: Pick<VisibleArtifact, 'artifactId' | 'epoch' | 'fingerprint'>;
    result?: NonNullable<GenerationExecutionReceipt['result']> & Pick<GenerationExecutionReceipt, 'diagnostics' | 'failureCode'>;
    budgetDecision?: GenerationExecutionReceipt['budgetDecision'];
}
interface GenerationRead {
    run: DurableGenerationRun; budget: GenerationBudgetReceipt; rows: ReceiptRow[];
    artifacts: Map<string, ReceiptRow>;
    receipt: (attemptId: string) => { receipt: GenerationExecutionReceipt; usage: ReceiptUsage };
}
const receiptSelect = `SELECT t.attempt_id,t.run_id,t.rowid AS ordinal,t.attempt_json,
    json_object('purpose',json_extract(t.usage_receipt_json,'$.purpose'),
        'artifactIdentity',json_extract(t.usage_receipt_json,'$.artifactIdentity'),
        'result',json_extract(t.usage_receipt_json,'$.result'),
        'budgetDecision',json_extract(t.usage_receipt_json,'$.budgetDecision')) AS usage_receipt_json,
    a.artifact_id,a.run_id AS artifact_run_id,a.artifact_json,a.revision,a.status AS artifact_status
    FROM generation_attempts t LEFT JOIN generation_artifacts a ON a.attempt_id=t.attempt_id`;
export const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (value: unknown): string => JSON.stringify(value);
const authorEffectPath = '$."$runEffects"';
function fail(code: string): never { throw new Error(code); }
const completeHandle = (handle: DirectoryGenerationProgress['sourceHandle']) => handle && typeof handle === 'object'
    && Object.keys(handle).length === 4 && ['projectId', 'epoch', 'rootActionId', 'runId'].every(key => typeof handle[key as keyof typeof handle] === 'string' && handle[key as keyof typeof handle].trim());
function binding(request: RunBinding): RunBinding {
    if (!request.sourceManifest || typeof request.sourceManifest !== 'object' || Array.isArray(request.sourceManifest) || !Object.keys(request.sourceManifest).length || !request.projectId || !request.epoch || !request.contextSnapshotId || Object.keys(request.fingerprint).length !== 9
        || ['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash'].some(key => !isContentHash(request.fingerprint[key as keyof FrozenInputFingerprint]))
        || request.sourceRefs.some(ref => !sameProjectEpoch(ref, request) || !ref.sourceId || !isContentHash(ref.contentHash) || !Number.isSafeInteger(ref.revision) || ref.revision < 0))
        fail('GENERATION_BINDING_INVALID');
    return JSON.parse(encode({ projectId: request.projectId, epoch: request.epoch, fingerprint: request.fingerprint, contextSnapshotId: request.contextSnapshotId, sourceManifest: request.sourceManifest, sourceRefs: request.sourceRefs }));
}
export class GenerationRunRepository {
    private readonly database: Database.Database | null;
    constructor(getDb: () => Database.Database | null = getProjectDb, private readonly now: () => number = Date.now,
        private readonly isFrozen: (table: PortableRuntimeFreezeTable, recordId: string) => boolean = () => false) {
        // Capture this project's admitted handle once. A later project switch
        // must never redirect in-flight generation writes into another DB.
        this.database = getDb();
    }
    private db(): Database.Database {
        if (!this.database?.open) fail('GENERATION_DATABASE_NOT_READY');
        return this.database;
    }
    private transaction<T>(fn: () => T): T { return this.db().transaction(fn).immediate(); }
    get(runId: string): DurableGenerationRun {
        const row = this.db().prepare('SELECT * FROM generation_runs WHERE run_id=?').get(runId) as {
            run_id: string;
            root_action_id: string;
            binding_json: string;
            status: string;
        } | undefined;
        if (!row)
            fail('GENERATION_RUN_MISSING');
        const { $runEffects, ...frozen } = JSON.parse(row.binding_json) as RunBinding & { $runEffects?: unknown };
        void $runEffects;
        return { runId: row.run_id, rootActionId: row.root_action_id, binding: frozen, status: row.status };
    }
    private authorEditedRoot(rootId: string): boolean {
        return !!this.db().prepare('SELECT 1 FROM generation_runs WHERE root_action_id=? AND json_type(binding_json,?) IS NOT NULL LIMIT 1').get(rootId, authorEffectPath);
    }
    assertPlotOutlineWritable(runId: string): void {
        if (this.isPrivatePlanningHistory(runId)) fail('GENERATION_PLANNING_HISTORY_READ_ONLY');
        if (this.authorEditedRoot(this.get(runId).rootActionId)) fail('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED');
    }
    isPrivatePlanningHistory(runId: string): boolean {
        return !!this.db().prepare("SELECT 1 FROM generation_runs WHERE root_action_id=(SELECT root_action_id FROM generation_runs WHERE run_id=?) AND json_extract(binding_json,'$.sourceManifest.policy.planning.outlineProtocol')='chapter-parts-v2' LIMIT 1").get(runId);
    }
    plotOutlineAuthorEditReceipt(runId: string, operationId: string, committedRange: PlotOutlineRange, synopsisHash: string): PlotOutlineAuthorEditReceipt {
        const run = this.get(runId), policy = plotOutlinePolicy(run.binding.sourceManifest);
        if (!policy || !committedRange || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/u.test(operationId) || !isContentHash(synopsisHash)
            || committedRange.from !== policy.range.from || !Number.isSafeInteger(committedRange.to)
            || committedRange.to < committedRange.from || committedRange.to > policy.range.to) fail('GENERATION_PLOT_OUTLINE_AUTHOR_EDIT_INVALID');
        if (this.db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycles'").get()
            && this.db().prepare('SELECT 1 FROM review_cycles WHERE root_action_id=? LIMIT 1').get(run.rootActionId))
            fail('GENERATION_PLOT_OUTLINE_AUTHOR_EDIT_INVALID');
        const sourceHandle = { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId };
        const expected = plotOutlineExpected(run.binding.sourceManifest.plotOutlineSource);
        return { kind: 'author-edit', operationId, sourceHandle, requestedRange: policy.range,
            committedRange: { from: committedRange.from, to: committedRange.to },
            remainingRange: committedRange.to < policy.range.to ? { from: committedRange.to + 1, to: policy.range.to } : null,
            synopsisHash, payloadHash: textHash(encode([sourceHandle, operationId, committedRange.from, committedRange.to, synopsisHash, expected])), idempotent: false };
    }
    readPlotOutlineAuthorEdit(runId: string): PlotOutlineAuthorEditReceipt | null {
        const stored = this.db().prepare('SELECT json_extract(binding_json,?) FROM generation_runs WHERE run_id=?').pluck().get(authorEffectPath, runId);
        if (stored === null || stored === undefined) return null;
        const value = JSON.parse(String(stored)) as { plotOutlineAuthorEdit?: PlotOutlineAuthorEditReceipt; planningContinuation?: PlanningContinuationReceipt };
        const receipt = value?.plotOutlineAuthorEdit;
        if (Object.keys(value).some(key => !['plotOutlineAuthorEdit', 'blueprintAuthorEdit', 'planningContinuation'].includes(key))) fail('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_INVALID');
        if (!receipt) return null;
        if (!receipt.committedRange
            || !isDeepStrictEqual(receipt, this.plotOutlineAuthorEditReceipt(runId, receipt.operationId, receipt.committedRange, receipt.synopsisHash)))
            fail('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_INVALID');
        return receipt;
    }
    recordPlotOutlineAuthorEdit(receipt: PlotOutlineAuthorEditReceipt): void {
        if (!this.db().inTransaction) fail('GENERATION_PLOT_OUTLINE_TRANSACTION_REQUIRED');
        const runId = receipt.sourceHandle.runId;
        this.assertPlotOutlineWritable(runId);
        if (!isDeepStrictEqual(receipt, this.plotOutlineAuthorEditReceipt(runId, receipt.operationId, receipt.committedRange, receipt.synopsisHash)))
            fail('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_INVALID');
        const original = this.db().prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(runId) as string;
        const result = this.db().prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=? AND binding_json=?')
            .run(encode({ ...JSON.parse(original), $runEffects: { plotOutlineAuthorEdit: receipt } }), runId, original);
        if (result.changes !== 1) fail('GENERATION_PLOT_OUTLINE_AUTHOR_RECEIPT_CONFLICT');
    }
    readPlanningContinuation(runId: string): PlanningContinuationReceipt | null {
        const stored = this.db().prepare('SELECT json_extract(binding_json,?) FROM generation_runs WHERE run_id=?').pluck().get(`${authorEffectPath}.planningContinuation`, runId);
        if (stored === null || stored === undefined) return null;
        const receipt = JSON.parse(String(stored)) as PlanningContinuationReceipt;
        const source = this.get(runId);
        if (!receipt || receipt.kind !== 'planning-continuation' || !completeHandle(receipt.sourceHandle) || !completeHandle(receipt.nextHandle)
            || !isContentHash(receipt.requestHash) || Object.keys(receipt).some(key => !['kind', 'sourceHandle', 'nextHandle', 'requestHash'].includes(key))
            || receipt.sourceHandle.runId !== runId || receipt.sourceHandle.rootActionId !== source.rootActionId
            || receipt.sourceHandle.projectId !== source.binding.projectId || receipt.nextHandle.projectId !== source.binding.projectId
            || receipt.nextHandle.rootActionId === source.rootActionId) fail('GENERATION_PLANNING_CONTINUATION_INVALID');
        const next = this.get(receipt.nextHandle.runId);
        if (next.rootActionId !== receipt.nextHandle.rootActionId || next.binding.projectId !== source.binding.projectId)
            fail('GENERATION_PLANNING_CONTINUATION_INVALID');
        return { ...receipt, nextHandle: { ...receipt.nextHandle, epoch: next.binding.epoch } };
    }
    readBlueprintAuthorEdit(runId: string): BlueprintAuthorEditReceipt | null {
        const stored = this.db().prepare('SELECT json_extract(binding_json,?) FROM generation_runs WHERE run_id=?').pluck().get(`${authorEffectPath}.blueprintAuthorEdit`, runId);
        if (stored === null || stored === undefined) return null;
        const receipt = JSON.parse(String(stored)) as BlueprintAuthorEditReceipt;
        const run = this.get(runId);
        const input = (run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined)?.find(item => item.id === 'directory:requested-range');
        const range = input ? JSON.parse(input.text) as { startChapter: number; endChapter: number } : null;
        if (!receipt || receipt.kind !== 'blueprint-author-edit' || !range || run.binding.sourceManifest.operation !== 'chapter-blueprint-directory'
            || !completeHandle(receipt.sourceHandle) || receipt.sourceHandle.runId !== runId || receipt.sourceHandle.rootActionId !== run.rootActionId
            || receipt.sourceHandle.projectId !== run.binding.projectId || !isContentHash(receipt.payloadHash)
            || !isDeepStrictEqual(receipt.requestedRange, { from: range.startChapter, to: range.endChapter })
            || !receipt.committedRange || !Number.isSafeInteger(receipt.committedRange.from) || !Number.isSafeInteger(receipt.committedRange.to)
            || receipt.committedRange.from < range.startChapter || receipt.committedRange.to < receipt.committedRange.from || receipt.committedRange.to > range.endChapter
            || !isDeepStrictEqual(receipt.remainingRange, receipt.committedRange.to < range.endChapter ? { from: receipt.committedRange.to + 1, to: range.endChapter } : null)
            || Object.keys(receipt).some(key => !['kind', 'operationId', 'sourceHandle', 'requestedRange', 'committedRange', 'remainingRange', 'payloadHash'].includes(key)))
            fail('GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID');
        const committed = this.db().prepare('SELECT payload_hash,start_chapter,end_chapter FROM blueprint_commit_operations WHERE operation_id=?').get(receipt.operationId) as { payload_hash: string; start_chapter: number; end_chapter: number } | undefined;
        if (!committed || committed.payload_hash !== receipt.payloadHash || committed.start_chapter !== receipt.committedRange.from || committed.end_chapter !== receipt.committedRange.to)
            fail('GENERATION_BLUEPRINT_AUTHOR_RECEIPT_INVALID');
        return receipt;
    }
    recordBlueprintAuthorEdit(receipt: BlueprintAuthorEditReceipt): void {
        if (!this.db().inTransaction) fail('GENERATION_DIRECTORY_TRANSACTION_REQUIRED');
        this.assertPlotOutlineWritable(receipt.sourceHandle.runId);
        const original = this.db().prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(receipt.sourceHandle.runId) as string;
        const binding = JSON.parse(original);
        const result = this.db().prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=? AND binding_json=?')
            .run(encode({ ...binding, $runEffects: { ...binding.$runEffects, blueprintAuthorEdit: receipt } }), receipt.sourceHandle.runId, original);
        if (result.changes !== 1) fail('GENERATION_BLUEPRINT_AUTHOR_RECEIPT_CONFLICT');
        this.readBlueprintAuthorEdit(receipt.sourceHandle.runId);
    }
    recordPlanningContinuation(receipt: PlanningContinuationReceipt): void {
        if (!this.db().inTransaction) fail('GENERATION_PLOT_OUTLINE_TRANSACTION_REQUIRED');
        if (this.readPlanningContinuation(receipt.sourceHandle.runId)) fail('GENERATION_PLANNING_CONTINUATION_EXISTS');
        const original = this.db().prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(receipt.sourceHandle.runId) as string;
        const binding = JSON.parse(original);
        const result = this.db().prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=? AND binding_json=?')
            .run(encode({ ...binding, $runEffects: { ...binding.$runEffects, planningContinuation: receipt } }), receipt.sourceHandle.runId, original);
        if (result.changes !== 1) fail('GENERATION_PLANNING_CONTINUATION_CONFLICT');
        this.readPlanningContinuation(receipt.sourceHandle.runId);
    }
    budget(rootId: string): GenerationBudgetReceipt {
        const row = this.db().prepare('SELECT * FROM generation_roots WHERE root_action_id=?').get(rootId) as {
            action_json: string;
            budget_json: string;
            active_elapsed_ms: number;
            active_since_ms: number | null;
            blocked_code: string | null;
        } | undefined;
        if (!row)
            fail('GENERATION_ROOT_MISSING');
        const attempts = this.db().prepare('SELECT attempt_json FROM generation_attempts WHERE root_action_id=? ORDER BY rowid').all(rootId) as {
            attempt_json: string;
        }[];
        return { root: JSON.parse(row.action_json), policy: JSON.parse(row.budget_json), activeElapsedMs: row.active_elapsed_ms + (row.active_since_ms === null ? 0 : Math.max(0, this.now() - row.active_since_ms)), attempts: attempts.map(row => JSON.parse(row.attempt_json)), blockedCode: row.blocked_code };
    }
    attemptCount(runId: string): number {
        return this.db().prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(runId) as number;
    }
    hasNonCancelledAttempt(runId: string): boolean {
        const rows = this.db().prepare('SELECT attempt_json FROM generation_attempts WHERE run_id=?').all(runId) as { attempt_json: string }[];
        return rows.some(row => (JSON.parse(row.attempt_json) as PhysicalAttempt).status !== 'cancelled-before-dispatch');
    }
    open(request: OpenGenerationRunRequest): DurableGenerationRun {
        const frozen = binding(request);
        return this.transaction(() => {
            let action: RootAction = { projectId: request.projectId, epoch: request.epoch, operation: request.operation, uiActionNonce: request.uiActionNonce, frozenInputHash: request.frozenInputHash, rootActionId: randomUUID(), status: 'active' };
            const key = rootActionIdempotencyKey(action);
            const openKey = encode([key, request.parentRootActionId ?? null]);
            const existing = this.db().prepare('SELECT run_id FROM generation_runs WHERE open_key=?').get(openKey) as {
                run_id: string;
            } | undefined;
            if (existing) {
                this.assertPlotOutlineWritable(existing.run_id);
                const prior = this.get(existing.run_id);
                if (!isDeepStrictEqual(prior.binding.sourceManifest, frozen.sourceManifest) || !isDeepStrictEqual(prior.binding.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; }), frozen.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; })) || encode(prior.binding.fingerprint) !== encode(frozen.fingerprint) || prior.binding.contextSnapshotId !== frozen.contextSnapshotId || encode(this.budget(prior.rootActionId).policy) !== encode(request.budget))
                    fail('GENERATION_NONCE_CONFLICT');
                return prior;
            }
            if (request.parentRootActionId) {
                if (this.authorEditedRoot(request.parentRootActionId)) fail('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED');
                const parent = this.budget(request.parentRootActionId);
                if (parent.root.projectId !== request.projectId || parent.root.epoch !== request.epoch || parent.root.status !== 'active' || parent.blockedCode)
                    fail('GENERATION_PARENT_INVALID');
                action = parent.root;
            }
            else {
                if (['maxPhysicalRequests', 'maxTokenLiability', 'maxOutputPerRequest', 'maxActiveElapsedMs'].some(key => { const value = request.budget[key as keyof RootBudget]; return !Number.isSafeInteger(value) || value <= 0; }))
                    fail('INVALID_BUDGET');
                this.db().prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run(action.rootActionId, key, encode(action), encode(request.budget));
            }
            const runId = randomUUID();
            this.db().prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(runId, action.rootActionId, encode(frozen), 'running', this.now(), openKey);
            return this.get(runId);
        });
    }
    replaceUnstartedBinding(runId: string, expected: RunBinding, next: RunBinding): DurableGenerationRun {
        const frozen = binding(next);
        return this.transaction(() => {
            const run = this.get(runId), budget = this.budget(run.rootActionId);
            this.assertPlotOutlineWritable(runId);
            if (!isDeepStrictEqual(run.binding, expected)) fail('GENERATION_BINDING_CONFLICT');
            if (run.status !== 'running' || budget.root.status !== 'active' || this.attemptCount(runId) > 0 || budget.blockedCode)
                fail('GENERATION_MATERIAL_DECISION_TOO_LATE');
            this.db().prepare('UPDATE generation_runs SET binding_json=? WHERE run_id=?').run(encode(frozen), runId);
            return this.get(runId);
        });
    }
    findInvocation(runId: string, nonce: string, requestHash: string): GenerationExecutionReceipt | null {
        const row = this.db().prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(runId, nonce) as {
            attempt_id: string;
            usage_receipt_json: string;
        } | undefined;
        if (!row)
            return null;
        if (JSON.parse(row.usage_receipt_json).requestHash !== requestHash)
            fail('GENERATION_INVOCATION_CONFLICT');
        return this.receipt(row.attempt_id);
    }
    reserve(runId: string, nonce: string, requestHash: string, reservedTokens: number, requestedOutputTokens: number, usagePolicy?: ProviderUsagePolicy, purpose?: string, replayTask?: import('../../src/services/generation/generation-harness').GenerationTask, budgetDecision?: import('../../src/services/generation/task-budget-planner').TaskBudgetDecision, reconciliationInjected?: boolean): GenerationExecutionReceipt {
        return this.transaction(() => {
            this.assertPlotOutlineWritable(runId);
            const prior = this.findInvocation(runId, nonce, requestHash);
            if (prior)
                return prior;
            if (!nonce || !isContentHash(requestHash))
                fail('GENERATION_INVOCATION_INVALID');
            const run = this.get(runId), budget = this.budget(run.rootActionId);
            if (run.status !== 'running' || budget.blockedCode)
                fail('GENERATION_DISPATCH_BLOCKED');
            if (!sameProjectEpoch(run.binding, budget.root))
                fail('GENERATION_EPOCH_STALE');
            this.assertPlotOutlineRequest(runId, purpose, replayTask);
            const attempt: PhysicalAttempt = { attemptId: randomUUID(), reservationId: randomUUID(), rootActionId: run.rootActionId, status: 'reserved', reservedTokens, requestedOutputTokens };
            assertReservation(budget.root, budget.policy, budget.attempts, attempt, budget.activeElapsedMs);
            this.db().prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(attempt.attemptId, attempt.reservationId, runId, run.rootActionId, encode(attempt), encode({ requestHash, usagePolicy: usagePolicy ?? null }), nonce);
            const artifact: VisibleArtifact = { artifactId: randomUUID(), attemptId: attempt.attemptId, rootActionId: run.rootActionId, projectId: run.binding.projectId, epoch: run.binding.epoch, fingerprint: run.binding.fingerprint, revision: 0, text: '', textHash: textHash('') };
            this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode({ requestHash, usagePolicy: usagePolicy ?? null, ...(purpose ? { purpose } : {}), ...(replayTask ? { replayTask } : {}), ...(budgetDecision ? { budgetDecision } : {}), ...(reconciliationInjected ? { reconciliationInjected: true } : {}), artifactIdentity: { artifactId: artifact.artifactId, epoch: artifact.epoch, fingerprint: artifact.fingerprint } }), attempt.attemptId);
            this.db().prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(artifact.artifactId, attempt.attemptId, runId, encode(artifact), 0, 'partial');
            return this.receipt(attempt.attemptId);
        });
    }
    receipt(attemptId: string, budget?: GenerationBudgetReceipt): GenerationExecutionReceipt {
        const row = this.db().prepare(`${receiptSelect} WHERE t.attempt_id=?`).get(attemptId) as ReceiptRow | undefined;
        if (!row)
            fail('GENERATION_ATTEMPT_MISSING');
        const run = this.get(row.run_id), usage: ReceiptUsage = JSON.parse(row.usage_receipt_json);
        return this.hydrateReceipt(row, run, usage, budget?.root.rootActionId === run.rootActionId ? budget : this.budget(run.rootActionId));
    }
    private hydrateReceipt(row: ReceiptRow, run: DurableGenerationRun, usage: ReceiptUsage, budget: GenerationBudgetReceipt): GenerationExecutionReceipt {
        const visible: VisibleArtifact | null = row.artifact_json === null ? null : JSON.parse(row.artifact_json);
        const identity = usage.artifactIdentity;
        if (visible && (visible.attemptId !== row.attempt_id || visible.rootActionId !== run.rootActionId
            || !identity || visible.artifactId !== row.artifact_id || visible.artifactId !== identity.artifactId
            || visible.epoch !== identity.epoch || !isDeepStrictEqual(visible.fingerprint, identity.fingerprint)
            || !isDeepStrictEqual(visible.fingerprint, run.binding.fingerprint)
            || visible.projectId !== run.binding.projectId || visible.revision !== row.revision
            || textHash(visible.text) !== visible.textHash)) fail('ARTIFACT_INTEGRITY_FAILED');
        return { run, attempt: JSON.parse(row.attempt_json), artifact: visible,
            budget, result: usage.result ?? null,
            ...(usage.result?.diagnostics ? { diagnostics: usage.result.diagnostics } : {}),
            ...(usage.result?.failureCode ? { failureCode: usage.result.failureCode } : {}),
            ...(usage.budgetDecision ? { budgetDecision: usage.budgetDecision } : {}) };
    }
    private readState(run: DurableGenerationRun): GenerationRead {
        const budget = this.budget(run.rootActionId);
        const rows = this.db().prepare(`${receiptSelect} WHERE t.root_action_id=? ORDER BY t.rowid`).all(run.rootActionId) as ReceiptRow[];
        const attempts = new Map(rows.map(row => [row.attempt_id, row]));
        const runs = new Map([[run.runId, run]]);
        const receipts = new Map<string, ReturnType<GenerationRead['receipt']>>();
        return { run, budget, rows, artifacts: new Map(rows.flatMap(row => row.artifact_id === null ? [] : [[row.artifact_id, row] as const])),
            receipt: attemptId => {
                const prior = receipts.get(attemptId);
                if (prior) return prior;
                const row = attempts.get(attemptId);
                if (!row) fail('GENERATION_ATTEMPT_MISSING');
                let owner = runs.get(row.run_id);
                if (!owner) { owner = this.get(row.run_id); runs.set(owner.runId, owner); }
                const usage: ReceiptUsage = JSON.parse(row.usage_receipt_json);
                const value = { usage, receipt: this.hydrateReceipt(row, owner, usage, owner.rootActionId === budget.root.rootActionId ? budget : this.budget(owner.rootActionId)) };
                receipts.set(attemptId, value);
                return value;
            } };
    }
    readRunView(runId: string) {
        const read = this.readState(this.get(runId));
        const plotOutline = this.plotOutlineFrom(read);
        const candidates = new Set(read.rows.filter(row => row.artifact_run_id === runId && row.artifact_status !== 'discarded'
            && !this.isFrozen('generation_attempts', row.attempt_id)).map(row => row.artifact_id));
        const attempts = read.budget.attempts.map(attempt => {
            const value = read.receipt(attempt.attemptId);
            return { ...value, candidate: value.receipt.artifact !== null && candidates.has(value.receipt.artifact.artifactId) };
        });
        return { budget: read.budget, plotOutline, attempts };
    }
    markDispatched(attemptId: string): void {
        this.transaction(() => {
            const receipt = this.receipt(attemptId);
            if (receipt.budget.activeElapsedMs >= receipt.budget.policy.maxActiveElapsedMs || receipt.budget.root.status !== 'active' || receipt.budget.blockedCode)
                fail('GENERATION_DISPATCH_BLOCKED');
            assertAttemptTransition(receipt.attempt.status, 'dispatch-marked');
            const stored = JSON.parse(this.db().prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(attemptId) as string);
            this.assertPlotOutlineRequest(receipt.run.runId, stored.purpose, stored.replayTask, attemptId);
            receipt.attempt.status = 'dispatch-marked';
            this.db().prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(encode(receipt.attempt), attemptId);
            this.db().prepare('UPDATE generation_roots SET active_since_ms=COALESCE(active_since_ms,?) WHERE root_action_id=?').run(this.now(), receipt.run.rootActionId);
        });
    }
    readPlotOutline(runId: string, omitAttemptId?: string): PlotOutlineProgress | null {
        const run = this.get(runId);
        return plotOutlinePolicy(run.binding.sourceManifest) ? this.plotOutlineFrom(this.readState(run), omitAttemptId) : null;
    }
    private plotOutlineFrom(read: GenerationRead, omitAttemptId?: string, composition?: VisibleCompositionReceipt | null): PlotOutlineProgress | null {
        const { run } = read, policy = plotOutlinePolicy(run.binding.sourceManifest);
        if (!policy) return null;
        if (composition === undefined) composition = this.compositionFrom(read);
        const sourceExpected = plotOutlineExpected(run.binding.sourceManifest.plotOutlineSource);
        const confirmedPrefix = plotOutlineConfirmedPrefix(sourceExpected, policy.range);
        const acceptedCount = composition?.chapters?.length ?? 0;
        const chapter = policy.range.from + acceptedCount;
        const rows = this.db().prepare("SELECT attempt_id,json_extract(usage_receipt_json,'$.purpose') AS purpose FROM generation_attempts WHERE run_id=? AND json_extract(usage_receipt_json,'$.purpose') IN (?,?) ORDER BY rowid")
            .all(run.runId, ...(['normal', 'compact'] as const).map(part => plotOutlinePurpose(chapter, part))) as { attempt_id: string; purpose: string }[];
        const attempts = rows.filter(row => row.attempt_id !== omitAttemptId).map(row => {
            const { receipt } = read.receipt(row.attempt_id);
            return { purpose: row.purpose, status: receipt.attempt.status,
                finishReason: receipt.result?.finishReason ?? null,
                artifact: receipt.artifact && read.artifacts.get(receipt.artifact.artifactId)?.artifact_status !== 'discarded'
                    && !this.isFrozen('generation_attempts', row.attempt_id) ? receipt.artifact : null };
        });
        return { protocol: PLOT_OUTLINE_PROTOCOL, ...policy, sourceExpected, confirmedPrefix, composition,
            targetUnits: parsePlanningTargetUnits(Number((run.binding.sourceManifest.authorInputs as { id: string; text: string }[]).find(input => input.id === 'planning:target-units')?.text ?? DEFAULT_PLANNING_TARGET_UNITS)),
            cursor: derivePlotOutlineCursor(policy.range, acceptedCount, attempts) };
    }
    assertPlotOutlineRequest(runId: string, purpose: string | undefined, task?: import('../../src/services/generation/generation-harness').GenerationTask, omitAttemptId?: string): void {
        this.assertPlotOutlineWritable(runId);
        const outline = this.readPlotOutline(runId, omitAttemptId);
        if (!outline) return;
        const cursor = outline.cursor;
        if (cursor.kind !== 'request' || purpose !== plotOutlinePurpose(cursor.chapterNumber, cursor.attempt)
            || !task?.messages.some(message => message.role === 'user' && message.content.endsWith(plotOutlineRequestContract(outline, cursor.chapterNumber, cursor.attempt))))
            fail('GENERATION_DISPATCH_PLOT_OUTLINE_CURSOR');
    }
    private visibleComposition(read: GenerationRead, artifactIds: string[], algorithm: VisibleCompositionAlgorithm = VISIBLE_CONTINUATION_VERSION): VisibleCompositionReceipt {
        const { run } = read, outline = plotOutlinePolicy(run.binding.sourceManifest);
        if (outline ? algorithm !== PLOT_OUTLINE_PROTOCOL : algorithm !== 'visible-append-v1' && !isDraftVisibleTextVersion(algorithm)) fail('GENERATION_COMPOSITION_ALGORITHM_INVALID');
        if (!Array.isArray(artifactIds) || !artifactIds.length || artifactIds.length > (outline ? (outline.range.to - outline.range.from + 1) : 32)
            || artifactIds.some(id => typeof id !== 'string' || !id) || new Set(artifactIds).size !== artifactIds.length)
            fail('GENERATION_COMPOSITION_INVALID');
        let text = '', previousOrdinal = -1;
        const sources: VisibleCompositionReceipt['sources'] = [];
        const chapters: NonNullable<VisibleCompositionReceipt['chapters']> = [];
        for (const [index, artifactId] of artifactIds.entries()) {
            const row = read.artifacts.get(artifactId);
            if (!row || row.artifact_run_id !== run.runId || row.artifact_status === 'discarded' || row.ordinal <= previousOrdinal)
                fail('GENERATION_COMPOSITION_SOURCE_INVALID');
            const { receipt, usage } = read.receipt(row.attempt_id), artifact = receipt.artifact!;
            if (usage.purpose === DRAFT_RECONCILE_PURPOSE || usage.purpose === DRAFT_SHORT_OUTLINE_PURPOSE) fail('GENERATION_COMPOSITION_SOURCE_INVALID');
            if (!['settled', 'unknown'].includes(receipt.attempt.status) || !artifact.text.trim())
                fail('GENERATION_COMPOSITION_SOURCE_NOT_TERMINAL');
            if (!['stop', 'length'].includes(receipt.result?.finishReason ?? ''))
                fail('GENERATION_COMPOSITION_SOURCE_UNTRUSTED');
            if (outline) {
                const purpose = parsePlotOutlinePurpose(String(usage.purpose));
                const chapter = outline.range.from + chapters.length;
                if (!purpose || purpose.chapterNumber !== chapter || chapter > outline.range.to || receipt.result?.finishReason !== 'stop') fail('GENERATION_PLOT_OUTLINE_ENTRY_INVALID');
                if (!validPlotOutlineEntry(artifact.text, chapter)) fail('GENERATION_PLOT_OUTLINE_ENTRY_INVALID');
                chapters.push({ chapterNumber: chapter, artifactIds: [artifactId], textHash: textHash(artifact.text) });
                text = joinPlotOutlineEntries(text, artifact.text);
                previousOrdinal = row.ordinal;
                sources.push({ artifactId, revision: artifact.revision, textHash: artifact.textHash });
                continue;
            }
            const draftAlgorithm = isDraftVisibleTextVersion(algorithm) ? algorithm : undefined;
            const condense = draftAlgorithm !== undefined && usage.purpose === DRAFT_CONDENSE_PURPOSE;
            if (condense && (!sources.length || index !== artifactIds.length - 1)) fail('GENERATION_COMPOSITION_SOURCE_INVALID');
            const next = condense ? sanitizeDraftText(artifact.text, draftAlgorithm) : draftAlgorithm
                ? sources.length ? composeDraftVisibleContinuation(text, artifact.text, draftAlgorithm) : sanitizeDraftText(artifact.text, draftAlgorithm)
                : sources.length ? composeVisibleContinuation(text, artifact.text) : artifact.text.trim();
            if (!next.trim()) fail('GENERATION_COMPOSITION_NO_PROGRESS');
            if (condense) {
                const target = Number((run.binding.sourceManifest.authorInputs as { id: string; text: string }[] | undefined)
                    ?.find(item => item.id === 'draft:target-units')?.text);
                if (!Number.isSafeInteger(target) || target < 1) fail('GENERATION_COMPOSITION_SOURCE_INVALID');
                if (receipt.result?.finishReason !== 'stop' || countDraftUnits(next) >= countDraftUnits(text)
                    || countDraftUnits(text) <= draftTargetUnitRange(target).maximum) fail('GENERATION_COMPOSITION_NO_PROGRESS');
            } else {
                if (draftAlgorithm && sources.length && receipt.result?.finishReason === 'length'
                    && countDraftUnits(next) - countDraftUnits(text) < 300) fail('GENERATION_COMPOSITION_NO_PROGRESS');
                if (sources.length && (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0))
                    fail('GENERATION_COMPOSITION_NO_PROGRESS');
            }
            text = next; previousOrdinal = row.ordinal;
            sources.push({ artifactId, revision: artifact.revision, textHash: artifact.textHash });
        }
        return { algorithm, text, textHash: textHash(text), artifactIds: [...artifactIds], sources, ...(outline ? { chapters } : {}) };
    }
    listDirectoryProgress(): DirectoryGenerationProgress[] {
        const rows = this.db().prepare('SELECT run_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as { run_id: string; usage_receipt_json: string }[];
        return rows.flatMap(row => {
            const stored = JSON.parse(row.usage_receipt_json).directoryProgress as DirectoryGenerationProgress | undefined;
            if (!stored) return [];
            if (!completeHandle(stored.sourceHandle) || stored.sourceHandle.runId !== row.run_id
                || stored.sourceHandle.epoch !== JSON.parse(row.usage_receipt_json).artifactIdentity?.epoch || !stored.requestedRange || !stored.committedRange
                || ![stored.requestedRange.startChapter, stored.requestedRange.endChapter, stored.committedRange.startChapter, stored.committedRange.endChapter].every(value => Number.isSafeInteger(value) && value > 0)
                || stored.requestedRange.endChapter < stored.requestedRange.startChapter
                || stored.requestedRange.endChapter - stored.requestedRange.startChapter >= 10000
                || stored.committedRange.endChapter < stored.committedRange.startChapter) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
            const run = this.get(stored.sourceHandle.runId);
            const selected = run.binding.sourceManifest.selectedBlueprintChapterNumbers as number[] | undefined;
            if (!selected || Array.from({ length: stored.requestedRange.endChapter - stored.requestedRange.startChapter + 1 }, (_, index) => stored.requestedRange.startChapter + index).some(chapter => !selected.includes(chapter)))
                fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
            const committed = this.db().prepare('SELECT payload_hash,start_chapter,end_chapter FROM blueprint_commit_operations WHERE operation_id=?').get(stored.operationId) as { payload_hash: string; start_chapter: number; end_chapter: number } | undefined;
            if (!committed || committed.payload_hash !== stored.payloadHash || run.rootActionId !== stored.sourceHandle.rootActionId
                || run.binding.projectId !== stored.sourceHandle.projectId || committed.start_chapter !== stored.committedRange.startChapter
                || committed.end_chapter !== stored.committedRange.endChapter || stored.requestedRange.startChapter !== committed.start_chapter
                || stored.requestedRange.endChapter < committed.end_chapter
                || !isDeepStrictEqual(stored.remainingRange, committed.end_chapter < stored.requestedRange.endChapter
                    ? { startChapter: committed.end_chapter + 1, endChapter: stored.requestedRange.endChapter } : null)) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
            if (stored.continuationHandle) {
                if (!completeHandle(stored.continuationHandle)) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
                const child = this.get(stored.continuationHandle.runId);
                if (child.rootActionId !== run.rootActionId || child.binding.projectId !== run.binding.projectId
                    || stored.continuationHandle.rootActionId !== child.rootActionId || stored.continuationHandle.projectId !== child.binding.projectId
                    || child.runId === run.runId) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
                stored.continuationHandle = { ...stored.continuationHandle, epoch: child.binding.epoch };
            }
            return [stored];
        });
    }
    recordDirectoryProgress(progress: DirectoryGenerationProgress): void {
        if (!this.db().inTransaction) fail('GENERATION_DIRECTORY_TRANSACTION_REQUIRED');
        this.assertPlotOutlineWritable(progress.sourceHandle.runId);
        const existing = this.listDirectoryProgress().find(item => item.operationId === progress.operationId);
        if (existing) {
            if (!isDeepStrictEqual(existing, progress)) fail('GENERATION_DIRECTORY_PROGRESS_CONFLICT');
            return;
        }
        const run = this.get(progress.sourceHandle.runId);
        if (run.binding.sourceManifest.outputContract !== 'structured-data') fail('GENERATION_DIRECTORY_OUTPUT_INVALID');
        const row = this.db().prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(progress.sourceHandle.runId) as { attempt_id: string; usage_receipt_json: string } | undefined;
        if (!row || JSON.parse(row.usage_receipt_json).directoryProgress) fail('GENERATION_DIRECTORY_PROGRESS_CONFLICT');
        if (!['settled', 'unknown'].includes(this.receipt(row.attempt_id).attempt.status)) fail('GENERATION_DIRECTORY_ATTEMPT_NOT_TERMINAL');
        this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode({ ...JSON.parse(row.usage_receipt_json), directoryProgress: progress }), row.attempt_id);
        this.listDirectoryProgress();
    }
    activateRootForCommittedStage(rootId: string, project: ProjectEpoch): void {
        if (!this.db().inTransaction) fail('GENERATION_DIRECTORY_TRANSACTION_REQUIRED');
        if (this.authorEditedRoot(rootId)) fail('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED');
        const budget = this.budget(rootId);
        if (budget.root.projectId !== project.projectId || !['active', 'paused'].includes(budget.root.status) || budget.blockedCode
            || budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))) fail('GENERATION_DIRECTORY_CONTINUATION_BLOCKED');
        budget.root.epoch = project.epoch; budget.root.status = 'active';
        this.db().prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run(encode(budget.root), rootId);
    }
    bindDirectoryContinuation(operationId: string, handle: DirectoryGenerationProgress['sourceHandle']): void {
        this.assertPlotOutlineWritable(handle.runId);
        const rows = this.db().prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts').all() as { attempt_id: string; usage_receipt_json: string }[];
        const row = rows.find(row => JSON.parse(row.usage_receipt_json).directoryProgress?.operationId === operationId);
        if (!row || !this.db().inTransaction) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
        const receipt = JSON.parse(row.usage_receipt_json);
        if (receipt.directoryProgress.continuationHandle) fail('GENERATION_DIRECTORY_CONTINUATION_EXISTS');
        receipt.directoryProgress.continuationHandle = handle;
        this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode(receipt), row.attempt_id);
    }
    readVisibleComposition(runId: string): VisibleCompositionReceipt | null {
        return this.compositionFrom(this.readState(this.get(runId)));
    }
    private compositionFrom(read: GenerationRead): VisibleCompositionReceipt | null {
        const rows = this.db().prepare("SELECT json_quote(json_extract(usage_receipt_json,'$.visibleComposition')) AS composition_json FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC").iterate(read.run.runId) as Iterable<{ composition_json: string }>;
        for (const row of rows) {
            const stored = JSON.parse(row.composition_json) as Omit<VisibleCompositionReceipt, 'text'> | undefined;
            if (!stored) continue;
            const current = this.visibleComposition(read, stored.artifactIds, stored.algorithm);
            if (stored.algorithm !== current.algorithm || stored.textHash !== current.textHash || !isDeepStrictEqual(stored.sources, current.sources)
                || !isDeepStrictEqual(stored.chapters, current.chapters))
                fail('GENERATION_COMPOSITION_INTEGRITY_FAILED');
            return current;
        }
        return null;
    }
    composeVisible(runId: string, artifactIds: string[], expectedTextHash: string, algorithm: VisibleCompositionAlgorithm = VISIBLE_CONTINUATION_VERSION): VisibleCompositionReceipt {
        return this.transaction(() => {
            this.assertPlotOutlineWritable(runId);
            const run = this.get(runId);
            if (run.binding.sourceManifest.outputContract !== 'visible-text') fail('GENERATION_COMPOSITION_OUTPUT_INVALID');
            const read = this.readState(run);
            const next = this.visibleComposition(read, artifactIds, algorithm), previous = this.compositionFrom(read);
            if (previous && previous.algorithm !== algorithm) fail('GENERATION_COMPOSITION_ALGORITHM_CHANGED');
            if (next.textHash !== expectedTextHash) fail('GENERATION_COMPOSITION_HASH_MISMATCH');
            if (previous && previous.artifactIds.some((id, index) => next.artifactIds[index] !== id)) fail('GENERATION_COMPOSITION_REGRESSION');
            const outline = this.plotOutlineFrom(read, undefined, previous);
            if (outline && !isDeepStrictEqual(next.artifactIds, previous?.artifactIds)) {
                if (outline.cursor.kind !== 'accept'
                    || !isDeepStrictEqual(next.artifactIds.slice(previous?.artifactIds.length ?? 0), outline.cursor.artifactIds)) fail('GENERATION_PLOT_OUTLINE_ACCEPT_CONFLICT');
            }
            const row = this.db().prepare('SELECT t.attempt_id,t.usage_receipt_json FROM generation_attempts t JOIN generation_artifacts a ON a.attempt_id=t.attempt_id WHERE a.artifact_id=?').get(artifactIds.at(-1)) as { attempt_id: string; usage_receipt_json: string };
            const { text: visibleText, ...stored } = next;
            void visibleText;
            this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode({ ...JSON.parse(row.usage_receipt_json), visibleComposition: stored }), row.attempt_id);
            return next;
        });
    }
    settle(attemptId: string, usage: GenerationUsageReceipt | null, finishReason: string | null = null, failureCode?: string,
        diagnostics?: import('../../src/shared/generation-contract').GenerationTransportDiagnostics): GenerationExecutionReceipt {
        return this.transaction(() => {
            const receipt = this.receipt(attemptId);
            this.assertPlotOutlineWritable(receipt.run.runId);
            assertAttemptTransition(receipt.attempt.status, usage?.trusted ? 'settled' : 'unknown');
            receipt.attempt.status = usage?.trusted ? 'settled' : 'unknown';
            if (usage?.trusted)
                receipt.attempt.actualTokens = usage.actualTokens;
            const old = this.db().prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(attemptId) as string;
            this.db().prepare('UPDATE generation_attempts SET attempt_json=?,usage_receipt_json=? WHERE attempt_id=?').run(encode(receipt.attempt), encode({ ...JSON.parse(old), result: { usage, finishReason, ...(failureCode ? { failureCode } : {}), ...(diagnostics ? { diagnostics } : {}) } }), attemptId);
            // Old receipts without a policy retain their original hard-bound rule.
            // Estimated overruns remain actual root usage, never clipped or erased.
            if (JSON.parse(old).usagePolicy?.canBoundTotalLiability !== false
                && usage?.actualTokens !== undefined && usage.actualTokens > receipt.attempt.reservedTokens)
                this.block(receipt.run.rootActionId, 'USAGE_EXCEEDED_RESERVATION');
            this.stopClockIfIdle(receipt.run.rootActionId);
            return this.receipt(attemptId);
        });
    }
    private stopClockIfIdle(rootId: string): void {
        if (this.budget(rootId).attempts.some(a => a.status === 'dispatch-marked'))
            return;
        const elapsed = this.budget(rootId).activeElapsedMs;
        this.db().prepare('UPDATE generation_roots SET active_elapsed_ms=?,active_since_ms=NULL WHERE root_action_id=?').run(elapsed, rootId);
    }
    snapshot(attemptId: string, expectedRevision: number, text: string): VisibleArtifact {
        return this.transaction(() => {
            const current = this.receipt(attemptId), prior = current.artifact!;
            this.assertPlotOutlineWritable(current.run.runId);
            if (!sameProjectEpoch(prior, current.budget.root))
                fail('GENERATION_EPOCH_STALE');
            if (prior.revision === expectedRevision + 1 && prior.text === text)
                return prior;
            if (['settled', 'unknown', 'cancelled-before-dispatch'].includes(current.attempt.status))
                fail('ARTIFACT_ATTEMPT_TERMINAL');
            if (prior.revision !== expectedRevision || !text.startsWith(prior.text) || /<\/?think\b/iu.test(text))
                fail('ARTIFACT_SNAPSHOT_CONFLICT');
            const next = { ...prior, text, textHash: textHash(text), revision: expectedRevision + 1 };
            const result = this.db().prepare('UPDATE generation_artifacts SET artifact_json=?,revision=? WHERE attempt_id=? AND revision=?').run(encode(next), next.revision, attemptId, expectedRevision);
            if (result.changes !== 1)
                fail('ARTIFACT_SNAPSHOT_CONFLICT');
            return next;
        });
    }
    block(rootId: string, code: string): void {
        if (this.authorEditedRoot(rootId)) fail('GENERATION_PLOT_OUTLINE_AUTHOR_SAVED');
        this.db().prepare('UPDATE generation_roots SET blocked_code=? WHERE root_action_id=?').run(code, rootId);
    }
    pause(rootId: string, cancel = false): void {
        this.transaction(() => {
            if (this.authorEditedRoot(rootId)) return;
            const budget = this.budget(rootId);
            if (['cancelled', 'sealed'].includes(budget.root.status))
                return;
            budget.root.status = cancel ? 'cancelled' : 'paused';
            this.db().prepare('UPDATE generation_roots SET action_json=?,active_elapsed_ms=?,active_since_ms=NULL WHERE root_action_id=?').run(encode(budget.root), budget.activeElapsedMs, rootId);
            this.db().prepare('UPDATE generation_runs SET status=? WHERE root_action_id=?').run(cancel ? 'cancelled' : 'paused', rootId);
            for (const attempt of budget.attempts)
                if (attempt.status === 'reserved') {
                    attempt.status = 'cancelled-before-dispatch';
                    this.db().prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(encode(attempt), attempt.attemptId);
                }
        });
    }
    resume(runId: string, next: RunBinding): void {
        this.transaction(() => {
            this.assertPlotOutlineWritable(runId);
            const run = this.get(runId), budget = this.budget(run.rootActionId);
            binding(next);
            if (budget.attempts.some(a => a.status === 'dispatch-marked') || budget.root.status !== 'paused' || budget.blockedCode || next.projectId !== run.binding.projectId)
                fail('GENERATION_RESUME_REFUSED');
            budget.root.epoch = next.epoch;
            budget.root.status = 'active';
            this.db().prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run(encode(budget.root), run.rootActionId);
            this.db().prepare('UPDATE generation_runs SET binding_json=?,status=? WHERE run_id=?').run(encode(next), 'running', runId);
        });
    }
    recoverInterrupted(): void {
        this.transaction(() => {
            const roots = this.db().prepare('SELECT root_action_id FROM generation_roots').all() as {
                root_action_id: string;
            }[];
            for (const { root_action_id: id } of roots) {
                if (this.frozenRoot(id)) continue;
                for (const attempt of this.budget(id).attempts)
                    if (attempt.status === 'dispatch-marked') {
                        attempt.status = 'unknown';
                        this.db().prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(encode(attempt), attempt.attemptId);
                    }
                this.pause(id);
            }
        });
    }
    private frozenRoot(rootId: string): boolean {
        if (this.authorEditedRoot(rootId)) return true;
        if (this.isFrozen('generation_roots', rootId)) return true;
        const runIds = this.db().prepare('SELECT run_id FROM generation_runs WHERE root_action_id=?').all(rootId) as { run_id: string }[];
        if (runIds.some(row => this.isFrozen('generation_runs', row.run_id))) return true;
        const attemptIds = this.db().prepare('SELECT attempt_id FROM generation_attempts WHERE root_action_id=?').all(rootId) as { attempt_id: string }[];
        return attemptIds.some(row => this.isFrozen('generation_attempts', row.attempt_id));
    }
    listCandidates(runId?: string): VisibleArtifact[] {
        const rows = this.db().prepare("SELECT attempt_id FROM generation_artifacts WHERE status!='discarded' AND (? IS NULL OR run_id=?) ORDER BY rowid").all(runId ?? null, runId ?? null) as { attempt_id: string }[];
        const budget = runId ? this.budget(this.get(runId).rootActionId) : undefined;
        // Portable history keeps visible text but has no current execution receipt.
        return rows.filter(row => !this.isFrozen('generation_attempts', row.attempt_id))
            .map(row => this.receipt(row.attempt_id, budget).artifact!);
    }
    discardCandidate(artifactId: string): void {
        const runId = this.db().prepare('SELECT run_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(artifactId) as string | undefined;
        if (runId) this.assertPlotOutlineWritable(runId);
        this.db().prepare("UPDATE generation_artifacts SET status='discarded' WHERE artifact_id=?").run(artifactId);
    }
}
