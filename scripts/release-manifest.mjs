import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { arch, platform, release, version } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { listPackage, extractFile } from '@electron/asar'

const ROOT = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    args[key] = value
    i += 1
  }
  return args
}

function sha256File(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

function artifact(file, displayPath = file) {
  const absolute = resolve(ROOT, file)
  if (!existsSync(absolute)) throw new Error(`artifact not found: ${absolute}`)
  return {
    path: displayPath,
    absolutePath: absolute,
    bytes: statSync(absolute).size,
    sha256: sha256File(absolute),
  }
}

function gitState() {
  if (!existsSync(join(ROOT, '.git'))) {
    return { commit: 'unavailable', dirty: 'unavailable', reason: 'no .git directory' }
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
    return { commit, dirty }
  } catch (error) {
    return { commit: 'unavailable', dirty: 'unavailable', reason: String(error.message) }
  }
}

function powershellJson(script) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0 || !result.stdout.trim()) {
    return { available: false, error: (result.stderr || '').trim() || 'powershell failed' }
  }
  try {
    return { available: true, value: JSON.parse(result.stdout) }
  } catch {
    return { available: false, error: result.stdout.trim() }
  }
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function signingState(file) {
  const script = `$s = Get-AuthenticodeSignature -LiteralPath ${quotePowerShell(file)}; [PSCustomObject]@{ status = $s.Status.ToString(); subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress`
  const result = powershellJson(script)
  if (!result.available) return { status: 'unavailable', error: result.error }
  return result.value
}

function peMetadata(file) {
  const script = `$i = (Get-Item -LiteralPath ${quotePowerShell(file)}).VersionInfo; [PSCustomObject]@{ fileVersion = $i.FileVersion; productVersion = $i.ProductVersion; companyName = $i.CompanyName; fileDescription = $i.FileDescription; productName = $i.ProductName } | ConvertTo-Json -Compress`
  const result = powershellJson(script)
  if (!result.available) return { available: false, error: result.error }
  return result.value
}

function normalizeEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '')
}

function inspectAsar(asarPath) {
  const entries = listPackage(asarPath).map(normalizeEntry)
  const topLevel = [...new Set(entries.map((entry) => entry.split('/')[0]))].sort()
  const forbidden = entries.filter((entry) => {
    if (/\.map$/i.test(entry)) return true
    if (/\.env(\.|$)/i.test(entry)) return true
    return /^(tests?|src|docs|scripts|release|coverage|\.github)\//.test(entry)
  })
  const packageJson = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8'))
  const mainText = extractFile(asarPath, join('out', 'main', 'index.js')).toString('utf8')
  const devServerUrlLiterals = ['localhost:5173', '127.0.0.1:5173'].filter((needle) =>
    mainText.includes(needle),
  )
  return {
    entries: entries.length,
    topLevel,
    forbidden,
    devServerUrlLiterals,
    packageJson: {
      name: packageJson.name,
      version: packageJson.version,
      main: packageJson.main,
      dependencies: Object.keys(packageJson.dependencies ?? {}).sort(),
      devDependencies: Object.keys(packageJson.devDependencies ?? {}).length,
    },
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'))
}

function latestAcceptanceReport() {
  const acceptanceDir = join(ROOT, 'release', 'acceptance')
  if (!existsSync(acceptanceDir)) throw new Error('no acceptance reports found')
  const reports = readdirSync(acceptanceDir)
    .map((name) => join(acceptanceDir, name, 'runtime-report.json'))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (reports.length === 0) throw new Error('no acceptance reports found')
  return reports[0].file
}

const args = parseArgs(process.argv.slice(2))
const installerArg =
  args.installer ?? `release/TermForge Setup ${readJson('package.json').version}.exe`
const blockmapArg = args.blockmap ?? `${installerArg}.blockmap`
const acceptanceArg = args.acceptance ?? latestAcceptanceReport()

const appDir = resolve(ROOT, args['app-dir'] ?? 'release/win-unpacked')
const exePath = join(appDir, 'TermForge.exe')
const asarPath = join(appDir, 'resources', 'app.asar')
const unpackedPagent = join(
  appDir,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'ssh2',
  'util',
  'pagent.exe',
)
for (const file of [exePath, asarPath, unpackedPagent]) {
  if (!existsSync(file)) throw new Error(`packaged file not found: ${file}`)
}

const pkg = readJson('package.json')
const acceptance = readJson(acceptanceArg)
const asar = inspectAsar(asarPath)
const git = gitState()
const signing = {
  installer: signingState(resolve(ROOT, installerArg)),
  executable: signingState(exePath),
}
const manifest = {
  product: 'TermForge',
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  source: git,
  environment: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    osVersion: version(),
    node: process.version,
    npm: execFileSync('cmd', ['/c', 'npm', '--version'], { encoding: 'utf8' }).trim(),
    electron: pkg.devDependencies.electron,
    electronBuilder: pkg.devDependencies['electron-builder'],
    electronVite: pkg.devDependencies['electron-vite'],
    vite: pkg.devDependencies.vite,
    typescript: pkg.devDependencies.typescript,
  },
  signing: {
    installer: signing.installer.status,
    executable: signing.executable.status,
    certificateSubject: signing.installer.subject ?? null,
    status:
      signing.installer.status === 'NotSigned' && signing.executable.status === 'NotSigned'
        ? 'unsigned-test-build'
        : 'see-per-file-status',
  },
  peMetadata: peMetadata(exePath),
  buildOutput: appDir,
  artifacts: {
    installer: artifact(installerArg),
    blockmap: artifact(blockmapArg),
    appAsar: artifact(asarPath, 'win-unpacked/resources/app.asar'),
    executable: artifact(exePath, 'win-unpacked/TermForge.exe'),
  },
  asar,
  unpacked: {
    pagentExe: artifact(
      unpackedPagent,
      'win-unpacked/resources/app.asar.unpacked/node_modules/ssh2/util/pagent.exe',
    ),
  },
  acceptance: {
    report: resolve(ROOT, acceptanceArg),
    generatedAt: acceptance.generatedAt,
    status: acceptance.summary?.status,
    checks: acceptance.summary?.checks,
    failed: acceptance.summary?.failed,
    secretOrTerminalLeaks: acceptance.summary?.secretOrTerminalLeaks,
    limitations: acceptance.limitations,
  },
  limitations: [
    'Unsigned test build: Authenticode signing is not configured and must be completed before public distribution.',
    'Installer install, uninstall, user-data retention and true upgrade were not executed; they require separate authorization.',
    'No clean Windows VM or Windows CI environment was available.',
    'Windows OpenSSH Server was not installed, configured or tested.',
    'The SSH/SFTP acceptance server is a local ssh2 fixture with a simplified PTY, not Windows OpenSSH Server.',
    'The icon is a provisional mark derived from the in-app brand and is pending brand confirmation.',
    'No git repository is present, so the source commit is unavailable.',
  ],
}

const outPath = resolve(ROOT, args.out ?? 'release/build-metadata.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ outPath, manifest }, null, 2))
