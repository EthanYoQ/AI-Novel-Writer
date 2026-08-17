#!/usr/bin/env node
/** Expose this workspace root under its package name for local Loader checks. */
import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const scopeRoot = join(packageRoot, 'node_modules', '@ethanyoq')
const linkPath = join(scopeRoot, 'dsh-ai-novel-writer')
const packageRootReal = await realpath(packageRoot)

await mkdir(scopeRoot, { recursive: true })
try {
  if (await realpath(linkPath) === packageRootReal) process.exit(0)
  await rm(linkPath, { recursive: true, force: true })
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
await symlink(process.platform === 'win32' ? packageRoot : '../..', linkPath, process.platform === 'win32' ? 'junction' : 'dir')
if (await realpath(linkPath) !== packageRootReal) throw new Error('The local package self-link points to the wrong directory')
