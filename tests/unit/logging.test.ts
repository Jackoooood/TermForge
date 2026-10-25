// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/logging/logger'
import { redactForLog, redactText } from '../../src/main/logging/redact'

describe('log redaction', () => {
  it('redacts private keys, assignments, authorization headers and URI credentials', () => {
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'abc123',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const text = [
      privateKey,
      'password=hunter2',
      'api_key: "sk-live-should-not-leak"',
      'Authorization: Bearer top-secret-token',
      'ssh://deploy:root-password@example.com:22',
    ].join('\n')

    const redacted = redactText(text)
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).not.toContain('sk-live-should-not-leak')
    expect(redacted).not.toContain('top-secret-token')
    expect(redacted).not.toContain('root-password')
    expect(redacted).toContain('[REDACTED]')
    expect(redacted).toContain('ssh://deploy:[REDACTED]@example.com')
  })

  it('redacts nested sensitive keys without dropping non-sensitive diagnostics', () => {
    const redacted = redactForLog({
      event: 'connect',
      connection: {
        host: '10.20.4.11',
        username: 'deploy',
        password: 'hunter2',
        privateKey: 'raw-key',
        passphrase: 'phrase',
        authorization: 'Bearer token',
      },
      notes: ['retry 1', { accessToken: 'abc' }],
    }) as Record<string, unknown>

    expect(redacted.event).toBe('connect')
    const connection = redacted.connection as Record<string, unknown>
    expect(connection).toMatchObject({
      host: '10.20.4.11',
      username: 'deploy',
      password: '[REDACTED]',
      privateKey: '[REDACTED]',
      passphrase: '[REDACTED]',
      authorization: '[REDACTED]',
    })
    const notes = redacted.notes as Array<Record<string, unknown> | string>
    expect(notes[0]).toBe('retry 1')
    expect((notes[1] as Record<string, unknown>).accessToken).toBe('[REDACTED]')
  })

  it('serializes errors with redacted messages, causes and circular references', () => {
    const root = new Error('login failed for password=hunter2') as Error & {
      cause?: unknown
      code?: string
    }
    root.code = 'AUTH_FAILED'
    const cause = new Error('nested api_key=secret')
    root.cause = cause
    const circular: Record<string, unknown> = { error: root }
    circular.self = circular

    const redacted = redactForLog(circular) as Record<string, unknown>
    const error = redacted.error as Record<string, unknown>
    expect(error).toMatchObject({ name: 'Error', code: 'AUTH_FAILED' })
    expect(String(error.message)).not.toContain('hunter2')
    expect(String((error.cause as Record<string, unknown>).message)).not.toContain('secret')
    expect(redacted.self).toBe('[circular]')
  })

  it('caps long strings, large arrays and excessive depth', () => {
    const redacted = redactForLog({
      long: 'x'.repeat(5_000),
      list: Array.from({ length: 150 }, (_, index) => index),
      nested: { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } },
    }) as Record<string, unknown>

    expect(String(redacted.long)).toContain('[truncated]')
    expect(String(redacted.long).length).toBeLessThan(2_100)
    const list = redacted.list as unknown[]
    expect(list).toHaveLength(101)
    expect(list.at(-1)).toBe('[truncated]')
    expect(JSON.stringify(redacted.nested)).toContain('[max-depth]')
  })
})

describe('logger', () => {
  let directory: string
  let logger: Logger | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'termforge-log-'))
  })

  afterEach(async () => {
    await logger?.flush().catch(() => undefined)
    logger = null
    await rm(directory, { recursive: true, force: true })
  })

  it('filters by level, writes redacted JSONL and reports file metadata', async () => {
    logger = new Logger({
      directory,
      level: 'info',
      now: () => new Date('2026-10-22T08:00:00.000Z'),
    })
    await logger.initialize()

    logger.debug('ssh', 'debug-detail', { step: 1 })
    logger.info('ssh', 'connected', {
      host: '10.20.4.11',
      password: 'hunter2',
      output: 'terminal output',
    })
    logger.error('ssh', 'failed', { error: new Error('auth failed for password=hunter2') })
    await logger.flush()

    const raw = await readFile(join(directory, 'termforge.log'), 'utf8')
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      timestamp: '2026-10-22T08:00:00.000Z',
      level: 'info',
      module: 'ssh',
      event: 'connected',
      host: '10.20.4.11',
      password: '[REDACTED]',
      output: '[REDACTED]',
    })
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('terminal output')

    const info = await logger.getInfo()
    expect(info.level).toBe('info')
    expect(info.directory).toBe(directory)
    expect(info.files.map((file) => file.name)).toEqual(['termforge.log'])
    expect(info.files[0]!.sizeBytes).toBeGreaterThan(0)
    expect(info.writeFailures).toBe(0)
  })

  it('rotates at the size limit and keeps the configured number of files', async () => {
    logger = new Logger({
      directory,
      level: 'debug',
      maxFileBytes: 64 * 1024,
      maxFiles: 3,
    })
    await logger.initialize()

    for (let index = 0; index < 50; index += 1) {
      logger.info('sftp', `entry-${index}`, { payload: 'y'.repeat(2_048) })
    }
    await logger.flush()

    const names = (await readdir(directory)).sort()
    expect(names).toContain('termforge.log')
    expect(names).toContain('termforge.1.log')
    expect(names.length).toBeLessThanOrEqual(3)
    expect(names).not.toContain('termforge.3.log')

    const info = await logger.getInfo()
    expect(info.files.length).toBeGreaterThan(1)
    expect(info.files.length).toBeLessThanOrEqual(3)
  })

  it('truncates oversized lines and never throws when the directory is unusable', async () => {
    const blocker = join(directory, 'not-a-directory')
    await writeFile(blocker, 'file', 'utf8')
    logger = new Logger({ directory: blocker, level: 'debug', maxFiles: 1 })

    expect(() =>
      logger!.info('app', 'oversized', {
        list: Array.from({ length: 100 }, () => 'z'.repeat(2_048)),
      }),
    ).not.toThrow()
    await expect(logger.flush()).resolves.toBeUndefined()

    const info = await logger.getInfo()
    expect(info.writeFailures).toBeGreaterThan(0)
    expect(info.files).toEqual([])
  })

  it('truncates a long physical line before writing it', async () => {
    logger = new Logger({ directory, level: 'debug' })
    await logger.initialize()
    logger.info('app', 'oversized-line', {
      list: Array.from({ length: 100 }, () => 'z'.repeat(2_048)),
    })
    await logger.flush()

    const raw = await readFile(join(directory, 'termforge.log'), 'utf8')
    expect(raw.length).toBeLessThan(2_000)
    expect(JSON.parse(raw.trim())).toMatchObject({ truncated: true, event: 'oversized-line' })
  })
})
