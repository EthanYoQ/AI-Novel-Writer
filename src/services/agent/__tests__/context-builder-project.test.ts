import { afterEach, describe, expect, it } from 'vitest'

import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { buildAgentSystemPrompt } from '../context-builder'

afterEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], currentRun: null })
})

describe('agent context project isolation', () => {
  it('excludes preserved tabs from another project even if an old tab is still active', () => {
    useProjectStore.setState({
      currentProject: {
        id: 'main',
        name: 'Project B',
        path: 'C:\\novels\\B',
        novelConfig: {},
      } as never,
    })
    useEditorStore.setState({
      activeTabId: 'tab-a',
      tabs: [
        {
          id: 'tab-a',
          name: 'A secret draft',
          type: 'chapter',
          projectKey: 'C:\\novels\\A',
          content: 'A-only content must not leak',
        },
        {
          id: 'tab-b',
          name: 'B config',
          type: 'config',
          projectKey: 'C:\\novels\\B',
          content: 'B project content',
        },
      ],
    })
    useWorkflowStore.setState({
      activeRuns: [{
        id: 'run-a',
        projectPath: 'C:\\novels\\A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:\\novels\\A' },
        writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN',
        type: 'chapter_creation',
        title: 'A private workflow',
        status: 'running',
        steps: [],
        currentStepIndex: 0,
        createdAt: new Date().toISOString(),
      }],
      currentRun: null,
    })

    const prompt = buildAgentSystemPrompt('fast')

    expect(prompt).toContain('Project B')
    expect(prompt).toContain('B config')
    expect(prompt).not.toContain('A secret draft')
    expect(prompt).not.toContain('A-only content must not leak')
    expect(prompt).not.toContain('A private workflow')
  })
})
