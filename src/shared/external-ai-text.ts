/**
 * 外部 AI 代劳用到的纯文本处理 —— 与界面无关，所以不放在组件里。
 */

/**
 * 剥掉整段的 Markdown 代码块围栏。
 *
 * 修稿时我们明确要求对方把正文放进 ``` 里，先生复制时常把围栏一起带走 ——
 * 直接写进编辑器就会多出三个反引号。只处理「整段被一个围栏包住」的情况，
 * 正文内部的代码块原样保留。
 */
export function stripCodeFence(value: string): string {
  const fenced = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n?```\s*$/u.exec(value)
  return (fenced?.[1] ?? value).trim()
}
