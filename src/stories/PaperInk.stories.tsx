import type { Meta, StoryObj } from '@storybook/react' // eslint-disable-line storybook/no-renderer-packages
import { useRef, useState } from 'react'
import { ChevronDown, Ellipsis, Feather, PenLine } from 'lucide-react'
import { actionToast } from '../components/ui/ActionToast'
import { alertError } from '../components/ui/AlertDialog'
import { Button } from '../components/ui/Button'
import { confirm } from '../components/ui/Confirm'
import { Check } from '../components/ui/Check'
import { DangerConfirm } from '../components/ui/DangerConfirm'
import { EmptyState } from '../components/ui/EmptyState'
import { InlineConfirm } from '../components/ui/InlineConfirm'
import { Lifecycle } from '../components/ui/Lifecycle'
import { Menu } from '../components/ui/Menu'
import { Notice } from '../components/ui/Notice'
import { Popover } from '../components/ui/Popover'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Sheet } from '../components/ui/Sheet'
import { StatGrid } from '../components/ui/StatGrid'
import { toast } from '../components/ui/Toast'
import { paperInkFrame } from './paper-ink-frame'

const meta = {
  title: '纸墨/原语',
  decorators: [paperInkFrame],
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const
const column = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 } as const

export const Buttons: Story = {
  render: () => (
    <div style={column}>
      <div style={row}>
        <Button variant="primary">写作此章</Button>
        <Button variant="secondary">重新生成</Button>
        <Button variant="text">稍后</Button>
        <Button variant="danger">删除作品…</Button>
        <Button variant="danger-solid">永久删除</Button>
        <Button variant="icon" aria-label="更多操作"><Ellipsis size={16} aria-hidden /></Button>
      </div>
      <div style={row}>
        <Button variant="primary" size="sm">小号</Button>
        <Button variant="primary" size="lg">大号</Button>
        <Button variant="primary" disabled>不可用</Button>
        <Button variant="secondary" disabled>不可用</Button>
        <Button variant="primary" disabled aria-busy>保存中</Button>
      </div>
      <div style={row}>
        <div className="pi-split">
          <Button variant="primary" className="pi-split-main"><PenLine aria-hidden />写第 3 章</Button>
          <Button variant="primary" className="pi-split-toggle" aria-label="更多写法"><ChevronDown aria-hidden /></Button>
        </div>
        <div className="pi-split pi-split--main-off">
          <Button variant="primary" className="pi-split-main" disabled>按 0 项意见修稿</Button>
          <Button variant="primary" className="pi-split-toggle" aria-label="更多修稿方式"><ChevronDown aria-hidden /></Button>
        </div>
      </div>
    </div>
  ),
}

function SheetDemo() {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState('outline')
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', height: 420 }}>
      <Button variant="secondary" onClick={() => setOpen(true)}>打开侧页</Button>
      <Sheet
        open={open}
        title="第 4 章 · 雨夜车站"
        subtitle="蓝图与写作要求"
        closeLabel="关闭侧页"
        onClose={() => setOpen(false)}
        tabs={{ items: [{ id: 'outline', label: '蓝图' }, { id: 'notes', label: '要求' }], active: tab, onChange: setTab }}
        footer={<Button variant="primary" size="sm">保存</Button>}
      >
        {tab === 'outline' ? '主角在雨夜的车站第三次展开信纸。' : '保持第一人称，结尾留一个悬念。'}
      </Sheet>
    </div>
  )
}

export const SheetPrimitive: Story = { name: 'Sheet', render: () => <SheetDemo /> }

export const MenuInSheet: Story = {
  name: '侧页内的菜单',
  render: () => (
    <div style={{ display: 'flex', height: 360 }}>
      <Sheet open title="第 4 章 · 雨夜车站" subtitle="审稿意见" closeLabel="关闭侧页" onClose={() => {}}>
        {['人物动机前后不一致。', '车站的雨声出现了三次。', '信纸内容提前泄露了结局。'].map((issue) => (
          <p key={issue} style={{ margin: 0 }}>{issue}</p>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
          <Menu
            label="意见操作"
            icon={<Ellipsis size={16} aria-hidden />}
            align="end"
            groups={[
              { id: 'main', items: [{ id: 'apply', label: '按此修稿', onSelect: () => {} }, { id: 'ignore', label: '忽略此条', onSelect: () => {} }] },
              { id: 'danger', tone: 'danger', items: [{ id: 'delete', label: '删除意见…', onSelect: () => {} }] },
            ]}
          />
        </div>
      </Sheet>
    </div>
  ),
}

export const MenuPrimitive: Story = {
  name: 'Menu',
  render: () => (
    <div style={{ height: 300 }}>
      <Menu
        label="作品操作"
        icon={<Ellipsis size={16} aria-hidden />}
        groups={[
          { id: 'main', items: [{ id: 'rename', label: '重命名', onSelect: () => {} }, { id: 'export', label: '导出…', onSelect: () => {} }] },
          { id: 'danger', tone: 'danger', label: '危险操作', items: [{ id: 'delete', label: '删除作品…', onSelect: () => {} }] },
        ]}
      />
    </div>
  ),
}

export const PopoverPrimitive: Story = {
  name: 'Popover',
  render: () => (
    <div style={{ height: 260 }}>
      <Popover label="版本 v3" title="草稿版本">
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>v3 修稿于今天 14:20，比 v2 多 312 字。</p>
      </Popover>
    </div>
  ),
}

function ControlsDemo() {
  const [scope, setScope] = useState<'chapter' | 'book'>('chapter')
  const [checked, setChecked] = useState(true)
  const [autoSave, setAutoSave] = useState(false)
  return (
    <div style={{ ...column, alignItems: 'flex-start' }}>
      <SegmentedControl
        label="审稿范围"
        options={[{ value: 'chapter', label: '本章' }, { value: 'book', label: '全书' }]}
        value={scope}
        onChange={setScope}
      />
      <Check checked={checked} onChange={setChecked} label="同时检查人物一致性" />
      <Check kind="switch" checked={autoSave} onChange={setAutoSave} label="自动保存" />
    </div>
  )
}

export const Controls: Story = { render: () => <ControlsDemo /> }

export const Stats: Story = {
  render: () => (
    <div style={column}>
      <StatGrid
        label="作品统计"
        items={[
          { id: 'chapters', label: '已定稿章节', value: '12' },
          { id: 'words', label: '总字数', value: '86,400' },
          { id: 'issues', label: '待处理意见', value: '3', hint: '来自第 4 章审稿' },
        ]}
      />
      <Lifecycle label="第 4 章进度" steps={['写作', '审稿', '修稿', '定稿']} current={2} />
    </div>
  ),
}

function NoticesDemo() {
  const [confirming, setConfirming] = useState(true)
  const clearButton = useRef<HTMLButtonElement>(null)
  return (
    <div style={column}>
      <Notice title="继续上次的写作" actions={<Button variant="secondary" size="sm">继续</Button>}>第 4 章停在第 3 段。</Notice>
      <Notice tone="ok" title="第 3 章已定稿" />
      <Notice tone="warn" title="有 2 处与设定冲突">可在审稿报告中逐条处理。</Notice>
      <Notice tone="warn" title="有 1 份修稿不能再合并" actions={<><Button variant="secondary" size="sm">查看修稿</Button><Button variant="danger" size="sm">丢弃…</Button></>}>
        修稿生成之后正文又改过，合并会覆盖这些修改。
      </Notice>
      <Notice tone="danger" title="第 3 章审稿失败">模型连接超时，已保留草稿，未丢失任何内容。</Notice>
      {confirming
        ? <InlineConfirm message="清空后无法恢复这 12 条日志。" confirmLabel="清空" cancelLabel="取消" onConfirm={() => setConfirming(false)} onCancel={() => setConfirming(false)} returnFocusRef={clearButton} />
        : <Button ref={clearButton} variant="text" onClick={() => setConfirming(true)}>清空日志…</Button>}
    </div>
  )
}

export const Notices: Story = { render: () => <NoticesDemo /> }

function DangerDemo() {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ minHeight: 420 }}>
      <Button variant="danger" onClick={() => setOpen(true)}>删除作品…</Button>
      <DangerConfirm
        open={open}
        onOpenChange={setOpen}
        title="删除《灯塔》"
        consequence="将删除全部章节、蓝图、设定与审稿记录。"
        recoverability="删除后无法恢复，已有的项目备份不受影响。"
        confirmLabel="永久删除"
        cancelLabel="取消"
        onConfirm={() => {}}
        typeToConfirm={{ expected: '灯塔', label: '输入作品名「灯塔」以确认' }}
      />
    </div>
  )
}

export const Danger: Story = { render: () => <DangerDemo /> }

/** 命令式弹窗与提示栈走纸墨宿主。 */
function OverlaysDemo() {
  return (
    <div style={row}>
      <Button variant="secondary" onClick={() => { void alertError('不是有效的项目目录。\n\n请重新选择。', { title: '打开项目失败' }) }}>错误弹框</Button>
      <Button variant="secondary" onClick={() => { void confirm('将删除第 3 章的定稿正文。删除后无法恢复。', { title: '删除定稿正文？', confirmText: '删除', danger: true }) }}>危险确认</Button>
      <Button variant="secondary" onClick={() => {
        toast.success('第 3 章已定稿\n\n正文已写入作品目录。')
        actionToast.show({ type: 'error', message: '第 3 章审稿失败\n\n模型连接超时，已保留草稿。', actions: [{ label: '查看' }, { label: '忽略', variant: 'ghost' }] })
        toast.warning('字数超出限制')
      }}>提示栈</Button>
    </div>
  )
}

export const Overlays: Story = { render: () => <OverlaysDemo /> }

export const Empty: Story = {
  render: () => (
    <EmptyState
      icon={<Feather aria-hidden />}
      heading="还没有作品"
      description="从一个前提开始，后面的角色、世界观与章节蓝图会一步步生成。"
      action={<Button variant="primary">新建作品</Button>}
    />
  ),
}

export const Typography: Story = {
  render: () => (
    <div style={column}>
      <span className="pi-num" style={{ fontSize: 56, lineHeight: 0.9 }}>3</span>
      <h1 className="pi-display" style={{ margin: 0, fontSize: 30 }}>雨夜车站</h1>
      <p style={{ margin: 0, font: 'var(--prose-size)/var(--prose-lh) var(--font-prose)', textIndent: '2em' }}>他第三次展开信纸。字迹很淡，只有一行。</p>
    </div>
  ),
}
