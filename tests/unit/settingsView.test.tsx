import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import type { HostKeyRecord, LogInfo } from '@shared/types'
import { SettingsView } from '@renderer/features/settings/SettingsView'
import { useAppStore } from '@renderer/stores/appStore'
import { useSettingsStore } from '@renderer/stores/settingsStore'
import { useTransferStore } from '@renderer/stores/transferStore'
import { useWallpaperStore } from '@renderer/stores/wallpaperStore'
import { createFakeBridge } from './helpers/fakeBridge'

const HOST_KEY: HostKeyRecord = {
  host: '10.20.4.11',
  port: 22,
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789',
  trustedAt: '2026-10-22T08:00:00.000Z',
  updatedAt: '2026-10-22T08:00:00.000Z',
}

const LOG_INFO: LogInfo = {
  directory: 'C:\\Users\\test\\AppData\\Roaming\\TermForge\\logs',
  level: 'info',
  files: [
    {
      name: 'termforge.log',
      sizeBytes: 2048,
      modifiedAt: '2026-10-22T08:00:00.000Z',
    },
  ],
  writeFailures: 0,
}

beforeEach(() => {
  useSettingsStore.setState({
    ...DEFAULT_APP_PREFERENCES,
    resolvedTheme: 'dark',
    status: 'idle',
    warnings: [],
    error: null,
  })
  useAppStore.setState({
    appInfo: null,
    bridgeStatus: 'idle',
    bridgeError: null,
    securityStatus: null,
    securityStatusError: null,
    toasts: [],
  })
  useTransferStore.setState({ tasks: [], panelOpen: false })
  useWallpaperStore.setState({
    dataUrl: null,
    fileName: null,
    updatedAt: null,
    status: 'idle',
    error: null,
    busy: false,
  })
})

describe('settings view', () => {
  it('shows appearance by default and switches categories by click and keyboard', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(8)
    expect(screen.getByRole('tab', { name: '外观' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: '外观' })).toBeVisible()
    expect(screen.queryByRole('tabpanel', { name: '终端' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '终端' }))
    expect(screen.getByRole('tab', { name: '终端' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: '终端' })).toBeVisible()
    expect(screen.queryByRole('tabpanel', { name: '外观' })).not.toBeInTheDocument()

    screen.getByRole('tab', { name: '终端' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('tab', { name: '文件传输' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: '文件传输' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: '文件传输' })).toBeVisible()
  })

  it('persists theme and log-level changes and exposes the system theme option', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })

    render(<SettingsView />)

    const classicGroup = screen.getByRole('group', { name: '经典主题' })
    expect(within(classicGroup).getAllByRole('button')).toHaveLength(3)
    expect(
      within(classicGroup).getByRole('button', { name: /Aurora 极光/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(screen.getByRole('group', { name: 'DBX 色板' })).getAllByRole('button'),
    ).toHaveLength(13)

    await user.click(within(classicGroup).getByRole('button', { name: /Mist 柔光/ }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'mist' }))

    await user.click(screen.getByLabelText('经典主题跟随系统深浅色'))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'system' }))

    await user.click(screen.getByRole('tab', { name: '诊断日志' }))
    await user.selectOptions(screen.getByLabelText('日志级别'), 'debug')
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'system', logLevel: 'debug' }),
    )

    await user.click(screen.getByRole('tab', { name: '文件传输' }))
    await user.selectOptions(screen.getByLabelText('全局传输并发'), '1')
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transferMaxConcurrent: 1,
        transferMaxPerSession: 1,
      }),
    )
  })

  it('applies a dbx palette, its light/dark mode and live font previews', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })

    render(<SettingsView />)

    const dbxGroup = screen.getByRole('group', { name: 'DBX 色板' })
    const cobalt = within(dbxGroup).getByRole('button', { name: /Cobalt 钴蓝/ })
    await user.click(cobalt)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dbx-cobalt' }))
    expect(cobalt).toHaveAttribute('aria-pressed', 'true')

    const modeGroup = screen.getByRole('group', { name: 'DBX 深浅色' })
    const darkMode = within(modeGroup).getByRole('button', { name: '深色' })
    expect(darkMode).toBeEnabled()
    await user.click(darkMode)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ dbxThemeMode: 'dark' }))

    await user.selectOptions(screen.getByLabelText('界面字体'), 'yahei')
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ uiFontFamily: 'yahei' }))

    const uiSizeGroup = screen.getByRole('group', { name: '界面字号' })
    await user.click(within(uiSizeGroup).getByRole('button', { name: '15' }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ uiFontSize: 15 }))

    await user.selectOptions(screen.getByLabelText('终端字体'), 'jetbrains')
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalFontFamily: 'jetbrains' }),
    )

    const terminalSizeGroup = screen.getByRole('group', { name: '终端字号' })
    await user.click(within(terminalSizeGroup).getByRole('button', { name: '16' }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ terminalFontSize: 16 }))

    expect(screen.getByText(/界面预览 · 15px/)).toBeInTheDocument()
    expect(screen.getByText(/TermForge 终端工作台/)).toBeInTheDocument()
    expect(screen.getByText(/dev@termforge/)).toBeInTheDocument()
  })

  it('keeps automatic reconnect off by default and persists an explicit opt-in', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update })

    render(<SettingsView />)

    await user.click(screen.getByRole('tab', { name: '会话与传输记录' }))
    const toggle = screen.getByRole('checkbox', { name: '启用自动重连' })
    expect(toggle).not.toBeChecked()
    expect(toggle.closest('label')).toHaveTextContent('已关闭（默认）')
    expect(screen.getByText(/最多 5 次/)).toBeInTheDocument()

    await user.click(toggle)
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoReconnectEnabled: true }),
    )
    expect(await screen.findByText('已启用')).toBeInTheDocument()
  })

  it('imports a local wallpaper, toggles wallpaper mode and selects intensity', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async (preferences) => ({
      ok: true as const,
      value: { preferences: { ...preferences }, warnings: [] },
    }))
    const wallpaper = {
      dataUrl: 'data:image/jpeg;base64,AAAA',
      fileName: 'desk.jpg',
      updatedAt: '2026-10-22T08:00:00.000Z',
    }
    const choose = vi.fn(async () => ({
      ok: true as const,
      value: { state: wallpaper, canceled: false },
    }))
    const remove = vi.fn(async () => ({
      ok: true as const,
      value: { dataUrl: null, fileName: null, updatedAt: null },
    }))
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, { update }, {}, {}, { choose, remove })

    render(<SettingsView />)

    expect(screen.getByRole('checkbox', { name: '启用壁纸模式' })).toBeDisabled()
    const intensityGroup = screen.getByRole('group', { name: '壁纸浓度' })
    expect(within(intensityGroup).getByRole('button', { name: '浓' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /选择本地图片/ }))
    expect(choose).toHaveBeenCalledTimes(1)
    expect(await screen.findByAltText('当前壁纸预览')).toHaveAttribute('src', wallpaper.dataUrl)
    expect(screen.getByText(/当前图片：desk\.jpg/)).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '启用壁纸模式' })).toBeChecked()
    })

    await user.click(screen.getByRole('checkbox', { name: '启用壁纸模式' }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ wallpaperEnabled: false }))
    await user.click(screen.getByRole('checkbox', { name: '启用壁纸模式' }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ wallpaperEnabled: true }))

    await user.click(within(intensityGroup).getByRole('button', { name: '浓' }))
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ wallpaperIntensity: 'strong' }),
    )

    await user.click(screen.getByRole('button', { name: '移除' }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('未导入')).toBeInTheDocument()
    expect(screen.queryByAltText('当前壁纸预览')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '启用壁纸模式' })).toBeDisabled()
    await vi.waitFor(() => {
      expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ wallpaperEnabled: false }))
    })
  })

  it('lists log metadata and delegates export and folder opening to the bridge', async () => {
    const user = userEvent.setup()
    const getInfo = vi.fn(async () => ({ ok: true as const, value: LOG_INFO }))
    const exportLogs = vi.fn(async () => ({ ok: true as const, value: { exported: true } }))
    const openFolder = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {
        getInfo,
        exportLogs,
        openFolder,
      },
    )

    render(<SettingsView />)

    await user.click(screen.getByRole('tab', { name: '诊断日志' }))
    expect(await screen.findByText('termforge.log')).toBeInTheDocument()
    expect(screen.getByText(LOG_INFO.directory)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /导出脱敏日志/ }))
    expect(exportLogs).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /打开日志目录/ }))
    expect(openFolder).toHaveBeenCalledTimes(1)
  })

  it('requires explicit confirmation before removing a trusted host key', async () => {
    const user = userEvent.setup()
    let keys = [HOST_KEY]
    const list = vi.fn(async () => ({ ok: true as const, value: [...keys] }))
    const remove = vi.fn(async (host: string, port: number) => {
      keys = keys.filter((key) => !(key.host === host && key.port === port))
      return { ok: true as const, value: { removed: true } }
    })
    window.termforge = createFakeBridge({}, {}, {}, {}, {}, {}, { list, remove })

    render(<SettingsView />)

    await user.click(screen.getByRole('tab', { name: '本地存储与凭据' }))
    expect(await screen.findByText('10.20.4.11:22')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '移除 10.20.4.11:22 的主机密钥信任' }))

    expect(screen.getByRole('heading', { name: '移除主机密钥信任？' })).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '移除信任' }))
    expect(remove).toHaveBeenCalledWith('10.20.4.11', 22)
    expect(await screen.findByText('尚未信任任何主机密钥。')).toBeInTheDocument()
  })

  it('surfaces settings persistence errors with a retry action', async () => {
    window.termforge = createFakeBridge(
      {},
      {},
      {},
      {},
      {},
      {
        get: async () => ({
          ok: false,
          error: { code: 'storage-read-failed', message: '设置文件不可读。' },
        }),
      },
    )
    await useSettingsStore.getState().loadSettings()

    render(<SettingsView />)

    expect(await screen.findByRole('alert')).toHaveTextContent('设置文件不可读。')
    expect(screen.getByRole('button', { name: '重新读取' })).toBeInTheDocument()
  })
})
