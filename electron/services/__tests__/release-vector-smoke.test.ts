import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseReleaseVectorSmokeInvocation,
  runReleaseVectorSmoke,
} from '../release-vector-smoke'

const previousReleaseSmoke = process.env.AI_NOVEL_RELEASE_SMOKE
const previousReleaseSmokeToken = process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN
const previousArgv = [...process.argv]

function releaseSmokeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  delete environment.AI_NOVEL_RELEASE_SMOKE
  delete environment.AI_NOVEL_RELEASE_SMOKE_TOKEN
  Object.assign(environment, overrides)
  return environment
}

afterEach(() => {
  if (previousReleaseSmoke === undefined) delete process.env.AI_NOVEL_RELEASE_SMOKE
  else process.env.AI_NOVEL_RELEASE_SMOKE = previousReleaseSmoke
  if (previousReleaseSmokeToken === undefined) delete process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN
  else process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN = previousReleaseSmokeToken
  process.argv.splice(0, process.argv.length, ...previousArgv)
  vi.unstubAllGlobals()
})

describe('packaged release vector smoke', () => {
  it('requires both the release-smoke environment flag and its one-time CLI token', () => {
    const token = 'a'.repeat(32)
    const args = ['AI小说作家.exe', `--ai-novel-release-smoke=${token}`]

    expect(parseReleaseVectorSmokeInvocation(args, releaseSmokeEnv())).toBeUndefined()
    expect(parseReleaseVectorSmokeInvocation(args, releaseSmokeEnv({ AI_NOVEL_RELEASE_SMOKE: '1' }))).toBeUndefined()
    expect(parseReleaseVectorSmokeInvocation(args, releaseSmokeEnv({
      AI_NOVEL_RELEASE_SMOKE: '1',
      AI_NOVEL_RELEASE_SMOKE_TOKEN: 'b'.repeat(32),
    }))).toBeUndefined()
    expect(parseReleaseVectorSmokeInvocation(args, releaseSmokeEnv({
      AI_NOVEL_RELEASE_SMOKE: '1',
      AI_NOVEL_RELEASE_SMOKE_TOKEN: token,
    }))).toEqual({ token })
  })

  it('uses deterministic local mock embeddings only under the dual gate and proves a same-fingerprint 768 to 1536 rebuild', async () => {
    const token = 'a'.repeat(32)
    process.env.AI_NOVEL_RELEASE_SMOKE = '1'
    process.env.AI_NOVEL_RELEASE_SMOKE_TOKEN = token
    process.argv.push(`--ai-novel-release-smoke=${token}`)
    const fetchMock = vi.fn(() => { throw new Error('release smoke must not use the network') })
    vi.stubGlobal('fetch', fetchMock)

    await expect(runReleaseVectorSmoke(token)).resolves.toMatchObject({
      schemaVersion: 1,
      kind: 'packaged-vector-smoke',
      projectA: {
        vectorDimension: 768,
        importChunkCount: 1,
        ftsResultCount: 0,
        semanticResultCount: 1,
      },
      projectB: {
        initialVectorDimension: 768,
        vectorDimension: 1536,
        initialImportChunkCount: 1,
        backfilledChunkCount: 1,
        sameFingerprintRebuilt: true,
        ftsResultCount: 0,
        semanticResultCount: 1,
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
