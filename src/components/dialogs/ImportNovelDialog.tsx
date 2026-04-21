import { useState, useCallback } from 'react'
import { FileUp, FolderOpen, BookOpen, Zap, Clock, AlertTriangle } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { ipc } from '../../services/ipc-client'
import { createImportWorkflow, estimateImportCost } from '../../services/workflows/import-workflow'
import type { ImportedChapter } from '../../services/workflows/commands/import-novel.command'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

interface ImportNovelDialogProps {
  open: boolean
  onClose: () => void
}

/** 导入小说向导对话框 */
export default function ImportNovelDialog({ open, onClose }: ImportNovelDialogProps) {
  const createProject = useProjectStore((s) => s.createProject)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)

  // 表单状态
  const [name, setName] = useState('')
  const [savePath, setSavePath] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])

  // 拆章结果
  const [chapters, setChapters] = useState<ImportedChapter[]>([])
  const [totalWords, setTotalWords] = useState(0)
  const [splitting, setSplitting] = useState(false)
  const [splitDone, setSplitDone] = useState(false)
  const [splitError, setSplitError] = useState('')

  // 导入流程
  const [importing, setImporting] = useState(false)

  /** 选择文件 */
  const handleSelectFiles = useCallback(async () => {
    const files = await ipc.invoke('dialog:select-novel-files')
    if (!files || files.length === 0) return

    setSelectedFiles(files)
    setSplitDone(false)
    setSplitError('')
    setChapters([])

    // 自动推断项目名称（取第一个文件名去掉后缀）
    if (!name.trim()) {
      const firstFile = files[0]
      const baseName = firstFile.split('/').pop()?.replace(/\.(txt|md|text)$/i, '') || '导入小说'
      setName(baseName)
    }

    // 自动拆章预览
    setSplitting(true)
    try {
      const result = await ipc.invoke('import:split-chapters', files)
      if (result.success) {
        setChapters(result.chapters)
        setTotalWords(result.totalWords)
        setSplitDone(true)
      } else {
        setSplitError(result.error || '拆章失败')
      }
    } catch (e) {
      setSplitError(String(e))
    } finally {
      setSplitting(false)
    }
  }, [name])

  /** 选择保存路径 */
  const handleSelectFolder = useCallback(async () => {
    const selected = await ipc.invoke('dialog:select-folder')
    if (selected) setSavePath(selected)
  }, [])

  /** 执行导入 */
  const handleImport = useCallback(async () => {
    if (!name.trim() || !savePath.trim() || chapters.length === 0) return

    setImporting(true)
    try {
      // 1. 创建项目骨架
      const success = await createProject({
        name: name.trim(),
        path: savePath.trim(),
        genre: '',
        targetAudience: '',
      })

      if (!success) {
        setImporting(false)
        return
      }

      // 2. 启动导入工作流
      const workflow = createImportWorkflow({ chapters })
      await startWorkflow(workflow, true) // 步进模式，方便用户观察

      onClose()
    } catch (e) {
      console.error('[ImportNovel] 导入失败:', e)
    } finally {
      setImporting(false)
    }
  }, [name, savePath, chapters, createProject, startWorkflow, onClose])

  // 成本预估
  const costEstimate = splitDone && chapters.length > 0
    ? estimateImportCost(totalWords, chapters.length)
    : null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp size={18} className="text-[var(--color-accent)]" />
            导入已有小说
          </DialogTitle>
          <DialogDescription>选择小说文件，Vela 将自动拆章并通过 AI 逆向推演全部结构化数据</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* ===== 文件选择 ===== */}
          <div>
            <Label>选择小说文件</Label>
            <div className="flex gap-2">
              <div
                className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs truncate"
                style={{
                  backgroundColor: 'var(--color-input)',
                  border: '1px solid var(--color-border)',
                  color: selectedFiles.length > 0 ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <BookOpen size={14} style={{ flexShrink: 0 }} />
                {selectedFiles.length > 0
                  ? `${selectedFiles.length} 个文件已选择`
                  : '支持 .txt / .md 文件（单个或多个）'}
              </div>
              <Button variant="outline" onClick={handleSelectFiles} disabled={splitting}>
                <FolderOpen size={14} />
                选择
              </Button>
            </div>
          </div>

          {/* ===== 拆章预览 ===== */}
          {splitting && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-secondary)' }}>
              <div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
              正在分析并拆分章节...
            </div>
          )}

          {splitError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ backgroundColor: 'rgba(220, 38, 38, 0.08)', color: 'var(--color-danger, #dc2626)' }}>
              <AlertTriangle size={14} />
              {splitError}
            </div>
          )}

          {splitDone && chapters.length > 0 && (
            <div className="rounded-lg overflow-hidden"
              style={{ border: '1px solid var(--color-border)' }}>
              {/* 统计头 */}
              <div className="flex items-center gap-4 px-3 py-2"
                style={{ backgroundColor: 'var(--color-hover)' }}>
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  共 {chapters.length} 章
                </span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {totalWords.toLocaleString()} 字
                </span>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  平均 {Math.round(totalWords / chapters.length).toLocaleString()} 字/章
                </span>
              </div>
              {/* 章节列表（最多显示 8 行 + 省略） */}
              <div className="px-3 py-2 space-y-1" style={{ maxHeight: '160px', overflowY: 'auto' }}>
                {chapters.slice(0, 8).map((ch) => (
                  <div key={ch.number} className="flex items-center justify-between text-xs">
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      第{ch.number}章 {ch.title}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>
                      {ch.wordCount.toLocaleString()} 字
                    </span>
                  </div>
                ))}
                {chapters.length > 8 && (
                  <div className="text-xs text-center py-1" style={{ color: 'var(--color-text-muted)' }}>
                    ··· 还有 {chapters.length - 8} 章 ···
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===== 项目信息 ===== */}
          <div>
            <Label>作品名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="导入后的项目名称"
            />
          </div>

          <div>
            <Label>保存位置</Label>
            <div className="flex gap-2">
              <Input
                value={savePath}
                onChange={(e) => setSavePath(e.target.value)}
                placeholder="选择项目保存目录"
                className="flex-1"
              />
              <Button variant="outline" onClick={handleSelectFolder}>
                <FolderOpen size={14} />
                选择
              </Button>
            </div>
          </div>

          {/* ===== Token 预估 ===== */}
          {costEstimate && (
            <div className="rounded-lg px-3 py-2.5 space-y-1.5"
              style={{
                backgroundColor: 'rgba(107, 164, 220, 0.06)',
                border: '1px solid rgba(107, 164, 220, 0.15)',
              }}>
              <div className="flex items-center gap-1.5">
                <Zap size={13} style={{ color: 'var(--color-accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  预估 AI 消耗
                </span>
              </div>
              <div className="text-xs space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {costEstimate.breakdown.split('\n').map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <Clock size={11} />
                预计耗时 ~{costEstimate.estimatedMinutes} 分钟（因模型速度而异）
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            onClick={handleImport}
            disabled={importing || !name.trim() || !savePath.trim() || chapters.length === 0}
          >
            <FileUp size={14} />
            {importing ? '导入中...' : `开始导入（${chapters.length} 章）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
