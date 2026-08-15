// Addressing Goals and Variables by the names their author gave them.
//
// The previous scheme handed the model opaque refs (v1, g2) and mapped them
// back. The security property was never the opacity — it was that the model can
// only touch what this turn advertised. That property is preserved here: a name
// resolves only if it is in the book built for this turn.
//
// A name that appears twice is refused rather than guessed at, because silently
// writing to the wrong record is worse than failing the request.
//
// PURE — no context, no DOM.

/**
 * @param {Array<{id: string, name: string}>} items
 * @returns {{entries: Array<{name: string, id: string}>, duplicates: string[]}}
 */
export function buildAddressBook(items = []) {
    const counts = new Map();
    for (const item of items) {
        const key = normalize(item?.name);
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const duplicates = [];
    const entries = [];
    for (const item of items) {
        const key = normalize(item?.name);
        if (!key || !item?.id) continue;
        if (counts.get(key) > 1) {
            if (!duplicates.includes(item.name)) duplicates.push(item.name);
            continue;
        }
        entries.push({ name: String(item.name), id: String(item.id) });
    }
    return { entries, duplicates };
}

/**
 * @returns {{ok: true, id: string} | {ok: false, reason: string}}
 */
export function resolveByName(book, name) {
    const key = normalize(name);
    if (!key) return { ok: false, reason: 'No name was given.' };
    const match = (book?.entries || []).find((entry) => normalize(entry.name) === key);
    if (match) return { ok: true, id: match.id };
    const duplicated = (book?.duplicates || []).some((item) => normalize(item) === key);
    if (duplicated) return { ok: false, reason: `"${name}" names more than one record in this Timeline; rename one of them.` };
    return { ok: false, reason: `"${name}" was not advertised for this request.` };
}

function normalize(value) {
    return String(value ?? '').trim().toLowerCase();
}
