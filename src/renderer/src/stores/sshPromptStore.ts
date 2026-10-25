import { create } from 'zustand'
import type { AuthMethod, HostKeyChallenge, SshCredentialKind } from '@shared/types'
import { useAppStore } from './appStore'

export interface CredentialPrompt {
  /** Stable workspace tab that owns the SSH session being retried. */
  tabId: string
  sessionId: string
  connectionId: string
  connectionName: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  kind: SshCredentialKind
  message: string
  /** Set when the missing credential belongs to a jump host. */
  hopIndex?: number
}

interface SshPromptState {
  hostKeyQueue: HostKeyChallenge[]
  hostKeySubmitting: boolean
  hostKeyError: string | null
  credentialPrompt: CredentialPrompt | null
  enqueueHostKey: (challenge: HostKeyChallenge) => void
  resolveHostKey: (requestId: string, accepted: boolean) => Promise<void>
  clearHostKeysForSession: (sessionId: string) => void
  clearCredentialForSession: (sessionId: string) => void
  openCredentialPrompt: (prompt: CredentialPrompt) => void
  closeCredentialPrompt: () => void
  reset: () => void
}

export const useSshPromptStore = create<SshPromptState>((set, get) => ({
  hostKeyQueue: [],
  hostKeySubmitting: false,
  hostKeyError: null,
  credentialPrompt: null,

  enqueueHostKey: (challenge) => {
    set((state) => {
      if (state.hostKeyQueue.some((item) => item.requestId === challenge.requestId)) return state
      return { hostKeyQueue: [...state.hostKeyQueue, challenge], hostKeyError: null }
    })
  },

  resolveHostKey: async (requestId, accepted) => {
    if (get().hostKeySubmitting) return
    const bridge = window.termforge
    if (!bridge) {
      set({ hostKeyError: '未加载 Electron preload bridge，无法提交主机密钥确认。' })
      return
    }

    set({ hostKeySubmitting: true, hostKeyError: null })
    try {
      const result = await bridge.ssh.respondToHostKey(requestId, accepted)
      if (result.ok) {
        set((state) => ({
          hostKeyQueue: state.hostKeyQueue.filter((item) => item.requestId !== requestId),
        }))
        return
      }

      const expired = result.error.code === 'not-found'
      if (!accepted || expired) {
        // The main process has already cancelled (or will time out) this
        // handshake; remove the stale prompt and surface the reason.
        set((state) => ({
          hostKeyQueue: state.hostKeyQueue.filter((item) => item.requestId !== requestId),
        }))
      }
      set({ hostKeyError: result.error.message })
      useAppStore.getState().pushToast({
        tone: 'danger',
        title: accepted ? '主机密钥未保存' : '主机密钥确认失败',
        description: result.error.message,
      })
    } catch {
      set({ hostKeyError: '提交主机密钥确认时发生错误，连接不会继续进行。' })
    } finally {
      set({ hostKeySubmitting: false })
    }
  },

  clearHostKeysForSession: (sessionId) => {
    set((state) => {
      if (!state.hostKeyQueue.some((item) => item.sessionId === sessionId)) return state
      return { hostKeyQueue: state.hostKeyQueue.filter((item) => item.sessionId !== sessionId) }
    })
  },

  clearCredentialForSession: (sessionId) => {
    set((state) =>
      state.credentialPrompt?.sessionId === sessionId ? { credentialPrompt: null } : state,
    )
  },

  openCredentialPrompt: (prompt) => {
    set({ credentialPrompt: prompt })
  },

  closeCredentialPrompt: () => set({ credentialPrompt: null }),

  reset: () => set({ hostKeyQueue: [], hostKeyError: null, credentialPrompt: null }),
}))
