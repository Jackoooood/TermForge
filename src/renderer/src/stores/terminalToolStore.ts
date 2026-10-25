import { create } from 'zustand'

export type TerminalCopyResult = 'copied' | 'empty' | 'failed'
export type TerminalPasteResult = 'pasted' | 'empty' | 'failed'

export interface TerminalToolController {
  copySelection: () => Promise<TerminalCopyResult>
  pasteClipboard: () => Promise<TerminalPasteResult>
  clearBuffer: () => void
  openSearch: () => void
}

interface TerminalToolState {
  selection: Record<string, boolean>
  setSelection: (tabId: string, hasSelection: boolean) => void
  forgetTab: (tabId: string) => void
  reset: () => void
}

// Controllers are imperative and tied to a live xterm instance, so they live
// outside React state. Zustand only mirrors the cheap selection flag the
// toolbar needs for enabling the copy action.
const controllers = new Map<string, TerminalToolController>()
const controllerTokens = new Map<string, number>()
let nextControllerToken = 1

export function registerTerminalToolController(
  tabId: string,
  controller: TerminalToolController,
): () => void {
  const token = nextControllerToken
  nextControllerToken += 1
  controllers.set(tabId, controller)
  controllerTokens.set(tabId, token)
  return () => {
    if (controllerTokens.get(tabId) !== token) return
    controllerTokens.delete(tabId)
    controllers.delete(tabId)
  }
}

export function getTerminalToolController(tabId: string): TerminalToolController | null {
  return controllers.get(tabId) ?? null
}

export const useTerminalToolStore = create<TerminalToolState>((set) => ({
  selection: {},

  setSelection: (tabId, hasSelection) =>
    set((state) => {
      if ((state.selection[tabId] ?? false) === hasSelection) return state
      return { selection: { ...state.selection, [tabId]: hasSelection } }
    }),

  forgetTab: (tabId) =>
    set((state) => {
      if (!(tabId in state.selection)) return state
      const selection = { ...state.selection }
      delete selection[tabId]
      return { selection }
    }),

  reset: () => set({ selection: {} }),
}))
