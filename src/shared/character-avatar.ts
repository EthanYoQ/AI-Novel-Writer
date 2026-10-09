/** Cross-process contract for project-scoped character avatars. */

export const MAX_CHARACTER_AVATAR_INPUT_BYTES = 4 * 1024 * 1024

export type CharacterAvatarErrorCode =
  | 'INVALID_SENDER'
  | 'INVALID_CHARACTER_ID'
  | 'PROJECT_NOT_OPEN'
  | 'CHARACTER_NOT_FOUND'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_FORMAT_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'AVATAR_SAVE_FAILED'

export interface CharacterAvatarError {
  code: CharacterAvatarErrorCode
  message: string
}

export interface CharacterAvatarView {
  characterId: string
  assetRevision: number
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}

export type CharacterAvatarAssetMime = CharacterAvatarView['mime'] | 'application/octet-stream'

export type CharacterAvatarChooseResponse =
  | { success: true; cancelled: true }
  | { success: true; cancelled: false; image: Omit<CharacterAvatarView, 'assetRevision'> }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarCommitResponse =
  | { success: true; avatar: CharacterAvatarView }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarBatchReadResponse =
  | { success: true; avatars: CharacterAvatarView[] }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarRemoveResponse =
  | { success: true }
  | { success: false; error: CharacterAvatarError }

export interface CharacterAvatarChannels {
  'character-avatar:choose': {
    args: [characterId: string]
    return: CharacterAvatarChooseResponse
  }
  'character-avatar:commit': {
    args: [characterId: string, base64: string]
    return: CharacterAvatarCommitResponse
  }
  'character-avatar:read-batch': {
    args: [characterIds: string[]]
    return: CharacterAvatarBatchReadResponse
  }
  'character-avatar:remove': {
    args: [characterId: string]
    return: CharacterAvatarRemoveResponse
  }
}

export type PortableCharacterAvatarRow =
  | {
    kind: 'bound'
    characterId: string
    assetRevision: number
    relativePath: string
    contentHash: string
    mime: CharacterAvatarAssetMime
    byteSize: number
  }
  | {
    kind: 'unresolved'
    recordId: string
    disposition: 'orphan' | 'ambiguous' | 'unknown-fork'
    sourceReference: string
    sourceRelativePath: string
    relativePath: string
    contentHash: string
    mime: CharacterAvatarAssetMime
    byteSize: number
    candidateCharacterIds: string[]
  }
  | {
    kind: 'unresolved-reference'
    recordId: string
    disposition: 'reference-only'
    sourceReference: string
    sourceRelativePath: string
    candidateCharacterIds: string[]
  }
