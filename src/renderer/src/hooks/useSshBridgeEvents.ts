import { useEffect } from 'react'
import type { SshSessionStatus } from '@shared/types'
import { promptForCredentialIfNeeded, useSessionStore } from '@renderer/stores/sessionStore'
import { useSshPromptStore } from '@renderer/stores/sshPromptStore'

const TERMINAL_PROMPT_STATUSES: ReadonlySet<SshSessionStatus> = new Set([
  'error',
  'closing',
  'disconnected',
])

/**
 * Mirrors main-process SSH notifications into renderer stores. The returned
 * unsubscribe callbacks are essential: the preload listeners must be removed
 * when the app root unmounts (including React StrictMode re-mounts).
 */
export function useSshBridgeEvents(): void {
  useEffect(() => {
    const bridge = window.termforge
    if (!bridge) return

    const unsubscribeStatus = bridge.ssh.onSessionStatus(({ session }) => {
      const applied = useSessionStore.getState().applySshSnapshot(session)
      if (!applied) return

      if (TERMINAL_PROMPT_STATUSES.has(applied.status)) {
        if (applied.sessionId) {
          useSshPromptStore.getState().clearHostKeysForSession(applied.sessionId)
          if (applied.status !== 'error') {
            useSshPromptStore.getState().clearCredentialForSession(applied.sessionId)
          }
        }
      }
      if (applied.status === 'connected' && applied.sessionId) {
        useSshPromptStore.getState().clearCredentialForSession(applied.sessionId)
      }
      if (applied.status === 'error') {
        promptForCredentialIfNeeded(applied)
      }
    })

    const unsubscribeHostKey = bridge.ssh.onHostKeyRequest(({ challenge }) => {
      useSshPromptStore.getState().enqueueHostKey(challenge)
    })

    return () => {
      unsubscribeStatus()
      unsubscribeHostKey()
    }
  }, [])
}
