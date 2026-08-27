#!/usr/bin/env node
// Stock-DSH quadrant runner (T07.2, fail-closed):
//   --deployment=npm|source --install=git|tgz
//
// Both deployments install into the OFFICIAL `web` profile: `dsh plugin
// --profile web add <spec>` initializes it from the built-in web template
// (dsh-base + dsh-web-app), so no hand-written bundle links ever run. Boot
// is `dsh web --port <p> --no-open`. Every quadrant installs FOR REAL; the
// evidence JSON is written only from that quadrant's own checks, and green
// is the conjunction of ALL required checks — any failure or block exits
// non-zero.
//
// source deployment uses the local monorepo checkout (SOURCE_DSH);
// npm deployment installs @deepseek-ai/dsh from the registry into an
// isolated prefix (shared per process across calls via NPM_PREFIX).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release as osRelease, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DSH = 'D:\\appset\\DeepSeekHarness\\deepseek-harness-master'

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const args = { deployment: 'source', install: 'tgz' }
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i]
  const value = flag.split('=')[1] ?? process.argv[i + 1]
  if (flag.startsWith('--deployment')) args.deployment = value
  else if (flag.startsWith('--install')) args.install = value
  else if (flag.startsWith('--')) { console.error(`test-stock: unknown flag ${flag}`); process.exit(2) }
  else continue
  if (!flag.includes('=')) i += 1
}

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TARBALL = `bululuburuarua666-dsh-plugin-manager-${PKG.version}.tgz`
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@bululuburuarua666/dsh-plugin-manager']
const stamp = new Date().toISOString()

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) finish('failed')
}

let home = null
let serverPid = null
function killServer() {
  if (serverPid === null) return
  try { execFileSync('cmd', ['/c', `taskkill /F /T /PID ${serverPid} >nul 2>&1`]) } catch { /* gone */ }
  serverPid = null
}
/** Capture boot log + toolchain/OS/run info next to the quadrant evidence. */
function persistDiagnostics(dir, quadrant) {
  const bootLog = join(home ?? '', 'boot.log')
  if (home !== null && existsSync(bootLog)) {
    try { copyFileSync(bootLog, join(dir, `${quadrant}-boot.log`)) } catch { /* best effort */ }
  }
  const environment = {
    quadrant,
    timestamp: stamp,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runSha: process.env.GITHUB_SHA ?? null,
    node: process.version,
    os: `${process.platform} ${osRelease()}`,
  }
  for (const tool of ['pnpm', 'npm']) {
    try { environment[tool] = execFileSync('cmd', ['/c', `${tool} --version`], { encoding: 'utf8' }).trim() } catch { environment[tool] = 'unavailable' }
  }
  try { writeFileSync(join(dir, `${quadrant}-environment.json`), `${JSON.stringify(environment, null, 2)}\n`, 'utf8') } catch { /* best effort */ }
}

function finish(status, blockedReason = null) {
  killServer()
  const record = {
    quadrant: { deployment: args.deployment, install: args.install },
    pluginVersion: PKG.version,
    dsh: '0.1.1-rc.2 (b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)',
    status,
    blockedReason,
    checks,
    timestamp: stamp,
  }
  const dir = join(ROOT, 'evidence')
  mkdirSync(dir, { recursive: true })
  const quadrant = `${record.quadrant.deployment}-${record.quadrant.install}`
  const file = join(dir, `${quadrant}.json`)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`evidence → ${file} (status: ${status})`)
  persistDiagnostics(dir, quadrant)
  if (home !== null) { try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ } }
  process.exit(status === 'green' ? 0 : 1)
}
process.on('SIGINT', () => finish('failed', 'interrupted'))

const temp = mkdtempSync(join(tmpdir(), `stock-${args.deployment}-${args.install}-`))
home = temp

// ---------------------------------------------------------------------------
// Per-deployment DSH invocation.
// ---------------------------------------------------------------------------
let dsh
if (args.deployment === 'source') {
  dsh = (...cli) => execFileSync('cmd', ['/c', `set DSH_HOME=${home}&& pnpm dsh ${cli.join(' ')}`], {
    cwd: SOURCE_DSH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
  })
} else {
  // npm deployment: install the official dsh once into an isolated prefix
  // (a persistent %TEMP%\stock-npm-prefix is reused locally; CI reinstalls
  // fresh). pnpm (invoked by dsh inside the profile) gets an ISOLATED
  // store-dir: registering projects into the user's global store is EPERM
  // under some sessions and would also pollute it.
  const prefix = existsSync(join(process.env.TEMP ?? tmpdir(), 'stock-npm-prefix', 'dsh.cmd'))
    ? join(process.env.TEMP ?? tmpdir(), 'stock-npm-prefix')
    : join(temp, 'prefix')
  if (!existsSync(join(prefix, 'dsh.cmd'))) {
    console.log('npm deployment: installing @deepseek-ai/dsh@0.1.1-rc.2 (first run ~3min)…')
    mkdirSync(prefix, { recursive: true })
    execFileSync('cmd', ['/c', `set npm_config_prefix=${prefix}&& npm install -g @deepseek-ai/dsh@0.1.1-rc.2 --no-audit --no-fund --loglevel=error`], { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  check('S0 official npm dsh installed', existsSync(join(prefix, 'dsh.cmd')), `prefix ${prefix}`)
  const dshCmd = join(prefix, 'dsh.cmd')
  if (/\s/.test(dshCmd)) { finish('failed', `npm prefix path contains spaces (${dshCmd}) — cmd /c single-string quoting cannot carry it; choose a space-free TEMP`) }
  const isolatedStore = join(home, 'pnpm-store')
  dsh = (...cli) => execFileSync('cmd', ['/c', `set DSH_HOME=${home}&& set npm_config_store_dir=${isolatedStore}&& ${dshCmd} ${cli.join(' ')}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
  })
  args.npmPrefix = prefix
  args.npmBootExtra = `set npm_config_store_dir=${isolatedStore}&& `
}

// ---------------------------------------------------------------------------
// The install spec per quadrant — every quadrant installs FOR REAL.
// ---------------------------------------------------------------------------
let installSpec
if (args.install === 'tgz') {
  const tgz = join(ROOT, 'dist', TARBALL)
  if (!existsSync(tgz)) finish('failed', 'dist tarball missing — run release:assets first')
  installSpec = JSON.stringify(tgz)
} else {
  // A pinned local git fixture (same shape as a GitHub 40-char SHA install).
  const repo = join(temp, 'repo')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  const git = (...g) => execFileSync('git', g, { cwd: repo, encoding: 'utf8' })
  const copy = (from, to) => {
    try { writeFileSync(to, readFileSync(from)) } catch {
      mkdirSync(to, { recursive: true })
      execFileSync('cmd', ['/c', 'xcopy', '/e', '/i', '/y', from, to], { stdio: 'ignore' })
    }
  }
  for (const entry of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'LICENSE', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md', 'lib']) copy(join(ROOT, entry), join(repo, entry))
  copy(join(ROOT, 'dist', TARBALL), join(repo, 'dist', TARBALL))
  git('init', '-q'); git('config', 'user.email', 't@local'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false')
  git('add', '-A'); git('commit', '-qm', 'fixture')
  const sha = git('rev-parse', 'HEAD').trim()
  check('git fixture at a full 40-char SHA', /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 12))
  installSpec = JSON.stringify(`git+file:///${repo.replace(/\\/g, '/').replace(/^\//, '')}#${sha}`)
}

// S8: the engine tree (source checkout) is untouched by THIS run — compare
// git status before vs after (the user's fork workspace may carry its own
// long-standing edits; only drift caused by the quadrant is a failure).
let sourceBaseline = null
if (args.deployment === 'source') {
  sourceBaseline = execFileSync('git', ['status', '--porcelain'], { cwd: SOURCE_DSH, encoding: 'utf8' })
}

// S1: REAL install into the official web profile (template auto-inits with
// dsh-base + dsh-web-app; the plugin command adds ours on top).
let addOut
try { addOut = dsh('plugin', '--profile', 'web', 'add', installSpec) } catch (error) {
  const text = `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}\n${String(error.message ?? '')}`.trim()
  check(`S1 real ${args.install} install into the web profile`, false, `killed=${error.killed ?? false} timeout=${error.timedOut ?? false} :: ${text.slice(-400).replace(/\r?\n/g, ' | ')}`)
}
check(`S1 real ${args.install} install into the web profile`, /Done in/.test(addOut ?? ''))

// S3a: bundles are EXACTLY base + web-app + ours.
const manifestPath = join(home, 'profiles', 'web', 'package.json')
let manifestText = readFileSync(manifestPath, 'utf8')
if (manifestText.charCodeAt(0) === 0xFEFF) manifestText = manifestText.slice(1)
const manifest = JSON.parse(manifestText)
const bundles = [...(manifest.dsh?.profile?.bundles ?? [])].sort()
const expected = [...REQUIRED_BUNDLES].sort()
check('S3a web profile bundles are exactly base+web-app+manager', JSON.stringify(bundles) === JSON.stringify(expected), bundles.join(', '))

// S3b: dump-config carries exactly one manager row.
const dump = dsh('--profile', 'web', '--dump-config')
const rowCount = (dump.match(/- id: dsh-plugin-manager$/gm) ?? []).length
check('S3b dump-config shows exactly one manager row', rowCount === 1, `rows=${rowCount}`)

// S-boot: `dsh web` on the scratch port (WMI breakaway keeps it alive).
const port = String(3500 + Math.floor(Math.random() * 400))
const bootCwd = args.deployment === 'source' ? SOURCE_DSH : home
const log = join(home, 'boot.log').replace(/\\/g, '/')
const launcher = args.deployment === 'source'
  ? `cmd /c cd /d ${SOURCE_DSH} && set DSH_HOME=${home}&& pnpm dsh web --port ${port} --no-open > ${log} 2>&1`
  : `cmd /c cd /d ${home} && set DSH_HOME=${home}&& ${args.npmBootExtra ?? ''}${join(args.npmPrefix ?? join(home, 'prefix'), 'dsh.cmd')} web --port ${port} --no-open > ${log} 2>&1`
const { promisify } = await import('node:util')
const { execFile } = await import('node:child_process')
const run = promisify(execFile)
const psScript = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${launcher.replace(/'/g, "''")}';CurrentDirectory='${bootCwd.replace(/\\/g, '/')}'}).ProcessId`
let bootOk = false
try {
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' })
  serverPid = Number(/(\d+)\s*$/.exec(stdout.trim())?.[1] ?? 0)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) { bootOk = true; break }
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
} catch {
  // WMI launch or the readiness loop itself failed: fall through with
  // bootOk=false so the tail of boot.log names the real cause.
}
if (!bootOk) {
  const tail = existsSync(join(home, 'boot.log'))
    ? readFileSync(join(home, 'boot.log'), 'utf8').split(/\r?\n/).slice(-6).join(' | ').slice(0, 240)
    : 'no boot log'
  check('S-boot dsh web serves HTTP', false, `port ${port} never ready; boot tail: ${tail}`)
}
check('S-boot dsh web serves HTTP', bootOk, bootOk ? `port ${port}` : '')

// S5: capabilities over the real channel; S6: spoofed Host draws 403.
let capsOk = false
if (bootOk) {
  await new Promise(resolve => setTimeout(resolve, 15_000))
  const body = JSON.stringify({ type: 'client-request', rpcId: `s-${Math.random().toString(36).slice(2, 8)}`, method: 'capabilities', payload: { protocolVersion: 1 } })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-plugin-manager/capabilities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(90_000) })
    const json = await res.json()
    capsOk = json?.result?.ok === true
    check('S5 channel capabilities over real HTTP', capsOk, `entries=${json?.result?.value?.entries?.length ?? '?'}`)
  } catch (error) {
    check('S5 channel capabilities over real HTTP', false, String(error.message).slice(0, 120))
  }
  // Raw-socket fence probe (Node fetch cannot override Host).
  const net = await import('node:net')
  const raw = net.connect(Number(port), '127.0.0.1')
  raw.setTimeout(15_000)
  let rawOut = ''
  const fenced = await new Promise(resolve => {
    raw.on('connect', () => {
      raw.write(`POST /dsh-plugin-manager/capabilities HTTP/1.1\r\nHost: attacker.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    })
    raw.on('data', chunk => { rawOut += chunk.toString() })
    raw.on('timeout', () => { raw.destroy(); resolve(false) })
    raw.on('error', () => resolve(false))
    raw.on('close', () => resolve(/HTTP\/1\.[01] 403/.test(rawOut)))
  })
  check('S6 spoofed-host rejected with 403 before the handler', fenced, fenced ? 'raw socket drew 403' : `raw: ${(rawOut.split('\r\n')[0] ?? 'none').slice(0, 60)}`)
}

// S8: the engine tree (source checkout) is untouched by THIS run.
if (args.deployment === 'source') {
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: SOURCE_DSH, encoding: 'utf8' })
  const drifted = after !== sourceBaseline
  check('S8 source checkout never modified', !drifted, drifted ? after.split('\n').filter(line => !sourceBaseline.split('\n').includes(line)).slice(0, 3).join(' | ') : '')
}

// green = ALL required checks present AND ok.
const required = ['S1 real ' + args.install + ' install into the web profile', 'S3a web profile bundles are exactly base+web-app+manager', 'S3b dump-config shows exactly one manager row', 'S-boot dsh web serves HTTP', 'S5 channel capabilities over real HTTP', 'S6 spoofed-host rejected with 403 before the handler']
if (args.deployment === 'source') required.push('S8 source checkout never modified')
const green = required.every(name => checks.some(c => c.name === name && c.ok))
finish(green ? 'green' : 'failed')
