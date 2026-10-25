import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/utils'

export interface MenuPosition {
  x: number
  y: number
}

interface FloatingMenuProps {
  position: MenuPosition
  onClose: () => void
  ariaLabel: string
  children: ReactNode
  className?: string
}

export function FloatingMenu({
  position,
  onClose,
  ariaLabel,
  children,
  className,
}: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<MenuPosition>(position)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const node = menuRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const padding = 8
    setCoords({
      x: Math.max(padding, Math.min(position.x, window.innerWidth - rect.width - padding)),
      y: Math.max(padding, Math.min(position.y, window.innerHeight - rect.height - padding)),
    })
  }, [position.x, position.y])

  useEffect(() => {
    const node = menuRef.current
    const firstItem = node?.querySelector<HTMLElement>('[role="menuitem"]')
    firstItem?.focus()

    const handlePointerDown = (event: MouseEvent): void => {
      if (node && event.target instanceof Node && !node.contains(event.target)) {
        onCloseRef.current()
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    const handleViewportChange = (): void => {
      onCloseRef.current()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [])

  return createPortal(
    <div
      ref={menuRef}
      className={cn('floating-menu', className)}
      role="menu"
      aria-label={ariaLabel}
      style={{ left: coords.x, top: coords.y }}
    >
      {children}
    </div>,
    document.body,
  )
}

interface MenuItemProps {
  icon?: LucideIcon
  label: string
  description?: string
  shortcut?: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

export function MenuItem({
  icon: Icon,
  label,
  description,
  shortcut,
  onSelect,
  disabled = false,
  danger = false,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn('menu-item', danger && 'menu-item--danger')}
      onClick={onSelect}
      disabled={disabled}
    >
      {Icon ? <Icon className="menu-item__icon" size={14} aria-hidden="true" /> : null}
      <span className="menu-item__content">
        <span className="menu-item__label">{label}</span>
        {description ? <span className="menu-item__description">{description}</span> : null}
      </span>
      {shortcut ? <span className="menu-item__shortcut">{shortcut}</span> : null}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>
}

export function MenuSeparator() {
  return <div className="menu-separator" role="separator" />
}
