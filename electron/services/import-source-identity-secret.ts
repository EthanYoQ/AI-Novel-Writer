import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const SECRET_BYTES = 32
const SECRET_FILE_NAME = 'import-source-identity.secret'

function readValidSecret(secretPath: string): Buffer {
  const secret = fs.readFileSync(secretPath)
  if (secret.byteLength !== SECRET_BYTES) throw new Error('导入来源应用密钥损坏')
  return secret
}

/** Application-level HMAC key. The project DB never receives this value. */
export function loadApplicationImportSourceSecret(): Buffer {
  const secretPath = path.join(app.getPath('userData'), SECRET_FILE_NAME)
  try {
    return readValidSecret(secretPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const secret = randomBytes(SECRET_BYTES)
  try {
    fs.writeFileSync(secretPath, secret, { flag: 'wx', mode: 0o600 })
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readValidSecret(secretPath)
  }
}
