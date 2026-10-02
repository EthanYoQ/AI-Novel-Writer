import { useState, useEffect } from 'react'
import { FolderOpen, Sparkles } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '../ui/Dialog'
import PageHead from '../ui/PageHead'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { useLocaleStore } from '../../stores/locale-store'

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
  const { locale, text } = useLocaleStore()

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
      writingLanguage: locale,
    })
    setCreating(false)
    if (success) {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-[420px]"
        /* 先生：作品名与保存位置填到一半，误点蒙版关掉就得重填。 */
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {/*
          先生：这类弹出来的子菜单要有统一规范与设计美感 —— 标头沿用各子菜单页头
          （PageHead）那套语言：朱砂小字眉标 → 衬线标题 → 次要色说明。
          DialogTitle 保留为 sr-only，无障碍名称不至于丢。
        */}
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">{text('新建小说项目', 'New novel project')}</DialogTitle>
          <PageHead
            kicker={text('NEW PROJECT · 新建项目', 'NEW PROJECT')}
            title={text('新建小说项目', 'New novel project')}
            description={text('填写作品名称和保存位置，其余配置在项目内完成。', 'Enter a title and save location; configure the rest inside the project.')}
          />
        </DialogHeader>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-4">
          {/* 项目名称 */}
          <div>
            <Label>{text('作品名称', 'Title')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={text('如：斗破苍穹', 'e.g. The Glass Observatory')}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          {/* 保存路径 */}
          <div>
            <Label>{text('保存位置', 'Save location')}</Label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={text('选择项目保存目录', 'Choose a project folder')}
                className="flex-1"
              />
              <Button variant="outline" onClick={handleSelectFolder}>
                <FolderOpen size={14} />
                {text('选择', 'Choose')}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim() || !path.trim()}
          >
            <Sparkles size={14} />
            {creating ? text('创建中...', 'Creating...') : text('创建项目', 'Create project')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
