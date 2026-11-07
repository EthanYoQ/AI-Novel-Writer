/* eslint-env node */
// Compiles the native secure file system helper on Linux only. Other platforms
// exit successfully so `pnpm dev` and `pnpm build` keep their existing flow on
// Windows (PowerShell helper) and macOS (clang helper compiled by the mac build).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'linux') process.exit(0)

const source = path.resolve('electron/security/linux-safe-file-system.c')
const output = path.resolve('electron/security/linux-safe-file-system')

if (!existsSync(source)) {
  console.error(`Missing secure file system source: ${source}`)
  process.exit(1)
}

const compiler = process.env.CC || 'cc'
try {
  execFileSync(compiler, ['-O2', '-std=gnu11', '-Wall', '-Wextra', '-o', output, source], {
    stdio: 'inherit',
  })
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.error(`No C compiler found (${compiler}). Install a C toolchain to build the Linux helper.`)
    process.exit(1)
  }
  throw error
}

chmodSync(output, 0o755)
