import assert from 'node:assert/strict'

/** Synthetic fixture setup only: production chooser issues the grant through the same renderer. */
export async function chooseProjectDirectoryGrant(app, page, directory, purpose = 'project-create') {
  await app.evaluate(({ dialog }, selectedPath) => {
    globalThis.__projectDirectoryDialogOriginal = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, directory)
  try {
    const grant = await page.evaluate(pickerPurpose => window.aiNovelAPI.invoke('dialog:select-folder', pickerPurpose), purpose)
    assert.equal(typeof grant?.grantId, 'string', 'project directory chooser did not issue a grant')
    return grant
  } finally {
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__projectDirectoryDialogOriginal
      delete globalThis.__projectDirectoryDialogOriginal
    })
  }
}
