import { app, BrowserWindow } from 'electron'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(projectRoot, 'build')
const sourcePath = join(buildDir, 'icon.svg')
const pngPath = join(buildDir, 'icon.png')
const icoPath = join(buildDir, 'icon.ico')
const logPath = join(buildDir, 'icon-generation.log')
const ICO_SIZES = [256, 128, 64, 48, 32, 16]

app.disableHardwareAcceleration()

// Destroying the render window would otherwise trigger Electron's default
// quit-on-last-window behavior before the icon files are written.
app.on('window-all-closed', () => {})

function log(message) {
  return appendFile(logPath, `${new Date().toISOString()} ${message}\n`)
}

function createIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  images.forEach(({ size, png }, index) => {
    const entry = index * 16
    entries.writeUInt8(size === 256 ? 0 : size, entry)
    entries.writeUInt8(size === 256 ? 0 : size, entry + 1)
    entries.writeUInt8(0, entry + 2)
    entries.writeUInt8(0, entry + 3)
    entries.writeUInt16LE(1, entry + 4)
    entries.writeUInt16LE(32, entry + 6)
    entries.writeUInt32LE(png.length, entry + 8)
    entries.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

async function renderSvg(svg) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;overflow:hidden}
svg{display:block;width:256px;height:256px}
</style></head><body>${svg}</body></html>`

  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const captured = await window.webContents.capturePage()
    await log(
      `captured size=${captured.getSize().width}x${captured.getSize().height} empty=${captured.isEmpty()} pngBytes=${captured.toPNG().length}`,
    )
    if (captured.isEmpty()) throw new Error('capturePage returned an empty image')
    const normalized =
      captured.getSize().width === 256
        ? captured
        : captured.resize({ width: 256, height: 256, quality: 'best' })
    return normalized
  } finally {
    window.destroy()
  }
}

async function main() {
  await mkdir(buildDir, { recursive: true })
  await writeFile(logPath, '')
  const svg = await readFile(sourcePath, 'utf8')
  const master = await renderSvg(svg)
  const masterPng = master.toPNG()
  await log(`master png bytes=${masterPng.length}`)
  if (masterPng.length === 0) throw new Error('master PNG is empty')

  await writeFile(pngPath, masterPng)
  const images = ICO_SIZES.map((size) => ({
    size,
    png: master.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))
  await writeFile(icoPath, createIco(images))
  await log(`wrote ${pngPath} and ${icoPath}`)
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.quit(),
    async (error) => {
      await log(`ERROR ${error?.stack ?? String(error)}`).catch(() => undefined)
      app.exit(1)
    },
  )
