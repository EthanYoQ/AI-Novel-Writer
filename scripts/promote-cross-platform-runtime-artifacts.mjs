import { createHash } from 'node:crypto'
import {
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
import { canonicalPnpmLockfileSha256 } from './canonical-pnpm-lockfile-hash.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const WINDOWS_WORKFLOW_NAME = 'Windows cloud package qualification'
const WINDOWS_WORKFLOW_PATH = '.github/workflows/windows-cloud-build-test.yml'
const WINDOWS_ARTIFACT_NAME = 'windows-cloud-build-runtime-verified'
const MACOS_WORKFLOW_NAME = 'macOS ARM64 cloud package qualification'
const MACOS_WORKFLOW_PATH = '.github/workflows/macos-arm64-cloud-build.yml'
const MACOS_ARTIFACT_NAME = 'macos-arm64-cloud-build-runtime-verified'
export const PROMOTION_CONFIRMATION = 'PROMOTE_RUNTIME_VERIFIED_CROSS_PLATFORM_RELEASE'

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
  const files = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = normalizedRelative(path.relative(root, absolute))
      const metadata = lstatSync(absolute)
      assert(!metadata.isSymbolicLink(), `Symbolic links are forbidden in promotion input: ${relative}`)
      if (entry.isDirectory()) visit(absolute)
      else {
        assert(entry.isFile(), `Only regular files are allowed in promotion input: ${relative}`)
        files.push(relative)
      }
    }
  }
  visit(root)
  return files.sort()
}

function parseFinalTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '')
  assert(match, 'tag must be a final v-prefixed semantic version (for example v0.5.0)')
  return match.slice(1).join('.')
}

function workflowPath(pathWithRef) {
  return String(pathWithRef ?? '').split('@', 1)[0]
}

function parseChecksums(text) {
  const records = new Map()
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64}) \*([^\\]+)$/i.exec(line)
    assert(match, `Invalid SHA256SUMS.txt line: ${line}`)
    const file = match[2].replaceAll('\\', '/')
    assert(!records.has(file), `Duplicate checksum entry: ${file}`)
    records.set(file, match[1].toLowerCase())
  }
  return records
}

function exactFileSet(actual, expected, label) {
  assert(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), `${label} file set is not exact; got ${[...actual].join(', ')}`)
}

export function resolvePromotionArtifactRoot(root, label) {
  const files = listRegularFiles(root)
  const manifests = files.filter(file => path.posix.basename(file) === 'manifest.json')
  assert(manifests.length === 1, `Expected exactly one manifest.json in ${label}, found ${manifests.length}`)
  const bundleRelativePath = path.posix.dirname(manifests[0])
  const bundleRoot = path.join(root, bundleRelativePath)
  const bundlePrefix = bundleRelativePath === '.' ? '' : `${bundleRelativePath}/`
  const filesOutsideBundle = files.filter(file => bundlePrefix !== '' && !file.startsWith(bundlePrefix))
  assert(filesOutsideBundle.length === 0, `${label} artifact contains files outside its verified bundle: ${filesOutsideBundle.join(', ')}`)
  const bundleFilesFromRoot = files.map(file => bundlePrefix === '' ? file : file.slice(bundlePrefix.length))
  exactFileSet(bundleFilesFromRoot, listRegularFiles(bundleRoot), `${label} artifact`)
  return bundleRoot
}

function validateEvidence(file, kind) {
  const evidence = jsonFile(file, 'qualification evidence')
  assert(evidence?.schemaVersion === 1 && evidence?.kind === kind, `Qualification evidence has invalid kind: ${path.basename(file)}`)
  return evidence
}

function validateVectorEvidence(evidence) {
  assert(evidence.projectA?.vectorDimension === 768, 'Vector qualification did not verify the 768-dimensional project')
  assert(Number.isInteger(evidence.projectA?.importChunkCount) && evidence.projectA.importChunkCount > 0, 'Vector qualification has no imported project-A chunks')
  assert(evidence.projectA?.ftsResultCount === 0 && Number(evidence.projectA?.semanticResultCount) > 0, 'Vector qualification did not prove project-A retrieval')
  assert(evidence.projectB?.initialVectorDimension === 768 && evidence.projectB?.vectorDimension === 1536, 'Vector qualification did not verify dimension migration')
  assert(Number.isInteger(evidence.projectB?.initialImportChunkCount) && evidence.projectB.initialImportChunkCount > 0, 'Vector qualification has no project-B initial import')
  assert(Number.isInteger(evidence.projectB?.backfilledChunkCount) && evidence.projectB.backfilledChunkCount > 0, 'Vector qualification has no project-B backfill')
  assert(evidence.projectB?.sameFingerprintRebuilt === true, 'Vector qualification did not verify same-fingerprint rebuilding')
  assert(evidence.projectB?.ftsResultCount === 0 && Number(evidence.projectB?.semanticResultCount) > 0, 'Vector qualification did not prove migrated retrieval')
}

function validateHomepageEvidence(evidence) {
  assert(evidence.trustedIntent?.channel === 'official-homepage:open', 'Homepage qualification used the wrong IPC channel')
  assert(evidence.trustedIntent?.requestArgumentCount === 0 && evidence.trustedIntent?.success === true && evidence.trustedIntent?.shellOpenExternalCalls === 1, 'Homepage qualification did not prove the trusted success path')
  assert(evidence.failedOpenExternal?.success === false && evidence.failedOpenExternal?.shellOpenExternalCalls === 1, 'Homepage qualification did not prove controlled failure')
  assert(typeof evidence.failedOpenExternal?.controllerError === 'string' && evidence.failedOpenExternal.controllerError.length > 0, 'Homepage qualification error evidence is incomplete')
}

function validateManifestArtifact(manifest, bundleRoot, expectedFiles, expectedCommit, expectedLockfile, label) {
  assert(manifest?.schemaVersion === 1, `${label} manifest schema is invalid`)
  assert(manifest.gateLevel === 'RUNTIME_VERIFIED', `${label} manifest gate level is invalid`)
  assert(manifest.releaseCreated === false, `${label} qualification manifest claims a Release was created`)
  assert(String(manifest.commit ?? '').toLowerCase() === expectedCommit, `${label} manifest commit does not match expected_sha`)
  assert(manifest.lockfileSha256 === expectedLockfile, `${label} manifest lockfile hash does not match qualified source`)
  assert(Array.isArray(manifest.artifacts), `${label} manifest has no artifact inventory`)
  exactFileSet(manifest.artifacts.map(record => record?.file), expectedFiles, `${label} manifest artifact`)
  for (const record of manifest.artifacts) {
    const file = path.join(bundleRoot, record.file)
    const metadata = statSync(file)
    assert(metadata.isFile() && metadata.size > 0, `${label} artifact is missing or empty: ${record.file}`)
    assert(record.sizeBytes === metadata.size, `${label} manifest size mismatch: ${record.file}`)
    assert(record.sha256 === sha256(file), `${label} manifest SHA-256 mismatch: ${record.file}`)
  }
}

function validateWindowsArtifact(root, { expectedSha, lockfileSha256, version }) {
  const bundleRoot = resolvePromotionArtifactRoot(root, 'Windows qualification')
  const installer = `ai-novel-writer-setup-${version}.exe`
  const blockmap = `${installer}.blockmap`
  const evidence = ['qualification/packaged-vector-smoke.json', 'qualification/packaged-official-homepage-smoke.json']
  const expected = ['SHA256SUMS.txt', 'manifest.json', installer, blockmap, 'latest.yml', ...evidence]
  exactFileSet(listRegularFiles(bundleRoot), expected, 'Windows qualification')
  const manifest = jsonFile(path.join(bundleRoot, 'manifest.json'), 'Windows manifest')
  validateManifestArtifact(manifest, bundleRoot, [installer, blockmap, 'latest.yml'], expectedSha, lockfileSha256, 'Windows')
  const sums = parseChecksums(readFileSync(path.join(bundleRoot, 'SHA256SUMS.txt'), 'utf8'))
  exactFileSet(sums.keys(), [installer, blockmap, 'latest.yml', 'manifest.json'], 'Windows SHA-256')
  for (const [file, digest] of sums) assert(sha256(path.join(bundleRoot, file)) === digest, `Windows SHA-256 mismatch: ${file}`)
  validateVectorEvidence(validateEvidence(path.join(bundleRoot, evidence[0]), 'packaged-vector-smoke'))
  validateHomepageEvidence(validateEvidence(path.join(bundleRoot, evidence[1]), 'packaged-official-homepage-smoke'))
  return { bundleRoot, releaseFiles: [installer, blockmap, 'latest.yml'] }
}

function validateMacosArtifact(root, { expectedSha, lockfileSha256, version }) {
  const bundleRoot = resolvePromotionArtifactRoot(root, 'macOS qualification')
  const dmg = `ai-novel-writer-mac-arm64-${version}-installer.dmg`
  const dmgChecksum = `${dmg}.sha256`
  const evidence = [
    ['qualification/packaged-vector-smoke.json', 'packaged-vector-smoke'],
    ['qualification/packaged-official-homepage-smoke.json', 'packaged-official-homepage-smoke'],
    ['qualification/macos-dmg-smoke.json', 'macos-dmg-smoke'],
  ]
  exactFileSet(listRegularFiles(bundleRoot), ['SHA256SUMS.txt', 'manifest.json', dmg, dmgChecksum, ...evidence.map(([file]) => file)], 'macOS qualification')
  const manifest = jsonFile(path.join(bundleRoot, 'manifest.json'), 'macOS manifest')
  assert(manifest.platform === 'darwin' && manifest.arch === 'arm64', 'macOS manifest platform/architecture is invalid')
  assert(manifest.dmgChecksum === dmgChecksum, 'macOS manifest checksum file is invalid')
  validateManifestArtifact(manifest, bundleRoot, [dmg], expectedSha, lockfileSha256, 'macOS')
  const sums = parseChecksums(readFileSync(path.join(bundleRoot, 'SHA256SUMS.txt'), 'utf8'))
  exactFileSet(sums.keys(), [dmg, 'manifest.json'], 'macOS SHA-256')
  for (const [file, digest] of sums) assert(sha256(path.join(bundleRoot, file)) === digest, `macOS SHA-256 mismatch: ${file}`)
  assert(readFileSync(path.join(bundleRoot, dmgChecksum), 'utf8').trim() === `${sha256(path.join(bundleRoot, dmg))}  ${dmg}`, 'macOS DMG checksum file does not match the DMG')
  validateVectorEvidence(validateEvidence(path.join(bundleRoot, evidence[0][0]), evidence[0][1]))
  validateHomepageEvidence(validateEvidence(path.join(bundleRoot, evidence[1][0]), evidence[1][1]))
  validateEvidence(path.join(bundleRoot, evidence[2][0]), evidence[2][1])
  const dmgSmoke = jsonFile(path.join(bundleRoot, 'qualification/macos-dmg-smoke.json'), 'macOS DMG smoke')
  assert(dmgSmoke.platform === 'darwin' && dmgSmoke.arch === 'arm64', 'macOS DMG smoke platform/architecture is invalid')
  assert(dmgSmoke.dmgSha256 === sha256(path.join(bundleRoot, dmg)), 'macOS DMG smoke SHA-256 does not match the DMG')
  assert(dmgSmoke.secureFileSystemSmoke === true && dmgSmoke.secureFileSystemHelper === 'security/darwin-safe-file-system', 'macOS DMG smoke did not verify the packaged secure file-system helper')
  return { bundleRoot, releaseFiles: [dmg, dmgChecksum] }
}

function readArguments(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    assert(typeof key === 'string' && key.startsWith('--') && typeof value === 'string', `Invalid argument near ${key ?? '(end)'}`)
    assert(!result.has(key), `Duplicate argument: ${key}`)
    result.set(key, value)
  }
  return result
}

function required(args, name) {
  const value = args.get(name)
  assert(typeof value === 'string' && value.length > 0, `Missing required argument: ${name}`)
  return value
}

function requiredEnvironment(name) {
  const value = process.env[name]
  assert(typeof value === 'string' && value.length > 0, `Missing required environment variable: ${name}`)
  return value
}

async function requestJson(fetcher, url, options, label) {
  const response = await fetcher(url, options)
  assert(response?.ok, `${label} request failed${response ? ` (${response.status})` : ''}`)
  return response.json()
}

async function requestMaybeNotFound(fetcher, url, options, label) {
  const response = await fetcher(url, options)
  if (response?.status === 404) return null
  assert(response?.ok, `${label} request failed${response ? ` (${response.status})` : ''}`)
  return response.json()
}

function apiHeaders(token) {
  return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
}

function validateRun({ repository, run, workflow, comparison, artifactResponse, expectedSha, runId, workflowName, workflowPathExpected, artifactName, label }) {
  assert(String(run?.id) === String(runId), `${label} run ID does not match`)
  assert(run?.status === 'completed' && run?.conclusion === 'success', `${label} qualification run did not succeed`)
  assert(String(run?.head_sha ?? '').toLowerCase() === expectedSha, `${label} qualification run SHA does not match expected_sha`)
  assert(run?.head_branch === repository.default_branch, `${label} qualification run did not execute on the default branch`)
  assert(run?.head_repository?.full_name === repository.full_name, `${label} qualification run came from another repository`)
  assert(run?.event === 'workflow_dispatch', `${label} qualification run was not manually dispatched`)
  assert(workflow?.name === workflowName, `${label} qualification workflow name is invalid`)
  assert(workflowPath(workflow?.path) === workflowPathExpected, `${label} qualification workflow path is invalid`)
  assert(run?.workflow_id === workflow.id && run?.name === workflowName && workflowPath(run?.path) === workflowPathExpected, `${label} run does not belong to its expected workflow`)
  assert(['ahead', 'identical'].includes(comparison?.status), `${label} qualification commit is not an ancestor of the default branch`)
  assert(String(comparison?.merge_base_commit?.sha ?? '').toLowerCase() === expectedSha, `${label} qualification comparison merge base is invalid`)
  assert(String(comparison?.base_commit?.sha ?? '').toLowerCase() === expectedSha, `${label} qualification comparison base is invalid`)
  assert(Number.isInteger(artifactResponse?.total_count) && artifactResponse.total_count <= 100, `${label} artifact listing is incomplete`)
  assert(Array.isArray(artifactResponse.artifacts) && artifactResponse.artifacts.length === artifactResponse.total_count, `${label} artifact listing is incomplete`)
  const matches = artifactResponse.artifacts?.filter(artifact => artifact?.name === artifactName) ?? []
  assert(matches.length === 1, `${label} qualification artifact is not unique`)
  const artifact = matches[0]
  assert(Number.isInteger(artifact.id) && artifact.id > 0 && artifact.expired === false && Number(artifact.size_in_bytes) > 0, `${label} qualification artifact is invalid`)
  assert(Date.parse(artifact.expires_at ?? '') > Date.now(), `${label} qualification artifact is expired`)
  assert(String(artifact.workflow_run?.id ?? '') === String(run.id) && String(artifact.workflow_run?.head_sha ?? '').toLowerCase() === expectedSha, `${label} qualification artifact is not bound to the verified run`)
  return { runId: Number(runId), workflow: { id: workflow.id, name: workflow.name, path: workflowPathExpected }, artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest ?? null } }
}

export async function planPromotion({ inputs, fetcher = globalThis.fetch, apiBaseUrl = 'https://api.github.com', token }) {
  assert(inputs?.confirmation === PROMOTION_CONFIRMATION, `confirmation must exactly equal ${PROMOTION_CONFIRMATION}`)
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(inputs?.repository ?? ''), 'repository must be owner/repo')
  assert(/^\d+$/.test(String(inputs?.windowsQualificationRunId ?? '')), 'windows_qualification_run_id must be a positive integer')
  assert(/^\d+$/.test(String(inputs?.macosQualificationRunId ?? '')), 'macos_qualification_run_id must be a positive integer')
  assert(/^[a-f0-9]{40}$/i.test(inputs?.expectedSha ?? ''), 'expected_sha must be a full 40-character commit SHA')
  const expectedSha = inputs.expectedSha.toLowerCase()
  const version = parseFinalTag(inputs.tag)
  const api = apiBaseUrl.replace(/\/$/, '')
  const headers = apiHeaders(token)
  const [repository, windowsRun, macosRun, remoteTag] = await Promise.all([
    requestJson(fetcher, `${api}/repos/${inputs.repository}`, { headers }, 'Repository metadata'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/runs/${inputs.windowsQualificationRunId}`, { headers }, 'Windows qualification run'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/runs/${inputs.macosQualificationRunId}`, { headers }, 'macOS qualification run'),
    requestMaybeNotFound(fetcher, `${api}/repos/${inputs.repository}/git/ref/tags/${encodeURIComponent(inputs.tag)}`, { headers }, 'Release tag'),
  ])
  assert(repository?.full_name === inputs.repository && typeof repository.default_branch === 'string', 'Repository identity/default branch is invalid')
  if (remoteTag !== null) {
    assert(remoteTag?.ref === `refs/tags/${inputs.tag}` && remoteTag?.object?.type === 'commit', `Existing Git tag ${inputs.tag} is not a lightweight commit tag`)
    assert(String(remoteTag.object.sha).toLowerCase() === expectedSha, `Existing Git tag ${inputs.tag} does not resolve to expected_sha`)
  }
  const [comparison, windowsWorkflow, macosWorkflow, windowsArtifacts, macosArtifacts] = await Promise.all([
    requestJson(fetcher, `${api}/repos/${inputs.repository}/compare/${encodeURIComponent(expectedSha)}...${encodeURIComponent(repository.default_branch)}`, { headers }, 'Default-branch ancestry'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/workflows/${windowsRun.workflow_id}`, { headers }, 'Windows workflow'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/workflows/${macosRun.workflow_id}`, { headers }, 'macOS workflow'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/runs/${inputs.windowsQualificationRunId}/artifacts?per_page=100`, { headers }, 'Windows artifacts'),
    requestJson(fetcher, `${api}/repos/${inputs.repository}/actions/runs/${inputs.macosQualificationRunId}/artifacts?per_page=100`, { headers }, 'macOS artifacts'),
  ])
  const windows = validateRun({ repository, run: windowsRun, workflow: windowsWorkflow, comparison, artifactResponse: windowsArtifacts, expectedSha, runId: inputs.windowsQualificationRunId, workflowName: WINDOWS_WORKFLOW_NAME, workflowPathExpected: WINDOWS_WORKFLOW_PATH, artifactName: WINDOWS_ARTIFACT_NAME, label: 'Windows' })
  const macos = validateRun({ repository, run: macosRun, workflow: macosWorkflow, comparison, artifactResponse: macosArtifacts, expectedSha, runId: inputs.macosQualificationRunId, workflowName: MACOS_WORKFLOW_NAME, workflowPathExpected: MACOS_WORKFLOW_PATH, artifactName: MACOS_ARTIFACT_NAME, label: 'macOS' })
  return { schemaVersion: 1, state: 'SOURCE_VERIFIED', repository: inputs.repository, defaultBranch: repository.default_branch, expectedSha, tag: inputs.tag, version, tagWasPresent: remoteTag !== null, windows, macos }
}

export function verifyPromotion({ windowsArtifactRoot, macosArtifactRoot, qualifiedSource, sourcePlan, outputDirectory }) {
  assert(sourcePlan?.schemaVersion === 1 && sourcePlan?.state === 'SOURCE_VERIFIED', 'Source verification plan is invalid')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: qualifiedSource, encoding: 'utf8' }).trim().toLowerCase()
  assert(sourceCommit === sourcePlan.expectedSha, 'Qualified source checkout does not match expected_sha')
  const packageMetadata = jsonFile(path.join(qualifiedSource, 'package.json'), 'qualified package.json')
  assert(packageMetadata?.version === sourcePlan.version, 'Qualified source version does not match the requested release tag')
  const lockfileSha256 = canonicalPnpmLockfileSha256(path.join(qualifiedSource, 'pnpm-lock.yaml'))
  const windows = validateWindowsArtifact(windowsArtifactRoot, { expectedSha: sourcePlan.expectedSha, lockfileSha256, version: sourcePlan.version })
  const macos = validateMacosArtifact(macosArtifactRoot, { expectedSha: sourcePlan.expectedSha, lockfileSha256, version: sourcePlan.version })
  assert(!existsSync(outputDirectory) || readdirSync(outputDirectory).length === 0, 'Promotion output directory must be empty')
  mkdirSync(path.join(outputDirectory, 'assets'), { recursive: true })
  const inventory = []
  for (const [bundleRoot, files] of [[windows.bundleRoot, windows.releaseFiles], [macos.bundleRoot, macos.releaseFiles]]) {
    for (const file of files) {
      const source = path.join(bundleRoot, file)
      const destination = path.join(outputDirectory, 'assets', file)
      copyFileSync(source, destination)
      inventory.push({ file, sizeBytes: statSync(source).size, sha256: sha256(source) })
    }
  }
  inventory.sort((left, right) => left.file.localeCompare(right.file))
  const ready = { schemaVersion: 1, state: 'READY_TO_PUBLISH', repository: sourcePlan.repository, expectedSha: sourcePlan.expectedSha, tag: sourcePlan.tag, version: sourcePlan.version, assets: inventory }
  writeFileSync(path.join(outputDirectory, 'promotion-ready.json'), `${JSON.stringify(ready, null, 2)}\n`, 'utf8')
  return ready
}

export function verifyRemoteReleaseAssets(release, localAssets) {
  assert(release?.draft === true && release?.prerelease === false, 'Release must remain a final-release draft before publication')
  assert(Array.isArray(release.assets), 'Release asset list is invalid')
  exactFileSet(release.assets.map(asset => asset?.name), localAssets.map(asset => asset.file), 'Remote release asset')
  for (const local of localAssets) {
    const remote = release.assets.find(asset => asset?.name === local.file)
    assert(remote?.size === local.sizeBytes, `Remote release asset size mismatch: ${local.file}`)
    assert(remote?.digest?.toLowerCase() === `sha256:${local.sha256}`, `Remote release asset digest mismatch: ${local.file}`)
  }
}

export function releaseNotes(version) {
  return [
    `## 中文`,
    ``,
    `AI 小说作家 ${version} 是一个补丁版本，修复以下严重问题：`,
    ``,
    `- #70：增加连接测试的输出预算，避免 DeepSeek 等推理模型被误判为连接失败。`,
    `- #71：修复 Windows 安全文件系统在目录枚举中发现 junction/symlink 后中断整个目录加载的问题，避免 \`SECURE_FS_REPARSE_POINT\` 阻止项目创建或打开。`,
    `- #72：在写入向量库前拒绝 embedding 响应中的 null、非有限数值和维度异常，并返回明确错误，避免底层 Arrow 错误。`,
    ``,
    `本版本同时提供 Windows 与 macOS Apple Silicon（ARM64）安装包。`,
    ``,
    `- Windows：下载 \`ai-novel-writer-setup-${version}.exe\`。`,
    `- macOS ARM64：下载 \`ai-novel-writer-mac-arm64-${version}-installer.dmg\`。此包未签名、未公证；首次安装时 macOS Gatekeeper 可能要求在“隐私与安全性”中手动允许。`,
    `- macOS 本版本不提供应用内更新；Windows 应用内更新只使用 Windows 的 \`latest.yml\` 与安装器。`,
    ``,
    `## English`,
    ``,
    `AI Novel Writer ${version} is a patch release for the following serious issues:`,
    ``,
    `- #70: increases the connection-test output budget so DeepSeek and other reasoning models are not falsely reported as unreachable.`,
    `- #71: prevents Windows directory enumeration from failing the entire project when it encounters a junction or symlink, so \`SECURE_FS_REPARSE_POINT\` no longer blocks project creation or opening.`,
    `- #72: rejects null, non-finite, or dimensionally invalid embedding responses before vector storage and reports a clear error instead of exposing a low-level Arrow failure.`,
    ``,
    `This release includes installers for Windows and macOS Apple Silicon (ARM64).`,
    ``,
    `- Windows: download \`ai-novel-writer-setup-${version}.exe\`.`,
    `- macOS ARM64: download \`ai-novel-writer-mac-arm64-${version}-installer.dmg\`. This package is unsigned and not notarized; Gatekeeper may require a manual Allow action in Privacy & Security on first install.`,
    `- This macOS release has no in-app updater. The Windows in-app updater consumes only Windows \`latest.yml\` and installer assets.`,
  ].join('\n')
}

async function createVerifiedTag(fetcher, api, headers, ready) {
  await requestJson(fetcher, `${api}/repos/${ready.repository}/git/refs`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: `refs/tags/${ready.tag}`, sha: ready.expectedSha }),
  }, 'Create verified release tag')
}

async function tagCommitShaIfPresent(fetcher, api, headers, ready) {
  const reference = await requestMaybeNotFound(fetcher, `${api}/repos/${ready.repository}/git/ref/tags/${encodeURIComponent(ready.tag)}`, { headers }, 'Release tag')
  if (reference === null) return null
  assert(reference?.ref === `refs/tags/${ready.tag}` && reference?.object?.type === 'commit', 'Release tag is not a lightweight commit tag')
  assert(/^[a-f0-9]{40}$/i.test(reference.object.sha), 'Release tag SHA is invalid')
  return reference.object.sha.toLowerCase()
}

async function assertTagCommit(fetcher, api, headers, ready, phase) {
  const actual = await tagCommitShaIfPresent(fetcher, api, headers, ready)
  assert(actual === ready.expectedSha, `Git tag does not resolve to expected_sha ${phase}`)
}

async function assertCreatedTagCommit(fetcher, api, headers, ready, phase) {
  // GitHub can acknowledge the tag POST before the new ref is visible to a
  // subsequent GET. Retry reads only, with a finite ~30 second total budget.
  const retryDelaysMs = [0, 1_000, 2_000, 4_000, 8_000, 15_000]
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    const actual = await tagCommitShaIfPresent(fetcher, api, headers, ready)
    if (actual === null) continue
    assert(actual === ready.expectedSha, `Git tag does not resolve to expected_sha ${phase}`)
    return
  }
  throw new Error(`Git tag does not resolve to expected_sha ${phase}`)
}

function validatePromotionDraft(release, ready) {
  assert(Number.isInteger(release?.id) && release.id > 0 && typeof release.upload_url === 'string', 'Release draft response is invalid')
  assert(release.draft === true && release.prerelease === false, 'Existing Release is not an unpublished final-release draft')
  assert(release.tag_name === ready.tag && String(release.target_commitish ?? '').toLowerCase() === ready.expectedSha, 'Existing draft Release target is inconsistent')
  assert(release.name === ready.tag && release.body === releaseNotes(ready.version), 'Existing draft Release provenance is inconsistent')
  assert(Array.isArray(release.assets), 'Existing draft Release assets are invalid')
}

async function releaseDraftIfPresent(fetcher, api, headers, ready) {
  return requestMaybeNotFound(fetcher, `${api}/repos/${ready.repository}/releases/tags/${encodeURIComponent(ready.tag)}`, { headers }, 'Release draft')
}

async function createAndPopulateDraft(fetcher, api, uploads, headers, ready, readyRoot) {
  const release = await requestJson(fetcher, `${api}/repos/${ready.repository}/releases`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: ready.tag, target_commitish: ready.expectedSha, name: ready.tag, body: releaseNotes(ready.version), draft: true, prerelease: false }),
  }, 'Create release draft')
  validatePromotionDraft(release, ready)
  assert(await tagCommitShaIfPresent(fetcher, api, headers, ready) === null, 'Creating a draft unexpectedly created a Git tag')
  const uploadBase = release.upload_url.replace('{?name,label}', '').replace(/^https:\/\/uploads\.github\.com/, uploads)
  for (const asset of ready.assets) {
    const file = path.join(readyRoot, 'assets', asset.file)
    assert(sha256(file) === asset.sha256 && statSync(file).size === asset.sizeBytes, `Promotion asset changed after verification: ${asset.file}`)
    await requestJson(fetcher, `${uploadBase}?name=${encodeURIComponent(asset.file)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: readFileSync(file) }, `Upload ${asset.file}`)
  }
  const populated = await requestJson(fetcher, `${api}/repos/${ready.repository}/releases/${release.id}`, { headers }, 'Verify release draft')
  validatePromotionDraft(populated, ready)
  verifyRemoteReleaseAssets(populated, ready.assets)
  return populated
}

async function restoreDraftRelease(fetcher, api, headers, ready, draft) {
  const restored = await requestJson(fetcher, `${api}/repos/${ready.repository}/releases/${draft.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: true, prerelease: false }),
  }, 'Restore release draft')
  assert(restored?.draft === true && restored?.prerelease === false, 'Release draft restoration failed')
  return restored
}

export async function publishPromotion({ readyRoot, token, fetcher = globalThis.fetch, apiBaseUrl = 'https://api.github.com', uploadsBaseUrl = 'https://uploads.github.com' }) {
  const ready = jsonFile(path.join(readyRoot, 'promotion-ready.json'), 'promotion-ready manifest')
  assert(ready?.schemaVersion === 1 && ready?.state === 'READY_TO_PUBLISH' && Array.isArray(ready.assets), 'Promotion-ready manifest is invalid')
  const api = apiBaseUrl.replace(/\/$/, '')
  const uploads = uploadsBaseUrl.replace(/\/$/, '')
  const headers = apiHeaders(token)
  let draft = await releaseDraftIfPresent(fetcher, api, headers, ready)
  const existingTag = await tagCommitShaIfPresent(fetcher, api, headers, ready)
  if (draft === null) {
    assert(existingTag === null, 'A Git tag exists without its matching draft Release')
    draft = await createAndPopulateDraft(fetcher, api, uploads, headers, ready, readyRoot)
  } else {
    validatePromotionDraft(draft, ready)
    verifyRemoteReleaseAssets(draft, ready.assets)
  }
  if (existingTag === null) {
    await createVerifiedTag(fetcher, api, headers, ready)
    await assertCreatedTagCommit(fetcher, api, headers, ready, 'before publication')
  } else {
    await assertTagCommit(fetcher, api, headers, ready, 'before publication')
  }
  let publicationAttempted = false
  try {
    publicationAttempted = true
    const published = await requestJson(fetcher, `${api}/repos/${ready.repository}/releases/${draft.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, prerelease: false }),
    }, 'Publish final release')
    assert(published?.draft === false && published?.prerelease === false, 'Release was not published as a final release')
    exactFileSet(published.assets?.map(asset => asset?.name) ?? [], ready.assets.map(asset => asset.file), 'Published release asset')
    for (const local of ready.assets) {
      const remote = published.assets.find(asset => asset?.name === local.file)
      assert(remote?.size === local.sizeBytes && remote?.digest?.toLowerCase() === `sha256:${local.sha256}`, `Published release asset verification failed: ${local.file}`)
    }
    await assertTagCommit(fetcher, api, headers, ready, 'after publication')
    return published
  } catch (error) {
    if (!publicationAttempted) throw error
    try {
      await restoreDraftRelease(fetcher, api, headers, ready, draft)
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'Release publication failed and draft restoration also failed')
    }
    throw error
  }
}

function writePlanOutputs(plan) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  writeFileSync(output, [
    `windows_artifact_id=${plan.windows.artifact.id}`,
    `macos_artifact_id=${plan.macos.artifact.id}`,
  ].join('\n') + '\n', { flag: 'a' })
}

async function main() {
  const [operation, ...rest] = process.argv.slice(2)
  const args = readArguments(rest)
  if (operation === 'plan') {
    const plan = await planPromotion({
      inputs: { repository: required(args, '--repository'), windowsQualificationRunId: required(args, '--windows-qualification-run-id'), macosQualificationRunId: required(args, '--macos-qualification-run-id'), expectedSha: required(args, '--expected-sha'), tag: required(args, '--tag'), confirmation: required(args, '--confirmation') },
      token: requiredEnvironment('GITHUB_TOKEN'),
    })
    writeFileSync(required(args, '--output'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    writePlanOutputs(plan)
    return
  }
  if (operation === 'verify') {
    verifyPromotion({ windowsArtifactRoot: required(args, '--windows-artifact-root'), macosArtifactRoot: required(args, '--macos-artifact-root'), qualifiedSource: required(args, '--qualified-source'), sourcePlan: jsonFile(required(args, '--plan'), 'source plan'), outputDirectory: required(args, '--output') })
    return
  }
  if (operation === 'publish') {
    const release = await publishPromotion({ readyRoot: required(args, '--ready-root'), token: requiredEnvironment('GITHUB_TOKEN') })
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `release_url=${release.html_url}\n`, { flag: 'a' })
    return
  }
  throw new Error('Usage: promote-cross-platform-runtime-artifacts.mjs <plan|verify|publish>')
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
}
