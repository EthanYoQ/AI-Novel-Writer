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

function releaseDirectoryFromArguments(version) {
  const option = process.argv.findIndex(value => value === '--release-dir')
  if (option < 0) return path.join(repositoryRoot, 'release', version)
  const releaseDir = process.argv[option + 1]
  assert(typeof releaseDir === 'string' && releaseDir.length > 0, '--release-dir requires a path')
  return path.resolve(releaseDir)
}

function requiredEvidenceRoot() {
  const value = process.env.AI_NOVEL_RELEASE_EVIDENCE_ROOT
  assert(typeof value === 'string' && value.trim().length > 0, 'Missing required environment variable: AI_NOVEL_RELEASE_EVIDENCE_ROOT')
  return path.resolve(value)
}

function main() {
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert(typeof packageMetadata?.version === 'string' && packageMetadata.version.length > 0, 'package.json must declare a version')
  const releaseDirectory = releaseDirectoryFromArguments(packageMetadata.version)
  const result = finalizeReleaseEvidence({
    platform: 'windows',
    evidenceRoot: requiredEvidenceRoot(),
    releaseRoot: releaseDirectory,
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
