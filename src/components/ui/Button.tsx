import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { Check } from 'lucide-react'
import { clsx } from 'clsx'

type NativeButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>

/** 旧组件沿用的按钮变体名，渲染时一律换成纸墨六种（见 LEGACY_INK_VARIANT）。 */
type LegacyButtonProps = NativeButtonProps & {
  variant?: 'default' | 'ai' | 'destructive' | 'outline' | 'ghost' | 'success' | null
  size?: 'default' | 'sm' | 'lg' | 'icon' | null
  asChild?: boolean
}

/** 纸墨按钮：主、次、文字（幽灵）、危险描边、危险实心与图标。 */
export type InkButtonVariant = 'primary' | 'secondary' | 'text' | 'danger' | 'danger-solid' | 'icon'
export type InkButtonSize = 'sm' | 'md' | 'lg'

type InkButtonProps = NativeButtonProps & { size?: InkButtonSize } & (
  | { variant: Exclude<InkButtonVariant, 'icon'> }
  | { variant: 'icon'; 'aria-label': string }
)

export type ButtonProps = LegacyButtonProps | InkButtonProps

const inkVariants: ReadonlySet<string> = new Set<InkButtonVariant>(['primary', 'secondary', 'text', 'danger', 'danger-solid', 'icon'])

function isInkButton(props: ButtonProps): props is InkButtonProps {
  return typeof props.variant === 'string' && inkVariants.has(props.variant)
}

type LegacyVariant = NonNullable<LegacyButtonProps['variant']>
type LegacySize = NonNullable<LegacyButtonProps['size']>

/**
 * 沿用的旧对话框与旧面板（导入、导出、项目备份、模型表单、架构编辑等）仍写旧变体名，渲染时一律换成纸墨六种。
 * 旧面板拿 default 标切换按钮的选中项（带 aria-pressed 或 aria-selected），那不是这一层的主操作：一律换成次按钮，
 * 选中时强调色边线加淡底；aria-pressed 的选中项前面再加对勾，不只靠颜色区分（标签页不加）。
 */
const LEGACY_INK_VARIANT: Record<LegacyVariant, Exclude<InkButtonVariant, 'icon'>> = {
  default: 'primary', ai: 'primary', success: 'primary', outline: 'secondary', ghost: 'text', destructive: 'danger-solid',
}
/** 旧尺寸 28/24/32px 换成纸墨最接近的一档。 */
const LEGACY_INK_SIZE: Record<LegacySize, InkButtonSize> = { default: 'sm', sm: 'sm', lg: 'md', icon: 'sm' }

function inkClasses(variant: InkButtonVariant, size: InkButtonSize, className: string | undefined) {
  return clsx('pi-btn', `pi-btn--${variant}`, size !== 'md' && `pi-btn--${size}`, className)
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
  if (isInkButton(props)) {
    const { className, variant, size = 'md', type = 'button', ...rest } = props
    return <button ref={ref} type={type} className={inkClasses(variant, size, className)} {...rest} />
  }
  const { className, variant, size, asChild = false, children, ...rest } = props
  const Comp = asChild ? Slot : 'button'
  const toggle = rest['aria-pressed'] !== undefined || rest['aria-selected'] !== undefined
  const inkVariant = size === 'icon' ? 'icon' : toggle ? 'secondary' : LEGACY_INK_VARIANT[variant ?? 'default']
  const checked = !asChild && (rest['aria-pressed'] === true || rest['aria-pressed'] === 'true')
  return (
    <Comp ref={ref} className={inkClasses(inkVariant, LEGACY_INK_SIZE[size ?? 'default'], className)} {...rest}>
      {checked ? <><Check aria-hidden />{children}</> : children}
    </Comp>
  )
})
Button.displayName = 'Button'

export { Button }
