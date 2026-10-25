import * as fsp from 'node:fs/promises'
import type { LogExportAck, LogFolderAck, LogInfo } from '../../shared/types/logging'
import { AppOperationError } from '../errors'
import type { Logger } from './logger'

export interface LogServicePort {
  getInfo(): Promise<LogInfo>
  exportLogs(): Promise<LogExportAck>
  openFolder(): Promise<LogFolderAck>
}

export interface LogServiceDependencies {
  logger: Logger
  /** Native save dialog; returns an absolute path or null when cancelled. */
  pickExportPath: () => Promise<string | null>
  /** Opens the fixed log directory with the OS shell. */
  openDirectory: (directory: string) => Promise<boolean>
}

export class LogService implements LogServicePort {
  constructor(private readonly dependencies: LogServiceDependencies) {}

  getInfo(): Promise<LogInfo> {
    return this.dependencies.logger.getInfo()
  }

  async exportLogs(): Promise<LogExportAck> {
    const target = await this.dependencies.pickExportPath()
    if (!target) return { exported: false }

    try {
      const logger = this.dependencies.logger
      const text = await logger.readExportText()
      const header = [
        '# TermForge diagnostics export',
        `# exportedAt=${new Date().toISOString()}`,
        '# scope=redacted application logs (no credentials, terminal I/O or file contents)',
        '',
      ].join('\n')
      await fsp.writeFile(target, `${header}${text}`, { encoding: 'utf8', mode: 0o600 })
      logger.info('logs', 'export-completed', { bytes: Buffer.byteLength(text) })
      return { exported: true }
    } catch {
      throw new AppOperationError(
        'storage-write-failed',
        '无法导出诊断日志，请检查所选位置的写入权限。',
      )
    }
  }

  async openFolder(): Promise<LogFolderAck> {
    const opened = await this.dependencies.openDirectory(this.dependencies.logger.getDirectory())
    return { opened }
  }
}
