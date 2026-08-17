export const DIRECTION_MARKER_PREFIX = '[[RM:';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

/**
 * Reads one visible character or one invisible Remodel direction marker.
 * A partial marker is deliberately withheld until the rest of the stream
 * arrives, so users never see protocol fragments flicker through the prose.
 */
export function readDirectionUnit(source, offset = 0, { final = false } = {}) {
    const text = String(source ?? '');
    const cursor = Math.max(0, Math.min(text.length, Number(offset) || 0));
    if (cursor >= text.length) return { kind: 'end', nextOffset: cursor };

    if (!text.startsWith(DIRECTION_MARKER_PREFIX, cursor)) {
        return { kind: 'text', value: text[cursor], nextOffset: cursor + 1 };
    }

    const close = text.indexOf(']]', cursor + DIRECTION_MARKER_PREFIX.length);
    if (close < 0) {
        return final
            ? { kind: 'unknown', nextOffset: text.length }
            : { kind: 'partial', nextOffset: cursor };
    }

    const body = text.slice(cursor + DIRECTION_MARKER_PREFIX.length, close).trim();
    const nextOffset = close + 2;
    if (body === 'BREATH') return { kind: 'breath', nextOffset };
    if (body === 'HARD_PAUSE') return { kind: 'hard-pause', nextOffset };

    const separator = body.indexOf(':');
    const type = separator < 0 ? body : body.slice(0, separator);
    const id = separator < 0 ? '' : body.slice(separator + 1).trim();
    if (type === 'OPENING' && ID_PATTERN.test(id)) return { kind: 'opening', id, nextOffset };
    if (type === 'COMMIT' && ID_PATTERN.test(id)) return { kind: 'commit', id, nextOffset };
    return { kind: 'unknown', nextOffset };
}

/**
 * Strip the scaffolding a performer echoed back instead of speaking.
 *
 * Models trained on roleplay transcripts reproduce the furniture around a
 * reply as if it were part of one. The owner's log caught this verbatim:
 *
 *   [IMPORTANT: This reply must constitute the entirety of The Narrato II's
 *   response to the user.]The Narrator II: The page flipped.
 *
 * Neither of those came from us — the phrase appears nowhere in the request
 * body we sent and nowhere in SillyTavern's source, and it arrived through
 * `stream_token_received`, so the model wrote it. Core would have removed the
 * `{{char}}:` half in `cleanUpMessage`, but Live Direction owns its own buffer
 * and writes the accepted text itself, so it never passed through that.
 *
 * DELIBERATELY CONSERVATIVE, because this edits the user's fiction:
 *
 * - Only at the very START of a reply. A bracket mid-prose is prose.
 * - A bracketed span is removed only while what FOLLOWS it is more scaffolding
 *   — another bracket, or the speaker's own name. A reply that simply opens on
 *   a bracketed aside and then continues into narration keeps it, because
 *   nothing there says it was scaffolding rather than style.
 * - The name prefix is matched against the performer's actual label, not a
 *   generic `Word:` pattern, which would eat "Teo:" opening a line of dialogue.
 *
 * @param {string} source
 * @param {string} performerLabel the label this reply was generated as.
 */
export function stripEchoedScaffolding(source, performerLabel = '') {
    let text = String(source ?? '');
    const label = String(performerLabel || '').trim();
    const prefix = label ? new RegExp(`^\\s*${escapeForRegExp(label)}\\s*:\\s*`, 'i') : null;

    // Bounded rather than `while (true)`: a reply that is nothing but nested
    // brackets should come out empty-ish, not spin.
    for (let pass = 0; pass < 4; pass++) {
        const leading = text.match(/^\s*\[[^\]]{0,400}\]\s*/);
        if (!leading) break;
        const rest = text.slice(leading[0].length);
        // The test for "this was scaffolding": something scaffolding-shaped
        // follows it. Otherwise it is the author's own opening line.
        if (!/^\s*\[/.test(rest) && !(prefix && prefix.test(rest))) break;
        text = rest;
    }
    if (prefix) text = text.replace(prefix, '');
    return text;
}

function escapeForRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove all complete, partial, known, and unknown Remodel markers. */
export function sanitizeDirectionText(source) {
    const text = String(source ?? '');
    let cursor = 0;
    let output = '';
    while (cursor < text.length) {
        const unit = readDirectionUnit(text, cursor, { final: true });
        if (unit.kind === 'text') output += unit.value;
        cursor = unit.nextOffset > cursor ? unit.nextOffset : cursor + 1;
    }
    return output;
}

/** Fixture-friendly full parse used by previews, recovery, and diagnostics. */
export function parseDirectionText(source, { final = false } = {}) {
    const text = String(source ?? '');
    const markers = [];
    let cursor = 0;
    let visible = '';
    while (cursor < text.length) {
        const unit = readDirectionUnit(text, cursor, { final });
        if (unit.kind === 'partial') return { visibleText: visible, markers, trailingPartial: true, consumed: cursor };
        if (unit.kind === 'text') visible += unit.value;
        else if (unit.kind !== 'unknown' && unit.kind !== 'end') markers.push({ ...unit, visibleOffset: visible.length });
        cursor = unit.nextOffset > cursor ? unit.nextOffset : cursor + 1;
    }
    return { visibleText: visible, markers, trailingPartial: false, consumed: cursor };
}
