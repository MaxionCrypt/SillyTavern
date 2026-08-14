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
