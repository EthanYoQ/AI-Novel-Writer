import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { launchCreativeWorkflow } from '../creative-workflow-launcher'

const session = { projectId: 'NovelA', leaseId: 'lease-NovelA', projectPath: 'C:/NovelA' }

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US' })
})

afterEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: null })
})

describe('创作工作流启动失败的说明按界面语言显示（#471）', () => {
  it('英文界面：项目会话已切换时说明是英文', async () => {
    useProjectStore.setState({ currentProject: null })

    await expect(launchCreativeWorkflow({ workflow: 'generate_draft', chapterNumber: 1 }, session))
      .rejects.toThrow(/^The project session changed, so the workflow did not start\.$/u)
  })

  it('英文界面：不能从对话启动的工作流说明是英文', async () => {
    useProjectStore.setState({
      currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId } as ProjectData,
    })

    await expect(launchCreativeWorkflow({ workflow: 'refine', chapterNumber: 1 }, session))
      .rejects.toThrow(/^refine needs an explicit draft ID and a fixed snapshot of its text\./u)
  })
})
