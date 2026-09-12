import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import type { ModelExecutionLeaseReceipt } from '../../src/shared/ipc-channels';
import type { ContextSnapshot, SourceRef } from '../../src/shared/source-ref';
import { inspectWritingSkillMarkdown, WRITING_SKILL_STAGES, type WritingSkillStage } from '../../src/shared/writing-skills';
import type { WritingLanguage } from '../../src/shared/writing-language';
import type { RunBinding } from '../repositories/generation-run-repository';
export type SafeGenerationModelReceipt = Omit<ModelExecutionLeaseReceipt, 'leaseId' | 'createdAt' | 'expiresAt'>;
export interface GenerationSourceBindingInput {
    projectId: string;
    epoch: string;
    operation: string;
    chapterNumber?: number;
    selectedDraftIds: readonly number[];
    selectedFinalizedDraftIds: readonly number[];
    promptKeys: readonly string[];
    skillStages: readonly WritingSkillStage[];
    modelReceipt: SafeGenerationModelReceipt;
    policy: Readonly<Record<string, unknown>>;
    outputContract: string | Readonly<Record<string, unknown>>;
}
export interface GenerationSourceBindingDependencies {
    db: Database.Database;
    projectStorageRoot: string;
    globalDataRoot: string;
    readBuiltinPrompt: (key: string, language: WritingLanguage) => string;
    readBuiltinSkill?: (name: string, language: WritingLanguage) => string | undefined;
}
export interface GenerationSourceBindingResult {
    binding: RunBinding;
    context: ContextSnapshot;
    materials: readonly {
        ref: SourceRef;
        text: string;
    }[];
}
function fail(code: string): never { throw new Error(code); }
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function stable(value: unknown): string {
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, sorted(item)])) : v;
    return JSON.stringify(sorted(value));
}
function safeMetadata(value: unknown): void {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
        fail('GENERATION_METADATA_INVALID');
    if (typeof value === 'string' && (/^(?:[A-Za-z]:[\\/]|\\\\|file:\/\/)/.test(value)))
        fail('GENERATION_METADATA_PRIVATE_PATH');
    if (Array.isArray(value)) {
        value.forEach(safeMetadata);
        return;
    }
    if (value && typeof value === 'object')
        for (const [key, entry] of Object.entries(value)) {
            if (/(?:api.?key|password|secret|credential|grant|absolute.?path|baseUrl|leaseId|expiresAt|createdAt)/i.test(key))
                fail('GENERATION_METADATA_PRIVATE_FIELD');
            safeMetadata(entry);
        }
}
function modelProjection(value: SafeGenerationModelReceipt): SafeGenerationModelReceipt {
    const { modelId, provider, protocol, modelName, modelRevision, endpointFingerprint, capabilityEvidence } = value;
    const safe = { modelId, provider, protocol, modelName, modelRevision, endpointFingerprint, capabilityEvidence };
    safeMetadata(safe);
    if (!modelId || !modelRevision || !endpointFingerprint || !capabilityEvidence)
        fail('GENERATION_MODEL_RECEIPT_INVALID');
    return JSON.parse(stable(safe));
}
function readFile(root: string, relative: string, optional = false): Buffer | null {
    if (!path.isAbsolute(root) || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || part === '.'))
        fail('GENERATION_ASSET_PATH_INVALID');
    const absolute = path.resolve(root, relative), rel = path.relative(root, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel))
        fail('GENERATION_ASSET_PATH_INVALID');
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(cursor);
        }
        catch (error) {
            if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }
        if (stat.isSymbolicLink() || cursor !== absolute && !stat.isDirectory() || cursor === absolute && (!stat.isFile() || stat.nlink !== 1))
            fail('GENERATION_ASSET_UNSAFE');
    }
    return fs.readFileSync(absolute);
}
function without(row: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> { return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.includes(key))); }
export function buildGenerationSourceBinding(deps: GenerationSourceBindingDependencies, input: GenerationSourceBindingInput): GenerationSourceBindingResult {
    if (!deps.db.open || !input.projectId || !input.epoch || !input.operation)
        fail('GENERATION_SOURCE_BINDING_INVALID');
    if (!Array.isArray(input.promptKeys) || input.promptKeys.length === 0)
        fail('GENERATION_PROMPT_SELECTION_REQUIRED');
    if (input.chapterNumber !== undefined && (!Number.isSafeInteger(input.chapterNumber) || input.chapterNumber < 1))
        fail('GENERATION_CHAPTER_INVALID');
    for (const ids of [input.selectedDraftIds, input.selectedFinalizedDraftIds])
        if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1))
            fail('GENERATION_SELECTION_INVALID');
    if (new Set([...input.selectedDraftIds, ...input.selectedFinalizedDraftIds]).size !== input.selectedDraftIds.length + input.selectedFinalizedDraftIds.length)
        fail('GENERATION_SELECTION_AMBIGUOUS');
    if (input.promptKeys.some(key => !/^[A-Za-z0-9_-]{1,128}$/.test(key)) || input.skillStages.some(stage => !WRITING_SKILL_STAGES.includes(stage)))
        fail('GENERATION_ASSET_ID_INVALID');
    const dataVersion = deps.db.pragma('data_version', { simple: true }), changes = deps.db.prepare('SELECT total_changes()').pluck().get();
    const modelReceipt = modelProjection(input.modelReceipt);
    safeMetadata(input.policy);
    safeMetadata(input.outputContract);
    const materials: {
        ref: SourceRef;
        text: string;
    }[] = [], contextSources: ContextSnapshot['sources'][number][] = [];
    const add = (sourceId: string, revision: number, text: string, slot: ContextSnapshot['sources'][number]['slot'], reason: string) => {
        const ref: SourceRef = { projectId: input.projectId, epoch: input.epoch, sourceId, revision, contentHash: hash(text) };
        materials.push({ ref, text });
        contextSources.push({ ref, slot, reason });
    };
    // SQLite supplies one read transaction; filesystem selections are read twice below.
    const facts = deps.db.transaction(() => {
        const raw = deps.db.prepare("SELECT * FROM project_core WHERE id='main'").get() as Record<string, unknown> | undefined;
        if (!raw)
            fail('GENERATION_PROJECT_CORE_MISSING');
        const core = without(raw, ['created_at', 'updated_at', 'character_states', 'plot_tree_snapshot']);
        const language: WritingLanguage = core.writing_language === 'en-US' ? 'en-US' : 'zh-CN';
        add('project-core:main', 0, stable(core), 'author-constraint', 'current project settings');
        let brief: Record<string, unknown> | null = null;
        if (input.chapterNumber !== undefined) {
            const row = deps.db.prepare('SELECT * FROM blueprints WHERE chapter_number=?').get(input.chapterNumber) as Record<string, unknown> | undefined;
            if (!row)
                fail('GENERATION_CHAPTER_MISSING');
            brief = without(row, ['created_at', 'updated_at', 'notes', 'notes_updated_at']);
            add(`blueprint:${input.chapterNumber}`, 0, stable(brief), 'author-constraint', 'selected chapter brief');
        }
        for (const [ids, finalized] of [[input.selectedDraftIds, false], [input.selectedFinalizedDraftIds, true]] as const)
            for (const id of ids) {
                const row = deps.db.prepare('SELECT d.*,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(id) as {
                    id: number;
                    chapter_number: number;
                    version: number;
                    status: string;
                    body: string;
                } | undefined;
                if (!row || typeof row.body !== 'string')
                    fail('GENERATION_SOURCE_MISSING');
                if (finalized) {
                    const latest = deps.db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1").pluck().get(row.chapter_number);
                    const receipt = deps.db.prepare('SELECT * FROM finalization_outbox WHERE draft_id=?').get(id) as {
                        finalization_id: string;
                        chapter_number: number;
                        content_hash: string;
                        content_snapshot: string;
                        content_revision: number;
                    } | undefined;
                    if (row.status !== 'finalized' || latest !== id || !receipt?.finalization_id || receipt.chapter_number !== row.chapter_number || receipt.content_snapshot !== row.body || receipt.content_hash !== hash(row.body) || !Number.isSafeInteger(receipt.content_revision) || receipt.content_revision < 1)
                        fail('GENERATION_FINALIZED_SOURCE_NOT_CURRENT');
                    add(`finalized:${id}:${receipt.finalization_id}`, receipt.content_revision, row.body, 'finalized-fact', 'explicit current finalized source');
                }
                else {
                    const latest = deps.db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status IN ('draft','revised','finalized') ORDER BY version DESC,id DESC LIMIT 1").pluck().get(row.chapter_number);
                    if (!['draft', 'revised'].includes(row.status) || latest !== id)
                        fail('GENERATION_DRAFT_NOT_CURRENT');
                    add(`draft:${id}`, row.version, row.body, 'unconfirmed-continuity', 'explicit selected current draft');
                }
            }
        return { core, brief, language };
    })();
    const assets: {
        scope: string;
        identity: string;
        hash: string;
    }[] = [], observed: {
        root: string;
        relative: string;
        bytes: Buffer | null;
    }[] = [];
    const observe = (root: string, relative: string, optional = false) => { const bytes = readFile(root, relative, optional); observed.push({ root, relative, bytes }); return bytes; };
    for (const key of input.promptKeys) {
        const builtin = deps.readBuiltinPrompt(key, facts.language);
        if (typeof builtin !== 'string' || !builtin)
            fail('GENERATION_BUILTIN_PROMPT_MISSING');
        assets.push({ scope: 'builtin', identity: `prompt:${key}:${facts.language}`, hash: hash(builtin) });
        let selected: Buffer | null = null, scope = '';
        for (const [candidateScope, root] of [['project', deps.projectStorageRoot], ['global', deps.globalDataRoot]] as const) {
            for (const relative of [`prompts/${key}.${facts.language}.json`, ...(facts.language === 'zh-CN' ? [`prompts/${key}.json`] : [])]) {
                const bytes = observe(root, relative, true);
                if (!selected && bytes) {
                    const parsed = JSON.parse(bytes.toString('utf8'));
                    if (parsed.key !== key || (parsed.writingLanguage ?? 'zh-CN') !== facts.language)
                        fail('GENERATION_PROMPT_INVALID');
                    selected = bytes;
                    scope = candidateScope + ':' + relative;
                }
            }
            if (selected)
                break;
        }
        if (selected)
            assets.push({ scope, identity: `prompt:${key}:${facts.language}`, hash: hash(selected) });
    }
    const bindingsBytes = observe(deps.projectStorageRoot, 'writing-skills.json', true);
    const bindings = bindingsBytes ? JSON.parse(bindingsBytes.toString('utf8')) : { version: 1, bindings: {} };
    if (bindings.version !== 1 || !bindings.bindings || typeof bindings.bindings !== 'object' || Array.isArray(bindings.bindings))
        fail('GENERATION_SKILL_BINDINGS_INVALID');
    const skills: {
        stage: string;
        identity: string;
        hash: string;
    }[] = [];
    for (const stage of input.skillStages) {
        const id = bindings.bindings[stage];
        if (id === undefined) {
            skills.push({ stage, identity: 'unbound', hash: hash('') });
            continue;
        }
        if (typeof id !== 'string' || !/^(builtin|user|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
            fail('GENERATION_SKILL_ID_INVALID');
        const [scope, name] = id.split(':');
        if (name === '.' || name === '..')
            fail('GENERATION_SKILL_ID_INVALID');
        const text = scope === 'builtin' ? deps.readBuiltinSkill?.(name, facts.language) : observe(scope === 'project' ? deps.projectStorageRoot : deps.globalDataRoot, `skills/${name}/SKILL.md`)!.toString('utf8');
        if (!text)
            fail('GENERATION_SKILL_MISSING');
        const inspected = inspectWritingSkillMarkdown(text);
        // Bundled skills are an existing product capability, selected through
        // the trusted pure getter. External imports retain their stricter gate.
        if (scope !== 'builtin' && !inspected.compatible || !['bilingual', facts.language].includes(inspected.metadata.language))
            fail('GENERATION_SKILL_INCOMPATIBLE');
        skills.push({ stage, identity: id, hash: hash(text) });
    }
    for (const file of observed) {
        const now = readFile(file.root, file.relative, true);
        if (!isDeepStrictEqual(now, file.bytes))
            fail('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT');
    }
    if (deps.db.pragma('data_version', { simple: true }) !== dataVersion || deps.db.prepare('SELECT total_changes()').pluck().get() !== changes)
        fail('GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT');
    const sourceManifest = { version: 1, operation: input.operation, ...(input.chapterNumber !== undefined ? { chapterNumber: input.chapterNumber } : {}), selectedDraftIds: [...input.selectedDraftIds], selectedFinalizedDraftIds: [...input.selectedFinalizedDraftIds], promptKeys: [...input.promptKeys], skillStages: [...input.skillStages], modelReceipt, policy: input.policy, outputContract: input.outputContract };
    const contextHash = hash(stable(contextSources.map(({ ref, ...entry }) => ({ ...entry, ref: without(ref as unknown as Record<string, unknown>, ['epoch']) }))));
    const context: ContextSnapshot = { projectId: input.projectId, epoch: input.epoch, id: `context:${contextHash}`, hash: contextHash, sources: contextSources, omissions: [], estimate: { methodVersion: 'utf8-bytes-v1', inputUnits: materials.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) } };
    const fingerprint = { chapterBriefHash: hash(stable(facts.brief)), authorGuidanceHash: hash(stable(facts.core)), dependencyHash: hash(stable(materials.filter(item => /^(draft|finalized):/.test(item.ref.sourceId)).map(item => ({ ...item.ref, epoch: undefined })))), contextSnapshotHash: contextHash, templateHash: hash(stable(assets)), skillSnapshotHash: hash(stable(skills)), modelLeaseRevision: hash(stable(modelReceipt)), policyHash: hash(stable(input.policy)), outputContractHash: hash(stable(input.outputContract)) };
    return { binding: { projectId: input.projectId, epoch: input.epoch, fingerprint, contextSnapshotId: context.id, sourceRefs: materials.map(item => item.ref), sourceManifest }, context, materials };
}
export function rebuildGenerationSourceBinding(deps: GenerationSourceBindingDependencies, previous: RunBinding, nextEpoch: string, modelReceipt?: SafeGenerationModelReceipt, policy?: Readonly<Record<string, unknown>>, outputContract?: GenerationSourceBindingInput['outputContract']): GenerationSourceBindingResult {
    const manifest = previous.sourceManifest as unknown as GenerationSourceBindingInput & {
        version: number;
    };
    if (manifest.version !== 1)
        fail('GENERATION_SOURCE_MANIFEST_INVALID');
    return buildGenerationSourceBinding(deps, { ...manifest, projectId: previous.projectId, epoch: nextEpoch, modelReceipt: modelReceipt ?? manifest.modelReceipt, policy: policy ?? manifest.policy, outputContract: outputContract ?? manifest.outputContract });
}
export function compareGenerationSourceBindings(previous: RunBinding, next: RunBinding): boolean {
    return previous.projectId === next.projectId && isDeepStrictEqual(previous.fingerprint, next.fingerprint) && previous.contextSnapshotId === next.contextSnapshotId && isDeepStrictEqual(previous.sourceManifest, next.sourceManifest)
        && isDeepStrictEqual(previous.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; }), next.sourceRefs.map(ref => { const copy: Partial<SourceRef> = { ...ref }; delete copy.epoch; return copy; }));
}
