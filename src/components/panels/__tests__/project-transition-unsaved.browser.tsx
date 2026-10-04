import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  discardProjectTransitionDrafts,
  hasProjectTransitionDrafts,
  saveProjectTransitionDrafts,
} from '../../../services/project-transition'
import { useProjectStore } from '../../../stores/project-store'
import AgentInputBox from '../agent/AgentInputBox'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_A = 'C:\\novels\\transition-a'
const PROJECT_B = 'C:\\novels\\transition-b'
const originalProjectState = useProjectStore.getState()

let container: HTMLDivElement
let root: Root

function project(path: string) {
  return {
    id: path,
    name: path,
    path,
    sessionLease: `${path}-lease`,
    novelConfig: {},
  } as never
}

async function typeInput(value: string) {
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  useProjectStore.setState({ currentProject: project(PROJECT_A) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AgentInputBox />))
})

afterEach(async () => {
  discardProjectTransitionDrafts(PROJECT_A)
  discardProjectTransitionDrafts(PROJECT_B)
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState(originalProjectState)
})

describe('project transition unsent agent input', () => {
  it('saves a project-scoped draft without sending it and restores it after switching back', async () => {
    await typeInput('尚未发送的场景要求')
    expect(hasProjectTransitionDrafts(PROJECT_A)).toBe(true)

    await act(async () => saveProjectTransitionDrafts(PROJECT_A))
    expect(hasProjectTransitionDrafts(PROJECT_A)).toBe(false)

    await act(async () => useProjectStore.setState({ currentProject: project(PROJECT_B) }))
    expect(container.querySelector('textarea')?.value).toBe('')
    await act(async () => useProjectStore.setState({ currentProject: project(PROJECT_A) }))
    expect(container.querySelector('textarea')?.value).toBe('尚未发送的场景要求')

    await typeInput('明确放弃的输入')
    await act(async () => discardProjectTransitionDrafts(PROJECT_A))
    expect(container.querySelector('textarea')?.value).toBe('')
  })
})
