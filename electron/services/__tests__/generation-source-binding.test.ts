import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema';
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry';
import { migrateSchema } from '../../migrations/runner';
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter';
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding, compareGenerationSourceBindings, type GenerationSourceBindingInput } from '../generation-source-binding';
import { readPortableCurrentAuthority } from '../portable-current-authority';
import { createPortableTransferAuthority, mapPortableTransferAuthority, serializePortableTransferAuthority } from '../portable-transfer-authority';
import { SummaryRepository } from '../../repositories/summary-repository';
import { MATERIAL_DECISION_MAX_INPUT_UNITS, MATERIAL_DECISION_RECEIPT_VERSION, type MaterialDecisionReceipt } from '../../../src/shared/generation-owner-contract';
import { captureReviewRevisionContext } from '../review-revision-context';
import { textHash } from '../../repositories/generation-run-repository';
import type { PrepareReviewRevisionRequest } from '../../../src/shared/review-revision-generation';
import { FinalizationRepository } from '../../repositories/finalization-repository';
import { createProjectArchiveRoundtripFixture } from '../../../test/desktop/project-archive.fixture';
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0))
    cleanup(); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('graph candidates bind the actual blueprint and fixed main task across sessions without self-conflicting on confirmed plans', () => {
    const f = fixture();
    f.db.exec('UPDATE project_core SET total_chapters=10');
    const input: GenerationSourceBindingInput = { ...f.input, operation: 'narrative-thread-plan-candidate', chapterNumber: undefined,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['graph-plan'], skillStages: [], graphGenerationInput: { kind: 'plan', chapterNumber: 2 }, graphGenerationKey: 'graph-key' };
    const deps = { ...f.deps, readBuiltinPrompt: () => { throw new Error('MUST_NOT_READ_RENDERER_TEMPLATE'); } };
    const original = buildGenerationSourceBinding(deps, input).binding;
    f.db.exec("INSERT INTO narrative_thread_plans(title,type,target_start_chapter,target_end_chapter,author_intent) VALUES('确认候选','伏笔',2,4,'调查')");
    const resumed = rebuildGenerationSourceBinding(deps, original, 'next-epoch').binding;
    expect(compareGenerationSourceBindings(original, resumed)).toBe(true);
    expect(resumed.sourceManifest.graphGenerationOriginEpoch).toBe('e');
    expect(resumed.sourceManifest.graphGenerationContext).toEqual(original.sourceManifest.graphGenerationContext);
    f.db.exec("UPDATE blueprints SET title='作者改名' WHERE chapter_number=2");
    expect(compareGenerationSourceBindings(original, rebuildGenerationSourceBinding(deps, original, 'next-epoch').binding)).toBe(false);
});
it('graph admission rejects unrelated operation, template, and renderer context selectors', () => {
    const f = fixture();
    const input: GenerationSourceBindingInput = { ...f.input, operation: 'narrative-thread-plan-candidate', chapterNumber: undefined,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['graph-plan'], skillStages: [], graphGenerationInput: { kind: 'plan', chapterNumber: 2 }, graphGenerationKey: 'graph-key' };
    for (const delta of [{ operation: 'chapter' }, { promptKeys: ['draft'] }, { selectedDraftIds: [1] }, { chapterNumber: 2 }, { authorInputs: [{ id: 'forged', text: 'text' }] }]) {
        expect(() => buildGenerationSourceBinding(f.deps, { ...input, ...delta })).toThrow('GENERATION_GRAPH_SELECTION_INVALID');
    }
});
function put(root: string, file: string, text: string) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
function putPortableAuthority(f: ReturnType<typeof fixture>, snapshotGeneration = 'snapshot-1') {
    const authority = mapPortableTransferAuthority(createPortableTransferAuthority({ database: f.db,
        originProjectId: '11111111-1111-4111-8111-111111111111', snapshotGeneration, portableDatabaseSha256: 'a'.repeat(64) }), f.input.projectId);
    fs.writeFileSync(path.join(f.deps.projectStorageRoot, 'portable-transfer-authority.json'), serializePortableTransferAuthority(authority));
    fs.writeFileSync(path.join(f.deps.projectStorageRoot, 'portable-runtime-freeze.json'), JSON.stringify({ version: 1,
        originProjectId: authority.originProjectId, snapshotGeneration, nonReplayable: true, requiresRuntimeFreezeGuard: true,
        records: [], avatarReferenceProjections: [] }));
    return authority;
}
function useCanonicalStorage(f: ReturnType<typeof fixture>) {
    const canonical = path.join(f.root, '.ai-novel');
    fs.renameSync(f.deps.projectStorageRoot, canonical);
    f.deps.projectStorageRoot = canonical;
}
function fixture() {
    const base = path.resolve('.runtime/.cache/novel-quality-modernization/s05-sources');
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'binding-')), projectStorageRoot = path.join(root, 'project'), globalDataRoot = path.join(root, 'global');
    fs.mkdirSync(projectStorageRoot);
    fs.mkdirSync(globalDataRoot);
    const db = new Database(path.join(root, 'source.db'));
    initializeLegacyBaselineSchema(db);
    cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    db.prepare("INSERT INTO project_core(id,project_name,global_guidance) VALUES('main','项目','作者全局指导')").run();
    db.prepare("INSERT INTO blueprints(chapter_number,title,user_guidance) VALUES(2,'第二章','章指导')").run();
    db.prepare("INSERT INTO contents(id,body) VALUES(1,'原文\r\n汉字。'),(2,'未选草稿'),(3,'已定稿原文')").run();
    db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(1,2,1,'draft',1),(2,3,1,'draft',2),(3,1,1,'finalized',3)").run();
    db.prepare("INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name) VALUES('final-3',3,1,?,1,'已定稿原文','chapter1.txt')").run(hash('已定稿原文'));
    const h = hash('model'), input: GenerationSourceBindingInput = { projectId: 'p', epoch: 'e', operation: 'chapter', chapterNumber: 2, selectedDraftIds: [1], selectedFinalizedDraftIds: [3], promptKeys: ['draft'], skillStages: ['drafting'], modelReceipt: { modelId: 'model', provider: 'openai', protocol: 'openai', modelName: 'synthetic', modelRevision: h, endpointFingerprint: h, capabilityEvidence: { source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' }, subjectFingerprint: h, contextWindowTokens: 8000, maxOutputTokens: 1000, reasoning: false, structuredOutput: false, usage: true } }, policy: { version: 'fixture-v1', maxPhysicalRequests: 2 }, outputContract: 'visible-text' };
    const deps = { db, projectStorageRoot, globalDataRoot, readBuiltinPrompt: () => JSON.stringify({ key: 'draft', content: 'builtin original', systemRole: 'immutable contract' }) };
    return { root, db, input, deps, build: () => buildGenerationSourceBinding(deps, input) };
}
describe('main rebuilt generation sources', () => {
    it.each([
        ['empty provenance', ''],
        ['missing field provenance', '{}'],
        ['malformed provenance', '{'],
    ])('omits unproved dynamic character state without failing on %s', (_label, provenance) => {
        const f = fixture();
        migrateSchema(new SqliteSchemaAdapter(f.db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION);
        f.input.operation = 'chapter-draft';
        f.input.selectedDraftIds = [];
        f.db.prepare(`INSERT INTO characters(character_id,name,role,static_provenance,cs_location,cs_physical_state,cs_provenance)
          VALUES('character-unproved','静态角色','supporting','{"kind":"author"}','不可信地点','不可信伤势',?)`).run(provenance);
        const stored = f.db.prepare("SELECT * FROM characters WHERE character_id='character-unproved'").get();
        const text = f.build().materials.find(item => item.ref.sourceId === 'characters:all')?.text;
        expect(text).toContain('静态角色');
        expect(text).not.toContain('不可信地点');
        expect(text).not.toContain('不可信伤势');
        expect(text).not.toContain('cs_provenance');
        expect(f.db.prepare("SELECT * FROM characters WHERE character_id='character-unproved'").get()).toEqual(stored);
    });

    it('keeps valid author, legacy and current derived state while omitting one invalid field entry', () => {
        const f = fixture();
        migrateSchema(new SqliteSchemaAdapter(f.db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION);
        f.input.operation = 'chapter-draft';
        f.input.selectedDraftIds = [];
        const source = { draftId: 3, finalizationId: 'final-3', chapterNumber: 1, contentHash: hash('已定稿原文') };
        f.db.prepare(`INSERT INTO summary_snapshots(
          draft_id,chapter_number,chapter_notes,source_finalization_id,source_content_hash,projection_generation
        ) VALUES(3,1,'当前摘要','final-3',?,0)`).run(source.contentHash);
        f.db.prepare(`INSERT INTO characters(
          character_id,name,role,static_provenance,cs_location,cs_physical_state,cs_mental_state,cs_key_items,cs_provenance
        ) VALUES('character-proved','可信角色','supporting','{"kind":"author"}',?,?,?, ?,?)`).run(
            '作者地点', '当前派生伤势', '旧档案警觉', '非法动态字段', JSON.stringify({
                location: { kind: 'author', chapterNumber: 1, revision: 3 },
                physicalState: { kind: 'derived', source, revision: 1, sourceOrder: {
                    continuityEpoch: 'p:0', chapterNumber: 1, authoritativeFinalizationRevision: 1,
                } },
                mentalState: { kind: 'legacy', revision: 4 },
                keyItems: { kind: 'author', chapterNumber: 1, unexpected: 'bad' },
            }),
        );
        const stored = f.db.prepare("SELECT * FROM characters WHERE character_id='character-proved'").get();
        const text = f.build().materials.find(item => item.ref.sourceId === 'characters:all')?.text;
        expect(text).toContain('可信角色');
        expect(text).toContain('作者地点');
        expect(text).toContain('当前派生伤势');
        expect(text).toContain('旧档案警觉');
        expect(text).not.toContain('非法动态字段');
        const projected = JSON.parse(text!) as Array<{ cs_provenance: string }>;
        expect(JSON.parse(projected[0]!.cs_provenance)).toMatchObject({
            location: { kind: 'author', chapterNumber: 1, revision: 3 },
            mentalState: { kind: 'legacy', revision: 4 },
        });
        expect(JSON.parse(projected[0]!.cs_provenance)).not.toHaveProperty('keyItems');
        expect(f.db.prepare("SELECT * FROM characters WHERE character_id='character-proved'").get()).toEqual(stored);
    });

    it('rejects a downstream derived state whose epoch is spoofed after an earlier chapter replacement', async () => {
        const f = await createProjectArchiveRoundtripFixture();
        cleanups.push(f.dispose);
        await f.exportAndRestore();
        f.reopenRestoredProject();
        const db = f.restoredDatabase();
        const body = '第19章新定稿：上游线索已经改变。';
        db.prepare('INSERT INTO contents(id,body) VALUES(119,?)').run(body);
        db.prepare(`INSERT INTO drafts(id,chapter_number,version,status,source,content_id,word_count,source_dependencies)
          VALUES(119,19,2,'draft','rewrite',119,?,'[]')`).run(Buffer.from(body).length);
        FinalizationRepository.commit({ finalizationId: 'finalization-19-replacement', draftId: 119, chapterNumber: 19,
            chapterTitle: '第19章新定稿', content: body, contentHash: hash(body), contentRevision: 1,
            targetFileName: 'chapter-19-replacement.md' });
        const generation = db.prepare("SELECT generation FROM continuity_projection_meta WHERE id='main'").pluck().get() as number;
        const provenance = JSON.parse(db.prepare('SELECT cs_provenance FROM characters WHERE character_id=?')
            .pluck().get(f.characterId) as string) as Record<string, { sourceOrder?: { continuityEpoch: string } }>;
        for (const field of ['physicalState', 'keyItems']) provenance[field]!.sourceOrder!.continuityEpoch = `${f.targetProjectId}:${generation}`;
        db.prepare('UPDATE characters SET cs_provenance=? WHERE character_id=?').run(JSON.stringify(provenance), f.characterId);
        const stored = db.prepare('SELECT * FROM characters WHERE character_id=?').get(f.characterId);
        const result = buildGenerationSourceBinding({ db, projectStorageRoot: f.targetStorage, globalDataRoot: f.globalDataRoot,
            readBuiltinPrompt: () => JSON.stringify({ key: 'draft', content: 'builtin', systemRole: 'immutable' }) }, {
            ...f.chapter21GenerationInput, epoch: 'restored-spoofed-epoch', selectedFinalizedDraftIds: [f.chapter20DraftId],
        });
        const text = result.materials.find(item => item.ref.sourceId === 'characters:all')?.text;
        expect(text).not.toContain(f.chapter20Injury);
        expect(text).not.toContain(f.chapter20Clue);
        expect(text).toContain(f.authorCharacterState);
        expect(text).toContain(f.legacyCharacterState);
        expect(text).toContain(f.earlierDerivedState);
        expect(db.prepare('SELECT * FROM characters WHERE character_id=?').get(f.characterId)).toEqual(stored);
    });

    it('reopens a restored 20-chapter copy with readable authority and invalidates only replaced chapter 20 derived facts', async () => {
        const f = await createProjectArchiveRoundtripFixture();
        cleanups.push(f.dispose);
        await f.exportAndRestore();
        f.reopenRestoredProject();
        const db = f.restoredDatabase();
        const input: GenerationSourceBindingInput = {
            ...f.chapter21GenerationInput,
            projectId: f.targetProjectId,
            epoch: 'restored-epoch-1',
            selectedFinalizedDraftIds: [f.chapter20DraftId],
        };
        const deps = {
            db,
            projectStorageRoot: f.targetStorage,
            globalDataRoot: f.globalDataRoot,
            readBuiltinPrompt: () => JSON.stringify({ key: 'draft', content: 'builtin', systemRole: 'immutable' }),
        };

        const restored = buildGenerationSourceBinding(deps, input);
        const projections = SummaryRepository.listFinalizedContinuityBefore(21, db);
        expect(projections).toHaveLength(20);
        expect(projections.every(item => item.sourceStatus === 'current')).toBe(true);
        expect(projections.at(-1)).toMatchObject({
            chapterNumber: 20,
            chapterNotes: f.chapter20Derived,
            sourceStatus: 'current',
        });
        expect(restored.context.transferAuthority).toMatchObject({ originProjectId: f.sourceProjectId });
        expect(restored.context.sources).toEqual(expect.arrayContaining([
            expect.objectContaining({ ref: expect.objectContaining({ sourceId: 'author-action:chapter-21-direction' }), slot: 'author-constraint' }),
            expect.objectContaining({ ref: expect.objectContaining({ sourceId: `finalized:${f.chapter20DraftId}:${f.chapter20FinalizationId}` }), slot: 'finalized-fact' }),
            expect.objectContaining({ ref: expect.objectContaining({ sourceId: expect.stringMatching(/^portable-transfer:/u) }) }),
        ]));
        expect(restored.materials.find(item => item.ref.sourceId === `finalized:${f.chapter20DraftId}:${f.chapter20FinalizationId}`)?.text)
            .toBe(f.chapter20Body);
        expect(restored.materials.find(item => item.ref.sourceId === 'characters:all')?.text).toContain(f.chapter20Injury);
        expect(restored.materials.find(item => item.ref.sourceId === 'continuity-locators')?.text).toContain(f.chapter20Clue);
        expect(restored.context.sources.some(item => /(?:candidate-old|attempt-unknown|outbox-old|import-old)/u.test(item.ref.sourceId))).toBe(false);

        const authorityBefore = fs.readFileSync(f.transferAuthorityPath);
        const chaptersOneToNineteenBefore = db.prepare(`SELECT d.chapter_number AS chapterNumber,o.finalization_id AS finalizationId,
          s.chapter_notes AS chapterNotes,s.source_content_hash AS sourceContentHash
          FROM drafts d JOIN finalization_outbox o ON o.draft_id=d.id JOIN summary_snapshots s ON s.draft_id=d.id
          WHERE d.chapter_number BETWEEN 1 AND 19 ORDER BY d.chapter_number`).all();
        const replacement = f.prepareChapter20Replacement(db);
        FinalizationRepository.commit(replacement.commit);
        const afterReplacement = SummaryRepository.listFinalizedContinuityBefore(21, db);
        expect(afterReplacement.slice(0, 19).every(item => item.sourceStatus === 'current')).toBe(true);
        expect(afterReplacement.at(-1)).toMatchObject({
            chapterNumber: 20,
            sourceStatus: 'stale',
            currentFinalizedDraftId: replacement.draftId,
        });
        const rebuilt = buildGenerationSourceBinding(deps, {
            ...input,
            epoch: 'restored-epoch-2',
            selectedFinalizedDraftIds: [replacement.draftId],
        });
        expect(rebuilt.materials.find(item => item.ref.sourceId.startsWith(`finalized:${replacement.draftId}:`))?.text)
            .toBe(replacement.body);
        const rebuiltCharacters = rebuilt.materials.find(item => item.ref.sourceId === 'characters:all')?.text;
        expect(rebuiltCharacters).not.toContain(f.chapter20Injury);
        expect(rebuiltCharacters).not.toContain(f.chapter20Clue);
        expect(rebuiltCharacters).toContain(f.authorCharacterState);
        expect(rebuiltCharacters).toContain(f.legacyCharacterState);
        expect(rebuiltCharacters).toContain(f.earlierDerivedState);
        expect(db.prepare(`SELECT d.chapter_number AS chapterNumber,o.finalization_id AS finalizationId,
          s.chapter_notes AS chapterNotes,s.source_content_hash AS sourceContentHash
          FROM drafts d JOIN finalization_outbox o ON o.draft_id=d.id JOIN summary_snapshots s ON s.draft_id=d.id
          WHERE d.chapter_number BETWEEN 1 AND 19 ORDER BY d.chapter_number`).all()).toEqual(chaptersOneToNineteenBefore);
        expect(fs.readFileSync(f.transferAuthorityPath)).toEqual(authorityBefore);
    });

    it('retains explicit empty guidance as distinct from a missing author input', () => {
        const f = fixture(), absent = f.build();
        f.input.authorInputs = [{ id: 'directory:pacing-guidance', text: '' }];
        const empty = f.build();
        expect(empty.binding.sourceManifest.authorInputs).toEqual([{ id: 'directory:pacing-guidance', text: '' }]);
        expect(empty.binding.fingerprint.authorGuidanceHash).not.toBe(absent.binding.fingerprint.authorGuidanceHash);
        expect(rebuildGenerationSourceBinding(f.deps, empty.binding, 'next').binding.sourceManifest.authorInputs).toEqual([{ id: 'directory:pacing-guidance', text: '' }]);
    });
    it('freezes explicit author input IDs, order and exact bytes independently of later renderer buffers', () => {
        const f = fixture();
        f.input.authorInputs = [{ id: 'material:1', text: ' 原始资料\r\n ' }, { id: 'guidance', text: '保留人物姓名。' }];
        const original = f.build();
        expect(original.materials[0]).toMatchObject({ text: ' 原始资料\r\n ', ref: { sourceId: 'author-action:material:1', contentHash: hash(' 原始资料\r\n ') } });
        f.input.authorInputs[0].text = '作者改了输入';
        const rebuilt = rebuildGenerationSourceBinding(f.deps, original.binding, 'next');
        expect(compareGenerationSourceBindings(original.binding, rebuilt.binding)).toBe(true);
        expect(f.build().binding.fingerprint.authorGuidanceHash).not.toBe(original.binding.fingerprint.authorGuidanceHash);
        f.input.authorInputs = [{ id: 'renamed', text: ' 原始资料\r\n ' }, { id: 'guidance', text: '保留人物姓名。' }];
        expect(f.build().context.hash).not.toBe(original.context.hash);
        f.input.authorInputs = [{ id: 'guidance', text: '保留人物姓名。' }, { id: 'material:1', text: ' 原始资料\r\n ' }];
        expect(f.build().context.hash).not.toBe(original.context.hash);
    });
    it.each([null, [{ id: '', text: '正文' }], [{ id: 'a', text: '正文' }, { id: 'a', text: '正文' }], [{ id: 'a', text: 42 }], [{ id: 'a', text: '正文', artifactId: 'recovery' }]])('rejects malformed author action input %j', value => {
        const f = fixture(); f.input.authorInputs = value as unknown as GenerationSourceBindingInput['authorInputs'];
        expect(() => f.build()).toThrow('GENERATION_AUTHOR_INPUT_INVALID');
    });
    it('binds explicitly selected blueprint rows and empty planning slots', () => {
        const f = fixture(); f.input.selectedBlueprintChapterNumbers = [2, 3];
        const original = f.build();
        expect(original.materials.filter(item => item.ref.sourceId === 'blueprint:2')).toHaveLength(1);
        expect(original.materials.find(item => item.ref.sourceId === 'blueprint:3')?.text).toBe('null');
        f.db.exec("INSERT INTO blueprints(chapter_number,title) VALUES(3,'作者新建第三章')");
        expect(compareGenerationSourceBindings(original.binding, f.build().binding)).toBe(false);
    });
    it('reads exact selected prose and current finalized authority without unselected drafts or private paths', () => { const f = fixture(), result = f.build(); expect(result.materials.find(item => item.ref.sourceId === 'draft:1')?.text).toBe('原文\r\n汉字。'); expect(result.materials.some(item => item.text === '未选草稿')).toBe(false); expect(result.binding.sourceRefs.map(ref => ref.sourceId)).toEqual(['project-core:main', 'blueprint:2', 'draft:1', 'finalized:3:final-3']); expect(result.context).not.toHaveProperty('transferAuthority'); expect(JSON.stringify(result.binding.sourceManifest)).not.toContain(f.root); });
    it('binds only a restored receipt projection in the new project scope and detects its replacement', () => {
        const f = fixture(); useCanonicalStorage(f); f.input.projectId = '22222222-2222-4222-8222-222222222222';
        f.db.prepare("INSERT INTO summary_snapshots(draft_id,chapter_number,chapter_notes,source_finalization_id,source_content_hash,projection_generation) VALUES(3,1,'旧派生摘要','final-3',?,0)").run(hash('已定稿原文'));
        const ordinary = f.build(), authority = putPortableAuthority(f), restored = f.build();
        expect(restored.context.transferAuthority).toEqual({ receiptId: authority.receiptId, originProjectId: authority.originProjectId, snapshotGeneration: authority.snapshotGeneration });
        expect(restored.context.sources.at(-1)).toMatchObject({ ref: { projectId: f.input.projectId, epoch: 'e', sourceId: `portable-transfer:${authority.receiptId}` } });
        expect(restored.materials.some(item => item.ref.sourceId.startsWith('portable-transfer:'))).toBe(false);
        expect(restored.context.hash).not.toBe(ordinary.context.hash);
        expect(restored.binding.sourceManifest.portableTransferAuthority).toEqual(restored.context.transferAuthority);
        const changed = putPortableAuthority(f, 'snapshot-2');
        expect(f.build().context.hash).not.toBe(restored.context.hash);
        expect(changed.receiptId).not.toBe(authority.receiptId);
        expect(SummaryRepository.listFinalizedContinuityBefore(2, f.db)[0]?.sourceStatus).toBe('current');
        f.db.prepare("INSERT INTO contents(id,body) VALUES(4,'新权威正文')").run();
        f.db.prepare("INSERT INTO drafts(id,chapter_number,version,status,content_id) VALUES(4,1,2,'finalized',4)").run();
        f.db.prepare("INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name) VALUES('final-4',4,1,?,1,'新权威正文','chapter1-new.txt')").run(hash('新权威正文'));
        expect(SummaryRepository.listFinalizedContinuityBefore(2, f.db)[0]).toMatchObject({ sourceStatus: 'stale', currentFinalizedDraftId: 4 });
        f.input.selectedFinalizedDraftIds = [4];
        expect(f.build().materials.find(item => item.ref.sourceId.startsWith('finalized:4:'))?.text).toBe('新权威正文');
    });
    it('fails closed for restored authority sidecar absence, invalid data, project mismatch, and replacement races', () => {
        const f = fixture(); useCanonicalStorage(f); f.input.projectId = '22222222-2222-4222-8222-222222222222';
        const authority = putPortableAuthority(f), authorityFile = path.join(f.deps.projectStorageRoot, 'portable-transfer-authority.json');
        fs.unlinkSync(path.join(f.deps.projectStorageRoot, 'portable-runtime-freeze.json'));
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        putPortableAuthority(f);
        fs.writeFileSync(authorityFile, '{}');
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        fs.writeFileSync(authorityFile, serializePortableTransferAuthority(mapPortableTransferAuthority(authority, '33333333-3333-4333-8333-333333333333')));
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        putPortableAuthority(f);
        const subset = JSON.parse(fs.readFileSync(authorityFile, 'utf8')) as { finalizations: unknown[] };
        subset.finalizations = [];
        fs.writeFileSync(authorityFile, JSON.stringify(subset));
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        putPortableAuthority(f);
        const tuple = JSON.parse(fs.readFileSync(authorityFile, 'utf8')) as { finalizations: Array<{ contentHash: string }> };
        tuple.finalizations[0]!.contentHash = 'b'.repeat(64);
        fs.writeFileSync(authorityFile, JSON.stringify(tuple));
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        putPortableAuthority(f);
        let authorityOpens = 0;
        expect(() => readPortableCurrentAuthority({ database: f.db, projectStorageRoot: f.deps.projectStorageRoot, projectId: f.input.projectId,
            __testHooks: { afterOpen: file => {
                if (file !== authorityFile) return;
                authorityOpens += 1;
                if (authorityOpens === 2) { fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, serializePortableTransferAuthority(putPortableAuthority(f, 'snapshot-3'))); }
            } } })).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
        putPortableAuthority(f);
        f.db.prepare("UPDATE contents SET body='篡改旧定稿' WHERE id=3").run();
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
    });
    it('fails closed when an exported summary source tuple is rewritten', () => {
        const f = fixture(); useCanonicalStorage(f); f.input.projectId = '22222222-2222-4222-8222-222222222222';
        f.db.prepare("INSERT INTO summary_snapshots(draft_id,chapter_number,chapter_notes,source_finalization_id,source_content_hash,projection_generation) VALUES(3,1,'冻结摘要','final-3',?,0)").run(hash('已定稿原文'));
        putPortableAuthority(f);
        f.db.prepare("UPDATE summary_snapshots SET projection_generation=1 WHERE draft_id=3").run();
        expect(() => f.build()).toThrow('PORTABLE_CURRENT_AUTHORITY_INVALID');
    });
    it('keeps binding hashes stable across epoch and timestamp/log-only changes', () => { const f = fixture(), a = f.build(); f.db.exec("UPDATE project_core SET updated_at='later';UPDATE drafts SET updated_at='later';UPDATE blueprints SET notes='cache',notes_updated_at='later'"); const b = rebuildGenerationSourceBinding(f.deps, a.binding, 'next'); expect(b.binding.epoch).toBe('next'); expect(compareGenerationSourceBindings(a.binding, b.binding)).toBe(true); });
    // 回归（s10b-2）：冻结的审修上下文绝不携带会话租约，否则重开项目（新 epoch）后重建
    // binding 会以 GENERATION_REVIEW_CONTEXT_CHANGED 假失败，审稿/修稿的续跑随之被破坏。
    it('resumes a review/refine run after a reopen because the frozen review context carries no session lease', () => {
        const f = fixture();
        // 捕获走现代 schema（审修材料来自 contents/drafts/characters 等表），
        // 这里只把已有的 legacy 基线库迁移到当前桌面版本。
        migrateSchema(new SqliteSchemaAdapter(f.db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION);
        const request: PrepareReviewRevisionRequest = { operation: 'review-chapter', draftId: 1,
            expectedDraft: { chapterNumber: 2, version: 1, status: 'draft', contentHash: textHash('原文\r\n汉字。') },
            authorInputs: [], uiLocale: 'zh-CN' };
        // 主进程在**会话-1** 捕获；项目 id 与会话无关，租约不进身份。
        const reviewRevisionContext = captureReviewRevisionContext(f.db, request, f.input.projectId);
        expect(reviewRevisionContext.history[0]!.identity).toMatchObject({ projectId: 'p', sourceId: 'finalized:3', revision: 3, provenance: 'finalized' });
        expect(reviewRevisionContext.history[0]!.identity).not.toHaveProperty('epoch');
        const input: GenerationSourceBindingInput = { ...f.input, operation: 'review-chapter', chapterNumber: 2,
            selectedDraftIds: [1], selectedFinalizedDraftIds: [], promptKeys: ['consistency_check'], skillStages: ['review'],
            reviewRevisionContext };
        const original = buildGenerationSourceBinding(f.deps, input);
        // 项目重开：活跃租约改变（会话-2）。重建必须成功，且冻结上下文逐字节不变。
        const resumed = rebuildGenerationSourceBinding(f.deps, original.binding, 'next-epoch');
        expect(resumed.binding.epoch).toBe('next-epoch');
        expect(resumed.binding.sourceManifest.reviewRevisionContext).toEqual(reviewRevisionContext);
        expect(compareGenerationSourceBindings(original.binding, resumed.binding)).toBe(true);
    });
    it.each(['core', 'brief', 'draft', 'model', 'policy', 'output'])('detects changed %s before resume', kind => { const f = fixture(), a = f.build(); if (kind === 'core')
        f.db.exec("UPDATE project_core SET global_guidance='changed'"); if (kind === 'brief')
        f.db.exec("UPDATE blueprints SET user_guidance='changed'"); if (kind === 'draft')
        f.db.exec("UPDATE contents SET body='changed' WHERE id=1"); if (kind === 'model')
        f.input.modelReceipt = { ...f.input.modelReceipt, modelRevision: hash('new') }; if (kind === 'policy')
        f.input.policy = { version: 'changed' }; if (kind === 'output')
        f.input.outputContract = 'structured-data'; expect(compareGenerationSourceBindings(a.binding, f.build().binding)).toBe(false); });
    it('resolves project over global over builtin while retaining immutable builtin contract changes', () => { const f = fixture(), a = f.build(); put(f.deps.globalDataRoot, 'prompts/draft.zh-CN.json', JSON.stringify({ key: 'draft', writingLanguage: 'zh-CN', content: 'global' })); const global = f.build(); expect(global.binding.fingerprint.templateHash).not.toBe(a.binding.fingerprint.templateHash); put(f.deps.projectStorageRoot, 'prompts/draft.json', JSON.stringify({ key: 'draft', content: 'project' })); const project = f.build(); put(f.deps.globalDataRoot, 'prompts/draft.zh-CN.json', JSON.stringify({ key: 'draft', writingLanguage: 'zh-CN', content: 'unused global edit' })); expect(f.build().binding.fingerprint.templateHash).toBe(project.binding.fingerprint.templateHash); f.deps.readBuiltinPrompt = () => JSON.stringify({ key: 'draft', content: 'builtin', systemRole: 'changed system contract' }); expect(f.build().binding.fingerprint.templateHash).not.toBe(project.binding.fingerprint.templateHash); });
    it('hashes raw selected custom prompt bytes including whitespace', () => { const f = fixture(); put(f.deps.projectStorageRoot, 'prompts/draft.json', '{"key":"draft","content":"同文"}'); const a = f.build(); put(f.deps.projectStorageRoot, 'prompts/draft.json', '{ "key":"draft","content":"同文"}'); expect(f.build().binding.fingerprint.templateHash).not.toBe(a.binding.fingerprint.templateHash); });
    it('binds actual selected Skill bytes and rejects a missing binding target', () => { const f = fixture(); put(f.deps.projectStorageRoot, 'writing-skills.json', JSON.stringify({ version: 1, bindings: { drafting: 'project:author' } })); expect(() => f.build()).toThrow(); put(f.deps.projectStorageRoot, 'skills/author/SKILL.md', '---\nname: author\nlanguage: zh-CN\nstage: drafting\n---\n保持作者事实。'); const a = f.build(); put(f.deps.projectStorageRoot, 'skills/author/SKILL.md', '---\nname: author\nlanguage: zh-CN\nstage: drafting\n---\n新作者规则。'); expect(f.build().binding.fingerprint.skillSnapshotHash).not.toBe(a.binding.fingerprint.skillSnapshotHash); });
    it.each(['missing', 'obsolete', 'hash', 'receipt'])('rejects %s selected source authority', kind => { const f = fixture(); if (kind === 'missing')
        f.input.selectedDraftIds = [999]; if (kind === 'obsolete') {
        f.db.exec("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(2,2,'draft',1)");
    } if (kind === 'hash')
        f.db.exec("UPDATE contents SET body='mutated finalized' WHERE id=3"); if (kind === 'receipt')
        f.db.exec('DELETE FROM finalization_outbox'); expect(() => f.build()).toThrow(); });
    it('rejects a linked prompt without traversing an external source', () => { const f = fixture(); put(f.root, 'outside.json', '{"key":"draft"}'); fs.mkdirSync(path.join(f.deps.projectStorageRoot, 'prompts')); fs.linkSync(path.join(f.root, 'outside.json'), path.join(f.deps.projectStorageRoot, 'prompts/draft.json')); expect(() => f.build()).toThrow('GENERATION_ASSET_UNSAFE'); });
    it('excludes lease lifetime fields and rejects secret or absolute path metadata', () => { const f = fixture(), a = f.build(); const extra = { ...f.input.modelReceipt, leaseId: 'lease-secret', createdAt: 123, expiresAt: 456 }; f.input.modelReceipt = extra; expect(f.build().binding.fingerprint.modelLeaseRevision).toBe(a.binding.fingerprint.modelLeaseRevision); expect(JSON.stringify(f.build().binding.sourceManifest)).not.toContain('lease-secret'); f.input.policy = { apiKey: 'never persist' }; expect(() => f.build()).toThrow('GENERATION_METADATA_PRIVATE_FIELD'); f.input.policy = { source: 'C:\\private\\config' }; expect(() => f.build()).toThrow('GENERATION_METADATA_PRIVATE_PATH'); });
});
it('rejects a source edit made while asset callbacks are being read', () => {
    const f = fixture();
    f.deps.readBuiltinPrompt = () => { f.db.exec("UPDATE project_core SET global_guidance='concurrent edit'"); return '{"key":"draft"}'; };
    expect(() => f.build()).toThrow('GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT');
});

it('hashes the actual bundled Skill body without reclassifying its established tool capability',()=>{
 const f=fixture();put(f.deps.projectStorageRoot,'writing-skills.json',JSON.stringify({version:1,bindings:{drafting:'builtin:writing-coach'}}));
 const deps={...f.deps,readBuiltinSkill:readBuiltinWritingSkill};
 const actual=readBuiltinWritingSkill('writing-coach','zh-CN');expect(actual).toBeDefined();
 const before=buildGenerationSourceBinding(deps,f.input);
 const after=buildGenerationSourceBinding({...deps,readBuiltinSkill:(name,language)=>{const bytes=readBuiltinWritingSkill(name,language);return bytes===undefined?undefined:bytes+'\n已审核内置正文变化'}},f.input);
 expect(after.binding.fingerprint.skillSnapshotHash).not.toBe(before.binding.fingerprint.skillSnapshotHash);
 expect(readBuiltinWritingSkill('missing','zh-CN')).toBeUndefined();
 expect(()=>buildGenerationSourceBinding({...deps,readBuiltinSkill:()=>undefined},f.input)).toThrow('GENERATION_SKILL_MISSING');
});
it('rejects an empty prompt selection before reading assets', () => {
    const f = fixture(); f.input.promptKeys = [];
    f.deps.readBuiltinPrompt = () => { throw new Error('MUST_NOT_READ'); };
    expect(() => f.build()).toThrow('GENERATION_PROMPT_SELECTION_REQUIRED');
});

/**
 * S10B 步骤 3：章节材料准入裁决的脱敏收据必须被**恢复指纹**绑定。
 *
 * 收据由渲染层产出（写稿路径的准入先于运行开启），主进程只校验形状、原样冻进
 * `sourceManifest`，并把它的哈希折进 `contextSnapshotHash`。这样同一份冻结来源配上
 * 另一份准入裁决就得到另一个 `contextSnapshotId`，恢复无法悄悄对着别的材料裁决继续。
 */
describe('material decision receipt binding (S10B step 3)', () => {
    const decision = (over: Partial<MaterialDecisionReceipt> = {}): MaterialDecisionReceipt => ({
        version: MATERIAL_DECISION_RECEIPT_VERSION, verdict: 'admitted', promptHash: hash('初始用户提示词'),
        capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 },
        coverage: { required: 1, included: 1, complete: true },
        included: [{ sourceId: 'author:required', revision: 1, contentHash: hash('必需作者资料'), category: 'author', required: true, units: 12 }],
        omitted: [],
        ...over,
    });
    const decisionOf = (binding: { sourceManifest: Readonly<Record<string, unknown>> }) =>
        binding.sourceManifest.materialDecision as MaterialDecisionReceipt | undefined;
    const receiptFixture = () => {
        const f = fixture();
        migrateSchema(new SqliteSchemaAdapter(f.db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION);
        f.input.operation = 'chapter-draft';
        f.input.selectedDraftIds = [];
        return f;
    };

    it('folds the decision into the frozen context snapshot and leaves everything else byte-identical', () => {
        const f = receiptFixture(), before = f.build();
        f.input.materialDecision = decision();
        const after = f.build();
        expect(after.binding.contextSnapshotId).not.toBe(before.binding.contextSnapshotId);
        expect(after.binding.fingerprint.contextSnapshotHash).not.toBe(before.binding.fingerprint.contextSnapshotHash);
        // 只有上下文快照分项改变：模板、Skill、模型租约、策略、输出契约与依赖哈希逐字节不变。
        for (const key of Object.keys(before.binding.fingerprint) as (keyof typeof before.binding.fingerprint)[]) {
            if (key === 'contextSnapshotHash') continue;
            expect(after.binding.fingerprint[key]).toBe(before.binding.fingerprint[key]);
        }
        // 冻结来源（= 提示词材料的身份）完全不变，收据是旁路证据，不是第二份材料。
        expect(after.binding.sourceRefs).toEqual(before.binding.sourceRefs);
        expect(decisionOf(after.binding)).toEqual(decision());
        expect(after.binding.sourceManifest.materialDecisionHash).toMatch(/^[a-f0-9]{64}$/);
        // 脱敏：持久化结构里没有材料正文，也没有渲染层没给过的自由文本。
        expect(JSON.stringify(after.binding.sourceManifest)).not.toContain('必需作者资料');
    });

    it('leaves the fingerprint component and manifest untouched when an entry point supplies no decision', () => {
        const f = fixture(), binding = f.build().binding;
        expect(Object.keys(binding.sourceManifest)).not.toContain('materialDecision');
        expect(Object.keys(binding.sourceManifest)).not.toContain('materialDecisionHash');
    });

    it('makes a different decision detectable on the same frozen sources', () => {
        const f = receiptFixture();
        f.input.materialDecision = decision();
        const original = f.build();
        // 更窄的准入：可选来源被整条排除。
        f.input.materialDecision = decision({ omitted: [{ sourceId: 'reference:0', revision: 1,
            contentHash: hash('被预算省略的参考材料'), reason: 'budget', category: 'reference', required: false }] });
        const narrower = f.build();
        expect(narrower.binding.fingerprint.contextSnapshotHash).not.toBe(original.binding.fingerprint.contextSnapshotHash);
        expect(narrower.binding.contextSnapshotId).not.toBe(original.binding.contextSnapshotId);
        expect(narrower.binding.sourceManifest.materialDecisionHash).not.toBe(original.binding.sourceManifest.materialDecisionHash);
        expect(compareGenerationSourceBindings(original.binding, narrower.binding)).toBe(false);
        // 更隐蔽的一种：来源集合与字节数都没变，但纳入的**正文**换了（哈希不同）。
        f.input.materialDecision = decision({ included: [{ sourceId: 'author:required', revision: 1, contentHash: hash('作者改了这段'), category: 'author', required: true, units: 12 }] });
        expect(compareGenerationSourceBindings(original.binding, f.build().binding)).toBe(false);
    });

    it('resumes against the very decision it froze', () => {
        const f = receiptFixture();
        f.input.materialDecision = decision();
        const original = f.build();
        const resumed = rebuildGenerationSourceBinding(f.deps, original.binding, 'next-epoch').binding;
        expect(decisionOf(resumed)).toEqual(decision());
        expect(resumed.fingerprint.contextSnapshotHash).toBe(original.binding.fingerprint.contextSnapshotHash);
        expect(compareGenerationSourceBindings(original.binding, resumed)).toBe(true);
    });

    it.each<[string, unknown]>([
        ['a version it could not have minted', { ...decision(), version: 2 }],
        ['a non-admitted verdict', { ...decision(), verdict: 'split-required' }],
        ['an extra field', { ...decision(), note: '自由文本说明' }],
        ['a missing coverage block', (() => { const copy: Record<string, unknown> = { ...decision() }; delete copy.coverage; return copy })()],
        ['a prompt hash that is not a hash', { ...decision(), promptHash: 'not-a-hash' }],
        ['an omission reason outside the closed set', { ...decision(), omitted: [{ sourceId: 'reference:0', revision: 1,
            contentHash: hash('参考'), reason: 'secret-token', category: 'reference', required: false }] }],
        ['an absolute path used as a source id', { ...decision(), included: [{ sourceId: 'C:\\private\\x', revision: 1, contentHash: hash('x'), category: 'author', required: true, units: 1 }] }],
        ['a credential-shaped source id', { ...decision(), included: [{ sourceId: 'token:sk-live-secret', revision: 1, contentHash: hash('x'), category: 'author', required: true, units: 1 }] }],
        ['a content hash that is not a hash', { ...decision(), included: [{ sourceId: 'author:required', revision: 1, contentHash: 'not-a-hash', category: 'author', required: true, units: 1 }] }],
        ['a negative unit count', { ...decision(), included: [{ sourceId: 'author:required', revision: 1, contentHash: hash('x'), category: 'author', required: true, units: -1 }] }],
        ['a non-positive maximum', { ...decision(), capacity: { maxInputUnits: 0, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 } }],
        ['an unsupported unit method', { ...decision(), capacity: { maxInputUnits: 18_000, methodVersion: 'api-key', admittedUnits: 12 } }],
        ['an oversized maximum', { ...decision(), capacity: { maxInputUnits: MATERIAL_DECISION_MAX_INPUT_UNITS + 1, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 } }],
        ['an admitted-unit total that disagrees with sources', { ...decision(), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 999 } }],
        ['an admitted-unit total above capacity', { ...decision(), capacity: { maxInputUnits: 1, methodVersion: 'utf8-bytes-v1', admittedUnits: 12 } }],
        ['a category outside the closed set', { ...decision(), included: [{ sourceId: 'author:required', revision: 1, contentHash: hash('x'), category: 'credential', required: true, units: 12 }] }],
        ['a category that disagrees with its source family', { ...decision(), included: [{ sourceId: 'reference:0', revision: 1, contentHash: hash('x'), category: 'author', required: false, units: 12 }] }],
        ['a required flag that disagrees with its source family', { ...decision(), included: [{ sourceId: 'author:required', revision: 1, contentHash: hash('x'), category: 'author', required: false, units: 12 }] }],
        ['a revision that disagrees with its source identity', { ...decision(), included: [{ sourceId: 'finalized:3', revision: 2, contentHash: hash('x'), category: 'finalized-history', required: false, units: 12 }] }],
        ['a chapter decision without its required author source', { ...decision(),
            capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 1 },
            coverage: { required: 0, included: 0, complete: true },
            included: [{ sourceId: 'reference:0', revision: 1, contentHash: hash('x'), category: 'reference', required: false, units: 1 }] }],
        ['a duplicate included identity', { ...decision(), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 24 },
            included: [decision().included[0]!, decision().included[0]!] }],
        ['a non-canonical included order', { ...decision(), capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 13 },
            included: [{ sourceId: 'reference:0', revision: 1, contentHash: hash('r'), category: 'reference', required: false, units: 1 }, decision().included[0]!] }],
        ['coverage counts detached from required identities', { ...decision(), coverage: { required: 2, included: 2, complete: true } }],
        ['a required coverage that is not complete', { ...decision(), coverage: { required: 2, included: 1, complete: false } }],
        ['a complete flag that disagrees with the counts', { ...decision(), coverage: { required: 1, included: 1, complete: false } }],
        ['a credential-shaped field', { ...decision(), apiKey: 'secret' }],
        ['an oversized source list', { ...decision(), included: Array.from({ length: 1_025 }, () => ({ sourceId: 'author:required', revision: 1, contentHash: hash('x'), category: 'author', required: true, units: 1 })) }],
    ])('fails closed on %s', (_name, value) => {
        const f = receiptFixture();
        f.input.materialDecision = value as MaterialDecisionReceipt;
        expect(() => f.build()).toThrow('GENERATION_MATERIAL_DECISION_INVALID');
    });

    it('rejects the receipt on a non-chapter operation', () => {
        const f = fixture();
        f.input.materialDecision = decision();
        expect(() => f.build()).toThrow('GENERATION_MATERIAL_DECISION_INVALID');
    });

    it('accepts an empty but complete review admission and binds its prompt hash', () => {
        const f = fixture();
        f.input.operation = 'review-chapter';
        f.input.materialDecision = decision({
            capacity: { maxInputUnits: 18_000, methodVersion: 'utf8-bytes-v1', admittedUnits: 0 },
            coverage: { required: 0, included: 0, complete: true }, included: [], omitted: [],
        });
        expect(decisionOf(f.build().binding)?.promptHash).toBe(hash('初始用户提示词'));
    });
});
