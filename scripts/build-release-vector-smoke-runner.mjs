import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(repositoryRoot, 'electron', 'release-vector-smoke-runner.ts')],
  bundle: true,
  external: ['better-sqlite3', '@lancedb/lancedb'],
  format: 'cjs',
  outfile: path.join(repositoryRoot, 'dist-electron', 'release-vector-smoke-runner.cjs'),
  platform: 'node',
  target: ['node22'],
})
