#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

version="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
release_directory="$repository_root/release/$version"
dmg="$release_directory/ai-novel-writer-mac-arm64-$version-installer.dmg"
qualification_directory="$release_directory/qualification"

if [[ ! -f "$dmg" ]]; then
  echo "Missing macOS DMG: $dmg" >&2
  exit 1
fi

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/ai-novel-macos-dmg-smoke.XXXXXX")"
mount_point="$smoke_root/mount"
smoke_home="$smoke_root/home"
mounted=0

cleanup() {
  local exit_status=$?
  if [[ "$mounted" == "1" ]]; then
    hdiutil detach "$mount_point" -force -quiet || true
    mounted=0
  fi
  rm -rf "$smoke_root" || true
  return "$exit_status"
}
trap cleanup EXIT

mkdir -p "$mount_point" "$smoke_home" "$qualification_directory"
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

function invoke(request, commit = false) {
  const input = [JSON.stringify(request), ...(commit ? [JSON.stringify({ command: 'commit' })] : [])].join('\n') + '\n'
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
const read = requireOk(invoke({ operation: 'read', rootPath: root, relativePath: 'chapters/one.txt' }), 'read')
if (Buffer.from(read.contentBase64 ?? '', 'base64').toString('utf8') !== 'safe package smoke') throw new Error('Secure helper read returned the wrong content')

fs.symlinkSync(outside, path.join(root, 'escape'))
const escaped = invoke({ operation: 'read', rootPath: root, relativePath: 'escape/secret.txt' }).at(-1)
if (escaped?.ok === true || escaped?.code !== 'SECURE_FS_REPARSE_POINT') {
  throw new Error(`Secure helper failed to reject a symlink escape: ${JSON.stringify(escaped)}`)
}
NODE

token="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
vector_evidence="$qualification_directory/packaged-vector-smoke.json"
homepage_evidence="$qualification_directory/packaged-official-homepage-smoke.json"

run_with_timeout 'packaged vector smoke' 120 env \
  ELECTRON_RUN_AS_NODE=1 HOME="$smoke_home" AI_NOVEL_RELEASE_SMOKE=1 AI_NOVEL_RELEASE_SMOKE_TOKEN="$token" \
  "$executable" "$vector_runner" "--ai-novel-release-smoke=$token" > "$vector_evidence"
run_with_timeout 'packaged official homepage smoke' 300 env \
  HOME="$smoke_home" AI_NOVEL_RELEASE_HOMEPAGE_SMOKE=1 AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN="$token" \
  "$executable" "--ai-novel-release-homepage-smoke=$token" > "$homepage_evidence"

node - "$vector_evidence" "$homepage_evidence" <<'NODE'
const fs = require('node:fs')
const [vectorFile, homepageFile] = process.argv.slice(2)
const vector = JSON.parse(fs.readFileSync(vectorFile, 'utf8'))
const homepage = JSON.parse(fs.readFileSync(homepageFile, 'utf8'))
if (vector?.schemaVersion !== 1 || vector?.kind !== 'packaged-vector-smoke') throw new Error('Invalid vector smoke evidence')
if (homepage?.schemaVersion !== 1 || homepage?.kind !== 'packaged-official-homepage-smoke') throw new Error('Invalid homepage smoke evidence')
NODE

node - "$qualification_directory/macos-dmg-smoke.json" "$dmg" "$app" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const [output, dmg, app] = process.argv.slice(2)
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex')
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'macos-dmg-smoke',
  platform: 'darwin',
  arch: 'arm64',
  mountedApplication: app.split('/').pop(),
  secureFileSystemHelper: 'security/darwin-safe-file-system',
  secureFileSystemSmoke: true,
  dmgSha256: sha256,
  vectorSmoke: true,
  officialHomepageSmoke: true,
}, null, 2)}\n`)
NODE
