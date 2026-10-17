import { useEffect, useState } from 'react'
import type { ProjectDirectoryGrant } from '../../shared/ipc-channels'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'

/** 新建作品：名称与保存位置，创建后其余设定在设定页填写。 */
export function useNewProjectForm(open: boolean, onClose: () => void) {
  const createProject = useProjectStore((s) => s.createProject)
  const locale = useLocaleStore(s => s.locale)
  const [name, setName] = useState('')
  const [path, setPath] = useState<ProjectDirectoryGrant | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    let mounted = true
    Promise.resolve().then(() => {
      if (mounted) { setName(''); setPath(null) }
    })
    return () => { mounted = false }
  }, [open])

  const selectFolder = async () => {
    const selected = await ipc.invoke('dialog:select-folder', 'project-create')
    if (selected) setPath(selected)
  }

  /** 类型与目标读者留空，在设定页填写。 */
  const create = async () => {
    if (!name.trim() || !path) return
    setCreating(true)
    const success = await createProject({
      name: name.trim(),
      parentGrantId: path.grantId,
      genre: '',
      targetAudience: '',
      writingLanguage: locale,
    })
    setPath(null)
    setCreating(false)
    if (success) onClose()
  }

  return { name, setName, path, selectFolder, creating, canCreate: !creating && Boolean(name.trim()) && path !== null, create }
}
