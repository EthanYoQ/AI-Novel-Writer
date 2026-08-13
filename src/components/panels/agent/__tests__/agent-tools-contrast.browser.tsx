import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/agent-tools.css'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => container.remove())

describe('Agent tool information text contrast', () => {
  it.each([
    ['light', 'rgb(56, 96, 66)', 'rgb(143, 48, 32)', 'rgb(122, 84, 20)', 'rgb(43, 42, 38)', 'rgb(82, 122, 91)', 'rgb(181, 64, 44)', 'rgb(198, 138, 58)', 'rgb(255, 255, 255)'],
    ['paper', 'rgb(56, 96, 66)', 'rgb(143, 48, 32)', 'rgb(122, 84, 20)', 'rgb(43, 42, 38)', 'rgb(82, 122, 91)', 'rgb(181, 64, 44)', 'rgb(198, 138, 58)', 'rgb(255, 255, 255)'],
    ['galaxy', 'rgb(74, 222, 128)', 'rgb(251, 113, 133)', 'rgb(251, 191, 36)', 'rgb(224, 236, 244)', 'rgb(74, 222, 128)', 'rgb(251, 113, 133)', 'rgb(251, 191, 36)', 'rgb(10, 22, 40)'],
    ['dark', 'rgb(137, 209, 133)', 'rgb(255, 138, 138)', 'rgb(204, 167, 0)', 'rgb(212, 212, 212)', 'rgb(137, 209, 133)', 'rgb(241, 76, 76)', 'rgb(204, 167, 0)', 'rgb(24, 24, 24)'],
  ])('uses readable semantic copy while retaining decorative status icons in %s', (theme, successText, errorText, warningText, ordinaryText, successDecoration, errorDecoration, warningDecoration, successForeground) => {
    container.className = theme
    container.innerHTML = `
      <div class="tool-call-header">
        <span class="tool-call-source-badge builtin">Built-in</span>
        <span class="tool-call-source-badge mcp">MCP</span>
        <span class="tool-call-source-badge skill">Skill</span>
        <div class="tool-call-status"><svg class="tool-call-status completed"></svg><span>Completed</span></div>
        <div class="tool-call-status"><svg class="tool-call-status failed"></svg><span>Failed</span></div>
        <div class="tool-call-status"><svg class="tool-call-status waiting_confirm"></svg><span>Waiting</span></div>
        <button class="confirm-card-btn approve">Approve</button>
      </div>
    `

    const color = (selector: string) => getComputedStyle(container.querySelector(selector)!).color
    expect(color('.tool-call-source-badge.builtin')).toBe(ordinaryText)
    expect(color('.tool-call-source-badge.mcp')).toBe(ordinaryText)
    expect(color('.tool-call-source-badge.skill')).toBe(successText)
    expect(color('.tool-call-status:has(> .completed) > span')).toBe(successText)
    expect(color('.tool-call-status:has(> .failed) > span')).toBe(errorText)
    expect(color('.tool-call-status:has(> .waiting_confirm) > span')).toBe(warningText)

    expect(color('svg.completed')).toBe(successDecoration)
    expect(color('svg.failed')).toBe(errorDecoration)
    expect(color('svg.waiting_confirm')).toBe(warningDecoration)
    expect(color('.confirm-card-btn.approve')).toBe(successForeground)
  })
})
