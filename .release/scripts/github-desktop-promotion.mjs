#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseStrictUtf8Json, readJsonFile, validateReleaseProfile } from "./validate-release-profile.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
export const AUTHORITATIVE_READBACK_DELAYS_MS = Object.freeze([250, 500, 1000, 2000]);

export async function boundedAuthoritativeReadback({ label, read, assert: assertValue, sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)), delays = AUTHORITATIVE_READBACK_DELAYS_MS }) {
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const value = await read();
      await assertValue(value);
      return value;
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw new Error(`${label} authoritative readback exhausted after ${delays.length + 1} attempts: ${lastError?.message || "unknown mismatch"}`);
}

export function parseQualificationRuns(text, requiredPlatforms) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`qualification run mapping is not JSON: ${error.message}`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("qualification run mapping must be an object");
  }
  const required = [...requiredPlatforms].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(required) !== JSON.stringify(actual)) {
    throw new Error(`qualification run mapping keys must be exactly: ${required.join(", ")}`);
  }
  return Object.fromEntries(required.map((platform) => {
    const record = value[platform];
    if (!record || Array.isArray(record) || typeof record !== "object") {
      throw new Error(`${platform} run mapping must be an object`);
    }
    const keys = Object.keys(record).sort();
    if (keys.some((key) => !["runId", "attempt", "artifactId"].includes(key))) {
      throw new Error(`${platform} run mapping has unknown fields`);
    }
    for (const field of ["runId", "attempt", "artifactId"]) {
      if (!Number.isSafeInteger(record[field]) || record[field] <= 0) {
        throw new Error(`${platform}.${field} must be a positive integer`);
      }
    }
    return [platform, { runId: record.runId, attempt: record.attempt, artifactId: record.artifactId }];
  }));
}

export function validatePromotionProfile(profile) {
  const baseValidation = validateReleaseProfile(profile);
  if (!baseValidation.ok) throw new Error(`release profile is invalid: ${baseValidation.errors.join("; ")}`);
  if (!profile || profile.schemaVersion !== 1 || profile.provider !== "github-actions" || profile.artifactSelection !== "workflow-run-attempt-artifact-id") {
    throw new Error("release profile does not select immutable GitHub Actions artifacts");
  }
  const platforms = Object.keys(profile.platforms || {});
  if (platforms.length === 0 || platforms.some((platform) => !["windows", "macos"].includes(platform))) throw new Error("release profile platforms are invalid");
  for (const platform of platforms) {
    const policy = profile.platforms[platform];
    if (typeof policy.qualificationWorkflow !== "string" || !policy.qualificationWorkflow.startsWith(".github/workflows/") || typeof policy.artifactName !== "string" || policy.artifactName.length === 0) {
      throw new Error(`${platform} promotion policy is invalid`);
    }
    if (!policy.signingPolicy || !["required", "allow-unsigned-with-disclosure"].includes(policy.signingPolicy.mode) || policy.signingPolicy.disclosureRequired !== true) {
      throw new Error(`${platform} signing policy is invalid`);
    }
  }
  if (!Array.isArray(profile.releaseAssets) || profile.releaseAssets.length === 0) throw new Error("release profile has no assets");
  const names = new Set();
  for (const asset of profile.releaseAssets) {
    if (!platforms.includes(asset.platform) || typeof asset.name !== "string" || asset.name.length === 0 || names.has(asset.name.toLowerCase())) throw new Error("release profile asset set is invalid");
    normalizeRelativePath(asset.name.replaceAll("{version}", "VERSION"));
    names.add(asset.name.toLowerCase());
  }
  const channel = profile.releaseChannel;
  if (![channel?.draft, channel?.prerelease, channel?.expectedLatest].every((value) => typeof value === "boolean")) throw new Error("release channel policy is invalid");
  return profile;
}

export function assertQualificationRun({ run, expectedSha, expectedAttempt, expectedWorkflow }) {
  if (String(run.head_sha).toLowerCase() !== expectedSha) throw new Error("qualification head SHA mismatch");
  if (run.run_attempt !== expectedAttempt) throw new Error("qualification run attempt mismatch");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("qualification run is not successful");
  const actualWorkflow = String(run.path || "").split("@")[0].replaceAll("\\", "/");
  if (actualWorkflow !== expectedWorkflow.replaceAll("\\", "/")) throw new Error("qualification workflow mismatch");
}

export function assertDefaultBranchAncestry(compare, expectedSha) {
  if (!["ahead", "identical"].includes(compare?.status)) throw new Error("qualified SHA is not an ancestor of the default branch");
  if (String(compare.merge_base_commit?.sha || "").toLowerCase() !== expectedSha) throw new Error("default-branch merge base does not equal the qualified SHA");
}

export function selectQualificationArtifact({ artifacts, artifactId, expectedName, runId, expectedSha }) {
  const matches = artifacts.filter((artifact) => artifact.id === artifactId);
  if (matches.length !== 1) throw new Error("qualification artifact ID is not unique in the selected run");
  const artifact = matches[0];
  if (artifact.name !== expectedName) throw new Error("qualification artifact name mismatch");
  if (artifact.expired) throw new Error("qualification artifact is expired");
  if (artifact.workflow_run?.id !== undefined && artifact.workflow_run.id !== runId) {
    throw new Error("qualification artifact run identity mismatch");
  }
  if (artifact.workflow_run?.head_sha !== undefined && String(artifact.workflow_run.head_sha).toLowerCase() !== expectedSha) {
    throw new Error("qualification artifact head SHA mismatch");
  }
  return artifact;
}

function normalizeRelativePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\\") || candidate.includes("\0")) {
    throw new Error(`unsafe relative path: ${String(candidate)}`);
  }
  const parts = candidate.split("/");
  if (candidate.startsWith("/") || parts.some((part) => part === "" || part === "." || part === ".." || part.endsWith(" ") || part.endsWith("."))) {
    throw new Error(`unsafe relative path: ${candidate}`);
  }
  return parts.join("/");
}

function recordsFromManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.evidence)) {
    throw new Error("qualification manifest shape is invalid");
  }
  const records = [...manifest.artifacts, ...manifest.evidence];
  const byPath = new Map();
  for (const record of records) {
    const recordPath = normalizeRelativePath(record.path);
    const digest = String(record.rawBytesSha256 || "").toLowerCase();
    if (!SHA256.test(digest)) throw new Error(`manifest digest is invalid: ${recordPath}`);
    const key = recordPath.toLowerCase();
    if (byPath.has(key)) throw new Error(`manifest path collides: ${recordPath}`);
    byPath.set(key, { path: recordPath, digest, record });
  }
  return byPath;
}

export function parseChecksumTable(text) {
  const table = new Map();
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("SHA256SUMS.txt is empty");
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error("SHA256SUMS.txt has an invalid line");
    const filePath = normalizeRelativePath(match[2]);
    const key = filePath.toLowerCase();
    if (table.has(key)) throw new Error(`checksum path collides: ${filePath}`);
    table.set(key, { path: filePath, digest: match[1].toLowerCase() });
  }
  return table;
}

export function verifyManifestIndex({ manifest, checksumText, actualFiles, actualDigests, expectedSha }) {
  if (String(manifest.commit).toLowerCase() !== expectedSha) throw new Error("manifest commit mismatch");
  if (manifest.releaseCreated !== false) throw new Error("qualification artifact claims a release was created");
  const records = recordsFromManifest(manifest);
  const checksums = parseChecksumTable(checksumText);
  const expectedChecksumKeys = new Set([...records.keys(), "manifest.json"]);
  if (expectedChecksumKeys.size !== checksums.size || [...expectedChecksumKeys].some((key) => !checksums.has(key))) {
    throw new Error("checksum table is not the exact manifest record set plus manifest.json");
  }
  for (const [key, record] of records) {
    if (checksums.get(key).digest !== record.digest) throw new Error(`manifest/checksum digest mismatch: ${record.path}`);
  }
  const expectedFiles = new Set([...checksums.keys(), "sha256sums.txt"]);
  const actualKeys = new Set(actualFiles.map((file) => normalizeRelativePath(file).toLowerCase()));
  if (expectedFiles.size !== actualKeys.size || [...expectedFiles].some((key) => !actualKeys.has(key))) {
    throw new Error("extracted artifact file set is not exact");
  }
  for (const [key, expected] of checksums) {
    if (actualDigests.get(key) !== expected.digest) throw new Error(`raw byte digest mismatch: ${expected.path}`);
  }
  return { records, checksums };
}

export function assertSigningDisclosure(manifest, signingPolicy, manifestRecords) {
  const signing = manifest?.signing;
  for (const field of ["status", "validationResult", "unsignedDistributionImpact", "evidencePath"]) {
    if (typeof signing?.[field] !== "string" || signing[field].trim() === "" || /[\r\n]/u.test(signing[field])) {
      throw new Error(`signing disclosure field is invalid: ${field}`);
    }
  }
  if (signingPolicy?.mode === "required" && signing.status.toLowerCase() !== "signed") {
    throw new Error("profile requires a signed artifact");
  }
  if (manifestRecords && !manifestRecords.has(signing.evidencePath.toLowerCase())) {
    throw new Error("signing evidencePath is not hash-bound by the manifest");
  }
  return {
    status: signing.status,
    validationResult: signing.validationResult,
    unsignedDistributionImpact: signing.unsignedDistributionImpact,
  };
}

export function parseSigningReceiptBytes(bytes, label = "signing receipt") {
  return parseStrictUtf8Json(bytes, label);
}

export function assertSigningReceipt(receipt, manifestSigning) {
  if (!receipt || Array.isArray(receipt) || typeof receipt !== "object") throw new Error("signing receipt must be a JSON object");
  if (receipt.accepted !== true) throw new Error("signing receipt must have accepted=true");
  if (!Array.isArray(receipt.observations) || receipt.observations.length === 0 || receipt.observations.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("signing receipt must have non-empty string observations");
  }
  for (const field of ["status", "validationResult", "unsignedDistributionImpact"]) {
    if (receipt[field] !== manifestSigning[field]) throw new Error(`signing receipt/manifest mismatch: ${field}`);
  }
  return receipt;
}

export function assertAcceptanceReceipt(receipt, platform, relativePath) {
  if (!receipt || Array.isArray(receipt) || typeof receipt !== "object") throw new Error(`${platform}:${relativePath} receipt must be a JSON object`);
  if (receipt.accepted !== true) throw new Error(`${platform}:${relativePath} receipt must have accepted=true`);
  if (!Array.isArray(receipt.observations) || receipt.observations.length === 0 || receipt.observations.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error(`${platform}:${relativePath} receipt must have non-empty string observations`);
  }
  if (receipt.platform !== undefined && receipt.platform !== platform) throw new Error(`${platform}:${relativePath} receipt platform mismatch`);
  return receipt;
}

export function assertLedgerSigning(ledgerSigning, manifestSigning) {
  if (!ledgerSigning || Array.isArray(ledgerSigning) || typeof ledgerSigning !== "object") throw new Error("run ledger signing binding is missing");
  for (const field of ["status", "validationResult", "unsignedDistributionImpact", "evidencePath"]) {
    if (ledgerSigning[field] !== manifestSigning[field]) throw new Error(`run ledger/manifest signing mismatch: ${field}`);
  }
}

export function assertContractBindings({ manifest, manifestRecords, ledger, profileRawBytesSha256, previousBindings = null }) {
  for (const [label, value] of [
    ["manifest contract", manifest.contractRawBytesSha256],
    ["manifest profile", manifest.profileRawBytesSha256],
    ["ledger contract", ledger.contractRawBytesSha256],
    ["ledger profile", ledger.profileRawBytesSha256],
    ["current profile", profileRawBytesSha256],
  ]) {
    if (!SHA256.test(String(value || "").toLowerCase())) throw new Error(`${label} raw-byte SHA-256 is invalid`);
  }
  const contractRecord = manifestRecords.get("release-contract.json");
  if (!contractRecord) throw new Error("release-contract.json is not hash-bound by the manifest");
  const contractHash = manifest.contractRawBytesSha256.toLowerCase();
  const profileHash = manifest.profileRawBytesSha256.toLowerCase();
  if (contractRecord.digest !== contractHash) throw new Error("release contract raw-byte hash mismatch");
  if (String(ledger.contractRawBytesSha256).toLowerCase() !== contractHash || String(ledger.profileRawBytesSha256).toLowerCase() !== profileHash) {
    throw new Error("run ledger contract/profile binding mismatch");
  }
  if (profileRawBytesSha256.toLowerCase() !== profileHash) throw new Error("current release profile raw-byte hash mismatch");
  if (previousBindings && (previousBindings.contractRawBytesSha256 !== contractHash || previousBindings.profileRawBytesSha256 !== profileHash)) {
    throw new Error("required platforms do not share identical contract/profile raw-byte hashes");
  }
  return { contractRawBytesSha256: contractHash, profileRawBytesSha256: profileHash };
}

export function decideSafeResume({ tagSha, expectedSha, expectedTag, release, expectedTitle, expectedBody, localAssets }) {
  if (tagSha !== null && tagSha !== expectedSha) throw new Error("existing tag points to a different commit");
  if (!release) return { createTag: tagSha === null, createDraft: true, upload: [...localAssets.keys()] };
  const releaseTag = release.tag_name ?? release.tagName;
  if (releaseTag !== expectedTag) throw new Error("existing release tag mismatch");
  if (release.name !== expectedTitle || release.body !== expectedBody) throw new Error("existing release title/body provenance mismatch");
  const remoteAssets = Array.isArray(release.assets) ? release.assets : [];
  const seen = new Set();
  for (const asset of remoteAssets) {
    const key = String(asset.name).toLowerCase();
    if (seen.has(key)) throw new Error("existing release has duplicate asset names");
    seen.add(key);
    const local = localAssets.get(key);
    if (!local) throw new Error("existing release has an unexpected asset");
    if (asset.state !== "uploaded" || asset.size !== local.size || String(asset.digest || "").toLowerCase() !== `sha256:${local.sha256}`) {
      throw new Error(`existing release asset does not match local bytes: ${asset.name}`);
    }
  }
  if (!release.draft && seen.size !== localAssets.size) throw new Error("published release is missing assets");
  return {
    createTag: false,
    createDraft: false,
    alreadyPublished: !release.draft,
    upload: [...localAssets.entries()].filter(([key]) => !seen.has(key)).map(([, value]) => value.name),
  };
}

export function assertAuthoritativeReadback({ release, tagSha, expectedSha, expectedTitle, expectedBody, localAssets, channel, latestReleaseId }) {
  if (tagSha !== expectedSha) throw new Error("authoritative tag target mismatch");
  if (release.name !== expectedTitle || release.body !== expectedBody) throw new Error("authoritative release provenance mismatch");
  if (release.draft !== channel.draft || release.prerelease !== channel.prerelease) throw new Error("authoritative release channel mismatch");
  const remote = Array.isArray(release.assets) ? release.assets : [];
  if (remote.length !== localAssets.size) throw new Error("authoritative asset set size mismatch");
  for (const asset of remote) {
    const local = localAssets.get(String(asset.name).toLowerCase());
    if (!local || asset.state !== "uploaded" || asset.size !== local.size || String(asset.digest || "").toLowerCase() !== `sha256:${local.sha256}`) {
      throw new Error(`authoritative asset mismatch: ${asset.name}`);
    }
  }
  const isLatest = latestReleaseId === release.id;
  if (isLatest !== channel.expectedLatest) throw new Error("authoritative latest-release policy mismatch");
}

export function assertDraftReadback(release, expectedTag, expectedTitle, expectedBody) {
  if (!release || release.tag_name !== expectedTag || release.name !== expectedTitle || release.body !== expectedBody || release.draft !== true) {
    throw new Error("created draft release is not authoritatively visible with exact provenance");
  }
}

export function assertUploadedAssetReadback(release, localAsset) {
  const matches = (release?.assets || []).filter((asset) => String(asset.name).toLowerCase() === localAsset.name.toLowerCase());
  if (matches.length !== 1) throw new Error(`uploaded asset is not uniquely visible: ${localAsset.name}`);
  const asset = matches[0];
  if (!asset.digest) throw new Error(`uploaded asset digest is missing: ${localAsset.name}`);
  if (asset.state !== "uploaded" || asset.size !== localAsset.size || String(asset.digest).toLowerCase() !== `sha256:${localAsset.sha256}`) {
    throw new Error(`uploaded asset readback mismatch: ${localAsset.name}`);
  }
}

export function completionClaims(channel) {
  return { draftVerified: channel.draft === true, publicationVerified: channel.draft === false };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["verify", "publish"].includes(command)) throw new Error("usage: github-desktop-promotion.mjs verify|publish [options]");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`invalid argument: ${key}`);
    options[key.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function validateIdentity({ repository, expectedSha, tag, version }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("repository must be owner/name");
  if (!COMMIT_SHA.test(expectedSha)) throw new Error("expected SHA must be a lowercase full commit SHA");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(tag) || tag.includes("..") || tag.endsWith("/") || tag.includes("//")) throw new Error("release tag is unsafe");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(version)) throw new Error("release version is unsafe");
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function listFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const details = await lstat(fullPath);
    if (details.isSymbolicLink()) throw new Error("artifact contains a symbolic link");
    if (details.isDirectory()) result.push(...await listFiles(root, fullPath));
    else if (details.isFile()) result.push(relative(root, fullPath).split(sep).join("/"));
    else throw new Error("artifact contains an unsupported filesystem entry");
  }
  return result.sort();
}

async function loadJson(filePath) {
  const bytes = await readFile(filePath);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${basename(filePath)} must not contain a BOM`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

class GitHubApi {
  constructor(repository, token) {
    this.repository = repository;
    this.token = token;
  }

  async request(method, route, body, allow404 = false) {
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-desktop-release-skill",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} ${route} failed with ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  async get(route, allow404 = false) { return this.request("GET", route, undefined, allow404); }
  async post(route, body) { return this.request("POST", route, body); }
  async patch(route, body) { return this.request("PATCH", route, body); }

  async paged(route, property) {
    const values = [];
    for (let page = 1; ; page += 1) {
      const separator = route.includes("?") ? "&" : "?";
      const response = await this.get(`${route}${separator}per_page=100&page=${page}`);
      const batch = property ? response[property] : response;
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }

  async downloadArtifact(artifactId, destination) {
    const response = await fetch(`https://api.github.com/repos/${this.repository}/actions/artifacts/${artifactId}/zip`, {
      redirect: "follow",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-desktop-release-skill",
      },
    });
    if (!response.ok || !response.body) throw new Error(`artifact download failed with ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  }
}

function inspectZip(zipPath) {
  const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error("unzip could not inspect the qualification artifact");
  for (const raw of listing.stdout.split(/\r?\n/u).filter(Boolean)) {
    const candidate = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (candidate) normalizeRelativePath(candidate);
  }
}

function extractZip(zipPath, destination) {
  inspectZip(zipPath);
  const result = spawnSync("unzip", ["-q", zipPath, "-d", destination], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("unzip could not extract the qualification artifact");
}

async function resolveTagSha(api, repository, tag) {
  const ref = await api.get(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, true);
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth += 1) {
    object = (await api.get(`/repos/${repository}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== "commit" || !COMMIT_SHA.test(String(object.sha))) throw new Error("tag does not resolve to a commit");
  return object.sha.toLowerCase();
}

async function findRelease(api, repository, tag) {
  const releases = await api.paged(`/repos/${repository}/releases`, null);
  const matches = releases.filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error("multiple releases use the target tag");
  return matches[0] || null;
}

function expectedReleaseProvenance(tag, expectedSha, assets, qualifications) {
  const lines = [...assets.values()].sort((a, b) => a.name.localeCompare(b.name)).map((asset) => `- ${asset.name}: sha256:${asset.sha256}`);
  const signingLines = [...qualifications].sort((a, b) => a.platform.localeCompare(b.platform)).map((qualification) =>
    `- ${qualification.platform}: ${qualification.signing.status}; validation=${qualification.signing.validationResult}; unsigned-impact=${qualification.signing.unsignedDistributionImpact}`);
  return {
    title: tag,
    body: [`Qualified desktop release ${tag}`, "", `Source: ${expectedSha}`, "", "Verified assets:", ...lines, "", "Signing and notarization disclosure:", ...signingLines].join("\n"),
  };
}

async function uploadAsset(api, repository, releaseId, asset) {
  const details = await stat(asset.path);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest({
      method: "POST",
      hostname: "uploads.github.com",
      path: `/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${api.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-desktop-release-skill",
        "Content-Type": "application/octet-stream",
        "Content-Length": details.size,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return rejectPromise(new Error(`asset upload failed with ${response.statusCode}`));
        try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { rejectPromise(error); }
      });
    });
    request.on("error", rejectPromise);
    createReadStream(asset.path).pipe(request);
  });
}

export async function verifyExtractedQualification({ root, platform, policy, releaseAssetPolicy, version, expectedSha, mapping, artifact, profileRawBytesSha256, previousBindings = null }) {
  const files = await listFiles(root);
  const manifest = await loadJson(join(root, "manifest.json"));
  const checksumText = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(root, "SHA256SUMS.txt")));
  const actualDigests = new Map();
  for (const file of files) actualDigests.set(file.toLowerCase(), await sha256File(join(root, ...file.split("/"))));
  const manifestIndex = verifyManifestIndex({ manifest, checksumText, actualFiles: files, actualDigests, expectedSha });
  const ledger = await loadJson(join(root, "run-ledger.json"));
  if (Number(ledger.runId) !== mapping.runId || Number(ledger.runAttempt) !== mapping.attempt || String(ledger.qualifiedCommit).toLowerCase() !== expectedSha) {
    throw new Error(`${platform} run ledger identity mismatch`);
  }
  const bindings = assertContractBindings({ manifest, manifestRecords: manifestIndex.records, ledger, profileRawBytesSha256, previousBindings });
  const signing = assertSigningDisclosure(manifest, policy.signingPolicy, manifestIndex.records);
  const receipts = new Map();
  for (const configuredPath of policy.acceptanceReceipts || []) {
    const relativePath = normalizeRelativePath(configuredPath);
    if (!manifestIndex.records.has(relativePath.toLowerCase())) throw new Error(`${platform}:${relativePath} required receipt is not hash-bound by the manifest`);
    const receipt = parseStrictUtf8Json(await readFile(join(root, ...relativePath.split("/"))), `${platform}:${relativePath}`);
    assertAcceptanceReceipt(receipt, platform, relativePath);
    receipts.set(relativePath.toLowerCase(), receipt);
  }
  const signingKey = manifest.signing.evidencePath.toLowerCase();
  const signingReceipt = receipts.get(signingKey) || parseSigningReceiptBytes(await readFile(join(root, ...manifest.signing.evidencePath.split("/"))), `${platform}:${manifest.signing.evidencePath}`);
  assertAcceptanceReceipt(signingReceipt, platform, manifest.signing.evidencePath);
  assertSigningReceipt(signingReceipt, manifest.signing);
  assertLedgerSigning(ledger.signing, manifest.signing);
  const expectedNames = releaseAssetPolicy.filter((asset) => asset.platform === platform).map((asset) => asset.name.replaceAll("{version}", version));
  const bundleFiles = files.filter((file) => file.startsWith("release-bundle/")).map((file) => file.slice("release-bundle/".length));
  if (JSON.stringify([...expectedNames].sort()) !== JSON.stringify([...bundleFiles].sort())) throw new Error(`${platform} release asset set mismatch`);
  const assets = [];
  for (const name of expectedNames) {
    const source = join(root, "release-bundle", ...name.split("/"));
    const safeName = normalizeRelativePath(name);
    if (safeName.includes("/")) throw new Error("release asset names must be flat");
    const details = await stat(source);
    assets.push({ name: safeName, platform, size: details.size, sha256: await sha256File(source), source });
  }
  return {
    bindings,
    assets,
    qualification: { platform, runId: mapping.runId, attempt: mapping.attempt, artifactId: mapping.artifactId, artifactName: artifact.name, headSha: expectedSha, ...bindings, signing },
  };
}

async function verifyCommand(options) {
  const repository = requireOption(options, "repository");
  const expectedSha = requireOption(options, "expected-sha");
  const tag = requireOption(options, "tag");
  const version = requireOption(options, "version");
  const profilePath = resolve(requireOption(options, "profile"));
  const output = resolve(requireOption(options, "output"));
  validateIdentity({ repository, expectedSha, tag, version });
  const profile = validatePromotionProfile(await readJsonFile(profilePath));
  const profileRawBytesSha256 = await sha256File(profilePath);
  const platforms = Object.keys(profile.platforms || {}).sort();
  const runMapping = parseQualificationRuns(requireOption(options, "qualification-runs-json"), platforms);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const api = new GitHubApi(repository, token);
  const workRoot = await mkdtemp(join(tmpdir(), "github-desktop-promotion-"));
  const releaseAssets = new Map();
  const qualifications = [];
  let sharedBindings = null;
  try {
    const repositoryState = await api.get(`/repos/${repository}`);
    const defaultBranch = String(repositoryState.default_branch || "");
    if (!defaultBranch) throw new Error("repository default branch is unavailable");
    const comparison = await api.get(`/repos/${repository}/compare/${expectedSha}...${encodeURIComponent(defaultBranch)}`);
    assertDefaultBranchAncestry(comparison, expectedSha);
    for (const platform of platforms) {
      const mapping = runMapping[platform];
      const policy = profile.platforms[platform];
      const run = await api.get(`/repos/${repository}/actions/runs/${mapping.runId}`);
      assertQualificationRun({ run, expectedSha, expectedAttempt: mapping.attempt, expectedWorkflow: policy.qualificationWorkflow });
      const artifacts = await api.paged(`/repos/${repository}/actions/runs/${mapping.runId}/artifacts`, "artifacts");
      const artifact = selectQualificationArtifact({ artifacts, artifactId: mapping.artifactId, expectedName: policy.artifactName, runId: mapping.runId, expectedSha });
      const zipPath = join(workRoot, `${platform}.zip`);
      const extracted = join(workRoot, platform);
      await mkdir(extracted);
      await api.downloadArtifact(artifact.id, zipPath);
      extractZip(zipPath, extracted);
      const verified = await verifyExtractedQualification({ root: extracted, platform, policy, releaseAssetPolicy: profile.releaseAssets, version, expectedSha, mapping, artifact, profileRawBytesSha256, previousBindings: sharedBindings });
      sharedBindings = verified.bindings;
      for (const asset of verified.assets) {
        const key = asset.name.toLowerCase();
        if (releaseAssets.has(key)) throw new Error(`release asset name collides: ${asset.name}`);
        releaseAssets.set(key, asset);
      }
      qualifications.push(verified.qualification);
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    for (const asset of releaseAssets.values()) await copyFile(asset.source, join(output, asset.name));
    const provenance = expectedReleaseProvenance(tag, expectedSha, releaseAssets, qualifications);
    const plan = {
      schemaVersion: 1,
      repository,
      expectedSha,
      tag,
      version,
      title: provenance.title,
      body: provenance.body,
      channel: profile.releaseChannel,
      qualifications,
      assets: [...releaseAssets.values()].map(({ source, ...asset }) => asset).sort((a, b) => a.name.localeCompare(b.name)),
    };
    await writeFile(join(output, "promotion-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ verified: true, qualifications, assets: plan.assets })}\n`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function publishCommand(options) {
  const repository = requireOption(options, "repository");
  const expectedSha = requireOption(options, "expected-sha");
  const tag = requireOption(options, "tag");
  const version = requireOption(options, "version");
  const profilePath = resolve(requireOption(options, "profile"));
  const packageRoot = resolve(requireOption(options, "verified-package"));
  const outerDigest = requireOption(options, "outer-artifact-digest").toLowerCase();
  validateIdentity({ repository, expectedSha, tag, version });
  if (!SHA256.test(outerDigest)) throw new Error("outer artifact digest is invalid");
  const profile = validatePromotionProfile(await readJsonFile(profilePath));
  const profileRawBytesSha256 = await sha256File(profilePath);
  const planPathCandidates = (await listFiles(packageRoot)).filter((file) => file === "promotion-plan.json" || file.endsWith("/promotion-plan.json"));
  if (planPathCandidates.length !== 1) throw new Error("verified package must contain exactly one promotion-plan.json");
  const planRoot = dirname(join(packageRoot, ...planPathCandidates[0].split("/")));
  const plan = await loadJson(join(planRoot, "promotion-plan.json"));
  if (plan.repository !== repository || plan.expectedSha !== expectedSha || plan.tag !== tag || plan.version !== version) throw new Error("verified promotion plan identity mismatch");
  if (JSON.stringify(plan.channel) !== JSON.stringify(profile.releaseChannel)) throw new Error("verified promotion channel/profile mismatch");
  const qualificationBindings = new Set((plan.qualifications || []).map((qualification) => `${qualification.contractRawBytesSha256}:${qualification.profileRawBytesSha256}`));
  if (qualificationBindings.size !== 1 || ![...qualificationBindings][0]?.endsWith(`:${profileRawBytesSha256}`)) {
    throw new Error("verified promotion plan/current profile raw-byte binding mismatch");
  }
  const localAssets = new Map();
  for (const record of plan.assets || []) {
    const name = normalizeRelativePath(record.name);
    if (name.includes("/")) throw new Error("release asset names must be flat");
    const assetPath = join(planRoot, name);
    const details = await stat(assetPath);
    const sha256 = await sha256File(assetPath);
    if (details.size !== record.size || sha256 !== record.sha256) throw new Error(`verified package bytes changed: ${name}`);
    const key = name.toLowerCase();
    if (localAssets.has(key)) throw new Error(`verified package asset collision: ${name}`);
    localAssets.set(key, { name, path: assetPath, size: details.size, sha256 });
  }
  const expectedProfileNames = profile.releaseAssets.map((asset) => asset.name.replaceAll("{version}", version)).sort();
  const actualNames = [...localAssets.values()].map((asset) => asset.name).sort();
  if (JSON.stringify(expectedProfileNames) !== JSON.stringify(actualNames)) throw new Error("verified package asset set/profile mismatch");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const api = new GitHubApi(repository, token);
  let tagSha = await resolveTagSha(api, repository, tag);
  let release = await findRelease(api, repository, tag);
  const normalizedRelease = release ? { ...release, tagName: release.tag_name, expectedTag: tag } : null;
  const decision = decideSafeResume({ tagSha, expectedSha, expectedTag: tag, release: normalizedRelease, expectedTitle: plan.title, expectedBody: plan.body, localAssets });
  if (decision.createTag) {
    await api.post(`/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha: expectedSha });
    tagSha = await boundedAuthoritativeReadback({
      label: "tag creation",
      read: () => resolveTagSha(api, repository, tag),
      assert: (value) => { if (value !== expectedSha) throw new Error("created tag target is not visible"); },
    });
  }
  if (decision.createDraft) {
    await api.post(`/repos/${repository}/releases`, { tag_name: tag, target_commitish: expectedSha, name: plan.title, body: plan.body, draft: true, prerelease: profile.releaseChannel.prerelease });
    release = await boundedAuthoritativeReadback({
      label: "draft creation",
      read: () => findRelease(api, repository, tag),
      assert: (value) => assertDraftReadback(value, tag, plan.title, plan.body),
    });
  }
  if (decision.alreadyPublished) {
    release = await findRelease(api, repository, tag);
  } else {
    for (const name of decision.upload) {
      const local = localAssets.get(name.toLowerCase());
      await uploadAsset(api, repository, release.id, local);
      release = await boundedAuthoritativeReadback({
        label: `asset upload ${name}`,
        read: () => findRelease(api, repository, tag),
        assert: (value) => assertUploadedAssetReadback(value, local),
      });
    }
    await api.patch(`/repos/${repository}/releases/${release.id}`, {
      name: plan.title,
      body: plan.body,
      draft: profile.releaseChannel.draft,
      prerelease: profile.releaseChannel.prerelease,
      make_latest: profile.releaseChannel.expectedLatest ? "true" : "false",
    });
  }
  const readback = await boundedAuthoritativeReadback({
    label: "final release state",
    read: async () => ({
      tagSha: await resolveTagSha(api, repository, tag),
      release: await findRelease(api, repository, tag),
      latest: await api.get(`/repos/${repository}/releases/latest`, true),
    }),
    assert: (value) => assertAuthoritativeReadback({ release: value.release, tagSha: value.tagSha, expectedSha, expectedTitle: plan.title, expectedBody: plan.body, localAssets, channel: profile.releaseChannel, latestReleaseId: value.latest?.id ?? null }),
  });
  release = readback.release;
  process.stdout.write(`${JSON.stringify({ ...completionClaims(profile.releaseChannel), releaseId: release.id, url: release.html_url, outerArtifactDigest: outerDigest })}\n`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "verify") await verifyCommand(options);
  else await publishCommand(options);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
