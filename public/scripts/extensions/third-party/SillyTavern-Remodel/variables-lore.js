import { getContext } from '../../../st-context.js';
import { entryKey, sameEntry } from './variables-lore-key.js';
import { markLoreLinkedTimelinesDirty } from './variables-store.js';

// Read access to lorebook entries, for the Variables layer.
//
// A value's identity in this system is the entry it is attached to, so entries
// are enumerated rather than searched: attaching needs to list them, and the
// relevance sweep needs their keywords to score against.
//
// Entry identity itself lives in `variables-lore-key.js`, which imports nothing
// — this module reaches native World Info through `st-context.js`, and the pure
// layers must be able to hash an entry without dragging that in. Re-exported
// here so callers that already need lore reading have one import.
//
// Read-only by design. Remodel stores the link metadata on its own side and
// never edits native World Info.

export { entryKey, sameEntry };

/**
 * Loading every book parses JSON per book, and both the sweep and the tab ask
 * for the same list repeatedly within one render. Cached until World Info says
 * it changed.
 */
let cache = null;
let listening = false;

function ensureInvalidation() {
    if (listening) return;
    listening = true;
    try {
        const context = getContext();
        // Clearing our own cache is not enough: a linked entry's prose is part of
        // the embedded document, so an edit also invalidates the vector index.
        const invalidate = () => {
            cache = null;
            try {
                markLoreLinkedTimelinesDirty('lore-entry-changed');
            } catch {
                // A reindex we failed to schedule must not break World Info.
            }
        };
        context.eventSource.on(context.eventTypes.WORLDINFO_UPDATED, invalidate);
        context.eventSource.on(context.eventTypes.WORLDINFO_ENTRIES_LOADED, invalidate);
        context.eventSource.on(context.eventTypes.WORLDINFO_SETTINGS_UPDATED, invalidate);
    } catch {
        // No event source yet: the cache simply stays cold, which is correct.
        listening = false;
    }
}

export function invalidateLoreCache() {
    cache = null;
}

/**
 * Every entry across every book the user has, flattened.
 *
 * `disabled` entries are returned rather than filtered, because the Variables
 * tab must still show an attachment whose entry has been switched off — a value
 * silently detaching itself because someone toggled a lorebook entry would be
 * worse than showing it as inactive. The sweep is what skips them.
 *
 * @returns {Promise<Array<{book: string, uid: string, name: string, keys: string[],
 *   secondaryKeys: string[], disabled: boolean, constant: boolean,
 *   caseSensitive: boolean, matchWholeWords: boolean, content: string}>>}
 */
export async function listLoreEntries() {
    ensureInvalidation();
    if (cache) return cache;
    const context = getContext();
    const names = typeof context.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
    const entries = [];
    for (const book of names) {
        let data = null;
        try {
            // eslint-disable-next-line no-await-in-loop
            data = await context.loadWorldInfo(book);
        } catch {
            // A book that fails to load must not take the others with it.
            continue;
        }
        for (const raw of Object.values(data?.entries || {})) {
            if (!raw || raw.uid === undefined || raw.uid === null) continue;
            entries.push(normalizeEntry(book, raw));
        }
    }
    cache = entries;
    return entries;
}

/** One entry, or null when the book or uid no longer exists. */
export async function getLoreEntry(ref) {
    const key = entryKey(ref);
    if (!key) return null;
    const entries = await listLoreEntries();
    return entries.find((entry) => entryKey(entry) === key) || null;
}

/** Grouped for a picker: `[{ book, entries: [...] }]`, books in name order. */
export async function listLoreBooks() {
    const entries = await listLoreEntries();
    const books = new Map();
    for (const entry of entries) {
        if (!books.has(entry.book)) books.set(entry.book, []);
        books.get(entry.book).push(entry);
    }
    return [...books.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([book, items]) => ({ book, entries: items }));
}

/**
 * A display name for an entry.
 *
 * `comment` is the memo the user titles an entry with and is what they will
 * recognise. Entries without one fall back to their first keyword, then to the
 * uid, so a picker never renders a blank row.
 */
export function entryName(raw) {
    const comment = String(raw?.comment ?? '').trim();
    if (comment) return comment;
    const firstKey = (Array.isArray(raw?.key) ? raw.key : []).map((item) => String(item ?? '').trim()).find(Boolean);
    return firstKey || `Entry ${raw?.uid ?? '?'}`;
}

function normalizeEntry(book, raw) {
    const strings = (value) => (Array.isArray(value) ? value : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean);
    return {
        book: String(book),
        uid: String(raw.uid),
        name: entryName(raw),
        keys: strings(raw.key),
        secondaryKeys: strings(raw.keysecondary),
        // Native flags the sweep honours, so scoring matches how the user
        // configured the entry rather than imposing its own matching rules.
        disabled: Boolean(raw.disable),
        constant: Boolean(raw.constant),
        caseSensitive: Boolean(raw.caseSensitive),
        matchWholeWords: Boolean(raw.matchWholeWords),
        content: String(raw.content ?? ''),
    };
}
