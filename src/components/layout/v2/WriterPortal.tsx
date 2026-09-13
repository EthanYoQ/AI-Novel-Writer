import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ColorTheme } from '../../../shared/appearance-profile'
import '../../../styles/redesign/writer-shell.css'

/** Portal appearance travels with the shell; never sets body/global theme or preferences. */
export default function WriterPortal({ theme, children, container }: {
  theme: ColorTheme
  children: ReactNode
  container: Element
}) {
  return createPortal(<div className="writer-portal" data-writer-theme={theme}>{children}</div>, container)
}
