import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'


/**
 * 文风分析命令
 * 从已写章节中采样正文，调用 AI 提炼作者文风特征，
 * 结果写入 NovelConfig.writingStyle 以锚定后续生成/修稿。
 */
export class AnalyzeWritingStyleCommand extends BaseWorkflowCommand<string> {
  async execute({ callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    callbacks.log('📖 正在采样已有章节正文...')

    // 采样策略：取最近 5 章的正文（从数据库查询）
    const sampleTexts: string[] = []
    try {
      const maxChap = await ipc.invoke('db:draft-get-max-finalized-chapter')
      if (maxChap <= 0) {
        callbacks.log('⚠️ 无已写章节，无法分析文风')
        return ''
      }

      const startChap = Math.max(1, maxChap - 4)
      for (let c = maxChap; c >= startChap; c--) {
        const meta = await ipc.invoke('db:draft-get-finalized', c)
        if (meta) {
          const full = await ipc.invoke('db:draft-get-full', meta.id)
          if (full?.content?.trim()) {
            sampleTexts.push(full.content.trim().slice(0, 2000))
          }
        }
      }
      callbacks.log(`  已采样 ${sampleTexts.length} 章正文`)
    } catch {
      callbacks.log('⚠️ 提取定稿内容失败')
      return ''
    }

    if (sampleTexts.length === 0) {
      callbacks.log('⚠️ 采样文本为空，跳过文风分析')
      return ''
    }

    const template = getPromptTemplate('analyze_writing_style')
    if (!template) throw new Error('未找到文风分析模板')

    const sampleText = sampleTexts.join('\n\n---\n\n')
    const prompt = new BasePromptBuilder(template)
      // 使用 protected variables 需要通过子类或反射，这里使用 build 前手动设置
      ; (prompt as unknown as { variables: { sample_text: string } }).variables = { sample_text: sampleText }
    const finalPrompt = prompt.build()

    callbacks.log('🎨 调用 AI 分析文风特征...')
    const result = await this.callLLM(
      finalPrompt,
      template.systemRole || '你是一位资深的文学评论家和网文研究者。',
      callbacks,
    )

    const cleanResult = this.stripThinkingTags(result).trim()
    if (!cleanResult) {
      callbacks.log('⚠️ 文风分析返回空结果')
      return ''
    }

    // 写入 NovelConfig
    const { updateNovelConfig, saveProject } = useProjectStore.getState()
    updateNovelConfig({ writingStyle: cleanResult })
    await saveProject()
    callbacks.log('✅ 文风特征已保存到小说配置')

    return cleanResult
  }
}
