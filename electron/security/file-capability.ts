import type { SecureFileCapability } from './windows-safe-file-system'

/** Derive a child without resolving through the ambient filesystem. */
export function childFileCapability(
  parent: SecureFileCapability,
  name: string,
): SecureFileCapability {
  return {
    rootPath: parent.rootPath,
    relativePath: parent.relativePath ? `${parent.relativePath}\\${name}` : name,
    rootIdentity: parent.rootIdentity,
  }
}
