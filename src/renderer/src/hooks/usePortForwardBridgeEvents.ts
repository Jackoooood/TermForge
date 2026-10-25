import { useEffect } from 'react'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'

/**
 * Mirrors main-process forwarding snapshots into the renderer projection.
 * Runtime state is never inferred from a button click; only these snapshots
 * and service responses change the visible status.
 */
export function usePortForwardBridgeEvents(): void {
  useEffect(() => {
    const bridge = window.termforge
    if (!bridge) return

    const unsubscribe = bridge.portForwards.onSnapshot((event) => {
      usePortForwardStore.getState().applySnapshot(event)
    })
    void usePortForwardStore.getState().sync()

    return unsubscribe
  }, [])
}
