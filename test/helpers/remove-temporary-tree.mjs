import fs from 'node:fs'
import path from 'node:path'

const isStrictlyInside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative !== '' && relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative)
}

function detachLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fs.unlinkSync(file)
    else if (entry.isDirectory()) detachLinks(file)
  }
}

/**
 * 删除测试自己建的临时目录树；目标的真实路径必须严格位于 parent 的真实路径之下，否则拒绝删除。
 * 先摘掉树里的符号链接与 junction 再递归删除：用 Electron 作 Node 跑测试时，Electron 41 的
 * fs.rmSync 会跟进 junction 删掉链接目标，曾删光工作树的 electron/ 与部分 node_modules（#449）。
 */
export function removeTemporaryTree(target, parent) {
  if (!fs.existsSync(target)) return
  const realTarget = fs.realpathSync.native(target)
  const realParent = fs.existsSync(parent) ? fs.realpathSync.native(parent) : path.resolve(parent)
  if (!isStrictlyInside(realTarget, realParent)) {
    throw new Error(`Refusing to remove ${path.resolve(target)}: it is not inside ${realParent}`)
  }
  detachLinks(realTarget)
  fs.rmSync(realTarget, { recursive: true, force: true })
}
