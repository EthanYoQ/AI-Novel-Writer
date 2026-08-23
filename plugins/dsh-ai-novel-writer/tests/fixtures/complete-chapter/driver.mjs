#!/usr/bin/env node
/** Test app that boots two fresh real-Loader contexts around one novel workspace. */
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('complete-chapter driver requires a cordis.yml path')

async function bootConfig() {
  const ctx = new Context()
  try {
    ctx.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`
    if (process.env.DSH_NOVEL_SCENARIO === 'v2-proposal' || process.env.DSH_NOVEL_SCENARIO === 'v2-authoring-chain') {
      const workspacePath = await realpath(process.cwd())
      const workspaceId = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')
      ctx.provide('workspaceRegistry', {
        resolveByPath: async (path) => {
          if (process.env.DSH_NOVEL_FORCE_READ_ERROR === '1') return undefined
          const canonicalPath = await realpath(path)
          return canonicalPath === workspacePath ? { id: workspaceId, path: workspacePath } : undefined
        },
      })
    }
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

const scenario = process.env.DSH_NOVEL_SCENARIO
if (scenario === 'approval-never') {
  await run('approval-never', '请初始化小说项目并保存。')
} else if (scenario === 'invalid-args') {
  await run('invalid-args', '请初始化小说项目并保存。')
} else if (scenario === 'approval-rejected') {
  await run('approval-rejected', '请初始化小说项目并保存。')
} else if (scenario === 'stale-revision') {
  await run('stale-revision', '初始化小说项目，然后尝试修改项目标题。')
} else if (scenario === 'v2-proposal') {
  await run('v2-proposal', '请读取 V2 小说项目，并提出一个架构修改建议。')
} else if (scenario === 'v2-authoring-chain') {
  const stage = process.env.DSH_NOVEL_AUTHORING_STAGE
  if (typeof stage !== 'string' || stage === '') throw new Error('v2 authoring chain requires DSH_NOVEL_AUTHORING_STAGE')
  const encodedPrompt = process.env.DSH_NOVEL_AUTHORING_PROMPT_BASE64
  if (typeof encodedPrompt !== 'string' || encodedPrompt === '') {
    throw new Error('v2 authoring chain requires the controller-generated DSH_NOVEL_AUTHORING_PROMPT_BASE64 prompt')
  }
  const prompt = Buffer.from(encodedPrompt, 'base64url').toString('utf8')
  if (prompt.trim() === '') throw new Error('v2 authoring chain received an empty controller-generated prompt')
  await run(stage, prompt)
} else {
  await run('first', '创建一部一致性优先的小说，并完成第一章。')
  await run('restart', '重启后读取第一章与项目策略。')
}
