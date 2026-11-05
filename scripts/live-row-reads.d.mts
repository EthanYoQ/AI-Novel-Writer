export const LIVE_ROW_TABLES: readonly string[]
export const RAW_ROW_READERS: Readonly<Record<string, string>>
export const LIVE_ROW_EXEMPT_TABLES: Readonly<Record<string, string>>
export interface LiveRowRead { line: number; table: string; offset: number; replacement: string }
export function scanSource(text: string, fileName?: string): LiveRowRead[]
export function rewriteSource(text: string, fileName?: string): string
export function listSourceFiles(root?: string): string[]
export function scanLiveRowReads(root?: string): Array<{ file: string; line: number; table: string }>
