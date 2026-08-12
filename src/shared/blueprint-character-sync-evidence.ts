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
 * Verifies the authoritative roster after a durable blueprint sync. Returning
 * no error is the only fact evidence that may close the pending operation.
 */
export function blueprintCharacterSyncFactError(
  blueprints: readonly BlueprintCharacterSyncFactSource[],
  roster: readonly BlueprintCharacterSyncRosterFact[],
): string | undefined {
  const rosterByName = new Map(roster.map(entry => [nameKey(entry.name), entry] as const))
  const expectedNames = new Map<string, string>()
  for (const blueprint of blueprints) {
    for (const rawName of blueprint.characters) {
      if (typeof rawName === 'string' && rawName.trim()) {
        expectedNames.set(nameKey(rawName), rawName.trim())
      }
    }
  }
  for (const [key, name] of expectedNames) {
    if (!rosterByName.has(key)) return `角色名单缺少蓝图角色「${name}」`
  }

  for (const blueprint of blueprints) {
    for (const fact of relationshipFacts(blueprint.relationshipHints)) {
      const from = rosterByName.get(nameKey(fact.from))
      const to = rosterByName.get(nameKey(fact.to))
      if (!from || !to) continue
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
