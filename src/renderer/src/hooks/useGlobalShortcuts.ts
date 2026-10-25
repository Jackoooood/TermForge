import { useEffect } from 'react'
import { isPrimaryModifierPressed } from '@renderer/lib/platform'
import { useQuickCommandStore } from '@renderer/stores/quickCommandStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  )
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || !isPrimaryModifierPressed(event) || event.altKey) return
      const key = event.key.toLowerCase()
      const workspace = useWorkspaceStore.getState()

      if (key === 'k' && !event.shiftKey) {
        event.preventDefault()
        workspace.openPalette('search')
        return
      }

      if (key === 'k' && event.shiftKey) {
        event.preventDefault()
        useQuickCommandStore.getState().openDrawer()
        return
      }

      if (key === 'p' && event.shiftKey) {
        event.preventDefault()
        workspace.openPalette('commands')
        return
      }

      if (isEditableTarget(event.target)) return

      if (key === 'b' && !event.shiftKey) {
        event.preventDefault()
        workspace.toggleSidebar()
        return
      }

      if (key === ',') {
        event.preventDefault()
        workspace.setActiveModule('settings')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
