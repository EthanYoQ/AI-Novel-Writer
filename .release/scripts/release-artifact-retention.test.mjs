import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, validateEvidence, PROMOTION_WORKFLOW } from './release-artifact-retention.mjs';

function fixture() {
  const sha = 'a'.repeat(40), zip = 'b'.repeat(64);
  const context = { repository: 'example/desktop', expectedSha: sha, tag: 'v1.0.0', runId: 40, attempt: 1, verifiedId: 400, verifiedDigest: zip };
  const qualifications = ['macos-arm64', 'macos-x64', 'windows'].map((platform, i) => ({
    platform, runId: i + 10, attempt: 1, artifactId: i + 100,
    artifactName: `qualified-${platform}`, headSha: sha,
  }));
  const artifacts = qualifications.map(q => ({ id: q.artifactId, name: q.artifactName, runId: q.runId,
    attempt: 1, headSha: sha, digest: `sha256:${zip}`, size: 100 }));
  artifacts.push({ id: 400, name: `verified-desktop-release-${sha}`, runId: 40, attempt: 1,
    headSha: 'c'.repeat(40), digest: `sha256:${zip}`, size: 300 });
  const evidence = { schemaVersion: 1, repository: context.repository,
    promotion: { runId: 40, attempt: 1, headSha: 'c'.repeat(40), workflow: PROMOTION_WORKFLOW },
    receipt: { publicationVerified: true, releaseId: 50, outerArtifactDigest: zip }, artifacts,
    plan: { qualificationRepository: context.repository, releaseRepository: context.repository,
      expectedSha: sha, tag: 'v1.0.0', title: 'v1.0.0', body: 'verified provenance',
      channel: { draft: false, prerelease: false }, qualifications,
      assets: [{ name: 'setup.exe', size: 90, sha256: zip }] },
  };
  const release = { id: 50, tag_name: 'v1.0.0', draft: false, prerelease: false, name: 'v1.0.0',
    body: 'verified provenance', assets: [{ name: 'setup.exe', state: 'uploaded', size: 90, digest: `sha256:${zip}` }] };
  const runs = new Map(artifacts.map(a => [a.runId, { id: a.runId, run_attempt: a.attempt, head_sha: a.headSha,
    status: a.runId === 40 ? 'in_progress' : 'completed', conclusion: a.runId === 40 ? null : 'success' }]));
  const live = new Map(artifacts.map(a => [a.id, { id: a.id, name: a.name, digest: a.digest,
    size_in_bytes: a.size, workflow_run: { id: a.runId, head_sha: a.headSha } }]));
  const deletes = [], active = [], tag = { sha };
  const api = async (path, method = 'GET', allowMissing = false) => {
    if (path === '/releases/50') return release;
    if (path === '/commits/v1.0.0') return tag;
    if (path.startsWith('/actions/runs?')) return { workflow_runs: active };
    const match = /^\/actions\/(runs|artifacts)\/(\d+)$/.exec(path);
    assert.ok(match, `unexpected API call: ${method} ${path}`);
    const id = Number(match[2]);
    if (match[1] === 'runs') return runs.get(id);
    if (method === 'DELETE') { deletes.push(id); live.delete(id); return null; }
    if (!live.has(id)) { assert.ok(allowMissing); return null; }
    return live.get(id);
  };
  return { context, evidence, release, runs, live, deletes, active, tag, api };
}

async function refused(mutator) {
  const f = fixture();
  mutator(f);
  await assert.rejects(cleanup(f.evidence, f.context, f.api, 40));
  assert.deepEqual(f.deletes, []);
}

test('successful publication deletes only the four exact IDs after complete preflight', async () => {
  const f = fixture();
  f.live.set(999, { id: 999 });
  const result = await cleanup(f.evidence, f.context, f.api, 40);
  assert.deepEqual(f.deletes, [100, 101, 102, 400]);
  assert.equal(result.deletedBytes, 600);
  assert.ok(f.live.has(999));
});
test('missing publication receipt blocks deletion', () => refused(f => { f.evidence.receipt.publicationVerified = false; }));
test('draft releases retain artifacts', () => refused(f => { f.release.draft = true; }));
test('changed tag target blocks deletion', () => refused(f => { f.tag.sha = 'f'.repeat(40); }));
test('changed release digest blocks deletion', () => refused(f => { f.release.assets[0].digest = `sha256:${'f'.repeat(64)}`; }));
test('duplicate artifact IDs block deletion', () => refused(f => { f.evidence.artifacts[1].id = 100; }));
test('wrong repository blocks deletion', () => refused(f => { f.context.repository = 'other/repo'; }));
test('source artifact digest mismatch blocks every deletion', () => refused(f => { f.live.get(400).digest = `sha256:${'f'.repeat(64)}`; }));
test('wrong artifact source run blocks every deletion', () => refused(f => { f.live.get(102).workflow_run.id = 99; }));
test('rerun qualification is not cleaned', () => refused(f => { f.runs.get(12).run_attempt = 2; }));
test('failed qualification is not cleaned', () => refused(f => { f.runs.get(12).conclusion = 'failure'; }));
test('another active promotion skips all cleanup', async () => {
  const f = fixture();
  f.active.push({ id: 99, path: PROMOTION_WORKFLOW, status: 'queued' });
  const result = await cleanup(f.evidence, f.context, f.api, 40);
  assert.ok(result.skipped);
  assert.deepEqual(f.deletes, []);
});
test('already-absent recorded artifacts are a safe retry', async () => {
  const f = fixture();
  f.live.delete(101);
  const result = await cleanup(f.evidence, f.context, f.api, 40);
  assert.deepEqual(f.deletes, [100, 102, 400]);
  assert.equal(result.deletedBytes, 500);
});
test('API failure in preflight cannot produce partial deletion', async () => {
  const f = fixture();
  const api = (path, ...rest) => path === '/actions/artifacts/400' ? Promise.reject(new Error('HTTP 403')) : f.api(path, ...rest);
  await assert.rejects(cleanup(f.evidence, f.context, api, 40), /HTTP 403/);
  assert.deepEqual(f.deletes, []);
});
test('unconfirmed DELETE is not reported as completed', async () => {
  const f = fixture();
  const api = (path, method, missing) => method === 'DELETE' ? Promise.resolve(null) : f.api(path, method, missing);
  await assert.rejects(cleanup(f.evidence, f.context, api, 40), /deletion not confirmed/);
});
test('source SHA and promotion workflow SHA may differ', () => {
  const f = fixture();
  assert.notEqual(f.evidence.promotion.headSha, f.context.expectedSha);
  validateEvidence(f.evidence, f.context);
});
