import path from 'node:path'

/** Existing consumer tests use the real coordinator with three synthetic siblings. */
export async function prepareGlobalDataFixture(root: string): Promise<string> {
  const legacySource = path.join(root, 'legacy'), canonicalTarget = path.join(root, 'canonical'), userData = path.join(root, 'userData')
  process.env.AI_NOVEL_VELA_HOME = legacySource
  process.env.AI_NOVEL_APP_DATA_HOME = canonicalTarget
  const { runGlobalDataMigration, activateGlobalData } = await import('../global-data-migration')
  const result = runGlobalDataMigration({ legacySource, canonicalTarget, userData, exclusiveAccess: true })
  if (result.state !== 'ready') throw new Error(result.code)
  activateGlobalData(result)
  return result.dataRoot
}
