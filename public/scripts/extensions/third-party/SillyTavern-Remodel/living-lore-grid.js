// Pure: turn a Scene's Living Lore entries into a diamond keyword grid.
//
// Slots hold KEYWORDS (the entries' primary tags), deduped case-insensitively
// and sorted alphabetically, then laid into the lattice in down-left diagonal
// order (top-left first, top-to-bottom within a diagonal). Selecting a set of
// keywords resolves to the entry whose keyword set contains them all — the exact
// set match wins, else the entry with the fewest extra keywords.
//
// Each slot also carries a `kind`, so the UI can colour reserved keywords and
// hide secret ones from the Scene view:
//   'goal' / 'variable' — the reserved markers a former Goal/Variable carries.
//   'secret'            — every entry that uses the keyword is secret (Loom-only).
//   'normal'            — an ordinary keyword.
// No DOM, no store, deterministic.

import { GOAL_KEYWORD, VARIABLE_KEYWORD } from './living-lore-secret.js';

const GRID = { r: 42, dx: 104, dy: 62, pad: 52, rows: 5 };
const EXTRA = [{ row: 1, col: -1 }, { row: 3, col: -1 }]; // fill the left notch

function norm(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

/** Unique primary keywords across the entries, first casing kept, A→Z. */
export function collectKeywords(entries) {
    const seen = new Map(); // norm -> display
    for (const entry of Array.isArray(entries) ? entries : []) {
        for (const tag of Array.isArray(entry?.tags) ? entry.tags : []) {
            const display = String(tag ?? '').trim();
            const key = norm(display);
            if (key && !seen.has(key)) seen.set(key, display);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** How a keyword slot should read: reserved marker, secret-only, or normal. */
export function keywordKind(keyword, entries) {
    const key = norm(keyword);
    if (key === norm(GOAL_KEYWORD)) return 'goal';
    if (key === norm(VARIABLE_KEYWORD)) return 'variable';
    const withKeyword = (Array.isArray(entries) ? entries : [])
        .filter((entry) => (entry?.tags || []).some((tag) => norm(tag) === key));
    if (withKeyword.length && withKeyword.every((entry) => entry?.secret)) return 'secret';
    return 'normal';
}

/**
 * @returns {{
 *   slots: {i:number, cx:number, cy:number, r:number, keyword:string, kind:string}[],
 *   keywords: string[],
 *   viewBox: {x:number, y:number, w:number, h:number},
 * }}
 */
export function buildKeywordGrid(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const keywords = collectKeywords(list);
    const kindOf = new Map(keywords.map((kw) => [kw, keywordKind(kw, list)]));
    const { r, dx, dy, pad, rows } = GRID;
    const offset = dx / 2;
    const cols = Math.max(5, Math.ceil(keywords.length / 4)); // grow sideways to fit
    const cellAt = (row, col) => ({ cx: pad + col * dx + (row % 2) * offset, cy: pad + row * dy });

    const raw = [];
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) raw.push(cellAt(row, col));
    }
    for (const spot of EXTRA) raw.push(cellAt(spot.row, spot.col));

    // Down-left diagonals share (cx/offset + cy/dy); smaller = up-left, so this
    // sweeps top-left first, top-to-bottom within each diagonal.
    const diagonal = (s) => s.cx / offset + s.cy / dy;
    raw.slice()
        .sort((a, b) => diagonal(a) - diagonal(b) || a.cy - b.cy || a.cx - b.cx)
        .forEach((slot, k) => { slot.keyword = keywords[k] || ''; });

    const slots = raw.map((s, i) => ({
        i,
        cx: s.cx,
        cy: s.cy,
        r,
        keyword: s.keyword || '',
        kind: s.keyword ? kindOf.get(s.keyword) : '',
    }));
    const m = 12;
    const xs = slots.map((s) => s.cx);
    const ys = slots.map((s) => s.cy);
    const minX = Math.min(...xs) - r - m;
    const minY = Math.min(...ys) - r - m;
    return {
        slots,
        keywords,
        viewBox: { x: minX, y: minY, w: (Math.max(...xs) + r + m) - minX, h: (Math.max(...ys) + r + m) - minY },
    };
}

/**
 * The entry a selected keyword set calls, or null. With `includeSecret: false`
 * secret entries are excluded from resolution (the Scene view can't reveal them).
 */
export function resolveEntryForKeywords(entries, selectedKeywords, { includeSecret = true } = {}) {
    const selection = (Array.isArray(selectedKeywords) ? selectedKeywords : []).map(norm).filter(Boolean);
    if (!selection.length) return null;
    const want = new Set(selection);
    let best = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!includeSecret && entry?.secret) continue;
        const tags = new Set((entry?.tags || []).map(norm));
        let containsAll = true;
        for (const key of want) {
            if (!tags.has(key)) { containsAll = false; break; }
        }
        if (!containsAll) continue;
        const extra = tags.size - want.size; // 0 == exact set match
        if (!best || extra < best.extra) best = { entry, extra };
        if (extra === 0) break;
    }
    return best ? best.entry : null;
}
