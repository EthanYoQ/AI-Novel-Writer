#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
release_directory="$repository_root/release/$version"
target_arch="${AI_NOVEL_RELEASE_TARGET_ARCH:-arm64}"
case "$target_arch" in
  arm64)
    expected_runner_machine_arch='arm64'
    ;;
  x64)
    expected_runner_machine_arch='x86_64'
    ;;
  *)
    echo "Unsupported macOS release target architecture: $target_arch" >&2
    exit 1
    ;;
esac
runner_machine_arch="$(uname -m)"
if [[ "$runner_machine_arch" != "$expected_runner_machine_arch" ]]; then
  echo "macOS runner architecture mismatch: expected $expected_runner_machine_arch for $target_arch, got $runner_machine_arch" >&2
  exit 1
fi
dmg="$release_directory/ai-novel-writer-mac-$target_arch-$version-installer.dmg"
qualification_directory="$release_directory/qualification"
evidence_root="${AI_NOVEL_RELEASE_EVIDENCE_ROOT:-$qualification_directory}"
acceptance_directory="$evidence_root/acceptance"

if [[ ! -f "$dmg" ]]; then
  echo "Missing macOS DMG: $dmg" >&2
  exit 1
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/ai-novel-macos-dmg-smoke.XXXXXX")"
mount_point="$smoke_root/mount"
smoke_home="$smoke_root/home"
skin_home="$smoke_root/vela-skin-home"
mounted=0
unmount_attempted=0
unmount_succeeded=0
dmg_mount_observed=0
app=''
executable=''
secure_helper=''
dmg_sha256=''
dmg_mount_receipt="$acceptance_directory/dmg-mount.json"
packaged_smoke_receipt="$acceptance_directory/packaged-smoke.json"
signing_receipt="$acceptance_directory/signing.json"

write_dmg_mount_receipt() {
  node - "$dmg_mount_receipt" "$dmg" "$app" "$executable" "$secure_helper" "$dmg_sha256" "$mount_point" "$unmount_attempted" "$unmount_succeeded" "$target_arch" "$runner_machine_arch" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [output, dmg, app, executable, helper, dmgSha256, mountPoint, unmountAttempted, unmountSucceeded, targetArch, runnerMachine] = process.argv.slice(2)

for (const [label, value] of Object.entries({ dmg, app, executable, helper, dmgSha256, mountPoint, targetArch, runnerMachine })) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing observed DMG mount fact: ${label}`)
}
if (!/^[a-f0-9]{64}$/i.test(dmgSha256)) throw new Error('Invalid observed DMG SHA-256')

const direct = {
  dmg: { path: dmg, filename: path.basename(dmg) },
  app: { path: app, bundleName: path.basename(app) },
  executable: { path: executable, present: true },
  helper: { path: helper, present: true },
  hash: { algorithm: 'sha256', value: dmgSha256 },
  mount: {
    path: mountPoint,
    attached: true,
    command: 'hdiutil attach -readonly -nobrowse -mountpoint',
  },
  unmount: {
    attempted: unmountAttempted === '1',
    succeeded: unmountSucceeded === '1',
    command: 'hdiutil detach -force -quiet',
  },
  architecture: { target: targetArch, runnerMachine },
}

fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 2,
  kind: 'dmg-mount',
  platform: 'darwin',
  arch: targetArch,
  accepted: true,
  observations: [
    `Mounted ${path.basename(dmg)} at ${mountPoint} with hdiutil.`,
    `Observed app bundle ${path.basename(app)}, executable, and secure helper in the mounted DMG.`,
    `Unmount attempted=${direct.unmount.attempted} succeeded=${direct.unmount.succeeded}.`,
  ],
  direct,
  ...direct,
}, null, 2)}\n`, 'utf8')
NODE
}

cleanup() {
  local exit_status=$?
  if [[ "$mounted" == "1" ]]; then
    unmount_attempted=1
    if hdiutil detach "$mount_point" -force -quiet; then
      unmount_succeeded=1
    elif [[ "$exit_status" == "0" ]]; then
      exit_status=1
    fi
    mounted=0
  fi
  if [[ "$dmg_mount_observed" == "1" ]]; then
    write_dmg_mount_receipt || true
  fi
  rm -rf "$smoke_root" || true
  return "$exit_status"
}
trap cleanup EXIT

mkdir -p "$mount_point" "$smoke_home" "$skin_home" "$qualification_directory" "$acceptance_directory"
dmg_sha256="$(shasum -a 256 "$dmg" | awk '{print $1}')"
if [[ ! "$dmg_sha256" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "Could not calculate SHA-256 for macOS DMG: $dmg" >&2
  exit 1
fi
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mount_point" -quiet
mounted=1

app="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "$app" ]]; then
  echo 'Mounted DMG does not contain an application bundle.' >&2
  exit 1
fi
executable="$app/Contents/MacOS/AI小说作家"
if [[ ! -x "$executable" ]]; then
  echo "Missing executable in mounted application: $executable" >&2
  exit 1
fi
secure_helper="$app/Contents/Resources/security/darwin-safe-file-system"
if [[ ! -x "$secure_helper" ]]; then
  echo "Missing executable Darwin secure file-system helper: $secure_helper" >&2
  exit 1
fi
vector_runner="$app/Contents/Resources/app.asar/dist-electron/release-vector-smoke-runner.cjs"
if [[ ! -f "$app/Contents/Resources/app.asar" ]]; then
  echo 'Mounted application does not contain app.asar.' >&2
  exit 1
fi
dmg_mount_observed=1
write_dmg_mount_receipt

command -v codesign >/dev/null || { echo 'codesign is required for macOS DMG signing observation.' >&2; exit 1; }
command -v spctl >/dev/null || { echo 'spctl is required for macOS Gatekeeper observation.' >&2; exit 1; }
signing_observation_directory="$smoke_root/signing-observation"
mkdir -p "$signing_observation_directory"
codesign_details="$signing_observation_directory/codesign-details.txt"
codesign_verification="$signing_observation_directory/codesign-verify.txt"
spctl_assessment="$signing_observation_directory/spctl-assess.txt"
set +e
codesign -dv --verbose=4 "$app" > "$codesign_details" 2>&1
codesign_details_status=$?
codesign --verify --deep --strict --verbose=2 "$app" > "$codesign_verification" 2>&1
codesign_verification_status=$?
spctl --assess --type execute --verbose=4 "$app" > "$spctl_assessment" 2>&1
spctl_assessment_status=$?
set -e

node --input-type=module - "$repository_root/scripts/release-evidence-v2.mjs" "$signing_receipt" "$codesign_details_status" "$codesign_verification_status" "$spctl_assessment_status" "$codesign_details" "$codesign_verification" "$spctl_assessment" "$target_arch" "$runner_machine_arch" <<'NODE'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [evidenceModule, output, detailsStatus, verificationStatus, assessmentStatus, detailsFile, verificationFile, assessmentFile, targetArch, runnerMachine] = process.argv.slice(2)
const { classifyMacosCodeSigning, MACOS_FORMAL_DISTRIBUTION_POLICY } = await import(pathToFileURL(evidenceModule).href)

function observedCommand(command, exitCode, outputFile) {
  const output = fs.readFileSync(outputFile)
  return {
    command,
    exitCode: Number(exitCode),
    outputSha256: crypto.createHash('sha256').update(output).digest('hex'),
  }
}

const codesignDetails = observedCommand('codesign -dv --verbose=4', detailsStatus, detailsFile)
const codesignVerification = observedCommand('codesign --verify --deep --strict --verbose=2', verificationStatus, verificationFile)
const gatekeeperAssessment = observedCommand('spctl --assess --type execute --verbose=4', assessmentStatus, assessmentFile)
const codeSigningObservation = classifyMacosCodeSigning({
  detailsExitCode: codesignDetails.exitCode,
  verificationExitCode: codesignVerification.exitCode,
  detailsOutput: fs.readFileSync(detailsFile, 'utf8'),
})
const codeSigning = {
  expected: MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning,
  ...codeSigningObservation,
  details: codesignDetails,
  verification: codesignVerification,
}

if (
  (codeSigning.observed !== 'ad_hoc' && codeSigning.observed !== 'unsigned')
  || codeSigning.hasDeveloperIdIdentity
) {
  throw new Error('Formal macOS release policy requires ad-hoc or unsigned code signing without a Developer ID identity.')
}

const notarization = {
  expected: MACOS_FORMAL_DISTRIBUTION_POLICY.notarization,
  observed: MACOS_FORMAL_DISTRIBUTION_POLICY.notarization,
  basis: 'The formal macOS release has no Apple notarization stage.',
}
const gatekeeper = {
  assessment: gatekeeperAssessment,
  observed: gatekeeperAssessment.exitCode === 0 ? 'accepted-on-runner' : 'manual-confirmation-may-be-required',
}
const validationResult = `Observed ${codeSigning.observed} code signing without a Developer ID identity. Apple notarization is ${notarization.observed}; Gatekeeper assessment exited with ${gatekeeperAssessment.exitCode}.`
const gatekeeperImpact = 'macOS Gatekeeper can warn about or block this package because it has no Developer ID distribution identity and is not notarized.'
const direct = {
  codeSigning,
  notarization,
  gatekeeper,
  architecture: { target: targetArch, runnerMachine },
}

fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 2,
  kind: 'signing',
  platform: 'darwin',
  arch: targetArch,
  accepted: true,
  status: MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning,
  validationResult,
  unsignedDistributionImpact: gatekeeperImpact,
  gatekeeperImpact,
  observations: [
    `codesign details exited with ${codesignDetails.exitCode}; code-signing state=${codeSigning.observed}; Developer ID identity=${codeSigning.hasDeveloperIdIdentity}.`,
    `codesign verification exited with ${codesignVerification.exitCode}.`,
    `Apple notarization state=${notarization.observed} under the formal release policy.`,
    `spctl Gatekeeper assessment exited with ${gatekeeperAssessment.exitCode}; Gatekeeper state=${gatekeeper.observed}.`,
  ],
  direct,
}, null, 2)}\n`, 'utf8')
NODE

run_with_timeout() {
  local label="$1"
  local timeout_seconds="$2"
  shift 2
  python3 - "$label" "$timeout_seconds" "$@" <<'PY'
import subprocess
import sys

label, timeout_seconds, *command = sys.argv[1:]
try:
    completed = subprocess.run(command, timeout=int(timeout_seconds))
except subprocess.TimeoutExpired:
    print(f"Package smoke process exceeded timeout ({timeout_seconds}s): {label}", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
}

node - "$secure_helper" "$smoke_root" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const [helper, smokeRoot] = process.argv.slice(2)
const root = path.join(smokeRoot, 'secure-root')
const outside = path.join(smokeRoot, 'outside')
fs.mkdirSync(root)
fs.mkdirSync(outside)
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8')
const rootInformation = fs.statSync(root, { bigint: true })
const rootIdentity = {
  volumeSerialNumber: rootInformation.dev.toString(),
  fileIndex: rootInformation.ino.toString(),
}

function invoke(request, commit = false) {
  const input = [JSON.stringify({ ...request, rootIdentity }), ...(commit ? [JSON.stringify({ command: 'commit' })] : [])].join('\n') + '\n'
  const result = spawnSync(helper, [], { input, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Secure helper exited ${result.status}: ${String(result.stderr).trim()}`)
  const responses = String(result.stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  if (responses.length === 0) throw new Error('Secure helper returned no response')
  return responses
}

function requireOk(responses, label) {
  const final = responses.at(-1)
  if (final?.ok !== true) throw new Error(`${label} failed: ${JSON.stringify(final)}`)
  return final
}

requireOk(invoke({ operation: 'mkdir', rootPath: root, relativePath: 'chapters' }), 'mkdir')
const writeResponses = invoke({
  operation: 'write', rootPath: root, relativePath: 'chapters/one.txt',
  contentBase64: Buffer.from('safe package smoke', 'utf8').toString('base64'),
}, true)
if (writeResponses[0]?.phase !== 'ready') throw new Error('Secure helper did not preserve the atomic-write ready boundary')
requireOk(writeResponses, 'write')
const read = requireOk(invoke({ operation: 'read', rootPath: root, relativePath: 'chapters/one.txt', maxBytes: 1024 }), 'read')
if (Buffer.from(read.contentBase64 ?? '', 'base64').toString('utf8') !== 'safe package smoke') throw new Error('Secure helper read returned the wrong content')

fs.symlinkSync(outside, path.join(root, 'escape'))
const escaped = invoke({ operation: 'read', rootPath: root, relativePath: 'escape/secret.txt', maxBytes: 1024 }).at(-1)
if (escaped?.ok === true || escaped?.code !== 'SECURE_FS_REPARSE_POINT') {
  throw new Error(`Secure helper failed to reject a symlink escape: ${JSON.stringify(escaped)}`)
}
NODE

token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
skin_token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
vector_evidence="$qualification_directory/packaged-vector-smoke.json"
homepage_evidence="$qualification_directory/packaged-official-homepage-smoke.json"
skin_evidence="$qualification_directory/packaged-skin-smoke.json"

run_with_timeout 'packaged vector smoke' 120 env \
  ELECTRON_RUN_AS_NODE=1 HOME="$smoke_home" AI_NOVEL_RELEASE_SMOKE=1 AI_NOVEL_RELEASE_SMOKE_TOKEN="$token" \
  "$executable" "$vector_runner" "--ai-novel-release-smoke=$token" > "$vector_evidence"
run_with_timeout 'packaged official homepage smoke' 300 env \
  HOME="$smoke_home" AI_NOVEL_RELEASE_HOMEPAGE_SMOKE=1 AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN="$token" \
  "$executable" "--ai-novel-release-homepage-smoke=$token" > "$homepage_evidence"
run_with_timeout 'packaged skin smoke' 120 env \
  HOME="$smoke_home" AI_NOVEL_VELA_HOME="$skin_home" AI_NOVEL_RELEASE_SKIN_SMOKE=1 AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN="$skin_token" \
  "$executable" "--ai-novel-release-skin-smoke=$skin_token" > "$skin_evidence"

node - "$vector_evidence" "$homepage_evidence" "$skin_evidence" <<'NODE'
const fs = require('node:fs')
const [vectorFile, homepageFile, skinFile] = process.argv.slice(2)
const vector = JSON.parse(fs.readFileSync(vectorFile, 'utf8'))
const homepage = JSON.parse(fs.readFileSync(homepageFile, 'utf8'))
const skin = JSON.parse(fs.readFileSync(skinFile, 'utf8'))
if (vector?.schemaVersion !== 1 || vector?.kind !== 'packaged-vector-smoke') throw new Error('Invalid vector smoke evidence')
if (homepage?.schemaVersion !== 1 || homepage?.kind !== 'packaged-official-homepage-smoke') throw new Error('Invalid homepage smoke evidence')
if (skin?.schemaVersion !== 1 || skin?.kind !== 'packaged-skin-smoke') throw new Error('Invalid skin smoke evidence')
if (skin?.builtInAnime?.asset !== 'skins/anime-night.webp' || skin?.builtInAnime?.present !== true || skin?.builtInAnime?.format !== 'webp') {
  throw new Error('Packaged anime skin evidence is incomplete')
}
if (skin?.customSkin?.importSucceeded !== true || skin?.customSkin?.readSucceeded !== true || skin?.customSkin?.stateRestored !== true) {
  throw new Error('Packaged custom skin persistence evidence is incomplete')
}
NODE

node - "$qualification_directory/macos-dmg-smoke.json" "$dmg" "$app" "$target_arch" "$runner_machine_arch" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const [output, dmg, app, targetArch, runnerMachine] = process.argv.slice(2)
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex')
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'macos-dmg-smoke',
  platform: 'darwin',
  arch: targetArch,
  mountedApplication: app.split('/').pop(),
  secureFileSystemHelper: 'security/darwin-safe-file-system',
  secureFileSystemSmoke: true,
  dmgSha256: sha256,
  vectorSmoke: true,
  officialHomepageSmoke: true,
  skinSmoke: true,
  architecture: { target: targetArch, runnerMachine },
}, null, 2)}\n`)
NODE

node - "$packaged_smoke_receipt" "$release_directory" "$vector_evidence" "$homepage_evidence" "$skin_evidence" "$qualification_directory/macos-dmg-smoke.json" "$target_arch" "$runner_machine_arch" <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [output, releaseDirectory, vectorFile, homepageFile, skinFile, macosDmgSmokeFile, targetArch, runnerMachine] = process.argv.slice(2)

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function reference(label, file, expectedKind) {
  const fact = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (fact?.kind !== expectedKind) throw new Error(`Invalid ${label} packaged smoke fact`)
  return {
    path: path.relative(releaseDirectory, file).split(path.sep).join('/'),
    kind: fact.kind,
    sha256: sha256(file),
  }
}

const vector = reference('vector', vectorFile, 'packaged-vector-smoke')
const homepage = reference('official homepage', homepageFile, 'packaged-official-homepage-smoke')
const skin = reference('skin', skinFile, 'packaged-skin-smoke')
const macosDmgSmoke = JSON.parse(fs.readFileSync(macosDmgSmokeFile, 'utf8'))
if (macosDmgSmoke?.schemaVersion !== 1 || macosDmgSmoke?.kind !== 'macos-dmg-smoke') {
  throw new Error('Invalid macOS DMG smoke fact')
}
const macosDmgSmokeReference = {
  path: path.relative(releaseDirectory, macosDmgSmokeFile).split(path.sep).join('/'),
  kind: macosDmgSmoke.kind,
  sha256: sha256(macosDmgSmokeFile),
}
const direct = {
  mountedApplication: macosDmgSmoke.mountedApplication,
  secureFileSystemHelper: macosDmgSmoke.secureFileSystemHelper,
  secureFileSystemSmoke: macosDmgSmoke.secureFileSystemSmoke,
  dmgSha256: macosDmgSmoke.dmgSha256,
  vectorSmoke: macosDmgSmoke.vectorSmoke,
  officialHomepageSmoke: macosDmgSmoke.officialHomepageSmoke,
  skinSmoke: macosDmgSmoke.skinSmoke,
  architecture: { target: targetArch, runnerMachine },
}

fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 2,
  kind: 'packaged-smoke',
  platform: 'darwin',
  arch: targetArch,
  accepted: true,
  references: {
    vector,
    officialHomepage: homepage,
    skin,
    macosDmgSmoke: macosDmgSmokeReference,
  },
  observations: [
    'Validated the packaged vector smoke fact.',
    'Validated the packaged official-homepage smoke fact.',
    'Validated the packaged skin smoke fact.',
    'Validated the direct macOS DMG smoke fact.',
  ],
  direct,
  directFacts: direct,
}, null, 2)}\n`, 'utf8')
NODE
