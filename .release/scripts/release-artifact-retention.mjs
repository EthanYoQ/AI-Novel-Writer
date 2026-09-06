#!/usr/bin/env node
// Post-publication housekeeping only. Never creates or modifies a Release.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROMOTION_WORKFLOW = '.github/workflows/cross-platform-runtime-artifact-promotion.yml';
const PLATFORMS = ['macos-arm64', 'macos-x64', 'windows'];
const digest = value => /^sha256:[0-9a-f]{64}$/.test(String(value));
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function validateEvidence(evidence, context) {
  const { plan, receipt, promotion, artifacts } = evidence;
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.repository, context.repository);
  assert.equal(plan.qualificationRepository, context.repository);
  assert.equal(plan.releaseRepository, context.repository);
  assert.equal(plan.expectedSha, context.expectedSha);
  assert.match(plan.expectedSha, /^[0-9a-f]{40}$/);
  assert.equal(plan.tag, context.tag);
  assert.equal(plan.channel.draft, false, 'drafts must retain their source artifacts');
  assert.equal(receipt.publicationVerified, true, 'authoritative publication readback is required');
  assert.ok(positiveId(receipt.releaseId));
  assert.equal(promotion.runId, context.runId);
  assert.equal(promotion.attempt, context.attempt);
  assert.equal(promotion.workflow, PROMOTION_WORKFLOW);
  assert.deepEqual(plan.qualifications.map(q => q.platform).sort(), PLATFORMS);
  assert.equal(artifacts.length, 4);
  assert.equal(new Set(artifacts.map(a => a.id)).size, 4, 'duplicate artifact IDs');
  const expected = plan.qualifications.map(q => {
    assert.ok(positiveId(q.runId) && positiveId(q.attempt) && positiveId(q.artifactId));
    assert.equal(q.headSha, plan.expectedSha);
    return { id: q.artifactId, name: q.artifactName, runId: q.runId, attempt: q.attempt, headSha: q.headSha };
  });
  expected.push({ id: context.verifiedId, name: `verified-desktop-release-${plan.expectedSha}`,
    runId: promotion.runId, attempt: promotion.attempt, headSha: promotion.headSha });
  for (const wanted of expected) {
    assert.ok(positiveId(wanted.id));
    const actual = artifacts.find(a => a.id === wanted.id);
    for (const [key, value] of Object.entries(wanted)) assert.equal(actual?.[key], value, `artifact ${wanted.id} ${key} mismatch`);
    assert.ok(digest(actual.digest), 'missing artifact ZIP digest');
    assert.ok(Number.isSafeInteger(actual.size) && actual.size > 0);
  }
  const verified = artifacts.find(a => a.id === context.verifiedId);
  assert.equal(verified.digest, `sha256:${context.verifiedDigest}`);
  assert.equal(receipt.outerArtifactDigest, context.verifiedDigest);
  return evidence;
}

export function assertPublishedRelease(evidence, release, tagCommit) {
  const { plan, receipt } = evidence;
  assert.equal(tagCommit.sha, plan.expectedSha, 'tag target changed');
  assert.equal(release.id, receipt.releaseId);
  assert.equal(release.tag_name, plan.tag);
  assert.equal(release.draft, false, 'release is not published');
  assert.equal(release.prerelease, plan.channel.prerelease);
  assert.equal(release.name, plan.title);
  assert.equal(release.body, plan.body, 'release provenance changed');
  assert.ok(Array.isArray(plan.assets) && plan.assets.length > 0);
  assert.deepEqual(release.assets.map(a => a.name).sort(), plan.assets.map(a => a.name).sort());
  assert.equal(new Set(plan.assets.map(a => a.name)).size, plan.assets.length);
  for (const wanted of plan.assets) {
    assert.match(wanted.sha256, /^[0-9a-f]{64}$/);
    const actual = release.assets.find(a => a.name === wanted.name);
    assert.equal(actual.state, 'uploaded');
    assert.equal(actual.size, wanted.size);
    assert.equal(actual.digest, `sha256:${wanted.sha256}`, `release bytes changed: ${wanted.name}`);
  }
}

export function assertArtifactUnchanged(actual, saved) {
  assert.equal(actual.id, saved.id);
  assert.equal(actual.name, saved.name);
  assert.equal(actual.digest, saved.digest);
  assert.equal(actual.size_in_bytes, saved.size);
  assert.equal(actual.workflow_run?.id, saved.runId);
  assert.equal(actual.workflow_run?.head_sha, saved.headSha);
}

export async function assertSources(evidence, api, currentRunId, allowMissing = false) {
  for (const saved of evidence.artifacts) {
    const run = await api(`/actions/runs/${saved.runId}`);
    assert.equal(run.run_attempt, saved.attempt, 'source run was rerun');
    assert.equal(run.head_sha, saved.headSha);
    if (run.id === currentRunId && run.id === evidence.promotion.runId) {
      assert.ok(run.status === 'in_progress' || (run.status === 'completed' && run.conclusion === 'success'));
    } else {
      assert.equal(run.status, 'completed', 'source run is still active');
      assert.equal(run.conclusion, 'success');
    }
    const artifact = await api(`/actions/artifacts/${saved.id}`, 'GET', allowMissing);
    if (artifact) assertArtifactUnchanged(artifact, saved);
  }
}

export async function verifyRelease(evidence, api) {
  const release = await api(`/releases/${evidence.receipt.releaseId}`);
  const commit = await api(`/commits/${encodeURIComponent(evidence.plan.tag)}`);
  assertPublishedRelease(evidence, release, commit);
  return release;
}

export async function cleanup(evidence, context, api, currentRunId) {
  validateEvidence(evidence, context);
  await verifyRelease(evidence, api);
  // Block any other active promotion: its dispatch can select an older SHA.
  for (const status of ['in_progress', 'queued', 'waiting', 'pending', 'requested']) {
    for (let page = 1; ; page++) {
      const result = await api(`/actions/runs?status=${status}&per_page=100&page=${page}`);
      assert.ok(Array.isArray(result.workflow_runs));
      const blocker = result.workflow_runs.find(run => run.id !== evidence.promotion.runId &&
        String(run.path).split('@')[0] === PROMOTION_WORKFLOW && run.status !== 'completed');
      if (blocker) return { skipped: 'another promotion is active', runId: blocker.id, deletedBytes: 0 };
      if (result.workflow_runs.length < 100) break;
    }
  }
  // Complete all validation before the first deletion; never delete by name/age.
  await assertSources(evidence, api, currentRunId, true);
  const deleted = [];
  for (const saved of evidence.artifacts) {
    const path = `/actions/artifacts/${saved.id}`;
    const live = await api(path, 'GET', true);
    if (!live) continue; // An already-absent, recorded ID is safe on a retry.
    assertArtifactUnchanged(live, saved);
    await api(path, 'DELETE', true);
    assert.equal(await api(path, 'GET', true), null, `artifact ${saved.id} deletion not confirmed`);
    deleted.push({ id: saved.id, bytes: saved.size });
  }
  return { deleted, deletedBytes: deleted.reduce((sum, a) => sum + a.bytes, 0) };
}

function githubApi(repository, token) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(token, 'GITHUB_TOKEN is required');
  return async (path, method = 'GET', allowMissing = false) => {
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    assert.ok(method === 'GET' || (method === 'DELETE' && /^\/actions\/artifacts\/\d+$/.test(path)));
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

async function main() {
  const [command, source, output = 'release-provenance/release-provenance.json'] = process.argv.slice(2);
  assert.ok(['prepare', 'cleanup'].includes(command) && source, 'usage: release-artifact-retention.mjs prepare|cleanup PATH [OUTPUT]');
  const env = process.env;
  const context = { repository: env.GITHUB_REPOSITORY, expectedSha: env.EXPECTED_SHA, tag: env.RELEASE_TAG,
    runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    verifiedId: Number(env.VERIFIED_ARTIFACT_ID), verifiedDigest: env.VERIFIED_ARTIFACT_DIGEST };
  const api = githubApi(context.repository, env.GITHUB_TOKEN);
  if (command === 'cleanup') {
    const result = await cleanup(await readJson(source), context, api, context.runId);
    if (result.skipped) console.log(`::warning::Storage cleanup skipped: ${result.skipped} (${result.runId})`);
    console.log(JSON.stringify(result));
    return;
  }
  const candidates = (await readdir(source, { recursive: true })).filter(p => p === 'promotion-plan.json' || p.endsWith('/promotion-plan.json'));
  assert.equal(candidates.length, 1, 'expected one verified promotion plan');
  const plan = await readJson(join(source, candidates[0]));
  const receipt = await readJson('publication-receipt.json');
  const promotionRun = await api(`/actions/runs/${context.runId}`);
  assert.equal(promotionRun.path.split('@')[0], PROMOTION_WORKFLOW);
  const artifacts = [];
  for (const id of [...plan.qualifications.map(q => q.artifactId), context.verifiedId]) {
    assert.ok(positiveId(id));
    const a = await api(`/actions/artifacts/${id}`);
    const q = plan.qualifications.find(q => q.artifactId === id);
    artifacts.push({ id: a.id, name: a.name, digest: a.digest, size: a.size_in_bytes,
      runId: a.workflow_run.id, headSha: a.workflow_run.head_sha, attempt: q?.attempt ?? context.attempt,
      createdAt: a.created_at, expiresAt: a.expires_at });
  }
  const evidence = { schemaVersion: 1, recordedAt: new Date().toISOString(), repository: context.repository,
    promotion: { runId: context.runId, attempt: context.attempt, headSha: promotionRun.head_sha, workflow: PROMOTION_WORKFLOW },
    plan, receipt, artifacts };
  validateEvidence(evidence, context);
  const release = await verifyRelease(evidence, api);
  await assertSources(evidence, api, context.runId);
  evidence.release = { id: release.id, url: release.html_url, publishedAt: release.published_at,
    assets: release.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })) };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
