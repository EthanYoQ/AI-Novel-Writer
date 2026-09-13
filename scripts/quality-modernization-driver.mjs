import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Existing command tests already inject the physical completion/IPC boundaries.
// Their product text is Chinese; selection deliberately excludes language cases.
export const COMMAND_PROBES = Object.freeze([
  { file: 'directory.command.test.ts', name: 'commits append generation as an exact replace-range operation' },
  { file: 'generate-draft.command.test.ts', name: 'accepts exactly 80% of the target without requesting a continuation' },
  { file: 'refine-draft.command.test.ts', name: 'uses finalized continuity as the only established-history source in the review request' },
])
export function runProductionCommandProbe(target, env, guard) {
  const report = path.join(target.isolationRoot, 'command-probe-vitest.json')
  if (fs.existsSync(report)) fs.unlinkSync(report)
  const prefix = 'src/services/workflows/commands/__tests__/'
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(guard).href, path.join(target.repositoryRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    ...COMMAND_PROBES.map(test => prefix + test.file), '-t', COMMAND_PROBES.map(test => test.name).join('|'),
    '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', `--outputFile=${report}`,
  ], { cwd: target.repositoryRoot, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(report)) throw new Error('COMMAND_PROBE_FAILED')
  const results = JSON.parse(fs.readFileSync(report, 'utf8'))
  const passed = results.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed')
  if (passed.length !== 3 || COMMAND_PROBES.some(test => !passed.some(row => row.title === test.name))) throw new Error('COMMAND_PROBE_COVERAGE_MISMATCH')
  return { status: 'passed', passed: passed.length, commands: ['GenerateDirectoryCommand', 'GenerateDraftCommand', 'ReviewChapterCommand'], evidenceLevel: 'production-command-with-injected-completion-and-IPC', physicalModelRequests: 0, limitations: ['持久结果仅由测试IPC断言，非真实数据库落盘', '不替代中文18章质量、Electron或安装版资格'], report }
}
