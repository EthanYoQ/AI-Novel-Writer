/* eslint-env node */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const EXPECTED_WORKFLOW_NAME = 'Windows cloud package qualification'
const EXPECTED_WORKFLOW_PATH = '.github/workflows/windows-cloud-build-test.yml'
const EXPECTED_ARTIFACT_NAME = 'windows-cloud-build-runtime-verified'
export const PROMOTION_CONFIRMATION = 'PROMOTE_RUNTIME_VERIFIED_WINDOWS_RELEASE'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function jsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizedRelative(file) {
  return file.split(path.sep).join('/')
}

function listRegularFiles(root) {
  assert(existsSync(root), `Directory does not exist: ${root}`)
  const result = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = normalizedRelative(path.relative(root, absolute))
      const metadata = lstatSync(absolute)
      assert(!metadata.isSymbolicLink(), `Symbolic links are forbidden in promotion input: ${relative}`)
      if (entry.isDirectory()) visit(absolute)
      else {
        assert(entry.isFile(), `Only regular files are allowed in promotion input: ${relative}`)
        result.push(relative)
      }
    }
  }
  visit(root)
  return result.sort()
}

function parseFinalTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '')
  assert(match, 'tag must be a final v-prefixed semantic version (for example v0.4.0)')
  return match.slice(1).join('.')
}

function workflowPath(pathWithRef) {
  return String(pathWithRef ?? '').split('@', 1)[0]
}

function assertAbsentResponse(status, label) {
  assert(status === 404, `${label} already exists or its absence could not be proven (HTTP ${status})`)
}

export function validateQualificationSource({
  inputs,
  repository,
  workflow,
  run,
  comparison,
  artifactsResponse,
  tagRefStatus,
  releaseStatus,
  now = new Date(),
}) {
  assert(inputs?.confirmation === PROMOTION_CONFIRMATION, `confirmation must exactly equal ${PROMOTION_CONFIRMATION}`)
  assert(/^\d+$/.test(String(inputs?.qualificationRunId ?? '')) && Number(inputs.qualificationRunId) > 0, 'qualification_run_id must be a positive integer')
  assert(/^[a-f0-9]{40}$/i.test(inputs?.expectedSha ?? ''), 'expected_sha must be a full 40-character commit SHA')
  const expectedSha = inputs.expectedSha.toLowerCase()
  const version = parseFinalTag(inputs?.tag)

  assert(repository?.full_name === inputs.repository, 'GitHub repository identity does not match the workflow repository')
  assert(typeof repository.default_branch === 'string' && repository.default_branch.length > 0, 'Repository default branch is missing')
  assert(workflow?.name === EXPECTED_WORKFLOW_NAME, `Qualification workflow name must be ${EXPECTED_WORKFLOW_NAME}`)
  assert(workflowPath(workflow?.path) === EXPECTED_WORKFLOW_PATH, `Qualification workflow path must be ${EXPECTED_WORKFLOW_PATH}`)

  assert(String(run?.id) === String(inputs.qualificationRunId), 'Qualification run ID does not match the requested run')
  assert(run?.workflow_id === workflow.id, 'Qualification run belongs to a different workflow')
  assert(run?.name === EXPECTED_WORKFLOW_NAME, 'Qualification run has the wrong workflow name')
  assert(workflowPath(run?.path) === EXPECTED_WORKFLOW_PATH, 'Qualification run has the wrong workflow path')
  assert(run?.event === 'workflow_dispatch', 'Qualification run was not manually dispatched')
  assert(run?.status === 'completed' && run?.conclusion === 'success', 'Qualification run did not complete successfully')
  assert(String(run?.head_sha ?? '').toLowerCase() === expectedSha, 'Qualification run head SHA does not match expected_sha')
  assert(run?.head_branch === repository.default_branch, 'Qualification run did not execute on the repository default branch')
  assert(run?.head_repository?.full_name === repository.full_name, 'Qualification run came from a different repository')

  assert(['ahead', 'identical'].includes(comparison?.status), 'expected_sha is not an ancestor of the current default branch')
  assert(String(comparison?.merge_base_commit?.sha ?? '').toLowerCase() === expectedSha, 'Default-branch ancestry proof does not resolve to expected_sha')
  assert(String(comparison?.base_commit?.sha ?? '').toLowerCase() === expectedSha, 'Comparison base is not expected_sha')

  assert(Number.isInteger(artifactsResponse?.total_count), 'Artifact listing did not return a total count')
  assert(artifactsResponse.total_count <= 100, 'Artifact listing exceeds one API page; refusing an incomplete duplicate check')
  assert(Array.isArray(artifactsResponse.artifacts) && artifactsResponse.artifacts.length === artifactsResponse.total_count, 'Artifact listing is incomplete')
  const matches = artifactsResponse.artifacts.filter(artifact => artifact?.name === EXPECTED_ARTIFACT_NAME)
  assert(matches.length === 1, `Expected exactly one ${EXPECTED_ARTIFACT_NAME} artifact, found ${matches.length}`)
  const artifact = matches[0]
  assert(Number.isInteger(artifact.id) && artifact.id > 0, 'Qualification artifact ID is invalid')
  assert(artifact.expired === false, 'Qualification artifact is expired')
  assert(Number(artifact.size_in_bytes) > 0, 'Qualification artifact is empty')
  const expiresAt = Date.parse(artifact.expires_at ?? '')
  assert(Number.isFinite(expiresAt) && expiresAt > now.getTime(), 'Qualification artifact has expired or has no trustworthy expiry')
  if (artifact.workflow_run) {
    assert(String(artifact.workflow_run.id) === String(run.id), 'Qualification artifact belongs to a different run')
    assert(String(artifact.workflow_run.head_sha ?? '').toLowerCase() === expectedSha, 'Qualification artifact head SHA is inconsistent')
  }

  assertAbsentResponse(tagRefStatus, `Git tag ${inputs.tag}`)
  assertAbsentResponse(releaseStatus, `GitHub Release ${inputs.tag}`)

  return {
    schemaVersion: 1,
    state: 'SOURCE_VERIFIED',
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    qualificationRunId: Number(inputs.qualificationRunId),
    expectedSha,
    tag: inputs.tag,
    version,
    workflow: { id: workflow.id, name: workflow.name, path: EXPECTED_WORKFLOW_PATH },
    artifact: {
      id: artifact.id,
      name: artifact.name,
      sizeBytes: artifact.size_in_bytes,
      expiresAt: artifact.expires_at,
      digest: artifact.digest ?? null,
    },
  }
}

function parseChecksums(text) {
  const records = new Map()
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) \*([^\\]+)$/i.exec(line)
    assert(match, `Invalid SHA256SUMS.txt line: ${line}`)
    const name = match[2].replaceAll('\\', '/')
    assert(!records.has(name), `Duplicate checksum entry: ${name}`)
    records.set(name, match[1].toLowerCase())
  }
  return records
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseUpdaterMetadata(text) {
  const version = /^version:\s*(.+?)\s*$/m.exec(text)?.[1]
  const legacyPath = /^path:\s*(.+?)\s*$/m.exec(text)?.[1]
  const urls = [...text.matchAll(/^\s*-\s+url:\s*(.+?)\s*$/gm)].map(match => unquoteYamlScalar(match[1]))
  return {
    version: version ? unquoteYamlScalar(version) : undefined,
    path: legacyPath ? unquoteYamlScalar(legacyPath) : undefined,
    urls,
  }
}

function validateVectorEvidence(evidence) {
  assert(evidence?.schemaVersion === 1 && evidence?.kind === 'packaged-vector-smoke', 'Vector qualification evidence has the wrong schema or kind')
  assert(evidence.projectA?.vectorDimension === 768, 'Vector evidence did not verify the 768-dimension project')
  assert(Number.isInteger(evidence.projectA?.importChunkCount) && evidence.projectA.importChunkCount > 0, 'Vector evidence has no imported chunks')
  assert(evidence.projectA?.ftsResultCount === 0, 'Vector evidence did not prove the expected FTS miss')
  assert(Number.isInteger(evidence.projectA?.semanticResultCount) && evidence.projectA.semanticResultCount > 0, 'Vector evidence did not prove semantic retrieval')
  assert(evidence.projectB?.initialVectorDimension === 768 && evidence.projectB?.vectorDimension === 1536, 'Vector evidence did not verify dimension migration')
  assert(Number.isInteger(evidence.projectB?.initialImportChunkCount) && evidence.projectB.initialImportChunkCount > 0, 'Vector migration evidence has no initial import')
  assert(Number.isInteger(evidence.projectB?.backfilledChunkCount) && evidence.projectB.backfilledChunkCount > 0, 'Vector migration evidence has no backfill')
  assert(evidence.projectB?.sameFingerprintRebuilt === true, 'Vector evidence did not verify same-fingerprint rebuilding')
  assert(evidence.projectB?.ftsResultCount === 0, 'Migrated vector evidence did not prove the expected FTS miss')
  assert(Number.isInteger(evidence.projectB?.semanticResultCount) && evidence.projectB.semanticResultCount > 0, 'Migrated vector evidence did not prove semantic retrieval')
}

function validateHomepageEvidence(evidence) {
  assert(evidence?.schemaVersion === 1 && evidence?.kind === 'packaged-official-homepage-smoke', 'Homepage qualification evidence has the wrong schema or kind')
  assert(evidence.trustedIntent?.channel === 'official-homepage:open', 'Homepage evidence used the wrong IPC channel')
  assert(evidence.trustedIntent?.requestArgumentCount === 0, 'Homepage evidence accepted renderer-controlled arguments')
  assert(evidence.trustedIntent?.url === 'https://github.com/EthanYoQ/AI-Novel-Writer', 'Homepage evidence opened the wrong URL')
  assert(evidence.trustedIntent?.success === true && evidence.trustedIntent?.shellOpenExternalCalls === 1, 'Homepage evidence did not prove the trusted success path')
  assert(evidence.failedOpenExternal?.success === false && evidence.failedOpenExternal?.shellOpenExternalCalls === 1, 'Homepage evidence did not prove controlled failure handling')
  assert(typeof evidence.failedOpenExternal?.controllerError === 'string' && evidence.failedOpenExternal.controllerError.length > 0, 'Homepage failure evidence is incomplete')
  assert(typeof evidence.failedOpenExternal?.rendererError?.zhCN === 'string' && evidence.failedOpenExternal.rendererError.zhCN.length > 0, 'Homepage Chinese renderer error evidence is incomplete')
  assert(typeof evidence.failedOpenExternal?.rendererError?.enUS === 'string' && evidence.failedOpenExternal.rendererError.enUS.length > 0, 'Homepage English renderer error evidence is incomplete')
}

function assertEmptyOrMissingDirectory(directory) {
  if (!existsSync(directory)) return
  assert(lstatSync(directory).isDirectory(), `Promotion output is not a directory: ${directory}`)
  assert(readdirSync(directory).length === 0, `Promotion output must be empty: ${directory}`)
}

export function verifyDownloadedQualification({ artifactRoot, qualifiedSource, sourceCommit, sourcePlan, outputDirectory }) {
  assert(sourcePlan?.schemaVersion === 1 && sourcePlan?.state === 'SOURCE_VERIFIED', 'Source verification plan is invalid')
  assert(String(sourceCommit ?? '').toLowerCase() === sourcePlan.expectedSha, 'Qualified source checkout does not match expected_sha')
  const packageMetadata = jsonFile(path.join(qualifiedSource, 'package.json'), 'qualified package.json')
  assert(packageMetadata?.version === sourcePlan.version, `Qualified source version ${packageMetadata?.version ?? '(missing)'} does not match ${sourcePlan.tag}`)
  assert(sha256(path.join(qualifiedSource, 'pnpm-lock.yaml')) !== '', 'Qualified source lockfile could not be hashed')

  const allArtifactFiles = listRegularFiles(artifactRoot)
  assert(!allArtifactFiles.some(file => file.toLowerCase().endsWith('.zip')), 'Portable ZIP files are forbidden in formal promotion input')
  const manifests = allArtifactFiles.filter(file => path.posix.basename(file) === 'manifest.json')
  assert(manifests.length === 1, `Expected exactly one manifest.json, found ${manifests.length}`)
  const bundleRoot = path.join(artifactRoot, path.dirname(manifests[0]))
  const bundleFiles = listRegularFiles(bundleRoot)
  assert(bundleFiles.length === allArtifactFiles.length, 'Qualification artifact contains files outside the verified release bundle')

  const manifestPath = path.join(bundleRoot, 'manifest.json')
  const manifest = jsonFile(manifestPath, 'runtime verification manifest')
  assert(manifest?.schemaVersion === 1, 'Runtime verification manifest schema is invalid')
  assert(manifest.gateLevel === 'RUNTIME_VERIFIED', 'Runtime verification manifest gateLevel is not RUNTIME_VERIFIED')
  assert(manifest.releaseCreated === false, 'Qualification manifest unexpectedly claims that a Release was created')
  assert(String(manifest.commit ?? '').toLowerCase() === sourcePlan.expectedSha, 'Runtime verification manifest commit does not match expected_sha')
  assert(manifest.lockfileSha256 === sha256(path.join(qualifiedSource, 'pnpm-lock.yaml')), 'Runtime verification manifest lockfile hash does not match qualified source')

  const installer = `ai-novel-writer-setup-${sourcePlan.version}.exe`
  const blockmap = `${installer}.blockmap`
  const evidenceFiles = [
    'qualification/packaged-vector-smoke.json',
    'qualification/packaged-official-homepage-smoke.json',
  ]
  const expectedFiles = ['SHA256SUMS.txt', blockmap, installer, 'latest.yml', 'manifest.json', ...evidenceFiles].sort()
  assert(JSON.stringify(bundleFiles) === JSON.stringify(expectedFiles), `Qualification artifact file set is not exact; got ${bundleFiles.join(', ')}`)

  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 3, 'Runtime verification manifest must contain exactly three updater artifacts')
  const manifestArtifacts = new Map()
  for (const artifact of manifest.artifacts) {
    assert(typeof artifact?.file === 'string' && !manifestArtifacts.has(artifact.file), 'Runtime verification manifest contains a duplicate or invalid artifact')
    manifestArtifacts.set(artifact.file, artifact)
  }
  assert(JSON.stringify([...manifestArtifacts.keys()].sort()) === JSON.stringify([blockmap, installer, 'latest.yml'].sort()), 'Runtime verification manifest artifact names are not exact')
  for (const [file, record] of manifestArtifacts) {
    const absolute = path.join(bundleRoot, file)
    const metadata = statSync(absolute)
    assert(metadata.isFile() && metadata.size > 0, `Verified artifact is missing or empty: ${file}`)
    assert(record.sizeBytes === metadata.size, `Manifest size mismatch for ${file}`)
    assert(record.sha256 === sha256(absolute), `Manifest SHA-256 mismatch for ${file}`)
  }

  const checksums = parseChecksums(readFileSync(path.join(bundleRoot, 'SHA256SUMS.txt'), 'utf8'))
  assert(JSON.stringify([...checksums.keys()].sort()) === JSON.stringify([blockmap, installer, 'latest.yml', 'manifest.json'].sort()), 'SHA256SUMS.txt entries are not exact')
  for (const [file, expectedHash] of checksums) {
    assert(sha256(path.join(bundleRoot, file)) === expectedHash, `SHA256SUMS.txt mismatch for ${file}`)
  }

  const updater = parseUpdaterMetadata(readFileSync(path.join(bundleRoot, 'latest.yml'), 'utf8'))
  assert(updater.version === sourcePlan.version, 'latest.yml version does not match the requested tag')
  assert(updater.path === installer, 'latest.yml legacy path does not name the expected installer')
  assert(updater.urls.includes(installer), 'latest.yml file list does not name the expected installer')
  assert(!updater.urls.some(url => url.toLowerCase().endsWith('.zip')), 'latest.yml references a forbidden portable ZIP')

  validateVectorEvidence(jsonFile(path.join(bundleRoot, evidenceFiles[0]), 'vector qualification evidence'))
  validateHomepageEvidence(jsonFile(path.join(bundleRoot, evidenceFiles[1]), 'homepage qualification evidence'))

  const inventory = bundleFiles.map(file => ({
    file,
    sizeBytes: statSync(path.join(bundleRoot, file)).size,
    sha256: sha256(path.join(bundleRoot, file)),
  }))
  const verifiedPlan = {
    ...sourcePlan,
    state: 'RUNTIME_ARTIFACT_VERIFIED',
    verifiedFiles: inventory,
    releaseAssets: [installer, blockmap, 'latest.yml'].map(file => inventory.find(record => record.file === file)),
  }

  if (outputDirectory) {
    assertEmptyOrMissingDirectory(outputDirectory)
    mkdirSync(path.join(outputDirectory, 'bundle', 'qualification'), { recursive: true })
    for (const file of bundleFiles) {
      const destination = path.join(outputDirectory, 'bundle', ...file.split('/'))
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(path.join(bundleRoot, ...file.split('/')), destination)
    }
    writeFileSync(path.join(outputDirectory, 'promotion-plan.json'), `${JSON.stringify(verifiedPlan, null, 2)}\n`, 'utf8')
  }
  return verifiedPlan
}

export function verifyStagedPromotion(readyRoot) {
  const plan = jsonFile(path.join(readyRoot, 'promotion-plan.json'), 'promotion plan')
  assert(plan?.schemaVersion === 1 && plan?.state === 'RUNTIME_ARTIFACT_VERIFIED', 'Promotion plan is not runtime-verified')
  parseFinalTag(plan.tag)
  const actualFiles = listRegularFiles(path.join(readyRoot, 'bundle'))
  const expectedFiles = plan.verifiedFiles?.map(record => record.file).sort()
  assert(Array.isArray(expectedFiles) && JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), 'Staged promotion file set changed after verification')
  for (const record of plan.verifiedFiles) {
    const file = path.join(readyRoot, 'bundle', ...record.file.split('/'))
    const metadata = statSync(file)
    assert(metadata.size === record.sizeBytes, `Staged promotion size changed: ${record.file}`)
    assert(sha256(file) === record.sha256, `Staged promotion SHA-256 changed: ${record.file}`)
  }
  assert(!actualFiles.some(file => file.toLowerCase().endsWith('.zip')), 'Staged promotion contains a forbidden portable ZIP')
  const expectedReleaseAssets = [
    `ai-novel-writer-setup-${plan.version}.exe`,
    `ai-novel-writer-setup-${plan.version}.exe.blockmap`,
    'latest.yml',
  ].sort()
  const releaseAssets = plan.releaseAssets?.map(asset => asset?.file).sort()
  assert(Array.isArray(releaseAssets) && JSON.stringify(releaseAssets) === JSON.stringify(expectedReleaseAssets), 'Promotion plan release asset set is not exact')
  for (const releaseAsset of plan.releaseAssets) {
    const inventory = plan.verifiedFiles.find(record => record.file === releaseAsset.file)
    assert(inventory && inventory.sizeBytes === releaseAsset.sizeBytes && inventory.sha256 === releaseAsset.sha256, `Release asset is inconsistent with the verified inventory: ${releaseAsset.file}`)
  }
  return plan
}

export function verifyRemoteReleaseAssets(release, localAssets) {
  assert(release?.draft === true, 'Release must remain a draft while assets are verified')
  assert(release?.prerelease === false, 'Release must not be a prerelease')
  assert(Array.isArray(release.assets), 'Release assets response is invalid')
  const expected = new Map(localAssets.map(asset => [asset.file, asset]))
  assert(expected.size === localAssets.length, 'Local release asset names are not unique')
  assert(release.assets.length === expected.size, `Remote Release has ${release.assets.length} assets; expected ${expected.size}`)
  for (const asset of release.assets) {
    const local = expected.get(asset?.name)
    assert(local, `Unexpected remote Release asset: ${asset?.name ?? '(missing name)'}`)
    assert(asset.state === 'uploaded', `Remote Release asset is not uploaded: ${asset.name}`)
    assert(asset.size === local.sizeBytes, `Remote Release asset size mismatch: ${asset.name}`)
    assert(String(asset.digest ?? '').toLowerCase() === `sha256:${local.sha256}`, `Remote Release asset digest mismatch: ${asset.name}`)
  }
  return true
}

async function apiRequest({ token, url, method = 'GET', body, headers = {}, allow = [] }) {
  assert(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN is required')
  const response = await fetch(url, {
    method,
    body,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AI-Novel-Writer-runtime-promotion',
      ...headers,
    },
  })
  if (allow.includes(response.status)) return { response, data: null }
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`GitHub API ${method} ${url} failed (${response.status}): ${detail.slice(0, 500)}`)
  }
  const text = await response.text()
  return { response, data: text ? JSON.parse(text) : null }
}

function apiBase(repository) {
  return `https://api.github.com/repos/${repository}`
}

async function proveTagAndReleaseAbsent(token, repository, tag) {
  const base = apiBase(repository)
  const tagResult = await apiRequest({ token, url: `${base}/git/ref/tags/${encodeURIComponent(tag)}`, allow: [404] })
  const releaseResult = await apiRequest({ token, url: `${base}/releases/tags/${encodeURIComponent(tag)}`, allow: [404] })
  let listedReleaseStatus = 404
  for (let page = 1; page <= 100; page += 1) {
    const { data: releases } = await apiRequest({ token, url: `${base}/releases?per_page=100&page=${page}` })
    assert(Array.isArray(releases), 'GitHub Release listing is invalid')
    if (releases.some(release => release?.tag_name === tag)) {
      listedReleaseStatus = 200
      break
    }
    if (releases.length < 100) break
    assert(page < 100, 'GitHub Release listing exceeded the fail-closed pagination limit')
  }
  return {
    tagRefStatus: tagResult.response.status,
    releaseStatus: releaseResult.response.status === 200 || listedReleaseStatus === 200 ? 200 : 404,
  }
}

export async function createSourcePlan({ token, inputs }) {
  const base = apiBase(inputs.repository)
  const { data: repository } = await apiRequest({ token, url: base })
  const workflowFile = path.posix.basename(EXPECTED_WORKFLOW_PATH)
  const { data: workflow } = await apiRequest({ token, url: `${base}/actions/workflows/${encodeURIComponent(workflowFile)}` })
  const { data: run } = await apiRequest({ token, url: `${base}/actions/runs/${inputs.qualificationRunId}` })
  const defaultBranch = encodeURIComponent(repository.default_branch)
  const expectedSha = encodeURIComponent(inputs.expectedSha)
  const { data: comparison } = await apiRequest({ token, url: `${base}/compare/${expectedSha}...${defaultBranch}` })
  const { data: artifactsResponse } = await apiRequest({ token, url: `${base}/actions/runs/${inputs.qualificationRunId}/artifacts?per_page=100` })
  const absence = await proveTagAndReleaseAbsent(token, inputs.repository, inputs.tag)
  return validateQualificationSource({ inputs, repository, workflow, run, comparison, artifactsResponse, ...absence })
}

function contentType(file) {
  if (file.endsWith('.yml')) return 'application/x-yaml'
  if (file.endsWith('.blockmap')) return 'application/octet-stream'
  return 'application/vnd.microsoft.portable-executable'
}

export async function publishPromotion({ token, readyRoot, expectedRepository, expectedTag }) {
  const plan = verifyStagedPromotion(readyRoot)
  assert(plan.repository === expectedRepository, 'Promotion package repository does not match the workflow repository')
  assert(plan.tag === expectedTag, 'Promotion package tag does not match the dispatched tag')
  await proveTagAndReleaseAbsent(token, plan.repository, plan.tag).then(({ tagRefStatus, releaseStatus }) => {
    assertAbsentResponse(tagRefStatus, `Git tag ${plan.tag}`)
    assertAbsentResponse(releaseStatus, `GitHub Release ${plan.tag}`)
  })

  const base = apiBase(plan.repository)
  let draft
  try {
    const created = await apiRequest({
      token,
      url: `${base}/releases`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: plan.tag,
        target_commitish: plan.expectedSha,
        name: plan.tag,
        body: `Windows runtime-verified release promoted from qualification run ${plan.qualificationRunId}.`,
        draft: true,
        prerelease: false,
      }),
    })
    draft = created.data
    assert(draft?.id && draft?.draft === true && draft?.prerelease === false, 'GitHub did not create the expected draft Release')
    assert(draft.tag_name === plan.tag, 'Created draft Release has the wrong tag')
    const uploadBase = String(draft.upload_url ?? '').replace(/\{.*$/, '')
    assert(uploadBase.startsWith('https://uploads.github.com/'), 'Draft Release has an invalid upload URL')

    for (const asset of plan.releaseAssets) {
      const file = path.join(readyRoot, 'bundle', ...asset.file.split('/'))
      await apiRequest({
        token,
        url: `${uploadBase}?name=${encodeURIComponent(asset.file)}`,
        method: 'POST',
        headers: { 'Content-Type': contentType(asset.file), 'Content-Length': String(asset.sizeBytes) },
        body: readFileSync(file),
      })
    }

    const refreshed = await apiRequest({ token, url: `${base}/releases/${draft.id}` })
    verifyRemoteReleaseAssets(refreshed.data, plan.releaseAssets)
    const published = await apiRequest({
      token,
      url: `${base}/releases/${draft.id}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false, prerelease: false }),
    })
    assert(published.data?.draft === false && published.data?.prerelease === false, 'GitHub did not publish a final non-prerelease Release')
    assert(published.data?.tag_name === plan.tag, 'Published Release tag is inconsistent')
    return { releaseId: draft.id, url: published.data.html_url, tag: plan.tag }
  } catch (error) {
    if (draft?.id) {
      console.error(`Promotion failed after draft creation. Draft Release ${draft.id} was intentionally left in place: ${draft.html_url ?? '(no URL)'}`)
    }
    throw error
  }
}

function argumentsMap(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    assert(option.startsWith('--') && argv[index + 1] !== undefined, `Invalid command argument: ${option}`)
    result.set(option.slice(2), argv[index + 1])
    index += 1
  }
  return result
}

function requiredArgument(args, name) {
  const value = args.get(name)
  assert(typeof value === 'string' && value.length > 0, `Missing --${name}`)
  return value
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8')
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = argumentsMap(rest)
  if (command === 'plan') {
    const plan = await createSourcePlan({
      token: process.env.GITHUB_TOKEN,
      inputs: {
        repository: requiredArgument(args, 'repository'),
        qualificationRunId: requiredArgument(args, 'qualification-run-id'),
        expectedSha: requiredArgument(args, 'expected-sha'),
        tag: requiredArgument(args, 'tag'),
        confirmation: requiredArgument(args, 'confirmation'),
      },
    })
    writeFileSync(path.resolve(requiredArgument(args, 'output')), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    writeOutput('artifact_id', plan.artifact.id)
    process.stdout.write(`Verified qualification run ${plan.qualificationRunId} and artifact ${plan.artifact.id}.\n`)
    return
  }
  if (command === 'verify') {
    const qualifiedSource = path.resolve(requiredArgument(args, 'qualified-source'))
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: qualifiedSource, encoding: 'utf8' }).trim()
    const verified = verifyDownloadedQualification({
      artifactRoot: path.resolve(requiredArgument(args, 'artifact-root')),
      qualifiedSource,
      sourceCommit,
      sourcePlan: jsonFile(path.resolve(requiredArgument(args, 'plan')), 'source verification plan'),
      outputDirectory: path.resolve(requiredArgument(args, 'output')),
    })
    process.stdout.write(`Verified ${verified.verifiedFiles.length} qualification files for ${verified.tag}.\n`)
    return
  }
  if (command === 'publish') {
    const result = await publishPromotion({
      token: process.env.GITHUB_TOKEN,
      readyRoot: path.resolve(requiredArgument(args, 'ready-root')),
      expectedRepository: requiredArgument(args, 'repository'),
      expectedTag: requiredArgument(args, 'tag'),
    })
    writeOutput('release_url', result.url)
    process.stdout.write(`Published ${result.tag}: ${result.url}\n`)
    return
  }
  throw new Error('Usage: promote-windows-runtime-artifact.mjs <plan|verify|publish> [options]')
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
