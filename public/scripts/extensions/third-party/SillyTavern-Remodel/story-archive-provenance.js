const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;
export const STORY_ARCHIVE_PASSAGE_MAX_CHARS = 6000;

/** Keep capture boundaries attached to the prose they originally covered. */
export function rebaseStoryArchiveProvenance(captures, previousBody, nextBody) {
    const before = String(previousBody || '');
    const after = String(nextBody || '');
    if (before === after) return captures;
    const diffs = diffText(before, after);

    for (const capture of captures || []) {
        if (!capture || capture.status === 'superseded') continue;
        const oldStart = clampOffset(capture.start, before.length);
        const oldEnd = Math.max(oldStart, clampOffset(capture.end, before.length));
        // Start binds to the prose on its right; end binds to the prose on its
        // left. An insertion exactly beside a capture therefore becomes its
        // own uncaptured span instead of silently changing the capture's author.
        const start = mapOffset(diffs, oldStart, 'right');
        const end = Math.max(start, mapOffset(diffs, oldEnd, 'left'));
        const currentText = after.slice(start, end);
        capture.start = start;
        capture.end = end;
        capture.sourceStatus = currentText === capture.text ? 'current' : 'changed';
        capture.currentText = capture.sourceStatus === 'changed' ? currentText : '';
    }
    return captures;
}

function diffText(before, after) {
    const DiffEngine = globalThis.diff_match_patch;
    if (typeof DiffEngine === 'function') {
        const dmp = new DiffEngine();
        dmp.Diff_Timeout = 0.25;
        const diffs = dmp.diff_main(before, after);
        dmp.diff_cleanupSemantic(diffs);
        return diffs;
    }

    // Tests, recovery pages, and unusual extension load orders may not have
    // SillyTavern's global library shim. Preserve the exact common edges and
    // conservatively treat the middle as one replacement. It can mark more of
    // a capture as edited, but can never attribute new text to the wrong author.
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
    const diffs = [];
    if (prefix) diffs.push([DIFF_EQUAL, before.slice(0, prefix)]);
    const removed = before.slice(prefix, before.length - suffix);
    const inserted = after.slice(prefix, after.length - suffix);
    if (removed) diffs.push([DIFF_DELETE, removed]);
    if (inserted) diffs.push([DIFF_INSERT, inserted]);
    if (suffix) diffs.push([DIFF_EQUAL, before.slice(before.length - suffix)]);
    return diffs;
}

/** Exact additions/edits/deletions not yet represented by active captures. */
export function buildStoryArchiveCatchUpPreview(doc) {
    const body = String(doc?.body || '');
    const captures = (doc?.archiveCaptures || [])
        .filter((capture) => capture?.status !== 'superseded' && capture?.changeType !== 'deletion')
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const changes = [];

    for (const capture of captures) {
        if (capture.sourceStatus !== 'changed') continue;
        const afterText = body.slice(capture.start, capture.end);
        changes.push({
            id: `change:${capture.id}`,
            type: afterText ? 'edit' : 'deletion',
            start: capture.start,
            end: capture.end,
            beforeText: capture.text,
            afterText,
            supersedesCaptureIds: [capture.id],
            origin: 'user',
        });
    }

    const coverage = mergeRanges(captures.map((capture) => ({ start: capture.start, end: capture.end })), body.length);
    let cursor = 0;
    for (const range of [...coverage, { start: body.length, end: body.length }]) {
        appendAddition(changes, body, cursor, range.start);
        cursor = Math.max(cursor, range.end);
    }

    changes.sort((left, right) => left.start - right.start || changeOrder(left.type) - changeOrder(right.type));
    const token = hashText(JSON.stringify({
        body,
        revision: Number(doc?.bodyRevision) || 0,
        sources: captures.map((capture) => [capture.id, capture.start, capture.end, capture.text, capture.status, capture.sourceStatus]),
    }));
    const retryCaptureIds = (doc?.archiveCaptures || [])
        .filter((capture) => capture?.status === 'failed' && capture.attempts < 3)
        .map((capture) => capture.id);
    return {
        token,
        bodyRevision: Number(doc?.bodyRevision) || 0,
        changes,
        retryCaptureIds,
        counts: {
            additions: changes.filter((change) => change.type === 'addition').length,
            edits: changes.filter((change) => change.type === 'edit').length,
            deletions: changes.filter((change) => change.type === 'deletion').length,
            retries: retryCaptureIds.length,
        },
    };
}

/** Split one exact addition into model-sized passages without changing order. */
export function splitStoryArchiveAddition(change, maximum = STORY_ARCHIVE_PASSAGE_MAX_CHARS) {
    const text = String(change?.afterText || '');
    const limit = Math.max(1000, Math.floor(Number(maximum) || STORY_ARCHIVE_PASSAGE_MAX_CHARS));
    if (change?.type !== 'addition' || text.length <= limit) return [{ ...change }];
    const chunks = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(text.length, cursor + limit);
        if (end < text.length) end = findPassageBoundary(text, cursor, end, limit);
        const source = text.slice(cursor, end);
        const leading = source.match(/^\s*/)?.[0].length || 0;
        const trailing = source.match(/\s*$/)?.[0].length || 0;
        const localStart = cursor + leading;
        const localEnd = Math.max(localStart, end - trailing);
        if (localEnd > localStart) {
            const afterText = text.slice(localStart, localEnd);
            chunks.push({
                ...change,
                id: `${change.id}:part:${chunks.length + 1}`,
                start: change.start + localStart,
                end: change.start + localEnd,
                afterText,
                part: chunks.length + 1,
            });
        }
        cursor = Math.max(end, cursor + 1);
    }
    const totalParts = chunks.length;
    return chunks.map((chunk) => ({ ...chunk, totalParts }));
}

function findPassageBoundary(text, start, idealEnd, limit) {
    const floor = start + Math.floor(limit * 0.55);
    const paragraph = text.lastIndexOf('\n\n', idealEnd);
    if (paragraph >= floor) return paragraph + 2;
    const sentence = Math.max(text.lastIndexOf('. ', idealEnd), text.lastIndexOf('! ', idealEnd), text.lastIndexOf('? ', idealEnd));
    if (sentence >= floor) return sentence + 2;
    const whitespace = Math.max(text.lastIndexOf(' ', idealEnd), text.lastIndexOf('\n', idealEnd));
    return whitespace >= floor ? whitespace + 1 : idealEnd;
}

function appendAddition(changes, body, start, end) {
    if (end <= start) return;
    const source = body.slice(start, end);
    const leading = source.match(/^\s*/)?.[0].length || 0;
    const trailing = source.match(/\s*$/)?.[0].length || 0;
    const trimmedStart = start + leading;
    const trimmedEnd = Math.max(trimmedStart, end - trailing);
    const text = body.slice(trimmedStart, trimmedEnd);
    if (!text) return;
    changes.push({
        id: `addition:${trimmedStart}:${trimmedEnd}:${hashText(text)}`,
        type: 'addition',
        start: trimmedStart,
        end: trimmedEnd,
        beforeText: '',
        afterText: text,
        supersedesCaptureIds: [],
        origin: 'user',
    });
}

function mergeRanges(ranges, maximum) {
    const sorted = ranges
        .map((range) => ({ start: clampOffset(range.start, maximum), end: clampOffset(range.end, maximum) }))
        .filter((range) => range.end > range.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const range of sorted) {
        const prior = merged.at(-1);
        if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

function mapOffset(diffs, offset, affinity) {
    let oldPosition = 0;
    let newPosition = 0;
    for (const [operation, text] of diffs) {
        const length = text.length;
        if (operation === DIFF_INSERT) {
            if (oldPosition < offset || (oldPosition === offset && affinity === 'right')) newPosition += length;
            continue;
        }
        if (operation === DIFF_DELETE) {
            if (offset <= oldPosition + length) return newPosition;
            oldPosition += length;
            continue;
        }
        if (operation === DIFF_EQUAL) {
            if (offset < oldPosition + length) return newPosition + (offset - oldPosition);
            if (offset === oldPosition + length && affinity === 'left') return newPosition + length;
            oldPosition += length;
            newPosition += length;
        }
    }
    return newPosition;
}

function changeOrder(type) {
    return type === 'deletion' ? 0 : type === 'edit' ? 1 : 2;
}

function clampOffset(value, maximum) {
    return Math.max(0, Math.min(maximum, Math.floor(Number(value) || 0)));
}

export function hashStoryArchiveText(value) {
    return hashText(value);
}

function hashText(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
