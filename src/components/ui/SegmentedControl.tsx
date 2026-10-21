import { useRef, type KeyboardEvent } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  /** 分组的可访问名称。 */
  label: string
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
}

const KEYS: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
}

/**
 * 互斥的少量选项；选中项 aria-pressed 为 true。整组只占一个 Tab 停靠点（落在选中项上），方向键与 Home/End 换选并移动焦点。
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, options.findIndex(option => option.value === value))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = KEYS[event.key]
    // 带修饰键的组合留给系统与外层快捷键（如 Alt+← 后退、Shift+方向键选字）。
    if (!move || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    event.preventDefault()
    const next = move(selected, options.length)
    onChange(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div className="pi-seg" role="group" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={element => { buttons.current[index] = element }}
          type="button"
          className="pi-seg-item"
          aria-pressed={option.value === value}
          tabIndex={index === selected ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
