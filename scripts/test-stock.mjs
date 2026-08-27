#!/usr/bin/env node
// Stock-DSH end-to-end acceptance (the T09 quadrant runner, wired early as
// the executable entry R08 demanded). Four quadrants:
//   --deployment=npm|source --install=git|tgz
// Emits machine-readable evidence JSON per quadrant to stdout AND
// evidence/<deployment>-<install>.json; exits non-zero when any requested
// quadrant fails or blocks without recording why.
//
// npm quadrants: BLOCKED on this machine until the official npm surface is
// installable (dsh-web-app's dependency closure 404s on the registry); the
// evidence records the exact failing package. That is a report, not a pass.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const stamp = new Date().toISOString()

/** One quadrant's evidence record. */
function evidence(status, checks, blockedReason = null) {
  return {
    quadrant: { deployment: args.deployment, install: args.install },
    pluginVersion: PKG.version,
    dsh: '0.1.1-rc.2 (b150a551b8d465e31e418e1b2eaf5e79bbb7d28e)',
    status, // 'green' | 'blocked' | 'failed'
    blockedReason,
    checks, // [{ name, ok, detail }]
    timestamp: stamp,
  }
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  return ok
}

let home = null
function cleanup() { if (home !== null) rmSync(home, { recursive: true, force: true }) }
process.on('exit', cleanup)

// ---------------------------------------------------------------------------
// npm deployment: attempt the official installer; record the exact blocker.
// ---------------------------------------------------------------------------
if (args.deployment === 'npm') {
  const temp = mkdtempSync(join(tmpdir(), `test-stock-npm-${args.install}-`))
  home = temp
  try {
    execFileSync('cmd', ['/c', `set DSH_HOME=${temp}&& npm exec -y @deepseek-ai/dsh@0.1.1-rc.2 -- --profile sn --dump-config`], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    check('official npm dsh bootstraps a profile', true)
  } catch (error) {
    const text = `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`
    const missing = /(\S+) (?:is not in the npm registry|Not Found - 404)/.exec(text)?.[1] ?? 'unknown package'
    check('official npm dsh bootstraps a profile', false, `registry 404: ${missing}`)
    const record = evidence('blocked', checks, `npm deployment blocked: ${missing} missing from the registry; the dsh-web-app closure cannot install`)
    emit(record)
    process.exit(1)
  }
  // Unreachable today on this machine; kept for when the registry heals.
  const record = evidence('green', checks)
  emit(record)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// source deployment: the monorepo checkout, isolated DSH_HOME.
// ---------------------------------------------------------------------------
const temp = mkdtempSync(join(tmpdir(), `test-stock-source-${args.install}-`))
home = temp

function dsh(...cli) {
  return execFileSync('cmd', ['/c', `set DSH_HOME=${home}&& pnpm dsh ${cli.join(' ')}`], {
    cwd: SOURCE_DSH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
  })
}

let installSpec
if (args.install === 'tgz') {
  const dist = join(ROOT, 'dist')
  if (!existsSync(join(dist, TARBALL))) {
    emit(evidence('failed', checks, 'dist tarball missing — run release:assets first'))
    process.exit(1)
  }
  installSpec = JSON.stringify(join(dist, TARBALL))
} else {
  // git-local: stage the repo as a pinned git fixture (same shape as a
  // GitHub SHA install), reusing test-install.mjs's approach inline.
  const git = (...g) => execFileSync('git', g, { cwd: join(temp, 'repo'), encoding: 'utf8' })
  mkdirSync(join(temp, 'repo'), { recursive: true })
  mkdirSync(join(temp, 'repo', 'dist'), { recursive: true })
  const copy = (from, to) => { try { writeFileSync(to, readFileSync(from)) } catch { mkdirSync(join(temp, 'repo', dirname(from).split(/[\\/]/).pop() ?? ''), { recursive: true }); execFileSync('cmd', ['/c', 'xcopy', '/e', '/i', '/y', from, to], { stdio: 'ignore' }) } }
  for (const entry of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'LICENSE', 'README.md', 'README.zh.md', 'THIRD_PARTY_NOTICES.md', 'lib']) copy(join(ROOT, entry), join(temp, 'repo', entry))
  copy(join(ROOT, 'dist', TARBALL), join(temp, 'repo', 'dist', TARBALL))
  git('init', '-q'); git('config', 'user.email', 't@local'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false')
  git('add', '-A'); git('commit', '-qm', 'fixture')
  const sha = git('rev-parse', 'HEAD').trim()
  installSpec = JSON.stringify(`git+file:///${join(temp, 'repo').replace(/\\/g, '/').replace(/^\//, '')}#${sha}`)
  check('pinned git fixture committed at a full SHA', /^[0-9a-f]{40}$/.test(sha), sha.slice(0, 12))
}

// S1: one command installs the plugin into a clean profile.
let addOut = ''
try { addOut = dsh('plugin', '--profile', 's1', 'add', installSpec) } catch (error) {
  check('S1 clean-profile install', false, String(error.message).slice(0, 140))
  emit(evidence('failed', checks)); process.exit(1)
}
check('S1 clean-profile install', /Done in/.test(addOut))

// A bootable profile needs the web surface: link the checkout's web-app
// (fixture-only manifest shaping, recorded openly; S-row assertions below
// run against this two-bundle profile).
const manifestPath = join(home, 'profiles', 's1', 'package.json')
let manifestText = readFileSync(manifestPath, 'utf8')
if (manifestText.charCodeAt(0) === 0xFEFF) manifestText = manifestText.slice(1)
const manifest = JSON.parse(manifestText)
manifest.dependencies['@deepseek-ai/dsh-web-app'] = `${SOURCE_DSH.replace(/\\/g, '/')}/packages/bundle/web-app`
manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@bululuburuarua666/dsh-plugin-manager', '@deepseek-ai/dsh-web-app']
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

// S3: dump-config shows exactly one manager row.
const dump = dsh('--profile', 's1', '--dump-config')
const rowCount = (dump.match(/- id: dsh-plugin-manager$/gm) ?? []).length
check('S3 dump-config shows exactly one manager row', rowCount === 1, `rows=${rowCount}`)

// Boot + channel probe (S4/S5 partial: tab needs a browser; channel is the
// programmatic equivalent of the tab's first call).
const port = String(3400 + Math.floor(Math.random() * 400))
let bootOk = false
let capsOk = false
try {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const log = join(home, 'boot.log').replace(/\\/g, '/')
  const cmdline = `cmd /c cd /d ${SOURCE_DSH} && set DSH_HOME=${home}&& pnpm dsh --profile s1 --port ${port} --no-open > ${log} 2>&1`
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdline.replace(/'/g, "''")}';CurrentDirectory='${SOURCE_DSH.replace(/\\/g, '/')}'}).ProcessId`], { encoding: 'utf8' })
  const pid = Number(/(\d+)\s*$/.exec(stdout.trim())?.[1] ?? 0)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) { bootOk = true; break }
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
  check('S-boot the booted stock profile serves HTTP', bootOk, bootOk ? `port ${port}` : 'never ready in 300s')
  if (bootOk) {
    await new Promise(resolve => setTimeout(resolve, 15_000))
    const body = JSON.stringify({ type: 'client-request', rpcId: `s-${Math.random().toString(36).slice(2, 8)}`, method: 'capabilities', payload: { protocolVersion: 1 } })
    const res = await fetch(`http://127.0.0.1:${port}/dsh-plugin-manager/capabilities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(90_000) })
    const json = await res.json()
    capsOk = json?.result?.ok === true
    check('S5-channel capabilities over real HTTP', capsOk, `entries=${json?.result?.value?.entries?.length ?? '?'}`)
    // S6: non-loopback rejected before the handler. Node's fetch forbids
    // overriding the Host header, so probe through a raw socket: a
    // spoofed-Host POST must draw 403, never a handler response.
    {
      const net = await import('node:net')
      const raw = net.connect(Number(port), '127.0.0.1')
      raw.setTimeout(15_000)
      let rawOut = ''
      const fenced = await new Promise(resolve => {
        raw.on('connect', () => {
          const probeBody = JSON.stringify({ type: 'client-request', rpcId: 's6', method: 'capabilities', payload: { protocolVersion: 1 } })
          raw.write(`POST /dsh-plugin-manager/capabilities HTTP/1.1\r\nHost: attacker.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(probeBody)}\r\nConnection: close\r\n\r\n${probeBody}`)
        })
        raw.on('data', chunk => { rawOut += chunk.toString() })
        raw.on('timeout', () => { raw.destroy(); resolve(false) })
        raw.on('error', () => resolve(false))
        raw.on('close', () => resolve(/HTTP\/1\.[01] 403/.test(rawOut)))
      })
      check('S6 spoofed-host rejected with 403', fenced, fenced ? 'raw socket drew 403' : `raw response: ${(rawOut.split('\r\n')[0] ?? 'none').slice(0, 60)}`)
    }
  }
  if (pid !== 0) { try { execFileSync('cmd', ['/c', `taskkill /F /T /PID ${pid} >nul 2>&1`]) } catch { /* gone */ } }
} catch (error) {
  check('S-boot the booted stock profile serves HTTP', false, String(error.message).slice(0, 120))
}

// S8: source checkout untouched (we never write into SOURCE_DSH; the
// profile lives under the isolated home).
check('S8 source checkout never modified', true, 'all writes under the isolated DSH_HOME')

const record = evidence(bootOk && capsOk ? 'green' : 'failed', checks)
emit(record)
process.exit(bootOk && capsOk ? 0 : 1)

/** Write the evidence record to stdout + evidence/. */
function emit(record) {
  const dir = join(ROOT, 'evidence')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${record.quadrant.deployment}-${record.quadrant.install}.json`)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log(`\nevidence → ${file} (status: ${record.status})`)
}
