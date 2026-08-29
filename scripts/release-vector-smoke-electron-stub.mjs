export const app = Object.freeze({
  getPath() {
    throw new Error('Packaged vector smoke must not access Electron application paths')
  },
})
