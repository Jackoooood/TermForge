import { BUILT_IN_QUICK_COMMANDS } from '../../../shared/quickCommands/builtIns'
import {
  parseQuickCommandTemplate,
  renderQuickCommandTemplate,
} from '../../../shared/quickCommands/template'
import type {
  CommandHistoryClearAck,
  CommandHistorySnapshot,
  PersistedCustomQuickCommand,
  QuickCommand,
  QuickCommandDraft,
  QuickCommandExecuteAck,
  QuickCommandExecuteInput,
  QuickCommandParameter,
  QuickCommandSnapshot,
} from '../../../shared/types/quickCommands'
import type { SshSessionSnapshot } from '../../../shared/types/ssh'
import { AppOperationError } from '../../errors'
import type { CommandHistoryStore } from '../../storage/commandHistoryRepository'
import type { QuickCommandStore } from '../../storage/quickCommandRepository'
import type { SshServicePort } from '../ssh/SshService'

const BUILT_IN_BY_ID = new Map(BUILT_IN_QUICK_COMMANDS.map((command) => [command.id, command]))

const MAX_RECENT_REQUESTS = 200

function builtInParameters(body: string): QuickCommandParameter[] {
  const parsed = parseQuickCommandTemplate(body)
  if (!parsed.ok) {
    throw new AppOperationError('internal', '内置快速命令模板无效。')
  }
  return parsed.parameters.map((name) => ({ name, defaultValue: '' }))
}

function customToView(command: PersistedCustomQuickCommand): QuickCommand {
  return {
    ...structuredClone(command),
    source: 'custom',
    editable: true,
  }
}

export interface QuickCommandServicePort {
  listCommands(): Promise<QuickCommandSnapshot>
  createCommand(input: QuickCommandDraft): Promise<QuickCommand>
  updateCommand(id: string, input: QuickCommandDraft): Promise<QuickCommand>
  removeCommand(id: string): Promise<{ id: string }>
  setFavorite(id: string, favorite: boolean): Promise<QuickCommand>
  execute(input: QuickCommandExecuteInput): Promise<QuickCommandExecuteAck>
  listHistory(): Promise<CommandHistorySnapshot>
  removeHistory(id: string): Promise<{ id: string }>
  clearHistory(): Promise<CommandHistoryClearAck>
}

export interface QuickCommandServiceDependencies {
  commands: QuickCommandStore
  history: CommandHistoryStore
  ssh: SshServicePort
  /** Read at send time so turning the setting off takes effect immediately. */
  isCommandHistoryEnabled: () => Promise<boolean>
}

/**
 * Quick commands reuse the existing terminal write path
 * (`SshService.writeShell`); this service never creates an SSH client or an
 * arbitrary exec channel. The renderer flushes its own terminal input queue
 * before invoking execute, and this service rejects a second in-flight send for
 * the same tab.
 */
export class QuickCommandService implements QuickCommandServicePort {
  private readonly inFlightTabs = new Set<string>()
  private readonly recentRequestIds = new Set<string>()
  private readonly requestOrder: string[] = []

  constructor(private readonly dependencies: QuickCommandServiceDependencies) {}

  async listCommands(): Promise<QuickCommandSnapshot> {
    const state = await this.dependencies.commands.list()
    const favoriteIds = new Set(state.builtInFavoriteIds)
    const commands: QuickCommand[] = BUILT_IN_QUICK_COMMANDS.map((command) => ({
      id: command.id,
      source: 'built-in',
      name: command.name,
      category: command.category,
      description: command.description,
      body: command.body,
      parameters: builtInParameters(command.body),
      favorite: favoriteIds.has(command.id),
      editable: false,
      createdAt: null,
      updatedAt: null,
    }))
    const customs = [...state.customCommands]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(customToView)
    return { commands: [...commands, ...customs] }
  }

  async createCommand(input: QuickCommandDraft): Promise<QuickCommand> {
    return customToView(await this.dependencies.commands.create(input))
  }

  async updateCommand(id: string, input: QuickCommandDraft): Promise<QuickCommand> {
    return customToView(await this.dependencies.commands.update(id, input))
  }

  removeCommand(id: string): Promise<{ id: string }> {
    return this.dependencies.commands.remove(id)
  }

  async setFavorite(id: string, favorite: boolean): Promise<QuickCommand> {
    if (id.startsWith('builtin-') && !BUILT_IN_BY_ID.has(id)) {
      throw new AppOperationError('not-found', '找不到该内置命令。')
    }
    await this.dependencies.commands.setFavorite(id, favorite)
    const command = (await this.listCommands()).commands.find((item) => item.id === id)
    if (!command) {
      throw new AppOperationError('not-found', '找不到该快速命令。')
    }
    return command
  }

  async execute(input: QuickCommandExecuteInput): Promise<QuickCommandExecuteAck> {
    if (this.recentRequestIds.has(input.requestId)) {
      throw new AppOperationError('conflict', '该发送请求已处理，已忽略重复请求。')
    }
    if (this.inFlightTabs.has(input.tabId)) {
      throw new AppOperationError('conflict', '该终端已有快速命令正在发送，请等待完成后再试。')
    }

    this.inFlightTabs.add(input.tabId)
    try {
      const snapshot = await this.requireTarget(input.tabId, input.sessionId)
      const body = await this.resolveBody(input)
      await this.dependencies.ssh.writeShell(input.sessionId, `${body}\r`)
      this.rememberRequest(input.requestId)

      const history = await this.recordHistory(input, snapshot, body)
      return {
        requestId: input.requestId,
        body,
        writtenAt: new Date().toISOString(),
        historyRecorded: history.recorded,
        historyWarning: history.warning,
      }
    } finally {
      this.inFlightTabs.delete(input.tabId)
    }
  }

  async listHistory(): Promise<CommandHistorySnapshot> {
    const state = await this.dependencies.history.list()
    return { entries: state.entries }
  }

  removeHistory(id: string): Promise<{ id: string }> {
    return this.dependencies.history.remove(id)
  }

  clearHistory(): Promise<CommandHistoryClearAck> {
    return this.dependencies.history.clear()
  }

  private async requireTarget(tabId: string, sessionId: string): Promise<SshSessionSnapshot> {
    let snapshot: SshSessionSnapshot
    try {
      snapshot = await this.dependencies.ssh.getStatus(sessionId)
    } catch {
      throw new AppOperationError(
        'unavailable',
        '目标会话已断开或不存在，快速命令未发送。请重新选择终端。',
      )
    }
    if (snapshot.sessionId !== sessionId || snapshot.clientId !== tabId) {
      throw new AppOperationError(
        'conflict',
        '目标终端已变化，快速命令未发送。请重新选择终端。',
      )
    }
    if (snapshot.status !== 'connected') {
      throw new AppOperationError(
        'unavailable',
        '目标会话当前未连接，快速命令未发送。请重新选择终端。',
      )
    }

    let shellStatus: string
    try {
      shellStatus = (await this.dependencies.ssh.getShellStatus(sessionId)).status
    } catch {
      throw new AppOperationError(
        'unavailable',
        '无法确认目标终端状态，快速命令未发送。请重新选择终端。',
      )
    }
    if (shellStatus !== 'open') {
      throw new AppOperationError(
        'unavailable',
        '目标终端尚未打开 Shell，快速命令未发送。请先在目标终端中打开 Shell。',
      )
    }
    return snapshot
  }

  private async resolveBody(input: QuickCommandExecuteInput): Promise<string> {
    if (input.kind === 'history') return input.body

    let body: string | null = null
    const builtIn = BUILT_IN_BY_ID.get(input.commandId)
    if (builtIn) {
      body = builtIn.body
    } else {
      const state = await this.dependencies.commands.list()
      body = state.customCommands.find((command) => command.id === input.commandId)?.body ?? null
    }
    if (body === null) {
      throw new AppOperationError('not-found', '找不到该快速命令，可能已被删除。')
    }

    const parsed = parseQuickCommandTemplate(body)
    if (!parsed.ok) {
      throw new AppOperationError('invalid-input', '快速命令模板无效，未发送任何内容。')
    }
    const provided = Object.keys(input.parameterValues)
    if (
      provided.length !== parsed.parameters.length ||
      provided.some((name) => !parsed.parameters.includes(name))
    ) {
      throw new AppOperationError('invalid-input', '参数与命令模板不一致，未发送任何内容。')
    }

    const rendered = renderQuickCommandTemplate(body, input.parameterValues)
    if (!rendered.ok) {
      throw new AppOperationError('invalid-input', rendered.message)
    }
    return rendered.text
  }

  private async recordHistory(
    input: QuickCommandExecuteInput,
    snapshot: SshSessionSnapshot,
    body: string,
  ): Promise<{ recorded: boolean; warning: string | null }> {
    if (!input.recordHistory) return { recorded: false, warning: null }

    let enabled: boolean
    try {
      enabled = await this.dependencies.isCommandHistoryEnabled()
    } catch {
      return { recorded: false, warning: '无法读取命令历史设置，本次发送未记录历史。' }
    }
    if (!enabled) {
      return { recorded: false, warning: '命令历史已在设置中关闭，本次发送未记录。' }
    }

    try {
      await this.dependencies.history.append({
        body,
        tabId: input.tabId,
        sessionId: input.sessionId,
        connectionId: snapshot.connectionId,
        connectionName: snapshot.connectionName,
        host: snapshot.host,
      })
      return { recorded: true, warning: null }
    } catch {
      return {
        recorded: false,
        warning: '命令已写入终端，但命令历史保存失败；未记录本次发送。',
      }
    }
  }

  private rememberRequest(requestId: string): void {
    this.recentRequestIds.add(requestId)
    this.requestOrder.push(requestId)
    while (this.requestOrder.length > MAX_RECENT_REQUESTS) {
      const oldest = this.requestOrder.shift()
      if (oldest) this.recentRequestIds.delete(oldest)
    }
  }
}
