import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { SplitDirection } from '@renderer/features/terminal/splitLayout'
import { clampSplitRatio } from '@renderer/features/terminal/splitLayout'

interface TerminalSplitDividerProps {
  direction: SplitDirection
  ratio: number
  onChange: (ratio: number) => void
}

export function TerminalSplitDivider({ direction, ratio, onChange }: TerminalSplitDividerProps) {
  const draggingRef = useRef(false)

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const stage = event.currentTarget.parentElement
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    if (direction === 'row') {
      if (rect.width <= 0) return
      onChange((event.clientX - rect.left) / rect.width)
    } else {
      if (rect.height <= 0) return
      onChange((event.clientY - rect.top) / rect.height)
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    updateFromPointer(event)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    draggingRef.current = false
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.02
    let next: number | null = null
    if (direction === 'row') {
      if (event.key === 'ArrowLeft') next = ratio - step
      if (event.key === 'ArrowRight') next = ratio + step
    } else {
      if (event.key === 'ArrowUp') next = ratio - step
      if (event.key === 'ArrowDown') next = ratio + step
    }
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = 1
    if (next === null) return
    event.preventDefault()
    onChange(clampSplitRatio(next))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="调整分屏比例"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={`${Math.round(ratio * 100)}%`}
      className={`terminal-split-divider terminal-split-divider--${direction}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={() => onChange(0.5)}
      onKeyDown={handleKeyDown}
    />
  )
}
