import { readBuiltinWritingSkill } from '../../../src/shared/builtin-writing-skills'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema';
import { buildGenerationSourceBinding, rebuildGenerationSourceBinding, compareGenerationSourceBindings, type GenerationSourceBindingInput } from '../generation-source-binding';
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0))
    cleanup(); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function put(root: string, file: string, text: string) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
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
    it('reads exact selected prose and current finalized authority without unselected drafts or private paths', () => { const f = fixture(), result = f.build(); expect(result.materials.find(item => item.ref.sourceId === 'draft:1')?.text).toBe('原文\r\n汉字。'); expect(result.materials.some(item => item.text === '未选草稿')).toBe(false); expect(result.binding.sourceRefs.map(ref => ref.sourceId)).toEqual(['project-core:main', 'blueprint:2', 'draft:1', 'finalized:3:final-3']); expect(JSON.stringify(result.binding.sourceManifest)).not.toContain(f.root); });
    it('keeps binding hashes stable across epoch and timestamp/log-only changes', () => { const f = fixture(), a = f.build(); f.db.exec("UPDATE project_core SET updated_at='later';UPDATE drafts SET updated_at='later';UPDATE blueprints SET notes='cache',notes_updated_at='later'"); const b = rebuildGenerationSourceBinding(f.deps, a.binding, 'next'); expect(b.binding.epoch).toBe('next'); expect(compareGenerationSourceBindings(a.binding, b.binding)).toBe(true); });
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
