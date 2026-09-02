export interface BlueprintCharacterSyncFactSource {
  chapterNumber: number
  characters: readonly string[]
  relationshipHints?: unknown
}

export interface BlueprintCharacterSyncRosterFact {
  name: string
  relationships: readonly { target: string; relation: string }[]
  /** Retained only so verification can prove free text is not accepted as structured evidence. */
  legacyRelationshipNotes?: string
}

interface RelationshipFact {
  from: string
  to: string
  relation: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nameKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US')
}

function relationshipFacts(hints: unknown): RelationshipFact[] {
  if (!Array.isArray(hints)) return []
  return hints.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const rawFrom = candidate.from ?? candidate.source
    const rawTo = candidate.to ?? candidate.target
    if (
      typeof rawFrom !== 'string'
      || !rawFrom.trim()
      || typeof rawTo !== 'string'
      || !rawTo.trim()
    ) return []
    const relation = typeof candidate.relation === 'string' && candidate.relation.trim()
      ? candidate.relation.trim()
      : '相关'
    return [{ from: rawFrom.trim(), to: rawTo.trim(), relation }]
  })
}

function relationshipSatisfied(
  source: BlueprintCharacterSyncRosterFact,
  targetName: string,
  relation: string,
): boolean {
  const targetKey = nameKey(targetName)
  return source.relationships.some(edge => (
    nameKey(edge.target) === targetKey && edge.relation.trim() === relation
  ))
}

/**
 * Verifies relationship enrichment for characters that already exist in the
 * authoritative roster. Blueprint-only names are planning references and are
 * deliberately not required to become character cards.
 */
export function blueprintCharacterSyncFactError(
  blueprints: readonly BlueprintCharacterSyncFactSource[],
  roster: readonly BlueprintCharacterSyncRosterFact[],
): string | undefined {
  const rosterByName = new Map(roster.map(entry => [nameKey(entry.name), entry] as const))
  for (const blueprint of blueprints) {
    for (const fact of relationshipFacts(blueprint.relationshipHints)) {
      const from = rosterByName.get(nameKey(fact.from))
      const to = rosterByName.get(nameKey(fact.to))
      if (!from || !to) continue
      // Legacy relationship prose remains authoritative read-only evidence.
      // Blueprint sync must not force a lossy conversion merely to close its
      // post-commit bookkeeping operation.
      if (from.legacyRelationshipNotes || to.legacyRelationshipNotes) continue
      if (
        !relationshipSatisfied(from, to.name, fact.relation)
        || !relationshipSatisfied(to, from.name, fact.relation)
      ) {
        return `角色名单缺少「${fact.from}—${fact.to}：${fact.relation}」关系事实`
      }
    }
  }
  return undefined
}
