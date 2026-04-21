import { useState } from 'react'
import { Download, FileText, Files, Type } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { exportNovel, type ExportFormat } from '../../services/export-service'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { cn } from '../../lib/utils'

interface Props {
  isOpen: boolean
  onClose: () => void
}

/** 导出对话框 — 使用 shadcn/ui */
export default function ExportDialog({ isOpen, onClose }: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  const [format, setFormat] = useState<ExportFormat>('merged-md')
  const [includeOutline, setIncludeOutline] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; path?: string; error?: string } | null>(null)

  const handleExport = async () => {
    if (!currentProject) return
    const dir = await ipc.invoke('dialog:select-folder')
    if (!dir) return

    setExporting(true)
    setResult(null)
    const res = await exportNovel({ format, outputDir: dir, includeOutline })
    setResult(res)
    setExporting(false)
  }

  const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; desc: string; icon: React.ReactNode }> = [
    { value: 'merged-md', label: '合并 Markdown', desc: '全书合并为单个 .md 文件', icon: <FileText size={18} /> },
    { value: 'split-md', label: '分章 Markdown', desc: '每章一个独立 .md 文件', icon: <Files size={18} /> },
    { value: 'txt', label: '纯文本 TXT', desc: '去除格式标记的纯文本', icon: <Type size={18} /> },
  ]

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={16} className="text-[var(--color-accent)]" />
            导出项目
          </DialogTitle>
          <DialogDescription>选择导出格式和目标目录</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-3">
          {/* 格式选择 */}
          <div className="space-y-2">
            {FORMAT_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                onClick={() => setFormat(opt.value)}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors border',
                  format === opt.value
                    ? 'bg-[var(--color-active)] border-[var(--color-accent)]'
                    : 'bg-[var(--color-panel)] border-[var(--color-border)] hover:bg-[var(--color-hover)]'
                )}
              >
                <div className={cn(
                  'transition-colors',
                  format === opt.value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'
                )}>
                  {opt.icon}
                </div>
                <div>
                  <div className="text-xs font-medium text-[var(--color-text)]">{opt.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{opt.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 选项 */}
          <label className="flex items-center gap-2 text-xs cursor-pointer text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={includeOutline} onChange={(e) => setIncludeOutline(e.target.checked)} />
            包含故事大纲
          </label>

          {/* 结果 */}
          {result && (
            <div className={cn(
              'p-3 rounded-lg text-xs',
              result.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
            )}>
              {result.success ? `✅ 已导出到: ${result.path}` : `❌ ${result.error}`}
            </div>
          )}
        </div>

        <DialogFooter className="justify-end">
          <Button variant="default" onClick={handleExport} disabled={exporting}>
            <Download size={13} />
            {exporting ? '导出中...' : '选择目录并导出'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
