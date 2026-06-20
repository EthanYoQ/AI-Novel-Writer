import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LeftToolWindowBar from '../LeftToolWindowBar'

describe('LeftToolWindowBar', () => {
  it('renders visible Chinese labels for every left navigation item', () => {
    const html = renderToString(<LeftToolWindowBar />)

    for (const label of ['首页', '项目', '小说', '蓝图', '角色', '世界', 'AI', '任务', '设置']) {
      expect(html).toContain(label)
    }
  })

  it('does not render old Vela sidebar labels as primary nav labels', () => {
    const html = renderToString(<LeftToolWindowBar />)

    expect(html).not.toContain('项目结构</span>')
    expect(html).not.toContain('知识库</span>')
    expect(html).not.toContain('角色管理</span>')
  })
})
