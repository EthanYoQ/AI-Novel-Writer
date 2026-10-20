import fs from 'node:fs'
import path from 'node:path'

const isStrictlyInside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 删除测试自己建的临时目录树；目标必须严格位于 parent 之下，否则拒绝删除。 */
export function removeTemporaryTree(target, parent) {
  const resolved = path.resolve(target)
  if (!isStrictlyInside(resolved, path.resolve(parent))) {
    throw new Error(`Refusing to remove ${resolved}: it is not inside ${path.resolve(parent)}`)
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
