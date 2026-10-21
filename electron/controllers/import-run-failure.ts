import { app } from 'electron'
import { knownAppErrorMessage } from '../../src/i18n/app-errors'
import { resolveLocale, translate } from '../../src/i18n/core'
import type { Locale } from '../../src/i18n/types'
import { getMainLocale } from '../i18n'
import { ImportRunRepository } from '../repositories/import-run-repository'

const IPC_PREFIX = /^Error invoking remote method '[^']+': /u
const CLASS_PREFIX = /^[A-Za-z]*Error: /u
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/u
/** 导入运行、导入来源、检查与收据的完整性校验码：没有作者能照做的建议，说明里附上码供反馈定位。 */
const IMPORT_CHECK_CODE = /^(?:IMPORT_RUN|IMPORT_GLOBAL_FACTS|FINALIZED_IMPORT|IMPORT_SOURCE|IMPORT_INSPECTION)_/u

export interface ImportRunFailure {
  error: string
  errorCode: string
}

function rawReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().replace(IPC_PREFIX, '').replace(CLASS_PREFIX, '')
}

/**
 * 导入对话框与导入运行卡片原样显示主进程交来的 error，失败原因还会存进导入运行的 last_error 供以后显示（#474）。
 * 所以在 IPC 边界按导入运行的界面语言写成说明：登记过的码用 app-errors 的文案，导入的完整性校验码给带码的通用说明，
 * 原码放在 errorCode。认不出的（已按语言写好的说明、其他未登记的码）返回 undefined，由调用方照旧交出。
 * 语言可以传函数，只在认出码时才去查，免得查语言本身的失败盖住原来的报错。
 */
export function explainImportRunFailure(error: unknown, locale: Locale | (() => Locale)): ImportRunFailure | undefined {
  const code = rawReason(error)
  if (!ERROR_CODE.test(code) || !(isKnownAppErrorCode(code) || IMPORT_CHECK_CODE.test(code))) return undefined
  const resolved = typeof locale === 'function' ? locale() : locale
  return {
    error: knownAppErrorMessage(resolved, code) ?? translate(resolved, 'error.importRunCheckFailed', { code }),
    errorCode: code,
  }
}

function isKnownAppErrorCode(code: string): boolean {
  return knownAppErrorMessage('zh-CN', code) !== undefined
}

/** 存进 last_error 的失败原因：去掉 Electron 的调用通道与错误类名前缀，认得出的码换成说明。 */
export function persistedImportRunFailure(reason: string, locale: Locale | (() => Locale)): string {
  return explainImportRunFailure(reason, locale)?.error ?? rawReason(reason)
}

/** 说明用的语言：请求自带的导入语言优先，其次是导入运行记下的语言，都没有时用应用界面语言。 */
export function importRunLocale(runId?: unknown, requestedLocale?: unknown): Locale {
  if (requestedLocale === 'zh-CN' || requestedLocale === 'en-US') return requestedLocale
  if (typeof runId === 'string') {
    try {
      const locale = ImportRunRepository.get(runId)?.locale
      if (locale) return locale
    } catch {
      // 项目数据库已关闭或运行记录读不出时只是拿不到运行语言，退回界面语言。
    }
  }
  try {
    return getMainLocale(app.getLocale())
  } catch {
    // 全局设置还读不出来时按系统语言说明，不让查语言的失败盖住导入本身的报错。
    return resolveLocale(app.getLocale())
  }
}
