import fs from 'node:fs'
import path from 'node:path'

const isStrictlyInside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function detachLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fs.unlinkSync(file)
    else if (entry.isDirectory()) detachLinks(file)
  }
}

/**
 * 删除测试自己建的临时目录树；目标必须严格位于 parent 之下，否则拒绝删除。
 * 先摘掉树里的符号链接与 junction 再递归删除：用 Electron 作 Node 跑测试时，Electron 41 的
 * fs.rmSync 会跟进 junction 删掉链接目标，曾删光工作树的 electron/ 与部分 node_modules（#449）。
 */
export function removeTemporaryTree(target, parent) {
  const resolved = path.resolve(target)
  if (!isStrictlyInside(resolved, path.resolve(parent))) {
    throw new Error(`Refusing to remove ${resolved}: it is not inside ${path.resolve(parent)}`)
  }
  if (!fs.existsSync(resolved)) return
  detachLinks(resolved)
  fs.rmSync(resolved, { recursive: true, force: true })
}
