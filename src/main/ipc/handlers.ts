import { clipboard, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/ipc'
import { connectionIdSchema, setFavoriteInputSchema } from '../../shared/schemas/ipc'
import { connectionInputSchema } from '../../shared/schemas/connection'
import { hostKeyEndpointSchema } from '../../shared/schemas/hostKey'
import { localFsListInputSchema } from '../../shared/schemas/localFs'
import { settingsPreferencesSchema } from '../../shared/schemas/settings'
import {
  commandHistoryRemoveInputSchema,
  customQuickCommandIdSchema,
  quickCommandDraftSchema,
  quickCommandExecuteInputSchema,
  quickCommandFavoriteInputSchema,
} from '../../shared/schemas/quickCommands'
import {
  connectionRemovalOptionsSchema,
  portForwardCreateInputSchema,
  portForwardIdSchema,
  portForwardUpdateInputSchema,
  startPortForwardInputSchema,
} from '../../shared/schemas/portForward'
import { SSH_CREDENTIAL_KINDS } from '../../shared/types/ssh'
import type { AppPreferences } from '../../shared/types/preferences'
import {
  sftpDeleteInputSchema,
  sftpListInputSchema,
  sftpMkdirInputSchema,
  sftpOpenInputSchema,
  sftpReadTextFileInputSchema,
  sftpRenameInputSchema,
  sftpStatInputSchema,
  sftpWriteTextFileInputSchema,
} from '../../shared/schemas/sftp'
import {
  respondHostKeyInputSchema,
  sshClientIdSchema,
  sshCredentialInputSchema,
  sshSessionIdSchema,
} from '../../shared/schemas/ssh'
import {
  transferCancelInputSchema,
  transferEnqueueDownloadInputSchema,
  transferEnqueueDownloadPathsInputSchema,
  transferEnqueueUploadInputSchema,
  transferEnqueueUploadPathsInputSchema,
  transferResolveConflictInputSchema,
  transferRetryInputSchema,
} from '../../shared/schemas/transfer'
import {
  terminalSessionIdSchema,
  terminalSizeSchema,
  terminalWriteDataSchema,
} from '../../shared/schemas/terminal'
import type {
  CommandHistoryClearAck,
  CommandHistorySnapshot,
  ConnectionInput,
  ConnectionMutationAck,
  ConnectionProfile,
  ConnectionCatalog,
  ConnectionRemovalImpact,
  SecurityStatus,
  LocalDirectoryListing,
  LocalRootsResult,
  OperationResult,
  PortForwardItem,
  PortForwardRemoveAck,
  PortForwardSnapshot,
  QuickCommand,
  QuickCommandExecuteAck,
  QuickCommandSnapshot,
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteTextFile,
  SftpCloseAck,
  SftpMutationAck,
  SftpOpenResult,
  SftpTextWriteAck,
  SshConnectCancelAck,
  SshConnectResult,
  SshCredentialAck,
  SshHostKeyResponseAck,
  SshSessionSnapshot,
  TerminalAck,
  TerminalOpenResult,
  TerminalShellSnapshot,
  TransferClearAck,
  TransferTask,
  TransferUploadEnqueueAck,
  WallpaperChooseResult,
  WallpaperState,
} from '../../shared/types'
import { AppOperationError, toOperationError } from '../errors'
import type { LogServicePort } from '../logging/logService'
import type { CredentialStore } from '../security/credentialStore'
import { getAppInfo } from '../services/appInfoService'
import type { LocalFsServicePort } from '../services/localFs/LocalFsService'
import type { PortForwardServicePort } from '../services/portForward/PortForwardService'
import type { QuickCommandServicePort } from '../services/quickCommands/QuickCommandService'
import { credentialReference } from '../services/ssh/credentialResolver'
import type { SftpServicePort } from '../services/sftp/SftpService'
import type { SshServicePort } from '../services/ssh/SshService'
import type { TransferServicePort } from '../services/transfers/TransferService'
import type { WallpaperServicePort } from '../services/wallpaper/WallpaperService'
import type { ConnectionStore } from '../storage/connectionRepository'
import type { HostKeyStore } from '../storage/hostKeyRepository'
import type { SettingsStore } from '../storage/settingsRepository'

type TrustedWindowGetter = () => BrowserWindow | null

interface IpcDependencies {
  connections: ConnectionStore
  credentials: CredentialStore
  portForwards: PortForwardServicePort
  ssh: SshServicePort
  sftp: SftpServicePort
  transfer: TransferServicePort
  localFs: LocalFsServicePort
  settings: SettingsStore
  hostKeys: HostKeyStore
  logs: LogServicePort
  wallpaper: WallpaperServicePort
  quickCommands: QuickCommandServicePort
  /** Applies settings that also affect main-process runtime services. */
  applyRuntimePreferences: (preferences: AppPreferences) => void
}

const UNAVAILABLE_CREDENTIAL_STATUS = {
  available: false,
  protection: 'unavailable',
  message: '无法读取操作系统安全存储状态；凭据操作已禁用，不会使用明文替代。',
} as const

export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: TrustedWindowGetter,
): void {
  const window = getWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('Blocked IPC request from an untrusted sender')
  }
  if (!event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Blocked IPC request from a non-main frame')
  }
}

function parseConnectionInput(value: unknown): ConnectionInput {
  const parsed = connectionInputSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '连接配置未通过校验，请检查字段后重试。')
  }
  return parsed.data
}

function parseId(value: unknown): string {
  const parsed = connectionIdSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppOperationError('invalid-input', '连接 ID 格式无效。')
  }
  return parsed.data
}

async function toResult<T>(operation: () => Promise<T>): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: toOperationError(error) }
  }
}

/**
 * Every renderer → main entry point is a fixed domain channel. Each handler
 * validates the sender/main frame, re-validates input and returns a typed
 * result with sanitized errors; there is no generic invoke/forward channel.
 */
export function registerIpcHandlers(
  getWindow: TrustedWindowGetter,
  dependencies: IpcDependencies,
): void {
  ipcMain.handle(IPC_CHANNELS.appGetInfo, (event) => {
    assertTrustedSender(event, getWindow)
    return getAppInfo()
  })

  ipcMain.handle(IPC_CHANNELS.securityGetStatus, async (event): Promise<SecurityStatus> => {
    assertTrustedSender(event, getWindow)
    let credentialStorage: SecurityStatus['credentialStorage'] = UNAVAILABLE_CREDENTIAL_STATUS
    try {
      credentialStorage = await dependencies.credentials.getStatus()
    } catch {
      credentialStorage = UNAVAILABLE_CREDENTIAL_STATUS
    }
    return {
      credentialStorage,
      hostKeyPolicy: 'explicit-trust-only',
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.connectionsList,
    (event): Promise<OperationResult<ConnectionCatalog>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.connections.list())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.connectionsCreate,
    (event, rawInput: unknown): Promise<OperationResult<ConnectionProfile>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.connections.create(parseConnectionInput(rawInput)))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.connectionsUpdate,
    (event, rawId: unknown, rawInput: unknown): Promise<OperationResult<ConnectionProfile>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() =>
        dependencies.connections.update(parseId(rawId), parseConnectionInput(rawInput)),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.connectionsRemove,
    (
      event,
      rawId: unknown,
      rawOptions: unknown,
    ): Promise<OperationResult<ConnectionMutationAck>> => {
      assertTrustedSender(event, getWindow)
      return toResult(async () => {
        const connectionId = parseId(rawId)
        const options = connectionRemovalOptionsSchema.safeParse(rawOptions ?? {})
        if (!options.success) {
          throw new AppOperationError('invalid-input', '删除连接的附加参数无效。')
        }

        const impact = await dependencies.portForwards.getConnectionRemovalImpact(connectionId)
        if (impact.portForwardRuleCount > 0 && !options.data.cascadePortForwards) {
          throw new AppOperationError(
            'conflict',
            `该连接下仍有 ${impact.portForwardRuleCount} 条端口转发规则，必须先确认停止并删除这些规则后才能删除连接。`,
          )
        }
        // Cascade removal stops every rule and aborts on cleanup failure, so a
        // connection profile is never deleted while its listeners still exist.
        if (impact.portForwardRuleCount > 0) {
          await dependencies.portForwards.removeForConnection(connectionId)
        }

        const ack = await dependencies.connections.remove(connectionId)
        // Losing the profile must not leave its encrypted secrets orphaned.
        // Cleanup failures are non-fatal because the profile is already gone.
        await Promise.allSettled(
          SSH_CREDENTIAL_KINDS.map((kind) =>
            dependencies.credentials.remove(credentialReference(ack.id, kind)),
          ),
        )
        return ack
      })
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsList,
    (event): Promise<OperationResult<PortForwardSnapshot>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.portForwards.list())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsCreate,
    (event, rawInput: unknown): Promise<OperationResult<PortForwardItem>> => {
      assertTrustedSender(event, getWindow)
      const parsed = portForwardCreateInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '端口转发规则未通过校验，请检查字段后重试。' },
        })
      }
      return toResult(() => dependencies.portForwards.create(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsUpdate,
    (
      event,
      rawId: unknown,
      rawInput: unknown,
    ): Promise<OperationResult<PortForwardItem>> => {
      assertTrustedSender(event, getWindow)
      const id = portForwardIdSchema.safeParse(rawId)
      const input = portForwardUpdateInputSchema.safeParse(rawInput)
      if (!id.success || !input.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '端口转发规则未通过校验，请检查字段后重试。' },
        })
      }
      return toResult(() => dependencies.portForwards.update(id.data, input.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsRemove,
    (event, rawId: unknown): Promise<OperationResult<PortForwardRemoveAck>> => {
      assertTrustedSender(event, getWindow)
      const id = portForwardIdSchema.safeParse(rawId)
      if (!id.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '端口转发规则 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.portForwards.remove(id.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsStart,
    (event, rawInput: unknown): Promise<OperationResult<PortForwardItem>> => {
      assertTrustedSender(event, getWindow)
      const parsed = startPortForwardInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '启动端口转发参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.portForwards.start(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsStop,
    (event, rawId: unknown): Promise<OperationResult<PortForwardItem>> => {
      assertTrustedSender(event, getWindow)
      const id = portForwardIdSchema.safeParse(rawId)
      if (!id.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '端口转发规则 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.portForwards.stop(id.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.portForwardsConnectionImpact,
    (event, rawId: unknown): Promise<OperationResult<ConnectionRemovalImpact>> => {
      assertTrustedSender(event, getWindow)
      const id = connectionIdSchema.safeParse(rawId)
      if (!id.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '连接 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.portForwards.getConnectionRemovalImpact(id.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.connectionsSetFavorite,
    (event, rawId: unknown, rawFavorite: unknown): Promise<OperationResult<ConnectionProfile>> => {
      assertTrustedSender(event, getWindow)
      const parsed = setFavoriteInputSchema.safeParse({ id: rawId, favorite: rawFavorite })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '收藏操作参数无效。' },
        })
      }
      return toResult(() =>
        dependencies.connections.setFavorite(parsed.data.id, parsed.data.favorite),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshConnect,
    (
      event,
      rawConnectionId: unknown,
      rawClientId: unknown,
    ): Promise<OperationResult<SshConnectResult>> => {
      assertTrustedSender(event, getWindow)
      const connectionId = connectionIdSchema.safeParse(rawConnectionId)
      const clientId = sshClientIdSchema.safeParse(rawClientId)
      if (!connectionId.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '连接 ID 格式无效。' },
        })
      }
      if (!clientId.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 客户端标识格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.connect(connectionId.data, clientId.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshCancelConnect,
    (event, rawClientId: unknown): Promise<OperationResult<SshConnectCancelAck>> => {
      assertTrustedSender(event, getWindow)
      const clientId = sshClientIdSchema.safeParse(rawClientId)
      if (!clientId.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 客户端标识格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.cancelConnect(clientId.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshDisconnect,
    (event, rawSessionId: unknown): Promise<OperationResult<SshSessionSnapshot>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sshSessionIdSchema.safeParse(rawSessionId)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.disconnect(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshGetStatus,
    (event, rawSessionId: unknown): Promise<OperationResult<SshSessionSnapshot>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sshSessionIdSchema.safeParse(rawSessionId)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.getStatus(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshRespondHostKey,
    (
      event,
      rawRequestId: unknown,
      rawAccepted: unknown,
    ): Promise<OperationResult<SshHostKeyResponseAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = respondHostKeyInputSchema.safeParse({
        requestId: rawRequestId,
        accepted: rawAccepted,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '主机密钥确认参数无效。' },
        })
      }
      return toResult(() =>
        dependencies.ssh.respondToHostKey(parsed.data.requestId, parsed.data.accepted),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sshSetCredential,
    (event, rawInput: unknown): Promise<OperationResult<SshCredentialAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sshCredentialInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '凭据参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.ssh.saveCredential(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalOpen,
    (
      event,
      rawSessionId: unknown,
      rawSize: unknown,
    ): Promise<OperationResult<TerminalOpenResult>> => {
      assertTrustedSender(event, getWindow)
      const sessionId = terminalSessionIdSchema.safeParse(rawSessionId)
      const size = terminalSizeSchema.safeParse(rawSize)
      if (!sessionId.success || !size.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '终端打开参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.ssh.openShell(sessionId.data, size.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalWrite,
    (event, rawSessionId: unknown, rawData: unknown): Promise<OperationResult<TerminalAck>> => {
      assertTrustedSender(event, getWindow)
      const sessionId = terminalSessionIdSchema.safeParse(rawSessionId)
      const data = terminalWriteDataSchema.safeParse(rawData)
      if (!sessionId.success || !data.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '终端输入参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.ssh.writeShell(sessionId.data, data.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    (event, rawSessionId: unknown, rawSize: unknown): Promise<OperationResult<TerminalAck>> => {
      assertTrustedSender(event, getWindow)
      const sessionId = terminalSessionIdSchema.safeParse(rawSessionId)
      const size = terminalSizeSchema.safeParse(rawSize)
      if (!sessionId.success || !size.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '终端尺寸参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.ssh.resizeShell(sessionId.data, size.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalClose,
    (event, rawSessionId: unknown): Promise<OperationResult<TerminalAck>> => {
      assertTrustedSender(event, getWindow)
      const sessionId = terminalSessionIdSchema.safeParse(rawSessionId)
      if (!sessionId.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.closeShell(sessionId.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalGetStatus,
    (event, rawSessionId: unknown): Promise<OperationResult<TerminalShellSnapshot>> => {
      assertTrustedSender(event, getWindow)
      const sessionId = terminalSessionIdSchema.safeParse(rawSessionId)
      if (!sessionId.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SSH 会话 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.ssh.getShellStatus(sessionId.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.terminalReadClipboard,
    (event): Promise<OperationResult<string>> => {
      assertTrustedSender(event, getWindow)
      return toResult(async () => clipboard.readText())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.localFsRoots,
    (event): Promise<OperationResult<LocalRootsResult>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.localFs.roots())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.localFsList,
    (event, rawPath: unknown): Promise<OperationResult<LocalDirectoryListing>> => {
      assertTrustedSender(event, getWindow)
      const parsed = localFsListInputSchema.safeParse({ path: rawPath })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '本地目录参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.localFs.list(parsed.data.path))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpOpen,
    (event, rawSessionId: unknown): Promise<OperationResult<SftpOpenResult>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpOpenInputSchema.safeParse({ sessionId: rawSessionId })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SFTP 打开参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.open(parsed.data.sessionId))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpList,
    (
      event,
      rawSessionId: unknown,
      rawPath: unknown,
    ): Promise<OperationResult<RemoteDirectoryListing>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpListInputSchema.safeParse({
        sessionId: rawSessionId,
        path: rawPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SFTP 目录参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.list(parsed.data.sessionId, parsed.data.path))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpStat,
    (event, rawSessionId: unknown, rawPath: unknown): Promise<OperationResult<RemoteFileEntry>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpStatInputSchema.safeParse({
        sessionId: rawSessionId,
        path: rawPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SFTP 路径参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.stat(parsed.data.sessionId, parsed.data.path))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpMkdir,
    (
      event,
      rawSessionId: unknown,
      rawParentPath: unknown,
      rawName: unknown,
    ): Promise<OperationResult<SftpMutationAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpMkdirInputSchema.safeParse({
        sessionId: rawSessionId,
        parentPath: rawParentPath,
        name: rawName,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '新建目录参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.sftp.mkdir(parsed.data.sessionId, parsed.data.parentPath, parsed.data.name),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpRename,
    (
      event,
      rawSessionId: unknown,
      rawSourcePath: unknown,
      rawTargetPath: unknown,
    ): Promise<OperationResult<SftpMutationAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpRenameInputSchema.safeParse({
        sessionId: rawSessionId,
        sourcePath: rawSourcePath,
        targetPath: rawTargetPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '重命名参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.sftp.rename(
          parsed.data.sessionId,
          parsed.data.sourcePath,
          parsed.data.targetPath,
        ),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpDeleteFile,
    (event, rawSessionId: unknown, rawPath: unknown): Promise<OperationResult<SftpMutationAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpDeleteInputSchema.safeParse({
        sessionId: rawSessionId,
        path: rawPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '删除文件参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.deleteFile(parsed.data.sessionId, parsed.data.path))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpRemoveDirectory,
    (event, rawSessionId: unknown, rawPath: unknown): Promise<OperationResult<SftpMutationAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpDeleteInputSchema.safeParse({
        sessionId: rawSessionId,
        path: rawPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '删除目录参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.sftp.removeDirectory(parsed.data.sessionId, parsed.data.path),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpReadTextFile,
    (event, rawSessionId: unknown, rawPath: unknown): Promise<OperationResult<RemoteTextFile>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpReadTextFileInputSchema.safeParse({
        sessionId: rawSessionId,
        path: rawPath,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '读取文本文件参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.sftp.readTextFile(parsed.data.sessionId, parsed.data.path),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpWriteTextFile,
    (event, rawInput: unknown): Promise<OperationResult<SftpTextWriteAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpWriteTextFileInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '保存文本文件参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.writeTextFile(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.sftpClose,
    (event, rawSessionId: unknown): Promise<OperationResult<SftpCloseAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = sftpOpenInputSchema.safeParse({ sessionId: rawSessionId })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: 'SFTP 关闭参数未通过校验。' },
        })
      }
      return toResult(() => dependencies.sftp.close(parsed.data.sessionId))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferEnqueueUpload,
    (
      event,
      rawSessionId: unknown,
      rawRemoteDirectory: unknown,
    ): Promise<OperationResult<TransferTask[]>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferEnqueueUploadInputSchema.safeParse({
        sessionId: rawSessionId,
        remoteDirectory: rawRemoteDirectory,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '上传请求参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.transfer.enqueueUpload(parsed.data.sessionId, parsed.data.remoteDirectory),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferEnqueueDownload,
    (
      event,
      rawSessionId: unknown,
      rawRemotePaths: unknown,
    ): Promise<OperationResult<TransferTask[]>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferEnqueueDownloadInputSchema.safeParse({
        sessionId: rawSessionId,
        remotePaths: rawRemotePaths,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '下载请求参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.transfer.enqueueDownload(parsed.data.sessionId, parsed.data.remotePaths),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferEnqueueUploadPaths,
    (
      event,
      rawSessionId: unknown,
      rawRemoteDirectory: unknown,
      rawLocalPaths: unknown,
    ): Promise<OperationResult<TransferUploadEnqueueAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferEnqueueUploadPathsInputSchema.safeParse({
        sessionId: rawSessionId,
        remoteDirectory: rawRemoteDirectory,
        localPaths: rawLocalPaths,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '上传路径参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.transfer.enqueueUploadPaths(
          parsed.data.sessionId,
          parsed.data.remoteDirectory,
          parsed.data.localPaths,
        ),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferEnqueueDownloadPaths,
    (
      event,
      rawSessionId: unknown,
      rawRemotePaths: unknown,
      rawLocalDirectory: unknown,
    ): Promise<OperationResult<TransferTask[]>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferEnqueueDownloadPathsInputSchema.safeParse({
        sessionId: rawSessionId,
        remotePaths: rawRemotePaths,
        localDirectory: rawLocalDirectory,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '下载路径参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.transfer.enqueueDownloadPaths(
          parsed.data.sessionId,
          parsed.data.remotePaths,
          parsed.data.localDirectory,
        ),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferCancel,
    (event, rawTransferId: unknown): Promise<OperationResult<TransferTask>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferCancelInputSchema.safeParse({ transferId: rawTransferId })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '传输任务 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.transfer.cancel(parsed.data.transferId))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferRetry,
    (event, rawTransferId: unknown): Promise<OperationResult<TransferTask>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferRetryInputSchema.safeParse({ transferId: rawTransferId })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '传输任务 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.transfer.retry(parsed.data.transferId))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.transferResolveConflict,
    (
      event,
      rawTransferId: unknown,
      rawChoice: unknown,
      rawNewName: unknown,
    ): Promise<OperationResult<TransferTask>> => {
      assertTrustedSender(event, getWindow)
      const parsed = transferResolveConflictInputSchema.safeParse({
        transferId: rawTransferId,
        choice: rawChoice,
        newName: rawNewName,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '冲突处理参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.transfer.resolveConflict(
          parsed.data.transferId,
          parsed.data.choice,
          parsed.data.newName,
        ),
      )
    },
  )

  ipcMain.handle(IPC_CHANNELS.transferList, (event): Promise<OperationResult<TransferTask[]>> => {
    assertTrustedSender(event, getWindow)
    return toResult(async () => dependencies.transfer.list())
  })

  ipcMain.handle(
    IPC_CHANNELS.transferClearHistory,
    (event): Promise<OperationResult<TransferClearAck>> => {
      assertTrustedSender(event, getWindow)
      return toResult(async () => dependencies.transfer.clearHistory())
    },
  )

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event, getWindow)
    return toResult(() => dependencies.settings.get())
  })

  ipcMain.handle(
    IPC_CHANNELS.settingsUpdate,
    (event, rawPreferences: unknown): Promise<OperationResult<unknown>> => {
      assertTrustedSender(event, getWindow)
      const parsed = settingsPreferencesSchema.safeParse(rawPreferences)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '设置参数未通过校验，未写入任何数据。' },
        })
      }
      return toResult(async () => {
        const snapshot = await dependencies.settings.update(parsed.data)
        dependencies.applyRuntimePreferences(snapshot.preferences)
        return snapshot
      })
    },
  )

  ipcMain.handle(IPC_CHANNELS.hostKeysList, (event) => {
    assertTrustedSender(event, getWindow)
    return toResult(() => dependencies.hostKeys.list())
  })

  ipcMain.handle(
    IPC_CHANNELS.hostKeysRemove,
    (event, rawHost: unknown, rawPort: unknown): Promise<OperationResult<unknown>> => {
      assertTrustedSender(event, getWindow)
      const parsed = hostKeyEndpointSchema.safeParse({ host: rawHost, port: rawPort })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '主机端点参数无效。' },
        })
      }
      return toResult(async () => ({
        removed: await dependencies.hostKeys.remove(parsed.data.host, parsed.data.port),
      }))
    },
  )

  ipcMain.handle(IPC_CHANNELS.logsGetInfo, (event) => {
    assertTrustedSender(event, getWindow)
    return toResult(() => dependencies.logs.getInfo())
  })

  ipcMain.handle(IPC_CHANNELS.logsExport, (event) => {
    assertTrustedSender(event, getWindow)
    return toResult(() => dependencies.logs.exportLogs())
  })

  ipcMain.handle(IPC_CHANNELS.logsOpenFolder, (event) => {
    assertTrustedSender(event, getWindow)
    return toResult(() => dependencies.logs.openFolder())
  })

  ipcMain.handle(
    IPC_CHANNELS.wallpaperGet,
    (event): Promise<OperationResult<WallpaperState>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.wallpaper.get())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wallpaperChoose,
    (event): Promise<OperationResult<WallpaperChooseResult>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.wallpaper.choose())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.wallpaperRemove,
    (event): Promise<OperationResult<WallpaperState>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.wallpaper.remove())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsList,
    (event): Promise<OperationResult<QuickCommandSnapshot>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.quickCommands.listCommands())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsCreate,
    (event, rawInput: unknown): Promise<OperationResult<QuickCommand>> => {
      assertTrustedSender(event, getWindow)
      const parsed = quickCommandDraftSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '快速命令未通过校验，请检查字段后重试。' },
        })
      }
      return toResult(() => dependencies.quickCommands.createCommand(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsUpdate,
    (event, rawId: unknown, rawInput: unknown): Promise<OperationResult<QuickCommand>> => {
      assertTrustedSender(event, getWindow)
      const id = customQuickCommandIdSchema.safeParse(rawId)
      const input = quickCommandDraftSchema.safeParse(rawInput)
      if (!id.success || !input.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '快速命令未通过校验，请检查字段后重试。' },
        })
      }
      return toResult(() => dependencies.quickCommands.updateCommand(id.data, input.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsRemove,
    (event, rawId: unknown): Promise<OperationResult<{ id: string }>> => {
      assertTrustedSender(event, getWindow)
      const id = customQuickCommandIdSchema.safeParse(rawId)
      if (!id.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '命令 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.quickCommands.removeCommand(id.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsSetFavorite,
    (event, rawId: unknown, rawFavorite: unknown): Promise<OperationResult<QuickCommand>> => {
      assertTrustedSender(event, getWindow)
      const parsed = quickCommandFavoriteInputSchema.safeParse({
        id: rawId,
        favorite: rawFavorite,
      })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '收藏参数未通过校验。' },
        })
      }
      return toResult(() =>
        dependencies.quickCommands.setFavorite(parsed.data.id, parsed.data.favorite),
      )
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.quickCommandsExecute,
    (event, rawInput: unknown): Promise<OperationResult<QuickCommandExecuteAck>> => {
      assertTrustedSender(event, getWindow)
      const parsed = quickCommandExecuteInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '快速命令发送参数未通过校验，未发送任何内容。' },
        })
      }
      return toResult(() => dependencies.quickCommands.execute(parsed.data))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.commandHistoryList,
    (event): Promise<OperationResult<CommandHistorySnapshot>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.quickCommands.listHistory())
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.commandHistoryRemove,
    (event, rawId: unknown): Promise<OperationResult<{ id: string }>> => {
      assertTrustedSender(event, getWindow)
      const parsed = commandHistoryRemoveInputSchema.safeParse({ id: rawId })
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: { code: 'invalid-input', message: '历史记录 ID 格式无效。' },
        })
      }
      return toResult(() => dependencies.quickCommands.removeHistory(parsed.data.id))
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.commandHistoryClear,
    (event): Promise<OperationResult<CommandHistoryClearAck>> => {
      assertTrustedSender(event, getWindow)
      return toResult(() => dependencies.quickCommands.clearHistory())
    },
  )
}
