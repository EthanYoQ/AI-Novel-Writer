/**
 * ConfirmCard — 操作确认卡片
 *
 * 当 Agent 调用需要确认的 Tool 时显示此卡片。
 * 用户可以批准或拒绝操作。
 */
import { ShieldAlert } from 'lucide-react'
import type { ToolCallInfo } from '../../../services/agent/agent-engine'
import { useAgentStore } from '../../../stores/agent-store'
import { useLocaleStore } from '../../../stores/locale-store'
import DomainProposalDiff, { useDomainProposalPreview } from './DomainProposalDiff'

interface Props {
  toolCall: ToolCallInfo
}

export default function ConfirmCard({ toolCall }: Props) {
  const { resolveToolConfirmation, cancelGeneration } = useAgentStore()
  const text = useLocaleStore(s => s.text)
  const { id, toolName, arguments: args } = toolCall
  const proposalPreview = useDomainProposalPreview(toolCall)
  const isDomainProposal = proposalPreview.kind !== 'none'
  const canApprove = !isDomainProposal || proposalPreview.kind === 'valid'

  // 生成操作描述
  const description = generateDescription(toolName, args, text)

  return (
    <div className="confirm-card">
      {/* 头部 */}
      <div className="confirm-card-header">
        <ShieldAlert size={14} />
        <span>{text('需要确认操作', 'Confirmation required')}</span>
      </div>

      {/* 内容 */}
      <div className="confirm-card-body">
        <div>{description}</div>
        <DomainProposalDiff toolCall={toolCall} preview={proposalPreview} />
        {!isDomainProposal && Object.keys(args).length > 0 && (
          <div
            style={{
              marginTop: 6,
              padding: '4px 8px',
              borderRadius: 4,
              backgroundColor: 'var(--color-hover)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.68rem',
              color: 'var(--color-text-secondary)',
              whiteSpace: 'pre-wrap',
              maxHeight: 120,
              overflowY: 'auto',
            }}
          >
            {JSON.stringify(args, null, 2)}
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="confirm-card-actions">
        {isDomainProposal && (
          <button
            className="confirm-card-btn reject"
            onClick={() => void cancelGeneration()}
          >
            {text('取消本次助手任务', 'Cancel this Agent task')}
          </button>
        )}
        <button
          className="confirm-card-btn reject"
          onClick={() => resolveToolConfirmation(id, false)}
        >
          {text('拒绝', 'Reject')}
        </button>
        <button
          className="confirm-card-btn approve"
          disabled={!canApprove}
          onClick={() => resolveToolConfirmation(id, true)}
        >
          {text('批准执行', 'Approve')}
        </button>
      </div>
    </div>
  )
}

/** 根据 Tool 名称生成人类可读的操作描述 */
function generateDescription(
  toolName: string,
  args: Record<string, unknown>,
  text: ReturnType<typeof useLocaleStore.getState>['text'],
): string {
  switch (toolName) {
    case 'write_file':
      return `将写入文件：${args.file_path ?? '未知路径'}`
    case 'open_editor':
      return `将在编辑器中打开：${args.file_path ?? '未知文件'}`
    case 'start_workflow':
      return `将启动工作流：${args.workflow ?? '未知工作流'}${args.chapter_number ? `（第 ${args.chapter_number} 章）` : ''}`
    case 'propose_novel_config':
      return text('小说配置变更提案', 'Novel configuration change proposal')
    case 'propose_chapter_blueprint':
      return text(
        `第 ${args.chapter_number ?? '？'} 章蓝图变更提案`,
        `Chapter ${args.chapter_number ?? '?'} blueprint change proposal`,
      )
    default:
      return `将执行操作：${toolName}`
  }
}
