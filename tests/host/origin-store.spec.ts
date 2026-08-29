/**
 * OriginStore tests: the write pipeline (lock → in-lock re-read → revision
 * conflict check → strict schema validation → atomic write → post-write
 * verification), the fail-closed stance on corrupt files, and the revision
 * currency. Uses the real filesystem with temp profiles.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OriginStore, ORIGIN_MISSING_REVISION, originTextDigest } from '../../src/host/origin-store.ts'
import { parseOriginOverrides } from '../../src/host/origin.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profileFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mgr-origins-'))
  tempDirs.push(dir)
  return dir
}

/** Read and parse the override file of one profile. */
function readOverrides(profileDir: string) {
  const result = parseOriginOverrides(readFileSync(join(profileDir, 'plugin-origins.json'), 'utf8'))
  expect(result.diagnostics).toEqual([])
  return result.overrides!.packages
}

describe('OriginStore.revision', () => {
  it('reports the missing revision for a profile without the file', () => {
    const store = new OriginStore(profileFixture())
    expect(store.revision()).toBe(ORIGIN_MISSING_REVISION)
  })

  it('reports the missing revision without a profile directory', () => {
    const store = new OriginStore(null)
    expect(store.revision()).toBe(ORIGIN_MISSING_REVISION)
  })

  it('reports the content digest of an existing file', () => {
    const dir = profileFixture()
    const text = `${JSON.stringify({ schemaVersion: 1, packages: {} }, null, 2)}\n`
    writeFileSync(join(dir, 'plugin-origins.json'), text)
    const store = new OriginStore(dir)
    expect(store.revision()).toBe(originTextDigest(text))
  })
})

describe('OriginStore.update', () => {
  it('fails without a profile directory', async () => {
    const store = new OriginStore(null)
    await expect(store.update('pkg', { kind: 'personal' }, ORIGIN_MISSING_REVISION))
      .rejects.toMatchObject({ code: 'ORIGIN_UNAVAILABLE' })
  })

  it('creates the file on the first override and returns the new revision', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    const result = await store.update('dsh-vision-router', { kind: 'personal', note: 'mine' }, ORIGIN_MISSING_REVISION)
    expect(result.revision).toBe(store.revision())
    const packages = readOverrides(dir)
    expect(packages.get('dsh-vision-router')).toEqual({ kind: 'personal', note: 'mine' })
  })

  it('persists upstream/fork/branch fields of a customized entry', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    await store.update('dsh-fork', {
      kind: 'opensource',
      customized: true,
      upstream: 'https://github.com/example/up',
      fork: 'https://github.com/me/fork',
      branch: 'local',
      note: { zh: '定制', en: 'customized' },
    }, ORIGIN_MISSING_REVISION)
    const packages = readOverrides(dir)
    expect(packages.get('dsh-fork')).toEqual({
      kind: 'opensource',
      customized: true,
      upstream: 'https://github.com/example/up',
      fork: 'https://github.com/me/fork',
      branch: 'local',
      note: { zh: '定制', en: 'customized' },
    })
  })

  it('requires a note for a customized open-source classification', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    await expect(store.update('dsh-fork', { kind: 'opensource', customized: true }, ORIGIN_MISSING_REVISION))
      .rejects.toMatchObject({ code: 'ORIGIN_NOTE_REQUIRED' })
    await expect(store.update('dsh-fork', { kind: 'opensource', customized: true, note: '   ' }, ORIGIN_MISSING_REVISION))
      .rejects.toMatchObject({ code: 'ORIGIN_NOTE_REQUIRED' })
    // Nothing was written.
    expect(store.revision()).toBe(ORIGIN_MISSING_REVISION)
  })

  it('clears an override with null (restore automatic) and keeps other entries', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    const first = await store.update('pkg-a', { kind: 'personal' }, ORIGIN_MISSING_REVISION)
    const second = await store.update('pkg-b', { kind: 'official' }, first.revision)
    const third = await store.update('pkg-a', null, second.revision)
    expect(third.revision).toBe(store.revision())
    const packages = readOverrides(dir)
    expect(packages.has('pkg-a')).toBe(false)
    expect(packages.get('pkg-b')).toEqual({ kind: 'official' })
  })

  it('leaves an empty packages object when the last override is removed', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    const first = await store.update('pkg-a', { kind: 'personal' }, ORIGIN_MISSING_REVISION)
    await store.update('pkg-a', null, first.revision)
    const packages = readOverrides(dir)
    expect(packages.size).toBe(0)
  })

  it('rejects a stale expected revision with ORIGIN_CONFLICT', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    await store.update('pkg-a', { kind: 'personal' }, ORIGIN_MISSING_REVISION)
    // A second writer (another page) now holds a stale revision.
    await expect(store.update('pkg-b', { kind: 'official' }, ORIGIN_MISSING_REVISION))
      .rejects.toMatchObject({ code: 'ORIGIN_CONFLICT' })
    expect(readOverrides(dir).has('pkg-b')).toBe(false)
  })

  it('serializes concurrent updates through the file lock', async () => {
    const dir = profileFixture()
    const store = new OriginStore(dir)
    const first = await store.update('pkg-a', { kind: 'personal' }, ORIGIN_MISSING_REVISION)
    // Two writers race with the same base revision; exactly one may win.
    const [winner, loser] = await Promise.allSettled([
      store.update('pkg-b', { kind: 'official' }, first.revision),
      store.update('pkg-c', { kind: 'opensource' }, first.revision),
    ])
    const outcomes = [winner, loser].map(r => r.status)
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = [winner, loser].find(r => r.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'ORIGIN_CONFLICT' })
    const packages = readOverrides(dir)
    expect(packages.size).toBe(2)
    expect(packages.has('pkg-a')).toBe(true)
  })

  it('preserves a corrupt file untouched and reports ORIGIN_FILE_INVALID', async () => {
    const dir = profileFixture()
    const corrupt = '{ not json'
    writeFileSync(join(dir, 'plugin-origins.json'), corrupt)
    const store = new OriginStore(dir)
    const revision = store.revision()
    await expect(store.update('pkg-a', { kind: 'personal' }, revision))
      .rejects.toMatchObject({ code: 'ORIGIN_FILE_INVALID' })
    // The corrupt bytes survived — nothing was replaced by an empty config.
    expect(readFileSync(join(dir, 'plugin-origins.json'), 'utf8')).toBe(corrupt)
  })

  it('refuses to write over a file with a partially invalid entry', async () => {
    const dir = profileFixture()
    const broken = JSON.stringify({
      schemaVersion: 1,
      packages: { 'pkg-good': { kind: 'personal' }, 'pkg-bad': { kind: 'nonsense' } },
    })
    writeFileSync(join(dir, 'plugin-origins.json'), broken)
    const store = new OriginStore(dir)
    await expect(store.update('pkg-new', { kind: 'official' }, store.revision()))
      .rejects.toMatchObject({ code: 'ORIGIN_FILE_INVALID' })
    expect(readFileSync(join(dir, 'plugin-origins.json'), 'utf8')).toBe(broken)
  })

  it('checks file validity before the revision so corruption reports correctly', async () => {
    const dir = profileFixture()
    writeFileSync(join(dir, 'plugin-origins.json'), '{ not json')
    const store = new OriginStore(dir)
    // A stale revision on a corrupt file still reports the corruption.
    await expect(store.update('pkg-a', { kind: 'personal' }, 'stale-revision'))
      .rejects.toMatchObject({ code: 'ORIGIN_FILE_INVALID' })
  })
})
