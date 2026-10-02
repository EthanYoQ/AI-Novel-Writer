/* eslint-disable react-refresh/only-export-components */
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

 

export const buttonVariants = cva(
  /* 基础：加入顺滑过渡和点击缩小回弹效果，提升交互手感。
     v2-btn 是「墨纸书斋」尺寸钩子：在 v1 下它没有任何样式（类名未定义），
     组件完全走下面的 Tailwind 原值，逐像素不变；v2 下由无层 CSS 覆盖成
     demo 的 30px 高 / 8px 圆角 / 12.5px 字号。 */
  'v2-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-xs font-medium transition-all duration-200 ease-out active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)] focus-visible:ring-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'v2-btn-primary btn-primary text-white',
        ai:
          'v2-btn-ai ai-glow text-white shadow-sm hover:shadow-md relative overflow-hidden',
        destructive:
          'v2-btn-destructive bg-[var(--color-error)] text-[var(--color-error-foreground)] shadow-sm hover:shadow-md hover:shadow-[var(--color-error)]/30 transition-all duration-200 hover:brightness-110 active:scale-[0.96]',
        outline:
          'v2-btn-outline border border-[var(--color-border)] bg-transparent text-[var(--color-text)] hover:bg-[var(--color-hover)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-all duration-200',
        ghost:
          'v2-btn-ghost text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)] active:scale-[0.98] transition-all duration-200',
        success:
          'bg-[var(--color-success)] text-[var(--color-success-foreground)] shadow-sm hover:shadow-md hover:shadow-[var(--color-success)]/30 transition-all duration-200 hover:brightness-110 active:scale-[0.96]',
      },
      size: {
        default: 'v2-btn-md h-7 px-3 py-1 rounded-[var(--radius-md)]',    /* 28px 高 */
        sm:      'v2-btn-sm h-6 px-2.5 py-0.5 rounded-[var(--radius-sm)]', /* 24px 高 */
        lg:      'v2-btn-lg h-8 px-4 py-1.5 rounded-[var(--radius-lg)]',   /* 32px 高 */
        icon:    'v2-btn-icon h-7 w-7 p-0 rounded-[var(--radius-md)]',       /* 28x28 方形图标按钮 */
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button }
