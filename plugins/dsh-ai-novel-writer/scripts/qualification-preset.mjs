#!/usr/bin/env node
/** Real-Loader probe for one installed AI Novel Writer Preset agent. */
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('qualification Preset probe requires a cordis.yml path')

const ctx = new Context()
try {
  ctx.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  await ctx.agents.create({
    sessionId: SessionId('qualification-installed-preset'),
    meta: { cwd: process.cwd(), agentPreset: 'ai-novel-writer' },
    agentOptions: { provider: 'qualification', model: 'qualification' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer'),
  })
  const agents = ctx.agents.roots()
  if (agents.length !== 1 || agents[0] === undefined) {
    throw new Error(`qualification Preset probe expected one root agent, found ${agents.length}`)
  }
  process.stdout.write(`${JSON.stringify({
    agentTools: ctx.tools.schemas(agents[0]),
    globalTools: ctx.tools.schemas(),
  })}\n`)
} catch (error) {
  try {
    await ctx.fiber.dispose()
  } catch (disposeError) {
    throw new AggregateError([error, disposeError], 'Preset probe and cleanup both failed')
  }
  throw error
}
await ctx.fiber.dispose()
