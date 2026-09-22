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
  if (!ok) return

  if (await useProjectStore.getState().deleteProject(project.path)) {
    toast.success(text(`项目「${project.name}」已删除`, `Project “${project.name}” deleted`))
  }
}
