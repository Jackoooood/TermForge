import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import {
  DEFAULT_UI_FONT_SIZE,
  TERMINAL_FONT_FAMILIES,
  UI_FONT_FAMILIES,
} from '@shared/constants'
import { TopBar } from '@renderer/components/layout/TopBar'
import { PrimarySidebar } from '@renderer/components/layout/PrimarySidebar'
import { StatusBar } from '@renderer/components/layout/StatusBar'
import { ToastHost } from '@renderer/components/common/ToastHost'
import { CommandPalette } from '@renderer/features/command-palette/CommandPalette'
import { ConnectionEditorModal } from '@renderer/features/connections/ConnectionEditorModal'
import { CredentialPromptModal } from '@renderer/features/connections/CredentialPromptModal'
import { DeleteConnectionModal } from '@renderer/features/connections/DeleteConnectionModal'
import { HostKeyConfirmModal } from '@renderer/features/connections/HostKeyConfirmModal'
import { ServersView } from '@renderer/features/connections/ServersView'
import { SettingsView } from '@renderer/features/settings/SettingsView'
import { SftpView } from '@renderer/features/sftp/SftpView'
import { DeletePortForwardModal } from '@renderer/features/portForwards/DeletePortForwardModal'
import { PortForwardEditorModal } from '@renderer/features/portForwards/PortForwardEditorModal'
import { PortForwardStartModal } from '@renderer/features/portForwards/PortForwardStartModal'
import { PortForwardsView } from '@renderer/features/portForwards/PortForwardsView'
import { QuickCommandComposeModal } from '@renderer/features/quickCommands/QuickCommandComposeModal'
import { QuickCommandDrawer } from '@renderer/features/quickCommands/QuickCommandDrawer'
import { QuickCommandEditorModal } from '@renderer/features/quickCommands/QuickCommandEditorModal'
import { TransferDrawer } from '@renderer/features/transfers/TransferDrawer'
import { RemoteTextEditor } from '@renderer/features/editor/RemoteTextEditor'
import { WorkbenchView } from '@renderer/features/sessions/WorkbenchView'
import { useGlobalShortcuts } from '@renderer/hooks/useGlobalShortcuts'
import { usePortForwardBridgeEvents } from '@renderer/hooks/usePortForwardBridgeEvents'
import { useSshBridgeEvents } from '@renderer/hooks/useSshBridgeEvents'
import { useTerminalBridgeEvents } from '@renderer/hooks/useTerminalBridgeEvents'
import { useTransferBridgeEvents } from '@renderer/hooks/useTransferBridgeEvents'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useWallpaperStore } from '@renderer/stores/wallpaperStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import type { WorkspaceModule } from '@renderer/stores/workspaceStore'

function ActiveModuleView({ module }: { module: WorkspaceModule }) {
  switch (module) {
    case 'servers':
      return <ServersView />
    case 'sftp':
      return <SftpView />
    case 'port-forwards':
      return <PortForwardsView />
    case 'settings':
      return <SettingsView />
    case 'workbench':
    default:
      return <WorkbenchView />
  }
}

export function App() {
  const theme = useSettingsStore((state) => state.theme)
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme)
  const resolvedStyle = useSettingsStore((state) => state.resolvedStyle)
  const gradientIntensity = useSettingsStore((state) => state.gradientIntensity)
  const uiFontFamily = useSettingsStore((state) => state.uiFontFamily)
  const uiFontSize = useSettingsStore((state) => state.uiFontSize)
  const terminalFontFamily = useSettingsStore((state) => state.terminalFontFamily)
  const wallpaperEnabled = useSettingsStore((state) => state.wallpaperEnabled)
  const wallpaperIntensity = useSettingsStore((state) => state.wallpaperIntensity)
  const wallpaperDataUrl = useWallpaperStore((state) => state.dataUrl)
  const sidebarCollapsed = useWorkspaceStore((state) => state.sidebarCollapsed)
  const activeModule = useWorkspaceStore((state) => state.activeModule)
  const wallpaperActive = wallpaperEnabled && wallpaperDataUrl !== null

  useGlobalShortcuts()
  useSshBridgeEvents()
  useTerminalBridgeEvents()
  useTransferBridgeEvents()
  usePortForwardBridgeEvents()

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.themeStyle = resolvedStyle
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme, resolvedStyle])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--tf-font-ui', UI_FONT_FAMILIES[uiFontFamily])
    root.style.setProperty('--tf-font-scale', String(uiFontSize / DEFAULT_UI_FONT_SIZE))
    root.style.setProperty('--tf-font-terminal', TERMINAL_FONT_FAMILIES[terminalFontFamily])
  }, [uiFontFamily, uiFontSize, terminalFontFamily])

  useEffect(() => {
    // The gradient template (--tf-gradient-shell) is declared on :root, so its
    // var(--tf-gradient-strength) resolves against :root, not the .app-shell
    // descendant where the inline style would sit.
    document.documentElement.style.setProperty(
      '--tf-gradient-strength',
      String(gradientIntensity / 100),
    )
  }, [gradientIntensity])

  useEffect(() => {
    useSettingsStore.getState().refreshResolvedTheme()
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = (): void => useSettingsStore.getState().refreshResolvedTheme()
    query.addEventListener?.('change', sync)
    return () => query.removeEventListener?.('change', sync)
  }, [theme])

  useEffect(() => {
    void useSettingsStore.getState().loadSettings()
    void useWallpaperStore.getState().loadWallpaper()
    void useConnectionStore.getState().loadConnections()
    void useAppStore.getState().loadAppInfo()
    void useAppStore.getState().loadSecurityStatus()
  }, [])

  const shellStyle: CSSProperties = {
    ...(wallpaperActive && wallpaperDataUrl
      ? ({ '--tf-wallpaper-image': `url("${wallpaperDataUrl}")` } as CSSProperties)
      : {}),
  }

  return (
    <div
      className="app-shell"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-wallpaper={wallpaperActive ? 'on' : 'off'}
      data-wallpaper-intensity={wallpaperIntensity}
      style={shellStyle}
    >
      <TopBar />
      {sidebarCollapsed ? null : <PrimarySidebar />}
      <main className="workspace" id="main-content">
        <ActiveModuleView module={activeModule} />
      </main>
      <StatusBar />
      <ConnectionEditorModal />
      <DeleteConnectionModal />
      <PortForwardEditorModal />
      <PortForwardStartModal />
      <DeletePortForwardModal />
      <HostKeyConfirmModal />
      <CredentialPromptModal />
      <CommandPalette />
      <QuickCommandDrawer />
      <QuickCommandEditorModal />
      <QuickCommandComposeModal />
      <TransferDrawer />
      <RemoteTextEditor />
      <ToastHost />
    </div>
  )
}
