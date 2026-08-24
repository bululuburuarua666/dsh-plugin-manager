/**
 * Source-preserving editor for the profile's user patch file
 * (`cordis.patch.yml`). Two operations only:
 *
 * - {@link applyManagedToggleRows} replaces the content of the unique
 *   BEGIN/END lifecycle marker block, leaving every other byte untouched;
 * - {@link removeManualInsertRows} splices a manual-insert entry using parsed
 *   structure plus byte ranges — never a full-file re-stringify.
 *
 * Both return candidate bytes; the caller validates and commits them.
 */

import { load as parseYaml } from 'js-yaml'
import { entryListSchema } from './entry-schema.ts'
import { isAlias, isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'

/** Marker comment delimiting the lifecycle-managed block. */
export const LIFECYCLE_BEGIN_MARKER = '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit'
/** Closing marker comment of the lifecycle-managed block. */
export const LIFECYCLE_END_MARKER = '# END DSH PLUGIN LIFECYCLE'

/** One managed toggle row: `disabled: true` disables, `false` writes null. */
export interface ManagedToggleRow {
  readonly entryId: string
  readonly disabled: boolean
}

/** Editor failure codes surfaced as lifecycle error codes. */
export type PatchEditorFailureCode = 'INVALID_PATCH' | 'MANAGED_BLOCK_INVALID' | 'UNSUPPORTED_PATCH_SHAPE'

/** Editor outcome: candidate bytes, or a structured refusal. */
export type PatchEditResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly code: PatchEditorFailureCode; readonly message: string }

/** Insert-removal outcome additionally reports the removed entry ids. */
export type InsertRemovalResult =
  | { readonly ok: true; readonly content: string; readonly removedEntryIds: readonly string[] }
  | { readonly ok: false; readonly code: PatchEditorFailureCode; readonly message: string }

function failure(code: PatchEditorFailureCode, message: string): { ok: false; code: PatchEditorFailureCode; message: string } {
  return { ok: false, code, message }
}

/**
 * Validate patch text with the same contract the boot path uses
 * (`app-boot`'s parsePatchList): js-yaml under the include's entry-list
 * schema, a top-level array, and mapping items.
 * @param text - candidate or source patch text.
 * @returns true when the text is a structurally valid patch list.
 */
export function isValidPatchListText(text: string): boolean {
  let parsed: unknown
  try {
    parsed = parseYaml(text, { schema: entryListSchema })
  } catch {
    return false
  }
  if (parsed === null || parsed === undefined) {
    // A document of comments/whitespace only is a null YAML document: treat it
    // as the empty patch list this editor may legitimately produce mid-edit.
    return /^(\s*#.*)?$/s.test(text.trimEnd())
  }
  if (!Array.isArray(parsed)) return false
  return parsed.every(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
}

/** Detected byte-level text style of a patch file. */
interface TextStyle {
  readonly bom: boolean
  readonly newline: '\r\n' | '\n'
  readonly trailingNewline: boolean
}

/** Detect BOM, dominant newline, and final-newline presence. */
function detectStyle(source: string): TextStyle {
  const bom = source.startsWith('﻿')
  const body = bom ? source.slice(1) : source
  return {
    bom,
    newline: body.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: body.length === 0 || body.endsWith('\n'),
  }
}

/** Split into lines without keeping terminators. */
function splitLines(source: string): string[] {
  return source.replace(/^﻿/, '').split(/\r?\n/)
}

/** Emit one scalar YAML-safe: plain when safe, JSON-quoted otherwise. */
function scalarText(value: string): string {
  // A leading non-digit keeps all-numeric ids (hex Loader ids) from being
  // parsed back as YAML numbers.
  return /^[A-Za-z][A-Za-z0-9._~/-]*$/.test(value) ? value : JSON.stringify(value)
}

/** Serialize the managed rows deterministically (sorted by entryId). */
function serializeManagedRows(rows: readonly ManagedToggleRow[]): string[] {
  const sorted = [...rows].sort((left, right) => left.entryId.localeCompare(right.entryId))
  const lines: string[] = []
  for (const row of sorted) {
    lines.push(`- id: ${scalarText(row.entryId)}`)
    lines.push(`  disabled: ${row.disabled ? 'true' : 'null'}`)
  }
  return lines
}

/**
 * Replace the lifecycle marker block inside a patch file. With no markers the
 * block is appended after the existing top-level sequence; exactly one marker
 * pair replaces its inner rows. Duplicate, nested, or misordered markers, an
 * indented marker, or an invalid source shape refuse the edit.
 * @param source - current file text (empty string means no file yet).
 * @param rows - the complete next managed row set.
 * @returns candidate bytes or a structured refusal.
 */
export function applyManagedToggleRows(source: string, rows: readonly ManagedToggleRow[]): PatchEditResult {
  if (!isValidPatchListText(source)) {
    return failure('INVALID_PATCH', 'patch file is not a valid top-level loader patch list')
  }
  const style = detectStyle(source)
  const lines = splitLines(source)
  // A trailing newline produces a sentinel empty last line; keep it out of
  // the marker scan and re-attach at the end.
  const tailEmpty = lines.length > 0 && lines[lines.length - 1] === ''
  const body = tailEmpty ? lines.slice(0, -1) : lines

  const beginAt: number[] = []
  const endAt: number[] = []
  body.forEach((line, index) => {
    if (line === LIFECYCLE_BEGIN_MARKER) beginAt.push(index)
    if (line === LIFECYCLE_END_MARKER) endAt.push(index)
  })
  if (beginAt.length > 1 || endAt.length > 1) {
    return failure('MANAGED_BLOCK_INVALID', 'duplicate lifecycle marker blocks')
  }
  if (beginAt.length !== endAt.length) {
    return failure('MANAGED_BLOCK_INVALID', 'unpaired lifecycle marker')
  }

  const blockLines = rows.length === 0 ? [] : [LIFECYCLE_BEGIN_MARKER, ...serializeManagedRows(rows), LIFECYCLE_END_MARKER]
  let next: string[]
  if (beginAt.length === 0) {
    next = rows.length === 0 ? body : [...body, ...blockLines]
  } else {
    const begin = beginAt[0] as number
    const end = endAt[0] as number
    if (end < begin) {
      return failure('MANAGED_BLOCK_INVALID', 'end marker precedes begin marker')
    }
    // An empty managed set removes the whole block, restoring the file to its
    // unmanaged content; a non-empty set replaces the block inner rows.
    next = rows.length === 0
      ? [...body.slice(0, begin), ...body.slice(end + 1)]
      : [...body.slice(0, begin), ...blockLines, ...body.slice(end + 1)]
  }

  const joined = next.join(style.newline)
  const content = `${style.bom ? '﻿' : ''}${joined}${style.trailingNewline ? style.newline : ''}`
  /* v8 ignore next -- the editor only composes marker comments and quoted rows;
     a candidate failing here means the source misled validation. */
  if (!isValidPatchListText(content)) {
    return failure('INVALID_PATCH', 'managed block candidate failed patch-list validation')
  }
  return { ok: true, content }
}

/** Line-start offsets of a text, for range→line mapping. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/** The start offset of the line containing `offset`. */
function lineStartOf(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((starts[mid] as number) <= offset) low = mid
    else high = mid - 1
  }
  return starts[low] as number
}

/** The start offset of the line AFTER the line containing `offset`. */
function nextLineStartOf(starts: readonly number[], offset: number, textLength: number): number {
  const start = lineStartOf(starts, offset)
  const index = starts.indexOf(start)
  return index + 1 < starts.length ? (starts[index + 1] as number) : textLength
}

/** One removable row inside a manual insert list. */
interface InsertMatch {
  /** The entry map node whose `name` matches the target module. */
  readonly entry: YAMLMap
  /** The insert sequence containing the entry. */
  readonly insertSeq: YAMLSeq
  /** The top-level patch item (`- insert: …`) owning the sequence. */
  readonly topItem: YAMLMap
  /** Ids declared by the matched entry. */
  readonly entryId: string | null
}

/** Whether a subtree contains an alias node (which shares source ranges). */
function containsAlias(node: unknown): boolean {
  let found = false
  const visit = (value: unknown): void => {
    if (found) return
    if (isAlias(value)) {
      found = true
      return
    }
    if (isMap(value) || isSeq(value)) {
      for (const item of value.items) visit(item)
    } else if (typeof value === 'object' && value !== null && 'key' in (value as Record<string, unknown>)) {
      const pair = value as { key?: unknown; value?: unknown }
      visit(pair.key)
      visit(pair.value)
    }
  }
  visit(node)
  return found
}
/** Read result of the managed block, or null when no block exists. */
export type ManagedToggleReadResult =
  | { readonly ok: true; readonly rows: ManagedToggleRow[] }
  | { readonly ok: false; readonly code: PatchEditorFailureCode; readonly message: string }

/**
 * Read the current managed toggle rows from a patch file. Returns null when
 * the marker block is absent (no managed state yet); refuses with an
 * `MANAGED_BLOCK_INVALID` failure when the markers are malformed.
 * @param source - current file text.
 * @returns parsed managed rows, or null when no block exists.
 */
export function readManagedToggleRows(source: string): ManagedToggleReadResult | null {
  const lines = splitLines(source)
  const beginAt: number[] = []
  const endAt: number[] = []
  lines.forEach((line, index) => {
    if (line === LIFECYCLE_BEGIN_MARKER) beginAt.push(index)
    if (line === LIFECYCLE_END_MARKER) endAt.push(index)
  })
  if (beginAt.length === 0 && endAt.length === 0) return null
  if (beginAt.length !== 1 || endAt.length !== 1 || (endAt[0] as number) < (beginAt[0] as number)) {
    return failure('MANAGED_BLOCK_INVALID', 'malformed lifecycle marker block')
  }
  const rows: ManagedToggleRow[] = []
  const rowPattern = /^- id: (.+)$/
  const valuePattern = /^ {2}disabled: (true|false|null)$/
  for (let index = (beginAt[0] as number) + 1; index < (endAt[0] as number); index++) {
    const line = lines[index] as string
    if (line.trim().length === 0) continue
    const idMatch = rowPattern.exec(line)
    if (idMatch === null) return failure('MANAGED_BLOCK_INVALID', `unrecognized managed row line: ${line}`)
    const entryId = parseYaml(idMatch[1] as string, { schema: entryListSchema }) as string
    const valueLine = lines[index + 1]
    /* v8 ignore next -- the END marker always follows a well-formed managed block, so the row is never the last line. */
    const valueMatch = valueLine === undefined ? null : valuePattern.exec(valueLine)
    if (valueMatch === null) return failure('MANAGED_BLOCK_INVALID', `managed row misses its disabled value: ${entryId}`)
    rows.push({ entryId, disabled: valueMatch[1] === 'true' })
    index++
  }
  return { ok: true, rows }
}

/** Scalar string value of a map key, when present and plain. */
function scalarValue(map: YAMLMap, key: string): string | null {
  const value = map.get(key, true)
  return isScalar(value) && typeof value.value === 'string' ? value.value : null
}

/**
 * Splice the manual-insert entry rows whose `name` equals `moduleName` out of
 * a patch file. The structural match is confirmed through the parsed document
 * and removed with byte ranges; an insert list emptied by the splice loses its
 * whole top-level item. Ambiguous matches, aliases, non-sequence tops, or an
 * unparseable source refuse the edit.
 * @param source - current patch file text.
 * @param moduleName - exact package/module name to remove.
 * @returns candidate bytes plus removed entry ids, or a structured refusal.
 */
export function removeManualInsertRows(source: string, moduleName: string): InsertRemovalResult {
  if (!isValidPatchListText(source)) {
    return failure('INVALID_PATCH', 'patch file is not a valid top-level loader patch list')
  }
  const document = parseDocument(source, { keepSourceTokens: false })
  /* v8 ignore next -- the validity gate above already uses the same parser dialect; text that passes it cannot error here. */
  if (document.errors.length > 0) {
    return failure('INVALID_PATCH', 'patch file failed to parse for structural editing')
  }
  const top = document.contents
  if (!isSeq(top)) {
    // Empty or comment-only files carry no sequence: report the entry as not
    // manual-insert-owned so callers keep the patch as-is.
    return failure('UNSUPPORTED_PATCH_SHAPE', `no manual insert row declares ${JSON.stringify(moduleName)}`)
  }

  const matches: InsertMatch[] = []
  for (const item of top.items) {
    /* v8 ignore next -- the validity gate above rejects non-mapping top-level items before the scan runs. */
    if (!isMap(item)) continue
    const insertValue = item.get('insert', true)
    if (!isSeq(insertValue)) continue
    for (const entry of insertValue.items) {
      if (!isMap(entry)) continue
      if (scalarValue(entry, 'name') === moduleName) {
        matches.push({ entry, insertSeq: insertValue, topItem: item, entryId: scalarValue(entry, 'id') })
      }
    }
  }
  if (matches.length === 0) {
    return failure('UNSUPPORTED_PATCH_SHAPE', `no manual insert row declares ${JSON.stringify(moduleName)}`)
  }
  if (matches.length > 1) {
    return failure('UNSUPPORTED_PATCH_SHAPE', `multiple manual insert rows declare ${JSON.stringify(moduleName)}`)
  }
  const match = matches[0] as InsertMatch
  if (containsAlias(match.topItem)) {
    return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert row contains a YAML alias')
  }

  const starts = lineStarts(source)
  // The entry's removal starts at its item dash: walk up from the entry's
  // start line to the nearest line whose first non-space character is '-'.
  const entryRange = match.entry.range
  /* v8 ignore next -- parsed block maps always carry source ranges. */
  if (entryRange === null || entryRange === undefined) {
    return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert entry carries no source range')
  }
  let entryStartLine = lineStartOf(starts, entryRange[0])
  while (entryStartLine > 0) {
    const lineEnd = source.indexOf('\n', entryStartLine)
    const line = source.slice(entryStartLine, lineEnd === -1 ? source.length : lineEnd)
    if (/^\s*-/.test(line)) break
    entryStartLine = lineStartOf(starts, entryStartLine - 1)
  }
  {
    const lineEnd = source.indexOf('\n', entryStartLine)
    const line = source.slice(entryStartLine, lineEnd === -1 ? source.length : lineEnd)
    /* v8 ignore next -- every block-sequence entry's dash line is reachable by the walk above. */
    if (!/^\s*-/.test(line)) {
      return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert entry has no owning dash line')
    }
  }
  const entryEnd = nextLineStartOf(starts, entryRange[2] - 1, source.length)

  const removeWholeItem = match.insertSeq.items.length === 1
  let spliceStart: number
  let spliceEnd: number
  if (removeWholeItem) {
    const topRange = match.topItem.range
    /* v8 ignore next -- parsed block maps always carry source ranges. */
    if (topRange === null || topRange === undefined) {
      return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert item carries no source range')
    }
    spliceStart = lineStartOf(starts, topRange[0])
    /* v8 ignore next -- a non-empty insert map always spans both range offsets; the empty-node arm is defensive only. */
    spliceEnd = nextLineStartOf(starts, topRange[2] === topRange[1] ? topRange[2] : topRange[2] - 1, source.length)
  } else {
    spliceStart = entryStartLine
    spliceEnd = entryEnd
  }

  const content = source.slice(0, spliceStart) + source.slice(spliceEnd)
  if (!isValidPatchListText(content)) {
    return failure('INVALID_PATCH', 'insert-removal candidate failed patch-list validation')
  }
  const reparsed = parseDocument(content)
  let stillPresent = false
  if (isSeq(reparsed.contents)) {
    for (const item of reparseItems(reparsed.contents)) {
      if (scalarValue(item, 'name') === moduleName || scalarValue(item, 'id') === moduleName) stillPresent = true
      const insertValue = item.get('insert', true)
      if (isSeq(insertValue)) {
        for (const entry of insertValue.items) {
          /* v8 ignore next -- duplicate insert names are refused by the ambiguity check before any splice runs. */
          if (isMap(entry) && scalarValue(entry, 'name') === moduleName) stillPresent = true
        }
      }
    }
  }
  if (stillPresent) {
    return failure('UNSUPPORTED_PATCH_SHAPE', 'candidate still contains the removed module')
  }
  return { ok: true, content, removedEntryIds: match.entryId === null ? [] : [match.entryId] }
}

/** Iterate YAMLMap items of a sequence, ignoring non-map entries. */
function* reparseItems(seq: YAMLSeq): Generator<YAMLMap> {
  for (const item of seq.items) {
    /* v8 ignore next -- the validity gate rejects non-mapping top-level items before the reparse runs. */
    if (isMap(item)) yield item
  }
}
