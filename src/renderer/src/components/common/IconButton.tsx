import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md'
  active?: boolean
}

export function IconButton({
  label,
  size = 'md',
  active = false,
  className,
  type = 'button',
  title,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        'icon-btn',
        size === 'sm' && 'icon-btn--sm',
        active && 'icon-btn--active',
        className,
      )}
      {...props}
    />
  )
}
