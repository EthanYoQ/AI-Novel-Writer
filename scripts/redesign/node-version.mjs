/**
 * 驱动的场景模块直接 import 应用里的 .ts，靠 Node 自带的类型剥离。看 process.features.typescript 而不是版本号：
 * 22.18、23.6 起默认开启，但 --no-experimental-strip-types 能关掉它；22.10 之前没有这个字段。
 */
export function assertNodeRunsTypeScript(version, typescript) {
  if (typescript) return
  throw new Error(`驱动脚本直接 import 应用里的 .ts，需要 Node 自带的类型剥离（Node 22.18、23.6 起默认开启，不能用 --no-experimental-strip-types 关掉），当前 ${version} 没有开启。可以用 fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs …`)
}
