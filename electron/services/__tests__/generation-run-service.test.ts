import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs';
import { GenerationRunRepository, textHash, type OpenGenerationRunRequest } from '../../repositories/generation-run-repository';
import { createGenerationRunService, settleProviderUsage, type ExecuteGenerationRequest, type GenerationProviderUsage } from '../generation-run-service';
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
const handles: import('better-sqlite3').Database[] = [];
afterEach(() => { for (const db of handles.splice(0))
    if (db.open)
        db.close(); vi.useRealTimers(); });
function fixture() {
    const db = new Database(':memory:');
    handles.push(db);
    db.pragma('foreign_keys=ON');
    db.exec(M01_GENERATION_SQL);
    let now = 1000;
    const repository = new GenerationRunRepository(() => db, () => now);
    const h = textHash('frozen'), fingerprint = { chapterBriefHash: h, authorGuidanceHash: h, dependencyHash: h, contextSnapshotHash: h, templateHash: h, skillSnapshotHash: h, modelLeaseRevision: h, policyHash: h, outputContractHash: h };
    const open: OpenGenerationRunRequest = { projectId: 'project', epoch: 'epoch', operation: 'write', uiActionNonce: 'click', frozenInputHash: h, fingerprint, contextSnapshotId: 'context', sourceManifest: { kind: 'synthetic-frozen-sources' }, sourceRefs: [], budget: { maxPhysicalRequests: 2, maxTokenLiability: 500, maxOutputPerRequest: 100, maxActiveElapsedMs: 10000 } };
    const policy = { estimatorVersion: 'fixture-v1', safetyMarginTokens: 10, reasoning: 'included-in-completion' as const, canBoundTotalLiability: true };
    const request = (runId: string, nonce = 'call'): ExecuteGenerationRequest => ({ runId, invocationNonce: nonce, requestHash: textHash(nonce), providerRequest: { prompt: 'author' }, reservedTokens: 200, requestedOutputTokens: 100, inputUpperBoundTokens: 90, reasoningUpperBoundTokens: 0, usagePolicy: policy });
    return { db, repository, open, policy, request, setNow: (value: number) => { now = value; } };
}
const usage: GenerationProviderUsage = { promptTokens: 50, completionTokens: 50, totalTokens: 100, reasoningTokens: 20, accounting: 'included-in-completion', totalIncludesReasoning: true, trusted: true };
describe('single durable generation owner', () => {
    it('mints stable nonce root/run across service restarts without expanding budget', () => { const f = fixture(), a = f.repository.open(f.open); expect(f.repository.open({ ...f.open, epoch: 'new' })).toEqual(a); expect(() => f.repository.open({ ...f.open, budget: { ...f.open.budget, maxPhysicalRequests: 99 } })).toThrow('GENERATION_NONCE_CONFLICT'); });
    it('checks reservation and marks durably before exactly one dispatch for duplicate invocation', async () => {
        const f = fixture();
        let runId = '';
        const dispatch = vi.fn(async () => { expect(f.repository.budget(f.repository.get(runId).rootActionId).attempts[0].status).toBe('dispatch-marked'); return { usage, finishReason: 'stop' }; });
        const service = createGenerationRunService({ repository: f.repository, dispatch });
        runId = service.open(f.open).runId;
        const [a, b] = await Promise.all([service.execute(f.request(runId)), service.execute(f.request(runId))]);
        expect(a.attempt.attemptId).toBe(b.attempt.attemptId);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(a.attempt.actualTokens).toBe(100);
        await expect(service.execute({ ...f.request(runId), requestHash: textHash('changed'), providerRequest: { prompt: 'changed' } })).rejects.toThrow('GENERATION_INVOCATION_CONFLICT');
    });
    it('atomically shares parent budget across child calls', () => { const f = fixture(), root = f.repository.open(f.open), child = f.repository.open({ ...f.open, uiActionNonce: 'child', parentRootActionId: root.rootActionId }); expect(child.rootActionId).toBe(root.rootActionId); f.repository.reserve(root.runId, 'a', textHash('a'), 200, 100); f.repository.reserve(child.runId, 'b', textHash('b'), 200, 100); expect(() => f.repository.reserve(child.runId, 'c', textHash('c'), 200, 100)).toThrow('ROOT_BUDGET_EXHAUSTED'); });
    it('keeps unknown liability and does not replay the nonce after restart', async () => { const f = fixture(), run = f.repository.open(f.open), request = f.request(run.runId); const hash = request.requestHash; const a = f.repository.reserve(run.runId, 'call', hash, 200, 100); f.repository.markDispatched(a.attempt.attemptId); f.setNow(4000); f.repository.recoverInterrupted(); const dispatch = vi.fn(); const service = createGenerationRunService({ repository: f.repository, dispatch }); const result = await service.execute(request); expect(result.attempt.status).toBe('unknown'); expect(result.budget.activeElapsedMs).toBe(3000); expect(dispatch).not.toHaveBeenCalled(); });
    it('releases only undispatched cancellation and uses one cancelled root terminal', () => { const f = fixture(), run = f.repository.open(f.open); const a = f.repository.reserve(run.runId, 'a', textHash('a'), 200, 100); f.repository.pause(run.rootActionId, true); f.repository.pause(run.rootActionId, true); expect(f.repository.receipt(a.attempt.attemptId).attempt.status).toBe('cancelled-before-dispatch'); expect(() => f.repository.markDispatched(a.attempt.attemptId)).toThrow('GENERATION_DISPATCH_BLOCKED'); });
    it('CAS snapshots reject rollback and acknowledge idempotent same revision', () => { const f = fixture(), run = f.repository.open(f.open), a = f.repository.reserve(run.runId, 'a', textHash('a'), 200, 100); const saved = f.repository.snapshot(a.attempt.attemptId, 0, '原文'); expect(f.repository.snapshot(a.attempt.attemptId, 0, '原文')).toEqual(saved); expect(() => f.repository.snapshot(a.attempt.attemptId, 0, '改变')).toThrow(); expect(() => f.repository.snapshot(a.attempt.attemptId, 1, '原')).toThrow(); expect(f.repository.receipt(a.attempt.attemptId).artifact?.text).toBe('原文'); });
    it('normalizes cumulative and trustworthy event IDs without string guessing', async () => { const f = fixture(), dispatch = vi.fn(async (_request, options) => { options.onVisible({ kind: 'delta', text: '甲', eventId: '1' }); options.onVisible({ kind: 'delta', text: '甲', eventId: '1' }); options.onVisible({ kind: 'delta', text: '甲' }); options.onVisible({ kind: 'cumulative', text: '甲甲乙' }); return { usage, finishReason: 'stop' }; }); const service = createGenerationRunService({ repository: f.repository, dispatch }), run = service.open(f.open), receipt = await service.execute(f.request(run.runId)); expect(receipt.artifact?.text).toBe('甲甲乙'); expect(receipt.artifact?.revision).toBe(1); });
    it('flushes a large prefix before completion and keeps attempts separate', async () => { const f = fixture(); const dispatch = vi.fn(async (_request, options) => { options.onVisible({ kind: 'delta', text: 'a'.repeat(4096) }); expect(f.repository.listCandidates().at(-1)?.revision).toBe(1); options.onVisible({ kind: 'delta', text: 'tail' }); return { usage, finishReason: 'stop' }; }); const service = createGenerationRunService({ repository: f.repository, dispatch }), run = service.open(f.open); const a = await service.execute(f.request(run.runId)), b = await service.execute(f.request(run.runId, 'second')); expect(a.artifact?.revision).toBe(2); expect(b.artifact?.artifactId).not.toBe(a.artifact?.artifactId); expect(b.artifact?.text.length).toBe(4100); });
    it('does not persist thinking and preserves prior visible content as unknown', async () => { const f = fixture(); const service = createGenerationRunService({ repository: f.repository, dispatch: async (_r, o) => { o.onVisible({ kind: 'delta', text: 'visible' }); o.onVisible({ kind: 'delta', text: '<think>hidden</think>' }); return { usage, finishReason: 'stop' }; } }), run = service.open(f.open), result = await service.execute(f.request(run.runId)); expect(result.artifact?.text).toBe('visible'); expect(result.attempt.status).toBe('unknown'); });
    it('disk failure retains a copyable tail and prohibits subsequent dispatch', async () => { const f = fixture(); vi.spyOn(f.repository, 'snapshot').mockImplementation(() => { throw new Error('disk full'); }); const dispatch = vi.fn(async (_r, o) => { o.onVisible({ kind: 'delta', text: 'unsaved' }); return { usage, finishReason: 'stop' }; }); const service = createGenerationRunService({ repository: f.repository, dispatch }), run = service.open(f.open), result = await service.execute(f.request(run.runId)); expect(result.unsavedTail).toBe('unsaved'); expect(result.failureCode).toBe('GENERATION_STORAGE_FAILED'); await expect(service.execute(f.request(run.runId, 'again'))).rejects.toThrow('GENERATION_STORAGE_FAILED'); expect(dispatch).toHaveBeenCalledTimes(1); });
    it('defaults recovery authorization to rejection and pauses elapsed time', async () => { const f = fixture(), service = createGenerationRunService({ repository: f.repository, dispatch: vi.fn() }), run = service.open(f.open); const a = f.repository.reserve(run.runId, 'a', textHash('a'), 200, 100); f.repository.markDispatched(a.attempt.attemptId); f.setNow(2000); service.pause(run.rootActionId); f.setNow(9000); expect(f.repository.budget(run.rootActionId).activeElapsedMs).toBe(1000); await expect(service.resume(run.runId, { ...run.binding, epoch: 'next' })).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED'); });
    it.each([null, { ...usage, promptTokens: -1 }, { ...usage, totalTokens: 101 }, { ...usage, trusted: false }])('keeps reservation for absent or untrusted usage', value => { const f = fixture(); expect(settleProviderUsage(value, f.policy).trusted).toBe(false); });
    it('handles separately billed reasoning already in total without double counting', () => { const f = fixture(); expect(settleProviderUsage({ ...usage, completionTokens: 30, reasoningTokens: 20, totalTokens: 100, accounting: 'separately-billed' }, { ...f.policy, reasoning: 'separately-billed' }).actualTokens).toBe(100); });
    it('records overestimate usage in full and blocks further requests', async () => { const f = fixture(), service = createGenerationRunService({ repository: f.repository, dispatch: async () => ({ usage: { ...usage, promptTokens: 300, totalTokens: 350 }, finishReason: 'stop' }) }), run = service.open(f.open), a = await service.execute(f.request(run.runId)); expect(a.attempt.actualTokens).toBe(350); expect(a.budget.blockedCode).toBe('USAGE_EXCEEDED_RESERVATION'); await expect(service.execute(f.request(run.runId, 'again'))).rejects.toThrow('GENERATION_DISPATCH_BLOCKED'); });
});
it('persists a terminal receipt while providerRequest remains opaque and is never serialized', async () => {
    const f = fixture(), service = createGenerationRunService({ repository: f.repository, dispatch: async () => ({ usage, finishReason: 'length' }) }), run = service.open(f.open);
    const opaque = { toJSON() { throw new Error('must not serialize provider request'); } };
    const result = await service.execute({ ...f.request(run.runId), providerRequest: opaque });
    expect(result.result).toMatchObject({ finishReason: 'length', usage: { actualTokens: 100 } });
    expect((await service.execute({ ...f.request(run.runId), providerRequest: { differentLease: 'not part of semantic nonce' } })).attempt.attemptId).toBe(result.attempt.attemptId);
});
it('never dispatches after a failed dispatch mark and prohibits later calls', async () => {
    const f = fixture(), dispatch = vi.fn();
    vi.spyOn(f.repository, 'markDispatched').mockImplementation(() => { throw new Error('disk full'); });
    const service = createGenerationRunService({ repository: f.repository, dispatch }), run = service.open(f.open);
    const result = await service.execute(f.request(run.runId));
    expect(result.failureCode).toBe('GENERATION_STORAGE_FAILED');
    expect(dispatch).not.toHaveBeenCalled();
    await expect(service.execute(f.request(run.runId, 'again'))).rejects.toThrow('GENERATION_STORAGE_FAILED');
});
it('flushes by the one-second timer and reports only committed revisions', async () => {
    vi.useFakeTimers();
    const f = fixture(), updates: unknown[] = [];
    let finish!: (v: {
        usage: typeof usage;
        finishReason: string;
    }) => void;
    const service = createGenerationRunService({ repository: f.repository, onSnapshot: event => updates.push(event), dispatch: async (_r, o) => { o.onVisible({ kind: 'delta', text: 'prefix' }); return new Promise(resolve => { finish = resolve; }); } }), run = service.open(f.open);
    const operation = service.execute(f.request(run.runId));
    expect(f.repository.listCandidates()[0].revision).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.repository.listCandidates()[0].revision).toBe(1);
    expect(updates).toContainEqual(expect.objectContaining({ durableRevision: 1, durableText: 'prefix' }));
    finish({ usage, finishReason: 'stop' });
    await operation;
});
it('refuses source/fingerprint change even if an injected validator mistakenly returns true', async () => {
    const f = fixture(), service = createGenerationRunService({ repository: f.repository, dispatch: vi.fn(), validateRecovery: async () => true }), run = service.open(f.open);
    service.pause(run.rootActionId);
    await expect(service.resume(run.runId, { ...run.binding, epoch: 'new', fingerprint: { ...run.binding.fingerprint, templateHash: textHash('changed') } })).rejects.toThrow('GENERATION_RECOVERY_UNAUTHORIZED');
    expect((await service.resume(run.runId, { ...run.binding, epoch: 'new' })).binding.epoch).toBe('new');
});
it('repeated child action creation returns the same persisted run', () => {
    const f = fixture(), root = f.repository.open(f.open), request = { ...f.open, uiActionNonce: 'child', parentRootActionId: root.rootActionId };
    expect(f.repository.open(request)).toEqual(f.repository.open(request));
});
it('cancels an in-flight dispatch once, retaining conservative liability and the saved prefix', async () => {
    const f = fixture();
    let reject!: (e: Error) => void;
    const service = createGenerationRunService({ repository: f.repository, dispatch: async (_r, o) => { o.onVisible({ kind: 'delta', text: 'cancelled partial' }); return new Promise((_resolve, r) => { reject = r; o.signal.addEventListener('abort', () => r(new Error('abort')), { once: true }); }); } }), run = service.open(f.open);
    const operation = service.execute(f.request(run.runId));
    service.cancel(run.rootActionId);
    service.cancel(run.rootActionId);
    const result = await operation;
    expect(result.attempt.status).toBe('unknown');
    expect(result.attempt.reservedTokens).toBe(200);
    expect(result.artifact?.text).toBe('cancelled partial');
    expect(reject).toBeDefined();
});
it('keeps split reasoning tags out of visible artifacts', async () => {
    const f = fixture(), service = createGenerationRunService({ repository: f.repository, dispatch: async (_r, o) => { o.onVisible({ kind: 'delta', text: '<thi' }); o.onVisible({ kind: 'delta', text: 'nk>hidden reasoning' }); return { usage, finishReason: 'stop' }; } }), run = service.open(f.open), result = await service.execute(f.request(run.runId));
    expect(result.artifact?.text).not.toContain('hidden reasoning');
    expect(result.attempt.status).toBe('unknown');
});
it('reopens a real SQLite file and retains nonce, unknown liability, elapsed time and maximum saved prefix', () => {
    const f = fixture(), base = path.resolve('.runtime/.cache/novel-quality-modernization/s05-ledger');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'restart-')), file = path.join(root, 'ledger.db');
    let db = new Database(file);
    try {
        db.exec(M01_GENERATION_SQL);
        let repository = new GenerationRunRepository(() => db, () => 1000);
        const run = repository.open(f.open), request = f.request(run.runId), a = repository.reserve(run.runId, request.invocationNonce, request.requestHash, 200, 100);
        repository.markDispatched(a.attempt.attemptId);
        repository.snapshot(a.attempt.attemptId, 0, '保存原文');
        db.close();
        db = new Database(file);
        repository = new GenerationRunRepository(() => db, () => 5000);
        repository.recoverInterrupted();
        expect(repository.open(f.open).runId).toBe(run.runId);
        const receipt = repository.findInvocation(run.runId, request.invocationNonce, request.requestHash)!;
        expect(receipt.attempt.status).toBe('unknown');
        expect(receipt.attempt.reservedTokens).toBe(200);
        expect(receipt.budget.activeElapsedMs).toBe(4000);
        expect(receipt.artifact).toMatchObject({ revision: 1, text: '保存原文' });
    }
    finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
it('rejects late provider events and terminal snapshot mutation', async () => {
    const f = fixture();
    let late!: Parameters<Parameters<typeof createGenerationRunService>[0]['dispatch']>[1]['onVisible'];
    const service = createGenerationRunService({ repository: f.repository, dispatch: async (_r, o) => { late = o.onVisible; o.onVisible({ kind: 'delta', text: 'final' }); return { usage, finishReason: 'stop' }; } }), run = service.open(f.open), receipt = await service.execute(f.request(run.runId));
    late({ kind: 'delta', text: 'late'.repeat(2000) });
    expect(f.repository.receipt(receipt.attempt.attemptId).artifact?.text).toBe('final');
    expect(() => f.repository.snapshot(receipt.attempt.attemptId, 1, 'final injected')).toThrow('ARTIFACT_ATTEMPT_TERMINAL');
});
it('a failed reservation transaction cannot leave an artifact without its ledger row', () => {
    const f = fixture(), run = f.repository.open(f.open);
    f.db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON generation_artifacts BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END");
    expect(() => f.repository.reserve(run.runId, 'nonce', textHash('x'), 200, 100)).toThrow('fixture disk failure');
    expect(f.repository.budget(run.rootActionId).attempts).toHaveLength(0);
    expect(f.repository.listCandidates()).toHaveLength(0);
});

it('times out an uncooperative provider and ignores its late success', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: (value: { usage: typeof usage; finishReason: string }) => void;
    const service = createGenerationRunService({ repository: f.repository, dispatch: async () => new Promise(resolve => { finish = resolve; }) });
    const run = service.open(f.open);
    const operation = service.execute(f.request(run.runId));
    f.setNow(11000);
    await vi.advanceTimersByTimeAsync(10000);
    const result = await operation;
    expect(result.failureCode).toBe('ROOT_BUDGET_EXHAUSTED');
    expect(result.attempt.status).toBe('unknown');
    finish({ usage, finishReason: 'stop' });
    await Promise.resolve();
    expect(f.repository.receipt(result.attempt.attemptId).attempt.status).toBe('unknown');
});
it('never redirects an old repository into a newly active project database', () => {
    const f = fixture(), other = new Database(':memory:'); handles.push(other); other.exec(M01_GENERATION_SQL);
    let active = f.db;
    const repository = new GenerationRunRepository(() => active);
    const run = repository.open(f.open);
    active = other;
    f.db.close();
    expect(() => repository.reserve(run.runId, 'old-call', textHash('old'), 200, 100)).toThrow('GENERATION_DATABASE_NOT_READY');
    expect(other.prepare('SELECT COUNT(*) FROM generation_roots').pluck().get()).toBe(0);
});
it('cancelled roots cannot become successful when an uncooperative provider resolves later', async () => {
    const f=fixture();let finish!:(value:{usage:typeof usage;finishReason:string})=>void;
    const service=createGenerationRunService({repository:f.repository,dispatch:async()=>new Promise(resolve=>{finish=resolve})}),run=service.open(f.open);
    const pending=service.execute(f.request(run.runId));service.cancel(run.rootActionId);
    const receipt=await pending;expect(receipt.failureCode).toBe('GENERATION_CANCELLED');expect(receipt.attempt.status).toBe('unknown');
    finish({usage,finishReason:'stop'});await Promise.resolve();expect(f.repository.receipt(receipt.attempt.attemptId).attempt.status).toBe('unknown');
});
it('rejects corrupted saved text instead of confirming its old digest',()=>{
    const f=fixture(),run=f.repository.open(f.open),receipt=f.repository.reserve(run.runId,'a',textHash('a'),200,100);
    const artifact={...receipt.artifact!,text:'tampered'};
    f.db.prepare('UPDATE generation_artifacts SET artifact_json=? WHERE artifact_id=?').run(JSON.stringify(artifact),artifact.artifactId);
    expect(()=>f.repository.receipt(receipt.attempt.attemptId)).toThrow('ARTIFACT_INTEGRITY_FAILED');
});
it.each(['artifactId','epoch','fingerprint'])('rejects altered saved artifact identity %s',field=>{
 const f=fixture(),run=f.repository.open(f.open),receipt=f.repository.reserve(run.runId,'a',textHash('a'),200,100);
 const artifact={...receipt.artifact!};if(field==='fingerprint')artifact.fingerprint={...artifact.fingerprint,authorGuidanceHash:textHash('wrong')};else artifact[field as 'artifactId'|'epoch']='wrong';
 f.db.prepare('UPDATE generation_artifacts SET artifact_json=? WHERE artifact_id=?').run(JSON.stringify(artifact),receipt.artifact!.artifactId);
 expect(()=>f.repository.receipt(receipt.attempt.attemptId)).toThrow('ARTIFACT_INTEGRITY_FAILED');expect(()=>f.repository.listCandidates()).toThrow('ARTIFACT_INTEGRITY_FAILED');
});
it('retains the immutable old artifact epoch after authorized resume in a new epoch',async()=>{
 const f=fixture(),service=createGenerationRunService({repository:f.repository,dispatch:async()=>({usage,finishReason:'stop'}),validateRecovery:async()=>true}),run=service.open(f.open),receipt=await service.execute(f.request(run.runId));
 service.pause(run.rootActionId);await service.resume(run.runId,{...run.binding,epoch:'new-epoch'});
 expect(f.repository.receipt(receipt.attempt.attemptId).artifact?.epoch).toBe('epoch');
});
it('synchronously saves the visible prefix before the project DB closes', async () => {
    const f=fixture(),base=path.resolve('.runtime/.cache/novel-quality-modernization/s05-ledger');fs.mkdirSync(base,{recursive:true});
    const root=fs.mkdtempSync(path.join(base,'close-')),file=path.join(root,'ledger.db');let db=new Database(file);
    try {
        db.exec(M01_GENERATION_SQL);const repository=new GenerationRunRepository(()=>db);
        const service=createGenerationRunService({repository,dispatch:async(_r,o)=>{o.onVisible({kind:'delta',text:'visible unsaved prefix'});return new Promise(()=>{})}}),run=service.open(f.open);
        const operation=service.execute(f.request(run.runId));service.suspendForProjectClose();db.close();
        const result=await operation;expect(result.failureCode).toBe('GENERATION_PROJECT_CLOSED');expect(result.artifact?.text).toBe('visible unsaved prefix');
        db=new Database(file);const reopened=new GenerationRunRepository(()=>db);expect(reopened.receipt(result.attempt.attemptId)).toMatchObject({attempt:{status:'unknown'},artifact:{revision:1,text:'visible unsaved prefix'}});
    } finally {if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true})}
});
it('refuses project close until an explicitly discarded unsaved tail is acknowledged', async () => {
    const f=fixture();let chunks!:(event:{kind:'delta';text:string})=>void;
    const service=createGenerationRunService({repository:f.repository,dispatch:async(_r,o)=>{chunks=o.onVisible;return new Promise(()=>{})}}),run=service.open(f.open);
    const pending=service.execute(f.request(run.runId));chunks({kind:'delta',text:'saved'.repeat(1024)});
    const durable=f.repository.listCandidates()[0];expect(durable.revision).toBe(1);
    vi.spyOn(f.repository,'snapshot').mockImplementation(()=>{throw new Error('disk full')});
    chunks({kind:'delta',text:'未保存尾部\r\n原字节'});
    expect(()=>service.suspendForProjectClose()).toThrow('GENERATION_UNSAVED_TAIL_PRESENT');
    expect(f.db.open).toBe(true);
    const tails=service.readUnsavedTails();expect(tails).toEqual([{attemptId:durable.attemptId,artifactId:durable.artifactId,durableRevision:1,text:'未保存尾部\r\n原字节',failureCode:'GENERATION_STORAGE_FAILED'}]);
    await pending;expect(service.readUnsavedTails()).toEqual(tails);
    expect(()=>service.suspendForProjectClose()).toThrow('GENERATION_UNSAVED_TAIL_PRESENT');
    service.discardCandidate(durable.artifactId);expect(service.readUnsavedTails()).toEqual([]);expect(()=>service.suspendForProjectClose()).not.toThrow();
});
it('never persists stop completion for a prefix whose terminal flush failed, including file reopen', async () => {
    const f=fixture(),base=path.resolve('.runtime/.cache/novel-quality-modernization/s05-ledger');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'disk-')),file=path.join(root,'ledger.db');let db=new Database(file);
    try {
        db.exec(M01_GENERATION_SQL);const repository=new GenerationRunRepository(()=>db);vi.spyOn(repository,'snapshot').mockImplementation(()=>{throw new Error('disk full')});
        const service=createGenerationRunService({repository,dispatch:async(_r,o)=>{o.onVisible({kind:'delta',text:'unsaved terminal text'});return {usage,finishReason:'stop'}}}),run=service.open(f.open),result=await service.execute(f.request(run.runId));
        expect(result.failureCode).toBe('GENERATION_STORAGE_FAILED');expect(service.readUnsavedTails()[0].text).toBe('unsaved terminal text');db.close();db=new Database(file);
        const reopened=new GenerationRunRepository(()=>db),receipt=reopened.receipt(result.attempt.attemptId);expect(receipt.result?.finishReason).toBe('error');expect(receipt.budget.blockedCode).toBe('GENERATION_STORAGE_FAILED');expect(receipt.artifact?.text).toBe('');
    } finally {if(db.open)db.close();fs.rmSync(root,{recursive:true,force:true})}
});