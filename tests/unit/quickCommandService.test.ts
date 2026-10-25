// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { BUILT_IN_QUICK_COMMANDS } from '@shared/quickCommands/builtIns'
import type {
  CommandHistoryAppendInput,
  CommandHistoryEntry,
  PersistedCustomQuickCommand,
  QuickCommandDraft,
  QuickCommandExecuteInput,
  QuickCommandStoreState,
  SshSessionSnapshot,
  TerminalShellSnapshot,
} from '@shared/types'
import type { CommandHistoryStore } from '../../src/main/storage/commandHistoryRepository'
import type { QuickCommandStore } from '../../src/main/storage/quickCommandRepository'
import {
  QuickCommandService,
  type QuickCommandServiceDependencies,
} from '../../src/main/services/quickCommands/QuickCommandService'
import type { SshServicePort } from '../../src/main/services/ssh/SshService'

const NOW = '2026-10-23T08:00:00.000Z'

const SNAPSHOT: SshSessionSnapshot = {
  clientId: 'sshtab-1',
  sessionId: 'ssh-1',
  connectionId: 'conn-a',
  connectionName: '生产服务器',
  host: '10.0.0.9',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  status: 'connected',
  jumps: [],
  activeHop: null,
  createdAt: NOW,
  connectedAt: NOW,
  hostKey: null,
  error: null,
}

const SHELL: TerminalShellSnapshot = {
  sessionId: 'ssh-1',
  status: 'open',
  size: { cols: 80, rows: 24 },
  failure: null,
  exit: null,
}

function storedCustom(overrides: Partial<PersistedCustomQuickCommand> = {}): PersistedCustomQuickCommand {
  return {
    id: 'qc-1',
    name: '查看服务状态',
    category: '服务诊断',
    description: '',
    body: 'systemctl status {{service}} --no-pager',
    parameters: [{ name: 'service', defaultValue: 'sshd' }],
    favorite: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function createCommandStore(initial: QuickCommandStoreState = { customCommands: [], builtInFavoriteIds: [] }): {
  store: QuickCommandStore
  state: QuickCommandStoreState
} {
  const state = structuredClone(initial)
  const store: QuickCommandStore = {
    list: vi.fn(async () => structuredClone(state)),
    create: vi.fn(async (input: QuickCommandDraft) => ({
      ...structuredClone(input),
      id: 'qc-new',
      favorite: false,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    update: vi.fn(async (id: string, input: QuickCommandDraft) => ({
      ...structuredClone(input),
      id,
      favorite: false,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    remove: vi.fn(async (id: string) => ({ id })),
    setFavorite: vi.fn(async () => structuredClone(state)),
  }
  return { store, state }
}

function createHistoryStore(): {
  store: CommandHistoryStore
  entries: CommandHistoryEntry[]
} {
  const entries: CommandHistoryEntry[] = []
  const store: CommandHistoryStore = {
    list: vi.fn(async () => ({ entries: structuredClone(entries) })),
    append: vi.fn(async (input: CommandHistoryAppendInput) => {
      const entry: CommandHistoryEntry = {
        ...input,
        id: `ch-${entries.length + 1}`,
        sentAt: NOW,
      }
      entries.unshift(entry)
      return entry
    }),
    remove: vi.fn(async (id: string) => ({ id })),
    clear: vi.fn(async () => ({ cleared: 0 })),
  }
  return { store, entries }
}

function createSsh(overrides: Partial<Record<keyof SshServicePort, unknown>> = {}): SshServicePort {
  const ssh: SshServicePort = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn().mockResolvedValue(structuredClone(SNAPSHOT)),
    respondToHostKey: vi.fn(),
    saveCredential: vi.fn(),
    openShell: vi.fn(),
    writeShell: vi.fn().mockResolvedValue({ sessionId: 'ssh-1' }),
    resizeShell: vi.fn(),
    closeShell: vi.fn(),
    getShellStatus: vi.fn().mockResolvedValue(structuredClone(SHELL)),
    acquireForwardingSession: vi.fn(),
    ...overrides,
  } as SshServicePort
  return ssh
}

function createService(options: {
  commands?: QuickCommandStoreState
  historyEnabled?: boolean
  ssh?: SshServicePort
} = {}): {
  service: QuickCommandService
  commands: ReturnType<typeof createCommandStore>
  history: ReturnType<typeof createHistoryStore>
  ssh: SshServicePort
  deps: QuickCommandServiceDependencies
} {
  const commands = createCommandStore(options.commands)
  const history = createHistoryStore()
  const ssh = options.ssh ?? createSsh()
  const deps: QuickCommandServiceDependencies = {
    commands: commands.store,
    history: history.store,
    ssh,
    isCommandHistoryEnabled: vi.fn().mockResolvedValue(options.historyEnabled ?? false),
  }
  return { service: new QuickCommandService(deps), commands, history, ssh, deps }
}

function executeInput(overrides: Partial<QuickCommandExecuteInput> = {}): QuickCommandExecuteInput {
  return {
    kind: 'command',
    requestId: 'req-12345678',
    commandId: 'builtin-uptime',
    parameterValues: {},
    tabId: 'sshtab-1',
    sessionId: 'ssh-1',
    recordHistory: false,
    ...overrides,
  } as QuickCommandExecuteInput
}

describe('quick command service', () => {
  it('lists built-ins first and merges custom commands and favorites', async () => {
    const { service } = createService({
      commands: {
        customCommands: [storedCustom()],
        builtInFavoriteIds: ['builtin-uptime'],
      },
    })

    const snapshot = await service.listCommands()
    expect(snapshot.commands.filter((command) => command.source === 'built-in')).toHaveLength(
      BUILT_IN_QUICK_COMMANDS.length,
    )
    const uptime = snapshot.commands.find((command) => command.id === 'builtin-uptime')
    expect(uptime).toMatchObject({ favorite: true, editable: false, source: 'built-in' })
    const custom = snapshot.commands.find((command) => command.id === 'qc-1')
    expect(custom).toMatchObject({ favorite: true, editable: true, source: 'custom' })
    expect(custom?.parameters).toEqual([{ name: 'service', defaultValue: 'sshd' }])
  })

  it('renders parameters and writes exactly the preview plus one carriage return', async () => {
    const { service, ssh, history } = createService({ historyEnabled: true })

    const ack = await service.execute(
      executeInput({
        commandId: 'builtin-service-status',
        parameterValues: { service: '  nginx  ' },
        recordHistory: true,
      }),
    )

    expect(ssh.writeShell).toHaveBeenCalledWith(
      'ssh-1',
      'systemctl status nginx --no-pager\r',
    )
    expect(ack).toMatchObject({
      requestId: 'req-12345678',
      body: 'systemctl status nginx --no-pager',
      historyRecorded: true,
      historyWarning: null,
    })
    expect(history.store.append).toHaveBeenCalledWith({
      body: 'systemctl status nginx --no-pager',
      tabId: 'sshtab-1',
      sessionId: 'ssh-1',
      connectionId: 'conn-a',
      connectionName: '生产服务器',
      host: '10.0.0.9',
    })
  })

  it('does not record history when the global setting is off', async () => {
    const { service, history } = createService({ historyEnabled: false })
    const ack = await service.execute(executeInput({ recordHistory: true }))

    expect(history.store.append).not.toHaveBeenCalled()
    expect(ack.historyRecorded).toBe(false)
    expect(ack.historyWarning).toContain('命令历史已在设置中关闭')
  })

  it('keeps a successful terminal write successful when history persistence fails', async () => {
    const { service, history } = createService({ historyEnabled: true })
    vi.mocked(history.store.append).mockRejectedValueOnce(new Error('disk full'))

    const ack = await service.execute(executeInput({ recordHistory: true }))
    expect(ack.historyRecorded).toBe(false)
    expect(ack.historyWarning).toContain('命令已写入终端')
  })

  it('rejects a target whose tab or session changed and never writes', async () => {
    const ssh = createSsh({
      getStatus: vi.fn().mockResolvedValue({ ...SNAPSHOT, clientId: 'sshtab-other' }),
    })
    const { service } = createService({ ssh })

    await expect(service.execute(executeInput())).rejects.toMatchObject({ code: 'conflict' })
    expect(ssh.writeShell).not.toHaveBeenCalled()
  })

  it('rejects disconnected sessions and closed shells without retargeting', async () => {
    const disconnected = createSsh({
      getStatus: vi.fn().mockResolvedValue({ ...SNAPSHOT, status: 'disconnected' }),
    })
    const disconnectedService = createService({ ssh: disconnected }).service
    await expect(disconnectedService.execute(executeInput())).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(disconnected.writeShell).not.toHaveBeenCalled()

    const closedShell = createSsh({
      getShellStatus: vi.fn().mockResolvedValue({ ...SHELL, status: 'closed' }),
    })
    const closedService = createService({ ssh: closedShell }).service
    await expect(closedService.execute(executeInput())).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(closedShell.writeShell).not.toHaveBeenCalled()
  })

  it('rejects mismatched parameter sets instead of partially rendering', async () => {
    const { service, ssh } = createService()
    await expect(
      service.execute(
        executeInput({
          commandId: 'builtin-service-status',
          parameterValues: { service: 'nginx', extra: 'x' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(ssh.writeShell).not.toHaveBeenCalled()
  })

  it('deduplicates request ids and blocks a second in-flight send for the same tab', async () => {
    let resolveStatus: ((value: SshSessionSnapshot) => void) | undefined
    const getStatus = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SshSessionSnapshot>((resolve) => {
            resolveStatus = resolve
          }),
      )
      .mockResolvedValue(structuredClone(SNAPSHOT))
    const ssh = createSsh({ getStatus })
    const { service } = createService({ ssh })

    const first = service.execute(executeInput())
    await expect(service.execute(executeInput({ requestId: 'req-abcdefgh' }))).rejects.toMatchObject(
      { code: 'conflict' },
    )
    resolveStatus?.(structuredClone(SNAPSHOT))
    await first

    await expect(service.execute(executeInput())).rejects.toMatchObject({ code: 'conflict' })
    expect(ssh.writeShell).toHaveBeenCalledTimes(1)
  })

  it('re-sends a history body without template processing and records the new send', async () => {
    const { service, ssh, history } = createService({ historyEnabled: true })

    const ack = await service.execute(
      executeInput({
        kind: 'history',
        body: 'echo {{literal}}',
        recordHistory: true,
      }),
    )

    expect(ssh.writeShell).toHaveBeenCalledWith('ssh-1', 'echo {{literal}}\r')
    expect(ack.body).toBe('echo {{literal}}')
    expect(history.store.append).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'echo {{literal}}' }),
    )
  })

  it('rejects an unknown built-in favorite', async () => {
    const { service } = createService()
    await expect(service.setFavorite('builtin-does-not-exist', true)).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
