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
import { load as parseYaml } from 'js-yaml';
import { entryListSchema } from "./entry-schema.js";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
/** Marker comment delimiting the lifecycle-managed block. */
export const LIFECYCLE_BEGIN_MARKER = '# BEGIN DSH PLUGIN LIFECYCLE — managed, do not edit';
/** Closing marker comment of the lifecycle-managed block. */
export const LIFECYCLE_END_MARKER = '# END DSH PLUGIN LIFECYCLE';
/**
 * Translate a loader tree entry id into the patch-layer data id it targets
 * (the last `:`-segment; ids without a colon are their own data id).
 */
export function dataIdOf(entryId) {
    const cut = entryId.lastIndexOf(':');
    return cut === -1 ? entryId : entryId.slice(cut + 1);
}
function failure(code, message) {
    return { ok: false, code, message };
}
/**
 * Validate patch text with the same contract the boot path uses
 * (`app-boot`'s parsePatchList): js-yaml under the include's entry-list
 * schema, a top-level array, and mapping items.
 * @param text - candidate or source patch text.
 * @returns true when the text is a structurally valid patch list.
 */
export function isValidPatchListText(text) {
    let parsed;
    try {
        parsed = parseYaml(text, { schema: entryListSchema });
    }
    catch {
        return false;
    }
    if (parsed === null || parsed === undefined) {
        // A document of comments/whitespace only is a null YAML document: treat it
        // as the empty patch list this editor may legitimately produce mid-edit.
        return /^(\s*#.*)?$/s.test(text.trimEnd());
    }
    if (!Array.isArray(parsed))
        return false;
    return parsed.every(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
}
/** Detect BOM, dominant newline, and final-newline presence. */
function detectStyle(source) {
    const bom = source.startsWith('﻿');
    const body = bom ? source.slice(1) : source;
    return {
        bom,
        newline: body.includes('\r\n') ? '\r\n' : '\n',
        trailingNewline: body.length === 0 || body.endsWith('\n'),
    };
}
/** Split into lines without keeping terminators. */
function splitLines(source) {
    return source.replace(/^﻿/, '').split(/\r?\n/);
}
/** Emit one scalar YAML-safe: plain when safe, JSON-quoted otherwise. */
function scalarText(value) {
    // A leading non-digit keeps all-numeric ids (hex Loader ids) from being
    // parsed back as YAML numbers.
    return /^[A-Za-z][A-Za-z0-9._~/-]*$/.test(value) ? value : JSON.stringify(value);
}
/** Serialize the managed rows deterministically (sorted by entryId). */
function serializeManagedRows(rows) {
    const sorted = [...rows].sort((left, right) => left.entryId.localeCompare(right.entryId));
    const lines = [];
    for (const row of sorted) {
        lines.push(`- id: ${scalarText(row.entryId)}`);
        lines.push(`  disabled: ${row.disabled ? 'true' : 'null'}`);
    }
    return lines;
}
/**
 * True when the body is the official no-layer template shape: comments and
 * blank lines plus exactly one bare `[]` line (empty flow-sequence root).
 * The first managed write must REPLACE that line — appending under a flow
 * root is not a valid YAML document — and collapsing back to zero rows must
 * re-emit it, because a comment-only document parses as null and the boot
 * path rejects null patch lists.
 */
function splitEmptyFlowRoot(body) {
    let markerLine = -1;
    for (let index = 0; index < body.length; index += 1) {
        const line = body[index];
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        if (trimmed.startsWith('#'))
            continue;
        if (trimmed === '[]' && markerLine === -1) {
            markerLine = index;
            continue;
        }
        return null;
    }
    if (markerLine === -1)
        return null;
    const comments = body.filter((_, index) => index !== markerLine);
    return { comments, markerLine };
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
export function applyManagedToggleRows(source, rows) {
    if (!isValidPatchListText(source)) {
        return failure('INVALID_PATCH', 'patch file is not a valid top-level loader patch list');
    }
    const style = detectStyle(source);
    const lines = splitLines(source);
    // A trailing newline produces a sentinel empty last line; keep it out of
    // the marker scan and re-attach at the end.
    const tailEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    const body = tailEmpty ? lines.slice(0, -1) : lines;
    const beginAt = [];
    const endAt = [];
    body.forEach((line, index) => {
        if (line === LIFECYCLE_BEGIN_MARKER)
            beginAt.push(index);
        if (line === LIFECYCLE_END_MARKER)
            endAt.push(index);
    });
    if (beginAt.length > 1 || endAt.length > 1) {
        return failure('MANAGED_BLOCK_INVALID', 'duplicate lifecycle marker blocks');
    }
    if (beginAt.length !== endAt.length) {
        return failure('MANAGED_BLOCK_INVALID', 'unpaired lifecycle marker');
    }
    const blockLines = rows.length === 0 ? [] : [LIFECYCLE_BEGIN_MARKER, ...serializeManagedRows(rows), LIFECYCLE_END_MARKER];
    let next;
    if (beginAt.length === 0) {
        const emptyRoot = splitEmptyFlowRoot(body);
        if (emptyRoot !== null) {
            // The official template's comments + `[]`: the first managed rows
            // replace the flow root; collapsing back to zero rows restores it.
            next = rows.length === 0
                ? body
                : [...emptyRoot.comments, ...blockLines];
        }
        else {
            next = rows.length === 0 ? body : [...body, ...blockLines];
        }
    }
    else {
        const begin = beginAt[0];
        const end = endAt[0];
        if (end < begin) {
            return failure('MANAGED_BLOCK_INVALID', 'end marker precedes begin marker');
        }
        // An empty managed set removes the whole block, restoring the file to its
        // unmanaged content; a non-empty set replaces the block inner rows.
        next = rows.length === 0
            ? [...body.slice(0, begin), ...body.slice(end + 1)]
            : [...body.slice(0, begin), ...blockLines, ...body.slice(end + 1)];
    }
    const joined = next.join(style.newline);
    const content = `${style.bom ? '﻿' : ''}${joined}${style.trailingNewline ? style.newline : ''}`;
    /* v8 ignore next -- the editor only composes marker comments and quoted rows;
       a candidate failing here means the source misled validation. */
    if (!isValidPatchListText(content)) {
        return failure('INVALID_PATCH', 'managed block candidate failed patch-list validation');
    }
    return { ok: true, content };
}
/** Line-start offsets of a text, for range→line mapping. */
function lineStarts(text) {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n')
            starts.push(index + 1);
    }
    return starts;
}
/** The start offset of the line containing `offset`. */
function lineStartOf(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset)
            low = mid;
        else
            high = mid - 1;
    }
    return starts[low];
}
/** The start offset of the line AFTER the line containing `offset`. */
function nextLineStartOf(starts, offset, textLength) {
    const start = lineStartOf(starts, offset);
    const index = starts.indexOf(start);
    return index + 1 < starts.length ? starts[index + 1] : textLength;
}
/** Whether a subtree contains an alias node (which shares source ranges). */
function containsAlias(node) {
    let found = false;
    const visit = (value) => {
        if (found)
            return;
        if (isAlias(value)) {
            found = true;
            return;
        }
        if (isMap(value) || isSeq(value)) {
            for (const item of value.items)
                visit(item);
        }
        else if (typeof value === 'object' && value !== null && 'key' in value) {
            const pair = value;
            visit(pair.key);
            visit(pair.value);
        }
    };
    visit(node);
    return found;
}
/**
 * Read the current managed toggle rows from a patch file. Returns null when
 * the marker block is absent (no managed state yet); refuses with an
 * `MANAGED_BLOCK_INVALID` failure when the markers are malformed.
 * @param source - current file text.
 * @returns parsed managed rows, or null when no block exists.
 */
export function readManagedToggleRows(source) {
    const lines = splitLines(source);
    const beginAt = [];
    const endAt = [];
    lines.forEach((line, index) => {
        if (line === LIFECYCLE_BEGIN_MARKER)
            beginAt.push(index);
        if (line === LIFECYCLE_END_MARKER)
            endAt.push(index);
    });
    if (beginAt.length === 0 && endAt.length === 0)
        return null;
    if (beginAt.length !== 1 || endAt.length !== 1 || endAt[0] < beginAt[0]) {
        return failure('MANAGED_BLOCK_INVALID', 'malformed lifecycle marker block');
    }
    const rows = [];
    const rowPattern = /^- id: (.+)$/;
    const valuePattern = /^ {2}disabled: (true|false|null)$/;
    for (let index = beginAt[0] + 1; index < endAt[0]; index++) {
        const line = lines[index];
        if (line.trim().length === 0)
            continue;
        const idMatch = rowPattern.exec(line);
        if (idMatch === null)
            return failure('MANAGED_BLOCK_INVALID', `unrecognized managed row line: ${line}`);
        const entryId = parseYaml(idMatch[1], { schema: entryListSchema });
        const valueLine = lines[index + 1];
        /* v8 ignore next -- the END marker always follows a well-formed managed block, so the row is never the last line. */
        const valueMatch = valueLine === undefined ? null : valuePattern.exec(valueLine);
        if (valueMatch === null)
            return failure('MANAGED_BLOCK_INVALID', `managed row misses its disabled value: ${entryId}`);
        rows.push({ entryId, disabled: valueMatch[1] === 'true' });
        index++;
    }
    return { ok: true, rows };
}
/** Scalar string value of a map key, when present and plain. */
function scalarValue(map, key) {
    const value = map.get(key, true);
    return isScalar(value) && typeof value.value === 'string' ? value.value : null;
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
export function removeManualInsertRows(source, moduleName) {
    if (!isValidPatchListText(source)) {
        return failure('INVALID_PATCH', 'patch file is not a valid top-level loader patch list');
    }
    const document = parseDocument(source, { keepSourceTokens: false });
    /* v8 ignore next -- the validity gate above already uses the same parser dialect; text that passes it cannot error here. */
    if (document.errors.length > 0) {
        return failure('INVALID_PATCH', 'patch file failed to parse for structural editing');
    }
    const top = document.contents;
    if (!isSeq(top)) {
        // Empty or comment-only files carry no sequence: report the entry as not
        // manual-insert-owned so callers keep the patch as-is.
        return failure('UNSUPPORTED_PATCH_SHAPE', `no manual insert row declares ${JSON.stringify(moduleName)}`);
    }
    const matches = [];
    for (const item of top.items) {
        /* v8 ignore next -- the validity gate above rejects non-mapping top-level items before the scan runs. */
        if (!isMap(item))
            continue;
        const insertValue = item.get('insert', true);
        if (!isSeq(insertValue))
            continue;
        for (const entry of insertValue.items) {
            if (!isMap(entry))
                continue;
            if (scalarValue(entry, 'name') === moduleName) {
                matches.push({ entry, insertSeq: insertValue, topItem: item, entryId: scalarValue(entry, 'id') });
            }
        }
    }
    if (matches.length === 0) {
        return failure('UNSUPPORTED_PATCH_SHAPE', `no manual insert row declares ${JSON.stringify(moduleName)}`);
    }
    if (matches.length > 1) {
        return failure('UNSUPPORTED_PATCH_SHAPE', `multiple manual insert rows declare ${JSON.stringify(moduleName)}`);
    }
    const match = matches[0];
    if (containsAlias(match.topItem)) {
        return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert row contains a YAML alias');
    }
    const starts = lineStarts(source);
    // The entry's removal starts at its item dash: walk up from the entry's
    // start line to the nearest line whose first non-space character is '-'.
    const entryRange = match.entry.range;
    /* v8 ignore next -- parsed block maps always carry source ranges. */
    if (entryRange === null || entryRange === undefined) {
        return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert entry carries no source range');
    }
    let entryStartLine = lineStartOf(starts, entryRange[0]);
    while (entryStartLine > 0) {
        const lineEnd = source.indexOf('\n', entryStartLine);
        const line = source.slice(entryStartLine, lineEnd === -1 ? source.length : lineEnd);
        if (/^\s*-/.test(line))
            break;
        entryStartLine = lineStartOf(starts, entryStartLine - 1);
    }
    {
        const lineEnd = source.indexOf('\n', entryStartLine);
        const line = source.slice(entryStartLine, lineEnd === -1 ? source.length : lineEnd);
        /* v8 ignore next -- every block-sequence entry's dash line is reachable by the walk above. */
        if (!/^\s*-/.test(line)) {
            return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert entry has no owning dash line');
        }
    }
    const entryEnd = nextLineStartOf(starts, entryRange[2] - 1, source.length);
    const removeWholeItem = match.insertSeq.items.length === 1;
    let spliceStart;
    let spliceEnd;
    if (removeWholeItem) {
        const topRange = match.topItem.range;
        /* v8 ignore next -- parsed block maps always carry source ranges. */
        if (topRange === null || topRange === undefined) {
            return failure('UNSUPPORTED_PATCH_SHAPE', 'manual insert item carries no source range');
        }
        spliceStart = lineStartOf(starts, topRange[0]);
        /* v8 ignore next -- a non-empty insert map always spans both range offsets; the empty-node arm is defensive only. */
        spliceEnd = nextLineStartOf(starts, topRange[2] === topRange[1] ? topRange[2] : topRange[2] - 1, source.length);
    }
    else {
        spliceStart = entryStartLine;
        spliceEnd = entryEnd;
    }
    const content = source.slice(0, spliceStart) + source.slice(spliceEnd);
    if (!isValidPatchListText(content)) {
        return failure('INVALID_PATCH', 'insert-removal candidate failed patch-list validation');
    }
    const reparsed = parseDocument(content);
    let stillPresent = false;
    if (isSeq(reparsed.contents)) {
        for (const item of reparseItems(reparsed.contents)) {
            if (scalarValue(item, 'name') === moduleName || scalarValue(item, 'id') === moduleName)
                stillPresent = true;
            const insertValue = item.get('insert', true);
            if (isSeq(insertValue)) {
                for (const entry of insertValue.items) {
                    /* v8 ignore next -- duplicate insert names are refused by the ambiguity check before any splice runs. */
                    if (isMap(entry) && scalarValue(entry, 'name') === moduleName)
                        stillPresent = true;
                }
            }
        }
    }
    if (stillPresent) {
        return failure('UNSUPPORTED_PATCH_SHAPE', 'candidate still contains the removed module');
    }
    return { ok: true, content, removedEntryIds: match.entryId === null ? [] : [match.entryId] };
}
/** Iterate YAMLMap items of a sequence, ignoring non-map entries. */
function* reparseItems(seq) {
    for (const item of seq.items) {
        /* v8 ignore next -- the validity gate rejects non-mapping top-level items before the reparse runs. */
        if (isMap(item))
            yield item;
    }
}
//# sourceMappingURL=patch-editor.js.map