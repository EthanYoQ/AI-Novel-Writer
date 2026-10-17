/// <reference types="@vitest/browser-playwright" />
import { cdp } from 'vitest/browser'

/**
 * 在「减少动态效果」下跑一段断言，跑完复位成 Playwright 默认的 no-preference。
 * 不能用空的 features 复位：那会退回系统设置，CI 的 Windows Server 关了动画，同一页里之后的用例都会变成减少动态效果。
 */
export async function withReducedMotion(run: () => Promise<void>) {
  const session = cdp()
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    await run()
  } finally {
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  }
}
