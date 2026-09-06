/**
 * 单条消息渲染组件（升级版）
 *
 * 支持三种渲染模式：
 * - 用户消息：右对齐气泡
 * - 助手消息：左侧 Markdown 风格渲染
 * - Tool 调用：ToolCallBlock / ConfirmCard / ArtifactCard
 */
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { AgentMessage as AgentMessageType } from '../../../stores/agent-store'
import { useLocaleStore } from '../../../stores/locale-store'
import MarkdownContent, { StreamingCursor } from '../../ui/MarkdownContent'
import ToolCallBlock from './ToolCallBlock'
import ConfirmCard from './ConfirmCard'
import ArtifactCard from './ArtifactCard'
import '../../../styles/agent-tools.css'

interface Props {
  message: AgentMessageType
}

export default function AgentMessage({ message }: Props) {
  const { role, content, streaming, toolCalls, artifacts } = message
  const text = useLocaleStore(state => state.text)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  const copyButton = (
    <>
      <button
        type="button"
        aria-label={text('复制消息', 'Copy message')}
        title={copyState === 'copied'
          ? text('已复制', 'Copied')
          : text('复制消息', 'Copy message')}
        disabled={!content || streaming}
        onClick={() => void copyMessage()}
        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
        style={{ color: 'var(--color-text-muted)', background: 'var(--color-hover)' }}
      >
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {copyState === 'failed' && <span role="alert" className="sr-only">{text('无法复制这条消息', 'Could not copy this message')}</span>}
    </>
  )

  if (role === 'user') {
    return (
      <div className="group relative flex justify-end mb-2">
        <div
          className="max-w-[88%] px-3 py-2 rounded-2xl text-xs leading-relaxed break-words whitespace-pre-wrap"
          style={{
            backgroundColor: 'rgba(var(--color-accent-rgb), 0.12)',
            border: '1px solid rgba(var(--color-accent-rgb), 0.2)',
            color: 'var(--color-text)',
          }}
        >
          {content}
        </div>
        {copyButton}
      </div>
    )
  }

  // 助手消息
  return (
    <div className="group relative flex justify-start mb-2">
      <div
        className="max-w-full text-xs leading-relaxed break-words w-full"
        style={{ color: 'var(--color-text)' }}
      >
        {/* 文本内容 */}
        {content ? (
          <MarkdownContent content={content} streaming={streaming} />
        ) : streaming ? (
          <span className="inline-flex items-center h-4">
            <StreamingCursor />
          </span>
        ) : null}

        {/* Tool 调用区块列表 */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="mt-2">
            {toolCalls.map(tc => (
              tc.status === 'waiting_confirm' ? (
                <ConfirmCard key={tc.id} toolCall={tc} />
              ) : (
                <ToolCallBlock key={tc.id} toolCall={tc} />
              )
            ))}
          </div>
        )}

        {/* 产物卡片列表 */}
        {artifacts && artifacts.length > 0 && (
          <div className="mt-2">
            {artifacts.map((a, i) => (
              <ArtifactCard key={`artifact-${i}`} artifact={a} />
            ))}
          </div>
        )}
      </div>
      {copyButton}
    </div>
  )
}
