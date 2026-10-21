import type { ReactNode } from 'react'

/** 把查找词在片段里标出来；按空白切成多个词，各自标记。 */
export function highlight(snippet: string, query: string): ReactNode[] {
  const terms = query.split(/\s+/).filter(Boolean).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (terms.length === 0) return [snippet]
  const pattern = new RegExp(`(${terms.join('|')})`, 'gi')
  return snippet.split(pattern).map((part, index) => index % 2 === 1 ? <mark key={index}>{part}</mark> : part)
}
