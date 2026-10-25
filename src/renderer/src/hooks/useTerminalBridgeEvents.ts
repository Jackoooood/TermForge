import { useEffect } from 'react'
import { attachTerminalRuntime } from '@renderer/services/terminalRuntime'

/**
 * Subscribes the renderer to terminal events for the app lifetime. Output is
 * buffered per SSH session, so switching away from the workbench does not lose
 * remote output or close the underlying shell.
 */
export function useTerminalBridgeEvents(): void {
  useEffect(() => attachTerminalRuntime(), [])
}
