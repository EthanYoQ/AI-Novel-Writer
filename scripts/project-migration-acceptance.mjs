import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(repository, '.runtime', '.cache', 'novel-quality-modernization')
const suites = [
  'electron/migrations/__tests__/character-assets-migration.test.ts',
  'electron/migrations/__tests__/m05-installed-lane.test.ts',
  'electron/services/__tests__/project-format-migration.test.ts',
  'electron/services/__tests__/project-access.test.ts',
  'electron/services/__tests__/project-storage-preflight.test.ts',
]
const args = process.argv.slice(2)
function cleanSourceSha() {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true })
  const sha = git.status === 0 ? git.stdout.trim() : ''
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_SHA_UNAVAILABLE')
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'electron', 'src', 'scripts'], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
  })
  if (status.status !== 0) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_STATUS_UNAVAILABLE')
  if (status.stdout.length > 0) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_SOURCE_DIRTY')
  return sha
}
if (args.length === 0 || args.includes('--help')) {
  process.stdout.write('Usage: node scripts/project-migration-acceptance.mjs --dry-run | --run-synthetic\nRuns only repository synthetic fixtures. No author project argument or old-binary safety claim is supported.\n')
} else if (args.length !== 1 || !['--dry-run', '--run-synthetic'].includes(args[0])) {
  throw new Error('PROJECT_MIGRATION_ACCEPTANCE_ARGUMENT_INVALID')
} else {
  // Verify every existing ancestor without following junctions to an external evidence root.
  for (let cursor = cache; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_UNSAFE_ROOT')
  }
  const subjectSha = cleanSourceSha()
  const plan = { scope: 'synthetic-fixtures-only', fixtureRoot: '.runtime/.cache/novel-quality-modernization/s04-fixtures',
    gate: 'F03.m05-integrated', subjectSha, targetSchemaVersion: 6, suites,
    authorProjectsEnabled: false, oldBinaryQualification: 'not-run', powerLossQualification: 'not-run' }
  if (args[0] === '--dry-run') process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  else {
    fs.mkdirSync(cache, { recursive: true })
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const result = spawnSync(pnpm, ['exec', 'vitest', 'run', ...suites], { cwd: repository, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    fs.writeFileSync(path.join(cache, 's04-acceptance.log'), log)
    if (cleanSourceSha() !== subjectSha) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_SOURCE_CHANGED')
    const receipt = { ...plan, exitCode: result.status, completed: result.status === 0,
      validatorLogSha256: createHash('sha256').update(log).digest('hex') }
    fs.writeFileSync(path.join(cache, 'f03-m05-integrated.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = result.status ?? 1
  }
}
