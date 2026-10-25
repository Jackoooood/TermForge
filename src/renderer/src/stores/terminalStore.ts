import { create } from 'zustand'
import type {
  TerminalExitEvent,
  TerminalFailure,
  TerminalOpenResult,
  TerminalShellSnapshot,
  TerminalSize,
} from '@shared/types'

/**
 * Shell lifecycle keyed by the stable workspace tab. Remote terminal output
 * never enters this store: it is streamed straight from preload events into
 * xterm and a capped replay buffer.
 */
interface TerminalStoreState {
  shells: Record<string, TerminalShellSnapshot>
  applySnapshot: (tabId: string, snapshot: TerminalShellSnapshot) => void
  applyOpenResult: (tabId: string, result: TerminalOpenResult) => void
  applyExit: (tabId: string, event: TerminalExitEvent) => void
  applyFailure: (tabId: string, failure: TerminalFailure, size?: TerminalSize) => void
  applySize: (tabId: string, size: TerminalSize) => void
  removeTab: (tabId: string) => void
  reset: () => void
}

function copySnapshot(snapshot: TerminalShellSnapshot): TerminalShellSnapshot {
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    size: { cols: snapshot.size.cols, rows: snapshot.size.rows },
    failure: snapshot.failure ? { ...snapshot.failure } : null,
    exit: snapshot.exit ? { ...snapshot.exit } : null,
  }
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  shells: {},

  applySnapshot: (tabId, snapshot) => {
    set((state) => ({
      shells: { ...state.shells, [tabId]: copySnapshot(snapshot) },
    }))
  },

  applyOpenResult: (tabId, result) => {
    set((state) => {
      const current = state.shells[tabId]
      return {
        shells: {
          ...state.shells,
          [tabId]: {
            sessionId: result.sessionId,
            status: result.status,
            size: { cols: result.size.cols, rows: result.size.rows },
            failure: null,
            exit:
              result.status === 'open' || result.status === 'opening'
                ? null
                : (current?.exit ?? null),
          },
        },
      }
    })
  },

  applyExit: (tabId, event) => {
    const current = get().shells[tabId]
    if (!current) return
    set((state) => ({
      shells: {
        ...state.shells,
        [tabId]: {
          ...current,
          exit: { code: event.code, signal: event.signal, reason: event.reason },
        },
      },
    }))
  },

  applyFailure: (tabId, failure, size) => {
    set((state) => {
      const current = state.shells[tabId]
      return {
        shells: {
          ...state.shells,
          [tabId]: {
            sessionId: current?.sessionId ?? '',
            status: 'error',
            size: size
              ? { cols: size.cols, rows: size.rows }
              : (current?.size ?? { cols: 80, rows: 24 }),
            failure: { ...failure },
            exit: null,
          },
        },
      }
    })
  },

  applySize: (tabId, size) => {
    const current = get().shells[tabId]
    if (!current) return
    if (current.size.cols === size.cols && current.size.rows === size.rows) return
    set((state) => ({
      shells: {
        ...state.shells,
        [tabId]: {
          ...current,
          size: { cols: size.cols, rows: size.rows },
        },
      },
    }))
  },

  removeTab: (tabId) => {
    if (!(tabId in get().shells)) return
    set((state) => {
      const shells = { ...state.shells }
      delete shells[tabId]
      return { shells }
    })
  },

  reset: () => set({ shells: {} }),
}))
