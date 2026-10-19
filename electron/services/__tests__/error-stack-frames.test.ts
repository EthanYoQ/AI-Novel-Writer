import { describe, expect, it } from 'vitest'
import { errorStackFrames } from '../error-stack-frames'

describe('errorStackFrames', () => {
  it('不把消息里以 at 开头的行当成栈帧', () => {
    const error = new TypeError('坏收据\n    at 第二行正文不该进日志\nat 第三行也不行')
    const frames = errorStackFrames(error, 7)!
    expect(frames).toBeTruthy()
    expect(frames).not.toContain('正文')
    expect(frames).not.toContain('第三行')
    expect(frames.split('\n').every(line => /^\s+at /u.test(line))).toBe(true)
  })

  it('子类改过 name 时也能去掉头部', () => {
    class ReceiptError extends Error {
      constructor(message: string) { super(message); this.name = 'ReceiptError' }
    }
    const frames = errorStackFrames(new ReceiptError('x\n    at 正文'), 3)!
    expect(frames).not.toContain('正文')
    expect(frames.split('\n')).toHaveLength(3)
  })

  it('stack 头部与当前消息对不上时不记栈', () => {
    const error = new Error('原消息')
    void error.stack
    error.message = '改过的消息\n    at 正文'
    expect(errorStackFrames(error, 7)).toBeUndefined()
    const bare = new Error('无栈')
    bare.stack = undefined
    expect(errorStackFrames(bare, 7)).toBeUndefined()
  })
})
