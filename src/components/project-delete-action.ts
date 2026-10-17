import { useLocaleStore } from '../stores/locale-store'
import { useProjectStore } from '../stores/project-store'
import { confirm } from './ui/Confirm'
import { toast } from './ui/Toast'

/** Shared confirmation for the sidebar and V3 home; the store enforces current-project authority. */
export async function confirmDeleteCurrentProject(project: { name: string; path: string }) {
  const text = useLocaleStore.getState().text
  const ok = await confirm(
    text(`确认删除项目「${project.name}」？\n此操作会删除该项目目录下的小说正文、故事架构、角色、蓝图、知识库和所有项目数据。`, `Delete project “${project.name}”?\nThis removes its manuscripts, architecture, characters, blueprints, knowledge base, and all project data.`),
    {
      title: text('删除项目', 'Delete project'),
      confirmText: text('删除项目', 'Delete project'),
      danger: true,
    },
  )
  if (ok) await deleteCurrentProject(project)
}

/** 确认之后的删除；书房先用危险确认（输入作品名），之后走这里。 */
export async function deleteCurrentProject(project: { name: string; path: string }) {
  const text = useLocaleStore.getState().text
  if (await useProjectStore.getState().deleteProject(project.path)) {
    toast.success(text(`项目「${project.name}」已删除`, `Project “${project.name}” deleted`))
  }
}

export async function confirmRemoveRecentProject(project: { name: string; path: string }) {
  const text = useLocaleStore.getState().text
  const ok = await confirm(
    text(
      `确认从最近项目中移除「${project.name}」？\n这只会移除列表记录，不会删除项目文件。`,
      `Remove “${project.name}” from recent projects?\nThis only removes the list entry and does not delete project files.`,
    ),
    {
      title: text('从最近项目移除', 'Remove from recent projects'),
      confirmText: text('移除记录', 'Remove entry'),
    },
  )
  if (ok) await removeRecentProject(project)
}

export async function removeRecentProject(project: { name: string; path: string }) {
  const text = useLocaleStore.getState().text
  if (await useProjectStore.getState().removeRecentProject(project.path)) {
    toast.success(text(`已从最近项目移除「${project.name}」`, `Removed “${project.name}” from recent projects`))
  }
}
