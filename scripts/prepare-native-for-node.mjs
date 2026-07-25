import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageRoot = path.dirname(require.resolve('better-sqlite3/package.json'))
const packageRequire = createRequire(path.join(packageRoot, 'package.json'))
const prebuildInstall = packageRequire.resolve('prebuild-install/bin.js')

const install = spawnSync(process.execPath, [prebuildInstall], {
  cwd: packageRoot,
  env: {
    ...process.env,
    npm_config_runtime: 'node',
    npm_config_target: process.versions.node,
  },
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true,
})
if (install.error) throw install.error
if (install.status !== 0) {
  throw new Error(`Failed to prepare better-sqlite3 for Node ${process.versions.node}`)
}

const Database = packageRequire('better-sqlite3')
const db = new Database(':memory:')
try {
  const result = db.prepare('select 1 as ok').get()
  if (result?.ok !== 1) {
    throw new Error('better-sqlite3 Node ABI verification query failed')
  }
} finally {
  db.close()
}

console.log(`Verified better-sqlite3 for Node ABI ${process.versions.modules}`)
