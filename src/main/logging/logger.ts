import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_LOG_FILES, MAX_LOG_FILE_BYTES } from '../../shared/constants/app'
import {
  LOG_LEVEL_RANK,
  type LogFileInfo,
  type LogInfo,
  type LogLevel,
} from '../../shared/types/logging'
import { redactForLog, redactText } from './redact'

const CURRENT_LOG_NAME = 'termforge.log'
const ROTATED_LOG_NAME = /^termforge(?:\.(\d+))?\.log$/
const MAX_EXPORT_BYTES = 20 * 1024 * 1024
const MAX_LINE_LENGTH = 16 * 1024

export interface LoggerOptions {
  directory: string
  level?: LogLevel
  maxFileBytes?: number
  maxFiles?: number
  now?: () => Date
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  module: string
  event: string
  [key: string]: unknown
}

function shortToken(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || fallback
}

/**
 * Process-wide structured logger. Writes JSON lines under an Electron userData
 * subdirectory, rotates by size, and never throws into SSH/SFTP/transfer paths.
 * All metadata is deep-redacted before serialization.
 */
export class Logger {
  private level: LogLevel
  private readonly directory: string
  private readonly maxFileBytes: number
  private readonly maxFiles: number
  private readonly now: () => Date
  private readonly recent: LogEntry[] = []
  private currentBytes = 0
  private writeFailures = 0
  private writeChain: Promise<void> = Promise.resolve()
  private readonly initialized: Promise<void>

  constructor(options: LoggerOptions) {
    this.directory = options.directory
    this.level = options.level ?? 'info'
    this.maxFileBytes = Math.max(64 * 1024, options.maxFileBytes ?? MAX_LOG_FILE_BYTES)
    this.maxFiles = Math.max(1, options.maxFiles ?? MAX_LOG_FILES)
    this.now = options.now ?? (() => new Date())
    this.initialized = this.initializeDirectory()
  }

  initialize(): Promise<void> {
    return this.initialized
  }

  getLevel(): LogLevel {
    return this.level
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getDirectory(): string {
    return this.directory
  }

  getWriteFailures(): number {
    return this.writeFailures
  }

  recentEntries(): LogEntry[] {
    return this.recent.map((entry) => ({ ...entry }))
  }

  error(module: string, event: string, details?: Record<string, unknown>): void {
    this.write('error', module, event, details)
  }

  warn(module: string, event: string, details?: Record<string, unknown>): void {
    this.write('warn', module, event, details)
  }

  info(module: string, event: string, details?: Record<string, unknown>): void {
    this.write('info', module, event, details)
  }

  debug(module: string, event: string, details?: Record<string, unknown>): void {
    this.write('debug', module, event, details)
  }

  async flush(): Promise<void> {
    await this.initialized
    await this.writeChain
  }

  async getInfo(): Promise<LogInfo> {
    await this.flush()
    let files: LogFileInfo[] = []
    try {
      const names = (await fsp.readdir(this.directory)).filter((name) =>
        ROTATED_LOG_NAME.test(name),
      )
      files = await Promise.all(
        names.map(async (name) => {
          try {
            const stats = await fsp.stat(join(this.directory, name))
            return {
              name,
              sizeBytes: stats.size,
              modifiedAt: stats.mtime.toISOString(),
            }
          } catch {
            return { name, sizeBytes: 0, modifiedAt: new Date(0).toISOString() }
          }
        }),
      )
    } catch {
      files = []
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    return {
      directory: this.directory,
      level: this.level,
      files,
      writeFailures: this.writeFailures,
    }
  }

  /** Returns already-redacted log text for a user-initiated diagnostics export. */
  async readExportText(): Promise<string> {
    await this.flush()
    let names: string[]
    try {
      names = (await fsp.readdir(this.directory)).filter((name) => ROTATED_LOG_NAME.test(name))
    } catch {
      return ''
    }

    names.sort((a, b) => {
      const indexA = Number(ROTATED_LOG_NAME.exec(a)?.[1] ?? 0)
      const indexB = Number(ROTATED_LOG_NAME.exec(b)?.[1] ?? 0)
      return indexB - indexA
    })

    const chunks: string[] = []
    let total = 0
    for (const name of names) {
      try {
        const raw = await fsp.readFile(join(this.directory, name), 'utf8')
        const remaining = MAX_EXPORT_BYTES - total
        if (remaining <= 0) break
        const chunk = raw.slice(-remaining)
        total += chunk.length
        chunks.push(redactText(chunk))
        if (total >= MAX_EXPORT_BYTES) break
      } catch {
        continue
      }
    }
    return chunks.join('')
  }

  private write(
    level: LogLevel,
    module: string,
    event: string,
    details?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_RANK[level] > LOG_LEVEL_RANK[this.level]) return

    const entry: LogEntry = {
      timestamp: this.now().toISOString(),
      level,
      module: shortToken(module, 'app'),
      event: shortToken(event, 'event'),
    }
    if (details) {
      const redacted = redactForLog(details)
      if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        Object.assign(entry, redacted)
      } else {
        entry.details = redacted
      }
    }

    let line = JSON.stringify(entry)
    if (line.length > MAX_LINE_LENGTH) {
      line = JSON.stringify({
        timestamp: entry.timestamp,
        level,
        module: entry.module,
        event: entry.event,
        truncated: true,
      })
    }

    this.recent.push(entry)
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200)

    this.writeChain = this.writeChain.then(() => this.appendLine(line))
  }

  private async initializeDirectory(): Promise<void> {
    try {
      await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const stats = await fsp.stat(join(this.directory, CURRENT_LOG_NAME)).catch(() => null)
      this.currentBytes = stats?.size ?? 0
    } catch {
      this.writeFailures += 1
    }
  }

  private async appendLine(line: string): Promise<void> {
    try {
      if (this.currentBytes > 0 && this.currentBytes + line.length > this.maxFileBytes) {
        await this.rotate()
      }
      await fsp.appendFile(join(this.directory, CURRENT_LOG_NAME), `${line}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      this.currentBytes += Buffer.byteLength(line) + 1
    } catch {
      this.writeFailures += 1
    }
  }

  private async rotate(): Promise<void> {
    const currentPath = join(this.directory, CURRENT_LOG_NAME)
    if (this.maxFiles <= 1) {
      await fsp.rm(currentPath, { force: true }).catch(() => undefined)
      this.currentBytes = 0
      return
    }

    await fsp
      .rm(join(this.directory, `termforge.${this.maxFiles - 1}.log`), { force: true })
      .catch(() => undefined)
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await fsp
        .rename(
          join(this.directory, `termforge.${index}.log`),
          join(this.directory, `termforge.${index + 1}.log`),
        )
        .catch(() => undefined)
    }
    await fsp.rename(currentPath, join(this.directory, 'termforge.1.log')).catch(() => undefined)
    this.currentBytes = 0
  }
}
