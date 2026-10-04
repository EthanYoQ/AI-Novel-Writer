import type { CharacterRenameData } from '../../electron/repositories/character-repository'
import {
  getProjectEditorDraft,
  mergeObjectDraftWithRemote,
  setProjectEditorDraftMetadata,
  type ProjectEditorDraftLedger,
} from './project-editor-draft-ledger'

interface CharacterDraftMetadata {
  renames: CharacterRenameData[]
}

function isRename(value: unknown): value is CharacterRenameData {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.originalName === 'string' && typeof candidate.newName === 'string'
}

export function getCharacterDraftRenames<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
): CharacterRenameData[] {
  const metadata = getProjectEditorDraft(ledger, projectKey)?.metadata
  if (!metadata || typeof metadata !== 'object') return []
  const renames = (metadata as Partial<CharacterDraftMetadata>).renames
  return Array.isArray(renames) ? renames.filter(isRename) : []
}

export function setCharacterDraftRenames<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  renames: CharacterRenameData[],
): ProjectEditorDraftLedger<T> {
  return setProjectEditorDraftMetadata(ledger, projectKey, { renames })
}

export function updateCharacterRename(
  renames: CharacterRenameData[],
  currentName: string,
  newName: string,
  persistedNames: ReadonlySet<string>,
): CharacterRenameData[] {
  const existing = renames.find(rename => rename.newName === currentName)
  if (existing) {
    const others = renames.filter(rename => rename !== existing)
    return newName === existing.originalName
      ? others
      : [...others, { originalName: existing.originalName, newName }]
  }
  if (!persistedNames.has(currentName) || newName === currentName) return renames
  return [...renames, { originalName: currentName, newName }]
}

/**
 * 角色改名尚未落盘时，base/remote 仍使用旧主键，draft 已使用新主键。
 * 先按改名账本统一身份，再对同一角色执行字段级三方合并。
 */
export function mergeCharacterDraftWithRemote<T extends { name: string; characterId?: string }>(
  baseCharacters: readonly T[], draftCharacters: readonly T[], remoteCharacters: readonly T[],
  _renames: readonly CharacterRenameData[],
): T[] {
  void _renames
  for (const cards of [baseCharacters, draftCharacters, remoteCharacters]) {
    const ids = cards.flatMap(c => c.characterId ? [c.characterId] : [])
    if (new Set(ids).size !== ids.length) throw new Error('CHARACTER_DRAFT_IDENTITY_AMBIGUOUS')
  }
  // Names and legacy rename metadata never establish identity. Unbound drafts
  // are retained separately and cannot be saved by the stable-ID writer.
  const baseById = new Map(baseCharacters.filter(c => c.characterId).map(c => [c.characterId!, c]))
  const draftById = new Map(draftCharacters.filter(c => c.characterId).map(c => [c.characterId!, c]))
  const deleted = new Set([...baseById.keys()].filter(id => !draftById.has(id)))
  const included = new Set<string>()
  const merged = remoteCharacters.filter(c => !c.characterId || !deleted.has(c.characterId)).map(remote => {
    if (!remote.characterId) return remote
    included.add(remote.characterId)
    const draft = draftById.get(remote.characterId), base = baseById.get(remote.characterId)
    return draft ? base ? mergeObjectDraftWithRemote(base, draft, remote) : draft : remote
  })
  return [...merged, ...draftCharacters.filter(c => !c.characterId || !included.has(c.characterId))]
}

export function rebaseCharacterRenamesAfterSave(
  savedRenames: CharacterRenameData[],
  currentRenames: CharacterRenameData[],
): CharacterRenameData[] {
  return currentRenames.flatMap((current) => {
    const saved = savedRenames.find(rename => rename.originalName === current.originalName)
    if (!saved) return [current]
    const savedName = saved.newName.trim()
    if (current.newName.trim() === savedName) return []
    return [{ originalName: savedName, newName: current.newName }]
  })
}

/**
 * 保存期间允许继续编辑。除了把显式的二次改名接到刚落盘的新主键后，还要从
 * 本次实际落盘的角色与当前草稿中恢复“改回原名”的身份链：
 *
 * A -> B 正在保存时，用户可能把 B 改回 A。此时普通草稿账本会正确认为草稿
 * 回到了旧基线并清空 A -> B；但首个事务成功后，数据库基线已变成 B，所以
 * 后续仍必须记录 B -> A。
 */
export function rebuildCharacterRenamesAfterSave<T extends { name: string }>(
  savedCharacters: readonly T[],
  currentCharacters: readonly T[],
  savedRenames: CharacterRenameData[],
  currentRenames: CharacterRenameData[],
): CharacterRenameData[] {
  const rebuilt = rebaseCharacterRenamesAfterSave(savedRenames, currentRenames)
    .map(rename => ({
      originalName: rename.originalName.trim(),
      newName: rename.newName.trim(),
    }))
    .filter(rename => rename.originalName !== rename.newName)

  const savedNames = new Set(savedCharacters.map(character => character.name.trim()))
  const currentNames = new Set(currentCharacters.map(character => character.name.trim()))

  for (const savedRename of savedRenames) {
    const originalName = savedRename.originalName.trim()
    const persistedName = savedRename.newName.trim()
    if (
      originalName === persistedName
      || !savedNames.has(persistedName)
      || !currentNames.has(originalName)
      || currentNames.has(persistedName)
      || rebuilt.some(rename => (
        rename.originalName === persistedName || rename.newName === originalName
      ))
    ) {
      continue
    }
    rebuilt.push({ originalName: persistedName, newName: originalName })
  }

  return rebuilt
}
