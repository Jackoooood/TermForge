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
const OUT_DIR = resolve('release/acceptance/p1-04-quick-commands')
const PASSWORD = 'p1-04-accept-password'
const COMMAND_TOKEN = 'TF_P1_04_APPROVED'
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
    await sleep(150)
  }
  throw new Error(
    `timeout: ${label}${lastError ? ` (${String(lastError.message ?? lastError)})` : ''}`,
  )
}

const HELPERS = `(() => {
  const textOf = (el) => (el && (el.textContent || '')).replace(/\\s+/g, ' ').trim()
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
  window.__qcAccept = {
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
    clickLabel(label, root = document) {
      const button = root.querySelector('[aria-label="' + label + '"]')
      if (!button) throw new Error('aria-label not found: ' + label)
      button.click()
      return true
    },
    clickLabelPrefix(prefix, root = document) {
      const button = [...root.querySelectorAll('[aria-label]')].find((el) =>
        String(el.getAttribute('aria-label')).startsWith(prefix),
      )
      if (!button) throw new Error('aria-label prefix not found: ' + prefix)
      button.click()
      return true
    },
    clickTab(label, root = document) {
      const tab = [...root.querySelectorAll('[role="tab"]')].find((el) =>
        textOf(el).startsWith(label),
      )
      if (!tab) throw new Error('tab not found: ' + label)
      tab.click()
      return true
    },
    card(cardLabel) {
      return document.querySelector('article[aria-label="' + CSS.escape(cardLabel) + '"]')
    },
    clickCardButton(cardLabel, buttonText) {
      const card = this.card(cardLabel)
      if (!card) throw new Error('card not found: ' + cardLabel)
      this.clickButton(buttonText, card)
      return true
    },
    setField(labelText, value) {
      const label = [...document.querySelectorAll('label')].find((el) =>
        textOf(el).startsWith(labelText),
      )
      if (!label) throw new Error('label not found: ' + labelText)
      const control = document.getElementById(label.htmlFor)
      if (!control) throw new Error('control not found for label: ' + labelText)
      setControlValue(control, value)
      return control.value
    },
    setRowCheckbox(rowLabel, checked) {
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
    selectValueValueEndingWith(sessionId) {
      const select = document.querySelector('.qc-compose select')
      if (!select) throw new Error('compose select not found')
      const option = [...select.options].find((item) => item.value.endsWith(sessionId))
      if (!option) throw new Error('option not found for session: ' + sessionId)
      setControlValue(select, option.value)
      return option.value
    },
  }
  return true
})()`

const STATE_BINDINGS = `(() => {
  const api = window.termforge
  window.__qc = { statuses: [], outputs: {}, shellStatuses: [], exits: [] }
  api.ssh.onSessionStatus((event) => window.__qc.statuses.push(event.session))
  api.terminal.onOutput((event) => {
    ;(window.__qc.outputs[event.sessionId] ||= []).push(event.data)
  })
  api.terminal.onStatus((event) => window.__qc.shellStatuses.push(event))
  api.terminal.onExit((event) => window.__qc.exits.push(event))
  return true
})()`

function outputFor(sessionId) {
  return `(window.__qc.outputs[${JSON.stringify(sessionId)}] || []).join('')`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const workDir = mkdtempSync(join(tmpdir(), 'termforge-p1-04-'))
  const userDataDir = join(workDir, 'user-data')
  const appDataDir = join(workDir, 'appdata')
  const fixtureRoot = createFixtureRoot(join(workDir, 'fixture-root'))
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(appDataDir, { recursive: true })

  const checks = []
  const screenshots = []
  const notes = []
  let cdp = null
  let child = null
  let fixture = null
  let exitCode = 0

  const check = (id, fn) => {
    try {
      const details = fn()
      checks.push({ id, status: 'passed', details })
      console.log(`CHECK passed ${id}`)
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

  try {
    const hostKey = createHostKey()
    fixture = await startFixtureSshServer({
      hostKey,
      rootDir: fixtureRoot,
      password: PASSWORD,
    })
    notes.push({ fixturePort: fixture.port, workDir })

    const cdpPort = await getFreePort()
    const launchEnv = {
      ...process.env,
      APPDATA: appDataDir,
      LOCALAPPDATA: appDataDir,
    }
    // Ancestor tooling may set this; Electron would then run as Node and never open a window.
    delete launchEnv.ELECTRON_RUN_AS_NODE
    child = spawn(
      ELECTRON,
      [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, REPO_ROOT],
      {
        cwd: REPO_ROOT,
        env: launchEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
    check('history-default-off', () => {
      if (!settingsBefore?.ok) throw new Error(JSON.stringify(settingsBefore))
      if (settingsBefore.value.preferences.commandHistoryEnabled !== false) {
        throw new Error('new profile must default command history to off')
      }
      return { commandHistoryEnabled: settingsBefore.value.preferences.commandHistoryEnabled }
    })

    await cdp.evaluate(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'K',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }))
      return true
    })()`)
    await waitFor(
      cdp,
      `!!document.querySelector('[aria-labelledby="quick-command-title"]')`,
      5000,
      'quick command drawer by shortcut',
    )
    const emptyTargetNotice = await cdp.evaluate(
      `document.querySelector('.qc-target-strip')?.innerText ?? ''`,
    )
    check('shortcut-opens-drawer-without-target', () => {
      if (!emptyTargetNotice.includes('未捕获可发送终端')) {
        throw new Error(`unexpected target strip: ${emptyTargetNotice}`)
      }
      return { targetStrip: emptyTargetNotice }
    })
    await cdp.evaluate(`__qcAccept.clickLabel('关闭快速命令')`)

    const connectionName = `P1-04 验收 ${RUN}`
    const setup = await cdp.evaluate(`(async () => {
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
        tags: ['acceptance', 'p1-04'],
      })
      if (!created.ok) throw new Error(JSON.stringify(created))
      const credential = await api.ssh.saveCredential({
        connectionId: created.value.id,
        kind: 'password',
        secret: ${JSON.stringify(PASSWORD)},
      })
      if (!credential.ok) throw new Error(JSON.stringify(credential))
      return { connectionId: created.value.id }
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
      `!!__qcAccept.button('快速命令') || !![...document.querySelectorAll('[aria-label]')].find((el) => String(el.getAttribute('aria-label')).startsWith('连接 ${connectionName.replace(/"/g, '\\"')}'))`,
      15000,
      'server sidebar rendered',
    )

    await cdp.evaluate(`__qcAccept.clickLabelPrefix(${JSON.stringify(`连接 ${connectionName}`)})`)
    await waitFor(cdp, `!!__qcAccept.button('信任并继续')`, 15000, 'host key prompt')
    await cdp.evaluate(`__qcAccept.clickButton('信任并继续')`)

    const sessionA = await waitFor(
      cdp,
      `(async () => {
        const api = window.termforge
        const connected = window.__qc.statuses.filter((item) => item.status === 'connected')
        for (const session of connected) {
          const shell = await api.terminal.getStatus(session.sessionId)
          if (shell.ok && shell.value.status === 'open') return session.sessionId
        }
        return null
      })()`,
      20000,
      'first shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionA)}).includes('tfuser@acceptance')`,
      10000,
      'first fixture prompt',
    )
    await waitFor(cdp, `!!__qcAccept.button('快速命令')`, 10000, 'terminal toolbar quick commands')
    check('real-ssh-terminal-ready', () => ({
      connectionId: setup.connectionId,
      sessionId: sessionA,
      fixturePort: fixture.port,
      promptSeen: true,
    }))

    await cdp.evaluate(`__qcAccept.clickButton('快速命令')`)
    await waitFor(
      cdp,
      `!!document.querySelector('[aria-labelledby="quick-command-title"]')`,
      5000,
      'drawer open',
    )
    await cdp.evaluate(`__qcAccept.clickTab('历史')`)
    await waitFor(
      cdp,
      `document.body.innerText.includes('命令历史已在设置中关闭')`,
      5000,
      'history-off notice',
    )
    const connectedTargetNotice = await cdp.evaluate(
      `document.querySelector('.qc-target-strip')?.innerText ?? ''`,
    )
    check('drawer-history-off-disclosure', () => ({
      notice: '命令历史已在设置中关闭',
      targetStrip: connectedTargetNotice,
    }))
    await cdp.evaluate(`__qcAccept.clickTab('命令库')`)
    await waitFor(cdp, `!!__qcAccept.card('系统运行时间')`, 10000, 'built-in card')
    await cdp.evaluate(`__qcAccept.clickCardButton('系统运行时间', '发送')`)
    await waitFor(cdp, `!!__qcAccept.button('确认发送')`, 5000, 'send compose')
    const composeOne = await cdp.evaluate(`(() => ({
      title: document.querySelector('.modal__title')?.innerText ?? '',
      preview: document.querySelector('[aria-label="最终命令预览"]')?.innerText ?? '',
      target: document.querySelector('.qc-compose select')?.value ?? '',
      historyOff: document.body.innerText.includes('命令历史已在设置中关闭，本次发送不会记录'),
      historyCheckboxes: document.querySelectorAll('.qc-compose input[type="checkbox"]').length,
    }))()`)
    await screenshot('01-send-compose-history-off')
    check('send-confirmation-preview-and-history-off', () => {
      if (composeOne.preview !== 'uptime') {
        throw new Error(`unexpected preview: ${JSON.stringify(composeOne)}`)
      }
      if (!composeOne.target.endsWith(sessionA)) {
        throw new Error(
          `compose target did not stay on captured session: ${JSON.stringify(composeOne)}`,
        )
      }
      if (!composeOne.historyOff || composeOne.historyCheckboxes !== 0) {
        throw new Error(`history should be off without checkbox: ${JSON.stringify(composeOne)}`)
      }
      return composeOne
    })
    await cdp.evaluate(`__qcAccept.clickButton('确认发送')`)
    await waitFor(
      cdp,
      `(${outputFor(sessionA)}).includes('acceptance-shell: uptime')`,
      10000,
      'uptime written to real shell',
    )
    await waitFor(cdp, `!document.querySelector('.qc-compose')`, 5000, 'send compose closed')
    const historyAfterOffSend = await cdp.evaluate(`window.termforge.commandHistory.list()`)
    const uptimeOutput = await cdp.evaluate(`(${outputFor(sessionA)}).slice(-400)`)
    check('send-uses-real-shell-and-does-not-record-when-off', () => {
      if (!historyAfterOffSend?.ok) throw new Error(JSON.stringify(historyAfterOffSend))
      if (historyAfterOffSend.value.entries.length !== 0) {
        throw new Error(`history should be empty: ${JSON.stringify(historyAfterOffSend.value)}`)
      }
      return {
        output: uptimeOutput,
        historyEntries: historyAfterOffSend.value.entries.length,
      }
    })

    await cdp.evaluate(`__qcAccept.clickCardButton('当前身份', '插入')`)
    await waitFor(cdp, `!!__qcAccept.button('插入到终端')`, 5000, 'insert compose')
    await cdp.evaluate(`__qcAccept.clickButton('插入到终端')`)
    await waitFor(cdp, `document.body.innerText.includes('已插入终端输入行')`, 5000, 'insert toast')
    await sleep(500)
    const afterInsert = await cdp.evaluate(outputFor(sessionA))
    await cdp.evaluate(`window.termforge.terminal.write(${JSON.stringify(sessionA)}, '\\r')`)
    await waitFor(
      cdp,
      `(${outputFor(sessionA)}).includes('acceptance-shell: id')`,
      10000,
      'inserted id executed after explicit Enter',
    )
    check('insert-does-not-append-enter', () => {
      if (afterInsert.includes('acceptance-shell: id')) {
        throw new Error('insert unexpectedly executed the command before Enter')
      }
      return { outputBeforeEnter: afterInsert.slice(-120) }
    })
    await screenshot('02-after-insert-and-send')
    await cdp.evaluate(`__qcAccept.clickLabel('关闭快速命令')`)

    await cdp.evaluate(`__qcAccept.clickLabel('设置')`)
    await waitFor(
      cdp,
      `!!__qcAccept.button('会话与传输记录') || !![...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('会话与传输记录'))`,
      10000,
      'settings view',
    )
    await cdp.evaluate(`__qcAccept.clickTab('会话与传输记录')`)
    await waitFor(
      cdp,
      `document.body.innerText.includes('默认关闭。启用后，只有在快速命令发送确认中勾选')`,
      5000,
      'history settings row',
    )
    const disclosure = await cdp.evaluate(`document.body.innerText`)
    await cdp.evaluate(`__qcAccept.setRowCheckbox('命令历史', true)`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.settings.get()
        return result.ok && result.value.preferences.commandHistoryEnabled === true
      })()`,
      5000,
      'history setting persisted on',
    )
    check('settings-exposes-history-toggle-and-disclosure', () => {
      if (!disclosure.includes('command-history.json')) {
        throw new Error('missing command-history.json disclosure')
      }
      if (!disclosure.includes('未额外加密')) {
        throw new Error('missing unencrypted history disclosure')
      }
      if (!disclosure.includes('清空命令历史')) {
        throw new Error('missing clear-history control')
      }
      return { enabled: true, disclosure: 'command-history.json / 未额外加密 / 清空命令历史' }
    })
    await screenshot('03-settings-history-enabled')
    await cdp.evaluate(`__qcAccept.clickButton('工作台')`)
    await waitFor(cdp, `!!__qcAccept.button('快速命令')`, 10000, 'workbench restored')

    await cdp.evaluate(`__qcAccept.clickButton('快速命令')`)
    await waitFor(cdp, `!!__qcAccept.button('新建')`, 5000, 'drawer new button')
    await cdp.evaluate(`__qcAccept.clickButton('新建')`)
    await waitFor(cdp, `!!__qcAccept.button('保存命令')`, 5000, 'editor open')
    await cdp.evaluate(`__qcAccept.setField('命令名称', '验收站点探测')`)
    await cdp.evaluate(`__qcAccept.setField('分类', '验收')`)
    await cdp.evaluate(`__qcAccept.setField('命令正文', 'echo ${COMMAND_TOKEN}_{{token}}')`)
    await cdp.evaluate(`__qcAccept.setField('token', 'approved')`)
    await screenshot('04-custom-command-editor')
    await cdp.evaluate(`__qcAccept.clickButton('保存命令')`)
    await waitFor(cdp, `!!__qcAccept.card('验收站点探测')`, 10000, 'custom command card')
    const customList = await cdp.evaluate(`window.termforge.quickCommands.list()`)
    const customCommand = customList.value.commands.find((item) => item.name === '验收站点探测')
    check('custom-command-created-with-parameters', () => {
      if (!customCommand) throw new Error('custom command missing')
      if (customCommand.parameters[0]?.name !== 'token') {
        throw new Error(`unexpected parameters: ${JSON.stringify(customCommand.parameters)}`)
      }
      if (customCommand.source !== 'custom') {
        throw new Error(`custom source expected: ${JSON.stringify(customCommand)}`)
      }
      return {
        id: customCommand.id,
        body: customCommand.body,
        parameters: customCommand.parameters,
        builtInReadOnly: (
          customList.value.commands.filter((item) => item.source === 'built-in') || []
        ).every((item) => !item.editable),
      }
    })

    await cdp.evaluate(`__qcAccept.clickCardButton('验收站点探测', '发送')`)
    await waitFor(cdp, `!!__qcAccept.button('确认发送')`, 5000, 'custom send compose')
    const composeCustom = await cdp.evaluate(`(() => ({
      preview: document.querySelector('[aria-label="最终命令预览"]')?.innerText ?? '',
      target: document.querySelector('.qc-compose select')?.value ?? '',
      historyChecked: document.querySelector('.qc-compose input[type="checkbox"]')?.checked ?? false,
    }))()`)
    check('custom-send-preview-and-history-default-checked', () => {
      if (composeCustom.preview !== `echo ${COMMAND_TOKEN}_approved`) {
        throw new Error(`unexpected rendered preview: ${JSON.stringify(composeCustom)}`)
      }
      if (!composeCustom.target.endsWith(sessionA)) {
        throw new Error(`unexpected target: ${JSON.stringify(composeCustom)}`)
      }
      if (composeCustom.historyChecked !== true) {
        throw new Error('history checkbox must default checked when enabled')
      }
      return composeCustom
    })
    await screenshot('05-custom-send-compose')
    await cdp.evaluate(`__qcAccept.clickButton('确认发送')`)
    await waitFor(
      cdp,
      `(${outputFor(sessionA)}).includes('${COMMAND_TOKEN}_approved')`,
      10000,
      'custom command executed on real shell',
    )
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.commandHistory.list()
        return result.ok && result.value.entries.length === 1
      })()`,
      10000,
      'history entry recorded',
    )
    const historyOne = await cdp.evaluate(`window.termforge.commandHistory.list()`)
    check('history-records-rendered-body-only', () => {
      const entry = historyOne.value.entries[0]
      if (entry.body !== `echo ${COMMAND_TOKEN}_approved`) {
        throw new Error(`unexpected history body: ${JSON.stringify(entry)}`)
      }
      if (entry.sessionId !== sessionA) {
        throw new Error(`history session mismatch: ${JSON.stringify(entry)}`)
      }
      const serialized = JSON.stringify(entry)
      if (serialized.includes('acceptance-shell') || serialized.includes('tfuser@acceptance')) {
        throw new Error('terminal output leaked into history')
      }
      return entry
    })
    await cdp.evaluate(`__qcAccept.clickTab('历史')`)
    await waitFor(
      cdp,
      `!!__qcAccept.card('历史记录 echo ${COMMAND_TOKEN}_approved')`,
      5000,
      'history card',
    )
    await screenshot('06-history-recorded')
    await cdp.evaluate(`__qcAccept.clickLabel('关闭快速命令')`)

    await cdp.evaluate(`__qcAccept.clickLabelPrefix(${JSON.stringify(`连接 ${connectionName}`)})`)
    const sessionB = await waitFor(
      cdp,
      `(async () => {
        const api = window.termforge
        const connected = window.__qc.statuses.filter((item) => item.status === 'connected')
        for (const session of connected) {
          if (session.sessionId === ${JSON.stringify(sessionA)}) continue
          const shell = await api.terminal.getStatus(session.sessionId)
          if (shell.ok && shell.value.status === 'open') return session.sessionId
        }
        return null
      })()`,
      20000,
      'second shell open',
    )
    await waitFor(
      cdp,
      `(${outputFor(sessionB)}).includes('tfuser@acceptance')`,
      10000,
      'second fixture prompt',
    )
    check('two-independent-real-shells', () => ({ sessionA, sessionB }))

    await cdp.evaluate(`__qcAccept.clickButton('快速命令')`)
    await waitFor(cdp, `!!__qcAccept.card('系统运行时间')`, 5000, 'drawer on second tab')
    await cdp.evaluate(`__qcAccept.clickCardButton('系统运行时间', '发送')`)
    await waitFor(cdp, `!!__qcAccept.button('确认发送')`, 5000, 'second compose')
    const capturedOnB = await cdp.evaluate(
      `document.querySelector('.qc-compose select')?.value ?? ''`,
    )
    await cdp.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.session-tab')]
      if (tabs.length < 2) throw new Error('expected two session tabs')
      tabs[0].click()
      return true
    })()`)
    await cdp.evaluate(`window.termforge.terminal.close(${JSON.stringify(sessionB)})`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.terminal.getStatus(${JSON.stringify(sessionB)})
        return result.ok && result.value.status === 'closed'
      })()`,
      10000,
      'second shell closed',
    )
    await waitFor(
      cdp,
      `document.body.innerText.includes('不会自动切换目标')`,
      5000,
      'captured target invalid warning',
    )
    const staleTarget = await cdp.evaluate(`(() => {
      const select = document.querySelector('.qc-compose select')
      const options = select ? [...select.options].map((item) => item.value) : []
      return {
        value: select?.value ?? '',
        options,
        confirmDisabled: __qcAccept.button('确认发送')?.disabled ?? null,
        warning: document.body.innerText.includes('不会自动切换目标'),
      }
    })()`)
    check('stale-captured-target-never-auto-switches', () => {
      if (capturedOnB.endsWith(sessionA)) {
        throw new Error(`captured target unexpectedly followed active tab: ${capturedOnB}`)
      }
      if (!capturedOnB.endsWith(sessionB)) {
        throw new Error(`captured target was not the second tab: ${capturedOnB}`)
      }
      if (!staleTarget.confirmDisabled) {
        throw new Error(
          `confirm must be disabled with stale target: ${JSON.stringify(staleTarget)}`,
        )
      }
      if (!staleTarget.options.some((value) => value.endsWith(sessionA))) {
        throw new Error('first tab should be available for explicit reselect')
      }
      if (staleTarget.value.endsWith(sessionA)) {
        throw new Error('stale target silently switched to the first tab')
      }
      return { capturedOnB, staleTarget }
    })
    await screenshot('07-stale-target-requires-explicit-selection')
    const uptimeBefore = await cdp.evaluate(
      `((${outputFor(sessionA)}).match(/acceptance-shell: uptime/g) || []).length`,
    )
    await cdp.evaluate(`__qcAccept.selectValueValueEndingWith(${JSON.stringify(sessionA)})`)
    await waitFor(
      cdp,
      `__qcAccept.button('确认发送') && __qcAccept.button('确认发送').disabled === false`,
      5000,
      'confirm enabled after explicit reselect',
    )
    await cdp.evaluate(`__qcAccept.clickButton('确认发送')`)
    await waitFor(
      cdp,
      `((${outputFor(sessionA)}).match(/acceptance-shell: uptime/g) || []).length > ${uptimeBefore}`,
      10000,
      'explicit target receives command',
    )
    const historyTwo = await cdp.evaluate(`window.termforge.commandHistory.list()`)
    check('explicit-selection-sends-only-to-selected-session', () => {
      if (historyTwo.value.entries.length !== 2) {
        throw new Error(`expected 2 history entries: ${JSON.stringify(historyTwo.value)}`)
      }
      const latest = historyTwo.value.entries[0]
      if (latest.sessionId !== sessionA) {
        throw new Error(`latest history target mismatch: ${JSON.stringify(latest)}`)
      }
      return { entries: historyTwo.value.entries.length, latest }
    })

    await cdp.evaluate(`__qcAccept.clickTab('历史')`)
    await waitFor(
      cdp,
      `document.querySelectorAll('article[aria-label^="历史记录"]').length === 2`,
      5000,
      'two history cards',
    )
    await cdp.evaluate(`__qcAccept.clickLabel('删除该历史记录')`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.commandHistory.list()
        return result.ok && result.value.entries.length === 1
      })()`,
      5000,
      'single history delete',
    )
    await screenshot('08-history-delete')
    await cdp.evaluate(`__qcAccept.clickButton('清空历史')`)
    await waitFor(
      cdp,
      `!!document.querySelector('[aria-label="确认清空命令历史"]')`,
      5000,
      'clear history confirmation',
    )
    await cdp.evaluate(`__qcAccept.clickButton('确认清空')`)
    await waitFor(
      cdp,
      `(async () => {
        const result = await window.termforge.commandHistory.list()
        return result.ok && result.value.entries.length === 0
      })()`,
      5000,
      'history cleared',
    )
    check('history-delete-and-clear', () => ({ deletedOne: true, cleared: true }))
    await screenshot('09-history-cleared')
    await cdp.evaluate(`__qcAccept.clickLabel('关闭快速命令')`)

    const userDataRoot = resolve(logInfo.value.directory, '..')
    const historyPath = join(userDataRoot, 'command-history.json')
    const settingsPath = join(userDataRoot, 'settings.json')
    const logsPath = logInfo.value.directory
    await sleep(500)
    const historyFile = JSON.parse(readFileSync(historyPath, 'utf8'))
    const settingsFile = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const logText = readdirSync(logsPath)
      .filter((name) => name.endsWith('.log'))
      .map((name) => readFileSync(join(logsPath, name), 'utf8'))
      .join('\n')
    check('persistence-and-log-separation', () => {
      if (settingsFile.version !== 3) {
        throw new Error(`expected settings v3, got ${settingsFile.version}`)
      }
      if (settingsFile.preferences.commandHistoryEnabled !== true) {
        throw new Error('history setting not persisted')
      }
      const entries = Array.isArray(historyFile?.data?.entries) ? historyFile.data.entries : null
      if (entries === null || entries.length !== 0) {
        throw new Error(`unexpected history file: ${JSON.stringify(historyFile)}`)
      }
      if (logText.includes(COMMAND_TOKEN) || logText.includes('acceptance-shell')) {
        throw new Error('command text or terminal output leaked into logs')
      }
      return {
        historyFileVersion: historyFile.version,
        historyEntries: entries.length,
        settingsVersion: settingsFile.version,
        commandHistoryEnabled: settingsFile.preferences.commandHistoryEnabled,
        logsContainCommandText: false,
      }
    })

    await cdp.evaluate(`__qcAccept.clickLabel('设置')`)
    await waitFor(
      cdp,
      `!!__qcAccept.button('会话与传输记录') || !![...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('会话与传输记录'))`,
      10000,
      'settings reopened',
    )
    await cdp.evaluate(`__qcAccept.clickTab('会话与传输记录')`)
    await waitFor(
      cdp,
      `document.body.innerText.includes('清空命令历史')`,
      5000,
      'history settings row',
    )
    await cdp.evaluate(`__qcAccept.clickButton('清空命令历史')`)
    await waitFor(
      cdp,
      `document.body.innerText.includes('清空命令历史？')`,
      5000,
      'settings clear history confirmation',
    )
    const clearModalText = await cdp.evaluate(`document.body.innerText`)
    check('settings-clear-history-requires-confirmation', () => {
      if (!clearModalText.includes('该操作会删除本机保存的全部快速命令历史')) {
        throw new Error('clear confirmation text missing')
      }
      return { confirmationShown: true }
    })
    await cdp.evaluate(`__qcAccept.clickButton('取消')`)
    await screenshot('10-settings-history-disclosure')

    const report = {
      status: 'passed',
      checks,
      screenshots,
      notes,
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
