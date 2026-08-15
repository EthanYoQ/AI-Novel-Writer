#!/usr/bin/env node
/** Test app that boots two fresh real-Loader contexts around one novel workspace. */
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('complete-chapter driver requires a cordis.yml path')

async function bootConfig() {
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
    return ctx
  } catch (error) {
    try {
      await ctx.fiber.dispose()
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Loader setup and cleanup both failed')
    }
    throw error
  }
}

async function run(phase, task) {
  const ctx = await bootConfig()
  const [agent] = ctx.agents.roots()
  if (agent === undefined || ctx.agents.roots().length !== 1) {
    await ctx.fiber.dispose()
    throw new Error(`complete-chapter driver expected one root agent, found ${ctx.agents.roots().length}`)
  }
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    process.stdout.write(`${JSON.stringify({ type: 'session_event', phase, event })}\n`)
  })
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
  } finally {
    disposeListener()
    await ctx.fiber.dispose()
  }
}

await run('first', '创建一部一致性优先的小说，并完成第一章。')
await run('restart', '重启后读取第一章与项目策略。')
