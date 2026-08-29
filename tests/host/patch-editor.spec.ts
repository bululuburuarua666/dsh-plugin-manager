import { describe, expect, it } from 'vitest'
import {
  applyManagedToggleRows,
  isValidPatchListText,
  LIFECYCLE_BEGIN_MARKER,
  LIFECYCLE_END_MARKER,
  patchTargetIdOf,
  readManagedToggleRows,
  removeManualInsertRows,
  treeIdOfPatchTarget,
} from '../../src/host/patch-editor.ts'

const USER_ROWS = [
  '# hand-written header comment',
  '',
  '- insert:',
  '    - id: dsh-update-checker',
  "      name: 'dsh-update-checker'",
  '',
  '- id: tools',
  '  config:',
  '    mode: !!js process.env.DSH_TOOLS_MODE',
].join('\n')

describe('isValidPatchListText', () => {
  it('accepts patch lists, empty text, and !!js rows; rejects other shapes', () => {
    expect(isValidPatchListText(USER_ROWS)).toBe(true)
    expect(isValidPatchListText('')).toBe(true)
    expect(isValidPatchListText('  \n')).toBe(true)
    expect(isValidPatchListText('[]')).toBe(true)
    expect(isValidPatchListText('not: a-map')).toBe(false)
    expect(isValidPatchListText('42')).toBe(false)
    expect(isValidPatchListText('- 42')).toBe(false)
    expect(isValidPatchListText('- [unclosed')).toBe(false)
  })
})

describe('patchTargetIdOf', () => {
  it('maps only exact single-prefix root-space declarations', () => {
    expect(patchTargetIdOf('include:timer', 'timer')).toBe('timer')
    // Nested subtree ids never match their last segment.
    expect(patchTargetIdOf('include:preset:foo', 'foo')).toBeNull()
    // No include prefix.
    expect(patchTargetIdOf('timer', 'timer')).toBeNull()
    // Declared id must compose back to the exact tree id.
    expect(patchTargetIdOf('include:foo', 'bar')).toBeNull()
    // Non-string and empty declarations are not addressable.
    expect(patchTargetIdOf('include:foo', undefined)).toBeNull()
    expect(patchTargetIdOf('include:foo', '')).toBeNull()
    expect(patchTargetIdOf('include:42', 42)).toBeNull()
  })
})

describe('treeIdOfPatchTarget', () => {
  it('prefixes unconditionally, even when the data id itself contains colons', () => {
    expect(treeIdOfPatchTarget('timer')).toBe('include:timer')
    expect(treeIdOfPatchTarget('include:foo')).toBe('include:include:foo')
  })
})

describe('applyManagedToggleRows', () => {
  it('round-trips the official comments-plus-empty-list template', () => {
    const template = [
      '# Your patch layer for this dsh profile, applied after every bundle layer:',
      '# a top-level YAML array of loader patch entries.',
      '[]',
      '',
    ].join('\n')
    // No-op on a pristine template: nothing to write, nothing to restore.
    const untouched = applyManagedToggleRows(template, [])
    expect(untouched.ok).toBe(true)
    expect(untouched.ok ? untouched.content : '').toBe(template)
    const first = applyManagedToggleRows(template, [{ entryId: 'target', disabled: true }])
    expect(first.ok).toBe(true)
    if (first.ok) {
      // The `[]` flow root is REPLACED by the block; the file stays a single
      // valid document.
      expect(first.content).toContain('- id: target')
      expect(first.content).not.toMatch(/^\[\]$/m)
      const rows = readManagedToggleRows(first.content)
      expect(rows !== null && rows.ok ? rows.rows : []).toEqual([{ entryId: 'target', disabled: true }])
      // Collapsing the block re-emits `[]` so the layer never becomes the
      // null document the boot path rejects.
      const cleared = applyManagedToggleRows(first.content, [])
      expect(cleared.ok).toBe(true)
      if (cleared.ok) {
        expect(cleared.content).not.toContain('- id: target')
        expect(cleared.content.trimEnd().endsWith('[]')).toBe(true)
        expect(isValidPatchListText(cleared.content)).toBe(true)
      }
    }
  })

  it('appends a sorted marker block to a file without one', () => {
    const result = applyManagedToggleRows(USER_ROWS, [
      { entryId: 'zeta', disabled: true },
      { entryId: 'alpha', disabled: false },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content.startsWith(USER_ROWS)).toBe(true)
    const block = result.content.slice(USER_ROWS.length)
    expect(block).toBe([
      '',
      LIFECYCLE_BEGIN_MARKER,
      '- id: alpha',
      '  disabled: null',
      '- id: zeta',
      '  disabled: true',
      LIFECYCLE_END_MARKER,
    ].join('\n'))
  })

  it('replaces only the marker block and preserves every other byte', () => {
    const source = [
      USER_ROWS,
      LIFECYCLE_BEGIN_MARKER,
      '- id: stale',
      '  disabled: true',
      '# inside comment is replaced with the block',
      LIFECYCLE_END_MARKER,
      '# trailing comment survives',
      '',
    ].join('\n')
    const result = applyManagedToggleRows(source, [{ entryId: 'fresh', disabled: true }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe([
      USER_ROWS,
      LIFECYCLE_BEGIN_MARKER,
      '- id: fresh',
      '  disabled: true',
      LIFECYCLE_END_MARKER,
      '# trailing comment survives',
      '',
    ].join('\n'))
  })

  it('keeps CRLF newlines, a BOM, and a missing final newline', () => {
    const crlf = USER_ROWS.split('\n').join('\r\n')
    const result = applyManagedToggleRows(crlf, [{ entryId: 'a', disabled: true }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('\r\n- id: a\r\n')
    expect(result.content.startsWith(crlf)).toBe(true)

    const bom = `﻿${USER_ROWS}`
    const bomResult = applyManagedToggleRows(bom, [{ entryId: 'b', disabled: true }])
    expect(bomResult.ok).toBe(true)
    if (!bomResult.ok) return
    expect(bomResult.content.startsWith('﻿')).toBe(true)

    const noTrailing = USER_ROWS
    const noTrailingResult = applyManagedToggleRows(noTrailing, [{ entryId: 'c', disabled: true }])
    expect(noTrailingResult.ok).toBe(true)
    if (!noTrailingResult.ok) return
    expect(noTrailingResult.content.endsWith(LIFECYCLE_END_MARKER)).toBe(true)
  })

  it('removes the whole block when the managed set becomes empty', () => {
    const source = [
      USER_ROWS,
      LIFECYCLE_BEGIN_MARKER,
      '- id: stale',
      '  disabled: true',
      LIFECYCLE_END_MARKER,
      '# trailing comment survives',
      '',
    ].join('\n')
    const result = applyManagedToggleRows(source, [])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe([
      USER_ROWS,
      '# trailing comment survives',
      '',
    ].join('\n'))
    // An empty set on a file without a block is a byte-identical no-op.
    const noOp = applyManagedToggleRows(USER_ROWS, [])
    expect(noOp.ok).toBe(true)
    if (!noOp.ok) return
    expect(noOp.content).toBe(USER_ROWS)
  })

  it('creates a patch file from empty text', () => {
    const result = applyManagedToggleRows('', [{ entryId: 'a', disabled: true }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe([
      LIFECYCLE_BEGIN_MARKER,
      '- id: a',
      '  disabled: true',
      LIFECYCLE_END_MARKER,
      '',
    ].join('\n'))
  })

  it('quotes entry ids that are not plain-safe', () => {
    const result = applyManagedToggleRows('', [{ entryId: 'weird: id', disabled: true }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('- id: "weird: id"')
  })

  it('refuses duplicate, unpaired, and misordered markers', () => {
    const paired = [LIFECYCLE_BEGIN_MARKER, LIFECYCLE_END_MARKER].join('\n')
    const doubled = applyManagedToggleRows(`${paired}\n${paired}`, [])
    expect(doubled.ok).toBe(false)
    const unpaired = applyManagedToggleRows(LIFECYCLE_BEGIN_MARKER, [])
    expect(unpaired.ok).toBe(false)
    const swapped = [LIFECYCLE_END_MARKER, LIFECYCLE_BEGIN_MARKER].join('\n')
    const result = applyManagedToggleRows(swapped, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('MANAGED_BLOCK_INVALID')
  })

  it('refuses invalid source shapes', () => {
    const notAMap = applyManagedToggleRows('not: a-map', [])
    const scalarRow = applyManagedToggleRows('- 42', [])
    const unclosed = applyManagedToggleRows('- [unclosed', [])
    for (const result of [notAMap, scalarRow, unclosed]) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('INVALID_PATCH')
    }
  })

  it('round-trips: a block written is a block replaced', () => {
    const first = applyManagedToggleRows(USER_ROWS, [{ entryId: 'a', disabled: true }])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = applyManagedToggleRows(first.content, [{ entryId: 'b', disabled: false }])
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.content).not.toContain('- id: a')
    expect(second.content).toContain('- id: b')
    expect(second.content.startsWith(USER_ROWS)).toBe(true)
  })
})

describe('removeManualInsertRows', () => {
  it('splices a single-entry manual insert and drops the emptied insert item', () => {
    const result = removeManualInsertRows(USER_ROWS, 'dsh-update-checker')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removedEntryIds).toEqual(['dsh-update-checker'])
    expect(result.content).toBe([
      '# hand-written header comment',
      '',
      '- id: tools',
      '  config:',
      '    mode: !!js process.env.DSH_TOOLS_MODE',
    ].join('\n'))
  })

  it('removes one entry from a multi-entry insert and keeps its siblings byte-identical', () => {
    const source = [
      '- insert:',
      '    - id: keep-me',
      '      name: \'keep-me\'',
      '    - id: remove-me',
      "      name: 'remove-me'",
      '',
      '# tail',
    ].join('\n')
    const result = removeManualInsertRows(source, 'remove-me')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.removedEntryIds).toEqual(['remove-me'])
    expect(result.content).toBe([
      '- insert:',
      '    - id: keep-me',
      '      name: \'keep-me\'',
      '',
      '# tail',
    ].join('\n'))
  })

  it('reports no removed ids for an id-less entry and skips non-map siblings', () => {
    const idLess = [
      '- insert:',
      "    - name: 'id-less'",
    ].join('\n')
    const idLessResult = removeManualInsertRows(idLess, 'id-less')
    expect(idLessResult.ok).toBe(true)
    if (!idLessResult.ok) return
    expect(idLessResult.removedEntryIds).toEqual([])

    const withScalarSibling = [
      '- insert:',
      "    - name: 'splice-me'",
      '    - 42',
      '',
    ].join('\n')
    const siblingResult = removeManualInsertRows(withScalarSibling, 'splice-me')
    expect(siblingResult.ok).toBe(true)
    if (!siblingResult.ok) return
    expect(siblingResult.content).toBe('- insert:\n    - 42\n')
  })

  it('accepts comment-only documents as empty patch lists', () => {
    expect(isValidPatchListText('# only a comment\n')).toBe(true)
    expect(isValidPatchListText('   \n  # comment\n')).toBe(true)
  })

  it('reads managed rows and refuses unrecognized or truncated ones', () => {
    const source = [
      LIFECYCLE_BEGIN_MARKER,
      '- id: numeric-id',
      '  disabled: true',
      '',
      '- id: named-id',
      '  disabled: false',
      LIFECYCLE_END_MARKER,
    ].join('\n')
    const rows = readManagedToggleRows(source)
    expect(rows !== null && rows.ok ? rows.rows : []).toEqual([
      { entryId: 'numeric-id', disabled: true },
      { entryId: 'named-id', disabled: false },
    ])

    const stray = [LIFECYCLE_BEGIN_MARKER, 'random text', LIFECYCLE_END_MARKER].join('\n')
    const strayRead = readManagedToggleRows(stray)
    expect(strayRead !== null && !strayRead.ok ? strayRead.code : 'ok').toBe('MANAGED_BLOCK_INVALID')

    const truncated = [LIFECYCLE_BEGIN_MARKER, '- id: x', LIFECYCLE_END_MARKER].join('\n')
    const truncatedRead = readManagedToggleRows(truncated)
    expect(truncatedRead !== null && !truncatedRead.ok ? truncatedRead.code : 'ok').toBe('MANAGED_BLOCK_INVALID')

    expect(readManagedToggleRows('# no block\n')).toBeNull()
  })

  it('refuses ambiguous, absent, aliased, and non-sequence shapes', () => {
    const ambiguous = [
      '- insert:',
      "    - name: 'dup'",
      '- insert:',
      "    - name: 'dup'",
    ].join('\n')
    const ambiguousResult = removeManualInsertRows(ambiguous, 'dup')
    expect(ambiguousResult.ok).toBe(false)
    if (ambiguousResult.ok) return
    expect(ambiguousResult.code).toBe('UNSUPPORTED_PATCH_SHAPE')

    const absent = removeManualInsertRows(USER_ROWS, 'absent-module')
    expect(absent.ok).toBe(false)
    if (absent.ok) return
    expect(absent.code).toBe('UNSUPPORTED_PATCH_SHAPE')

    // A surviving id-targeted row still referencing the module keeps the
    // candidate in a state that would re-apply the removal: refuse. The blank
    // line keeps the insert item's range from crossing into the next item.
    const stillReferenced = [
      '- insert:',
      "    - name: 'linked-module'",
      '',
      '- id: linked-module',
      '  disabled: true',
    ].join('\n')
    const referencedResult = removeManualInsertRows(stillReferenced, 'linked-module')
    expect(referencedResult.ok).toBe(false)
    if (referencedResult.ok) return
    expect(referencedResult.code).toBe('UNSUPPORTED_PATCH_SHAPE')

    // An alias inside the removal range: parsed cleanly by both parsers, but
    // splicing it would corrupt the shared reference — refuse structurally.
    const aliased = [
      '- insert:',
      "    - name: 'anchored'",
      '      extra: &x 1',
      '      more: *x',
    ].join('\n')
    const aliasedResult = removeManualInsertRows(aliased, 'anchored')
    expect(aliasedResult.ok).toBe(false)
    if (aliasedResult.ok) return
    expect(aliasedResult.code).toBe('UNSUPPORTED_PATCH_SHAPE')

    // The alias lives in an earlier sibling: the scan stops at the first
    // subsequent visit once the alias is found, and the whole insert refuses.
    const aliasedSibling = [
      '- insert:',
      "    - name: 'aliased-first'",
      '      extra: &z 1',
      '      more: *z',
      "    - name: 'target'",
    ].join('\n')
    const siblingAliasResult = removeManualInsertRows(aliasedSibling, 'target')
    expect(siblingAliasResult.ok).toBe(false)
    if (siblingAliasResult.ok) return
    expect(siblingAliasResult.code).toBe('UNSUPPORTED_PATCH_SHAPE')

    // A cross-item anchor/alias pair is refused too (whichever guard fires).
    const crossItem = [
      '- insert:',
      '    - &anchor',
      "        name: 'anchored'",
      '- id: other',
      '  config: *anchor',
    ].join('\n')
    expect(removeManualInsertRows(crossItem, 'anchored').ok).toBe(false)

    const notAMap = removeManualInsertRows('not: a-map', 'x')
    const unclosed = removeManualInsertRows('- [unclosed', 'x')
    for (const result of [notAMap, unclosed]) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('INVALID_PATCH')
    }
  })
})

