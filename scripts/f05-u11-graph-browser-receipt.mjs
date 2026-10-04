import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const driver = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(driver), '..')
const fixture = path.join(repository, 'src/components/layout/v2/__tests__/f05-writer-graph.browser.tsx')
const config = path.join(repository, 'vitest.browser.config.ts')
const setup = path.join(repository, 'test/setup-locale.ts')
const cases = [
  { title: 'U10.A07, U11.A01/A02/A07: Writer 人物卡头像和图谱交互补充证据', actions: ['U11.A01', 'U11.A02', 'U11.A07'] },
  { title: 'U11.A03/A04/A05/A06: Writer 图谱拖动、平移、缩放、适应和复位', actions: ['U11.A03', 'U11.A04', 'U11.A05', 'U11.A06'] },
]

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function sourceState() {
  const tracked = git('diff', '--name-only', 'HEAD', '--', 'src', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts')
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'src', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts')
  return {
    executionHead: git('rev-parse', 'HEAD'),
    driverSha256: hash(driver), fixtureSha256: hash(fixture), configSha256: hash(config), setupSha256: hash(setup),
    dirtyProductPaths: [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))]
      .filter(file => file.startsWith('src/') ? !file.includes('/__tests__/') : true).sort(),
  }
}

export function verifiedSteps(report) {
  assert.equal(report.success, true, 'browser report did not pass')
  assert.equal(report.numFailedTests, 0, 'browser report has failed tests')
  assert.equal(report.testResults?.length, 1, 'expected exactly one browser test file')
  assert.equal(path.resolve(report.testResults[0].name), fixture, 'unexpected browser test file')
  const results = report.testResults[0].assertionResults
  assert.ok(Array.isArray(results), 'browser assertion results are missing')
  return cases.flatMap(({ title, actions }) => {
    const matches = results.filter(result => result.fullName === title)
    assert.equal(matches.length, 1, `missing or duplicate browser test: ${title}`)
    assert.equal(matches[0].status, 'passed', `browser test did not pass: ${title}`)
    return actions.map(actionId => ({
      stepId: `${actionId}-writer-v3-browser`, actionId, status: 'PASS', evidenceLevel: 'browser', sourceTest: title,
    }))
  })
}

function main() {
  const runId = randomUUID()
  const outputDir = path.join(repository, '.runtime/.cache/f05-u11-graph-browser', runId)
  fs.mkdirSync(outputDir, { recursive: true })
  const reportPath = path.join(outputDir, 'vitest.json')
  const receiptPath = path.join(outputDir, 'receipt.json')
  const receipt = {
    schemaVersion: 1, runId, qualification: 'F05_U11_A01_A07_WRITER_V3_BROWSER_ONLY',
    evidenceLevel: 'browser', outcome: 'FAIL', runner: 'vitest.browser.config.ts / chromium',
    fixture: path.relative(repository, fixture).replaceAll('\\', '/'),
    limitations: ['mock IPC and canvas', 'not packaged Electron or native evidence', 'does not qualify U10.A07/A08 or U11.A13'],
    steps: [],
  }
  try {
    const before = sourceState()
    Object.assign(receipt, before, { nodeVersion: process.version })
    assert.deepEqual(before.dirtyProductPaths, [], 'product source is dirty')
    const result = spawnSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run', '--config', path.relative(repository, config),
      path.relative(repository, fixture), '--reporter=json', `--outputFile=${reportPath}`,
    ], { cwd: repository, stdio: 'inherit' })
    receipt.vitestExitCode = result.status
    if (fs.existsSync(reportPath)) {
      receipt.report = { path: path.relative(repository, reportPath).replaceAll('\\', '/'), sha256: hash(reportPath) }
    }
    assert.equal(result.status, 0, result.error?.message || 'Vitest browser run failed')
    assert.ok(receipt.report, 'Vitest JSON report is missing')
    const steps = verifiedSteps(JSON.parse(fs.readFileSync(reportPath, 'utf8')))
    assert.deepEqual(sourceState(), before, 'source changed during browser run')
    receipt.steps = steps
    receipt.outcome = 'PASS'
  } catch (error) {
    receipt.error = String(error)
  }
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.relative(repository, receiptPath), steps: receipt.steps.map(step => step.stepId) })}\n`)
  if (receipt.outcome !== 'PASS') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === driver) main()
