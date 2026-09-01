import { afterEach, describe, expect, it, vi } from 'vitest'

import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { buildAgentSystemPrompt } from '../context-builder'
import { toolRegistry } from '../tool-registry'
import {
  clearProjectCustomPrompts,
  getBuiltinPromptTemplate,
  loadProjectCustomPrompts,
  saveProjectCustomPrompt,
} from '../../prompt-templates'

afterEach(() => {
  vi.unstubAllGlobals()
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], currentRun: null })
  toolRegistry.unregister('test_chinese_description')
  clearProjectCustomPrompts()
})

describe('agent context project isolation', () => {
  it('hydrates an assistant identity override before the first cold-start request', async () => {
    const builtin = getBuiltinPromptTemplate('assistant_writing_identity', 'en-US')!
    useProjectStore.setState({
      currentProject: {
        id: 'cold-start',
        sessionLease: 'lease-cold-start',
        name: 'Cold Start',
        path: 'C:\\novels\\cold-start',
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
          if (channel === 'fs:check-exists') return true
          if (channel === 'fs:list-dir') return [{
            name: 'assistant_writing_identity.en-US.json',
            path: 'C:\\novels\\cold-start\\.vela\\prompts\\assistant_writing_identity.en-US.json',
            isDir: false,
          }]
          if (channel === 'fs:read-file') return {
            success: true,
            content: JSON.stringify({
              ...builtin,
              writingLanguage: 'en-US',
              systemRole: 'You are the cold-start continuity editor.',
            }),
          }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }),
      },
    })

    const prompt = await buildAgentSystemPrompt('fast', {
      projectSession: {
        projectId: 'cold-start',
        leaseId: 'lease-cold-start',
        projectPath: 'C:\\novels\\cold-start',
      },
      selectedModelId: 'model-1',
    })

    expect(prompt).toContain('You are the cold-start continuity editor.')
  })

  it('uses the language-specific project assistant role and guidance without exposing hidden contracts', async () => {
    const projectSession = {
      projectId: 'english-custom',
      leaseId: 'lease-english-custom',
      projectPath: 'C:\\novels\\english-custom',
    }
    useProjectStore.setState({
      currentProject: {
        id: projectSession.projectId,
        sessionLease: projectSession.leaseId,
        name: 'Night Flight',
        path: projectSession.projectPath,
        novelConfig: { writingLanguage: 'en-US' },
      } as never,
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
          if (channel === 'fs:check-exists') return false
          if (channel === 'fs:mkdir' || channel === 'fs:write-file') return { success: true }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }),
      },
    })
    await loadProjectCustomPrompts(projectSession)
    const builtin = getBuiltinPromptTemplate('assistant_writing_identity', 'en-US')
    expect(builtin).toBeDefined()
    await expect(saveProjectCustomPrompt(projectSession, {
      ...builtin!,
      writingLanguage: 'en-US',
      systemRole: 'You are the author’s continuity partner.',
      taskGuidance: 'Question every unexplained change in motive.',
    })).resolves.toBe(true)

    const prompt = await buildAgentSystemPrompt('fast', { projectSession, selectedModelId: 'model-1' })

    expect(prompt).toContain('You are the author’s continuity partner.')
    expect(prompt).toContain('Question every unexplained change in motive.')
    expect(prompt).toContain('[Immutable system contract]')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('uses English identity, context labels, and tool protocol for an English project', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'english',
        name: 'Night Flight',
        path: 'C:\\novels\\english',
        novelConfig: {
          writingLanguage: 'en-US',
          genre: 'Mystery',
          coreOutline: 'A pilot investigates a forged maintenance log.',
        },
      } as never,
    })
    toolRegistry.register({
      name: 'test_chinese_description',
      description: '这段中文描述不能进入英文模型提示词',
      descriptionEn: 'Registered application tool.',
      source: 'builtin',
      inputSchema: {
        type: 'object',
        properties: { chapter: { type: 'number', description: '章节编号', descriptionEn: 'Chapter number' } },
        required: ['chapter'],
      },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: async () => ({ success: true, content: 'ok' }),
    })

    const prompt = await buildAgentSystemPrompt('fast')

    expect(prompt).toContain('You are an experienced long-form fiction-writing assistant')
    expect(prompt).toContain('## Tool system')
    expect(prompt).toContain('test_chinese_description')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('excludes preserved tabs from another project even if an old tab is still active', async () => {
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

    const prompt = await buildAgentSystemPrompt('fast')

    expect(prompt).toContain('Project B')
    expect(prompt).toContain('B config')
    expect(prompt).not.toContain('A secret draft')
    expect(prompt).not.toContain('A-only content must not leak')
    expect(prompt).not.toContain('A private workflow')
  })
})
