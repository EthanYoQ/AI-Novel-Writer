/** Main-issued source snapshot. No external paths, embedding credentials or endpoint metadata. */
export interface GenerationKnowledgeItem {
  revision: number
  chunkId: string; documentId: string; chunkIndex: number; text: string; fileName: string; score: number
  corpusKind: 'reference' | 'project-knowledge' | 'unknown'
  contentHash: string; documentChunkCount: number; documentChunkSetHash: string
}
export interface GenerationKnowledgeSnapshot {
  version: 1
  state: 'empty' | 'stored'
  storageState: 'absent' | 'empty' | 'present'
  query: string; topK: number
  canonicalRevision: number | null; documentsRevision: number | null
  items: GenerationKnowledgeItem[]
}
