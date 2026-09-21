// Pure: turn a Scene's Living Lore entries into a diamond keyword grid.
//
// A slot is a KEYWORD, with a role and a kind:
//   role  'primary'   — one of the entry's `keys` (OR: any one can trigger it).
//         'secondary' — one of its `secondaryKeys` (AND: must also be present).
//   kind  'secret'/'goal'/'variable' — the reserved identifying markers; a secret
//         entry is keyed `secret` + its real keywords, so the grid shows one
//         `secret` slot rather than tinting the topic keywords. Else 'normal'.
//
// Keywords are deduped case-insensitively, sorted A→Z, and laid into the lattice
// in down-left diagonal order (top-left first). Resolving a selection to an entry
// follows the trigger rule: at least one of the entry's primary keys is selected,
// AND all of its secondary keys are selected, and the selection is a subset of the
// entry's keys. Ties break to the more-constrained entry (more secondary keys),
// which tells an "A or B" entry apart from an "A and B" one. No DOM, no store.

import { SECRET_KEYWORD, GOAL_KEYWORD, VARIABLE_KEYWORD } from './living-lore-secret.js';

const GRID = { r: 42, dx: 104, dy: 62, pad: 52, rows: 5 };
const EXTRA = [{ row: 1, col: -1 }, { row: 3, col: -1 }]; // fill the left notch

function norm(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

// The data layer strips the reserved `secret` key into an `entry.secret` flag, so
// we re-add it here — a secret entry's primary keys are `secret` + its topic keys.
function primaryKeys(entry) {
    const keys = (Array.isArray(entry?.tags) ? entry.tags : []).map((k) => String(k));
    return entry?.secret ? [...keys, SECRET_KEYWORD] : keys;
}

function secondaryKeys(entry) {
    return (Array.isArray(entry?.secondaryTags) ? entry.secondaryTags : []).map((k) => String(k));
}

/** How a keyword slot reads, from the literal keyword. */
export function keywordKind(keyword) {
    const key = norm(keyword);
    if (key === norm(SECRET_KEYWORD)) return 'secret';
    if (key === norm(GOAL_KEYWORD)) return 'goal';
    if (key === norm(VARIABLE_KEYWORD)) return 'variable';
    return 'normal';
}

/**
 * Unique keywords across the entries as {keyword, role, kind}, A→Z. A keyword
 * used as a primary key anywhere is 'primary'; one used only as a secondary key
 * is 'secondary'.
 */
export function collectKeywords(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const display = new Map(); // norm -> display
    const primary = new Set();
    const secondary = new Set();
    const remember = (raw, set) => {
        const text = String(raw ?? '').trim();
        const key = norm(text);
        if (!key) return;
        if (!display.has(key)) display.set(key, text);
        set.add(key);
    };
    for (const entry of list) {
        for (const k of primaryKeys(entry)) remember(k, primary);
        for (const k of secondaryKeys(entry)) remember(k, secondary);
    }
    return [...display.entries()]
        .map(([key, text]) => ({ keyword: text, role: primary.has(key) ? 'primary' : 'secondary', kind: keywordKind(text) }))
        .sort((a, b) => a.keyword.localeCompare(b.keyword, undefined, { sensitivity: 'base' }));
}

/**
 * @param {object[]} entries
 * @param {{hideSecret?: boolean}} [options] hideSecret drops secret entries from
 *   the grid (their unique topic keywords vanish) but keeps a single `secret`
 *   marker slot to signal they exist.
 * @returns {{
 *   slots: {i:number, cx:number, cy:number, r:number, keyword:string, role:string, kind:string}[],
 *   keywords: {keyword:string, role:string, kind:string}[],
 *   viewBox: {x:number, y:number, w:number, h:number},
 * }}
 */
export function buildKeywordGrid(entries, { hideSecret = false } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const visible = hideSecret ? list.filter((entry) => !entry?.secret) : list;
    const keywords = collectKeywords(visible);
    if (list.some((entry) => entry?.secret) && !keywords.some((k) => norm(k.keyword) === norm(SECRET_KEYWORD))) {
        keywords.push({ keyword: SECRET_KEYWORD, role: 'primary', kind: 'secret' });
        keywords.sort((a, b) => a.keyword.localeCompare(b.keyword, undefined, { sensitivity: 'base' }));
    }

    const { r, dx, dy, pad, rows } = GRID;
    const offset = dx / 2;
    const cols = Math.max(5, Math.ceil(keywords.length / 4)); // grow sideways to fit
    const cellAt = (row, col) => ({ cx: pad + col * dx + (row % 2) * offset, cy: pad + row * dy });

    const raw = [];
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) raw.push(cellAt(row, col));
    }
    for (const spot of EXTRA) raw.push(cellAt(spot.row, spot.col));

    // Down-left diagonals share (cx/offset + cy/dy); smaller = up-left.
    const diagonal = (s) => s.cx / offset + s.cy / dy;
    raw.slice()
        .sort((a, b) => diagonal(a) - diagonal(b) || a.cy - b.cy || a.cx - b.cx)
        .forEach((slot, k) => {
            const kw = keywords[k];
            slot.keyword = kw ? kw.keyword : '';
            slot.role = kw ? kw.role : '';
            slot.kind = kw ? kw.kind : '';
        });

    const slots = raw.map((s, i) => ({
        i, cx: s.cx, cy: s.cy, r, keyword: s.keyword || '', role: s.role || '', kind: s.kind || '',
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
 * The entry a selected keyword set calls, or null. Trigger rule: ≥1 primary key
 * selected AND every secondary key selected, with the selection a subset of the
 * entry's keys. The more-constrained match wins (more secondary keys), then the
 * one with fewer keys. `includeSecret: false` hides secret entries from resolution.
 */
export function resolveEntryForKeywords(entries, selectedKeywords, { includeSecret = true } = {}) {
    const sel = new Set((Array.isArray(selectedKeywords) ? selectedKeywords : []).map(norm).filter(Boolean));
    if (!sel.size) return null;
    let best = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!includeSecret && entry?.secret) continue;
        const primary = primaryKeys(entry).map(norm);
        const secondary = secondaryKeys(entry).map(norm);
        const allKeys = new Set([...primary, ...secondary]);
        if (![...sel].every((k) => allKeys.has(k))) continue;   // selection ⊆ entry keys
        if (!primary.some((k) => sel.has(k))) continue;          // ≥1 primary (OR)
        if (!secondary.every((k) => sel.has(k))) continue;       // all secondary (AND)
        const score = secondary.length * 1000 - allKeys.size;    // constrained, then tight
        if (!best || score > best.score) best = { entry, score };
    }
    return best ? best.entry : null;
}
