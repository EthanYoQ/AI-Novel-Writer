import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import {
  readPortableKnowledgeSnapshot,
  serializePortableKnowledgeSnapshot,
} from '../vector-store'
import { CANONICAL_RAW_PROJECT_ASSETS } from './project-format-migration'
import { portablePathKey } from './portable-project-format'
import type { PortableAssetProvider, PortableProvidedFile } from './project-archive-service'

export const PORTABLE_KNOWLEDGE_SOURCE_PATH = 'portable-knowledge-source.json'

const KNOWN_OMITTED_TOP_LEVEL = new Set([
  'avatars', 'project.db', 'project.db-wal', 'project.db-shm', 'project.db-journal', 'project.json',
  'lancedb', 'embedding-spaces.json', 'vectors.json', 'vectors.json.migrated',
  'vectors.json.migration-journal.json', 'portable-transfer-authority.json', 'portable-runtime-freeze.json',
  PORTABLE_KNOWLEDGE_SOURCE_PATH, 'knowledge-copies', 'cache', 'logs', 'temp', 'trash',
])

function fail(): never { throw new Error('PORTABLE_ASSET_UNSAFE') }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const contained = (root: string, candidate: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function disposition(topLevel: string): PortableProvidedFile['disposition'] {
  if (topLevel === 'prompts') return 'prompt'
  if (topLevel === 'skills' || topLevel === 'writing-skills.json') return 'skill'
  return 'author-content'
}

function physicalDirectory(directory: string, root: string): void {
  const info = fs.lstatSync(directory, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()
    || normalized(fs.realpathSync.native(directory)) !== normalized(directory)
    || (directory !== root && !contained(root, directory))) fail()
}

function physicalFile(file: string, root: string): fs.BigIntStats {
  const info = fs.lstatSync(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
    || !contained(root, file) || !contained(fs.realpathSync.native(root), fs.realpathSync.native(file))) fail()
  return info
}

function enumerateRawFiles(storageRoot: string): PortableProvidedFile[] {
  physicalDirectory(storageRoot, storageRoot)
  const topKeys = new Set<string>()
  for (const name of fs.readdirSync(storageRoot)) {
    const topLevel = fs.lstatSync(path.join(storageRoot, name), { bigint: true })
    if (topLevel.isSymbolicLink()) fail()
    if (name === 'knowledge-copies' && !topLevel.isDirectory()) fail()
    const key = portablePathKey(name)
    if (topKeys.has(key)) fail()
    topKeys.add(key)
    if (!CANONICAL_RAW_PROJECT_ASSETS.includes(name as typeof CANONICAL_RAW_PROJECT_ASSETS[number])
      && !KNOWN_OMITTED_TOP_LEVEL.has(name)) fail()
  }
  const files: PortableProvidedFile[] = []
  const keys = new Set<string>()
  const visit = (topLevel: string, entry: string) => {
    const info = fs.lstatSync(entry, { bigint: true })
    if (info.isSymbolicLink()) fail()
    if (info.isDirectory()) {
      physicalDirectory(entry, storageRoot)
      for (const child of fs.readdirSync(entry).sort()) visit(topLevel, path.join(entry, child))
      return
    }
    const fileInfo = physicalFile(entry, storageRoot)
    const archivePath = path.relative(storageRoot, entry).split(path.sep).join('/')
    const key = portablePathKey(archivePath)
    if (keys.has(key)) fail()
    keys.add(key)
    const bytes = fs.readFileSync(entry)
    if (BigInt(bytes.length) !== fileInfo.size) fail()
    files.push({ id: `raw:${archivePath}`, archivePath, sourcePath: entry,
      byteSize: bytes.length, sha256: sha256(bytes), disposition: disposition(topLevel) })
  }
  for (const name of CANONICAL_RAW_PROJECT_ASSETS) {
    const entry = path.join(storageRoot, name)
    if (fs.existsSync(entry)) {
      const info = fs.lstatSync(entry)
      const directoryExpected = name === 'prompts' || name === 'skills' || name === 'partial_arch'
      if (info.isSymbolicLink() || directoryExpected !== info.isDirectory()) fail()
      visit(name, entry)
    }
  }
  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath))
}

function sameFiles(left: readonly PortableProvidedFile[], right: readonly PortableProvidedFile[]): boolean {
  return JSON.stringify(left.map(({ id, archivePath, byteSize, sha256, disposition }) => (
    { id, archivePath, byteSize, sha256, disposition }
  ))) === JSON.stringify(right.map(({ id, archivePath, byteSize, sha256, disposition }) => (
    { id, archivePath, byteSize, sha256, disposition }
  )))
}

/** Production provider for the canonical raw allowlist plus a strict canonical-text projection. */
export function createPortableProjectAssetProvider(): PortableAssetProvider {
  return {
    async snapshot({ sourceProjectRoot }) {
      const storageRoot = path.join(path.resolve(sourceProjectRoot), CANONICAL_PROJECT_DIRECTORY)
      const rawFiles = enumerateRawFiles(storageRoot)
      const knowledgeBytes = serializePortableKnowledgeSnapshot(await readPortableKnowledgeSnapshot(storageRoot))
      const knowledgeFile: PortableProvidedFile = {
        id: 'canonical-knowledge',
        archivePath: PORTABLE_KNOWLEDGE_SOURCE_PATH,
        sourcePath: '',
        bytes: knowledgeBytes,
        byteSize: knowledgeBytes.length,
        sha256: sha256(knowledgeBytes),
        disposition: 'knowledge-source',
      }
      return {
        files: [...rawFiles, knowledgeFile],
        semanticCounts: { 'raw-assets': rawFiles.length, 'knowledge-snapshots': 1 },
        verifyUnchanged: async () => {
          const currentRaw = enumerateRawFiles(storageRoot)
          const currentKnowledge = serializePortableKnowledgeSnapshot(await readPortableKnowledgeSnapshot(storageRoot))
          return sameFiles(rawFiles, currentRaw) && currentKnowledge.compare(knowledgeBytes) === 0
        },
      }
    },
  }
}
