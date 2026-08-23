/** V2-only agent entry: its Workspace registry is a required Host dependency. */
import type { Context } from '@deepseek-ai/cordis'
import { applyV2, NovelV2Config } from './agent.ts'
import type { NovelV2Config as NovelV2ConfigType } from './agent.ts'

/** Stable Cordis plugin name for the isolated V2 tool surface. */
export const name = 'dsh-ai-novel-writer-agent-v2'

/** V2 needs the Host-owned Workspace registry; V1 deliberately does not. */
export const inject = ['agents', 'systemPrompt', 'tools', 'workspaceRegistry']

/** Runtime config schema for the V2 proposal inbox bounds. */
export const Config = NovelV2Config

/** Register V2 tools with the separately injected Workspace registry. */
export function apply(ctx: Context, config: NovelV2ConfigType = {}): void {
  applyV2(ctx, config)
}
