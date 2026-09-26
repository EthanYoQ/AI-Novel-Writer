import subprocess,json,pathlib,hashlib,os,re,datetime,collections
ROOT=pathlib.Path.cwd(); OUT=ROOT/'docs/research/novel-quality-modernization'; PRIVATE=ROOT/'.runtime/.cache/novel-quality-modernization'
def run(*args): return subprocess.check_output(args,cwd=ROOT)
def jsave(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def sha(b): return hashlib.sha256(b).hexdigest()
def tree(ref):
 rows={}
 for entry in run('git','ls-tree','-r','-z',ref).split(b'\0'):
  if not entry: continue
  meta,p=entry.split(b'\t'); mode,typ,oid=meta.decode().split(); p=p.decode()
  if typ=='blob' and scope(p): rows[p]=oid
 proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,cwd=ROOT)
 data,_=proc.communicate(('\n'.join(rows.values())+'\n').encode()); pos=0; result={}
 for p in rows:
  end=data.index(b'\n',pos); n=int(data[pos:end].split()[-1]); result[p]=data[end+1:end+1+n]; pos=end+n+2
 return result
def scope(p):
 parts=p.split('/')
 return not any(x in parts for x in ['.runtime','.cache','node_modules','.git','.codegraph','plugins','.dsh','.worktrees','dist','dist-electron']) and not re.search(r'(^|/)(dsh|deepseek-harness)(/|$)',p,re.I)
def scan(root):
 out={}
 for base,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=[d for d in dirs if scope((pathlib.Path(base)/d).relative_to(root).as_posix()) and not (pathlib.Path(base)/d).is_symlink() and not (pathlib.Path(base)/d).is_junction()]
  for f in files:
   p=pathlib.Path(base)/f; rel=p.relative_to(root).as_posix()
   if scope(rel) and not p.is_symlink(): out[rel]=p.read_bytes()
 return out
if __name__=='__main__':
 import argparse
 ap=argparse.ArgumentParser(); ap.add_argument('--donor',required=True); args=ap.parse_args()
 current=tree('HEAD'); old=tree('v1.1.0'); donor=scan(pathlib.Path(args.donor))
 union=json.loads((ROOT/'docs/plans/novel-quality-program-v3-2026-09-13/feature-union.json').read_text(encoding='utf-8'))
 actions={f['id']:[a['actionId'] for a in f['actions']] for f in union['features']}
 def classify(p):
  s=p.lower()
  if s.endswith(('.css','.scss')): return 'pure-visual-reuse','F02',['U02'],'Reuse styling through current presenters; preserve behavior and verify Chinese layout.'
  if re.search('avatar|avatar-image',s): return 'persistent-asset-schema','F03',['U10','U11','U16'],'Adapt avatar behavior to stable ID and M05 staging; retain compression, original bytes, cancellation and bounded reads.'
  if re.search('project-peek|projectoverview|flowstages|welcomepage',s): return 'behavior-change','F04',['U01','U08'],'Retain real overview; replace arbitrary path/write fallback/private cache and any-chapter completion with authorized read-only counts.'
  if re.search('theme|appearance|ui-version|font',s): return 'persistent-asset-schema','F01',['U02'],'Preserve explicit shell/color/font preferences; migrate through one appearance owner.'
  if re.search('skin',s): return 'persistent-asset-schema','S03',['U02'],'Preserve main SkinService ownership; migrate images/config before writers start.'
  if re.search('database|ipc-handlers|ipc-channels|preload|electron/main|vite-env|ipc-client',s): return 'interface-adaptation','S01',['U01','U03','U10','U16'],'Keep current shared contract; centrally register donor services and schema M05 after probe; do not copy donor central file.'
  if re.search('world-building|generate-architecture|generate-outline',s): return 'stale-upstream','S06A',['U04','U13'],'Retain current source-conflict and recovery fixes; donor presentation must call current command.'
  if re.search('draft-context|synopsis',s): return 'stale-upstream','S10B',['U05'],'Retain current per-chapter synopsis and evidence semantics.'
  if re.search('command|workflow',s): return 'interface-adaptation','S06B',['U04','U05','U12','U13'],'Keep current business command and budget/recovery fixes; adapt UI without replacing the kernel.'
  if re.search('review|revision|finaliz',s): return 'behavior-change','S11',['U12','U13'],'Retain current evidence/no-op/merge/finalization semantics and adapt required Writer entry.'
  if re.search('relationship|relationmap|relationseditor',s): return 'behavior-change','F04',['U09','U10','U11'],'Retain five layouts, center/drag/pan/zoom/reset/profile and relation editing; reset must write zero character facts.'
  if re.search('character',s): return 'interface-adaptation','S09C',['U09','U10','U11','U14'],'Retain card import/edit/provenance and consume stable IDs; F04 wires Writer and F03 owns avatar service.'
  if re.search('codemirror|live-preview',s): return 'behavior-change','F04',['U06','U14'],'Retain live Markdown/IME/selection/undo/fonts; verify 3000 and 200000 unit performance without disabling preview.'
  if re.search('editor|archfileviewer',s): return 'behavior-change','F04',['U04','U05','U06','U07','U14','U15'],'Adapt shared editor surface; preserve dirty/saving/saved/failed, content on failure, undo and latest upstream semantics.'
  if re.search('settings|config|prompt|skill|model',s): return 'interface-adaptation','F04',['U03','U14'],'Keep supported settings and latest handlers; both settings entries must persist/reopen with real content.'
  if re.search('layout|rail|tabstrip|titlebar|activitybar|app.tsx|sidebar|panel|navigation',s): return 'behavior-change','F04',['U01','U07','U13','U16'],'Reuse Writer shell while preserving dirty state and all business routes; backup placeholder is fulfilled by B01/B02, not removed as scope.'
  if re.search(r'(^test/|__tests__|\.test\.|\.browser\.|^scripts/|^\.github/|^\.release/|^\.storybook/|package|lock|vite|tsconfig|electron-builder|^build/)',s): return 'test-tooling','S01',['U01','U02','U03','U04','U05','U06','U07','U08','U09','U10','U11','U12','U13','U14','U15','U16'],'Retain current build/release dependency baseline; adapt test/tool coverage before qualification; no donor dependency downgrade.'
  if s.endswith(('.png','.jpg','.jpeg','.webp','.woff','.woff2','.ttf','.ico','.svg')): return 'pending-license','F02',['U02'],'Asset source/license must be verified or replaced with compliant equivalent before release; no functionality removed.'
  if s.startswith('docs/') or s.endswith('.md') or 'license' in s: return 'documentation','S00',[],'Historical source/reference only; retain attribution; active documentation updates belong to relevant implementation/release owner.'
  return 'pending-review','F04',['U01','U03','U07','U15'],'Preserve current implementation pending explicit consumer review; not permission to discard donor functionality.'
 files=[]; differences=[]; lexical=[]
 for p in sorted(set(current)|set(old)|set(donor)):
  hashes={k:sha(d[p]) if p in d else None for k,d in [('currentMaster',current),('v110',old),('donor',donor)]}
  same=len(set(hashes.values()))==1
  row={'path':p,'hashes':hashes,'sameAcrossThree':same}
  files.append(row)
  if not same:
   cat,owner,groups,reason=classify(p)
   row={**row,'classification':cat,'owner':owner,'featureActionIds':[a for g in groups for a in actions[g]],'mappingStatus':'candidate-coverage-not-action-acceptance','decision':'retain-current-and-review-adaptation' if cat!='pure-visual-reuse' else 'reuse-after-visual-verification','reason':reason,'gates':['C12','F05-required-action-receipts'] if groups else ['documentation-source-review'],'evidenceLevel':'source-hash-only','reviewStatus':'pending-owner-line-review'}
   differences.append(row)
 for p,b in current.items():
  try: lines=b.decode('utf-8').splitlines()
  except UnicodeDecodeError: continue
  hits=[{'line':i,'tokens':sorted(set(m.group(0) for m in re.finditer(r'vela',line,re.I)))} for i,line in enumerate(lines,1) if re.search('vela',line,re.I)]
  if hits:
   cat,owner,groups,reason=classify(p)
   production=p.startswith(('src/','electron/')) and not re.search(r'__tests__|\.test\.|\.stories\.',p)
   lexical.append({'path':p,'sha256':sha(b),'matches':hits,'productionCandidate':production,'owner': 'S02' if production else 'S13','consumerStatus':'lexical-only-not-dead-code-proof','disposition':'replace-through-canonical-contract' if production else 'review-historical-test-or-build-reference','allowedLegacy':'isolated migration fixtures and historical attribution only; S13 must approve exact retained occurrence'})
 meta={'schemaVersion':1,'specId':'S00','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseSha':run('git','rev-parse','HEAD').decode().strip(),'v110Sha':run('git','rev-parse','v1.1.0^{}').decode().strip(),'evidenceLevel':'source-inventory','productAcceptance':'not-run'}
 jsave(OUT/'donor-delta.json',{**meta,'hashAlgorithm':'sha256-raw-bytes','scope':'all tracked current/tag files and donor regular files excluding DSH/plugins/cache/build outputs; includes src/electron/scripts/test/public/.release/.github/package/lock/docs/root tooling','files':files,'differences':differences,'counts':{'current':len(current),'v110':len(old),'donor':len(donor),'union':len(files),'differences':len(differences),'classifications':dict(collections.Counter(d['classification'] for d in differences))},'limitations':['Per-file route/action mapping is a conservative candidate coverage list, not source line-by-line acceptance. Pending-review items block downstream adoption until owner confirms exact actions.','No source deletion justified by lexical count; dynamic import/barrel/glob consumer evidence required by S13.','User/global runtime data not scanned; runtime asset occurrence census requires S04 isolated fixtures.']})
 jsave(OUT/'inventory.json',{**meta,'scope':['src','electron','scripts','.release','.github','package/lock','test','public','active tracked docs','root tooling'],'exclusions':['DSH/plugins','.runtime/.cache','node_modules','git metadata','external author data'],'currentFileCount':len(current),'lexicalVela':lexical,'behaviorConsumers':[],'deadCodeClaims':[],'allConsumersVerified':False,'remainingOwner':'S02/S03/S04/S13','privacy':'Only source-relative paths and line numbers; no raw source snippets, author data, credentials, or machine paths.'})
 print(json.dumps({'files':len(files),'differences':len(differences),'velaFiles':len(lexical),'classifications':dict(collections.Counter(d['classification'] for d in differences))}))
 # Actual changed line intervals for reviewer navigation; hashes above remain raw-byte identity.
 import difflib
 path_to_row={x['path']:x for x in differences}
 for p,row in path_to_row.items():
  evidence=[]
  for left_name,right_name,left,right in [('v110','currentMaster',old,current),('v110','donor',old,donor),('currentMaster','donor',current,donor)]:
   if left.get(p)==right.get(p): continue
   try:
    a=left.get(p,b'').decode('utf-8').splitlines(); b=right.get(p,b'').decode('utf-8').splitlines()
   except UnicodeDecodeError:
    evidence.append({'comparison':left_name+'..'+right_name,'kind':'binary-byte-delta'}); continue
   changed=[{'operation':tag,'leftStartLine':i1+1,'leftLineCount':i2-i1,'rightStartLine':j1+1,'rightLineCount':j2-j1} for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes() if tag!='equal']
   evidence.append({'comparison':left_name+'..'+right_name,'kind':'source-line-delta','hunks':changed})
  row['actualDiffEvidence']=evidence
 d=json.loads((OUT/'donor-delta.json').read_text(encoding='utf-8')); d['differences']=differences; jsave(OUT/'donor-delta.json',d)
