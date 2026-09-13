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
import type { GenerationAuthorInput, GenerationBatchIntent } from '../../src/shared/generation-owner-contract';
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge';
import type { ReviewRevisionContext } from '../../src/shared/review-revision-generation';
import { captureReviewRevisionContext, reviewRevisionRequest } from './review-revision-context';
import type { AgentGenerationInput } from '../../src/shared/agent-generation';
import { buildAgentGenerationContext, validateAgentGenerationInput } from './agent-generation-context';
import type { ImportGenerationSlot } from '../../src/shared/import-generation';
import { captureImportGenerationContext, importGenerationSlotKey } from './import-generation-source';
import type { EditorInlineInput } from '../../src/shared/editor-inline-generation';
import { buildEditorInlineContext, validateEditorInlineInput, editorInlineTask } from './editor-inline-generation';
import type { FinalizationGenerationContext, FinalizationGenerationSlot } from '../../src/shared/finalization-generation';
import { captureFinalizationGenerationContext, finalizationSlotKey, finalizationGenerationTask } from './finalization-generation-source';
import type { GraphGenerationContext, GraphGenerationInput } from '../../src/shared/graph-generation';
import { captureGraphGenerationContext, graphGenerationTask, validateGraphGenerationInput } from './graph-generation-source';
import { provenGraphOwnEventIds } from './graph-generation';
import type { LegacyRosterGenerationContext } from '../../src/shared/legacy-roster-generation';
import { captureLegacyRosterGenerationContext, legacyRosterGenerationTask } from './legacy-roster-generation-context';
export type SafeGenerationModelReceipt = Omit<ModelExecutionLeaseReceipt, 'leaseId' | 'createdAt' | 'expiresAt'>;
export interface GenerationSourceBindingInput {
    projectId: string;
    epoch: string;
    operation: string;
    chapterNumber?: number;
    selectedDraftIds: readonly number[];
    selectedFinalizedDraftIds: readonly number[];
    selectedBlueprintChapterNumbers?: readonly number[];
    promptKeys: readonly string[];
    skillStages: readonly WritingSkillStage[];
    authorInputs?: readonly GenerationAuthorInput[];
    batchId?: string;
    batchIntent?: GenerationBatchIntent;
    knowledgeSnapshot?: GenerationKnowledgeSnapshot;
    /** Injected only after the owner admits a main-issued finalized identity context. */
    finalizedCharacterContextHash?: string;
    /** Main-issued inputs persisted so recovery can revalidate the original selection. */
    reviewRevisionContext?: ReviewRevisionContext;
    /** Internal Agent admission input; never accepted through generic generation:begin. */
    agentInput?: AgentGenerationInput;
    agentSession?: { key: string; roundIndex: number };
    agentWorkflowRegistrationId?: string;
    importSlot?: ImportGenerationSlot;
    editorInlineInput?: EditorInlineInput;
    /** Main freezes the initial identity for lost-response navigation across resume. */
    editorInlineOriginEpoch?: string;
    finalizationGenerationSlot?: FinalizationGenerationSlot;
    finalizationGenerationContext?: FinalizationGenerationContext;
    graphGenerationInput?: GraphGenerationInput;
    graphGenerationKey?: string;
    graphGenerationContext?: GraphGenerationContext;
    legacyRosterKey?: string;
    legacyRosterContext?: LegacyRosterGenerationContext;
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
function freezeAuthorInputs(value: unknown): GenerationAuthorInput[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) fail('GENERATION_AUTHOR_INPUT_INVALID');
    let bytes = 0;
    const ids = new Set<string>();
    return value.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).some(key => key !== 'id' && key !== 'text')
            || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(item.id)
            || ids.has(item.id) || typeof item.text !== 'string')
            fail('GENERATION_AUTHOR_INPUT_INVALID');
        ids.add(item.id);
        bytes += Buffer.byteLength(item.text, 'utf8');
        if (bytes > 8 * 1024 * 1024) fail('GENERATION_AUTHOR_INPUT_TOO_LARGE');
        return { id: item.id, text: item.text };
    });
}
export function buildGenerationSourceBinding(deps: GenerationSourceBindingDependencies, input: GenerationSourceBindingInput): GenerationSourceBindingResult {
    if (!deps.db.open || !input.projectId || !input.epoch || !input.operation)
        fail('GENERATION_SOURCE_BINDING_INVALID');
    if (!Array.isArray(input.promptKeys) || input.promptKeys.length === 0)
        fail('GENERATION_PROMPT_SELECTION_REQUIRED');
    const agentInput = input.agentInput ? validateAgentGenerationInput(input.agentInput) : undefined;
    const editorInlineInput = input.editorInlineInput ? validateEditorInlineInput(input.editorInlineInput) : undefined;
    const graphInput = input.graphGenerationInput ? validateGraphGenerationInput(input.graphGenerationInput) : undefined;
    if (input.legacyRosterKey && (input.operation !== 'legacy-character-roster-repair' || !isDeepStrictEqual(input.promptKeys, ['legacy-roster'])
        || input.skillStages.length || input.selectedDraftIds.length || input.selectedFinalizedDraftIds.length || input.chapterNumber !== undefined
        || input.authorInputs?.length || graphInput)) fail('GENERATION_LEGACY_SELECTION_INVALID');
    if (graphInput && (input.operation !== ({ plot: 'plot-tree-snapshot', plan: 'narrative-thread-plan-candidate', event: 'narrative-thread-event-candidate' } as const)[graphInput.kind]
        || !input.graphGenerationKey || !isDeepStrictEqual(input.promptKeys, [`graph-${graphInput.kind}`]) || input.skillStages.length
        || input.selectedDraftIds.length || input.selectedFinalizedDraftIds.length || input.chapterNumber !== undefined || input.authorInputs?.length)) fail('GENERATION_GRAPH_SELECTION_INVALID');
    const authorInputs = freezeAuthorInputs(input.authorInputs);
    const blueprintChapters = input.selectedBlueprintChapterNumbers ?? [];
    if (!Array.isArray(blueprintChapters) || blueprintChapters.length > 10_000 || new Set(blueprintChapters).size !== blueprintChapters.length
        || blueprintChapters.some(chapter => !Number.isSafeInteger(chapter) || chapter < 1))
        fail('GENERATION_BLUEPRINT_SELECTION_INVALID');
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
    for (const item of authorInputs)
        add(`author-action:${item.id}`, 0, item.text, 'author-constraint', 'explicit immutable author input for this action; not a database or file identity');
    let graphContext: GraphGenerationContext | undefined;
    let legacyContext: LegacyRosterGenerationContext | undefined;
    // SQLite supplies one read transaction; filesystem selections are read twice below.
    const facts = deps.db.transaction(() => {
        const raw = deps.db.prepare("SELECT * FROM project_core WHERE id='main'").get() as Record<string, unknown> | undefined;
        if (!raw)
            fail('GENERATION_PROJECT_CORE_MISSING');
        const core = without(raw, ['created_at', 'updated_at', 'character_states', 'plot_tree_snapshot']);
        const language: WritingLanguage = core.writing_language === 'en-US' ? 'en-US' : 'zh-CN';
        add('project-core:main', 0, stable(core), 'author-constraint', 'current project settings');
        if (input.legacyRosterKey) {
            legacyContext = captureLegacyRosterGenerationContext(deps.db, input, input.legacyRosterKey, input.legacyRosterContext);
            add('legacy-roster-context', 0, JSON.stringify(legacyContext), 'author-constraint', 'actual preserved legacy evidence and identity baseline');
        }
        if (graphInput) {
            graphContext = captureGraphGenerationContext(deps.db, graphInput, input, input.graphGenerationKey!, input.graphGenerationContext,
                input.graphGenerationContext ? provenGraphOwnEventIds(deps.db, input.graphGenerationContext) : []);
            add('graph-generation-context', 0, JSON.stringify(graphContext), 'author-constraint', 'main captured graph sources and original target baseline');
        }
        if (agentInput) {
            const blueprints = deps.db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all() as Record<string, unknown>[];
            add('agent-blueprints:all', 0, stable(blueprints.map(row => without(row, ['created_at', 'updated_at', 'notes_updated_at']))), 'unconfirmed-continuity', 'actual author plans guarded across Agent tool confirmations');
        }
        if (input.reviewRevisionContext) {
            const currentContext = captureReviewRevisionContext(deps.db, reviewRevisionRequest(input.reviewRevisionContext));
            if (!isDeepStrictEqual(input.reviewRevisionContext, currentContext)) fail('GENERATION_REVIEW_CONTEXT_CHANGED');
            add('review-revision-context', 0, JSON.stringify(currentContext), 'author-constraint', 'main-verified frozen manuscript, author decisions and review material');
        }
        if (input.operation === 'chapter-draft') {
            const characters = deps.db.prepare('SELECT * FROM characters ORDER BY character_id').all() as Record<string, unknown>[];
            add('characters:all', 0, stable(characters.map(row => without(row, ['created_at', 'updated_at']))), 'author-constraint', 'current structured character facts consumed by drafting');
            const relationships = deps.db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all() as Record<string, unknown>[];
            add('character-relationships:all', 0, stable(relationships.map(row => without(row, ['created_at', 'updated_at']))), 'author-constraint', 'current identity relationships projected into character profiles');
            const plans = deps.db.prepare('SELECT * FROM narrative_thread_plans ORDER BY id').all() as Record<string, unknown>[];
            const events = deps.db.prepare("SELECT c.id,c.plan_id,c.draft_id,c.event_type,c.evidence,c.reason,d.chapter_number,o.chapter_title FROM narrative_thread_confirmations c JOIN drafts d ON d.id=c.draft_id AND d.status='finalized' JOIN finalization_outbox o ON o.draft_id=d.id ORDER BY d.chapter_number,c.id").all();
            add('narrative-thread-context:all', 0, stable({ plans: plans.map(row => without(row, ['created_at', 'updated_at'])), events }), 'unconfirmed-continuity', 'author plans and confirmed event evidence used to select active narrative context');
            const currentDraft = deps.db.prepare('SELECT d.id,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC,d.id DESC LIMIT 1').get(input.chapterNumber) ?? null;
            add(`draft-target:${input.chapterNumber}`, 0, stable(currentDraft), 'author-constraint', 'prevent a later draft or author edit from being silently superseded');
            const catalog = deps.db.prepare("SELECT d.id,d.chapter_number,d.version,d.status,c.body,o.finalization_id,o.content_hash,o.content_snapshot FROM drafts d JOIN contents c ON c.id=d.content_id LEFT JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.chapter_number < ? AND (d.status='finalized' OR NOT EXISTS (SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status IN ('draft','revised','finalized') AND newer.version>d.version)) ORDER BY d.id").all(input.chapterNumber) as Record<string, unknown>[];
            add('draft-continuity-catalog', 0, stable(catalog.map(row => ({ ...without(row, ['body', 'content_snapshot']), bodyHash: hash(String(row.body)), snapshotHash: row.content_snapshot === null ? null : hash(String(row.content_snapshot)) }))), 'unconfirmed-continuity', 'source catalog frozen before renderer selects continuity material');
            const locators = deps.db.prepare('SELECT * FROM summary_snapshots WHERE draft_id IS NOT NULL AND chapter_number < ? ORDER BY draft_id,id').all(input.chapterNumber) as Record<string, unknown>[];
            const watermark = deps.db.prepare("SELECT * FROM continuity_projection_meta WHERE id='main'").get();
            add('continuity-locators', 0, stable({ rows: locators.map(row => without(row, ['created_at', 'character_states'])), watermark }), 'unconfirmed-continuity', 'derived locators and invalidation watermark; never promoted to author facts');
        }
        let brief: Record<string, unknown> | null = null;
        if (input.chapterNumber !== undefined) {
            const row = deps.db.prepare('SELECT * FROM blueprints WHERE chapter_number=?').get(input.chapterNumber) as Record<string, unknown> | undefined;
            if (!row && !input.reviewRevisionContext && !input.finalizationGenerationSlot)
                fail('GENERATION_CHAPTER_MISSING');
            brief = row ? without(row, ['created_at', 'updated_at', 'notes', 'notes_updated_at']) : null;
            add(`blueprint:${input.chapterNumber}`, 0, stable(brief), 'author-constraint', 'selected chapter brief');
        }
        for (const chapter of blueprintChapters) {
            if (chapter === input.chapterNumber) continue;
            const row = deps.db.prepare('SELECT * FROM blueprints WHERE chapter_number=?').get(chapter) as Record<string, unknown> | undefined;
            // A requested empty slot is evidence too: later creation must invalidate this snapshot.
            add(`blueprint:${chapter}`, 0, stable(row ? without(row, ['created_at', 'updated_at', 'notes', 'notes_updated_at']) : null),
                'author-constraint', 'explicit planning range; current row or absent slot');
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
                if (input.operation === 'chapter-draft' && row.chapter_number >= input.chapterNumber!)
                    fail('GENERATION_DRAFT_CONTINUITY_RANGE_INVALID');
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
    const guidanceNames = (): string[] => {
        const directory = path.join(deps.projectStorageRoot, 'prompts');
        if (!fs.existsSync(directory)) return [];
        if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('GENERATION_ASSET_UNSAFE');
        return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => !entry.isDirectory() && entry.name.endsWith('.md')).map(entry => entry.name).sort();
    };
    const selectedGuidance = input.operation === 'chapter-draft' ? guidanceNames() : [];
    for (const name of selectedGuidance) {
        const bytes = observe(deps.projectStorageRoot, `prompts/${name}`)!;
        assets.push({ scope: 'project-guidance', identity: name, hash: hash(bytes) });
        add(`project-guidance:${name}`, 0, bytes.toString('utf8'), 'author-constraint', 'project Markdown guidance consumed by drafting');
    }
    let agentPrompt: { selected: string; builtin: string } | undefined;
    const importPrompts: Record<string, import('../../src/services/prompt-templates').PromptTemplate> = {};
    for (const key of input.promptKeys) {
        if (legacyContext) {
            assets.push({ scope: 'builtin', identity: `prompt:${key}:${facts.language}`, hash: hash(JSON.stringify(legacyRosterGenerationTask(legacyContext))) });
            continue;
        }
        if (graphContext) {
            assets.push({ scope: 'builtin', identity: `prompt:${key}:${facts.language}`, hash: hash(JSON.stringify(graphGenerationTask(graphContext))) });
            continue;
        }
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
        if (agentInput && key === 'assistant_writing_identity') agentPrompt = { selected: selected?.toString('utf8') ?? builtin, builtin };
        if (input.importSlot || editorInlineInput || input.finalizationGenerationSlot) importPrompts[key] = JSON.parse(selected?.toString('utf8') ?? builtin);
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
    if (input.operation === 'chapter-draft' && !isDeepStrictEqual(selectedGuidance, guidanceNames())) fail('GENERATION_ASSET_CHANGED_DURING_SNAPSHOT');
    if (input.knowledgeSnapshot) {
        add('knowledge-selection', 0, stable(input.knowledgeSnapshot), 'unconfirmed-continuity', 'main-verified immutable knowledge selection and source identities');
        for (const item of input.knowledgeSnapshot.items) add(`kb:${item.documentId}:${item.chunkId}`, item.revision, item.text, 'unconfirmed-continuity', 'verified original knowledge passage');
    }
    const agentContext = agentInput && agentPrompt ? buildAgentGenerationContext(agentInput, facts.core, facts.language, agentPrompt.selected, agentPrompt.builtin) : undefined;
    const editorInlineContext = editorInlineInput ? buildEditorInlineContext(editorInlineInput, facts.language, importPrompts.edit_selected_text!) : undefined;
    const finalizationContext = input.finalizationGenerationSlot ? captureFinalizationGenerationContext(deps.db, input.finalizationGenerationSlot, input, facts.language,
        importPrompts[input.finalizationGenerationSlot.stepKey === 'chapter_notes' ? 'generate_chapter_notes' : 'update_character_cards']!, input.finalizationGenerationContext) : undefined;
    if (finalizationContext) add('finalization-generation-context', 0, JSON.stringify(finalizationContext), 'finalized-fact', 'main captured finalization identity, original field baselines and selected prompt');
    if (editorInlineContext) add('editor-inline:author-draft', 0, JSON.stringify(editorInlineContext), 'author-constraint', 'explicit unsaved author manuscript and UTF16 selection; not a canonical document');
    const importContext = input.importSlot ? captureImportGenerationContext(deps.db, input.importSlot) : undefined;
    if (importContext) importContext.prompts = importPrompts;
    if (importContext) add(`import-manifest:${importGenerationSlotKey(importContext.slot)}`, 0, stable(importContext), 'unconfirmed-continuity', 'persisted reference import material for this exact checkpoint');
    if (agentInput && !agentContext) fail('GENERATION_AGENT_PROMPT_REQUIRED');
    if (agentContext) add('agent-context', 0, JSON.stringify(agentContext), 'author-constraint', 'explicit conversation and tool definitions with main-read project facts and identity template');
    if (deps.db.pragma('data_version', { simple: true }) !== dataVersion || deps.db.prepare('SELECT total_changes()').pluck().get() !== changes)
        fail('GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT');
    const sourceManifest = { version: 1, ...(input.finalizedCharacterContextHash ? { finalizedCharacterContextHash: input.finalizedCharacterContextHash } : {}), operation: input.operation, ...(input.knowledgeSnapshot ? { knowledgeSnapshot: structuredClone(input.knowledgeSnapshot) } : {}), ...(input.batchId ? { batchId: input.batchId } : {}), ...(input.batchIntent ? { batchIntent: structuredClone(input.batchIntent) } : {}), ...(input.chapterNumber !== undefined ? { chapterNumber: input.chapterNumber } : {}), selectedDraftIds: [...input.selectedDraftIds], selectedFinalizedDraftIds: [...input.selectedFinalizedDraftIds], ...(blueprintChapters.length ? { selectedBlueprintChapterNumbers: [...blueprintChapters] } : {}), promptKeys: [...input.promptKeys], skillStages: [...input.skillStages], ...(authorInputs.length ? { authorInputs } : {}), modelReceipt, policy: input.policy, outputContract: input.outputContract };
    if (input.reviewRevisionContext) Object.assign(sourceManifest, { reviewRevisionContext: structuredClone(input.reviewRevisionContext), reviewRevisionContextHash: hash(JSON.stringify(input.reviewRevisionContext)) });
    if (legacyContext) {
        const task = legacyRosterGenerationTask(legacyContext);
        Object.assign(sourceManifest, { legacyRosterKey: legacyContext.key, legacyRosterContext: legacyContext, legacyRosterContextHash: hash(JSON.stringify(legacyContext)),
            legacyRosterOriginEpoch: legacyContext.originEpoch, legacyRosterTask: task, legacyRosterTaskHash: hash(JSON.stringify(task)) });
    }
    if (graphContext) {
        const task = graphGenerationTask(graphContext);
        Object.assign(sourceManifest, { graphGenerationInput: graphContext.input, graphGenerationKey: graphContext.key,
            graphGenerationContext: graphContext, graphGenerationContextHash: hash(JSON.stringify(graphContext)), graphGenerationOriginEpoch: graphContext.originEpoch,
            graphGenerationTask: task, graphGenerationTaskHash: hash(JSON.stringify(task)) });
    }
    if (finalizationContext) {
        const task = finalizationGenerationTask(finalizationContext);
        Object.assign(sourceManifest, { finalizationGenerationSlot: finalizationContext.slot, finalizationGenerationSlotKey: finalizationSlotKey(finalizationContext.slot),
            finalizationGenerationContext: finalizationContext, finalizationGenerationContextHash: hash(JSON.stringify(finalizationContext)), finalizationGenerationOriginEpoch: finalizationContext.identity.epoch,
            finalizationGenerationTask: task, finalizationGenerationTaskHash: hash(JSON.stringify(task)) });
    }
    if (agentContext) Object.assign(sourceManifest, { agentInput, agentContext, agentContextHash: hash(JSON.stringify(agentContext)), ...(input.agentSession ? { agentSession: structuredClone(input.agentSession) } : {}) });
    if (input.agentWorkflowRegistrationId) Object.assign(sourceManifest, { agentWorkflowRegistrationId: input.agentWorkflowRegistrationId });
    if (editorInlineContext) {
        const task = editorInlineTask(editorInlineContext);
        Object.assign(sourceManifest, { editorInlineInput, editorInlineOriginEpoch: input.editorInlineOriginEpoch ?? input.epoch, editorInlineContext, editorInlineContextHash: hash(JSON.stringify(editorInlineContext)), editorInlineTask: task, editorInlineTaskHash: hash(JSON.stringify(task)) });
    }
    if (importContext) Object.assign(sourceManifest, { importSlot: importContext.slot, importSlotKey: importGenerationSlotKey(importContext.slot), importContext });
    const contextHash = hash(stable(contextSources.map(({ ref, ...entry }) => ({ ...entry, ref: without(ref as unknown as Record<string, unknown>, ['epoch']) }))));
    const context: ContextSnapshot = { projectId: input.projectId, epoch: input.epoch, id: `context:${contextHash}`, hash: contextHash, sources: contextSources, omissions: [], estimate: { methodVersion: 'utf8-bytes-v1', inputUnits: materials.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) } };
    const fingerprint = { chapterBriefHash: hash(stable(facts.brief)), authorGuidanceHash: hash(stable(authorInputs.length ? [facts.core, authorInputs] : facts.core)), dependencyHash: hash(stable(materials.filter(item => /^(draft|finalized):/.test(item.ref.sourceId)).map(item => ({ ...item.ref, epoch: undefined })))), contextSnapshotHash: contextHash, templateHash: hash(stable(assets)), skillSnapshotHash: hash(stable(skills)), modelLeaseRevision: hash(stable(modelReceipt)), policyHash: hash(stable(input.policy)), outputContractHash: hash(stable(input.outputContract)) };
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
