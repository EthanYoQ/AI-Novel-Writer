import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backfillVectors, importText, searchKnowledge, searchKnowledgeFTS } from '../knowledge-base'
import { closeConnection, getEmbeddingSpaces } from '../vector-store'

const RELEASE_SMOKE_ARGUMENT_PREFIX = '--ai-novel-release-smoke='

export interface ReleaseVectorSmokeInvocation {
  token: string
}

export interface ReleaseVectorSmokeEvidence {
  schemaVersion: 1
  kind: 'packaged-vector-smoke'
  projectA: {
    vectorDimension: 768
    importChunkCount: number
    ftsResultCount: number
    semanticResultCount: number
  }
  projectB: {
    initialVectorDimension: 768
    vectorDimension: 1536
    initialImportChunkCount: number
    backfilledChunkCount: number
    sameFingerprintRebuilt: true
    ftsResultCount: number
    semanticResultCount: number
  }
}

let claimedToken: string | undefined

export function releaseVectorSmokeWasRequested(args: readonly string[] = process.argv): boolean {
  return args.some(argument => argument.startsWith(RELEASE_SMOKE_ARGUMENT_PREFIX))
}

export function parseReleaseVectorSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseVectorSmokeInvocation | undefined {
  const matches = args.filter(argument => argument.startsWith(RELEASE_SMOKE_ARGUMENT_PREFIX))
  if (matches.length !== 1 || env.AI_NOVEL_RELEASE_SMOKE !== '1') return undefined
  const token = matches[0].slice(RELEASE_SMOKE_ARGUMENT_PREFIX.length)
  if (!/^[a-f0-9]{32,128}$/i.test(token) || env.AI_NOVEL_RELEASE_SMOKE_TOKEN !== token) return undefined
  return { token }
}

export function claimReleaseVectorSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseVectorSmokeInvocation | undefined {
  const invocation = parseReleaseVectorSmokeInvocation(args, env)
  if (!invocation || claimedToken !== undefined) return undefined
  claimedToken = invocation.token
  return invocation
}

function createInternalProjectRoot(): string {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir())
  const projectRoot = fs.mkdtempSync(path.join(temporaryRoot, 'ai-novel-release-smoke-'))
  const canonicalProjectRoot = fs.realpathSync.native(projectRoot)
  const relative = path.relative(temporaryRoot, canonicalProjectRoot)
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !path.basename(canonicalProjectRoot).startsWith('ai-novel-release-smoke-')
    || fs.readdirSync(canonicalProjectRoot).length !== 0
  ) {
    fs.rmSync(canonicalProjectRoot, { recursive: true, force: true })
    throw new Error('Release vector smoke refused an unsafe temporary project path')
  }
  return canonicalProjectRoot
}

function releaseSmokeModel(
  token: string,
  dimension: 768 | 1536,
  modelName: string = `release-smoke-${dimension}`,
) {
  return {
    baseUrl: `vela-release-smoke://${token}`,
    apiKey: token,
    modelName,
    // This test-only selector is accepted solely by the dual-gated provider
    // in embedding.ts. It is deliberately excluded from the persisted model
    // fingerprint so this smoke covers a real same-fingerprint dimension drift.
    releaseSmokeDimension: dimension,
  }
}

function assertSmokeResult(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Packaged vector smoke failed: ${detail}`)
}

function reportReleaseVectorSmokeStage(stage: string): void {
  // This is qualification-only diagnostics. Keep stdout reserved for the final
  // evidence JSON and never include the one-time token or temporary paths.
  process.stderr.write(`[AI Novel release vector smoke] stage=${stage}\n`)
}

function activeDimension(registry: Awaited<ReturnType<typeof getEmbeddingSpaces>>): number | undefined {
  return registry.spaces.find(space => space.generation === registry.activeGeneration)?.vectorDimension
}

/**
 * Runs inside the packaged Electron main process. It accepts no filesystem
 * arguments: both projects are newly created under os.tmpdir() and removed
 * after producing the in-memory evidence consumed by the installer gate.
 */
export async function runReleaseVectorSmoke(token: string): Promise<ReleaseVectorSmokeEvidence> {
  const invocation = parseReleaseVectorSmokeInvocation(
    [`${RELEASE_SMOKE_ARGUMENT_PREFIX}${token}`],
    process.env,
  )
  if (!invocation || invocation.token !== token) {
    throw new Error('Release vector smoke requires its environment and one-time CLI token')
  }

  reportReleaseVectorSmokeStage('invocation-valid')
  const root = createInternalProjectRoot()
  const projectA = path.join(root, 'project-a')
  const projectB = path.join(root, 'project-b')
  fs.mkdirSync(projectA)
  fs.mkdirSync(projectB)
  reportReleaseVectorSmokeStage('temporary-projects-created')
  try {
    const model768 = releaseSmokeModel(token, 768)
    reportReleaseVectorSmokeStage('import-a')
    const importedA = await importText(
      'installed package vector source A',
      'packaged-vector-a.txt',
      projectA,
      'openai',
      model768,
    )
    assertSmokeResult(importedA.success && importedA.chunkCount === 1, '768-dimensional importText did not complete')
    reportReleaseVectorSmokeStage('fts-a')
    const ftsA = await searchKnowledgeFTS('never-match-query-a-9', projectA)
    reportReleaseVectorSmokeStage('semantic-a')
    const semanticA = await searchKnowledge('never-match-query-a-9', projectA, 'openai', model768)
    const registryA = await getEmbeddingSpaces(projectA)
    assertSmokeResult(ftsA.length === 0, '768-dimensional query unexpectedly matched FTS')
    assertSmokeResult(semanticA.length === 1 && semanticA[0]?.fileName === 'packaged-vector-a.txt', '768-dimensional semantic search did not return the imported text')
    assertSmokeResult(activeDimension(registryA) === 768, '768-dimensional embedding space was not active')

    const driftingModelName = 'release-smoke-dimension-drift'
    const modelB768 = releaseSmokeModel(token, 768, driftingModelName)
    reportReleaseVectorSmokeStage('import-b')
    const initialImportB = await importText(
      'installed package vector source B',
      'packaged-vector-b.txt',
      projectB,
      'openai',
      modelB768,
    )
    assertSmokeResult(initialImportB.success && initialImportB.chunkCount === 1, 'same-fingerprint 768-dimensional importText did not complete')
    const registryBeforeB = await getEmbeddingSpaces(projectB)
    assertSmokeResult(activeDimension(registryBeforeB) === 768, 'same-fingerprint 768-dimensional embedding space was not active')
    const modelB1536 = releaseSmokeModel(token, 1536, driftingModelName)
    reportReleaseVectorSmokeStage('backfill-b')
    const backfilledB = await backfillVectors(projectB, 'openai', modelB1536)
    assertSmokeResult(backfilledB.success && backfilledB.processed === 1, 'same-fingerprint 1536-dimensional backfillVectors did not complete')
    reportReleaseVectorSmokeStage('fts-b')
    const ftsB = await searchKnowledgeFTS('never-match-query-b-9', projectB)
    reportReleaseVectorSmokeStage('semantic-b')
    const semanticB = await searchKnowledge('never-match-query-b-9', projectB, 'openai', modelB1536)
    const registryB = await getEmbeddingSpaces(projectB)
    const fingerprintB = `openai|vela-release-smoke://${token}|${driftingModelName}`
    const sameFingerprintSpaces = registryB.spaces.filter(space => space.modelFingerprint === fingerprintB)
    assertSmokeResult(ftsB.length === 0, '1536-dimensional query unexpectedly matched FTS')
    assertSmokeResult(semanticB.length === 1 && semanticB[0]?.fileName === 'packaged-vector-b.txt', '1536-dimensional semantic search did not return the backfilled text')
    assertSmokeResult(activeDimension(registryB) === 1536, '1536-dimensional embedding space was not active')
    assertSmokeResult(
      sameFingerprintSpaces.some(space => space.vectorDimension === 768 && space.status === 'inactive')
        && sameFingerprintSpaces.some(space => space.vectorDimension === 1536 && space.status === 'active'),
      'same-fingerprint rebuild did not preserve 768 and activate 1536 generations',
    )

    return {
      schemaVersion: 1,
      kind: 'packaged-vector-smoke',
      projectA: {
        vectorDimension: 768,
        importChunkCount: importedA.chunkCount,
        ftsResultCount: ftsA.length,
        semanticResultCount: semanticA.length,
      },
      projectB: {
        initialVectorDimension: 768,
        vectorDimension: 1536,
        initialImportChunkCount: initialImportB.chunkCount,
        backfilledChunkCount: backfilledB.processed,
        sameFingerprintRebuilt: true,
        ftsResultCount: ftsB.length,
        semanticResultCount: semanticB.length,
      },
    }
  } finally {
    reportReleaseVectorSmokeStage('cleanup')
    closeConnection(projectA)
    closeConnection(projectB)
    fs.rmSync(root, { recursive: true, force: true })
  }
}
