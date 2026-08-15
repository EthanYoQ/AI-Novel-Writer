import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NovelProjectId } from '../src/types.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const testRoot = join(repositoryRoot, '.runtime', '.cache', 'dsh-ai-novel-tests')
let prepared: Promise<void> | undefined

/** Deterministic manifest identity used to compare approval cards with committed bytes. */
export const TEST_INITIALIZATION_IDENTITY = {
  projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
} as const

async function prepareTestRoot(): Promise<void> {
  await mkdir(testRoot, { recursive: true })
  try {
    await writeFile(join(testRoot, '.vibe-owner.json'), `${JSON.stringify({
      owner: 'codex-ticket-103',
      sourceProject: repositoryRoot,
      purpose: 'AI Novel Writer Harness plugin focused tests',
      createdAt: new Date().toISOString(),
      ttlDays: 1,
      cleanup: `Remove-Item -LiteralPath '${testRoot}' -Recurse -Force`,
    }, null, 2)}\n`, { flag: 'wx' })
  } catch (cause) {
    if (typeof cause !== 'object' || cause === null || !('code' in cause) || cause.code !== 'EEXIST') throw cause
  }
}

/** Create an isolated test workspace under the repository-owned cache. */
export async function makeTestWorkspace(prefix: string): Promise<string> {
  prepared ??= prepareTestRoot()
  await prepared
  return mkdtemp(join(testRoot, prefix))
}
