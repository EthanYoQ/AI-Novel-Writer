import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(repositoryRoot, 'electron', 'release-vector-smoke-runner.ts')],
  bundle: true,
  alias: { electron: path.join(repositoryRoot, 'scripts', 'release-vector-smoke-electron-stub.mjs') },
  external: ['better-sqlite3', '@lancedb/lancedb'],
  banner: { js: 'const __aiNovelImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__aiNovelImportMetaUrl' },
  format: 'cjs',
  outfile: path.join(repositoryRoot, 'dist-electron', 'release-vector-smoke-runner.cjs'),
  platform: 'node',
  target: ['node22'],
})
