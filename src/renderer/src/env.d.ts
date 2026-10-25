/// <reference types="vite/client" />

import type { TermForgeBridge } from '@shared/types'

declare global {
  interface Window {
    /** Exposed by the sandboxed preload bridge. Undefined in a plain browser. */
    termforge?: TermForgeBridge
  }
}

export {}
