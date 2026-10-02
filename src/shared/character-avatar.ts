/**
 * 角色自定义头像的跨进程契约。
 *
 * 边界设计（与皮肤资源同源）：
 *   · 图片本体存 <项目>/.vela/avatars/，characters 表只记文件名；
 *   · 渲染层永远不提供路径、也不回写字节 —— 选图只发生在主进程的文件对话框之后；
 *   · 头像不是角色事实：不进角色名单投影哈希，也不被 AI 生成/蓝图同步覆盖。
 */

export type CharacterAvatarErrorCode =
  | 'INVALID_SENDER'
  | 'INVALID_NAME'
  | 'PROJECT_NOT_OPEN'
  | 'CHARACTER_NOT_FOUND'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_FORMAT_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'AVATAR_SAVE_FAILED'

export interface CharacterAvatarError {
  code: CharacterAvatarErrorCode
  message: string
}

/** renderer 可消费的头像载荷：base64 + MIME，转成 Blob URL 后即丢弃。 */
export interface CharacterAvatarView {
  name: string
  mime: string
  base64: string
}

/**
 * 先生（头像逻辑）：头像只能在编辑档案时修改，并且要跟角色卡一起生效。
 * 因此拆成两步，与角色卡的「编辑 → 保存」节奏严格对齐：
 *   choose —— 只打开系统选择器、校验并回传预览字节，**不落盘、不写库**；
 *   commit —— 角色卡保存成功之后才把预览字节落盘并记入角色行。
 * 中途放弃编辑时什么都不会留下，用户不会因为点了一下头像就永久改掉档案。
 */
export type CharacterAvatarChooseResponse =
  | { success: true; cancelled: true }
  | { success: true; cancelled: false; image: CharacterAvatarView }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarCommitResponse =
  | { success: true; avatar: CharacterAvatarView }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarReadResponse =
  | { success: true; avatar: CharacterAvatarView | null }
  | { success: false; error: CharacterAvatarError }

export type CharacterAvatarRemoveResponse =
  | { success: true }
  | { success: false; error: CharacterAvatarError }

/** 单张头像的输入上限；超过即拒绝，避免把项目撑成图片仓库。 */
export const MAX_CHARACTER_AVATAR_INPUT_BYTES = 4 * 1024 * 1024
