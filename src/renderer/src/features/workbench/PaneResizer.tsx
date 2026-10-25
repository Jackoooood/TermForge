import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@renderer/lib/utils'

interface PaneResizerProps {
  /** Side of the handle that the resized pane occupies. */
  edge: 'left' | 'right'
  label: string
  width: number | null
  min: number
  max: number
  fallbackWidth: number
  getTargetWidth: () => number | null
  onChange: (width: number) => void
  onReset?: () => void
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function PaneResizer({
  edge,
  label,
  width,
  min,
  max,
  fallbackWidth,
  getTargetWidth,
  onChange,
  onReset,
  className,
}: PaneResizerProps) {
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)
  const currentWidth = width ?? fallbackWidth

  const endDrag = (): void => {
    dragState.current = null
    setDragging(false)
    document.body.classList.remove('is-resizing-pane')
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const measured = getTargetWidth() ?? currentWidth
    dragState.current = { startX: event.clientX, startWidth: measured }
    setDragging(true)
    document.body.classList.add('is-resizing-pane')

    const handleMove = (moveEvent: PointerEvent): void => {
      const state = dragState.current
      if (!state) return
      const delta =
        edge === 'right' ? state.startX - moveEvent.clientX : moveEvent.clientX - state.startX
      onChange(clamp(state.startWidth + delta, min, max))
    }
    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      endDrag()
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Home' && onReset) {
      event.preventDefault()
      onReset()
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const grow = event.key === (edge === 'right' ? 'ArrowLeft' : 'ArrowRight')
    const step = event.shiftKey ? 48 : 16
    const measured = getTargetWidth() ?? currentWidth
    onChange(clamp(measured + (grow ? step : -step), min, max))
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(currentWidth)}
      tabIndex={0}
      className={cn('pane-resizer', dragging && 'pane-resizer--dragging', className)}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      title={`${label}（拖动调整，双击恢复默认）`}
    >
      <span className="pane-resizer__line" aria-hidden="true" />
    </div>
  )
}
