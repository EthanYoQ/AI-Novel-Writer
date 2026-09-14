import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(repository, '.runtime', '.cache', 'novel-quality-modernization')
const suites = [
  'electron/services/__tests__/project-format-migration.test.ts',
  'electron/services/__tests__/project-access.test.ts',
  'electron/services/__tests__/project-storage-preflight.test.ts',
]
const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help')) {
  process.stdout.write('Usage: node scripts/project-migration-acceptance.mjs --dry-run | --run-synthetic\nRuns only repository synthetic fixtures. No author project argument or old-binary safety claim is supported.\n')
} else if (args.length !== 1 || !['--dry-run', '--run-synthetic'].includes(args[0])) {
  throw new Error('PROJECT_MIGRATION_ACCEPTANCE_ARGUMENT_INVALID')
} else {
  // Verify every existing ancestor without following junctions to an external evidence root.
  for (let cursor = cache; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('PROJECT_MIGRATION_ACCEPTANCE_UNSAFE_ROOT')
  }
  const plan = { scope: 'synthetic-fixtures-only', fixtureRoot: '.runtime/.cache/novel-quality-modernization/s04-fixtures',
    suites, authorProjectsEnabled: false, oldBinaryQualification: 'not-run', powerLossQualification: 'not-run' }
  if (args[0] === '--dry-run') process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  else {
    fs.mkdirSync(cache, { recursive: true })
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    const result = spawnSync(pnpm, ['exec', 'vitest', 'run', ...suites], { cwd: repository, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true })
    fs.writeFileSync(path.join(cache, 's04-acceptance.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`)
    process.stdout.write(`${JSON.stringify({ ...plan, exitCode: result.status, completed: result.status === 0 })}\n`)
    process.exitCode = result.status ?? 1
  }
}
