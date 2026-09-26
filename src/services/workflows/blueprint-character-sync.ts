import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { CharacterProposalBatch } from '../../shared/character-proposal'
import type { BlueprintNewCharacterCandidate } from '../../shared/blueprint-semantic-contract'
import { ipc } from '../ipc-client'

export interface BlueprintCharacterCandidateSource {
  chapterNumber: number
  characters: readonly string[]
  newCharacterCandidates?: readonly BlueprintNewCharacterCandidate[]
  relationshipHints?: unknown
}

/** Stage the exact durable directory operation. Renderer names never authorize roster writes. */
export async function syncBlueprintCharacterCandidates(
  _blueprints: readonly BlueprintCharacterCandidateSource[],
  _expectedProjectPath: string,
  projectSession: ProjectSessionContext,
  operationId?: string,
): Promise<CharacterProposalBatch> {
  if (!operationId?.trim()) throw new Error('CHARACTER_PROPOSAL_DIRECTORY_OPERATION_REQUIRED')
  return ipc.invokeWithProjectSession(projectSession, 'character-proposal:stage', {
    source: { kind: 'directory', operationId },
  })
}
