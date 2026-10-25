import { PanelLeft, Palette, Search } from 'lucide-react'
import { nextThemeStyle, themeLabel } from '@shared/theme/catalog'
import { IconButton } from '@renderer/components/common/IconButton'
import { StatusDot } from '@renderer/components/common/StatusDot'
import { formatShortcut } from '@renderer/lib/platform'
import { useAppStore } from '@renderer/stores/appStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

export function TopBar() {
  const sidebarCollapsed = useWorkspaceStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar)
  const openPalette = useWorkspaceStore((state) => state.openPalette)
  const resolvedStyle = useSettingsStore((state) => state.resolvedStyle)
  const toggleTheme = useSettingsStore((state) => state.toggleTheme)
  const bridgeStatus = useAppStore((state) => state.bridgeStatus)

  const nextStyle = nextThemeStyle(resolvedStyle)

  return (
    <header className="top-bar">
      <IconButton
        label={sidebarCollapsed ? '展开服务器侧栏' : '收起服务器侧栏'}
        title={`${sidebarCollapsed ? '展开' : '收起'}服务器侧栏 (${formatShortcut('B')})`}
        size="sm"
        active={!sidebarCollapsed}
        className="top-bar__sidebar-toggle"
        onClick={toggleSidebar}
      >
        <PanelLeft size={16} aria-hidden="true" />
      </IconButton>

      <button
        type="button"
        className="top-bar__search"
        aria-label="全局搜索"
        title={`全局搜索 (${formatShortcut('K')})`}
        onClick={() => openPalette('search')}
      >
        <Search size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="top-bar__search-text">搜索连接、命令、设置…</span>
        <kbd>{formatShortcut('K')}</kbd>
      </button>

      <span className="top-bar__spacer" aria-hidden="true" />

      <span
        className="top-bar__bridge"
        title={
          bridgeStatus === 'ready'
            ? '渲染进程与主进程数据桥已就绪'
            : bridgeStatus === 'unavailable'
              ? '未加载 preload bridge：浏览器预览模式，无 SSH 能力'
              : '正在连接主进程数据桥…'
        }
      >
        <StatusDot
          status={
            bridgeStatus === 'ready' ? 'online' : bridgeStatus === 'unavailable' ? 'error' : 'idle'
          }
          label={
            bridgeStatus === 'ready'
              ? '桥接就绪'
              : bridgeStatus === 'unavailable'
                ? '桥接不可用'
                : '桥接连接中'
          }
        />
        <span>
          {bridgeStatus === 'ready'
            ? '桥接就绪'
            : bridgeStatus === 'unavailable'
              ? '浏览器预览'
              : '连接主进程…'}
        </span>
      </span>

      <IconButton
        label="切换主题"
        title={`当前 ${themeLabel(resolvedStyle)} · 点击切换到 ${themeLabel(nextStyle)}`}
        size="sm"
        onClick={toggleTheme}
      >
        <Palette size={16} aria-hidden="true" />
      </IconButton>
    </header>
  )
}
