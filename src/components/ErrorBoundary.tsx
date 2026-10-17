import { Component, createContext } from 'react'
import type { ReactNode, ErrorInfo, ContextType } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useLocaleStore } from '../stores/locale-store'

interface Props {
  children: ReactNode
  fallbackLabel?: string
  /** 自定义的出错界面，替代默认的错误详情与重试按钮；传函数时拿到重试（清掉错误、重新渲染子树）。 */
  fallback?: ReactNode | ((retry: () => void) => ReactNode)
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack: string
}

/** 全局 Error Boundary — 防止单个组件崩溃导致整个 React 树卸载 */
export class ErrorBoundary extends Component<Props, State> {
  static contextType = createContext(undefined)
  declare context: ContextType<typeof ErrorBoundary.contextType>

  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, componentStack: '' }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 组件崩溃:', error, info)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  private retry = () => this.setState({ hasError: false, error: null, componentStack: '' })

  render() {
    const { fallback } = this.props
    if (this.state.hasError && fallback !== undefined) return typeof fallback === 'function' ? fallback(this.retry) : fallback
    if (this.state.hasError) {
      const text = useLocaleStore.getState().text
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            backgroundColor: 'var(--color-editor-bg)',
            color: 'var(--color-text)',
          }}
        >
          <AlertTriangle size={32} aria-hidden="true" />
          <p style={{ fontWeight: 600, fontSize: 14 }}>
            {this.props.fallbackLabel || text('组件渲染出错', 'Component failed to render')}
          </p>
          <pre
            style={{
              fontSize: '0.75rem',
              color: 'var(--color-error-text)',
              backgroundColor: 'color-mix(in srgb, var(--color-error) 10%, transparent)',
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              maxWidth: '100%',
              overflow: 'auto',
              maxHeight: 200,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {this.state.error?.message}
            {'\n'}
            {this.state.componentStack}
          </pre>
          <button
            style={{
              marginTop: 8,
              padding: '6px 16px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              backgroundColor: 'var(--color-hover)',
              color: 'var(--color-text)',
              cursor: 'pointer',
              fontSize: '0.8rem',
              transition: 'background-color var(--transition-fast)',
            }}
            onClick={this.retry}
          >
            {text('重试', 'Retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
