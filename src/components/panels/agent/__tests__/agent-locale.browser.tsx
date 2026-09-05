import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSkillMd, skillRegistry, type LoadedSkill } from '../../../../services/agent/skill-registry'
import { useAgentStore } from '../../../../stores/agent-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useMCPStore } from '../../../../stores/mcp-store'
import { MenuItem } from '../../../ui/MenuItem'
import AgentHeader from '../AgentHeader'
import MentionMenu from '../MentionMenu'
import SlashCommandMenu from '../SlashCommandMenu'

let container: HTMLDivElement
let root: Root
let originalSkills: LoadedSkill[]
const originalAgentState = useAgentStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalMCPState = useMCPStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  originalSkills = skillRegistry.listAll()
  skillRegistry.clear()
  const skill = parseSkillMd(
    '---\nname: scene-craft\ndisplay_name: Scene Craft\ndescription: Build scenes around consequential choices.\nstage: drafting\n---\nUse concrete action.',
    'scene-craft',
    'user',
    'managed://skills/scene-craft',
    'managed://skills/scene-craft/SKILL.md',
  )!
  skill.metadata.displayName = '场景塑造'
  skill.metadata.description = '以有后果的选择推进场景。'
  skillRegistry.register(skill)
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useAgentStore.setState({
    conversations: [],
    activeConversationId: null,
    showHistory: false,
    toolsInitialized: true,
  })
  useMCPStore.setState({
    servers: [{
      id: 'broken-server',
      name: 'Broken server',
      status: 'error',
      toolCount: 0,
      error: 'provider-secret-server-error',
    }],
    tools: [],
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  skillRegistry.clear()
  for (const skill of originalSkills) skillRegistry.register(skill)
  useAgentStore.setState(originalAgentState, true)
  useLocaleStore.setState(originalLocaleState, true)
  useMCPStore.setState(originalMCPState, true)
})

describe('Agent reachable UI locale', () => {
  it('renders slash commands, mentions, the header skill menu, and disabled menu copy in English', async () => {
    await act(async () => root.render(
      <div>
        <SlashCommandMenu query="" onSelect={() => undefined} onClose={() => undefined} />
        <MentionMenu query="" onSelect={() => undefined} onClose={() => undefined} />
        <MenuItem label="Future action" disabled onClick={() => undefined} />
        <AgentHeader />
      </div>,
    ))

    expect(container.textContent).toContain('Commands')
    expect(container.textContent).toContain('Show available commands and features')
    expect(container.textContent).toContain('Reference context')
    expect(container.textContent).toContain('Story architecture')
    expect(container.textContent).toContain('Coming soon')
    expect(container.textContent).toContain('AI Writing Assistant')

    const moreButton = container.querySelector<HTMLButtonElement>('[title="More options"]')
    expect(moreButton).not.toBeNull()
    await act(async () => moreButton?.click())
    const skillsButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Skills'))
    expect(skillsButton).toBeDefined()

    const mcpButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('MCP servers'))
    await act(async () => mcpButton?.click())
    expect(container.textContent).toContain('Error')
    expect(container.innerHTML).not.toContain('provider-secret-server-error')
    const mcpBackButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('MCP servers'))
    await act(async () => mcpBackButton?.click())
    const reopenedSkillsButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Skills'))
    await act(async () => reopenedSkillsButton?.click())

    expect(container.textContent).toContain('Scene Craft')
    expect(container.textContent).toContain('Build scenes around consequential choices.')
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u)
  })
})
