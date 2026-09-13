import { isDeepStrictEqual } from 'node:util';
import { GenerationRunRepository, type OpenGenerationRunRequest, type RunBinding, type GenerationExecutionReceipt, type GenerationUsageReceipt } from '../repositories/generation-run-repository';
import type { ProviderUsagePolicy } from '../../src/shared/generation-contract';
export type { OpenGenerationRunRequest, RunBinding, DurableGenerationRun, GenerationExecutionReceipt, GenerationBudgetReceipt } from '../repositories/generation-run-repository';
export interface VisibleGenerationEvent {
    kind: 'delta' | 'cumulative';
    text: string;
    eventId?: string;
}
export interface GenerationProviderUsage {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    reasoningTokens: number | null;
    accounting: 'included-in-completion' | 'separately-billed' | 'unknown';
    totalIncludesReasoning: boolean;
    /** Set only by the trusted provider adapter for a known protocol. */
    trusted: boolean;
}
export interface GenerationDispatchResult {
    usage: GenerationProviderUsage | null;
    finishReason: string | null;
}
export interface GenerationUnsavedTail {
    attemptId: string;
    artifactId: string;
    durableRevision: number;
    text: string;
    failureCode: 'GENERATION_STORAGE_FAILED';
}
/** Internal main-only request. The IPC controller supplies the frozen plan and lease, never renderer estimates. */
export interface ExecuteGenerationRequest {
    runId: string;
    invocationNonce: string;
    requestHash: string;
    providerRequest: unknown;
    reservedTokens: number;
    requestedOutputTokens: number;
    inputUpperBoundTokens: number;
    reasoningUpperBoundTokens: number;
    usagePolicy: ProviderUsagePolicy;
    purpose?: string;
}
export interface GenerationRunServiceDependencies {
    repository: GenerationRunRepository;
    dispatch: (request: unknown, options: {
        signal: AbortSignal;
        onVisible: (event: VisibleGenerationEvent) => void;
    }) => Promise<GenerationDispatchResult>;
    onSnapshot?: (event: {
        attemptId: string;
        visibleText: string;
        durableText: string;
        durableRevision: number;
        storageFailed: boolean;
    }) => void;
    validateRecovery?: (previous: RunBinding, next: RunBinding) => Promise<boolean>;
}
export function settleProviderUsage(usage: GenerationProviderUsage | null, policy: ProviderUsagePolicy): GenerationUsageReceipt {
    const conservative: GenerationUsageReceipt = { policy, trusted: false };
    if (!usage?.trusted || usage.accounting === 'unknown' || usage.accounting !== policy.reasoning)
        return conservative;
    const { promptTokens: p, completionTokens: c, reasoningTokens: r, totalTokens: t } = usage;
    if (p === null || c === null || !Number.isSafeInteger(p) || !Number.isSafeInteger(c) || p < 0 || c < 0
        || r !== null && (!Number.isSafeInteger(r) || r < 0) || t !== null && (!Number.isSafeInteger(t) || t < 0))
        return conservative;
    if (usage.accounting === 'included-in-completion' && r !== null && r > c)
        return conservative;
    if (usage.accounting === 'separately-billed' && r === null)
        return conservative;
    const actual = p + c + (usage.accounting === 'separately-billed' ? r! : 0);
    const expectedTotal = p + c + (usage.accounting === 'separately-billed' && usage.totalIncludesReasoning ? r! : 0);
    if (t !== null && t !== expectedTotal || !Number.isSafeInteger(actual))
        return conservative;
    return { policy, trusted: true, inputTokens: p, completionTokens: c, ...(r !== null ? { reasoningTokens: r } : {}), actualTokens: actual };
}
export function createGenerationRunService(deps: GenerationRunServiceDependencies) {
    const controllers = new Map<string, {
        controller: AbortController;
        rootId: string;
        flush: () => void;
        suspend: () => void;
    }>(), pending = new Map<string, Promise<GenerationExecutionReceipt>>();
    const failedRoots = new Set<string>();
    const unsavedTails = new Map<string, GenerationUnsavedTail>();
    const execute = async (request: ExecuteGenerationRequest): Promise<GenerationExecutionReceipt> => {
        const requestHash = request.requestHash;
        if (!/^[a-f0-9]{64}$/u.test(requestHash))
            throw new Error('GENERATION_REQUEST_HASH_INVALID');
        const key = JSON.stringify([request.runId, request.invocationNonce]);
        const existing = deps.repository.findInvocation(request.runId, request.invocationNonce, requestHash);
        if (existing)
            return pending.get(key) ?? existing;
        if (pending.has(key))
            return pending.get(key)!;
        const operation = (async () => {
            const run = deps.repository.get(request.runId);
            if (failedRoots.has(run.rootActionId))
                throw new Error('GENERATION_STORAGE_FAILED');
            const { usagePolicy: policy } = request;
            if (!policy.canBoundTotalLiability || !policy.estimatorVersion || !Number.isSafeInteger(policy.safetyMarginTokens) || policy.safetyMarginTokens < 0
                || ![request.inputUpperBoundTokens, request.reasoningUpperBoundTokens].every(v => Number.isSafeInteger(v) && v >= 0)
                || request.reservedTokens < request.inputUpperBoundTokens + request.requestedOutputTokens + request.reasoningUpperBoundTokens + policy.safetyMarginTokens)
                throw new Error('GENERATION_LIABILITY_UNBOUNDED');
            let receipt: GenerationExecutionReceipt;
            try {
                receipt = deps.repository.reserve(request.runId, request.invocationNonce, requestHash, request.reservedTokens, request.requestedOutputTokens, policy, request.purpose);
            }
            catch (error) {
                if (!/BUDGET|RESERVATION|EPOCH|DISPATCH|INVOCATION/.test(error instanceof Error ? error.message : '')) {
                    failedRoots.add(run.rootActionId);
                    try {
                        deps.repository.block(run.rootActionId, 'GENERATION_STORAGE_FAILED');
                    }
                    catch { /* The in-memory failure fence remains authoritative if storage is unavailable. */ }
                }
                throw error;
            }
            if (receipt.attempt.status !== 'reserved')
                return receipt;
            const attemptId = receipt.attempt.attemptId, controller = new AbortController();
            let text = receipt.artifact!.text, durable = text, revision = receipt.artifact!.revision, storageFailed = false, streamFailed = false, terminal = false, suspended = false;
            const events = new Map<string, string>();
            const notify = () => { try {
                deps.onSnapshot?.({ attemptId, visibleText: text, durableText: durable, durableRevision: revision, storageFailed });
            }
            catch { /* UI notification cannot alter durable accounting */ } };
            const flush = () => {
                if (storageFailed || text === durable)
                    return;
                try {
                    const artifact = deps.repository.snapshot(attemptId, revision, text);
                    revision = artifact.revision;
                    durable = artifact.text;
                }
                catch {
                    storageFailed = true;
                    unsavedTails.set(attemptId, Object.freeze({ attemptId, artifactId: receipt.artifact!.artifactId,
                        durableRevision: revision, text: text.slice(durable.length), failureCode: 'GENERATION_STORAGE_FAILED' }));
                    failedRoots.add(run.rootActionId);
                    controller.abort();
                    try {
                        deps.repository.block(run.rootActionId, 'GENERATION_STORAGE_FAILED');
                    }
                    catch { /* retain copyable tail in memory */ }
                }
                notify();
            };
            controllers.set(attemptId, { controller, rootId: run.rootActionId, flush,
                suspend: () => { receipt = deps.repository.receipt(attemptId); suspended = true; controller.abort(); } });
            let timer: ReturnType<typeof setInterval> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            let removeAbortListener = () => { };
            let timedOut = false;
            try {
                try {
                    deps.repository.markDispatched(attemptId);
                }
                catch (error) {
                    storageFailed = true;
                    failedRoots.add(run.rootActionId);
                    try {
                        deps.repository.block(run.rootActionId, 'GENERATION_STORAGE_FAILED');
                    }
                    catch { /* The in-memory failure fence remains authoritative if storage is unavailable. */ }
                    throw error;
                }
                timer = setInterval(flush, 1000);
                const remaining = Math.max(0, receipt.budget.policy.maxActiveElapsedMs - deps.repository.budget(run.rootActionId).activeElapsedMs);
                deadline = setTimeout(() => { timedOut = true; try {
                    deps.repository.block(run.rootActionId, 'ROOT_BUDGET_EXHAUSTED');
                }
                catch {
                    storageFailed = true;
                    failedRoots.add(run.rootActionId);
                } controller.abort(); }, remaining);
                const cancelled = new Promise<never>((_resolve, reject) => { const abort = () => reject(new Error('GENERATION_CANCELLED')); controller.signal.addEventListener('abort', abort, { once: true }); removeAbortListener = () => controller.signal.removeEventListener('abort', abort); });
                const provider = deps.dispatch(request.providerRequest, { signal: controller.signal, onVisible: event => {
                        if (terminal || storageFailed || controller.signal.aborted)
                            return;
                        if (event.eventId) {
                            const prior = events.get(event.eventId), current = JSON.stringify(event);
                            if (prior) {
                                if (prior !== current) {
                                    streamFailed = true;
                                    controller.abort();
                                }
                                return;
                            }
                            events.set(event.eventId, current);
                        }
                        if (/<\/?think\b/iu.test(event.text)) {
                            streamFailed = true;
                            controller.abort();
                            return;
                        }
                        const next = event.kind === 'cumulative' ? event.text : text + event.text;
                        if (!next.startsWith(text) || /<\/?think\b/iu.test(next)) {
                            streamFailed = true;
                            controller.abort();
                            return;
                        }
                        text = next;
                        notify();
                        if (Buffer.byteLength(text) - Buffer.byteLength(durable) >= 4096)
                            flush();
                    } });
                const result = await Promise.race([provider, cancelled]);
                if (controller.signal.aborted)
                    throw new Error('GENERATION_CANCELLED');
                flush();
                receipt = deps.repository.settle(attemptId, streamFailed ? null : settleProviderUsage(result.usage, policy), storageFailed ? 'error' : result.finishReason);
            }
            catch {
                flush();
                try {
                    if (suspended) return { ...receipt, ...(storageFailed ? { unsavedTail: text.slice(durable.length) } : {}), failureCode: 'GENERATION_PROJECT_CLOSED' };
                    const current = deps.repository.receipt(attemptId);
                    if (current.attempt.status === 'dispatch-marked')
                        receipt = deps.repository.settle(attemptId, null);
                    else
                        receipt = current;
                }
                catch {
                    storageFailed = true;
                    failedRoots.add(run.rootActionId);
                }
            }
            finally {
                terminal = true;
                if (timer)
                    clearInterval(timer);
                if (deadline)
                    clearTimeout(deadline);
                removeAbortListener();
                controllers.delete(attemptId);
            }
            if (storageFailed)
                return { ...receipt, unsavedTail: text.slice(durable.length), failureCode: 'GENERATION_STORAGE_FAILED' };
            const finalReceipt = deps.repository.receipt(attemptId);
            if (controller.signal.aborted)
                return { ...finalReceipt, failureCode: timedOut ? 'ROOT_BUDGET_EXHAUSTED' : 'GENERATION_CANCELLED' };
            return finalReceipt;
        })();
        pending.set(key, operation);
        try {
            return await operation;
        }
        finally {
            pending.delete(key);
        }
    };
    return {
        open: (request: OpenGenerationRunRequest) => deps.repository.open(request), execute,
        suspendForProjectClose: () => {
            // Flush synchronously while the captured DB is still open, then
            // persist unknown accounting before its owner closes the handle.
            for (const item of controllers.values()) item.flush();
            let failure: unknown;
            try { deps.repository.recoverInterrupted(); } catch (error) { failure = error; }
            for (const item of controllers.values()) {
                try { item.suspend(); } catch (error) { failure ??= error; item.controller.abort(); }
            }
            if (unsavedTails.size) throw new Error('GENERATION_UNSAVED_TAIL_PRESENT');
            if (failure) throw failure;
        },
        readUnsavedTails: (): readonly GenerationUnsavedTail[] => Object.freeze([...unsavedTails.values()]),
        get: (runId: string) => deps.repository.get(runId),
        readAttempt: (attemptId: string) => deps.repository.receipt(attemptId),
        listCandidates: () => deps.repository.listCandidates(),
        discardCandidate: (id: string) => {
            deps.repository.discardCandidate(id);
            for (const [attemptId, tail] of unsavedTails) if (tail.artifactId === id) unsavedTails.delete(attemptId);
        },
        pause: (rootId: string) => { deps.repository.pause(rootId); for (const item of controllers.values())
            if (item.rootId === rootId)
                item.controller.abort(); },
        cancel: (rootId: string) => { deps.repository.pause(rootId, true); for (const item of controllers.values())
            if (item.rootId === rootId)
                item.controller.abort(); },
        resume: async (runId: string, next: RunBinding) => { const old = deps.repository.get(runId); if (!isDeepStrictEqual(old.binding.fingerprint, next.fingerprint) || old.binding.contextSnapshotId !== next.contextSnapshotId || !isDeepStrictEqual(old.binding.sourceManifest, next.sourceManifest) || !deps.validateRecovery || !await deps.validateRecovery(old.binding, next))
            throw new Error('GENERATION_RECOVERY_UNAUTHORIZED'); deps.repository.resume(runId, next); return deps.repository.get(runId); },
        restart: (oldRootId: string, request: OpenGenerationRunRequest) => { deps.repository.pause(oldRootId, true); for (const item of controllers.values())
            if (item.rootId === oldRootId)
                item.controller.abort(); return deps.repository.open(request); },
        recoverInterrupted: () => deps.repository.recoverInterrupted(),
    };
}
