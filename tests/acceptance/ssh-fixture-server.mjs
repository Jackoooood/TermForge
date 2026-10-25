import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, posix } from 'node:path'

const require = createRequire(import.meta.url)
const { Server } = require('ssh2')

const OPEN_MODE = { READ: 1, WRITE: 2, APPEND: 4, CREAT: 8, TRUNC: 16, EXCL: 32 }
const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
}

export const HOME_PATH = '/acceptance'
export const FIXTURE_USER = 'tfuser'

export function createHostKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' })
}

export function createFixtureRoot(rootDir) {
  mkdirSync(rootDir, { recursive: true })
  writeFileSync(join(rootDir, 'alpha.txt'), 'alpha fixture\n')
  writeFileSync(join(rootDir, 'space name.txt'), 'space fixture\n')
  writeFileSync(join(rootDir, 'temp-delete.txt'), 'remove me\n')
  const unicodeDir = join(rootDir, '测试 目录')
  mkdirSync(unicodeDir, { recursive: true })
  writeFileSync(join(unicodeDir, '文件.txt'), 'unicode fixture\n')
  return rootDir
}

function resolveVirtualPath(rootDir, requestedPath) {
  const raw = !requestedPath || requestedPath === '.' ? HOME_PATH : requestedPath
  const virtualPath = posix.normalize(raw.startsWith('/') ? raw : `${HOME_PATH}/${raw}`)
  if (virtualPath !== HOME_PATH && !virtualPath.startsWith(`${HOME_PATH}/`)) {
    throw Object.assign(new Error('path escapes fixture root'), { code: 'EACCES' })
  }
  const relative = virtualPath.slice(HOME_PATH.length).replace(/^\/+/, '')
  const localPath = join(rootDir, ...relative.split('/').filter(Boolean))
  return { virtualPath, localPath }
}

function statsToAttrs(stats) {
  return {
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  }
}

function entryFor(name, localPath, longnamePrefix) {
  const stats = lstatSync(localPath)
  return {
    filename: name,
    longname: `${longnamePrefix} 1 ${FIXTURE_USER} ${FIXTURE_USER} ${stats.size} Jan 1 2026 ${name}`,
    attrs: statsToAttrs(stats),
  }
}

function sendSftpStatus(sftpStream, requestId, error) {
  if (!error) return sftpStream.status(requestId, STATUS_CODE.OK)
  if (error.code === 'ENOENT') return sftpStream.status(requestId, STATUS_CODE.NO_SUCH_FILE)
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return sftpStream.status(requestId, STATUS_CODE.PERMISSION_DENIED)
  }
  return sftpStream.status(requestId, STATUS_CODE.FAILURE)
}

function attachSftpServer(sftpStream, rootDir) {
  const directoryHandles = new Map()
  const fileHandles = new Map()
  let nextHandle = 1

  function allocateHandle(collection, value) {
    const handle = Buffer.alloc(4)
    const id = nextHandle++
    handle.writeUInt32BE(id, 0)
    collection.set(id, value)
    return handle
  }

  function lookup(collection, handle) {
    if (!Buffer.isBuffer(handle) || handle.length !== 4) return null
    return collection.get(handle.readUInt32BE(0)) ?? null
  }

  function statHandler(requestId, requestedPath) {
    try {
      const { localPath } = resolveVirtualPath(rootDir, requestedPath)
      sftpStream.attrs(requestId, statsToAttrs(statSync(localPath)))
    } catch (error) {
      sendSftpStatus(sftpStream, requestId, error)
    }
  }

  sftpStream
    .on('REALPATH', (requestId, requestedPath) => {
      try {
        const { virtualPath } = resolveVirtualPath(rootDir, requestedPath)
        sftpStream.name(requestId, [{ filename: virtualPath, longname: virtualPath, attrs: {} }])
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('STAT', statHandler)
    .on('LSTAT', statHandler)
    .on('OPENDIR', (requestId, requestedPath) => {
      try {
        const { localPath } = resolveVirtualPath(rootDir, requestedPath)
        const names = readdirSync(localPath)
        const entries = names.map((name) => {
          const entryPath = join(localPath, name)
          const isDirectory = lstatSync(entryPath).isDirectory()
          return entryFor(name, entryPath, isDirectory ? 'd' : '-')
        })
        sftpStream.handle(requestId, allocateHandle(directoryHandles, { entries, sent: false }))
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('READDIR', (requestId, handle) => {
      const state = lookup(directoryHandles, handle)
      if (!state) return sftpStream.status(requestId, STATUS_CODE.FAILURE)
      if (state.sent) return sftpStream.status(requestId, STATUS_CODE.EOF)
      state.sent = true
      sftpStream.name(requestId, state.entries)
    })
    .on('OPEN', (requestId, requestedPath, flags) => {
      try {
        const { localPath } = resolveVirtualPath(rootDir, requestedPath)
        let mode = 'r'
        if (flags & OPEN_MODE.WRITE) mode = 'w'
        if (flags & OPEN_MODE.CREAT) mode = 'w+'
        if (flags & OPEN_MODE.EXCL) mode = 'wx'
        if (flags & OPEN_MODE.APPEND) mode = 'a'
        const fd = openSync(localPath, mode)
        sftpStream.handle(requestId, allocateHandle(fileHandles, { fd }))
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('READ', (requestId, handle, offset, length) => {
      const state = lookup(fileHandles, handle)
      if (!state) return sftpStream.status(requestId, STATUS_CODE.FAILURE)
      const buffer = Buffer.alloc(length)
      let bytesRead = 0
      try {
        bytesRead = readSync(state.fd, buffer, 0, length, offset)
      } catch (error) {
        return sendSftpStatus(sftpStream, requestId, error)
      }
      if (bytesRead === 0) return sftpStream.status(requestId, STATUS_CODE.EOF)
      sftpStream.data(requestId, buffer.subarray(0, bytesRead))
    })
    .on('WRITE', (requestId, handle, offset, data) => {
      const state = lookup(fileHandles, handle)
      if (!state) return sftpStream.status(requestId, STATUS_CODE.FAILURE)
      try {
        writeSync(state.fd, data, 0, data.length, offset)
        sftpStream.status(requestId, STATUS_CODE.OK)
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('CLOSE', (requestId, handle) => {
      const file = lookup(fileHandles, handle)
      if (file) {
        fileHandles.delete(handle.readUInt32BE(0))
        try {
          closeSync(file.fd)
        } catch {
          // Closing an already-closed fixture handle is harmless.
        }
        return sftpStream.status(requestId, STATUS_CODE.OK)
      }
      if (lookup(directoryHandles, handle)) {
        directoryHandles.delete(handle.readUInt32BE(0))
        return sftpStream.status(requestId, STATUS_CODE.OK)
      }
      sftpStream.status(requestId, STATUS_CODE.FAILURE)
    })
    .on('MKDIR', (requestId, requestedPath) => {
      try {
        const { localPath } = resolveVirtualPath(rootDir, requestedPath)
        mkdirSync(localPath)
        sftpStream.status(requestId, STATUS_CODE.OK)
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('RENAME', (requestId, oldPath, newPath) => {
      try {
        const source = resolveVirtualPath(rootDir, oldPath)
        const target = resolveVirtualPath(rootDir, newPath)
        renameSync(source.localPath, target.localPath)
        sftpStream.status(requestId, STATUS_CODE.OK)
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('REMOVE', (requestId, requestedPath) => {
      try {
        const { localPath } = resolveVirtualPath(rootDir, requestedPath)
        if (!existsSync(localPath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        unlinkSync(localPath)
        sftpStream.status(requestId, STATUS_CODE.OK)
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
    .on('RMDIR', (requestId, requestedPath) => {
      try {
        const { localPath } = resolveVirtualPath(rootDir, requestedPath)
        rmdirSync(localPath)
        sftpStream.status(requestId, STATUS_CODE.OK)
      } catch (error) {
        sendSftpStatus(sftpStream, requestId, error)
      }
    })
}

export async function startFixtureSshServer({
  hostKey,
  rootDir,
  port = 0,
  username = FIXTURE_USER,
  password,
}) {
  const clients = new Set()
  const readyClients = []
  const forgetClient = (client) => {
    clients.delete(client)
    const index = readyClients.indexOf(client)
    if (index !== -1) readyClients.splice(index, 1)
  }
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on('authentication', (context) => {
      if (
        context.method === 'password' &&
        context.username === username &&
        context.password === password
      ) {
        context.accept()
        return
      }
      context.reject(['password'])
    })
    client.on('ready', () => {
      readyClients.push(client)
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (acceptPty) => {
          if (acceptPty) acceptPty()
        })
        session.on('window-change', (acceptChange) => {
          if (acceptChange) acceptChange()
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          let pending = ''
          stream.write('tfuser@acceptance:~$ ')
          stream.on('data', (chunk) => {
            pending += chunk.toString('utf8')
            for (;;) {
              const match = /\r\n|\r|\n/.exec(pending)
              if (!match) break
              const line = pending.slice(0, match.index)
              pending = pending.slice(match.index + match[0].length)
              const command = line.trim()
              if (command === 'exit') {
                stream.write('logout\r\n')
                stream.exit(0)
                stream.end()
                return
              }
              if (command === 'whoami') stream.write(`tfuser\r\n`)
              else if (command === 'pwd') stream.write(`${HOME_PATH}\r\n`)
              else if (command === 'uname -a') stream.write('TermForge-acceptance-fixture\r\n')
              else if (command.startsWith('echo ')) stream.write(`${command.slice(5)}\r\n`)
              else if (command.length > 0) stream.write(`acceptance-shell: ${command}\r\n`)
              stream.write('tfuser@acceptance:~$ ')
            }
          })
        })
        session.on('sftp', (acceptSftp) => {
          attachSftpServer(acceptSftp(), rootDir)
        })
      })
    })
    client.on('error', () => undefined)
    client.on('close', () => forgetClient(client))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port

  return {
    port: actualPort,
    connectionCount: () => clients.size,
    readyCount: () => readyClients.length,
    /** Server-initiated close used to emulate an unexpected transport loss. */
    dropReadyConnection: (index = 0) => {
      const client = index < 0 ? readyClients[readyClients.length + index] : readyClients[index]
      if (!client) return false
      try {
        client.end()
      } catch {
        // The transport may already be gone.
      }
      return true
    },
    close: async () => {
      for (const client of clients) {
        try {
          client.end()
        } catch {
          // The transport may already be gone.
        }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          for (const client of clients) {
            try {
              client.destroy()
            } catch {
              // Best-effort shutdown for the fixture.
            }
          }
          resolve()
        }, 1500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
