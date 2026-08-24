import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LifecycleEngine, blockReasonToCode, type EngineHost } from '../../src/host/engine.ts'
import { readManagedToggleRows } from '../../src/host/patch-editor.ts'
import { PluginLifecycleTokenStore } from '../../src/host/token-store.ts'
import { PluginLifecycleOperationStore } from '../../src/host/operation-store.ts'
import { lifecycleFailure } from '../../src/host/failure.ts'
import { runPnpm } from '../../src/host/package-runner.ts'
import type { LoaderEntry } from '../../src/host/cordis.ts'
import type { PluginLifecycleOperationView } from '../../src/host/engine-types.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** In-memory Loader double: the engine reads entries through this array. */
function fakeLoader(entries: LoaderEntry[]): { entries: LoaderEntry[] } {
  return { entries }
}

/** Build an engine over a temp profile with the given roster rows. */
function engineHarness(options: {
  profile?: boolean
  roster?: LoaderEntry[]
  persistence?: 'writable' | 'read-only'
  runner?: EngineHost['createPackageRunner']
}): { engine: LifecycleEngine; loader: { entries: LoaderEntry[] }; profileDir: string | null; baseUrl: string | undefined } {
  const loader = fakeLoader(options.roster ?? [])
  let profileDir: string | null = null
  let baseUrl: string | undefined
  if (options.profile !== false) {
    profileDir = mkdtempSync(join(tmpdir(), 'dsh-mgr-engine-'))
    tempDirs.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test' }))
    baseUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
  }
  const host: EngineHost = {
    entries: () => loader.entries,
    persistence: () => options.persistence ?? 'writable',
    engineTreeRoot: null,
    ...(options.runner !== undefined ? { createPackageRunner: options.runner } : {}),
  }
  return { engine: new LifecycleEngine(baseUrl, host), loader, profileDir, baseUrl }
}

/** Extract the structured code from a thrown engine failure. */
function failureOf(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    const failure = error as { code: string; message: string }
    return { code: failure.code, message: failure.message }
  }
  throw new Error('expected a structured failure')
}

describe('LifecycleEngine shell', () => {
  it('exposes the four engine operations', () => {
    const { engine } = engineHarness({ profile: false })
    expect(typeof engine.capabilities).toBe('function')
    expect(typeof engine.preview).toBe('function')
    expect(typeof engine.execute).toBe('function')
    expect(typeof engine.operation).toBe('function')
  })

  it('fails unknown operations with a structured code', () => {
    const { engine } = engineHarness({ profile: false })
    expect(failureOf(() => engine.operation({ operationId: 'nope' })).message).toMatch(/unknown operation/)
  })
})

describe('PluginLifecycleTokenStore', () => {
  const binding = {
    action: 'disable',
    entryId: 'entry-1',
    packageName: 'pkg',
    affectedEntryIds: ['entry-1'],
    restartRequired: false,
    revision: 'rev-1',
  } as const

  it('issues and consumes a token exactly once', () => {
    const tick = 1_000
    const store = new PluginLifecycleTokenStore({ now: () => tick, randomHex: () => 'a'.repeat(32) })
    const { token, expiresAt } = store.issue(binding)
    expect(token).toBe('a'.repeat(32))
    expect(expiresAt).toBe(61_000)
    expect(store.consume(token)).toMatchObject({ entryId: 'entry-1', action: 'disable' })
    expect(store.consume(token)).toBeNull()
  })

  it('expires tokens at the TTL and sweeps them lazily', () => {
    let tick = 0
    let counter = 0
    const store = new PluginLifecycleTokenStore({
      now: () => tick,
      randomHex: () => (counter++).toString(16).padStart(4, '0'),
      ttlMs: 100,
    })
    const first = store.issue(binding)
    tick = 101
    expect(store.consume(first.token)).toBeNull()
    expect(store.consume(first.token)).toBeNull()

    tick = 200
    store.issue(binding)
    tick = 400
    store.issue(binding)
    tick = 401
    expect(store.consume('0001')).toBeNull()
  })

  it('evicts the oldest token beyond capacity', () => {
    let counter = 0
    const store = new PluginLifecycleTokenStore({
      randomHex: () => (counter++).toString(16).padStart(4, '0'),
      capacity: 2,
    })
    store.issue(binding)
    store.issue(binding)
    store.issue(binding)
    expect(store.consume('0000')).toBeNull()
    expect(store.consume('0001')).not.toBeNull()
    expect(store.consume('0002')).not.toBeNull()
  })
})

describe('PluginLifecycleOperationStore', () => {
  it('creates, updates, and reads operations', () => {
    const store = new PluginLifecycleOperationStore()
    const id = store.create('disable')
    expect(store.get(id)).toMatchObject({ state: 'queued', action: 'disable' })
    store.update(id, { state: 'succeeded' })
    expect(store.get(id)!.state).toBe('succeeded')
  })

  it('tolerates an empty update object', () => {
    const store = new PluginLifecycleOperationStore()
    const id = store.create('disable')
    store.update(id, {})
    expect(store.get(id)).toMatchObject({ state: 'queued', action: 'disable' })
  })

  it('ignores updates for unknown operation ids', () => {
    const store = new PluginLifecycleOperationStore()
    expect(() => store.update('nope', { state: 'succeeded' })).not.toThrow()
    expect(store.get('nope')).toBeNull()
  })

  it('evicts the oldest operation beyond capacity', () => {
    const store = new PluginLifecycleOperationStore({ capacity: 2 })
    const first = store.create('disable')
    store.create('enable')
    store.create('uninstall')
    expect(store.get(first)).toBeNull()
  })
})

describe('lifecycleFailure', () => {
  it('carries the structured payload the channel preserves', () => {
    const failure = lifecycleFailure('PROFILE_CHANGED', 'drifted')
    expect(failure.code).toBe('PROFILE_CHANGED')
    expect(failure.message).toBe('drifted')
  })

  it('maps every capability block reason to its wire code', () => {
    expect(blockReasonToCode('read-only-remote')).toBe('READ_ONLY_REMOTE')
    expect(blockReasonToCode('protected-plugin')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('engine-owned')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('template-bundle')).toBe('PROTECTED_PLUGIN')
    expect(blockReasonToCode('not-direct-dependency')).toBe('NOT_DIRECT_DEPENDENCY')
  })
})
