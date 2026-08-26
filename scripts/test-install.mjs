#!/usr/bin/env node
// Persistent, fail-closed install self-tests for both release paths.
//   node scripts/test-install.mjs tgz        — unpack the release ZIP, install
//                                               the inner tgz, DELETE the
//                                               unpack dir, boot, probe the
//                                               channel, official remove, and
//                                               assert the row fully gone —
//                                               with zero manifest hand-edits.
//   node scripts/test-install.mjs git-local  — stage a temp git repo, install
//                                               from its full commit SHA, and
//                                               assert no build scripts ran.
// Both modes use an isolated DSH_HOME and a scratch port, never the user's
// profile, and exit non-zero on the first failed assertion.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = 'D:\\appset\\DeepSeekHarness\\deepseek-harness-master'
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = PKG.version
const TARBALL = `bululuburuarua666-dsh-plugin-manager-${VERSION}.tgz`
const ZIP_NAME = `dsh-plugin-manager-${VERSION}.zip`
const PORT = String(3080 + Math.floor(Math.random() * 100) + 10)

function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const failures = []
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) { failures.push(label); finish(1) }
}
function finish(code) {
  killServer()
  // Give the killed server a beat to release file handles before cleanup;
  // a lingering pnpm/node child can hold the temp dir on Windows.
  if (tempRoot !== null) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(tempRoot, { recursive: true, force: true }); break } catch { /* retry */ }
      try { execFileSync('cmd', ['/c', `taskkill /F /T /PID ${serverPid ?? 0} >nul 2>&1`]) } catch { /* best effort */ }
      try { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800'], { stdio: 'ignore' }) } catch { /* best effort */ }
    }
  }
  process.exit(code)
}
function killServer() {
  if (serverPid === null) return
  try { execFileSync('cmd', ['/c', `taskkill /F /T /PID ${serverPid} >nul 2>&1`]) } catch { /* already gone */ }
  serverPid = null
}

let tempRoot = null
let serverPid = null

/** Run pnpm dsh … inside the monorepo with an isolated DSH_HOME. */
function dsh(home, ...args) {
  const out = execFileSync('cmd', ['/c', `set DSH_HOME=${home}&& pnpm dsh ${args.join(' ')}`], {
    cwd: DSH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out
}

/** Boot the profile on the scratch port (WMI breakaway keeps it session-proof). */
async function bootAndProbe(home, profile) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const log = join(home, 'boot.log')
  const logPs = log.replace(/\\/g, '/')
  const cmdline = `cmd /c cd /d ${DSH} && set DSH_HOME=${home}&& pnpm dsh --profile ${profile} --port ${PORT} > ${logPs} 2>&1`
  const psScript = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${cmdline.replace(/'/g, "''")}';CurrentDirectory='${DSH.replace(/\\/g, '/')}'}).ProcessId`
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' })
  const match = /(\d+)\s*$/.exec(stdout.trim())
  serverPid = match === null ? null : Number(match[1])
  if (serverPid !== null) {
    // The WMI cmd parent exits immediately; the real node server is its
    // descendant. Wait for the log file to grow past the command echo (the
    // banner appears only once Node actually starts serving).
    const startDeadline = Date.now() + 30_000
    while (Date.now() < startDeadline) {
      try {
        const text = readFileSync(log, 'utf8')
        if (text.includes('dsh web:') || text.includes('http://')) break
      } catch { /* log not written yet */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const deadline = Date.now() + 360_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return true
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  return false
}

/** POST one manager-channel envelope; returns the parsed JSON or null. */
async function channelCall(method, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `t-${Math.random().toString(36).slice(2, 8)}`, method, payload })
  const res = await fetch(`http://127.0.0.1:${PORT}/dsh-plugin-manager/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(90_000),
  })
  return await res.json()
}

/** Read the profile manifest with BOM tolerance. */
function readManifest(home, profile) {
  let text = readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  return JSON.parse(text)
}

const mode = process.argv[2]
if (mode !== 'tgz' && mode !== 'git-local') {
  console.error('usage: node scripts/test-install.mjs <tgz|git-local>')
  process.exit(2)
}

tempRoot = mkdtempSync(join(tmpdir(), `dsh-t061-${mode}-`))
const home = join(tempRoot, 'home')
mkdirSync(home, { recursive: true })

process.on('SIGINT', () => finish(130))

// ---------------------------------------------------------------------------
if (mode === 'tgz') {
  const dist = join(ROOT, 'dist')
  const zipPath = join(dist, ZIP_NAME)
  check(existsSync(zipPath), `release zip exists (${ZIP_NAME})`)

  const unpack = join(tempRoot, 'unpacked')
  mkdirSync(unpack, { recursive: true })
  execFileSync('tar', ['-xf', zipPath, '-C', unpack])
  const innerTgz = join(unpack, TARBALL)
  check(existsSync(innerTgz), 'zip unpacked with the inner tgz')
  const outerTgz = join(dist, TARBALL)
  const outerHash = createHash('sha256').update(readFileSync(outerTgz)).digest('hex')
  const innerHash = createHash('sha256').update(readFileSync(innerTgz)).digest('hex')
  check(innerHash === outerHash, 'inner tgz digest equals the released tgz digest')

  const addOut = dsh(home, 'plugin', '--profile', 'ti', 'add', JSON.stringify(innerTgz))
  check(/Done in/.test(addOut), 'tgz install completed')

  // S2: the download directory must be deletable right after install.
  rmSync(unpack, { recursive: true, force: true })
  check(!existsSync(innerTgz), 'unpack dir deleted after install')

  // A bootable fixture needs the web surface: link the monorepo web-app.
  const manifestPath = join(home, 'profiles', 'ti', 'package.json')
  let manifest = readManifest(home, 'ti')
  manifest.dependencies['@deepseek-ai/dsh-web-app'] = `${DSH.replace(/\\/g, '/')}/packages/bundle/web-app`
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@bululuburuarua666/dsh-plugin-manager', '@deepseek-ai/dsh-web-app']
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  // Fixture-only manifest shaping (adding the web surface): recorded openly.
  // The REMOVE assertion later must pass with zero hand-edits.

  const dump = dsh(home, '--profile', 'ti', '--dump-config')
  check(dump.includes('dsh-plugin-manager'), 'dump-config shows the manager row before boot')

  const ready = await bootAndProbe(home, 'ti')
  if (!ready) {
    // Surface the boot log tail for diagnosis before failing the assertion.
    const logPath = join(home, 'boot.log')
    try { console.log('--- boot.log tail ---\n' + readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-8).join('\n')) } catch { /* no log */ }
  }
  check(ready, `profile boots on :${PORT}`)
  if (ready) {
    await new Promise(resolve => setTimeout(resolve, 15_000))
    const caps = await channelCall('capabilities', { protocolVersion: 1 })
    check(caps?.result?.ok === true, `channel capabilities ok over real HTTP (entries=${caps?.result?.value?.entries?.length ?? '?'})`)
  }
  killServer()
  await new Promise(resolve => setTimeout(resolve, 1_500))

  // Official remove with ZERO manifest edits afterwards.
  let removeOk = false
  let removeOut = ''
  try { removeOut = dsh(home, 'plugin', '--profile', 'ti', 'remove', '@bululuburuarua666/dsh-plugin-manager'); removeOk = true } catch (error) {
    removeOut = String(error.stdout ?? error.message)
  }
  const after = readManifest(home, 'ti')
  const depGone = after.dependencies['@bululuburuarua666/dsh-plugin-manager'] === undefined
  const bundleGone = !after.dsh?.profile?.bundles?.includes('@bululuburuarua666/dsh-plugin-manager')
  if (removeOk && depGone && bundleGone) {
    check(true, 'official remove: dependency and bundle row both gone (no hand edits)')
  } else {
    // The web-app file: link can make pnpm's lockfile re-resolution fail on
    // upstream workspace deps. Report honestly; never fake the pass.
    check(false, `official remove on the bootable fixture (ok=${removeOk} dep=${depGone} row=${bundleGone}; out=${removeOut.slice(0, 120).replace(/\r?\n/g, ' ')})`)
  }
}

// ---------------------------------------------------------------------------
if (mode === 'git-local') {
  // Stage a temporary git repo holding the current tree (lib + dist included
  // up front), commit once, and install from that full SHA — the same shape
  // as a pinned GitHub install.
  const gitRepo = join(tempRoot, 'gitrepo')
  mkdirSync(gitRepo, { recursive: true })
  mkdirSync(join(gitRepo, 'dist'), { recursive: true })
  mkdirSync(join(gitRepo, 'docs'), { recursive: true })
  const copyIn = (from, to) => {
    try { copyFileSync(from, to) } catch { mkdirSync(to, { recursive: true }); execFileSync('cmd', ['/c', 'xcopy', '/e', '/i', '/y', from, to], { stdio: 'ignore' }) }
  }
  for (const entry of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README.zh.md', 'lib']) {
    copyIn(join(ROOT, entry), join(gitRepo, entry))
  }
  copyIn(join(ROOT, 'dist', TARBALL), join(gitRepo, 'dist', TARBALL))
  copyIn(join(ROOT, 'docs', 'INSTALL.md'), join(gitRepo, 'docs', 'INSTALL.md'))
  copyIn(join(ROOT, 'docs', 'INSTALL.zh.md'), join(gitRepo, 'docs', 'INSTALL.zh.md'))
  execFileSync('git', ['init', '-q'], { cwd: gitRepo })
  execFileSync('git', ['config', 'user.email', 't@local'], { cwd: gitRepo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: gitRepo })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: gitRepo })
  execFileSync('git', ['add', '-A'], { cwd: gitRepo })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: gitRepo })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo, encoding: 'utf8' }).trim()
  check(/^[0-9a-f]{40}$/.test(sha), `fixture commit is a full 40-char SHA (${sha.slice(0, 8)}…)`)

  // Windows git file URLs need the three-slash form: file:///C:/…
  const gitUrl = `file:///${gitRepo.replace(/\\/g, '/').replace(/^\//, '')}`
  const spec = `git+${gitUrl}#${sha}`
  let installOut = ''
  try { installOut = dsh(home, 'plugin', '--profile', 'tg', 'add', JSON.stringify(spec)) } catch (error) {
    installOut = `${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}\n${String(error.message ?? '')}`
    check(false, `git-local install from pinned SHA (${installOut.slice(0, 600).replace(/\r?\n/g, ' ')})`)
  }
  check(/Done in/.test(installOut), 'git-local install completed from the pinned SHA')
  // No install-time build: pnpm must not report running any build script.
  check(!/running [0-9]+ build|build scripts? ran|approving build/i.test(installOut), 'no build scripts executed during install')

  const dump = dsh(home, '--profile', 'tg', '--dump-config')
  check(dump.includes('dsh-plugin-manager'), 'dump-config shows the manager row (git path)')

  const manifest = readManifest(home, 'tg')
  check(manifest.dependencies['@bululuburuarua666/dsh-plugin-manager'] === spec,
    'manifest records the exact pinned git spec')
}

console.log(failures.length === 0 ? `\ninstall-test[${mode}]: ALL GREEN` : `\ninstall-test[${mode}]: ${failures.length} failure(s)`)
finish(failures.length === 0 ? 0 : 1)
