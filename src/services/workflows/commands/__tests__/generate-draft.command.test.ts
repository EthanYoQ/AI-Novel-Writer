import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { GenerateDraftCommand, countChineseDraftChars, sanitizeDraftText } from '../generate-draft.command'

describe('generate draft command text cleanup', () => {
  it('removes thinking residue and continue UI prompts from draft text', () => {
    const text = sanitizeDraftText(`<think>分析过程</think>

点我继续生成后续内容

林岚推开办公室的门，屏幕上的航班编号仍在闪烁。`)

    expect(text).not.toContain('<think>')
    expect(text).not.toContain('点我继续')
    expect(text).toContain('林岚推开办公室的门')
  })

  it('deduplicates repeated long paragraphs while keeping distinct paragraphs', () => {
    const repeated = '林岚握紧手中的U盘，屏幕蓝光映在她的指节上，走廊尽头传来压低的脚步声，她没有回头，只把那串航班编号重新敲进检索框。'
    const unique = '周砚没有立刻回答，只把监控画面停在三点十七分。'
    const text = sanitizeDraftText(`${repeated}

${unique}

${repeated}`)

    expect(text.match(/林岚握紧手中的U盘/g)).toHaveLength(1)
    expect(text).toContain(unique)
  })

  it('counts non-whitespace draft characters for auto-continue thresholds', () => {
    expect(countChineseDraftChars('林岚\n\n 推门')).toBe(4)
  })

  it('does not delete previous manuscript when a later continuation contains dangling think residue', () => {
    const previous = '林岚已经写下第一段正文。'.repeat(80)
    const text = sanitizeDraftText(`${previous}

碎片
</think>

周砚推门走进监控室。`)

    expect(text).toContain('林岚已经写下第一段正文')
    expect(text).toContain('周砚推门走进监控室')
    expect(text).not.toContain('</think>')
  })
})

describe('GenerateDraftCommand cancellation boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
  })

  it('does not query a version or persist a draft after the main LLM request is cancelled', async () => {
    const projectPath = 'C:\\novels\\A'
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:project-core-get') {
        return { premise: '故事前提', charactersArch: '', worldbuilding: '', synopsis: '' }
      }
      if (channel === 'fs:list-dir' || channel === 'db:character-get-all' || channel === 'db:blueprint-get-all') {
        return []
      }
      throw new Error(`unexpected IPC write/read: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })
    useProjectStore.setState({
      currentProject: {
        id: 'main',
        name: 'A',
        path: projectPath,
        sessionLease: 'lease-main',
        novelConfig: {
          totalChapters: 10,
          wordsPerChapter: 3000,
        },
      } as never,
    })
    const context: WorkflowContext = {
      runId: 'draft-cancel',
      projectPath,
      projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath },
      data: {},
      cancelled: false,
    }
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }
    let resolveLlm: ((value: string) => void) | undefined
    const command = new GenerateDraftCommand({
      projectPath,
      chapterNumber: 1,
      title: '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '开端',
      characters: [],
    })
    vi.spyOn(
      command as unknown as { callLLMWithBuilder: () => Promise<string> },
      'callLLMWithBuilder',
    ).mockImplementation(() => new Promise<string>((resolve) => { resolveLlm = resolve }))

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveLlm).toBeTypeOf('function'))
    context.cancelled = true
    resolveLlm!('不应保存的正文')

    await expect(execution).rejects.toThrow('工作流已取消')
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  })
})
