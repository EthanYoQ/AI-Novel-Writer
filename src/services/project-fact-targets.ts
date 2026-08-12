export type ProjectFactWorkflow = 'generate_architecture' | 'generate_blueprint'

/**
 * Canonical filenames whose meaning belongs to structured project facts.
 * Generic file writes must never create a second, Markdown-shaped fact source.
 */
export const PROJECT_FACT_TARGETS = Object.freeze([
  { fact: 'premise', workflow: 'generate_architecture', fileNames: ['故事前提.md', 'premise.md'] },
  { fact: 'worldbuilding', workflow: 'generate_architecture', fileNames: ['世界观.md', 'worldbuilding.md'] },
  { fact: 'characters', workflow: 'generate_architecture', fileNames: ['角色图谱.md', '角色名单.md', '角色.md', 'characters.md', 'character.md', 'character-roster.md', 'character_roster.md'] },
  { fact: 'synopsis', workflow: 'generate_architecture', fileNames: ['情节大纲.md', '剧情大纲.md', 'synopsis.md'] },
  { fact: 'blueprints', workflow: 'generate_blueprint', fileNames: ['章节蓝图.md', '蓝图.md', 'blueprints.md', 'blueprint.md', 'chapter-blueprint.md', 'chapter_blueprint.md', 'directory.json'] },
] as const)

const targetWorkflowByFileName = new Map<string, ProjectFactWorkflow>(
  PROJECT_FACT_TARGETS.flatMap(target => target.fileNames.map(fileName => (
    [fileName.toLocaleLowerCase('zh-CN'), target.workflow] as const
  ))),
)

export function projectFactWorkflowForFilePath(filePath: string): ProjectFactWorkflow | undefined {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase('zh-CN')
  return targetWorkflowByFileName.get(normalized.split('/').at(-1) ?? '')
}
