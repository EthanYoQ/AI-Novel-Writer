import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as lance from '@lancedb/lancedb'
import { afterEach, describe, expect, it } from 'vitest'

import {
  parsePortableKnowledgeSnapshot,
  restorePortableKnowledgeSnapshot,
  verifyPortableKnowledgeSnapshot,
} from '../../vector-store'
import { createPortableProjectAssetProvider, PORTABLE_KNOWLEDGE_SOURCE_PATH } from '../portable-project-assets'

const roots: string[] = []
const knowledge = {
  version: 1 as const,
  documents: [{
    docId: '世界观-1', fileName: '世界观.txt', corpusKind: 'project-knowledge' as const,
    chunks: [{ chunkIndex: 0, text: '雨城终年潮湿。' }, { chunkIndex: 1, text: '铜钥匙只能开启北门。' }],
  }],
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-project-assets-'))
  roots.push(root)
  const storage = path.join(root, '.ai-novel')
  fs.mkdirSync(storage)
  fs.writeFileSync(path.join(storage, 'project.db'), 'db')
  fs.writeFileSync(path.join(storage, 'project.json'), '{}')
  return { root, storage }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('production portable project assets', () => {
  it('projects only canonical raw bytes and strict canonical knowledge without avatars or vectors', async () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.storage, 'prompts'))
    fs.mkdirSync(path.join(f.storage, 'skills', '作者'), { recursive: true })
    fs.mkdirSync(path.join(f.storage, 'avatars', 'ignored'), { recursive: true })
    fs.writeFileSync(path.join(f.storage, 'prompts', '章节.json'), '{"提示":"保持雨夜"}')
    fs.writeFileSync(path.join(f.storage, 'skills', '作者', 'SKILL.md'), '保留作者语气。')
    fs.writeFileSync(path.join(f.storage, 'writing-skills.json'), '{"version":1}')
    fs.writeFileSync(path.join(f.storage, 'partial_arch.json'), '{"候选":"未采用"}')
    fs.writeFileSync(path.join(f.storage, 'avatars', 'ignored', 'avatar.png'), 'avatar')
    await restorePortableKnowledgeSnapshot(f.storage, knowledge)

    const snapshot = await createPortableProjectAssetProvider().snapshot({
      sourceProjectRoot: f.root,
      sourceDatabasePath: path.join(f.storage, 'project.db'),
      projectSession: { projectId: 'p', projectPath: f.root, leaseId: 'l' },
      snapshotGeneration: 'g',
    })

    expect(snapshot.files.map(file => file.archivePath)).toEqual([
      'partial_arch.json', 'prompts/章节.json', 'skills/作者/SKILL.md', 'writing-skills.json',
      PORTABLE_KNOWLEDGE_SOURCE_PATH,
    ])
    expect(snapshot.files.some(file => file.archivePath.includes('avatar') || file.archivePath.includes('lancedb'))).toBe(false)
    const portableKnowledge = snapshot.files.find(file => file.archivePath === PORTABLE_KNOWLEDGE_SOURCE_PATH)!
    expect(parsePortableKnowledgeSnapshot(JSON.parse(portableKnowledge.bytes!.toString('utf8')))).toEqual(knowledge)
    expect(await snapshot.verifyUnchanged()).toBe(true)
    fs.writeFileSync(path.join(f.storage, 'prompts', '章节.json'), '{"提示":"已变化"}')
    expect(await snapshot.verifyUnchanged()).toBe(false)
  })

  it.each([
    { ...knowledge, documents: [{ ...knowledge.documents[0], filePath: 'C:\\secret.txt' }] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], vector: [1, 2] }] },
    { ...knowledge, secret: 'token' },
    { ...knowledge, documents: [{ ...knowledge.documents[0], fileName: 'C:\\作者\\资料.txt' }] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], fileName: '../资料.txt' }] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], fileName: '/tmp/资料.txt' }] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], fileName: '资料/片段.txt' }] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], fileName: '资料\n片段.txt' }] },
    { ...knowledge, documents: [knowledge.documents[0], knowledge.documents[0]] },
    { ...knowledge, documents: [{ ...knowledge.documents[0], chunks: [knowledge.documents[0].chunks[0], knowledge.documents[0].chunks[0]] }] },
  ])('rejects corrupt, duplicate or non-portable knowledge fields', (value) => {
    expect(() => parsePortableKnowledgeSnapshot(value)).toThrow('PORTABLE_KNOWLEDGE_INVALID')
  })

  it('rejects a renderer-imported path-like canonical fileName before archive construction', async () => {
    const f = fixture()
    const db = await lance.connect(path.join(f.storage, 'lancedb'))
    await db.createTable('documents', [{ id: 'renderer-doc', fileName: 'C:\\Users\\作者\\秘密资料.txt',
      importedAt: '2026-09-21T00:00:00.000Z', chunkCount: 1, filePath: 'C:\\Users\\作者\\秘密资料.txt',
      corpusKind: 'reference' }])
    await db.createTable('chunks', [{ id: 'chunk-1', docId: 'renderer-doc',
      fileName: 'C:\\Users\\作者\\秘密资料.txt', text: '可保留的正文。', chunkIndex: 0, totalChunks: 1,
      importedAt: '2026-09-21T00:00:00.000Z', corpusKind: 'reference' }])
    db.close()

    await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: f.root,
      sourceDatabasePath: path.join(f.storage, 'project.db'),
      projectSession: { projectId: 'p', projectPath: f.root, leaseId: 'l' }, snapshotGeneration: 'g' }))
      .rejects.toThrow('PORTABLE_KNOWLEDGE_INVALID')
  })

  it('fails closed on unknown top-level entries, hardlinks and NFKC collisions', async () => {
    const unknown = fixture()
    fs.writeFileSync(path.join(unknown.storage, 'unknown.txt'), 'x')
    await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: unknown.root,
      sourceDatabasePath: '', projectSession: { projectId: 'p', projectPath: unknown.root, leaseId: 'l' },
      snapshotGeneration: 'g' })).rejects.toThrow('PORTABLE_ASSET_UNSAFE')

    const linked = fixture()
    fs.mkdirSync(path.join(linked.storage, 'prompts'))
    fs.writeFileSync(path.join(linked.storage, 'prompts', 'one.txt'), 'x')
    fs.linkSync(path.join(linked.storage, 'prompts', 'one.txt'), path.join(linked.storage, 'prompts', 'two.txt'))
    await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: linked.root,
      sourceDatabasePath: '', projectSession: { projectId: 'p', projectPath: linked.root, leaseId: 'l' },
      snapshotGeneration: 'g' })).rejects.toThrow('PORTABLE_ASSET_UNSAFE')

    const collision = fixture()
    fs.mkdirSync(path.join(collision.storage, 'prompts'))
    fs.writeFileSync(path.join(collision.storage, 'prompts', 'A.txt'), 'a')
    fs.writeFileSync(path.join(collision.storage, 'prompts', 'Ａ.txt'), 'b')
    await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: collision.root,
      sourceDatabasePath: '', projectSession: { projectId: 'p', projectPath: collision.root, leaseId: 'l' },
      snapshotGeneration: 'g' })).rejects.toThrow('PORTABLE_ASSET_UNSAFE')

    const linkedDirectory = fixture()
    const outside = path.join(linkedDirectory.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'escape.txt'), 'outside')
    fs.symlinkSync(outside, path.join(linkedDirectory.storage, 'prompts'), 'junction')
    await expect(createPortableProjectAssetProvider().snapshot({ sourceProjectRoot: linkedDirectory.root,
      sourceDatabasePath: '', projectSession: { projectId: 'p', projectPath: linkedDirectory.root, leaseId: 'l' },
      snapshotGeneration: 'g' })).rejects.toThrow('PORTABLE_ASSET_UNSAFE')
  })

  it('rebuilds and strictly verifies canonical full text without embeddings', async () => {
    const f = fixture()
    await restorePortableKnowledgeSnapshot(f.storage, knowledge)
    expect(await verifyPortableKnowledgeSnapshot(f.storage, knowledge)).toBe(true)
    expect(fs.existsSync(path.join(f.storage, 'embedding-spaces.json'))).toBe(false)
    expect(fs.readdirSync(path.join(f.storage, 'lancedb')).some(name => name.startsWith('chunks__space_'))).toBe(false)
  })
})
