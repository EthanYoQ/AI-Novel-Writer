import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VisibleCompositionReceipt, VisibleCompositionAlgorithm, DirectoryGenerationProgress } from '../../src/shared/generation-owner-contract';
import { composeVisibleContinuation, VISIBLE_CONTINUATION_VERSION } from '../../src/shared/visible-continuation';
import { composeDraftVisibleContinuation, sanitizeDraftText } from '../../src/shared/draft-visible-text';
import { countDraftUnits } from '../../src/shared/draft-units';
import { getProjectDb } from '../database';
import { assertReservation, assertAttemptTransition, rootActionIdempotencyKey, type RootAction, type RootBudget, type PhysicalAttempt, type VisibleArtifact, type ProviderUsagePolicy } from '../../src/shared/generation-contract';
import { isContentHash, sameProjectEpoch, type FrozenInputFingerprint, type SourceRef, type ProjectEpoch } from '../../src/shared/source-ref';
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
}
export interface GenerationExecutionReceipt {
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
export const textHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (value: unknown): string => JSON.stringify(value);
function fail(code: string): never { throw new Error(code); }
function binding(request: RunBinding): RunBinding {
    if (!request.sourceManifest || typeof request.sourceManifest !== 'object' || Array.isArray(request.sourceManifest) || !Object.keys(request.sourceManifest).length || !request.projectId || !request.epoch || !request.contextSnapshotId || Object.keys(request.fingerprint).length !== 9
        || ['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash', 'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash'].some(key => !isContentHash(request.fingerprint[key as keyof FrozenInputFingerprint]))
        || request.sourceRefs.some(ref => !sameProjectEpoch(ref, request) || !ref.sourceId || !isContentHash(ref.contentHash) || !Number.isSafeInteger(ref.revision) || ref.revision < 0))
        fail('GENERATION_BINDING_INVALID');
    return JSON.parse(encode({ projectId: request.projectId, epoch: request.epoch, fingerprint: request.fingerprint, contextSnapshotId: request.contextSnapshotId, sourceManifest: request.sourceManifest, sourceRefs: request.sourceRefs }));
}
export class GenerationRunRepository {
    private readonly database: Database.Database | null;
    constructor(getDb: () => Database.Database | null = getProjectDb, private readonly now: () => number = Date.now) {
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
        return { runId: row.run_id, rootActionId: row.root_action_id, binding: JSON.parse(row.binding_json), status: row.status };
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
                const prior = this.get(existing.run_id);
                if (!isDeepStrictEqual(prior.binding.sourceManifest, frozen.sourceManifest) || !isDeepStrictEqual(prior.binding.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; }), frozen.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; })) || encode(prior.binding.fingerprint) !== encode(frozen.fingerprint) || prior.binding.contextSnapshotId !== frozen.contextSnapshotId || encode(this.budget(prior.rootActionId).policy) !== encode(request.budget))
                    fail('GENERATION_NONCE_CONFLICT');
                return prior;
            }
            if (request.parentRootActionId) {
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
    reserve(runId: string, nonce: string, requestHash: string, reservedTokens: number, requestedOutputTokens: number, usagePolicy?: ProviderUsagePolicy, purpose?: string): GenerationExecutionReceipt {
        return this.transaction(() => {
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
            const attempt: PhysicalAttempt = { attemptId: randomUUID(), reservationId: randomUUID(), rootActionId: run.rootActionId, status: 'reserved', reservedTokens, requestedOutputTokens };
            assertReservation(budget.root, budget.policy, budget.attempts, attempt, budget.activeElapsedMs);
            this.db().prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(attempt.attemptId, attempt.reservationId, runId, run.rootActionId, encode(attempt), encode({ requestHash, usagePolicy: usagePolicy ?? null }), nonce);
            const artifact: VisibleArtifact = { artifactId: randomUUID(), attemptId: attempt.attemptId, rootActionId: run.rootActionId, projectId: run.binding.projectId, epoch: run.binding.epoch, fingerprint: run.binding.fingerprint, revision: 0, text: '', textHash: textHash('') };
            this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode({ requestHash, usagePolicy: usagePolicy ?? null, ...(purpose ? { purpose } : {}), artifactIdentity: { artifactId: artifact.artifactId, epoch: artifact.epoch, fingerprint: artifact.fingerprint } }), attempt.attemptId);
            this.db().prepare('INSERT INTO generation_artifacts VALUES(?,?,?,?,?,?)').run(artifact.artifactId, attempt.attemptId, runId, encode(artifact), 0, 'partial');
            return this.receipt(attempt.attemptId);
        });
    }
    receipt(attemptId: string): GenerationExecutionReceipt {
        const row = this.db().prepare('SELECT run_id,attempt_json,usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(attemptId) as {
            run_id: string;
            attempt_json: string;
            usage_receipt_json: string;
        } | undefined;
        if (!row)
            fail('GENERATION_ATTEMPT_MISSING');
        const run = this.get(row.run_id), artifact = this.db().prepare('SELECT artifact_id,artifact_json,revision FROM generation_artifacts WHERE attempt_id=?').get(attemptId) as {
            artifact_id: string;
            artifact_json: string;
            revision: number;
        } | undefined;
        const visible: VisibleArtifact | null = artifact ? JSON.parse(artifact.artifact_json) : null;
        const identity = JSON.parse(row.usage_receipt_json).artifactIdentity;
        if (visible && (visible.attemptId !== attemptId || visible.rootActionId !== run.rootActionId
            || !identity || visible.artifactId !== artifact!.artifact_id || visible.artifactId !== identity.artifactId
            || visible.epoch !== identity.epoch || !isDeepStrictEqual(visible.fingerprint, identity.fingerprint)
            || !isDeepStrictEqual(visible.fingerprint, run.binding.fingerprint)
            || visible.projectId !== run.binding.projectId || visible.revision !== artifact!.revision
            || textHash(visible.text) !== visible.textHash)) fail('ARTIFACT_INTEGRITY_FAILED');
        return { run, attempt: JSON.parse(row.attempt_json), artifact: visible, budget: this.budget(run.rootActionId), result: JSON.parse(row.usage_receipt_json).result ?? null };
    }
    markDispatched(attemptId: string): void {
        this.transaction(() => {
            const receipt = this.receipt(attemptId);
            if (receipt.budget.activeElapsedMs >= receipt.budget.policy.maxActiveElapsedMs || receipt.budget.root.status !== 'active' || receipt.budget.blockedCode)
                fail('GENERATION_DISPATCH_BLOCKED');
            assertAttemptTransition(receipt.attempt.status, 'dispatch-marked');
            receipt.attempt.status = 'dispatch-marked';
            this.db().prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(encode(receipt.attempt), attemptId);
            this.db().prepare('UPDATE generation_roots SET active_since_ms=COALESCE(active_since_ms,?) WHERE root_action_id=?').run(this.now(), receipt.run.rootActionId);
        });
    }
    private visibleComposition(runId: string, artifactIds: string[], algorithm: VisibleCompositionAlgorithm = VISIBLE_CONTINUATION_VERSION): VisibleCompositionReceipt {
        if (!['visible-append-v1', 'draft-visible-v1'].includes(algorithm)) fail('GENERATION_COMPOSITION_ALGORITHM_INVALID');
        if (!Array.isArray(artifactIds) || !artifactIds.length || artifactIds.length > 32
            || artifactIds.some(id => typeof id !== 'string' || !id) || new Set(artifactIds).size !== artifactIds.length)
            fail('GENERATION_COMPOSITION_INVALID');
        let text = '', previousOrdinal = -1;
        const sources: VisibleCompositionReceipt['sources'] = [];
        for (const artifactId of artifactIds) {
            const row = this.db().prepare('SELECT a.attempt_id,a.run_id,a.status,t.rowid AS ordinal FROM generation_artifacts a JOIN generation_attempts t ON t.attempt_id=a.attempt_id WHERE a.artifact_id=?').get(artifactId) as {
                attempt_id: string; run_id: string; status: string; ordinal: number;
            } | undefined;
            if (!row || row.run_id !== runId || row.status === 'discarded' || row.ordinal <= previousOrdinal)
                fail('GENERATION_COMPOSITION_SOURCE_INVALID');
            const receipt = this.receipt(row.attempt_id), artifact = receipt.artifact!;
            if (!['settled', 'unknown'].includes(receipt.attempt.status) || !artifact.text.trim())
                fail('GENERATION_COMPOSITION_SOURCE_NOT_TERMINAL');
            if (!['stop', 'length'].includes(receipt.result?.finishReason ?? ''))
                fail('GENERATION_COMPOSITION_SOURCE_UNTRUSTED');
            const next = algorithm === 'draft-visible-v1'
                ? sources.length ? composeDraftVisibleContinuation(text, artifact.text) : sanitizeDraftText(artifact.text)
                : sources.length ? composeVisibleContinuation(text, artifact.text) : artifact.text.trim();
            if (!next.trim()) fail('GENERATION_COMPOSITION_NO_PROGRESS');
            if (algorithm === 'draft-visible-v1' && sources.length && receipt.result?.finishReason === 'length'
                && countDraftUnits(next) - countDraftUnits(text) < 300) fail('GENERATION_COMPOSITION_NO_PROGRESS');
            if (sources.length && (next.match(/[\p{L}\p{N}]/gu)?.length ?? 0) <= (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0))
                fail('GENERATION_COMPOSITION_NO_PROGRESS');
            text = next; previousOrdinal = row.ordinal;
            sources.push({ artifactId, revision: artifact.revision, textHash: artifact.textHash });
        }
        return { algorithm, text, textHash: textHash(text), artifactIds: [...artifactIds], sources };
    }
    listDirectoryProgress(): DirectoryGenerationProgress[] {
        const rows = this.db().prepare('SELECT run_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all() as { run_id: string; usage_receipt_json: string }[];
        return rows.flatMap(row => {
            const stored = JSON.parse(row.usage_receipt_json).directoryProgress as DirectoryGenerationProgress | undefined;
            if (!stored) return [];
            const completeHandle = (handle: DirectoryGenerationProgress['sourceHandle']) => handle && typeof handle === 'object'
                && Object.keys(handle).length === 4 && ['projectId', 'epoch', 'rootActionId', 'runId'].every(key => typeof handle[key as keyof typeof handle] === 'string' && handle[key as keyof typeof handle].trim());
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
        const budget = this.budget(rootId);
        if (budget.root.projectId !== project.projectId || !['active', 'paused'].includes(budget.root.status) || budget.blockedCode
            || budget.attempts.some(attempt => ['reserved', 'dispatch-marked'].includes(attempt.status))) fail('GENERATION_DIRECTORY_CONTINUATION_BLOCKED');
        budget.root.epoch = project.epoch; budget.root.status = 'active';
        this.db().prepare('UPDATE generation_roots SET action_json=? WHERE root_action_id=?').run(encode(budget.root), rootId);
    }
    bindDirectoryContinuation(operationId: string, handle: DirectoryGenerationProgress['sourceHandle']): void {
        const rows = this.db().prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts').all() as { attempt_id: string; usage_receipt_json: string }[];
        const row = rows.find(row => JSON.parse(row.usage_receipt_json).directoryProgress?.operationId === operationId);
        if (!row || !this.db().inTransaction) fail('GENERATION_DIRECTORY_PROGRESS_INVALID');
        const receipt = JSON.parse(row.usage_receipt_json);
        if (receipt.directoryProgress.continuationHandle) fail('GENERATION_DIRECTORY_CONTINUATION_EXISTS');
        receipt.directoryProgress.continuationHandle = handle;
        this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode(receipt), row.attempt_id);
    }
    readVisibleComposition(runId: string): VisibleCompositionReceipt | null {
        const rows = this.db().prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC').all(runId) as { usage_receipt_json: string }[];
        for (const row of rows) {
            const stored = JSON.parse(row.usage_receipt_json).visibleComposition as Omit<VisibleCompositionReceipt, 'text'> | undefined;
            if (!stored) continue;
            const current = this.visibleComposition(runId, stored.artifactIds, stored.algorithm);
            if (stored.algorithm !== current.algorithm || stored.textHash !== current.textHash || !isDeepStrictEqual(stored.sources, current.sources))
                fail('GENERATION_COMPOSITION_INTEGRITY_FAILED');
            return current;
        }
        return null;
    }
    composeVisible(runId: string, artifactIds: string[], expectedTextHash: string, algorithm: VisibleCompositionAlgorithm = VISIBLE_CONTINUATION_VERSION): VisibleCompositionReceipt {
        return this.transaction(() => {
            const run = this.get(runId);
            if (run.binding.sourceManifest.outputContract !== 'visible-text') fail('GENERATION_COMPOSITION_OUTPUT_INVALID');
            const next = this.visibleComposition(runId, artifactIds, algorithm), previous = this.readVisibleComposition(runId);
            if (previous && previous.algorithm !== algorithm) fail('GENERATION_COMPOSITION_ALGORITHM_CHANGED');
            if (next.textHash !== expectedTextHash) fail('GENERATION_COMPOSITION_HASH_MISMATCH');
            if (previous && previous.artifactIds.some((id, index) => next.artifactIds[index] !== id)) fail('GENERATION_COMPOSITION_REGRESSION');
            const row = this.db().prepare('SELECT t.attempt_id,t.usage_receipt_json FROM generation_attempts t JOIN generation_artifacts a ON a.attempt_id=t.attempt_id WHERE a.artifact_id=?').get(artifactIds.at(-1)) as { attempt_id: string; usage_receipt_json: string };
            const { text: visibleText, ...stored } = next;
            void visibleText;
            this.db().prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(encode({ ...JSON.parse(row.usage_receipt_json), visibleComposition: stored }), row.attempt_id);
            return next;
        });
    }
    settle(attemptId: string, usage: GenerationUsageReceipt | null, finishReason: string | null = null): GenerationExecutionReceipt {
        return this.transaction(() => {
            const receipt = this.receipt(attemptId);
            assertAttemptTransition(receipt.attempt.status, usage?.trusted ? 'settled' : 'unknown');
            receipt.attempt.status = usage?.trusted ? 'settled' : 'unknown';
            if (usage?.trusted)
                receipt.attempt.actualTokens = usage.actualTokens;
            const old = this.db().prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(attemptId) as string;
            this.db().prepare('UPDATE generation_attempts SET attempt_json=?,usage_receipt_json=? WHERE attempt_id=?').run(encode(receipt.attempt), encode({ ...JSON.parse(old), result: { usage, finishReason } }), attemptId);
            if (usage?.actualTokens !== undefined && usage.actualTokens > receipt.attempt.reservedTokens)
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
    block(rootId: string, code: string): void { this.db().prepare('UPDATE generation_roots SET blocked_code=? WHERE root_action_id=?').run(code, rootId); }
    pause(rootId: string, cancel = false): void {
        this.transaction(() => {
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
                for (const attempt of this.budget(id).attempts)
                    if (attempt.status === 'dispatch-marked') {
                        attempt.status = 'unknown';
                        this.db().prepare('UPDATE generation_attempts SET attempt_json=? WHERE attempt_id=?').run(encode(attempt), attempt.attemptId);
                    }
                this.pause(id);
            }
        });
    }
    listCandidates(): VisibleArtifact[] {
        const rows = this.db().prepare("SELECT attempt_id FROM generation_artifacts WHERE status!='discarded' ORDER BY rowid").all() as { attempt_id: string }[];
        return rows.map(row => this.receipt(row.attempt_id).artifact!);
    }
    discardCandidate(artifactId: string): void { this.db().prepare("UPDATE generation_artifacts SET status='discarded' WHERE artifact_id=?").run(artifactId); }
}
