export const app = Object.freeze({
  getPath() {
    throw new Error('Packaged vector smoke must not access Electron application paths')
  },
})

export const nativeImage = Object.freeze({
  createFromBuffer() {
    throw new Error('Packaged vector smoke does not support Electron avatar compression')
  },
})
