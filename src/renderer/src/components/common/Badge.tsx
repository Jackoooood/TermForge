import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'demo'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  children: ReactNode
}

export function Badge({ tone = 'neutral', className, children, ...props }: BadgeProps) {
  return (
    <span className={cn('badge', `badge--${tone}`, className)} {...props}>
      {children}
    </span>
  )
}
