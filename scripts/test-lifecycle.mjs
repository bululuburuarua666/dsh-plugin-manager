#!/usr/bin/env node
// Lifecycle mutation E2E (fail-closed): the missing acceptance layer — a real
// preview -> execute -> queued/running -> succeeded toggle cycle against an
// isolated DSH_HOME and the official stock web profile, with a plain
// root-space Host fixture proving fiber disposal and restart persistence.
// Never touches the developer's live server.
//
// Required evidence, each hard-failing:
//   L1  fixture fiber applies at boot (enabled baseline)
//   L2  preview->execute->operation settles succeeded (queued/running observed)
//   L3  the patch file carries the managed row keyed by the DATA id
//   L4  the fixture fiber is disposed after disable
//   L5  restart persistence: still disabled after a fresh boot
//   L6  enable cycle restores the fiber (apply marker increments)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DSH = 'D:\\appset\\DeepSeekHarness\\deepseek-harness-master'
function dirname(p) { return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) }

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TARBALL = join(ROOT, 'dist', `bululuburuarua666-dsh-plugin-manager-${PKG.version}.tgz`)
const stamp = new Date().toISOString()
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!ok) finish('failed')
}

const home = mkdtempSync(join(tmpdir(), 'dsh-mgr-lifecycle-'))
let serverPid = null
function killServer() {
  if (serverPid === null) return
  try { execFileSync('cmd', ['/c', `taskkill /F /T /PID ${serverPid} >nul 2>&1`]) } catch { /* gone */ }
  serverPid = null
}

function finish(status) {
  killServer()
  const dir = join(ROOT, 'evidence')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'lifecycle-e2e.json')
  writeFileSync(file, `${JSON.stringify({ pluginVersion: PKG.version, status, checks, timestamp: stamp }, null, 2)}\n`, 'utf8')
  console.log(`evidence -> ${file} (status: ${status})`)
  // Diagnostics travel with the evidence: boot logs and the fixture's marker.
  for (const [name, source] of [['boot.log', join(home, 'boot.log')], ['boot2.log', join(home, 'boot2.log')], ['fixture-fiber.log', marker]]) {
    try { if (existsSync(source)) writeFileSync(join(dir, `lifecycle-${name}`), readFileSync(source)) } catch { /* best effort */ }
  }
  if (status === 'green') { try { rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ } }
  else console.log(`scratch home retained for inspection: ${home}`)
  process.exit(status === 'green' ? 0 : 1)
}
process.on('SIGINT', () => finish('failed'))

// ---------------------------------------------------------------------------
// Install the release tarball into the stock web profile of the scratch home.
// ---------------------------------------------------------------------------
if (!existsSync(TARBALL)) {
  console.error('dist tarball missing - run release:assets first')
  finish('failed')
}
const dsh = (...cli) => execFileSync('cmd', ['/c', `set DSH_HOME=${home}&& pnpm dsh ${cli.join(' ')}`], {
  cwd: SOURCE_DSH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
})
try {
  const addOut = dsh('plugin', '--profile', 'web', 'add', JSON.stringify(TARBALL))
  check('L0 real tgz install into the scratch web profile', /Done in/.test(addOut))
} catch (error) {
  check('L0 real tgz install into the scratch web profile', false, String(error.stderr ?? error.message).slice(-300))
}

// A plain root-space Host fixture: a marker file records fiber lifecycle.
const profileDir = join(home, 'profiles', 'web')
const marker = join(profileDir, 'fixture-fiber.log').replace(/\\/g, '/')
writeFileSync(join(profileDir, 'e2e-fixture.mjs'), [
  `import { appendFileSync } from 'node:fs'`,
  `const MARK = ${JSON.stringify(marker)}`,
  `export const name = 'e2e-fixture'`,
  `export function apply(ctx) {`,
  `  appendFileSync(MARK, 'apply\\n')`,
  `  // cordis effect() runs the callback as SETUP at registration; the`,
  `  // returned function is the disposer, fired only on real fiber teardown.`,
  `  ctx.effect(() => () => { appendFileSync(MARK, 'dispose\\n') })`,
  `}`,
  '',
].join('\n'))
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '# lifecycle E2E fixture',
  '- insert:',
  '    - id: e2e-fixture',
  "      name: './e2e-fixture.mjs'",
  '',
].join('\n'))

// ---------------------------------------------------------------------------
// Boot the stock web app on a scratch port (WMI breakaway keeps it alive).
// ---------------------------------------------------------------------------
const port = String(3500 + Math.floor(Math.random() * 400))
const bootLog = join(home, 'boot.log').replace(/\\/g, '/')
const launcher = `cmd /c cd /d ${SOURCE_DSH} && set DSH_HOME=${home}&& pnpm dsh web --port ${port} --no-open > ${bootLog} 2>&1`
const { promisify } = await import('node:util')
const { execFile } = await import('node:child_process')
const run = promisify(execFile)
const psScript = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${launcher.replace(/'/g, "''")}';CurrentDirectory='${SOURCE_DSH.replace(/\\/g, '/')}'}).ProcessId`
let bootOk = false
try {
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' })
  serverPid = Number(/(\d+)\s*$/.exec(stdout.trim())?.[1] ?? 0)
  const deadline = Date.now() + 420_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) { bootOk = true; break }
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
} catch (error) {
  check('L-boot stock dsh web serves HTTP on the scratch port', false, String(error).slice(-200))
}
check('L-boot stock dsh web serves HTTP on the scratch port', bootOk, `port ${port}`)

// ---------------------------------------------------------------------------
// Channel calls over real loopback HTTP.
// ---------------------------------------------------------------------------
const call = async (endpoint, payload) => {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `lc-${Math.random().toString(36).slice(2, 10)}`,
    method: endpoint,
    payload: { protocolVersion: 1, ...payload },
  })
  const res = await fetch(`http://127.0.0.1:${port}/dsh-plugin-manager/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(120_000),
  })
  const json = await res.json()
  return json?.result
}
const markerText = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '')
const applyCount = () => markerText().split('\n').filter(line => line === 'apply').length
const disposeCount = () => markerText().split('\n').filter(line => line === 'dispose').length

// L1: enabled baseline — the fixture fiber applied during boot.
const caps = await call('capabilities', {})
check('L1 capabilities ok and the fixture row is toggleable', caps?.ok === true
  && (caps?.value?.entries ?? []).some(entry => entry.entryId === 'include:e2e-fixture' && entry.canToggle === true))
check('L1b fixture fiber applied at boot (enabled baseline)', applyCount() >= 1 && disposeCount() === 0, `apply=${applyCount()} dispose=${disposeCount()}`)

// L2: disable through the channel — preview -> execute -> poll to succeeded.
const revision = caps?.value?.revision
const preview = await call('preview', { entryId: 'include:e2e-fixture', action: 'disable', expectedRevision: revision })
check('L2a preview accepts the disable intent', preview?.ok === true && typeof preview?.value?.token === 'string')
const started = await call('execute', { token: preview.value.token })
check('L2b execute acknowledges queued state', started?.ok === true && (started?.value?.state === 'queued' || started?.value?.state === 'running'), `state=${started?.value?.state}`)
const operationId = started?.value?.operationId
const states = new Set()
let settled = null
const pollDeadline = Date.now() + 120_000
while (Date.now() < pollDeadline) {
  const view = await call('operation', { operationId })
  if (view?.ok !== true) break
  states.add(view.value.state)
  if (view.value.state !== 'queued' && view.value.state !== 'running') { settled = view.value; break }
  await new Promise(resolve => setTimeout(resolve, 250))
}
check('L2c operation settles succeeded', settled?.state === 'succeeded', `states=${[...states].join('/')}`)

// L3: the managed row is keyed by the DATA id, not the tree id.
const patchText = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('L3 managed row carries the data id (not the tree id)',
  /- id: e2e-fixture\r?\n {2}disabled: true/.test(patchText) && !patchText.includes('include:e2e-fixture'))

// L4: the fiber was really disposed (the row reflects it, not just the file).
check('L4 fixture fiber disposed after disable', disposeCount() >= 1, `dispose=${disposeCount()}`)

// L5: restart persistence — a fresh boot must keep the fixture disabled.
killServer()
await new Promise(resolve => setTimeout(resolve, 2_000))
const restartLog = join(home, 'boot2.log').replace(/\\/g, '/')
const launcher2 = `cmd /c cd /d ${SOURCE_DSH} && set DSH_HOME=${home}&& pnpm dsh web --port ${port} --no-open > ${restartLog} 2>&1`
const ps2 = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${launcher2.replace(/'/g, "''")}';CurrentDirectory='${SOURCE_DSH.replace(/\\/g, '/')}'}).ProcessId`
try {
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps2], { encoding: 'utf8' })
  serverPid = Number(/(\d+)\s*$/.exec(stdout.trim())?.[1] ?? 0)
  const deadline = Date.now() + 420_000
  let up = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) { up = true; break }
    } catch { /* not ready */ }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
  check('L5a restart serves HTTP again', up)
  const appliesBefore = applyCount()
  check('L5b fixture stayed disabled across the restart', up && applyCount() === appliesBefore && disposeCount() >= 1,
    `apply=${applyCount()} dispose=${disposeCount()}`)
} catch (error) {
  check('L5a restart serves HTTP again', false, String(error).slice(-200))
}

// L6: enable cycle — succeeded and the fiber applies again.
const caps2 = await call('capabilities', {})
const previewEnable = await call('preview', { entryId: 'include:e2e-fixture', action: 'enable', expectedRevision: caps2?.value?.revision })
check('L6a preview accepts the enable intent', previewEnable?.ok === true)
const startedEnable = await call('execute', { token: previewEnable.value.token })
const opId2 = startedEnable?.value?.operationId
let enabled = null
const enableDeadline = Date.now() + 120_000
while (Date.now() < enableDeadline) {
  const view = await call('operation', { operationId: opId2 })
  if (view?.ok !== true) break
  if (view.value.state !== 'queued' && view.value.state !== 'running') { enabled = view.value; break }
  await new Promise(resolve => setTimeout(resolve, 250))
}
check('L6b enable operation settles succeeded', enabled?.state === 'succeeded')
check('L6c fixture fiber re-applied after enable', applyCount() >= 2, `apply=${applyCount()}`)
const patchAfterEnable = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('L6d managed row now reads the explicit null override', /- id: e2e-fixture\r?\n {2}disabled: null/.test(patchAfterEnable))

finish('green')
