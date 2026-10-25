import { spawn } from 'node:child_process'
import {
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
  createFixtureRoot,
  createHostKey,
  startFixtureSshServer,
} from './ssh-fixture-server.mjs'

const REPO_ROOT = resolve('.')
const ELECTRON = resolve('node_modules/electron/dist/electron.exe')
const OUT_DIR = resolve('release/acceptance/p1-05-split-reconnect')
const PASSWORD = 'p1-05-accept-password'
const REPLAY_MARKER = 'TF_P105_NO_REPLAY'
const RUN = Date.now().toString(36)

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
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
          (target) =>
            target.type === 'page' &&
            !String(target.url).startsWith('devtools://') &&
            target.webSocketDebuggerUrl,
        )
        if (page) return page
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`CDP target did not appear: ${String(lastError ?? 'timeout')}`)
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await cdp.evaluate(expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(100)
  }
  throw new Error(
    `timeout: ${label}${lastError ? ` (${String(lastError.message ?? lastError)})` : ''}`,
  )
}

const HELPERS = `(() => {
  const textOf = (el) => ((el && el.textContent) || '').replace(/\\s+/g, ' ').trim()
  const setControlValue = (control, value) => {
    const prototype =
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const latestFor = (tabId) => window.__p105?.latest?.[tabId] ?? null
  window.__p105Help = {
    textOf,
    button(text, root = document) {
      return [...root.querySelectorAll('button')].find((el) => textOf(el) === text) ?? null
    },
    clickButton(text, root = document) {
      const button = this.button(text, root)
      if (!button) throw new Error('button not found: ' + text)
      button.click()
      return true
    },
    clickAria(label, root = document) {
      const el = root.querySelector('[aria-label="' + CSS.escape(label) + '"]')
      if (!el) throw new Error('aria-label not found: ' + label)
      el.click()
      return true
    },
    clickLabelPrefix(prefix, root = document) {
      const el = [...root.querySelectorAll('[aria-label]')].find((node) =>
        String(node.getAttribute('aria-label')).startsWith(prefix),
      )
      if (!el) throw new Error('aria-label prefix not found: ' + prefix)
      el.click()
      return true
    },
    clickTitle(title, root = document) {
      const el = [...root.querySelectorAll('[title]')].find(
        (node) => node.getAttribute('title') === title,
      )
      if (!el) throw new Error('title not found: ' + title)
      el.click()
      return true
    },
    clickTab(tabId) {
      const tab = document.getElementById('session-tab-' + tabId)
      if (!tab) throw new Error('tab not found: ' + tabId)
      tab.click()
      return true
    },
    closeTab(tabId) {
      const button = document.querySelector(
        '#session-tab-' + CSS.escape(tabId) + ' .session-tab__close',
      )
      if (!button) throw new Error('tab close button not found: ' + tabId)
      button.click()
      return true
    },
    tabs() {
      return [...document.querySelectorAll('.session-tab')].map((el) => ({
        tabId: el.id.replace('session-tab-', ''),
        title: textOf(el.querySelector('.session-tab__label')),
        active: el.getAttribute('aria-selected') === 'true',
        shellOpen: !!el.querySelector('.session-tab__shell'),
        pane: textOf(el.querySelector('.session-tab__pane')),
      }))
    },
    panel(tabId) {
      return document.getElementById('terminal-panel-' + tabId)
    },
    xtermCount(tabId) {
      const panel = this.panel(tabId)
      return panel ? panel.querySelectorAll('.terminal-xterm').length : 0
    },
    visiblePanes() {
      return [...document.querySelectorAll('.terminal-pane--visible')].map((el) => ({
        id: el.id,
        slots: [...el.classList].filter((name) => name.startsWith('terminal-pane--slot-')),
        focused: el.classList.contains('terminal-pane--focused'),
        xterms: el.querySelectorAll('.terminal-xterm').length,
      }))
    },
    stage() {
      const el = document.querySelector('.terminal-stage')
      if (!el) return null
      return {
        className: el.className,
        ratio: getComputedStyle(el).getPropertyValue('--split-ratio').trim(),
      }
    },
    divider() {
      const el = document.querySelector('[role="separator"][aria-label="调整分屏比例"]')
      if (!el) return null
      return {
        value: el.getAttribute('aria-valuenow'),
        orientation: el.getAttribute('aria-orientation'),
      }
    },
    pressDivider(key) {
      const el = document.querySelector('[role="separator"][aria-label="调整分屏比例"]')
      if (!el) throw new Error('divider not found')
      el.focus()
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      return true
    },
    notice(tabId) {
      const panel = this.panel(tabId)
      const el = panel?.querySelector('.terminal-auto-reconnect')
      if (!el) return null
      return {
        text: textOf(el),
        exhausted: el.classList.contains('terminal-auto-reconnect--exhausted'),
        button: textOf(el.querySelector('button')),
      }
    },
    notices() {
      return [...document.querySelectorAll('.terminal-auto-reconnect')].map((el) => textOf(el))
    },
    clickNoticeButton(tabId) {
      const panel = this.panel(tabId)
      const button = panel?.querySelector('.terminal-auto-reconnect button')
      if (!button) throw new Error('auto reconnect button not found: ' + tabId)
      button.click()
      return true
    },
    unbindPane(tabId) {
      const panel = this.panel(tabId)
      const button = panel?.querySelector('[aria-label^="将 "]')
      if (!button) throw new Error('pane unbind button not found: ' + tabId)
      button.click()
      return true
    },
    emptyPaneSelect(label) {
      return document.querySelector(
        'section[aria-label="' + CSS.escape(label) + '"] select',
      )
    },
    setSelect(label, value) {
      const select = this.emptyPaneSelect(label)
      if (!select) throw new Error('empty pane select not found: ' + label)
      setControlValue(select, value)
      return select.value
    },
    async shellReady(tabId) {
      const latest = latestFor(tabId)
      if (!latest || latest.status !== 'connected') return null
      const result = await window.termforge.terminal.getStatus(latest.sessionId)
      return result.ok && result.value.status === 'open' ? latest.sessionId : null
    },
    latest(tabId) {
      return latestFor(tabId)
    },
    output(sessionId) {
      return (window.__p105?.outputs?.[sessionId] || []).join('')
    },
    allOutput() {
      return Object.values(window.__p105?.outputs ?? {}).join('')
    },
    failuresFor(tabId) {
      const rows = (window.__p105?.statuses ?? []).filter((item) => item.clientId === tabId)
      return rows.map((item) => ({
        status: item.status,
        code: item.error?.code ?? null,
        sessionId: item.sessionId,
      }))
    },
    connectedSessionsFor(tabId) {
      return [...new Set(
        (window.__p105?.statuses ?? [])
          .filter((item) => item.clientId === tabId && item.status === 'connected')
          .map((item) => item.sessionId),
      )]
    },
    setSettingsRowCheckbox(rowLabel, checked) {
      const row = [...document.querySelectorAll('.settings-row')].find((el) =>
        [...el.querySelectorAll('.settings-row__label')].some(
          (label) => textOf(label) === rowLabel,
        ),
      )
      if (!row) throw new Error('settings row not found: ' + rowLabel)
      const checkbox = row.querySelector('input[type="checkbox"]')
      if (!checkbox) throw new Error('checkbox not found in row: ' + rowLabel)
      if (checkbox.checked !== checked) checkbox.click()
      return checkbox.checked
    },
    markXterms() {
      const tabs = this.tabs()
      window.__p105Dom = {}
      for (const tab of tabs) {
        const panel = this.panel(tab.tabId)
        window.__p105Dom[tab.tabId] = panel?.querySelector('.terminal-xterm') ?? null
      }
      return Object.keys(window.__p105Dom).length
    },
    sameXterms() {
      const tabs = this.tabs()
      return tabs.every(
        (tab) => this.panel(tab.tabId)?.querySelector('.terminal-xterm') === window.__p105Dom?.[tab.tabId],
      )
    },
  }
  return true
})()`

const STATE_BINDINGS = `(() => {
  const api = window.termforge
  window.__p105 = { statuses: [], outputs: {}, shellStatuses: [], latest: {} }
  api.ssh.onSessionStatus((event) => {
    window.__p105.statuses.push(event.session)
    window.__p105.latest[event.session.clientId] = event.session
  })
  api.terminal.onOutput((event) => {
    ;(window.__p105.outputs[event.sessionId] ||= []).push(event.data)
  })
  api.terminal.onStatus((event) => window.__p105.shellStatuses.push(event))
  return true
})()`

function outputFor(sessionId) {
  return `__p105Help.output(${JSON.stringify(sessionId)})`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const workDir = mkdtempSync(join(tmpdir(), 'termforge-p1-05-'))
  const userDataDir = join(workDir, 'user-data')
  const appDataDir = join(workDir, 'appdata')
  const fixtureRoot = createFixtureRoot(join(workDir, 'fixture-root'))
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(appDataDir, { recursive: true })

  const checks = []
  const screenshots = []
  const notes = []
  const stallSockets = new Set()
  let cdp = null
  let child = null
  let fixture = null
  let stallServer = null
  let exitCode = 0

  const check = (id, fn) => {
    try {
      const details = fn()
      checks.push({ id, status: 'passed', details })
      console.log(`CHECK passed ${id}`)
      return details
    } catch (error) {
      checks.push({ id, status: 'failed', error: String(error?.stack ?? error) })
      console.log(`CHECK failed ${id}: ${String(error?.message ?? error)}`)
      throw error
    }
  }

  const screenshot = async (name) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const path = join(OUT_DIR, `${name}.png`)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    screenshots.push({ name, path, bytes: statSync(path).size })
    return path
  }

  const stopStallServer = async () => {
    for (const socket of stallSockets) {
      try {
        socket.destroy()
      } catch {
        // Best-effort fixture shutdown.
      }
    }
    stallSockets.clear()
    if (!stallServer) return
    const server = stallServer
    stallServer = null
    await new Promise((resolveClose) => server.close(() => resolveClose()))
  }

  try {
    const hostKey = createHostKey()
    fixture = await startFixtureSshServer({
      hostKey,
      rootDir: fixtureRoot,
      password: PASSWORD,
    })
    stallServer = createServer((socket) => {
      stallSockets.add(socket)
      socket.on('close', () => stallSockets.delete(socket))
      socket.on('error', () => undefined)
    })
    await new Promise((resolveListen) => stallServer.listen(0, '127.0.0.1', resolveListen))
    const stallPort = stallServer.address().port
    notes.push({ fixturePort: fixture.port, stallPort, workDir })

    const cdpPort = await getFreePort()
    const launchEnv = {
      ...process.env,
      APPDATA: appDataDir,
      LOCALAPPDATA: appDataDir,
    }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    child = spawn(
      ELECTRON,
      [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, REPO_ROOT],
      { cwd: REPO_ROOT, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const electronLog = []
    child.stdout.on('data', (chunk) => electronLog.push(chunk.toString()))
    child.stderr.on('data', (chunk) => electronLog.push(chunk.toString()))
    child.on('exit', (code) => {
      if (code !== null && code !== 0) electronLog.push(`electron exited with ${code}`)
    })

    const target = await waitForCdpTarget(cdpPort, 30000)
    cdp = new CdpClient(target.webSocketDebuggerUrl, 'renderer')
    await cdp.connect()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await waitFor(
      cdp,
      `document.readyState === 'complete' && !!window.termforge`,
      30000,
      'preload bridge ready',
    )
    await cdp.evaluate(HELPERS)

    const appInfo = await cdp.evaluate(`window.termforge.getAppInfo()`)
    const logInfo = await cdp.evaluate(`window.termforge.logs.getInfo()`)
    check('baseline-isolated-runtime', () => {
      if (appInfo?.isPackaged !== false) {
        throw new Error(`unexpected app info: ${JSON.stringify(appInfo)}`)
      }
      if (!logInfo?.ok) throw new Error(`logs.getInfo failed: ${JSON.stringify(logInfo)}`)
      const expectedRoot = resolve(workDir).toLowerCase()
      const actual = resolve(logInfo.value.directory).toLowerCase()
      if (!actual.startsWith(expectedRoot)) {
        throw new Error(`userData was not isolated: ${actual}`)
      }
      return {
        appVersion: appInfo.appVersion,
        electronVersion: appInfo.electronVersion,
        logsDirectory: logInfo.value.directory,
      }
    })

    const settingsBefore = await cdp.evaluate(`window.termforge.settings.get()`)
    check('auto-reconnect-default-off', () => {
      if (!settingsBefore?.ok) throw new Error(JSON.stringify(settingsBefore))
      if (settingsBefore.value.preferences.autoReconnectEnabled !== false) {
        throw new Error('new profile must default automatic reconnect to off')
      }
      if (settingsBefore.value.preferences.commandHistoryEnabled !== false) {
        throw new Error('new profile must keep command history off')
      }
      return {
        autoReconnectEnabled: false,
        commandHistoryEnabled: false,
        warnings: settingsBefore.value.warnings,
      }
    })

    const connectionName = `P1-05 验收 ${RUN}`
    const stallName = `P1-05 停滞 ${RUN}`
    await cdp.evaluate(`(async () => {
      const api = window.termforge
      const catalog = await api.connections.list()
      if (!catalog.ok) throw new Error(JSON.stringify(catalog))
      const group = catalog.value.groups[0]
      if (!group) throw new Error('no group available')
      const created = await api.connections.create({
        name: ${JSON.stringify(connectionName)},
        host: '127.0.0.1',
        port: ${fixture.port},
        username: ${JSON.stringify(FIXTURE_USER)},
        authMethod: 'password',
        groupId: group.id,
        tags: ['acceptance', 'p1-05'],
      })
      if (!created.ok) throw new Error(JSON.stringify(created))
      const credential = await api.ssh.saveCredential({
        connectionId: created.value.id,
        kind: 'password',
        secret: ${JSON.stringify(PASSWORD)},
      })
      if (!credential.ok) throw new Error(JSON.stringify(credential))
      const stall = await api.connections.create({
        name: ${JSON.stringify(stallName)},
        host: '127.0.0.1',
        port: ${stallPort},
        username: ${JSON.stringify(FIXTURE_USER)},
        authMethod: 'password',
        groupId: group.id,
        tags: ['acceptance', 'p1-05', 'stall'],
      })
      if (!stall.ok) throw new Error(JSON.stringify(stall))
      const stallCredential = await api.ssh.saveCredential({
        connectionId: stall.value.id,
        kind: 'password',
        secret: ${JSON.stringify(PASSWORD)},
      })
      if (!stallCredential.ok) throw new Error(JSON.stringify(stallCredential))
      return { connectionId: created.value.id, stallConnectionId: stall.value.id }
    })()`)

    await cdp.send('Page.reload')
    await waitFor(
      cdp,
      `document.readyState === 'complete' && !!window.termforge`,
      30000,
      'renderer reloaded',
    )
    await cdp.evaluate(HELPERS)
    await cdp.evaluate(STATE_BINDINGS)
    await waitFor(
      cdp,
      `__p105Help.clickLabelPrefix(${JSON.stringify(`连接 ${connectionName}`)})`,
      15000,
      'fixture connection in sidebar',
    )
    await waitFor(cdp, `!!__p105Help.button('信任并继续')`, 15000, 'host key prompt')
    await cdp.evaluate(`__p105Help.clickButton('信任并继续')`)

    const tabA = await waitFor(
      cdp,
      `(() => {
        const tabs = __p105Help.tabs()
        return tabs.length === 1 ? tabs[0].tabId : null
      })()`,
      15000,
      'first tab created',
    )
    const sessionA = await waitFor(
      cdp,
      `__p105Help.shellReady(${JSON.stringify(tabA)})`,
      25000,
      'first shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA)}).includes('tfuser@acceptance')`,
      10000,
      'first fixture prompt',
    )

    await cdp.evaluate(`__p105Help.clickLabelPrefix(${JSON.stringify(`连接 ${connectionName}`)})`)
    const tabB = await waitFor(
      cdp,
      `(() => {
        const tabs = __p105Help.tabs()
        return tabs.length === 2 ? tabs[1].tabId : null
      })()`,
      15000,
      'second tab created',
    )
    const sessionB = await waitFor(
      cdp,
      `__p105Help.shellReady(${JSON.stringify(tabB)})`,
      25000,
      'second shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionB)}).includes('tfuser@acceptance')`,
      10000,
      'second fixture prompt',
    )
    check('two-real-ssh-shells', () => {
      if (fixture.readyCount() !== 2) {
        throw new Error(`expected 2 ready fixture transports, got ${fixture.readyCount()}`)
      }
      if (sessionA === sessionB) throw new Error('sessions must be distinct')
      return { tabA, tabB, sessionA, sessionB, readySshConnections: 2 }
    })

    await cdp.evaluate(`__p105Help.clickTab(${JSON.stringify(tabA)})`)
    await cdp.evaluate(`__p105Help.markXterms()`)
    const connectionsBeforeSplit = fixture.connectionCount()
    const splitOpened = await cdp.evaluate(`(() => {
      const button = document.querySelector('[aria-label="' + CSS.escape('左右分屏') + '"]')
      if (!button) throw new Error('split button missing')
      button.click()
      return true
    })()`)
    const splitRow = await waitFor(
      cdp,
      `(() => {
        const panes = __p105Help.visiblePanes()
        if (panes.length !== 2) return null
        return {
          panes,
          stage: __p105Help.stage(),
          divider: __p105Help.divider(),
          xtermsA: __p105Help.xtermCount(${JSON.stringify(tabA)}),
          xtermsB: __p105Help.xtermCount(${JSON.stringify(tabB)}),
          sameXterms: __p105Help.sameXterms(),
        }
      })()`,
      5000,
      'row split rendered',
    )
    check('split-row-two-panes-one-terminal-each', () => {
      if (!splitOpened) throw new Error('split button did not respond')
      if (!splitRow.stage.className.includes('terminal-stage--split-row')) {
        throw new Error(`unexpected split stage: ${JSON.stringify(splitRow.stage)}`)
      }
      if (splitRow.xtermsA !== 1 || splitRow.xtermsB !== 1) {
        throw new Error(`terminal instances are not one per tab: ${JSON.stringify(splitRow)}`)
      }
      if (!splitRow.sameXterms) {
        throw new Error('split change remounted an existing terminal')
      }
      if (!splitRow.panes.every((pane) => pane.xterms === 1)) {
        throw new Error(`pane is missing its terminal: ${JSON.stringify(splitRow.panes)}`)
      }
      if (fixture.connectionCount() !== connectionsBeforeSplit) {
        throw new Error('split layout changed the SSH transport count')
      }
      return splitRow
    })
    await screenshot('01-split-row-two-panes')

    await cdp.evaluate(
      `document.querySelector('#terminal-panel-' + CSS.escape(${JSON.stringify(tabB)}) + ' [title="聚焦此窗格"]').focus()`,
    )
    await cdp.evaluate(
      `document.querySelector('#terminal-panel-' + CSS.escape(${JSON.stringify(tabB)}) + ' [title="聚焦此窗格"]').click()`,
    )
    await cdp.evaluate(`__p105Help.pressDivider('ArrowRight')`)
    const focusedRow = await waitFor(
      cdp,
      `(() => {
        const tab = __p105Help.tabs().find((item) => item.tabId === ${JSON.stringify(tabB)})
        const pane = __p105Help.panel(${JSON.stringify(tabB)})
        const divider = __p105Help.divider()
        if (!tab?.active || !pane?.classList.contains('terminal-pane--focused')) return null
        if (divider?.value !== '52') return null
        return { activeTab: tab.tabId, focused: true, divider, stage: __p105Help.stage() }
      })()`,
      5000,
      'focus + ratio after keyboard',
    )
    check('split-focus-and-ratio-keyboard', () => {
      if (focusedRow.stage.ratio !== '52%') {
        throw new Error(`unexpected split ratio: ${JSON.stringify(focusedRow)}`)
      }
      return focusedRow
    })

    await cdp.evaluate(`__p105Help.clickAria('上下')`)
    const columnSplit = await waitFor(
      cdp,
      `(() => {
        const stage = __p105Help.stage()
        const divider = __p105Help.divider()
        if (!stage?.className.includes('terminal-stage--split-column')) return null
        return { stage, divider, panes: __p105Help.visiblePanes() }
      })()`,
      5000,
      'column split rendered',
    )
    await cdp.evaluate(`__p105Help.pressDivider('ArrowDown')`)
    const columnRatio = await waitFor(
      cdp,
      `(() => {
        const divider = __p105Help.divider()
        return divider?.value === '54' ? divider : null
      })()`,
      5000,
      'column ratio keyboard',
    )
    check('split-column-and-ratio-keyboard', () => {
      if (columnSplit.divider.orientation !== 'horizontal') {
        throw new Error(`unexpected divider orientation: ${JSON.stringify(columnSplit.divider)}`)
      }
      if (columnSplit.panes.length !== 2) {
        throw new Error(`expected 2 panes in column split: ${JSON.stringify(columnSplit)}`)
      }
      if (columnRatio.value !== '54') {
        throw new Error(`unexpected column ratio: ${JSON.stringify(columnRatio)}`)
      }
      return { direction: 'column', ratio: columnRatio.value }
    })
    await screenshot('02-split-column-focus-and-ratio')

    await cdp.evaluate(`__p105Help.unbindPane(${JSON.stringify(tabB)})`)
    const unbound = await waitFor(
      cdp,
      `(() => {
        const empty = document.querySelector('section[aria-label="下方空窗格"]')
        if (!empty) return null
        return {
          empty: true,
          tabs: __p105Help.tabs(),
          sessionsB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
          panes: __p105Help.visiblePanes(),
          ready: ${fixture.readyCount()},
        }
      })()`,
      5000,
      'pane B unbound without closing session',
    )
    const rebound = await cdp.evaluate(
      `__p105Help.setSelect('下方空窗格', ${JSON.stringify(tabB)})`,
    )
    const reboundState = await waitFor(
      cdp,
      `(() => {
        const panes = __p105Help.visiblePanes()
        const panel = __p105Help.panel(${JSON.stringify(tabB)})
        if (panes.length !== 2) return null
        if (!panel?.classList.contains('terminal-pane--slot-b')) return null
        return {
          panes,
          emptyGone: !document.querySelector('section[aria-label="下方空窗格"]'),
          tabB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
        }
      })()`,
      5000,
      'pane B rebound',
    )
    check('split-unbind-rebind-preserves-sessions', () => {
      if (unbound.tabs.length !== 2) throw new Error('unbinding removed a tab')
      if (unbound.sessionsB !== 'connected') {
        throw new Error(`unbinding closed the SSH session: ${JSON.stringify(unbound)}`)
      }
      if (unbound.ready !== 2) throw new Error('unbinding changed SSH transports')
      if (rebound !== tabB) throw new Error(`rebind select value mismatch: ${rebound}`)
      if (!reboundState.emptyGone || reboundState.panes.length !== 2) {
        throw new Error(`rebind did not restore both panes: ${JSON.stringify(reboundState)}`)
      }
      if (reboundState.tabB !== 'connected') {
        throw new Error('rebind changed SSH state')
      }
      return { unbound, rebound: reboundState }
    })
    await screenshot('03-split-empty-pane-rebound')

    await cdp.evaluate(`__p105Help.clickAria('退出分屏')`)
    const merged = await waitFor(
      cdp,
      `(() => {
        const panes = __p105Help.visiblePanes()
        if (panes.length !== 1) return null
        return {
          panes,
          xtermsA: __p105Help.xtermCount(${JSON.stringify(tabA)}),
          xtermsB: __p105Help.xtermCount(${JSON.stringify(tabB)}),
          sameXterms: __p105Help.sameXterms(),
          statusA: __p105Help.latest(${JSON.stringify(tabA)})?.status ?? null,
          statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
        }
      })()`,
      5000,
      'split merged',
    )
    check('split-exit-preserves-sessions-and-dom', () => {
      if (merged.xtermsA !== 1 || merged.xtermsB !== 1) {
        throw new Error(`terminal count changed after merge: ${JSON.stringify(merged)}`)
      }
      if (!merged.sameXterms) throw new Error('merge remounted a terminal')
      if (merged.statusA !== 'connected' || merged.statusB !== 'connected') {
        throw new Error(`merge changed SSH state: ${JSON.stringify(merged)}`)
      }
      if (fixture.connectionCount() !== connectionsBeforeSplit) {
        throw new Error('merge changed the SSH transport count')
      }
      return merged
    })

    await cdp.evaluate(`__p105Help.clickLabelPrefix(${JSON.stringify(`连接 ${stallName}`)})`)
    const stallTab = await waitFor(
      cdp,
      `(() => {
        const tabs = __p105Help.tabs()
        if (tabs.length !== 3) return null
        const tab = tabs.find(
          (item) => item.tabId !== ${JSON.stringify(tabA)} && item.tabId !== ${JSON.stringify(tabB)},
        )
        const latest = tab && __p105Help.latest(tab.tabId)
        return latest && (latest.status === 'connecting' || latest.status === 'authenticating')
          ? tab.tabId
          : null
      })()`,
      10000,
      'stalled connection is in progress',
    )
    await cdp.evaluate(
      `__p105Help.clickAria('取消连接', __p105Help.panel(${JSON.stringify(stallTab)}))`,
    )
    const cancelled = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(stallTab)})
        if (!latest || latest.status !== 'disconnected') return null
        if (latest.error?.code !== 'cancelled') return null
        return {
          status: latest.status,
          code: latest.error.code,
          tabs: __p105Help.tabs(),
          statusA: __p105Help.latest(${JSON.stringify(tabA)})?.status ?? null,
          statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
          ready: ${fixture.readyCount()},
        }
      })()`,
      10000,
      'cancel leaves a cancelled tab',
    )
    await sleep(1500)
    const afterCancel = await cdp.evaluate(`(() => ({
      tabs: __p105Help.tabs(),
      latest: __p105Help.latest(${JSON.stringify(stallTab)}),
      statusA: __p105Help.latest(${JSON.stringify(tabA)})?.status ?? null,
      statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
    }))()`)
    check('narrow-cancel-keeps-tab-and-other-sessions', () => {
      if (cancelled.code !== 'cancelled') throw new Error('cancel failure code mismatch')
      if (cancelled.tabs.length !== 3) throw new Error('cancel closed the tab')
      if (cancelled.statusA !== 'connected' || cancelled.statusB !== 'connected') {
        throw new Error(`cancel affected another session: ${JSON.stringify(cancelled)}`)
      }
      if (afterCancel.latest?.status !== 'disconnected') {
        throw new Error(`cancel state changed after late events: ${JSON.stringify(afterCancel)}`)
      }
      if (afterCancel.tabs.length !== 3) throw new Error('cancel tab disappeared late')
      if (afterCancel.statusA !== 'connected' || afterCancel.statusB !== 'connected') {
        throw new Error('cancel affected neighbor after late events')
      }
      if (fixture.readyCount() !== 2) throw new Error('cancel changed fixture transports')
      return { cancelled, afterCancel }
    })
    await cdp.evaluate(`__p105Help.closeTab(${JSON.stringify(stallTab)})`)
    await waitFor(cdp, `__p105Help.tabs().length === 2`, 5000, 'stalled tab closed by user')
    await stopStallServer()

    await cdp.evaluate(`__p105Help.clickTab(${JSON.stringify(tabA)})`)
    await cdp.evaluate(`__p105Help.clickAria('左右分屏')`)
    await waitFor(
      cdp,
      `__p105Help.visiblePanes().length === 2`,
      5000,
      'split restored for isolation test',
    )
    const peerWrite = await cdp.evaluate(
      `window.termforge.terminal.write(${JSON.stringify(sessionB)}, ${JSON.stringify('echo TF_P105_B_READY\r')})`,
    )
    if (!peerWrite?.ok) throw new Error(`peer terminal write failed: ${JSON.stringify(peerWrite)}`)
    await waitFor(
      cdp,
      `(${outputFor(sessionB)}).includes('TF_P105_B_READY')`,
      10000,
      'neighbor pane executes commands before drop',
    )
    await cdp.evaluate(
      `window.termforge.terminal.write(${JSON.stringify(sessionA)}, ${JSON.stringify(`echo ${REPLAY_MARKER}`)})`,
    )
    await sleep(250)
    const droppedForDefaultOff = fixture.dropReadyConnection(0)
    const disconnectedA = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(tabA)})
        if (!latest || (latest.status !== 'disconnected' && latest.status !== 'error')) return null
        if (!latest.error) return null
        return {
          status: latest.status,
          code: latest.error.code,
          notice: __p105Help.notice(${JSON.stringify(tabA)}),
          statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
        }
      })()`,
      10000,
      'unexpected disconnect on pane A',
    )
    const peerWriteAfterDrop = await cdp.evaluate(
      `window.termforge.terminal.write(${JSON.stringify(sessionB)}, ${JSON.stringify('echo TF_P105_PEER_OK\r')})`,
    )
    if (!peerWriteAfterDrop?.ok) {
      throw new Error(`peer write after drop failed: ${JSON.stringify(peerWriteAfterDrop)}`)
    }
    await waitFor(
      cdp,
      `(${outputFor(sessionB)}).includes('TF_P105_PEER_OK')`,
      10000,
      'neighbor pane still executes commands',
    )
    await sleep(300)
    const connectionCountAfterDrop = fixture.connectionCount()
    await sleep(2500)
    const noRetry = await cdp.evaluate(`(() => ({
      tabs: __p105Help.tabs(),
      statusA: __p105Help.latest(${JSON.stringify(tabA)})?.status ?? null,
      notice: __p105Help.notice(${JSON.stringify(tabA)}),
      connectedSessions: __p105Help.connectedSessionsFor(${JSON.stringify(tabA)}),
      statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
    }))()`)
    check('default-off-never-auto-retries-and-neighbor-isolated', () => {
      if (!droppedForDefaultOff) throw new Error('fixture drop hook failed')
      if (disconnectedA.code !== 'remote-closed') {
        throw new Error(`unexpected disconnect classification: ${JSON.stringify(disconnectedA)}`)
      }
      if (disconnectedA.notice !== null) {
        throw new Error(
          `auto reconnect notice appeared while disabled: ${JSON.stringify(disconnectedA)}`,
        )
      }
      if (fixture.connectionCount() !== connectionCountAfterDrop) {
        throw new Error('automatic retry happened while the setting was off')
      }
      if (noRetry.connectedSessions.length !== 1) {
        throw new Error(`unexpected automatic sessions: ${JSON.stringify(noRetry)}`)
      }
      if (noRetry.tabs.length !== 2) throw new Error('disconnect closed a tab')
      if (disconnectedA.statusB !== 'connected' || noRetry.statusB !== 'connected') {
        throw new Error('pane B lost its session when pane A disconnected')
      }
      return { disconnectedA, noRetry, peerCommand: 'TF_P105_PEER_OK' }
    })
    await screenshot('04-default-off-unexpected-disconnect')

    await cdp.evaluate(
      `__p105Help.clickAria('重新连接', __p105Help.panel(${JSON.stringify(tabA)}))`,
    )
    const sessionA2 = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(tabA)})
        if (!latest || latest.status !== 'connected') return null
        if (latest.sessionId === ${JSON.stringify(sessionA)}) return null
        return latest.sessionId
      })()`,
      25000,
      'manual reconnect created a new session',
    )
    await waitFor(
      cdp,
      `__p105Help.shellReady(${JSON.stringify(tabA)})`,
      15000,
      'manual reconnect shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA2)}).includes('tfuser@acceptance')`,
      10000,
      'new session prompt',
    )
    await cdp.evaluate(`window.termforge.terminal.write(${JSON.stringify(sessionA2)}, '\\r')`)
    await sleep(800)
    const replay = await cdp.evaluate(`(() => ({
      all: __p105Help.allOutput(),
      latestA: __p105Help.latest(${JSON.stringify(tabA)}),
      statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
      tabCount: __p105Help.tabs().length,
    }))()`)
    check('manual-reconnect-new-session-without-input-replay', () => {
      if (sessionA2 === sessionA) throw new Error('manual reconnect reused the old session ID')
      if (replay.all.includes(REPLAY_MARKER)) {
        throw new Error('pending terminal input was replayed into the new shell')
      }
      if (replay.statusB !== 'connected') throw new Error('neighbor session changed')
      if (replay.tabCount !== 2) throw new Error('tab count changed')
      return { previousSession: sessionA, newSession: sessionA2, replay: false }
    })
    await screenshot('05-manual-reconnect-new-session')

    await cdp.evaluate(`__p105Help.clickAria('退出分屏')`)
    await waitFor(cdp, `__p105Help.visiblePanes().length === 1`, 5000, 'split merged again')

    await cdp.evaluate(`__p105Help.clickAria('设置')`)
    await waitFor(
      cdp,
      `!!__p105Help.button('会话与传输记录') || !![...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('会话与传输记录'))`,
      10000,
      'settings view',
    )
    await cdp.evaluate(`__p105Help.clickButton('会话与传输记录')`)
    await waitFor(
      cdp,
      `!!document.querySelector('input[aria-label="启用自动重连"]')`,
      5000,
      'auto reconnect settings row',
    )
    const settingsCopy = await cdp.evaluate(`(() => ({
      text: document.body.innerText,
      checked: document.querySelector('input[aria-label="启用自动重连"]').checked,
    }))()`)
    await cdp.evaluate(`__p105Help.setSettingsRowCheckbox('自动重连', true)`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.settings.get()
        return result.ok && result.value.preferences.autoReconnectEnabled === true
      })()`,
      5000,
      'auto reconnect persisted on',
    )
    check('settings-v4-opt-in-and-disclosure', () => {
      if (settingsCopy.checked !== false) throw new Error('auto reconnect was not off by default')
      if (!settingsCopy.text.includes('最多 5 次，间隔依次为 1、2、4、8、15 秒')) {
        throw new Error('backoff disclosure missing')
      }
      if (!settingsCopy.text.includes('不会重放断线前的终端输入')) {
        throw new Error('input replay disclosure missing')
      }
      if (!settingsCopy.text.includes('不会恢复旧的远程 Shell')) {
        throw new Error('shell restoration disclosure missing')
      }
      return { defaultChecked: false, enabled: true }
    })
    await screenshot('06-settings-auto-reconnect-enabled')
    await cdp.evaluate(`__p105Help.clickButton('工作台')`)
    await waitFor(
      cdp,
      `__p105Help.latest(${JSON.stringify(tabA)})?.status === 'connected'`,
      10000,
      'workbench restored',
    )

    await cdp.evaluate(
      `window.termforge.terminal.write(${JSON.stringify(sessionA2)}, ${JSON.stringify(`echo ${REPLAY_MARKER}`)})`,
    )
    await sleep(250)
    const autoDrop = fixture.dropReadyConnection(-1)
    const waitingNotice = await waitFor(
      cdp,
      `(() => {
        const notice = __p105Help.notice(${JSON.stringify(tabA)})
        return notice && notice.text.includes('等待自动重连') ? notice : null
      })()`,
      3000,
      'automatic retry scheduled',
    )
    await screenshot('07-auto-reconnect-waiting')
    const sessionA3 = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(tabA)})
        if (!latest || latest.status !== 'connected') return null
        if (latest.sessionId === ${JSON.stringify(sessionA2)}) return null
        return latest.sessionId
      })()`,
      25000,
      'automatic reconnect completed',
    )
    await waitFor(
      cdp,
      `__p105Help.shellReady(${JSON.stringify(tabA)})`,
      15000,
      'automatic reconnect shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA3)}).includes('tfuser@acceptance')`,
      10000,
      'automatic reconnect prompt',
    )
    await cdp.evaluate(`window.termforge.terminal.write(${JSON.stringify(sessionA3)}, '\\r')`)
    await sleep(800)
    const autoState = await cdp.evaluate(`(() => ({
      notice: __p105Help.notice(${JSON.stringify(tabA)}),
      all: __p105Help.allOutput(),
      tabs: __p105Help.tabs(),
      statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
      sessions: __p105Help.connectedSessionsFor(${JSON.stringify(tabA)}),
      failures: __p105Help.failuresFor(${JSON.stringify(tabA)}),
    }))()`)
    check('auto-reconnect-waits-then-succeeds-without-replay', () => {
      if (!autoDrop) throw new Error('fixture drop hook failed')
      if (!waitingNotice.text.includes('1/5')) {
        throw new Error(`unexpected first automatic attempt: ${JSON.stringify(waitingNotice)}`)
      }
      if (autoState.notice !== null) {
        throw new Error(`retry notice should clear after success: ${JSON.stringify(autoState)}`)
      }
      if (autoState.all.includes(REPLAY_MARKER)) {
        throw new Error('automatic reconnect replayed pending input')
      }
      if (autoState.statusB !== 'connected') throw new Error('automatic retry affected pane B')
      if (autoState.sessions.length !== 3) {
        throw new Error(`unexpected session history: ${JSON.stringify(autoState.sessions)}`)
      }
      return {
        firstAttempt: waitingNotice,
        previousSession: sessionA2,
        newSession: sessionA3,
        sessionsSeenForTab: autoState.sessions,
      }
    })
    await screenshot('08-auto-reconnected')

    const cancelDrop = fixture.dropReadyConnection(-1)
    const cancelWaiting = await waitFor(
      cdp,
      `(() => {
        const notice = __p105Help.notice(${JSON.stringify(tabA)})
        return notice && notice.text.includes('等待自动重连') ? notice : null
      })()`,
      3000,
      'second automatic retry scheduled',
    )
    await cdp.evaluate(`__p105Help.clickNoticeButton(${JSON.stringify(tabA)})`)
    const cancelNoticeGone = await waitFor(
      cdp,
      `__p105Help.notice(${JSON.stringify(tabA)}) === null`,
      3000,
      'automatic retry cancelled from notice',
    )
    const connectionCountAfterCancel = fixture.connectionCount()
    await sleep(2500)
    const afterCancelRetry = await cdp.evaluate(`(() => ({
      latest: __p105Help.latest(${JSON.stringify(tabA)}),
      notice: __p105Help.notice(${JSON.stringify(tabA)}),
      tabs: __p105Help.tabs(),
      statusB: __p105Help.latest(${JSON.stringify(tabB)})?.status ?? null,
    }))()`)
    check('cancel-auto-reconnect-stops-retry-and-keeps-tab', () => {
      if (!cancelDrop) throw new Error('fixture drop hook failed')
      if (!cancelWaiting.text.includes('1/5')) {
        throw new Error(`unexpected retry attempt: ${JSON.stringify(cancelWaiting)}`)
      }
      if (!cancelNoticeGone || afterCancelRetry.notice !== null) {
        throw new Error('cancel left the auto reconnect notice behind')
      }
      if (fixture.connectionCount() !== connectionCountAfterCancel) {
        throw new Error('automatic retry continued after cancellation')
      }
      if (afterCancelRetry.tabs.length !== 2) throw new Error('cancel closed the tab')
      if (afterCancelRetry.statusB !== 'connected') throw new Error('cancel affected pane B')
      return { cancelledAttempt: cancelWaiting, afterCancelRetry }
    })

    const sessionA4 = await waitFor(
      cdp,
      `(async () => {
        const button = __p105Help.button('重新连接', __p105Help.panel(${JSON.stringify(tabA)}))
        if (!button) {
          const lazy = __p105Help.button('重新连接')
          if (!lazy) throw new Error('retry button missing')
          lazy.click()
        } else {
          button.click()
        }
        const deadline = Date.now() + 25000
        while (Date.now() < deadline) {
          const latest = __p105Help.latest(${JSON.stringify(tabA)})
          if (latest?.status === 'connected' && latest.sessionId !== ${JSON.stringify(sessionA3)}) {
            return latest.sessionId
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 150))
        }
        return null
      })()`,
      30000,
      'manual reconnect after cancelled automatic retry',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA4)}).includes('tfuser@acceptance')`,
      10000,
      'prompt after manual retry',
    )
    check('manual-reconnect-works-after-cancelled-auto-retry', () => ({
      previousSession: sessionA3,
      newSession: sessionA4,
    }))

    await cdp.evaluate(`__p105Help.closeTab(${JSON.stringify(tabB)})`)
    await waitFor(cdp, `__p105Help.tabs().length === 1`, 5000, 'neighbor tab closed by user')

    await fixture.close()
    const fixturePort = notes[0].fixturePort
    const exhaustionDrops = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(tabA)})
        return latest && (latest.status === 'disconnected' || latest.status === 'error')
          ? latest.error?.code ?? null
          : null
      })()`,
      10000,
      'fixture shutdown dropped the last session',
    )
    const exhausted = await waitFor(
      cdp,
      `(() => {
        const notice = __p105Help.notice(${JSON.stringify(tabA)})
        if (!notice || !notice.exhausted) return null
        return {
          notice,
          errors: __p105Help.failuresFor(${JSON.stringify(tabA)}).filter(
            (item) => item.status === 'error' && item.code === 'connection-refused',
          ).length,
          tabCount: __p105Help.tabs().length,
        }
      })()`,
      50000,
      'automatic retries exhausted after five attempts',
    )
    await screenshot('09-auto-reconnect-exhausted')
    const exhaustedCount = exhausted.errors
    await sleep(3500)
    const afterExhausted = await cdp.evaluate(`(() => ({
      errors: __p105Help.failuresFor(${JSON.stringify(tabA)}).filter(
        (item) => item.status === 'error' && item.code === 'connection-refused',
      ).length,
      notice: __p105Help.notice(${JSON.stringify(tabA)}),
      tabs: __p105Help.tabs().length,
    }))()`)
    check('auto-reconnect-bounded-to-five-attempts', () => {
      if (exhaustionDrops !== 'remote-closed') {
        throw new Error(`unexpected shutdown classification: ${exhaustionDrops}`)
      }
      if (exhausted.errors !== 5) {
        throw new Error(`expected exactly 5 connection-refused attempts: ${exhausted.errors}`)
      }
      if (!exhausted.notice.text.includes('已自动尝试 5 次仍未成功')) {
        throw new Error(`missing exhausted copy: ${JSON.stringify(exhausted.notice)}`)
      }
      if (afterExhausted.errors !== exhaustedCount) {
        throw new Error('retries continued after exhaustion')
      }
      if (!afterExhausted.notice?.exhausted) throw new Error('exhausted notice disappeared')
      if (afterExhausted.tabs !== 1) throw new Error('exhaustion closed the tab')
      return { attempts: exhausted.errors, drops: exhaustionDrops, afterExhausted }
    })

    await cdp.evaluate(`__p105Help.clickAria('设置')`)
    await waitFor(
      cdp,
      `!!document.querySelector('input[aria-label="启用自动重连"]') || !![...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('会话与传输记录'))`,
      10000,
      'settings reopened',
    )
    await cdp.evaluate(`__p105Help.clickButton('会话与传输记录')`)
    await waitFor(
      cdp,
      `!!document.querySelector('input[aria-label="启用自动重连"]')`,
      5000,
      'auto reconnect row after exhaustion',
    )
    await cdp.evaluate(`__p105Help.setSettingsRowCheckbox('自动重连', false)`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.settings.get()
        return result.ok && result.value.preferences.autoReconnectEnabled === false
      })()`,
      5000,
      'auto reconnect disabled again',
    )
    await cdp.evaluate(`__p105Help.clickButton('工作台')`)
    await waitFor(
      cdp,
      `__p105Help.notices().length === 0`,
      5000,
      'disabling setting clears retry state',
    )
    const noticesAfterDisable = await cdp.evaluate(`__p105Help.notices()`)
    check('disabling-setting-clears-auto-reconnect-state', () => {
      if (noticesAfterDisable.length !== 0) throw new Error('auto reconnect notice remained')
      return { notices: 0, autoReconnectEnabled: false }
    })

    fixture = await startFixtureSshServer({
      hostKey,
      rootDir: fixtureRoot,
      port: fixturePort,
      password: PASSWORD,
    })
    await waitFor(
      cdp,
      `(() => {
        const button = __p105Help.button('重新连接', __p105Help.panel(${JSON.stringify(tabA)}))
        if (!button) return false
        button.click()
        return true
      })()`,
      5000,
      'manual retry after fixture restart',
    )
    const sessionA5 = await waitFor(
      cdp,
      `(() => {
        const latest = __p105Help.latest(${JSON.stringify(tabA)})
        return latest?.status === 'connected' && latest.sessionId !== ${JSON.stringify(sessionA4)}
          ? latest.sessionId
          : null
      })()`,
      25000,
      'manual reconnect after fixture restart',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA5)}).includes('tfuser@acceptance')`,
      10000,
      'prompt after fixture restart',
    )
    check('manual-reconnect-after-exhaustion-and-restart', () => ({
      newSession: sessionA5,
      fixturePort,
    }))
    await screenshot('10-recovered-after-manual-retry')

    const userDataRoot = resolve(logInfo.value.directory, '..')
    const settingsPath = join(userDataRoot, 'settings.json')
    const logsPath = logInfo.value.directory
    await sleep(500)
    const settingsFile = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const settingsText = readFileSync(settingsPath, 'utf8')
    const logText = readdirSync(logsPath)
      .filter((name) => name.endsWith('.log'))
      .map((name) => readFileSync(join(logsPath, name), 'utf8'))
      .join('\n')
    check('settings-v4-persistence-and-no-secret-leak', () => {
      if (settingsFile.version !== 4) {
        throw new Error(`expected settings v4, got ${settingsFile.version}`)
      }
      if (settingsFile.preferences.autoReconnectEnabled !== false) {
        throw new Error('final auto reconnect preference was not persisted')
      }
      if (settingsText.includes(PASSWORD)) throw new Error('password leaked into settings.json')
      if (logText.includes(PASSWORD)) throw new Error('password leaked into logs')
      if (logText.includes(REPLAY_MARKER)) throw new Error('terminal input leaked into logs')
      if (settingsText.includes('nextRetryAt') || settingsText.includes('autoReconnect"')) {
        throw new Error('runtime retry state was persisted')
      }
      return {
        settingsVersion: settingsFile.version,
        autoReconnectEnabled: false,
        settingsContainsPassword: false,
        logsContainPassword: false,
        logsContainTerminalInput: false,
        runtimeRetryStatePersisted: false,
      }
    })

    const report = {
      status: 'passed',
      checks,
      screenshots,
      notes,
      environment: {
        fixture: 'ssh2 in-process fixture over 127.0.0.1',
        transport: 'controlled Electron + CDP',
        realOpenSsh: 'not executed',
        networkJitter: 'not executed',
      },
      electronLog: electronLog.join('').slice(-4000),
    }
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
    console.log(
      JSON.stringify({ status: 'passed', checks: checks.length, screenshots: screenshots.length }),
    )
  } catch (error) {
    exitCode = 1
    const report = {
      status: 'failed',
      error: String(error?.stack ?? error),
      checks,
      screenshots,
      notes,
    }
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
    console.error(error)
  } finally {
    cdp?.close()
    try {
      child?.kill()
    } catch {
      // Child may have exited already.
    }
    try {
      await fixture?.close()
    } catch {
      // Fixture may already be closed.
    }
    await stopStallServer().catch(() => undefined)
    if (exitCode !== 0) {
      console.error(`artifacts retained at ${workDir}`)
    } else {
      await sleep(500)
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // Windows may still hold a file; artifacts are not required on success.
      }
    }
  }
  process.exitCode = exitCode
}

await main()
