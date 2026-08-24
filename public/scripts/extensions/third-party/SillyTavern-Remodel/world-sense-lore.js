import { getContext } from '../../../st-context.js';
import { getTimelineStore } from './timeline-state.js';

const cache = new Map();
let listening = false;

const NATIVE_FIELDS = Object.freeze([
    'constant', 'vectorized', 'selective', 'selectiveLogic', 'order', 'position', 'disable', 'ignoreBudget',
    'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'probability', 'useProbability', 'depth',
    'outletName', 'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords',
    'useGroupScoring', 'automationId', 'role', 'sticky', 'cooldown', 'delay', 'triggers',
]);

/**
 * Read the one lorebook assigned to a Timeline. The returned packet is detached
 * from native World Info data and this module exposes no save operation.
 */
export async function loadTimelineLore(timelineId = '') {
    ensureInvalidation();
    const store = getTimelineStore();
    const id = String(timelineId || store.activeTimelineId || '').trim();
    const timeline = store.timelines[id];
    const book = String(timeline?.lorebookName ?? '').trim();
    if (!timeline || !book) return { timelineId: id, book: null, entries: [], hash: hashText('') };

    if (!cache.has(book)) cache.set(book, await loadBook(book));
    return { timelineId: id, ...structuredClone(cache.get(book)) };
}

export async function listTimelineLoreEntries(timelineId = '') {
    return (await loadTimelineLore(timelineId)).entries;
}

export function invalidateTimelineLoreCache(book = '') {
    const name = String(book ?? '').trim();
    if (name) cache.delete(name);
    else cache.clear();
}

export function normalizeTimelineLoreEntry(book, raw) {
    if (!raw || raw.uid === undefined || raw.uid === null) return null;
    const entry = {
        book: String(book),
        uid: String(raw.uid),
        name: entryName(raw),
        keys: strings(raw.key),
        secondaryKeys: strings(raw.keysecondary),
        content: String(raw.content ?? ''),
        native: Object.fromEntries(NATIVE_FIELDS.map((field) => [field, normalizeNativeValue(raw[field])])),
    };
    return { ...entry, hash: hashText(JSON.stringify(entry)) };
}

async function loadBook(book) {
    const context = getContext();
    if (typeof context.loadWorldInfo !== 'function') return { book, entries: [], hash: hashText('') };
    const data = await context.loadWorldInfo(book);
    const entries = Object.values(data?.entries || {})
        .map((raw) => normalizeTimelineLoreEntry(book, raw))
        .filter(Boolean)
        .sort(compareEntries);
    return { book, entries, hash: hashText(entries.map((entry) => entry.hash).join('|')) };
}

function ensureInvalidation() {
    if (listening) return;
    try {
        const context = getContext();
        const invalidateBook = (book) => invalidateTimelineLoreCache(typeof book === 'string' ? book : '');
        context.eventSource.on(context.eventTypes.WORLDINFO_UPDATED, invalidateBook);
        context.eventSource.on(context.eventTypes.WORLDINFO_ENTRIES_LOADED, () => invalidateTimelineLoreCache());
        context.eventSource.on(context.eventTypes.WORLDINFO_SETTINGS_UPDATED, () => invalidateTimelineLoreCache());
        listening = true;
    } catch {
        // Loading remains correct without an event source; it simply stays uncached.
        cache.clear();
    }
}

function entryName(raw) {
    return String(raw.comment ?? '').trim() || strings(raw.key)[0] || `Entry ${raw.uid}`;
}

function strings(value) {
    return (Array.isArray(value) ? value : []).map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizeNativeValue(value) {
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (value === undefined) return null;
    return value;
}

function compareEntries(left, right) {
    const leftNumber = Number(left.uid);
    const rightNumber = Number(right.uid);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left.uid.localeCompare(right.uid);
}

/** Stable non-cryptographic content fingerprint for cache and revision checks. */
export function hashText(value) {
    let hash = 0xcbf29ce484222325n;
    for (const character of String(value ?? '')) {
        hash ^= BigInt(character.codePointAt(0));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}
