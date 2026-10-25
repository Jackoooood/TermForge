import { app } from 'electron'
import { APP_NAME } from '../../shared/constants/app'
import type { AppInfo, DesktopPlatform } from '../../shared/types/ipc'

function toDesktopPlatform(platform: NodeJS.Platform): DesktopPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return 'other'
}

export function getAppInfo(): AppInfo {
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    platform: toDesktopPlatform(process.platform),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    isPackaged: app.isPackaged,
  }
}
