/** Manifest, physical storage, and SQLite schema versions are separate contracts. */
export const CANONICAL_PROJECT_DIRECTORY = '.ai-novel'
export const CANONICAL_PROJECT_DATABASE = 'project.db'
export interface CanonicalProjectManifest {
  schemaVersion: 1
  kind: 'ai-novel-project'
  projectId: string
  createdAt: string
  storageFormat: 'ai-novel'
  storageVersion: 1
}

export function parseCanonicalProjectManifest(value: unknown): CanonicalProjectManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PROJECT_MANIFEST_INVALID')
  const record = value as Record<string, unknown>
  const keys = ['schemaVersion', 'kind', 'projectId', 'createdAt', 'storageFormat', 'storageVersion']
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) ||
      record.schemaVersion !== 1 || record.kind !== 'ai-novel-project' || record.storageFormat !== 'ai-novel' || record.storageVersion !== 1 ||
      typeof record.projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.projectId) ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('PROJECT_MANIFEST_INVALID')
  return { schemaVersion: 1, kind: 'ai-novel-project', projectId: record.projectId, createdAt: record.createdAt, storageFormat: 'ai-novel', storageVersion: 1 }
}

export function createCanonicalProjectManifest(identity: { projectId: string; createdAt: string }): CanonicalProjectManifest {
  return parseCanonicalProjectManifest({ schemaVersion: 1, kind: 'ai-novel-project', ...identity, storageFormat: 'ai-novel', storageVersion: 1 })
}
