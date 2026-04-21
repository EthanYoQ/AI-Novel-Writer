import { useState, useRef } from 'react'
import { Sparkles, Hash, FileText } from 'lucide-react'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'

import { useProjectStore } from '../../stores/project-store'
import { createConfigGenerationWorkflow } from '../../services/workflows/architecture-workflow'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import type { NovelConfig } from '../../shared/ipc-channels'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 生成完成后回调（传入 AI 生成的配置） */
  onGenerated: (config: Partial<NovelConfig>) => void
}

/** AI 生成配置对话框 — 用户输入脑洞，AI 自动生成所有配置字段 */
export default function GenerateConfigDialog({ isOpen, onClose, onGenerated }: Props) {
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  // ✅ 用 getState() 获取 action，不订阅 workflow store 的 globalLogs 高频更新
  const addLog = useWorkflowStore.getState().addLog
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const [idea, setIdea] = useState('')

  // 控制当外部 Confirm 弹窗显示时，阻止本 Dialog 因为"点击外部"而意外关闭
  const [confirming, setConfirming] = useState(false)

  // 直接从 Store 读取规模参数 — 单一数据源，无需 local state 镜像
  const totalChapters = currentProject?.novelConfig.totalChapters ?? 100
  const wordsPerChapter = currentProject?.novelConfig.wordsPerChapter ?? 3000

  /** 修改总章数：直接写 Store，允许清空（失焦时由 Input 组件全局兜底） */
  const handleTotalChaptersChange = (val: string) => {
    if (val === '') {
      updateNovelConfig({ totalChapters: '' as unknown as number })
      return
    }
    const n = parseInt(val, 10)
    if (isNaN(n)) return
    updateNovelConfig({ totalChapters: n })
  }

  /** 修改每章字数：直接写 Store，允许清空（失焦时由 Input 组件全局兜底） */
  const handleWordsPerChapterChange = (val: string) => {
    if (val === '') {
      updateNovelConfig({ wordsPerChapter: '' as unknown as number })
      return
    }
    const n = parseInt(val, 10)
    if (isNaN(n)) return
    updateNovelConfig({ wordsPerChapter: n })
  }

  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)

  const handleGenerate = async () => {
    if (!idea.trim() || isSubmittingRef.current) return
    if (!defaultModelId) {
      addLog('error', '⚠️ 请先在设置中配置 AI 模型')
      return
    }

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      // 检测已填写的核心字段，提示用户确认覆盖
      const cfg = currentProject?.novelConfig
      const filledFields: string[] = []
      if (cfg?.coreOutline?.trim()) filledFields.push('核心大纲')
      if (cfg?.worldSetting?.trim()) filledFields.push('世界观设定')
      if (cfg?.goldenFinger?.trim()) filledFields.push('金手指体系')
      if (cfg?.protagonistProfile?.trim()) filledFields.push('主角人设')
      if (cfg?.globalGuidance?.trim()) filledFields.push('全局写作要求')
      if (cfg?.subGenre?.trim()) filledFields.push('细分类型')

      if (filledFields.length > 0) {
        setConfirming(true)
        const fieldList = filledFields.map(f => `• ${f}`).join('\n')
        const ok = await confirm(
          `以下字段已有内容，继续生成将覆盖：\n\n${fieldList}\n\n确定要重新生成吗？`,
          { title: '配置已存在', confirmText: '继续覆盖', cancelText: '取消' }
        )
        setConfirming(false)
        if (!ok) return
      }

      // 覆盖确认通过后，立即关闭弹窗
      onClose()
      toast.info('✨ 正在根据脑洞生成小说配置...')
      addLog('info', `🤖 正在根据创作脑洞生成小说配置（规模：${totalChapters} 章 / ${wordsPerChapter} 字/章）...`)

      // 后台执行 LLM 调用（由 WorkflowEngine 接管并显示全局状态面板）
      startWorkflow(
        createConfigGenerationWorkflow({
          idea,
          totalChapters: totalChapters || 100,
          wordsPerChapter: wordsPerChapter || 3000,
          onGenerated,
        })
      )
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    // 确认弹框期间不允许关闭
    if (!open && !confirming) onClose()
  }

  // 每次打开时预填当前项目的核心大纲
  const defaultIdea = currentProject?.novelConfig.coreOutline || ''

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent 
        className="max-w-[520px]"
        onInteractOutside={e => {
          // 当全局 Confirm 弹窗弹出时，点击 Confirm （由于渲染在 Body）
          // 会被 Radix 误认为是 Interact Outside。因此此时屏蔽关闭事件
          if (confirming) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-[var(--color-accent)]" />
            AI 一键生成小说配置
          </DialogTitle>
          <DialogDescription>
            输入你的创作脑洞，AI 将严格按照下方规模参数生成匹配的节奏规划与设定。
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* 规模参数（联动小说配置）*/}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {/* 标题行：左侧「规模参数」，右侧「全书约 x 字」 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'var(--color-text-muted)',
                }}
              >
                规模参数
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                全书约{' '}
                <strong style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                  {((Number(totalChapters) || 0) * (Number(wordsPerChapter) || 0)).toLocaleString()}
                </strong>{' '}
                字
              </span>
            </div>

            {/* 两列输入框 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {/* 总章数 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <Hash size={11} />
                  总章数
                </label>
              <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={totalChapters}
                  onChange={e => handleTotalChaptersChange(e.target.value)}
                  onBlur={() => {
                    if (!totalChapters || totalChapters < 1) {
                      updateNovelConfig({ totalChapters: 100 })
                    }
                  }}
                />
              </div>

              {/* 每章字数 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <FileText size={11} />
                  每章字数
                </label>
                <Input
                  type="number"
                  min={100}
                  max={20000}
                  step={100}
                  value={wordsPerChapter}
                  onChange={e => handleWordsPerChapterChange(e.target.value)}
                  onBlur={() => {
                    if (!wordsPerChapter || wordsPerChapter < 100) {
                      updateNovelConfig({ wordsPerChapter: 3000 })
                    }
                  }}
                />
              </div>
            </div>
          </div>

          {/* 创作脑洞输入框 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'var(--color-text-muted)',
              }}
            >
              创作脑洞
            </label>
            <Textarea
              autoFocus
              rows={5}
              placeholder={defaultIdea || '示例：我想写一个小人物在废土世界捡到远古文明遗物后逆袭的末世流小说，男频爽文风格，主角性格隐忍但有谋略...'}
              value={idea}
              onChange={e => setIdea(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate()
              }}
            />
          </div>

          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            写得越具体，AI 生成的配置越精准。后续还可以在表单中手动精修。
          </p>
        </div>

        <DialogFooter className="sm:justify-between items-center">
          <span className="text-xs text-[var(--color-text-muted)] mt-2 sm:mt-0">
            生成后自动填入配置表单 · ⌘↵ 快捷确认
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button
              variant="ai"
              size="lg"
              onClick={handleGenerate}
              disabled={!idea.trim() || isSubmitting}
            >
              <><Sparkles size={13} /> 一键生成配置</>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
