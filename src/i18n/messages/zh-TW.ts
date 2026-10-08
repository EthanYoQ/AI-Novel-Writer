import { zhCN } from './zh-CN'
import { toTraditionalChinese } from '../../shared/traditional-chinese'
import type { MessageKey } from './en-US'

// Shared keyed copy and colocated copy use the same Taiwan conversion rules.
export const zhTW = Object.fromEntries(
  Object.entries(zhCN).map(([key, value]) => [key, toTraditionalChinese(value)]),
) as Record<MessageKey, string>
