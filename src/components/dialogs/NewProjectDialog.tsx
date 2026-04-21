import { useState, useEffect } from 'react'
import { FolderOpen, Sparkles } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

interface NewProjectDialogProps {
  open: boolean
  onClose: () => void
}

/** 新建项目对话框 */
export default function NewProjectDialog({ open, onClose }: NewProjectDialogProps) {
  const createProject = useProjectStore((s) => s.createProject)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [creating, setCreating] = useState(false)

  /** 对话框每次打开时重置名称 */
  useEffect(() => {
    if (!open) return
    let mounted = true
    Promise.resolve().then(() => { if (mounted) setName('') })
    return () => { mounted = false }
  }, [open])

  /** 选择文件夹 */
  const handleSelectFolder = async () => {
    const selected = await ipc.invoke('dialog:select-folder')
    if (selected) setPath(selected)
  }

  /** 创建项目（类型/受众留空，在小说配置页面填写） */
  const handleCreate = async () => {
    if (!name.trim() || !path.trim()) return
    setCreating(true)
    const success = await createProject({
      name: name.trim(),
      path: path.trim(),
      genre: '',
      targetAudience: '',
    })
    setCreating(false)
    if (success) {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--color-accent)]" />
            新建小说项目
          </DialogTitle>
          <DialogDescription>填写作品名称和保存位置，其余配置在项目内完成</DialogDescription>
        </DialogHeader>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-4">
          {/* 项目名称 */}
          <div>
            <Label>作品名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：斗破苍穹"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          {/* 保存路径 */}
          <div>
            <Label>保存位置</Label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="选择项目保存目录"
                className="flex-1"
              />
              <Button variant="outline" onClick={handleSelectFolder}>
                <FolderOpen size={14} />
                选择
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim() || !path.trim()}
          >
            <Sparkles size={14} />
            {creating ? '创建中...' : '创建项目'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
