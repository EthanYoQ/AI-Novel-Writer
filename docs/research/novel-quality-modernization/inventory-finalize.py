"""Finalize S00 source-ledger annotations from private read-only receipts. No network or model calls."""
import json,pathlib,re,hashlib,datetime,collections,subprocess
R=pathlib.Path.cwd(); O=R/'docs/research/novel-quality-modernization'; P=R/'.runtime/.cache/novel-quality-modernization'
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
def save(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
d=read(O/'donor-delta.json'); inv=read(O/'inventory.json'); union=read(R/'docs/plans/novel-quality-program-v3-2026-09-13/feature-union.json'); acts={f['id']:[a['actionId'] for a in f['actions']] for f in union['features']}
for row in d['differences']:
 p=row['path']; s=p.lower()
 if s.startswith(('.release/','.github/','scripts/')): row.update(classification='test-tooling',owner='S01',reason='Keep current release/CI/tool contract; S13/S14A adapt and freeze before qualification. No donor rollback.')
 if 'live-preview' in s: row.update(owner='F04',reason='Preserve actual live Markdown preview, IME, selection and drop caps; meet editor absolute and relative performance gates.',featureActionIds=acts['U06'])
 if 'architecture-workflow' in s or '/architecture.command' in s: row.update(owner='S06A',featureActionIds=acts['U04']+acts['U13'])
 if 'project-controller' in s or 'project-clear-repository' in s or 'windows-safe-file-system' in s: row.update(owner='S01',classification='interface-adaptation',reason='Retain current authorization/session/delete safety. Central owner adapts donor peek via recent-project capability; no arbitrary-path or writable fallback.')
 if p=='public/fonts/YiShanBeiZhuanTi.ttf': row.update(classification='pending-license',owner='F02',reason='Added font is not covered by the four named families in THIRD_PARTY_NOTICES.md; verify provenance and license or substitute compatible typography before release.')
 if p=='src/main.tsx': row.update(classification='interface-adaptation',owner='S01',reason='Central renderer bootstrap owner preserves canonical facade, migration-ready and appearance hydration before mounting.')
 if p=='vitest.browser.config.ts': row.update(classification='test-tooling',owner='S01',reason='Retain current real-browser runner; adapt donor regression inputs before UI qualification.')
 if row['classification']=='pending-review':
  row.update(classification='interface-adaptation',reason='Retain current behavior and selectively adapt donor presentation/interaction; exact line review and action receipt remain required before adoption.')
 if '__tests__/' in s or '.test.' in s or '.browser.' in s: row['classification']='test-tooling'
 row['gates']=sorted(set(row['gates']+(['C07','C08','C09'] if row['classification']=='persistent-asset-schema' else [])+(['license-provenance-before-release'] if row['classification']=='pending-license' else [])))
 h=row['hashes']; row['deltaKind']='donor-only' if not h['currentMaster'] and h['donor'] else 'current-only' if h['currentMaster'] and not h['donor'] else 'current-equals-v110' if h['currentMaster']==h['v110'] else 'donor-equals-v110' if h['donor']==h['v110'] else 'three-way-change'
 row['sourceEvidence']=['docs/plans/novel-quality-program-v3-2026-09-13/evidence/donor-feature-union.md','docs/plans/novel-quality-program-v3-2026-09-13/05-INTEGRATION-CONTRACT.md#c12贡献者增量逐项处置']
d['counts']['classifications']=dict(collections.Counter(x['classification'] for x in d['differences']))
d['handoffIntegration']={'pr':229,'state':'MERGED','currentIncludesHandoff':True,'action':'Do not port the already merged world-building recovery changes again.'}
d['licenseReview']=[{'path':r['path'],'sha256':r['hashes']['donor'],'status':'unknown-provenance-blocks-this-asset-release','owner':'F02','equivalentFunctionRequired':True} for r in d['differences'] if r['classification']=='pending-license']
save(O/'donor-delta.json',d)
consumers=[
 ('global-config','electron/utils/config-utils.ts',['VELA_HOME','ensureVelaHome','GLOBAL_CONFIG_PATH','MODELS_CONFIG_PATH','RECENT_PROJECTS_PATH'],['electron/ipc-handlers.ts','electron/controllers/config-controller.ts','electron/controllers/app-data-controller.ts','electron/controllers/llm-controller.ts','electron/controllers/kb-controller.ts','electron/i18n.ts'],'S03','Start coordinator before config/model/skin/MCP/update writes; migrate one generation and default-model references.','cg0'),
 ('project-db','electron/database.ts',['getProjectDb'],['electron/controllers/import-controller.ts','electron/controllers/project-controller.ts','electron/knowledge-base.ts','electron/repositories/blueprint-repository.ts'],'S04','S01 owns schema lane; snapshot WAL consistently, preserve all author/current/candidate/outbox records.','storage'),
 ('vector-canonical','electron/vector-store.ts',['getEmbeddingSpaces','getCanonicalChunksForEmbeddingRebuild','planEmbeddingRebuild','rebuildPlannedEmbeddingSpace'],['electron/knowledge-base.ts','electron/services/release-vector-smoke.ts'],'S04','Preserve canonical text and corpus metadata before declaring embedding generations stale; no automatic paid rebuild.','vectors'),
 ('skin','electron/services/skin-service.ts',['SkinService'],['electron/controllers/skin-controller.ts','electron/ipc-handlers.ts','electron/services/release-skin-smoke.ts'],'S03','Keep main state/assets single writer; renderer appearance owner F01 only composes snapshot.','assets'),
 ('mcp','electron/mcp/mcp-manager.ts',['MCPManagerImpl','mcpManager','initializeSession'],['electron/mcp/mcp-ipc-bridge.ts'],'S03','Migrate config with secret handling, rename protocol identity deliberately, never execute imported server config automatically.','assets'),
 ('writing-skills','src/services/agent/skill-registry.ts',['LoadedSkill','loadProjectSkills','loadUserSkills','registerBuiltinSkills','loadAllAtomic'],['src/components/settings/SkillSettings.tsx','src/components/panels/agent/AgentHeader.tsx','src/services/agent/intent-router.ts','src/stores/agent-store.ts'],'S04','Preserve Skill bytes, identifiers and binding; no Skill script execution or dead-file claim from lexical absence.','dynamic'),
 ('architecture-recovery','src/services/workflows/architecture-workflow.ts',['createArchitectureWorkflow'],['src/services/workflows/commands/architecture.command.ts'],'S06A','Retain current frozen session/source and partial world-building/synopsis recovery behavior; migrate fragments as candidates only.','recovery')]
graph=read(P/'codegraph-summaries.json')
inv['behaviorConsumers']=[{'id':i,'source':src,'symbols':syms,'consumerFiles':cs,'owner':owner,'disposition':disp,'evidenceLevel':'codegraph-source-call-path','graphQueryId':q,'graphSummarySha256':hashlib.sha256(graph[q].encode()).hexdigest(),'acceptance':'not-run'} for i,src,syms,cs,owner,disp,q in consumers]
inv['otherVerifiedSourceConsumers']=[{'source':'src/services/agent/writing-skill-bindings.ts','symbols':['bindingPath','saveWritingSkillBinding','freezeWritingSkillsSnapshot'],'consumer':'src/stores/workflow-store.ts','owner':'S04','evidence':'CodeGraph source lines 30-32,57-180; binding version 1; real save and freeze consumers.'},{'source':'electron/services/update-preferences-store.ts','symbols':['GlobalConfigUpdatePreferencesStore'],'consumer':'electron/main.ts','owner':'S03','evidence':'CodeGraph read/write paths to GLOBAL_CONFIG_PATH; malformed config refuses overwrite.'}]
inv['dynamicConsumerReview']={'queried':['skill-registry.ts','import.meta.glob','ActivityBar'],'result':'CodeGraph shows Skill loader dynamic paths and ActivityBar outgoing calls; no complete incoming import/barrel/glob/build-zero proof collected.','owner':'S13','deadCodeEligible':False}
inv['allConsumersVerified']=False
inv['remainingBoundaries']=['217 lexical files are enumerated; grouped verified consumer paths are not a proof of exhaustive incoming edges for every file. S02/S13 must close individual replacement/legacy receipts.','Asset classification describes known storage classes, not a scan of real user/global directories.','No deterministic model, Electron, browser, migration, installed-product or release acceptance executed by this inventory task.']
save(O/'inventory.json',inv)
asset_specs=[
 ('project-manifest','project','project manifest','S04','M00','migrate','Identity/schema/layout probe and new generation; preserve project ID for upgrade, new ID for portable copy.'),
 ('sqlite-db-wal','project','.vela/vela.db and WAL/SHM','S04','M00-M05 via S01 registry','migrate','SQLite backup with exclusive writer checks; integrity/foreign keys/row counts and raw author hashes; do not copy live WAL.'),
 ('formal-content','project','SQLite authoritative manuscript and outbox records','S04','M00/M01','migrate','Preserve finalization/source and manuscript bytes; portable import carries readable authority, never old execution authority.'),
 ('characters-provenance','project','SQLite character facts, relations and source metadata','S08','M02','migrate','Stable IDs, ambiguity proposals, author/derived distinction; S09 owns derived changes.'),
 ('canonical-lance-text','project','.vela/lancedb canonical chunks/documents','S04','M00 storage conversion','migrate','Preserve IDs/document+chunk counts/text UTF-8 hashes/corpus kind even if source PDF was deleted; FTS-only corpus included.'),
 ('embedding-generations','project','.vela/lancedb/chunks__space_*','S04','embedding generation separate from DB schema','migrate-or-stale','Canonical text first; verify compatible spaces, stale incompatible indexes; never automatic model/embedding payment.'),
 ('embedding-registry','project','.vela/embedding-spaces.json','S04','embedding generation','migrate','Validate registry-to-space linkage, dimensions and active status; preserve non-rebuildable evidence.'),
 ('legacy-vectors','project','vectors.json and vector migration journal','S04','legacy fingerprint required','blocked-if-partial','Resolve half-migration from receipts; do not guess-merge duplicate sources.'),
 ('project-prompts','project','.vela/prompts/**','S04','raw-file assets','migrate','Preserve raw bytes and frozen workflow binding; do not rewrite author prompt text for brand rename.'),
 ('global-prompts','global','legacy global prompts/**','S03','global generation','migrate','Preserve raw bytes and template references; malformed/unknown items preserved, not default-overwritten.'),
 ('project-skills','project','project Skill files and .vela/writing-skills.json','S04','writing-skills binding version 1','migrate','Preserve files/bindings/stage frozen content; validate IDs, never execute scripts during conversion.'),
 ('global-skills','global','user Skill directories','S03','raw-file assets','migrate','Preserve bytes and references, remap locator under startup gate; unknown files backup-only.'),
 ('partial-architecture','project','partial_arch and visible recovery/checkpoint payloads','S04','M01','candidate-only','Preserve view/copy; unknown lineage/source becomes conflict candidate; never formal-table admission.'),
 ('run-import-history','project','run/attempt/import receipts, chapter parameters and UI recoverable state','S04','M01/M04','migrate','Classify persistent safety receipts separately from cache; restored portable copy cannot auto-resume tasks/outbox.'),
 ('global-model-config','global','config.json and models.json','S03','single global generation','migrate-private','Validate default model references; secrets stay local and excluded from hashes/public receipts/portable archive.'),
 ('recent-projects','global','recent-projects.json','S03','global generation','migrate-private','Preserve navigation with capability reauthorization; machine paths never public or portable grants.'),
 ('mcp-config','global','MCP server configuration','S03','global generation','migrate-private','Preserve configuration locally without launching scripts; secret env/URL credentials excluded from portable archive.'),
 ('skin-assets','global','SkinService persisted state and imported background files','S03','SkinService generation','migrate','Preserve state plus original images; main owns writes, F01 combines read-only revision; no scanning external symlinks.'),
 ('update-preferences','global','config.json updatePreferences and updater state','S03','global generation','migrate-private','Retain valid preferences and necessary safety receipts; transient downloads may rebuild only after classification.'),
 ('appearance','renderer','ai-novel-writer-theme / ai-novel-writer-ui-version','F01','AppearanceProfile revision','migrate','Preserve explicit shell/color/font/zoom; donor fontDefaultsVersion is provenance, not permission to replace author fonts.'),
 ('donor-avatar-files','project','.vela/avatars/**','F03','M05','migrate','Stable character ID mapping from verified DB association; preserve original bytes including orphans/conflicts; no name guessing.'),
 ('donor-avatar-column','project','donor SQLite characters.avatar variants','F03','M05','migrate-or-block','Known source fingerprints only; S04 verified staging invocation with S01 registered M05; no opportunistic ALTER TABLE.'),
 ('donor-overview-cache','renderer','vela:overview:*','F04','renderer cache','rebuild','Retire private persisted path/excerpt cache; authorized in-memory real statistics only; never treat cache as author truth.'),
 ('portable-archive','future-project','B01 versioned archive manifest/DB/assets','B01','C17 signed allowlist by S01','not-yet-present','Allowlist each table/field; preserve author/derived current readable authority through transfer receipt; exclude grants/leases/secrets/auto-run.'),
 ('webdav-binding','future-global','B02 OS secret store and cloud-book generation binding','B02','C18 local binding revision','not-yet-present','Immutable remote generation/completion descriptor; no inherited remote grants; session-only secrets if OS store unavailable.'),
 ('unknown-files','all','unclassified files/links','S04','unknown','legacy-backup-only','Preserve isolated backup without delete/execute/following links; required external-link assets block migration.'),
 ('proven-dead-assets','all','source files/assets with verified zero consumer','S13','not applicable','blocked-until-proof','No entries currently certified dead; require import/dynamic/barrel/glob/Storybook/build proof before deletion.')]
assets=[{'id':i,'scope':scope,'locatorPattern':loc,'assetMigrationOwner':owner,'schemaOwner':'S01','schemaLane':schema,'disposition':disp,'rule':rule,'runtimePresence':'not-scanned-author-data','fixtureAcceptance':'not-run','portableOwner':'B01','gates':['C09','C08','C17']} for i,scope,loc,owner,schema,disp,rule in asset_specs]
# Explicit source schema names for the single schema owner; no DB contents are read.
src=(R/'electron/database.ts').read_text(encoding='utf-8'); tables=sorted(set(re.findall(r'CREATE TABLE IF NOT EXISTS\s+(\w+)',src,re.I)))
save(O/'asset-disposition.json',{'schemaVersion':1,'specId':'S00','baseSha':d['baseSha'],'status':'source-classification-complete-runtime-and-portable-field-approval-pending','assets':assets,'sourceSchemaTables':[{'table':t,'schemaOwner':'S01','upgradeOwner':'S04','portableFieldAllowlistStatus':'pending-S01-signature','unknownColumns':'block portable export; preserve source'} for t in tables],'licenseAssets':d['licenseReview'],'mandatoryBeforeSwitch':['Every actual root occurrence mapped to one asset row; unknown preserved backup-only.','S01 must sign per-field portable allowlist; this table-name list is not authorization to export all columns.','S04 must prove synthetic fixtures for each asset and no real-user directory reads/writes.','F03 M05 avatar fixtures mandatory before final upgrade qualification.'],'rawAuthorDataRead':False,'runtimeMigrationExecuted':False})
issue_defs={187:('输出长度中断',['审稿约8K输出中断','目录蓝图约4K中断','compact-single约4K中断','最新反馈仍可复现'],'S07',[229]),191:('自动角色卡与随剧情补充',['从文本/大纲自动生成人物卡','卡片可编辑','情节推进自动新增关键信息'],'S09B',[]),199:('大纲范围与截断恢复',['选择本次章节范围','截断保留未完成内容','安全续批且不覆盖后来编辑','坏检查点/源变化/取消/切项目拒写'],'S06A',[201]),205:('连续性v2',['author/derived来源分离','候选/定稿与必需材料','逐目标审稿与unknown','两种批量模式与取消/提交语义'],'S10B',[208]),211:('角色图谱保存和导入',['真实协议图谱只读','保存失败可见且保稿','角色卡粘贴/文件导入确认','无模型/取消/切项目保留正确状态'],'S09C',[212]),213:('手动云存档',['跨设备完整项目归档/恢复新副本','手动WebDAV上传列表下载','保全头像和原稿且不携带权限/秘密'],'B02',[]),219:('生成角色图谱报告缺主角',['生成过程报未生成主角','区分模型遗漏/解析/身份/保存/刷新'],'S06A',[]),221:('多余角色和跨章重复',['蓝图生成后角色库出现未知角色','已有3章时第4章大量复述第3章'],'S10B',[]),222:('ActivityBar残留',['移除真正无消费者组件','清理历史注释'],'S13',[223]),224:('设置弹窗白屏',['工具栏设置入口白屏','状态栏设置入口白屏','有效tab内容与关闭重开状态同步'],'F04',[225])}
issues=[]; prs=[]
for n,(label,symptoms,owner,links) in issue_defs.items():
 raw=read(P/f'issues-{n}-raw.json'); cs=read(P/f'issue-{n}-comments-raw.json')
 issues.append({'number':n,'url':raw['html_url'],'summary':label,'state':raw['state'],'updatedAt':raw['updated_at'],'lastCommentAt':max([c['updated_at'] for c in cs],default=None),'symptoms':symptoms,'acceptanceOwner':owner,'relatedPrs':links,'reproduction':'not-run','rootCause':'not-established-by-S00','releaseAcceptance':'not-run','closureEligible':False,'evidenceLevel':'fresh-public-report-and-state','missingEvidence':'Production entry, synthetic symptom reproduction, product/install and exact release receipt per Program v3 gate.'})
for n in [201,208,212,223,225,229]:
 raw=read(P/f'pulls-{n}-raw.json'); commit=raw.get('merge_commit_sha'); merged=raw['merged']; ancestor=lambda ref: subprocess.run(['git','merge-base','--is-ancestor',commit,ref],capture_output=True).returncode==0 if merged else False
 prs.append({'number':n,'url':raw['html_url'],'state':'MERGED' if merged else raw['state'].upper(),'headSha':raw['head']['sha'],'mergeCommitSha':commit if merged else None,'mergedAt':raw['merged_at'],'includedInCurrentHead':ancestor('HEAD'),'includedInV110':ancestor('v1.1.0')})
release=read(P/'release-latest-raw.json'); checks=read(P/'pr225-checks-raw.json')
save(O/'issue-baseline.json',{'schemaVersion':1,'specId':'S00','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'repository':'EthanYoQ/AI-Novel-Writer','baseSha':d['baseSha'],'issues':issues,'relatedPrs':prs,'pr225Checks':checks,'latestRelease':{'tag':release['tag_name'],'publishedAt':release['published_at'],'url':release['html_url']},'historical226':{'status':'unavailable','issueApiStatus':404,'pullApiStatus':404,'meaning':'Cannot identify this historical reference from public API; not proof of closed/fixed. Owner S00/main must locate original source.'},'githubWrites':0,'modelCalls':0,'note':'Fresh state and safe symptom summaries only. No comments/raw reports, author prose, machine paths, model configuration IDs, secret material or secret hashes included.'})
(O/'donor-delta.md').write_text('''# S00 三方事实台账\n\n当前基线与 origin/master 为 `'''+d['baseSha']+'''`，v1.1.0 为 `'''+d['v110Sha']+'''`。PR #229 已合并，交接修复已包含，不能重复移植。\n\n`donor-delta.json` 列出全量路径与三方原字节 SHA256；`differences` 逐文件给出分类、owner、采取方向、功能动作候选映射和门。相同文件只说明无需复制，不是行为验收。映射是保守待测覆盖范围，owner 必须按真实入口逐动作落实；不能把宽泛映射当 PASS。\n\n`inventory.json` 将 Vela 词法行清单与 CodeGraph 真实调用路径分开。没有文件被判定可删除；ActivityBar 的 outgoing calls 不证明它有 incoming consumer，也不证明零消费者。S13 仍需完整 import/dynamic/barrel/glob/Storybook/build 核销。\n\n`asset-disposition.json` 分类 C09 全部必需类别，包含 prompts、Skill/绑定、partial_arch、canonical LanceDB 全文、多代向量、MCP、skin/update、donor 头像/缓存/偏好及便携归档。S01 仍须签署逐字段便携 allowlist；S04/F03 用隔离 fixture 验证实际对象。未扫描作者数据，不能声称所有作者目录已迁移。\n\n许可待核验素材为新增 plum-blossom 背景、两个 seal 图片与 YiShanBeiZhuanTi 字体。现有字体 notices 列出四个其他字体家族，不能推定覆盖该新增字体。F02 核验或同功能合规替代；不据此删除头像/界面功能。\n\n历史 donor-feature-union 说明中的备份占位处置已被 Program v3 C17/C18/U16 覆盖：B01/B02/F04 仍须实现完整手动备份/恢复。原冻结证据未改。\n\n本切片仅运行文件哈希/JSON检查、CodeGraph源码查询及 GitHub 只读刷新；未运行中文模型、Electron、浏览器、迁移或安装包验收。GitHub Issue 全部仍 open；具体 PR/Release 状态见 issue-baseline.json。\n\n重算：在项目根以 Python 运行 inventory-generate.py 并通过 --donor 指定获准只读 donor 根；然后运行 inventory-finalize.py（依赖本地私有只读 receipts）。输出中不记录绝对路径；原始 receipts 位于项目 .runtime/.cache/novel-quality-modernization，不提交。\n''',encoding='utf-8')
print({'assets':len(assets),'tables':len(tables),'issues':len(issues),'prs':len(prs),'consumerGroups':len(consumers)})
# Source-field inventory: current SQL declarations plus explicit additive declarations.
def ddl_columns(text):
 result={}
 for m in re.finditer(r'CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(',text,re.I):
  depth=1; quote=None; j=m.end()
  while j<len(text) and depth:
   ch=text[j]
   if quote:
    if ch==quote:
     if j+1<len(text) and text[j+1]==quote: j+=1
     else: quote=None
   elif ch in "'\"": quote=ch
   elif ch=='(': depth+=1
   elif ch==')': depth-=1
   j+=1
  table=m.group(1); table='import_runs' if table=='import_runs_stage_v3' else table
  cols=result.setdefault(table,{})
  for c in re.finditer(r'^\s*(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b',text[m.end():j-1],re.M|re.I): cols[c.group(1)]={'sqlType':c.group(2).upper(),'sourceLine':text.count('\n',0,m.end()+c.start())+1}
 for m in re.finditer(r'ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b',text,re.I): result.setdefault(m.group(1),{}).setdefault(m.group(2),{'sqlType':m.group(3).upper(),'sourceLine':text.count('\n',0,m.start())+1})
 return result
fieldmap=ddl_columns(src)
# These loops are declared explicitly in initProjectDatabase; capture arguments rather than ignoring interpolated ALTER statements.
for m in re.finditer(r"addSourceColumn\('([^']+)',\s*'([^']+)'",src):
 for table in ['revisions','reviews']: fieldmap[table].setdefault(m.group(1),{'sqlType':m.group(2),'sourceLine':src.count('\n',0,m.start())+1})
for fun,table in [('addProjectCoreTextColumn','project_core'),('addDeletionTextColumn','chapter_deletion_operations')]:
 for m in re.finditer(fun+r"\('([^']+)'",src): fieldmap[table].setdefault(m.group(1),{'sqlType':'TEXT','sourceLine':src.count('\n',0,m.start())+1})
a=read(O/'asset-disposition.json'); fields=[]
opaque={'source_dependencies','source_snapshot','receipt_json','payload_json','effect_receipt_json','source_display_json','display_json','source_fingerprint','manifest_fingerprint','authority_fingerprint','legacy_source_fingerprint','payload_hash','alias_digest','idempotency_key_hash','effect_key','effect_namespace','source_hash'}
execution_tables={'chapter_deletion_operations','post_process_runs','post_process_steps','import_runs','import_run_sources','import_run_receipts','import_run_knowledge_receipts','import_reference_documents','finalized_draft_import_operations','import_global_fact_operations'}
for table,cols in sorted(fieldmap.items()):
 for column,meta in sorted(cols.items()):
  rule='Preserve author/domain value and stable domain linkage; bind current readable authority to new project transfer receipt; no execution authority.'; disposition='preserve-domain-value'
  if table in execution_tables: disposition='historical-read-only-projection'; rule='Preserve safe historical meaning only; restored copy cannot execute old import/outbox/deletion/postprocess or claim previous receipt authorization.'
  if table=='import_legacy_identity_bridge' or column in {'legacy_knowledge_authorization','legacy_knowledge_authorized_at'}: disposition='exclude-machine-authority'; rule='Keep original in local source backup; do not export encrypted machine identity/grant or its hash. New copy obtains new local authorization only on explicit action.'
  elif column in opaque or re.search('error|failure_reason',column): disposition='allowlist-rebuild-or-block'; rule='Opaque nested data may contain local path/secretRef/permission identifiers. Recursively project approved semantic fields; exclude original value AND original hash if any nonportable metadata occurs. New portable digest binds sanitized projection; keep original history only at source; unresolved schema blocks complete export.'
  elif column=='project_id' or (table=='project_core' and column=='id'): disposition='new-project-id-transfer-map'; rule='New portable copy ID/epoch/session, preserve origin linkage only through approved transfer receipt; no inherited leases.'
  elif column=='target_file_name': disposition='validate-relative-projection'; rule='Carry only validated project-relative filename; absolute/traversal paths block export, derive safe new local output path without overwriting author files.'
  elif column in {'publication_status','manuscript_status','knowledge_status','status','state','stage'} and (table in execution_tables or table in {'finalization_outbox','recovery_candidates'}): disposition='non-executable-history'; rule='Preserve original historical state in approved safe projection; runtime status of copy must not resume old work or grant candidate adoption. Current readable formal authority transfers separately.'
  elif table=='llm_calls': disposition='safe-diagnostic-projection'; rule='Only approved nonsecret diagnostic counters/labels; model_id is not a reusable local configuration/grant. Error text screened separately, no model secrets or raw prompt.'
  fields.append({'table':table,'field':column,**meta,'source':'electron/database.ts','upgradeDisposition':'preserve-local-bytes-or-versioned-S01-migration','portableDisposition':disposition,'rule':rule,'owner':'B01','schemaApprovalOwner':'S01','approvedForExport':False})
a['portableFieldDispositions']=fields
a['sourceSchemaTables']=[{'table':t,'fieldCount':len(c),'schemaOwner':'S01','upgradeOwner':'S04','portableFieldAllowlistStatus':'proposed-explicit-field-disposition-pending-signature','unknownColumns':'block export and preserve source'} for t,c in sorted(fieldmap.items())]
a['portableOpaquePayloadPolicy']={'field':'Any nested JSON including secretRef/path/runtime grants','action':'Never carry original payload or its hash into portable archive if it contains nonportable metadata. Preserve safe author semantics through a newly hashed versioned projection and transfer-authority mapping; source original stays local. Unknown nested schema blocks complete archive.','owner':'B01','approvalOwner':'S01'}
a['donorSchemaDelta']=[{'table':'characters','field':'avatar','source':'donor/electron/database.ts','portableDisposition':'canonical-stable-character-asset-reference','assetOwner':'F03','portableOwner':'B01','migration':'M05','rule':'Preserve original image bytes and verified association; unknown name-hash collision blocks binding, never omit avatar feature.'}]
save(O/'asset-disposition.json',a)
print({'portableTables':len(fieldmap),'portableFields':len(fields)})
for row in a['portableFieldDispositions']:
 if row['field'] in {'source_id','root_run_id','run_id','operation_id','batch_id','idempotency_key_hash','alias_digest'} and row['table'].startswith(('import_','finalized_draft_import','import_global')):
  row['portableDisposition']='validate-semantic-id-or-remap'
  row['rule']='Prove identifier is domain-safe and not derived from path/secretRef/local grant. Unsafe or unknown identity and its original digest stay at source; allocate portable semantic ID and transfer map; no resumed operation authority.'
save(O/'asset-disposition.json',a)
# Explicit source-document input identity; frozen planning material is read, never rewritten.
inv=read(O/'inventory.json')
plan=R/'docs/plans/novel-quality-program-v3-2026-09-13'
inv['planningInputHashes']=[{'path':f.relative_to(R).as_posix(),'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sorted(plan.glob('*')) if f.is_file() and (f.name[:2] in {'00','01','02','03','04','05','09','10'} or f.name in {'dag.json','feature-union.json'})]
for row in inv['lexicalVela']:
 p=row['path'].lower()
 if row['productionCandidate']:
  if re.search('config-utils|config-controller|mcp|skin|update|app-data|i18n',p): row['owner']='S03'
  elif re.search('database|vector|knowledge-base|project-access|project-path|project-storage|writing-skill|skill-registry',p): row['owner']='S04'
  else: row['owner']='S02'
  row['retirementOwner']='S13'
save(O/'inventory.json',inv)
d=read(O/'donor-delta.json')
d['treeContentFingerprints']={arm:hashlib.sha256('\n'.join(row['path']+'\0'+row['hashes'][arm] for row in d['files'] if row['hashes'][arm]).encode()).hexdigest() for arm in ['currentMaster','v110','donor']}
d['fingerprintDefinition']='SHA256 of sorted relative path + NUL + raw-file SHA256 lines, UTF-8, scoped regular source files only.'
save(O/'donor-delta.json',d)
