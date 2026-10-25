import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog },
}))

let fixtureRoot = ''
let configPath = ''
let picker: typeof import('../remembered-dialog')

async function restartMainProcess() {
  vi.resetModules()
  const dataRoot = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  configPath = path.join(dataRoot, 'config.json')
  picker = await import('../remembered-dialog')
}

function directory(name: string): string {
  const created = path.join(fixtureRoot, 'user', name)
  fs.mkdirSync(created, { recursive: true })
  return created
}

function lastOptions(mock: typeof mocks.showOpenDialog) {
  return mock.mock.calls.at(-1)?.[0] as { defaultPath?: string } | undefined
}

beforeEach(async () => {
  mocks.showOpenDialog.mockReset()
  mocks.showSaveDialog.mockReset()
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-remembered-dialog-'))
  await restartMainProcess()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('file dialogs reopen in the directory used last time', () => {
  it('reopens a file picker in the folder of the chosen file, also after a restart', async () => {
    const novels = directory('novels')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(novels, 'draft.txt')] })

    await picker.showOpenDialogInLastDirectory('import-source', { properties: ['openFile'] })
    expect(lastOptions(mocks.showOpenDialog)).not.toHaveProperty('defaultPath')

    await restartMainProcess()
    await picker.showOpenDialogInLastDirectory('import-source', { properties: ['openFile'] })
    expect(lastOptions(mocks.showOpenDialog)).toMatchObject({ defaultPath: novels })
  })

  it('reopens a folder picker in the chosen folder itself', async () => {
    const projects = directory('projects')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [projects] })

    await picker.showOpenDialogInLastDirectory('project-create', { properties: ['openDirectory'] })
    await picker.showOpenDialogInLastDirectory('project-create', { properties: ['openDirectory'] })

    expect(lastOptions(mocks.showOpenDialog)).toMatchObject({ defaultPath: projects })
  })

  it('keeps each kind of dialog separate', async () => {
    const avatars = directory('avatars')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(avatars, 'face.png')] })

    await picker.showOpenDialogInLastDirectory('character-avatar', { properties: ['openFile'] })
    await picker.showOpenDialogInLastDirectory('knowledge-files', { properties: ['openFile'] })

    expect(lastOptions(mocks.showOpenDialog)).not.toHaveProperty('defaultPath')
  })

  it('puts the suggested file name inside the last save folder', async () => {
    const backups = directory('backups')
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(backups, 'first.ainovel') })

    await picker.showSaveDialogInLastDirectory('project-archive', { defaultPath: 'first.ainovel' })
    await picker.showSaveDialogInLastDirectory('project-archive', { defaultPath: 'second.ainovel' })

    expect(lastOptions(mocks.showSaveDialog)).toMatchObject({ defaultPath: path.join(backups, 'second.ainovel') })
  })

  it('falls back to the system default when the remembered folder is gone', async () => {
    const removed = directory('removed')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [removed] })
    await picker.showOpenDialogInLastDirectory('export-directory', { properties: ['openDirectory'] })
    fs.rmSync(removed, { recursive: true })

    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await picker.showOpenDialogInLastDirectory('export-directory', { properties: ['openDirectory'] })

    expect(lastOptions(mocks.showOpenDialog)).not.toHaveProperty('defaultPath')
  })

  it('remembers nothing when the dialog is cancelled', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await picker.showOpenDialogInLastDirectory('legacy-project', { properties: ['openDirectory'] })

    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('still returns the selection and leaves a damaged config untouched', async () => {
    fs.writeFileSync(configPath, '{BROKEN')
    const chosen = directory('chosen')
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [chosen] })

    const result = await picker.showOpenDialogInLastDirectory('knowledge-folder', { properties: ['openDirectory'] })

    expect(result).toEqual({ canceled: false, filePaths: [chosen] })
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{BROKEN')
  })
})

it('every main-process file picker goes through the remembering helper', () => {
  const electronRoot = path.resolve('electron')
  const direct = fs.readdirSync(electronRoot, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts') && !file.split(path.sep).includes('__tests__'))
    .filter(file => path.join(electronRoot, file) !== path.join(electronRoot, 'utils', 'remembered-dialog.ts'))
    .filter(file => /\bdialog\.show(?:Open|Save)Dialog\(/.test(fs.readFileSync(path.join(electronRoot, file), 'utf8')))

  expect(direct).toEqual([])
})
