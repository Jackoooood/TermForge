import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FIXTURE_USER,
  HOME_PATH,
  createFixtureRoot,
  createHostKey,
  startFixtureSshServer,
} from './ssh-fixture-server.mjs'

const DEFAULT_OUT = resolve('release/acceptance/runtime')

function parseArgs(argv) {
  const args = { app: null, out: DEFAULT_OUT, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--app') args.app = resolve(argv[++index])
    else if (value === '--out') args.out = resolve(argv[++index])
    else if (value === '--keep') args.keep = true
  }
  if (!args.app) throw new Error('Missing --app <path to packaged TermForge.exe>')
  if (!existsSync(args.app)) throw new Error(`Packaged executable not found: ${args.app}`)
  return args
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

class CdpClient {
  constructor(webSocketUrl, label) {
    this.webSocketUrl = webSocketUrl
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl)
    await new Promise((resolveOpen, reject) => {
      const onOpen = () => {
        cleanup()
        resolveOpen()
      }
      const onError = (event) => {
        cleanup()
        reject(new Error(`${this.label} WebSocket error: ${String(event?.message ?? event)}`))
      }
      const cleanup = () => {
        this.socket.removeEventListener('open', onOpen)
        this.socket.removeEventListener('error', onError)
      }
      this.socket.addEventListener('open', onOpen)
      this.socket.addEventListener('error', onError)
    })
    this.socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data)
      if (!payload.id) return
      const pending = this.pending.get(payload.id)
      if (!pending) return
      this.pending.delete(payload.id)
      if (payload.error) pending.reject(new Error(JSON.stringify(payload.error)))
      else pending.resolve(payload.result ?? {})
    })
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${this.label} CDP socket closed before responding`))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label} CDP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveSend(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async evaluate(expression) {
    const wrapped = `(async () => {
      try {
        const value = await (${expression})
        return JSON.stringify({ ok: true, value })
      } catch (error) {
        return JSON.stringify({ ok: false, error: String((error && error.stack) || error) })
      }
    })()`
    const result = await this.send('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`Renderer exception: ${JSON.stringify(result.exceptionDetails)}`)
    }
    const text = result.result?.value
    if (typeof text !== 'string') {
      throw new Error(`Renderer evaluation returned ${JSON.stringify(result)}`)
    }
    const payload = JSON.parse(text)
    if (!payload.ok) throw new Error(payload.error)
    return payload.value
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // The socket may already be gone.
    }
  }
}

async function waitForCdpTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find(
          (target) => target.type === 'page' && String(target.url).includes('app.asar'),
        )
        if (page?.webSocketDebuggerUrl) return page
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`CDP target did not appear: ${String(lastError ?? 'timeout')}`)
}

async function captureScreenshot(cdp, outPath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(outPath, Buffer.from(result.data, 'base64'))
  return { path: outPath, bytes: statSync(outPath).size }
}

const PHASE_A = `(async () => {
  const api = window.termforge
  const PORT = __PORT__
  const PASSWORD = __PASSWORD__
  const RUN = __RUN__
  const expectedHome = __HOME__
  const results = []
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const must = (result, label) => {
    if (!result || result.ok !== true) {
      throw new Error(label + ' failed: ' + JSON.stringify(result))
    }
    return result.value
  }
  const waitFor = async (fn, timeoutMs, label) => {
    const started = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error('timeout: ' + label)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }

  const state = (globalThis.__tf = {
    statuses: [],
    challenges: [],
    outputs: {},
    terminalStatuses: [],
    terminalExits: [],
    transferUpdates: [],
  })
  api.ssh.onSessionStatus((event) => state.statuses.push(event.session))
  api.ssh.onHostKeyRequest((event) => state.challenges.push(event.challenge))
  api.terminal.onOutput((event) => {
    ;(state.outputs[event.sessionId] ||= []).push(event.data)
  })
  api.terminal.onStatus((event) => state.terminalStatuses.push(event))
  api.terminal.onExit((event) => state.terminalExits.push(event))
  api.transfer.onUpdate((event) => state.transferUpdates.push(event.task))

  const info = await api.getAppInfo()
  const security = await api.getSecurityStatus()
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  const baseline = {
    appInfo: info,
    security,
    protocol: location.protocol,
    href: location.href,
    title: document.title,
    csp: csp ? csp.getAttribute('content') : null,
    hasNodeRequire: typeof require !== 'undefined',
    hasNodeProcess: typeof process !== 'undefined',
    bodyTextLength: (document.body && document.body.innerText || '').length,
  }
  assert(baseline.protocol === 'file:', 'packaged renderer must use file://')
  assert(baseline.appInfo && baseline.appInfo.isPackaged === true, 'app.isPackaged must be true')
  assert(
    baseline.appInfo.appVersion === '0.1.0',
    'unexpected app version: ' + JSON.stringify(baseline.appInfo),
  )
  assert(baseline.csp && /script-src 'self'/.test(baseline.csp), 'CSP script-src self missing')
  assert(baseline.csp && /connect-src 'none'/.test(baseline.csp), 'CSP connect-src none missing')
  assert(baseline.hasNodeRequire === false, 'renderer unexpectedly exposes require')
  assert(baseline.bodyTextLength > 0, 'renderer body is empty')
  results.push({ id: 'packaged-baseline', status: 'passed', details: baseline })

  const catalog = must(await api.connections.list(), 'connections.list')
  const group = catalog.groups.find((item) => item.tone === 'local') || catalog.groups[0]
  assert(group, 'no connection group available')
  const created = must(
    await api.connections.create({
      name: 'Acceptance Local ' + RUN,
      host: '127.0.0.1',
      port: PORT,
      username: __USER__,
      authMethod: 'password',
      groupId: group.id,
      tags: ['acceptance', 'local'],
    }),
    'connections.create',
  )
  results.push({
    id: 'connection-create',
    status: 'passed',
    details: { id: created.id, name: created.name, groupId: created.groupId, tags: created.tags },
  })

  const credential = must(
    await api.ssh.saveCredential({ connectionId: created.id, kind: 'password', secret: PASSWORD }),
    'ssh.saveCredential',
  )
  results.push({ id: 'credential-save', status: 'passed', details: credential })

  const connectA = must(await api.ssh.connect(created.id, 'sshtab-accept-a'), 'ssh.connect A')
  let sessionA = connectA.session
  assert(sessionA.status === 'awaiting-host-key', 'first connection must await host key trust, got ' + sessionA.status)
  const challenge = await waitFor(
    () => state.challenges.find((item) => item.sessionId === sessionA.sessionId),
    5000,
    'host key challenge',
  )
  const ack = must(
    await api.ssh.respondToHostKey(challenge.requestId, true),
    'ssh.respondToHostKey',
  )
  assert(ack.accepted === true, 'host key was not accepted')
  sessionA = await waitFor(
    async () => {
      const status = must(await api.ssh.getStatus(sessionA.sessionId), 'ssh.getStatus A')
      return status.status === 'connected' ? status : null
    },
    15000,
    'session A connected',
  )
  results.push({
    id: 'host-key-first-trust',
    status: 'passed',
    details: {
      algorithm: challenge.algorithm,
      fingerprint: challenge.fingerprint,
      status: sessionA.status,
    },
  })

  const shellA = must(await api.terminal.open(sessionA.sessionId, { cols: 100, rows: 32 }), 'terminal.open A')
  assert(shellA.status === 'open', 'shell A did not open')
  const tokenA = 'TOKEN_A_' + RUN
  must(await api.terminal.write(sessionA.sessionId, 'echo ' + tokenA + '\\r'), 'terminal.write A')
  await waitFor(
    () => (state.outputs[sessionA.sessionId] || []).join('').includes(tokenA),
    6000,
    'terminal A output',
  )
  must(await api.terminal.resize(sessionA.sessionId, { cols: 120, rows: 40 }), 'terminal.resize A')
  const shellAStatus = must(await api.terminal.getStatus(sessionA.sessionId), 'terminal.getStatus A')
  assert(shellAStatus.size.cols === 120 && shellAStatus.size.rows === 40, 'terminal resize not reflected')
  results.push({
    id: 'terminal-a-echo-resize',
    status: 'passed',
    details: {
      sessionId: sessionA.sessionId,
      output: (state.outputs[sessionA.sessionId] || []).join('').slice(-200),
      size: shellAStatus.size,
    },
  })

  const connectB = must(await api.ssh.connect(created.id, 'sshtab-accept-b'), 'ssh.connect B')
  let sessionB = connectB.session
  sessionB = await waitFor(
    async () => {
      const status = must(await api.ssh.getStatus(sessionB.sessionId), 'ssh.getStatus B')
      return status.status === 'connected' ? status : null
    },
    15000,
    'session B connected',
  )
  assert(sessionB.sessionId !== sessionA.sessionId, 'two tabs must own distinct sessions')
  assert(connectB.reused === false, 'second tab must not reuse the first session')
  const shellB = must(await api.terminal.open(sessionB.sessionId, { cols: 90, rows: 28 }), 'terminal.open B')
  assert(shellB.status === 'open', 'shell B did not open')
  const tokenB = 'TOKEN_B_' + RUN
  must(await api.terminal.write(sessionB.sessionId, 'echo ' + tokenB + '\\r'), 'terminal.write B')
  await waitFor(
    () => (state.outputs[sessionB.sessionId] || []).join('').includes(tokenB),
    6000,
    'terminal B output',
  )
  const outputA = (state.outputs[sessionA.sessionId] || []).join('')
  const outputB = (state.outputs[sessionB.sessionId] || []).join('')
  assert(outputA.includes(tokenA), 'terminal A marker missing')
  assert(outputB.includes(tokenB), 'terminal B marker missing')
  assert(!outputA.includes(tokenB), 'terminal A leaked terminal B output')
  assert(!outputB.includes(tokenA), 'terminal B leaked terminal A output')
  results.push({
    id: 'terminal-multi-tab-isolation',
    status: 'passed',
    details: { sessionA: sessionA.sessionId, sessionB: sessionB.sessionId },
  })

  const sftp = must(await api.sftp.open(sessionA.sessionId), 'sftp.open')
  assert(sftp.homePath === expectedHome, 'unexpected SFTP home ' + sftp.homePath)
  let listing = must(await api.sftp.list(sessionA.sessionId, sftp.homePath), 'sftp.list home')
  const names = listing.entries.map((entry) => entry.name)
  assert(names.includes('alpha.txt'), 'alpha.txt missing from listing')
  assert(names.includes('测试 目录'), 'unicode directory missing from listing')
  assert(names.includes('space name.txt'), 'space file missing from listing')
  const alpha = must(await api.sftp.stat(sessionA.sessionId, sftp.homePath + '/alpha.txt'), 'sftp.stat alpha')
  assert(alpha.kind === 'file' && alpha.sizeBytes === __ALPHA_SIZE__, 'alpha metadata mismatch')
  const unicodeDir = must(
    await api.sftp.stat(sessionA.sessionId, sftp.homePath + '/测试 目录'),
    'sftp.stat unicode dir',
  )
  assert(unicodeDir.kind === 'directory', 'unicode entry is not a directory')

  const createdDir = must(
    await api.sftp.mkdir(sessionA.sessionId, sftp.homePath, '新建目录 A'),
    'sftp.mkdir',
  )
  listing = must(await api.sftp.list(sessionA.sessionId, sftp.homePath), 'sftp.list after mkdir')
  assert(listing.entries.some((entry) => entry.name === '新建目录 A' && entry.kind === 'directory'), 'mkdir not listed')
  const renamedPath = sftp.homePath + '/重命名 目录'
  must(
    await api.sftp.rename(sessionA.sessionId, createdDir.path, renamedPath),
    'sftp.rename',
  )
  listing = must(await api.sftp.list(sessionA.sessionId, sftp.homePath), 'sftp.list after rename')
  assert(listing.entries.some((entry) => entry.name === '重命名 目录'), 'rename not listed')
  assert(!listing.entries.some((entry) => entry.name === '新建目录 A'), 'old directory name still listed')
  must(await api.sftp.removeDirectory(sessionA.sessionId, renamedPath), 'sftp.removeDirectory')
  must(
    await api.sftp.deleteFile(sessionA.sessionId, sftp.homePath + '/temp-delete.txt'),
    'sftp.deleteFile',
  )
  listing = must(await api.sftp.list(sessionA.sessionId, sftp.homePath), 'sftp.list final')
  assert(!listing.entries.some((entry) => entry.name === '重命名 目录'), 'removed directory still listed')
  assert(!listing.entries.some((entry) => entry.name === 'temp-delete.txt'), 'deleted file still listed')
  const closeSftp = must(await api.sftp.close(sessionA.sessionId), 'sftp.close')
  assert(closeSftp.closed === true, 'sftp.close did not report closed')
  results.push({
    id: 'sftp-browse-mutate-unicode',
    status: 'passed',
    details: { homePath: sftp.homePath, entries: names, alphaBytes: alpha.sizeBytes },
  })

  must(await api.terminal.close(sessionA.sessionId), 'terminal.close A')
  must(await api.terminal.close(sessionB.sessionId), 'terminal.close B')
  const disconnectedA = must(await api.ssh.disconnect(sessionA.sessionId), 'ssh.disconnect A')
  const disconnectedB = must(await api.ssh.disconnect(sessionB.sessionId), 'ssh.disconnect B')
  assert(disconnectedA.status === 'disconnected', 'session A not disconnected')
  assert(disconnectedB.status === 'disconnected', 'session B not disconnected')
  results.push({
    id: 'graceful-session-close',
    status: 'passed',
    details: {
      terminalExits: state.terminalExits.length,
      statuses: state.statuses.map((item) => item.status).slice(-8),
    },
  })

  const summary = {
    connectionId: created.id,
    groupId: group.id,
    firstFingerprint: challenge.fingerprint,
    sessionA: sessionA.sessionId,
    sessionB: sessionB.sessionId,
  }
  Object.assign(state, summary)
  return { results, state: summary }
})()`

const PHASE_C = `(async () => {
  const api = window.termforge
  const state = globalThis.__tf
  const results = []
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const must = (result, label) => {
    if (!result || result.ok !== true) throw new Error(label + ' failed: ' + JSON.stringify(result))
    return result.value
  }
  const waitFor = async (fn, timeoutMs, label) => {
    const started = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error('timeout: ' + label)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }

  const changed = await api.ssh.connect(state.connectionId, 'sshtab-accept-c')
  if (changed.ok !== true) {
    results.push({
      id: 'phase-c-state-diagnostics',
      status: 'failed',
      details: {
        hasState: Boolean(state),
        connectionId: state && state.connectionId,
        connectionIdType: state && typeof state.connectionId,
        stateKeys: state ? Object.keys(state) : [],
        error: changed.error,
      },
    })
    return { results, fatal: true }
  }
  assert(changed.value.session.status === 'error', 'changed key did not fail the session')
  assert(
    changed.value.session.error && changed.value.session.error.code === 'host-key-changed',
    'expected host-key-changed, got ' + JSON.stringify(changed.value.session.error),
  )
  const hostKeys = must(await api.hostKeys.list(), 'hostKeys.list')
  const stored = hostKeys.find((item) => item.port === __PORT__ && item.host === '127.0.0.1')
  assert(stored, 'trusted host key record missing')
  assert(stored.fingerprint === state.firstFingerprint, 'stored fingerprint changed unexpectedly')
  results.push({
    id: 'host-key-change-rejected',
    status: 'passed',
    details: { error: changed.value.session.error, storedFingerprint: stored.fingerprint },
  })

  const removal = must(await api.hostKeys.remove('127.0.0.1', __PORT__), 'hostKeys.remove')
  assert(removal.removed === true, 'host key was not removed')
  const challengesBefore = state.challenges.length
  const retrust = must(await api.ssh.connect(state.connectionId, 'sshtab-accept-d'), 'ssh.connect D')
  assert(retrust.session.status === 'awaiting-host-key', 're-trust did not request host key confirmation')
  const challenge = await waitFor(
    () => state.challenges.slice(challengesBefore).find((item) => item.sessionId === retrust.session.sessionId),
    5000,
    're-trust challenge',
  )
  assert(challenge.fingerprint !== state.firstFingerprint, 'new host key fingerprint matches old key')
  must(await api.ssh.respondToHostKey(challenge.requestId, true), 'host key re-trust response')
  const reconnected = await waitFor(
    async () => {
      const status = must(await api.ssh.getStatus(retrust.session.sessionId), 'getStatus re-trust')
      return status.status === 'connected' ? status : null
    },
    15000,
    're-trusted session connected',
  )
  await api.ssh.disconnect(reconnected.sessionId)
  results.push({
    id: 'host-key-remove-retrust',
    status: 'passed',
    details: {
      removedFingerprint: stored.fingerprint,
      newFingerprint: challenge.fingerprint,
      algorithm: challenge.algorithm,
    },
  })

  const settings = must(await api.settings.get(), 'settings.get')
  const updated = must(
    await api.settings.update({
      ...settings.preferences,
      theme: 'mist',
      terminalFontSize: 16,
      terminalCursorStyle: 'bar',
      terminalCursorBlink: false,
    }),
    'settings.update',
  )
  assert(updated.preferences.theme === 'mist', 'theme update not reflected')
  assert(updated.preferences.terminalFontSize === 16, 'font size update not reflected')
  const reread = must(await api.settings.get(), 'settings.get after update')
  assert(reread.preferences.terminalCursorStyle === 'bar', 'cursor style not persisted in memory')
  results.push({
    id: 'settings-update',
    status: 'passed',
    details: {
      theme: reread.preferences.theme,
      terminalFontSize: reread.preferences.terminalFontSize,
      terminalCursorStyle: reread.preferences.terminalCursorStyle,
    },
  })

  const transfers = must(await api.transfer.list(), 'transfer.list')
  const cleared = must(await api.transfer.clearHistory(), 'transfer.clearHistory')
  results.push({
    id: 'transfer-ipc-baseline',
    status: 'passed',
    details: { initialTasks: transfers.length, cleared },
    limitation: 'Upload/download dialogs are not automated; transfer streaming is covered by unit tests only.',
  })

  const logs = must(await api.logs.getInfo(), 'logs.getInfo')
  results.push({ id: 'logs-info', status: 'passed', details: logs })

  return { results, state: { newFingerprint: challenge.fingerprint } }
})()`

const PHASE_E = `(async () => {
  const api = window.termforge
  const results = []
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const must = (result, label) => {
    if (!result || result.ok !== true) throw new Error(label + ' failed: ' + JSON.stringify(result))
    return result.value
  }
  const waitFor = async (fn, timeoutMs, label) => {
    const started = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - started > timeoutMs) throw new Error('timeout: ' + label)
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  }

  const state = (globalThis.__tf = { challenges: [], statuses: [], outputs: {} })
  api.ssh.onHostKeyRequest((event) => state.challenges.push(event.challenge))
  api.ssh.onSessionStatus((event) => state.statuses.push(event.session))
  api.terminal.onOutput((event) => {
    ;(state.outputs[event.sessionId] ||= []).push(event.data)
  })

  const info = await api.getAppInfo()
  assert(info.isPackaged === true, 'restarted app is not packaged')
  const catalog = must(await api.connections.list(), 'connections.list after restart')
  const connection = catalog.connections.find((item) => item.name === __CONNECTION_NAME__)
  assert(connection, 'acceptance connection did not persist')
  const settings = must(await api.settings.get(), 'settings.get after restart')
  assert(settings.preferences.theme === 'mist', 'theme did not persist')
  assert(settings.preferences.terminalFontSize === 16, 'font size did not persist')
  assert(settings.preferences.terminalCursorStyle === 'bar', 'cursor style did not persist')
  const hostKeys = must(await api.hostKeys.list(), 'hostKeys.list after restart')
  const stored = hostKeys.find((item) => item.host === '127.0.0.1' && item.port === __PORT__)
  assert(stored, 'host key did not persist')
  assert(stored.fingerprint === __NEW_FINGERPRINT__, 'persisted host key fingerprint mismatch')
  const transfers = must(await api.transfer.list(), 'transfer.list after restart')
  assert(Array.isArray(transfers), 'transfer list is not an array')
  const logs = must(await api.logs.getInfo(), 'logs.getInfo after restart')
  results.push({
    id: 'restart-persistence',
    status: 'passed',
    details: {
      connection: connection.name,
      theme: settings.preferences.theme,
      fontSize: settings.preferences.terminalFontSize,
      fingerprint: stored.fingerprint,
      transferTasks: transfers.length,
      logDirectory: logs.directory,
    },
  })

  const connected = must(
    await api.ssh.connect(connection.id, 'sshtab-accept-persist'),
    'ssh.connect after restart',
  )
  let session = connected.session
  session = await waitFor(
    async () => {
      const status = must(await api.ssh.getStatus(session.sessionId), 'getStatus after restart')
      return status.status === 'connected' ? status : null
    },
    20000,
    'trusted reconnect',
  )
  assert(state.challenges.length === 0, 'trusted host unexpectedly prompted again')
  const shell = must(await api.terminal.open(session.sessionId, { cols: 80, rows: 24 }), 'terminal.open after restart')
  assert(shell.status === 'open', 'shell did not open after restart')
  const token = 'TOKEN_RESTART_' + __RUN__
  must(await api.terminal.write(session.sessionId, 'echo ' + token + '\\r'), 'terminal.write after restart')
  await waitFor(
    () => (state.outputs[session.sessionId] || []).join('').includes(token),
    6000,
    'terminal output after restart',
  )
  results.push({
    id: 'trusted-reconnect-terminal',
    status: 'passed',
    details: { sessionId: session.sessionId, challenges: state.challenges.length },
  })
  must(await api.terminal.close(session.sessionId), 'terminal.close after restart')
  await api.ssh.disconnect(session.sessionId)
  return { results }
})()`

function renderPhase(template, values) {
  let source = template
  for (const [key, value] of Object.entries(values)) {
    source = source.replaceAll(`__${key}__`, JSON.stringify(value))
  }
  return source
}

function inspectUserData(userDataDir, secrets) {
  const files = [
    'settings.json',
    'connections.json',
    'credentials.enc.json',
    'known-hosts.json',
    'transfer-journal.json',
  ]
  const report = { files: {}, leaks: [] }
  for (const relative of files) {
    const path = join(userDataDir, relative)
    if (!existsSync(path)) {
      report.files[relative] = { exists: false }
      continue
    }
    const text = readFileSync(path, 'utf8')
    report.files[relative] = {
      exists: true,
      bytes: statSync(path).size,
      sha256: sha256File(path),
      containsSecret: secrets.some((secret) => text.includes(secret)),
    }
    for (const secret of secrets) {
      if (text.includes(secret)) report.leaks.push({ file: relative, kind: 'secret' })
    }
  }
  const logPath = join(userDataDir, 'logs', 'termforge.log')
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, 'utf8')
    report.log = {
      exists: true,
      bytes: statSync(logPath).size,
      containsSecret: secrets.some((secret) => text.includes(secret)),
      containsTerminalOutput: /TOKEN_[AB]_|TOKEN_RESTART_/.test(text),
      lines: text.trim().split(/\r?\n/).length,
    }
    for (const secret of secrets) {
      if (text.includes(secret)) report.leaks.push({ file: 'logs/termforge.log', kind: 'secret' })
    }
    if (report.log.containsTerminalOutput) {
      report.leaks.push({ file: 'logs/termforge.log', kind: 'terminal-output' })
    }
  } else {
    report.log = { exists: false }
  }
  const extras = readdirSync(userDataDir).filter((name) =>
    /^profile|Preferences|Local Storage|Session Storage|Network$/.test(name),
  )
  report.extraEntries = extras
  return report
}

async function launchAndConnect({ app, userDataDir, debugPort, outDir, tag }) {
  const stdoutPath = join(outDir, `app-${tag}.stdout.log`)
  const stderrPath = join(outDir, `app-${tag}.stderr.log`)
  const child = spawn(
    app,
    [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${debugPort}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
  )
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.on('exit', () => {
    writeFileSync(stdoutPath, Buffer.concat(stdout))
    writeFileSync(stderrPath, Buffer.concat(stderr))
  })

  const target = await waitForCdpTarget(debugPort, 30000)
  const cdp = new CdpClient(target.webSocketDebuggerUrl, tag)
  await cdp.connect()
  await cdp.send('Page.enable')
  await cdp.evaluate(`(async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (window.termforge) return true
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    throw new Error('preload bridge not available')
  })()`)
  return { child, cdp, stdoutPath, stderrPath }
}

async function gracefulClose(child, cdp, timeoutMs = 15000) {
  try {
    // The app exits before CDP can answer, so this request is expected to fail.
    await cdp.send('Browser.close', {}, 5000)
  } catch {
    // Fall through to the OS-level close request below.
  }
  let exited = await waitForExit(child, timeoutMs)
  if (!exited && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid)], { windowsHide: true })
    exited = await waitForExit(child, 8000)
  }
  if (!exited && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    exited = await waitForExit(child, 5000)
  }
  return exited
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runId = timestamp()
  const outDir = join(args.out, runId)
  mkdirSync(outDir, { recursive: true })
  const workDir = mkdtempSync(join(tmpdir(), 'termforge-runtime-'))
  const userDataDir = join(workDir, 'user-data')
  const fixtureRoot = createFixtureRoot(join(workDir, 'fixtures'))
  mkdirSync(userDataDir, { recursive: true })
  const password = `Acceptance-${randomUUID()}`
  const report = {
    generatedAt: new Date().toISOString(),
    app: args.app,
    appSha256: sha256File(args.app),
    userDataDir,
    fixtureRoot,
    sshServer: null,
    checks: [],
    limitations: [
      'This acceptance drives the packaged renderer through the Chrome DevTools Protocol; it does not click every UI control.',
      'The SSH/SFTP server is a local ssh2 fixture, not Windows OpenSSH Server; PTY behavior is simplified.',
      'Installer install/uninstall/upgrade, signing and clean-VM checks are not executed by this harness.',
      'Upload/download dialogs are not automated; transfer streaming is covered by unit tests only.',
    ],
  }
  const secrets = [password]
  let hostKey = createHostKey()
  let server = await startFixtureSshServer({
    hostKey,
    rootDir: fixtureRoot,
    password,
    port: await getFreePort(),
  })
  report.sshServer = { port: server.port, user: FIXTURE_USER, home: HOME_PATH }
  const debugPort = await getFreePort()
  console.log(`STEP fixture-ready sshPort=${server.port} cdpPort=${debugPort}`)

  let first = null
  let second = null
  let cdp = null
  try {
    first = await launchAndConnect({
      app: args.app,
      userDataDir,
      debugPort,
      outDir,
      tag: 'phase-a',
    })
    cdp = first.cdp
    report.screenshotInitial = await captureScreenshot(cdp, join(outDir, 'initial-window.png'))
    const phaseA = await cdp.evaluate(
      renderPhase(PHASE_A, {
        PORT: server.port,
        PASSWORD: password,
        RUN: runId,
        USER: FIXTURE_USER,
        HOME: HOME_PATH,
        ALPHA_SIZE: Buffer.byteLength('alpha fixture\n'),
      }),
    )
    report.checks.push(...phaseA.results)
    report.phaseAState = phaseA.state
    report.screenshotAfterSftp = await captureScreenshot(cdp, join(outDir, 'after-sftp.png'))
    writeFileSync(join(outDir, 'phase-a.json'), JSON.stringify(phaseA, null, 2))
    console.log(`STEP phase-a-complete checks=${phaseA.results.length}`)

    const userDataAfterPhaseA = inspectUserData(userDataDir, secrets)
    report.userDataAfterPhaseA = userDataAfterPhaseA

    await server.close()
    hostKey = createHostKey()
    server = await startFixtureSshServer({
      hostKey,
      rootDir: fixtureRoot,
      password,
      port: report.sshServer.port,
    })
    console.log('STEP ssh-host-key-rotated')

    const phaseC = await cdp.evaluate(
      renderPhase(PHASE_C, {
        PORT: report.sshServer.port,
      }),
    )
    report.checks.push(...phaseC.results)
    report.phaseCState = phaseC.state
    writeFileSync(join(outDir, 'phase-c.json'), JSON.stringify(phaseC, null, 2))
    console.log(`STEP phase-c-complete checks=${phaseC.results.length}`)
    if (phaseC.fatal) throw new Error('phase C stopped after a failed connect')
    report.userDataBeforeRestart = inspectUserData(userDataDir, secrets)

    const closed = await gracefulClose(first.child, cdp)
    writeFileSync(join(outDir, 'phase-a.stdout.log'), readFileSync(first.stdoutPath))
    writeFileSync(join(outDir, 'phase-a.stderr.log'), readFileSync(first.stderrPath))
    report.firstLaunchExited = closed
    first = null
    cdp = null
    if (!closed) throw new Error('first packaged instance did not exit gracefully')
    console.log('STEP first-instance-exited')

    const restartDebugPort = await getFreePort()
    second = await launchAndConnect({
      app: args.app,
      userDataDir,
      debugPort: restartDebugPort,
      outDir,
      tag: 'phase-e',
    })
    console.log('STEP second-instance-ready')
    report.screenshotRestart = await captureScreenshot(
      second.cdp,
      join(outDir, 'restart-window.png'),
    )
    const phaseE = await second.cdp.evaluate(
      renderPhase(PHASE_E, {
        PORT: report.sshServer.port,
        CONNECTION_NAME: `Acceptance Local ${runId}`,
        NEW_FINGERPRINT: phaseC.state.newFingerprint,
        RUN: runId,
      }),
    )
    report.checks.push(...phaseE.results)
    writeFileSync(join(outDir, 'phase-e.json'), JSON.stringify(phaseE, null, 2))
    console.log(`STEP phase-e-complete checks=${phaseE.results.length}`)
    report.userDataAfterRestart = inspectUserData(userDataDir, secrets)
    const secondClosed = await gracefulClose(second.child, second.cdp)
    writeFileSync(join(outDir, 'phase-e.stdout.log'), readFileSync(second.stdoutPath))
    writeFileSync(join(outDir, 'phase-e.stderr.log'), readFileSync(second.stderrPath))
    report.secondLaunchExited = secondClosed
    second = null

    const failed = report.checks.filter((check) => check.status !== 'passed')
    const leakCount =
      (report.userDataAfterPhaseA.leaks || []).length +
      (report.userDataBeforeRestart.leaks || []).length +
      (report.userDataAfterRestart.leaks || []).length
    report.summary = {
      checks: report.checks.length,
      failed: failed.length,
      secretOrTerminalLeaks: leakCount,
      status:
        failed.length === 0 && leakCount === 0 && closed && secondClosed ? 'passed' : 'failed',
    }
  } catch (error) {
    report.error = String(error?.stack ?? error)
    report.summary = {
      checks: report.checks.length,
      failed: report.checks.filter((check) => check.status !== 'passed').length + 1,
      status: 'failed',
    }
  } finally {
    if (first) {
      try {
        cdp?.close()
      } catch {
        // Best-effort cleanup.
      }
      if (first.child.exitCode === null && first.child.pid) {
        spawnSync('taskkill', ['/PID', String(first.child.pid), '/T', '/F'], { windowsHide: true })
      }
      await waitForExit(first.child, 5000)
    }
    if (second) {
      try {
        second.cdp.close()
      } catch {
        // Best-effort cleanup.
      }
      if (second.child.exitCode === null && second.child.pid) {
        spawnSync('taskkill', ['/PID', String(second.child.pid), '/T', '/F'], { windowsHide: true })
      }
      await waitForExit(second.child, 5000)
    }
    await server.close()
    writeFileSync(join(outDir, 'runtime-report.json'), JSON.stringify(report, null, 2))
    writeFileSync(
      join(outDir, 'runtime-report.log'),
      [
        `TermForge packaged runtime acceptance ${report.generatedAt}`,
        `app=${args.app}`,
        `sha256=${report.appSha256}`,
        `status=${report.summary?.status ?? 'unknown'}`,
        ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.id}`),
        ...(report.error ? [`ERROR ${report.error}`] : []),
        `report=${join(outDir, 'runtime-report.json')}`,
      ].join('\n') + '\n',
    )
    if (!args.keep) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // Keep temp artifacts if a handle is still open.
      }
    }
  }
  console.log(JSON.stringify(report.summary))
  console.log(`REPORT=${join(outDir, 'runtime-report.json')}`)
  if (report.summary?.status !== 'passed') process.exitCode = 1
}

await main()
const exitCode = process.exitCode ?? 0
setTimeout(() => process.exit(exitCode), 250)
