import { afterEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { createArchitectureWorkflow } from '../architecture-workflow'

const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState({ locale: originalLocale })
})

describe('architecture workflow project context', () => {
  it('creates visible workflow copy in English when the UI locale is English', () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise'],
    })

    expect(workflow.title).toBe('Generate story architecture')
    expect(workflow.steps[0]).toMatchObject({
      name: 'Story premise',
      description: 'Refine the story premise and its core appeal',
    })
    expect(workflow.onComplete?.message).toBe(
      'Story architecture is ready. Open Story Architecture from the sidebar.',
    )
  })

  it('stops a later step when the user switches projects between workflow steps', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })
    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise', 'characters'],
    })
    useProjectStore.setState({
      currentProject: {
        id: 'project-B',
        sessionLease: 'lease-B',
        name: 'B',
        path: 'C:/projects/B',
        novelConfig: {},
        characterStates: {},
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    await expect(workflow.steps[1].executor(
      {
        id: 'characters',
        name: '角色图谱',
        description: '',
        status: 'running',
        logs: [],
      },
      {
        runId: 'test-run',
        projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {},
        cancelled: false,
      },
      { log: () => undefined, setProgress: () => undefined, appendText: () => undefined },
    )).rejects.toThrow('当前项目已切换，架构生成已停止以避免写入错误项目')
  })

  it('binds a factory-created workflow to its original lease across a same-path reopen', () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })
    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise'],
    })

    expect(workflow.projectSession).toMatchObject({
      projectId: 'project-A',
      leaseId: 'lease-A',
      projectPath: 'C:/projects/A',
    })

    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A-reopened',
        name: 'A reopened',
        path: 'c:/PROJECTS/A/',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    expect(() => createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: workflow.projectSession,
      selectedSteps: ['premise'],
    })).toThrow('当前项目已切换，无法启动架构生成')
  })
})
