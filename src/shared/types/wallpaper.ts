import type { OperationResult } from './ipc'

export type WallpaperIntensity = 'soft' | 'balanced' | 'strong'

/**
 * Renderer-safe projection of the imported wallpaper. The image itself is a
 * data URL produced by the main process; local paths and file handles never
 * cross IPC.
 */
export interface WallpaperState {
  dataUrl: string | null
  fileName: string | null
  updatedAt: string | null
}

export interface WallpaperChooseResult {
  state: WallpaperState
  canceled: boolean
}

export interface WallpaperBridge {
  get(): Promise<OperationResult<WallpaperState>>
  choose(): Promise<OperationResult<WallpaperChooseResult>>
  remove(): Promise<OperationResult<WallpaperState>>
}
