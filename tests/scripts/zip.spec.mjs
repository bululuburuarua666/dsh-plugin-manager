// zip.mjs round-trip + adversarial checks:
//  1. store → load → byte equality, CRC enforced
//  2. a POSIX tar renamed to .zip is REJECTED (GNU-tar regression guard)
//  3. a corrupted payload fails the CRC gate
//  4. the written archive opens with the platform unzip tool
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipStore, zipLoad, zipMemberDigest } from '../../scripts/zip.mjs'

/** A per-test temp dir cleaned on test completion. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('store → load round-trips bytes and digests', t => {
  const payload = Buffer.alloc(200_000)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xFF
  const archive = zipStore([
    { name: 'small.txt', data: Buffer.from('hello') },
    { name: 'big.bin', data: payload }, // exercises the deflate path (>64KiB)
  ])
  const members = zipLoad(archive)
  assert.equal(members.length, 2)
  assert.equal(members[0].data.toString(), 'hello')
  assert.equal(members[1].data.length, payload.length)
  assert.deepEqual([...members[1].data], [...payload])
  assert.equal(zipMemberDigest(members, 'small.txt').length, 64)
  void scratch(t)
})

test('a POSIX tar renamed to .zip is rejected', t => {
  const temp = scratch(t)
  writeFileSync(join(temp, 'seed.txt'), 'tar payload')
  const tarPath = join(temp, 'fake.zip')
  execFileSync('tar', ['-cf', tarPath, '-C', temp, 'seed.txt'], { stdio: 'ignore' })
  const tarBytes = readFileSync(tarPath)
  assert.throws(() => zipLoad(tarBytes), /not a ZIP archive/)
})

test('a corrupted member fails the CRC gate', () => {
  const archive = zipStore([{ name: 'x.txt', data: Buffer.from('intact') }])
  archive[40] ^= 0xFF // flip a payload byte
  assert.throws(() => zipLoad(archive), /CRC mismatch|corrupt/)
})

test('the written archive opens with the platform unzip', t => {
  const temp = scratch(t)
  const archivePath = join(temp, 'real.zip')
  writeFileSync(archivePath, zipStore([{ name: 'n.txt', data: Buffer.from('unzip-me') }]))
  // Windows: tar (bsdtar) lists zip; elsewhere `unzip -l`. Either passing
  // proves a standard tool accepts the archive.
  let listed = false
  try { execFileSync('tar', ['-tf', archivePath], { stdio: 'ignore' }); listed = true } catch {
    try { execFileSync('unzip', ['-l', archivePath], { stdio: 'ignore' }); listed = true } catch { /* both unavailable */ }
  }
  assert.ok(listed, 'no platform unzip tool available to cross-check')
})
