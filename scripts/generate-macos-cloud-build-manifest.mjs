import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { finalizeReleaseEvidence } from './release-evidence-v2.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredEvidenceRoot() {
  const value = process.env.AI_NOVEL_RELEASE_EVIDENCE_ROOT
  assert(typeof value === 'string' && value.trim().length > 0, 'Missing required environment variable: AI_NOVEL_RELEASE_EVIDENCE_ROOT')
  return path.resolve(value)
}

function main() {
  assert(process.platform === 'darwin', 'macOS qualification manifest can only be generated on darwin')
  assert(process.arch === 'arm64', 'macOS qualification manifest requires arm64')
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert(typeof packageMetadata?.version === 'string' && packageMetadata.version.length > 0, 'package.json must declare a version')
  const result = finalizeReleaseEvidence({
    platform: 'macos',
    evidenceRoot: requiredEvidenceRoot(),
    releaseRoot: path.join(repositoryRoot, 'release', packageMetadata.version),
  })
  console.log(`Wrote runtime verification manifest: ${result.manifestPath}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
