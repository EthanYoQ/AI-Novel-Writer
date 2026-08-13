#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLATFORM_NAMES = new Set(['windows', 'macos']);
const SIGNING_MODES = new Set(['required', 'allow-unsigned-with-disclosure']);
const FINAL_STATES = new Set(['draft', 'published']);
const SAFE_ARCHITECTURE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasGlob(value) {
  return /[*?\[\]]/.test(value);
}

function validateKnownKeys(value, allowedKeys, label, errors) {
  if (!isRecord(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown field: ${key}`);
  }
}

function validateRelativePath(value, label, errors, { workflow = false } = {}) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string.`);
    return;
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    errors.push(`${label} must be a portable forward-slash relative path.`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    errors.push(`${label} contains an empty, current-directory, or parent-directory segment.`);
  }
  if (value.includes(':') || segments.some((segment) => /[. ]$/.test(segment)) || hasGlob(value)) {
    errors.push(`${label} contains an unsafe separator, trailing dot/space, or glob.`);
  }
  if (workflow && !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(value)) {
    errors.push(`${label} must name one workflow directly under .github/workflows.`);
  }
}

function validateUniqueStrings(values, label, errors) {
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${label} must be a non-empty array.`);
    return [];
  }
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (!isNonEmptyString(value)) {
      errors.push(`${label}[${index}] must be a non-empty string.`);
      continue;
    }
    const key = value.toLocaleLowerCase('en-US');
    if (seen.has(key)) errors.push(`${label} contains a case-insensitive duplicate: ${value}`);
    seen.add(key);
  }
  return values;
}

export function validateReleaseProfile(profile) {
  const errors = [];
  if (!isRecord(profile)) return { ok: false, errors: ['Profile must be a JSON object.'], platforms: [] };

  validateKnownKeys(profile, [
    'schemaVersion',
    'provider',
    'platforms',
    'releaseAssets',
    'promotion',
    'artifactSelection',
    'releaseChannel',
    'retryPolicy',
    'hashPolicy'
  ], 'profile', errors);

  if (profile.schemaVersion !== 1) errors.push('schemaVersion must equal 1.');
  if (profile.provider !== 'github-actions') errors.push('provider must equal github-actions.');

  const platforms = isRecord(profile.platforms) ? Object.keys(profile.platforms) : [];
  if (platforms.length === 0) errors.push('platforms must contain windows and/or macos.');
  for (const platform of platforms) {
    if (!PLATFORM_NAMES.has(platform)) {
      errors.push(`Unsupported platform: ${platform}`);
      continue;
    }
    const config = profile.platforms[platform];
    if (!isRecord(config)) {
      errors.push(`platforms.${platform} must be an object.`);
      continue;
    }
    validateKnownKeys(config, [
      'qualificationWorkflow',
      'artifactName',
      'architectures',
      'retentionDays',
      'acceptanceReceipts',
      'signingPolicy'
    ], `platforms.${platform}`, errors);
    validateRelativePath(config.qualificationWorkflow, `platforms.${platform}.qualificationWorkflow`, errors, { workflow: true });
    if (!isNonEmptyString(config.artifactName) || hasGlob(config.artifactName) || /[\\/]/.test(config.artifactName)) {
      errors.push(`platforms.${platform}.artifactName must be an exact artifact name without path separators or globs.`);
    }
    const architectures = validateUniqueStrings(config.architectures, `platforms.${platform}.architectures`, errors);
    for (const [index, architecture] of architectures.entries()) {
      if (isNonEmptyString(architecture) && !SAFE_ARCHITECTURE_TOKEN.test(architecture)) {
        errors.push(`platforms.${platform}.architectures[${index}] must be a safe architecture token.`);
      }
    }
    if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 90) {
      errors.push(`platforms.${platform}.retentionDays must be an integer from 1 to 90.`);
    }
    const receipts = validateUniqueStrings(config.acceptanceReceipts, `platforms.${platform}.acceptanceReceipts`, errors);
    for (const [index, receipt] of receipts.entries()) {
      validateRelativePath(receipt, `platforms.${platform}.acceptanceReceipts[${index}]`, errors);
      if (isNonEmptyString(receipt) && !receipt.endsWith('.json')) {
        errors.push(`platforms.${platform}.acceptanceReceipts[${index}] must be JSON.`);
      }
    }
    if (!isRecord(config.signingPolicy)) {
      errors.push(`platforms.${platform}.signingPolicy must be an object.`);
    } else {
      validateKnownKeys(config.signingPolicy, ['mode', 'disclosureRequired'], `platforms.${platform}.signingPolicy`, errors);
      if (!SIGNING_MODES.has(config.signingPolicy.mode)) {
        errors.push(`platforms.${platform}.signingPolicy.mode is invalid.`);
      }
      if (config.signingPolicy.disclosureRequired !== true) {
        errors.push(`platforms.${platform}.signingPolicy.disclosureRequired must be true.`);
      }
    }
  }

  if (!Array.isArray(profile.releaseAssets) || profile.releaseAssets.length === 0) {
    errors.push('releaseAssets must be a non-empty array.');
  } else {
    const names = new Set();
    for (const [index, asset] of profile.releaseAssets.entries()) {
      if (!isRecord(asset)) {
        errors.push(`releaseAssets[${index}] must be an object.`);
        continue;
      }
      validateKnownKeys(asset, ['name', 'platform', 'role'], `releaseAssets[${index}]`, errors);
      if (!isNonEmptyString(asset.name) || /[\\/]/.test(asset.name) || hasGlob(asset.name)) {
        errors.push(`releaseAssets[${index}].name must be an exact filename; {version} is allowed but globs and paths are not.`);
      } else {
        const stripped = asset.name.replaceAll('{version}', '0.0.0');
        if (stripped.includes('{') || stripped.includes('}')) errors.push(`releaseAssets[${index}].name contains an unknown placeholder.`);
        const key = asset.name.toLocaleLowerCase('en-US');
        if (names.has(key)) errors.push(`releaseAssets contains a case-insensitive duplicate: ${asset.name}`);
        names.add(key);
      }
      if (!PLATFORM_NAMES.has(asset.platform) || !platforms.includes(asset.platform)) {
        errors.push(`releaseAssets[${index}].platform must reference a configured platform.`);
      }
      if (!isNonEmptyString(asset.role)) errors.push(`releaseAssets[${index}].role must be non-empty.`);
    }
  }

  if (!isRecord(profile.promotion)) {
    errors.push('promotion must be an object.');
  } else {
    validateKnownKeys(profile.promotion, ['workflow', 'finalState'], 'promotion', errors);
    validateRelativePath(profile.promotion.workflow, 'promotion.workflow', errors, { workflow: true });
    if (!FINAL_STATES.has(profile.promotion.finalState)) errors.push('promotion.finalState must equal draft or published.');
  }

  if (profile.artifactSelection !== 'workflow-run-attempt-artifact-id') {
    errors.push('artifactSelection must equal workflow-run-attempt-artifact-id.');
  }

  if (!isRecord(profile.releaseChannel)) {
    errors.push('releaseChannel must be an object.');
  } else {
    validateKnownKeys(profile.releaseChannel, ['draft', 'prerelease', 'expectedLatest'], 'releaseChannel', errors);
    for (const key of ['draft', 'prerelease', 'expectedLatest']) {
      if (typeof profile.releaseChannel[key] !== 'boolean') errors.push(`releaseChannel.${key} must be boolean.`);
    }
    if (FINAL_STATES.has(profile.promotion?.finalState) && typeof profile.releaseChannel.draft === 'boolean') {
      const expectedFinalState = profile.releaseChannel.draft ? 'draft' : 'published';
      if (profile.promotion.finalState !== expectedFinalState) {
        errors.push(`promotion.finalState must equal ${expectedFinalState} when releaseChannel.draft is ${profile.releaseChannel.draft}.`);
      }
    }
    if ((profile.releaseChannel.draft === true || profile.releaseChannel.prerelease === true) && profile.releaseChannel.expectedLatest !== false) {
      errors.push('releaseChannel.expectedLatest must be false for draft or prerelease releases.');
    }
  }

  if (isRecord(profile.retryPolicy)) {
    validateKnownKeys(profile.retryPolicy, ['maxConsecutiveFailuresPerStage'], 'retryPolicy', errors);
  }
  if (!isRecord(profile.retryPolicy) || profile.retryPolicy.maxConsecutiveFailuresPerStage !== 2) {
    errors.push('retryPolicy.maxConsecutiveFailuresPerStage must equal 2.');
  }

  if (!isRecord(profile.hashPolicy)) {
    errors.push('hashPolicy must be an object.');
  } else {
    validateKnownKeys(profile.hashPolicy, ['binary', 'text'], 'hashPolicy', errors);
    if (profile.hashPolicy.binary !== 'raw-sha256') errors.push('hashPolicy.binary must equal raw-sha256.');
    if (profile.hashPolicy.text !== 'raw-plus-newline-canonical-sha256') {
      errors.push('hashPolicy.text must equal raw-plus-newline-canonical-sha256.');
    }
  }

  return { ok: errors.length === 0, errors, platforms };
}

export async function readJsonFile(filePath) {
  const bytes = await readFile(filePath);
  return parseStrictUtf8Json(bytes, filePath);
}

export function parseStrictUtf8Json(bytes, label = 'JSON input') {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decoded = decoder.decode(bytes);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = hasBom ? decoded.slice(1) : decoded;
  if (text.includes('\uFEFF')) throw new Error(`${label} contains a duplicate or misplaced UTF-8 BOM.`);
  return JSON.parse(text);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) throw new Error('Usage: validate-release-profile.mjs --profile <profile.json>');
  const profilePath = path.resolve(args.profile);
  const profile = await readJsonFile(profilePath);
  const result = validateReleaseProfile(profile);
  process.stdout.write(`${JSON.stringify({ ...result, profile: profilePath })}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
