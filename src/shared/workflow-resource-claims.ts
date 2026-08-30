export interface WorkflowResourceClaims {
  /** Resources this workflow may mutate. */
  readonly resourceKeys?: readonly string[]
  /** Resources this workflow only reads and therefore may share with other readers. */
  readonly readResourceKeys?: readonly string[]
}

export function normalizeWorkflowResourceKeys(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  const keys = [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
  return keys.length > 0 ? Object.freeze(keys) : undefined
}

function intersects(left: readonly string[] | undefined, right: ReadonlySet<string>): boolean {
  return left?.some(key => right.has(key)) ?? false
}

/**
 * Readers may coexist. Any writer conflicts with every other reader or writer
 * of the same logical resource.
 */
export function workflowResourceClaimsConflict(
  active: WorkflowResourceClaims,
  requested: WorkflowResourceClaims,
): boolean {
  const activeWrites = normalizeWorkflowResourceKeys(active.resourceKeys)
  const activeReads = normalizeWorkflowResourceKeys(active.readResourceKeys)
  const requestedWrites = normalizeWorkflowResourceKeys(requested.resourceKeys)
  const requestedReads = normalizeWorkflowResourceKeys(requested.readResourceKeys)

  const activeWriteSet = new Set(activeWrites ?? [])
  const activeReadSet = new Set(activeReads ?? [])
  return intersects(requestedWrites, activeWriteSet)
    || intersects(requestedWrites, activeReadSet)
    || intersects(requestedReads, activeWriteSet)
}
