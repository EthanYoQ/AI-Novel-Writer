import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const windowsIt = process.platform === 'win32' ? it : it.skip
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"

windowsIt('window snapshot names every live window owner the way Get-Process does', () => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
. ${quote(resolve('scripts/smoke-win-app.ps1'))} -LoadProbeLibrary
$windows = @(Get-AiNovelTopLevelWindowSnapshot)
$mismatches = @(foreach ($window in $windows) {
  $owner = Get-Process -Id $window.ProcessId -ErrorAction SilentlyContinue
  if ($owner -and $owner.ProcessName -ne $window.ProcessName) { '{0}:{1}/{2}' -f $window.ProcessId, $window.ProcessName, $owner.ProcessName }
})
$named = @($windows | Where-Object { $_.ProcessName -ne '<exited>' }).Count
ConvertTo-Json -Compress @{ named = $named; mismatches = $mismatches }
`], { encoding: 'utf8' })
  const snapshot = JSON.parse(output) as { named: number; mismatches: string[] }
  expect(snapshot.mismatches).toEqual([])
  expect(snapshot.named).toBeGreaterThan(0)
}, 60_000)
