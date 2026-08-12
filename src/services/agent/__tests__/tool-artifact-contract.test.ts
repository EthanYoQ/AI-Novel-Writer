import { describe, expect, it } from 'vitest'

import { createToolArtifact, type ToolArtifact } from '../tool-registry'

const session = { projectId: 'p', leaseId: 'lease', projectPath: 'C:\\novels\\p' }

describe('ToolArtifact contract', () => {
  it('requires observable workflow receipt fields', () => {
    const artifact: ToolArtifact = createToolArtifact({
      type: 'workflow_started',
      name: '写稿',
      projectPath: session.projectPath,
      projectSession: session,
      runId: 'run-1',
      status: 'running',
    })
    expect(artifact.type === 'workflow_started' && artifact.runId).toBe('run-1')
  })
})

describe.skip('compile-time invalid artifact examples', () => {
  it('rejects structurally incomplete or mixed artifacts', () => {
  // @ts-expect-error A workflow receipt without runId/status can never report success.
  createToolArtifact({ type: 'workflow_started', name: 'invalid', projectPath: session.projectPath, projectSession: session })
  // @ts-expect-error File artifacts cannot masquerade as workflow receipts.
  createToolArtifact({ type: 'file_modified', name: 'notes.md', path: 'notes.md', projectPath: session.projectPath, projectSession: session, runId: 'run-1', status: 'running' })
  })
})
