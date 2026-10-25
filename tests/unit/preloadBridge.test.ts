import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_PREFERENCES } from '@shared/constants'
import { IPC_CHANNELS, IPC_CHANNEL_NAMES, IPC_EVENT_CHANNELS } from '@shared/constants/ipc'
import type {
  AppInfo,
  ConnectionInput,
  SshHostKeyRequestEvent,
  SshStatusEvent,
  TermForgeBridge,
} from '@shared/types'

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn((file: File) => `C:\\dropped\\${file.name}`),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
  webUtils: { getPathForFile: electronMock.getPathForFile },
}))

const APP_INFO: AppInfo = {
  appName: 'TermForge',
  appVersion: '0.1.0',
  platform: 'win32',
  electronVersion: '45.0.0',
  chromeVersion: '142.0.0.0',
  isPackaged: false,
}

const INPUT: ConnectionInput = {
  name: 'ops-node',
  host: '10.20.4.99',
  port: 22,
  username: 'deploy',
  authMethod: 'sshAgent',
  groupId: 'production',
  tagIds: [],
  credentialRef: '~/.ssh/id_ed25519',
  jumpConnectionIds: [],
}

describe('preload bridge boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    electronMock.invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.appGetInfo) return Promise.resolve(APP_INFO)
      if (channel === IPC_CHANNELS.securityGetStatus) {
        return Promise.resolve({
          credentialStorage: {
            available: true,
            protection: 'windows-dpapi',
            message: 'protected',
          },
          hostKeyPolicy: 'explicit-trust-only',
        })
      }
      return Promise.resolve({ ok: true, value: NULL_RESULT[channel] })
    })
  })

  it('exposes only fixed methods on a frozen bridge and frozen namespaces', async () => {
    await import('../../src/preload/index')

    expect(electronMock.exposeInMainWorld).toHaveBeenCalledTimes(1)
    const [key, bridge] = electronMock.exposeInMainWorld.mock.calls[0] as [string, TermForgeBridge]
    expect(key).toBe('termforge')
    expect(Object.keys(bridge)).toEqual([
      'getAppInfo',
      'getSecurityStatus',
      'getPathForFile',
      'connections',
      'portForwards',
      'ssh',
      'terminal',
      'sftp',
      'localFs',
      'transfer',
      'settings',
      'hostKeys',
      'logs',
      'wallpaper',
      'quickCommands',
      'commandHistory',
    ])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(bridge).not.toHaveProperty('ipcRenderer')
    expect(bridge).not.toHaveProperty('send')
    expect(bridge).not.toHaveProperty('invoke')

    expect(Object.keys(bridge.connections)).toEqual([
      'list',
      'create',
      'update',
      'remove',
      'setFavorite',
    ])
    expect(Object.isFrozen(bridge.connections)).toBe(true)

    expect(Object.keys(bridge.portForwards)).toEqual([
      'list',
      'create',
      'update',
      'remove',
      'start',
      'stop',
      'getConnectionRemovalImpact',
      'onSnapshot',
    ])
    expect(Object.isFrozen(bridge.portForwards)).toBe(true)

    expect(Object.keys(bridge.ssh)).toEqual([
      'connect',
      'cancelConnect',
      'disconnect',
      'getStatus',
      'respondToHostKey',
      'saveCredential',
      'onSessionStatus',
      'onHostKeyRequest',
    ])
    expect(Object.isFrozen(bridge.ssh)).toBe(true)

    expect(Object.keys(bridge.terminal)).toEqual([
      'open',
      'write',
      'resize',
      'close',
      'getStatus',
      'readClipboard',
      'onOutput',
      'onStatus',
      'onExit',
    ])
    expect(Object.isFrozen(bridge.terminal)).toBe(true)

    expect(Object.keys(bridge.sftp)).toEqual([
      'open',
      'list',
      'stat',
      'mkdir',
      'rename',
      'deleteFile',
      'removeDirectory',
      'readTextFile',
      'writeTextFile',
      'close',
    ])
    expect(Object.isFrozen(bridge.sftp)).toBe(true)

    expect(Object.keys(bridge.localFs)).toEqual(['roots', 'list'])
    expect(Object.isFrozen(bridge.localFs)).toBe(true)

    expect(Object.keys(bridge.transfer)).toEqual([
      'enqueueUpload',
      'enqueueUploadPaths',
      'enqueueDownload',
      'enqueueDownloadPaths',
      'cancel',
      'retry',
      'resolveConflict',
      'list',
      'clearHistory',
      'onUpdate',
    ])
    expect(Object.isFrozen(bridge.transfer)).toBe(true)

    expect(Object.keys(bridge.settings)).toEqual(['get', 'update'])
    expect(Object.isFrozen(bridge.settings)).toBe(true)

    expect(Object.keys(bridge.hostKeys)).toEqual(['list', 'remove'])
    expect(Object.isFrozen(bridge.hostKeys)).toBe(true)

    expect(Object.keys(bridge.logs)).toEqual(['getInfo', 'exportLogs', 'openFolder'])
    expect(Object.isFrozen(bridge.logs)).toBe(true)

    expect(Object.keys(bridge.wallpaper)).toEqual(['get', 'choose', 'remove'])
    expect(Object.isFrozen(bridge.wallpaper)).toBe(true)

    expect(Object.keys(bridge.quickCommands)).toEqual([
      'list',
      'create',
      'update',
      'remove',
      'setFavorite',
      'execute',
    ])
    expect(Object.isFrozen(bridge.quickCommands)).toBe(true)

    expect(Object.keys(bridge.commandHistory)).toEqual(['list', 'remove', 'clear'])
    expect(Object.isFrozen(bridge.commandHistory)).toBe(true)

    expect(IPC_CHANNEL_NAMES).toEqual(Object.values(IPC_CHANNELS))
    expect(IPC_CHANNEL_NAMES).toHaveLength(66)
  })

  it('invokes only the dedicated channel for each domain method', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    await bridge.getAppInfo()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.appGetInfo)

    await bridge.getSecurityStatus()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.securityGetStatus)

    await bridge.connections.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.connectionsList)

    await bridge.connections.create(INPUT)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.connectionsCreate, INPUT)

    await bridge.connections.update('conn-1', INPUT)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.connectionsUpdate,
      'conn-1',
      INPUT,
    )

    await bridge.connections.remove('conn-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.connectionsRemove, 'conn-1')

    await bridge.connections.setFavorite('conn-1', true)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.connectionsSetFavorite,
      'conn-1',
      true,
    )

    await bridge.connections.remove('conn-1', { cascadePortForwards: true })
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.connectionsRemove, 'conn-1', {
      cascadePortForwards: true,
    })

    await bridge.portForwards.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.portForwardsList)

    const localInput = {
      type: 'local' as const,
      name: 'web',
      connectionId: 'conn-1',
      bindPort: 8080,
      targetHost: '127.0.0.1',
      targetPort: 80,
    }
    await bridge.portForwards.create(localInput)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.portForwardsCreate,
      localInput,
    )

    const localUpdate = {
      type: 'local' as const,
      name: 'web-2',
      bindPort: 8081,
      targetHost: '127.0.0.1',
      targetPort: 80,
    }
    await bridge.portForwards.update('pf-1', localUpdate)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.portForwardsUpdate,
      'pf-1',
      localUpdate,
    )

    await bridge.portForwards.remove('pf-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.portForwardsRemove, 'pf-1')

    await bridge.portForwards.start({ ruleId: 'pf-1', sessionId: 'ssh-1' })
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.portForwardsStart, {
      ruleId: 'pf-1',
      sessionId: 'ssh-1',
    })

    await bridge.portForwards.stop('pf-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.portForwardsStop, 'pf-1')

    await bridge.portForwards.getConnectionRemovalImpact('conn-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.portForwardsConnectionImpact,
      'conn-1',
    )

    await bridge.ssh.connect('conn-1', 'sshtab-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sshConnect,
      'conn-1',
      'sshtab-1',
    )

    await bridge.ssh.cancelConnect('sshtab-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sshCancelConnect, 'sshtab-1')

    await bridge.ssh.disconnect('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sshDisconnect, 'ssh-1')

    await bridge.ssh.getStatus('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sshGetStatus, 'ssh-1')

    await bridge.ssh.respondToHostKey('hk-1', true)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sshRespondHostKey,
      'hk-1',
      true,
    )

    await bridge.ssh.saveCredential({
      connectionId: 'conn-1',
      kind: 'password',
      secret: 'secret',
    })
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sshSetCredential, {
      connectionId: 'conn-1',
      kind: 'password',
      secret: 'secret',
    })

    const size = { cols: 100, rows: 40 }
    await bridge.terminal.open('ssh-1', size)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.terminalOpen, 'ssh-1', size)

    await bridge.terminal.write('ssh-1', 'pwd\r')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.terminalWrite,
      'ssh-1',
      'pwd\r',
    )

    await bridge.terminal.resize('ssh-1', size)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.terminalResize, 'ssh-1', size)

    await bridge.terminal.close('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.terminalClose, 'ssh-1')

    await bridge.terminal.getStatus('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.terminalGetStatus, 'ssh-1')

    await bridge.terminal.readClipboard()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.terminalReadClipboard)

    await bridge.sftp.open('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sftpOpen, 'ssh-1')

    await bridge.sftp.list('ssh-1', '/var/www')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sftpList, 'ssh-1', '/var/www')

    await bridge.sftp.stat('ssh-1', '/var/www/index.html')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpStat,
      'ssh-1',
      '/var/www/index.html',
    )

    await bridge.sftp.mkdir('ssh-1', '/var/www', 'releases')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpMkdir,
      'ssh-1',
      '/var/www',
      'releases',
    )

    await bridge.sftp.rename('ssh-1', '/var/www/a', '/var/www/b')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpRename,
      'ssh-1',
      '/var/www/a',
      '/var/www/b',
    )

    await bridge.sftp.deleteFile('ssh-1', '/var/www/a')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpDeleteFile,
      'ssh-1',
      '/var/www/a',
    )

    await bridge.sftp.removeDirectory('ssh-1', '/var/www/empty')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpRemoveDirectory,
      'ssh-1',
      '/var/www/empty',
    )

    await bridge.sftp.readTextFile('ssh-1', '/var/www/index.html')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sftpReadTextFile,
      'ssh-1',
      '/var/www/index.html',
    )

    const writeInput = {
      sessionId: 'ssh-1',
      path: '/var/www/index.html',
      content: 'hello',
      encoding: 'utf-8' as const,
      eol: 'lf' as const,
      expectedRevision: '1:5',
      force: false,
    }
    await bridge.sftp.writeTextFile(writeInput)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sftpWriteTextFile, writeInput)

    await bridge.sftp.close('ssh-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sftpClose, 'ssh-1')

    await bridge.localFs.roots()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.localFsRoots)

    await bridge.localFs.list('C:\\Users\\deploy')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.localFsList,
      'C:\\Users\\deploy',
    )

    await bridge.transfer.enqueueUpload('ssh-1', '/var/www')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.transferEnqueueUpload,
      'ssh-1',
      '/var/www',
    )

    await bridge.transfer.enqueueUploadPaths('ssh-1', '/var/www', [
      'C:\\src\\app.js',
      'C:\\src\\assets',
    ])
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.transferEnqueueUploadPaths,
      'ssh-1',
      '/var/www',
      ['C:\\src\\app.js', 'C:\\src\\assets'],
    )

    await bridge.transfer.enqueueDownload('ssh-1', ['/var/www/a', '/var/www/b'])
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.transferEnqueueDownload,
      'ssh-1',
      ['/var/www/a', '/var/www/b'],
    )

    await bridge.transfer.enqueueDownloadPaths(
      'ssh-1',
      ['/var/www/a'],
      'C:\\Users\\deploy\\Downloads',
    )
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.transferEnqueueDownloadPaths,
      'ssh-1',
      ['/var/www/a'],
      'C:\\Users\\deploy\\Downloads',
    )

    await bridge.transfer.cancel('transfer-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.transferCancel, 'transfer-1')

    await bridge.transfer.retry('transfer-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.transferRetry, 'transfer-1')

    await bridge.transfer.resolveConflict('transfer-1', 'rename', 'a-copy.txt')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.transferResolveConflict,
      'transfer-1',
      'rename',
      'a-copy.txt',
    )

    await bridge.transfer.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.transferList)

    await bridge.transfer.clearHistory()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.transferClearHistory)

    await bridge.settings.get()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsGet)

    const preferences = { ...DEFAULT_APP_PREFERENCES }
    await bridge.settings.update(preferences)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsUpdate, preferences)

    await bridge.hostKeys.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.hostKeysList)

    await bridge.hostKeys.remove('10.20.4.11', 22)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.hostKeysRemove,
      '10.20.4.11',
      22,
    )

    await bridge.logs.getInfo()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.logsGetInfo)

    await bridge.logs.exportLogs()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.logsExport)

    await bridge.logs.openFolder()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.logsOpenFolder)

    await bridge.wallpaper.get()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.wallpaperGet)

    await bridge.wallpaper.choose()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.wallpaperChoose)

    await bridge.wallpaper.remove()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.wallpaperRemove)

    await bridge.quickCommands.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.quickCommandsList)

    const quickCommandDraft = {
      name: '查看服务状态',
      category: '服务诊断',
      description: '',
      body: 'systemctl status {{service}} --no-pager',
      parameters: [{ name: 'service', defaultValue: 'sshd' }],
    }
    await bridge.quickCommands.create(quickCommandDraft)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.quickCommandsCreate,
      quickCommandDraft,
    )

    await bridge.quickCommands.update('qc-1', quickCommandDraft)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.quickCommandsUpdate,
      'qc-1',
      quickCommandDraft,
    )

    await bridge.quickCommands.remove('qc-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.quickCommandsRemove, 'qc-1')

    await bridge.quickCommands.setFavorite('builtin-uptime', true)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.quickCommandsSetFavorite,
      'builtin-uptime',
      true,
    )

    const executeInput = {
      kind: 'command' as const,
      requestId: 'req-12345678',
      commandId: 'builtin-uptime',
      parameterValues: {},
      tabId: 'sshtab-1',
      sessionId: 'ssh-1',
      recordHistory: false,
    }
    await bridge.quickCommands.execute(executeInput)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.quickCommandsExecute,
      executeInput,
    )

    await bridge.commandHistory.list()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.commandHistoryList)

    await bridge.commandHistory.remove('ch-1')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.commandHistoryRemove, 'ch-1')

    await bridge.commandHistory.clear()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.commandHistoryClear)

    expect(electronMock.invoke).toHaveBeenCalledTimes(67)
  })

  it('resolves dropped file paths through webUtils with a safe fallback', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    const file = new File(['content'], 'notes.txt')
    expect(bridge.getPathForFile(file)).toBe('C:\\dropped\\notes.txt')
    expect(electronMock.getPathForFile).toHaveBeenCalledWith(file)

    electronMock.getPathForFile.mockImplementationOnce(() => {
      throw new Error('no on-disk path')
    })
    expect(bridge.getPathForFile(file)).toBe('')
  })

  it('subscribes to SSH events and removes the exact listener on unsubscribe', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    const statusListener = vi.fn()
    const unsubscribeStatus = bridge.ssh.onSessionStatus(statusListener)
    expect(electronMock.on).toHaveBeenLastCalledWith(
      IPC_EVENT_CHANNELS.sshSessionStatus,
      expect.any(Function),
    )
    const [statusChannel, statusWrapped] = electronMock.on.mock.calls.at(-1) as [
      string,
      (event: unknown, payload: SshStatusEvent) => void,
    ]
    const statusEvent = { session: { sessionId: 'ssh-1' } } as SshStatusEvent
    statusWrapped({}, statusEvent)
    expect(statusListener).toHaveBeenCalledWith(statusEvent)

    unsubscribeStatus()
    unsubscribeStatus()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(1)
    expect(electronMock.removeListener).toHaveBeenCalledWith(statusChannel, statusWrapped)
    expect(statusChannel).toBe(IPC_EVENT_CHANNELS.sshSessionStatus)

    const hostKeyListener = vi.fn()
    const unsubscribeHostKey = bridge.ssh.onHostKeyRequest(hostKeyListener)
    const [, hostKeyWrapped] = electronMock.on.mock.calls.at(-1) as [
      string,
      (event: unknown, payload: SshHostKeyRequestEvent) => void,
    ]
    const hostKeyEvent = { challenge: { requestId: 'hk-1' } } as SshHostKeyRequestEvent
    hostKeyWrapped({}, hostKeyEvent)
    expect(hostKeyListener).toHaveBeenCalledWith(hostKeyEvent)

    unsubscribeHostKey()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(2)
  })

  it('exposes typed terminal event subscriptions with idempotent unsubscribe', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    const outputListener = vi.fn()
    const unsubscribeOutput = bridge.terminal.onOutput(outputListener)
    const [outputChannel, outputWrapped] = electronMock.on.mock.calls.at(-1) as [
      string,
      (event: unknown, payload: unknown) => void,
    ]
    expect(outputChannel).toBe(IPC_EVENT_CHANNELS.terminalOutput)
    outputWrapped({}, { sessionId: 'ssh-1', data: 'pwd\r\n' })
    expect(outputListener).toHaveBeenCalledWith({ sessionId: 'ssh-1', data: 'pwd\r\n' })
    unsubscribeOutput()
    unsubscribeOutput()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(1)
    expect(electronMock.removeListener).toHaveBeenCalledWith(outputChannel, outputWrapped)

    const statusListener = vi.fn()
    const unsubscribeStatus = bridge.terminal.onStatus(statusListener)
    expect(electronMock.on).toHaveBeenLastCalledWith(
      IPC_EVENT_CHANNELS.terminalStatus,
      expect.any(Function),
    )
    unsubscribeStatus()

    const exitListener = vi.fn()
    const unsubscribeExit = bridge.terminal.onExit(exitListener)
    expect(electronMock.on).toHaveBeenLastCalledWith(
      IPC_EVENT_CHANNELS.terminalExit,
      expect.any(Function),
    )
    unsubscribeExit()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(3)
  })

  it('exposes the transfer update subscription with idempotent unsubscribe', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    const updateListener = vi.fn()
    const unsubscribeUpdate = bridge.transfer.onUpdate(updateListener)
    const [updateChannel, updateWrapped] = electronMock.on.mock.calls.at(-1) as [
      string,
      (event: unknown, payload: unknown) => void,
    ]
    expect(updateChannel).toBe(IPC_EVENT_CHANNELS.transferUpdate)
    const payload = { task: { id: 'transfer-1', revision: 3 } }
    updateWrapped({}, payload)
    expect(updateListener).toHaveBeenCalledWith(payload)

    unsubscribeUpdate()
    unsubscribeUpdate()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(1)
    expect(electronMock.removeListener).toHaveBeenCalledWith(updateChannel, updateWrapped)
  })

  it('exposes the port-forward snapshot subscription with idempotent unsubscribe', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    const listener = vi.fn()
    const unsubscribe = bridge.portForwards.onSnapshot(listener)
    const [channel, wrapped] = electronMock.on.mock.calls.at(-1) as [
      string,
      (event: unknown, payload: unknown) => void,
    ]
    expect(channel).toBe(IPC_EVENT_CHANNELS.portForwardSnapshot)
    const payload = { snapshot: { revision: 2, items: [] } }
    wrapped({}, payload)
    expect(listener).toHaveBeenCalledWith(payload)

    unsubscribe()
    unsubscribe()
    expect(electronMock.removeListener).toHaveBeenCalledTimes(1)
    expect(electronMock.removeListener).toHaveBeenCalledWith(channel, wrapped)
  })

  it('rejects non-function event listeners instead of registering them', async () => {
    await import('../../src/preload/index')
    const bridge = electronMock.exposeInMainWorld.mock.calls[0]?.[1] as TermForgeBridge

    expect(() => bridge.terminal.onOutput('not-a-function' as unknown as () => void)).toThrow(
      TypeError,
    )
    expect(electronMock.on).not.toHaveBeenCalled()
  })
})

const NULL_RESULT: Record<string, unknown> = {
  [IPC_CHANNELS.connectionsList]: { tags: [], connections: [], groups: [] },
  [IPC_CHANNELS.connectionsCreate]: null,
  [IPC_CHANNELS.connectionsUpdate]: null,
  [IPC_CHANNELS.connectionsRemove]: { id: 'conn-1' },
  [IPC_CHANNELS.connectionsSetFavorite]: null,
  [IPC_CHANNELS.portForwardsList]: { revision: 0, items: [] },
  [IPC_CHANNELS.portForwardsCreate]: null,
  [IPC_CHANNELS.portForwardsUpdate]: null,
  [IPC_CHANNELS.portForwardsRemove]: { id: 'pf-1' },
  [IPC_CHANNELS.portForwardsStart]: null,
  [IPC_CHANNELS.portForwardsStop]: null,
  [IPC_CHANNELS.portForwardsConnectionImpact]: {
    connectionId: 'conn-1',
    portForwardRuleCount: 0,
    runningPortForwardCount: 0,
  },
  [IPC_CHANNELS.sshConnect]: { session: null, reused: false },
  [IPC_CHANNELS.sshCancelConnect]: { cancelled: false, session: null },
  [IPC_CHANNELS.sshDisconnect]: null,
  [IPC_CHANNELS.sshGetStatus]: null,
  [IPC_CHANNELS.sshRespondHostKey]: { requestId: 'hk-1', accepted: true },
  [IPC_CHANNELS.sshSetCredential]: { connectionId: 'conn-1', kind: 'password' },
  [IPC_CHANNELS.terminalOpen]: {
    sessionId: 'ssh-1',
    status: 'open',
    size: { cols: 80, rows: 24 },
    reused: false,
  },
  [IPC_CHANNELS.terminalWrite]: { sessionId: 'ssh-1' },
  [IPC_CHANNELS.terminalResize]: { sessionId: 'ssh-1' },
  [IPC_CHANNELS.terminalClose]: { sessionId: 'ssh-1' },
  [IPC_CHANNELS.terminalGetStatus]: {
    sessionId: 'ssh-1',
    status: 'idle',
    size: { cols: 80, rows: 24 },
    failure: null,
    exit: null,
  },
  [IPC_CHANNELS.terminalReadClipboard]: '',
  [IPC_CHANNELS.sftpOpen]: { sessionId: 'ssh-1', homePath: '/home/deploy' },
  [IPC_CHANNELS.sftpList]: {
    sessionId: 'ssh-1',
    path: '/var/www',
    entries: [],
    loadedAt: '2026-10-22T08:00:00.000Z',
  },
  [IPC_CHANNELS.sftpStat]: {
    id: '/var/www/index.html',
    name: 'index.html',
    path: '/var/www/index.html',
    kind: 'file',
    sizeBytes: 0,
    modifiedAt: null,
    permissions: null,
  },
  [IPC_CHANNELS.sftpMkdir]: {
    sessionId: 'ssh-1',
    path: '/var/www/releases',
    operation: 'mkdir',
  },
  [IPC_CHANNELS.sftpRename]: {
    sessionId: 'ssh-1',
    path: '/var/www/b',
    operation: 'rename',
  },
  [IPC_CHANNELS.sftpDeleteFile]: {
    sessionId: 'ssh-1',
    path: '/var/www/a',
    operation: 'delete-file',
  },
  [IPC_CHANNELS.sftpRemoveDirectory]: {
    sessionId: 'ssh-1',
    path: '/var/www/empty',
    operation: 'remove-directory',
  },
  [IPC_CHANNELS.sftpReadTextFile]: {
    sessionId: 'ssh-1',
    path: '/var/www/index.html',
    content: '',
    encoding: 'utf-8',
    eol: 'lf',
    revision: '0:0',
    sizeBytes: 0,
    modifiedAt: null,
    permissions: null,
  },
  [IPC_CHANNELS.sftpWriteTextFile]: {
    sessionId: 'ssh-1',
    path: '/var/www/index.html',
    revision: '0:0',
    sizeBytes: 0,
    modifiedAt: null,
    backupCleanupFailed: false,
  },
  [IPC_CHANNELS.sftpClose]: { sessionId: 'ssh-1', closed: true },
  [IPC_CHANNELS.transferEnqueueUpload]: [],
  [IPC_CHANNELS.transferEnqueueDownload]: [],
  [IPC_CHANNELS.transferCancel]: null,
  [IPC_CHANNELS.transferRetry]: null,
  [IPC_CHANNELS.transferResolveConflict]: null,
  [IPC_CHANNELS.transferList]: [],
  [IPC_CHANNELS.transferClearHistory]: { cleared: 0 },
  [IPC_CHANNELS.settingsGet]: {
    preferences: { ...DEFAULT_APP_PREFERENCES },
    warnings: [],
  },
  [IPC_CHANNELS.settingsUpdate]: {
    preferences: { ...DEFAULT_APP_PREFERENCES },
    warnings: [],
  },
  [IPC_CHANNELS.hostKeysList]: [],
  [IPC_CHANNELS.hostKeysRemove]: { removed: true },
  [IPC_CHANNELS.logsGetInfo]: {
    directory: 'C:\\logs',
    level: 'info',
    files: [],
    writeFailures: 0,
  },
  [IPC_CHANNELS.logsExport]: { exported: true },
  [IPC_CHANNELS.logsOpenFolder]: { opened: true },
  [IPC_CHANNELS.wallpaperGet]: { dataUrl: null, fileName: null, updatedAt: null },
  [IPC_CHANNELS.wallpaperChoose]: {
    state: { dataUrl: null, fileName: null, updatedAt: null },
    canceled: true,
  },
  [IPC_CHANNELS.wallpaperRemove]: { dataUrl: null, fileName: null, updatedAt: null },
  [IPC_CHANNELS.quickCommandsList]: { commands: [] },
  [IPC_CHANNELS.quickCommandsCreate]: null,
  [IPC_CHANNELS.quickCommandsUpdate]: null,
  [IPC_CHANNELS.quickCommandsRemove]: { id: 'qc-1' },
  [IPC_CHANNELS.quickCommandsSetFavorite]: null,
  [IPC_CHANNELS.quickCommandsExecute]: {
    requestId: 'req-12345678',
    body: 'uptime',
    writtenAt: '2026-10-23T08:00:00.000Z',
    historyRecorded: false,
    historyWarning: null,
  },
  [IPC_CHANNELS.commandHistoryList]: { entries: [] },
  [IPC_CHANNELS.commandHistoryRemove]: { id: 'ch-1' },
  [IPC_CHANNELS.commandHistoryClear]: { cleared: 0 },
}
