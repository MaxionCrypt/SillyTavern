import { getContext } from '../../../st-context.js';

// The one thing shared-state retrieval persists: which item ids were retrieved
// on which recent turn, per Timeline, as a ring buffer.
//
// Every other retrieval channel is derived at retrieval time from data that
// already exists — the action, the history, activated lore, the vector index,
// the Loom's notebook, the stores — so there is no weight store to keep in
// sync and nothing here that can go stale against them. This buffer exists
// because "how often has this been pulled lately" is the one signal with no
// other source.
//
// It is WINDOWED, and that is the design, not a size limit. A running total
// would make whatever surfaced first keep surfacing and the retrieved set would
// ossify around it; a window decays by construction. Stop pulling something and
// its weight is gone.
//
// Goal ids and Variable ids live in the same buffer on purpose. They compete in
// one ranking under one budget, so "retrieved lately" has to mean the same
// thing for both, and a buffer per store would have been two answers to one
// question.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'retrievalRecallV1';
const STORE_VERSION = 1;

/**
 * The buffer keeps more turns than any window reads.
 *
 * The window is owner-settable, so storing exactly one window's worth would
 * mean lowering the setting silently destroyed history that raising it back
 * could not recover. Keeping the ceiling and reading a slice makes the setting
 * a view rather than a truncation.
 */
export const MAX_RECALL_TURNS = 30;

function getRecallStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isStore(namespace[SETTINGS_KEY])) namespace[SETTINGS_KEY] = { version: STORE_VERSION, timelines: {} };
    return namespace[SETTINGS_KEY];
}

/**
 * Record one retrieval pass. Ids are deduplicated within the turn: this counts
 * TURNS an item appeared in, not appearances, so an item listed twice in one
 * pass must not read as two turns of interest.
 *
 * Returns the number of turns now held, so a caller can tell a recorded pass
 * from a refused one.
 */
export function recordRetrievalRecall(timelineId, ids = []) {
    const id = String(timelineId || '');
    if (!id) return 0;
    const turn = [...new Set((Array.isArray(ids) ? ids : []).map((value) => String(value ?? '')).filter(Boolean))];
    const store = getRecallStore();
    const bucket = Array.isArray(store.timelines[id]) ? store.timelines[id] : [];
    // An empty pass is still a turn. Dropping it would let a long stretch of
    // empty retrieval leave an old item's share untouched at the top of the
    // window, which is exactly the ossification the window exists to prevent.
    bucket.push(turn);
    store.timelines[id] = bucket.slice(-MAX_RECALL_TURNS);
    getContext().saveSettingsDebounced();
    return store.timelines[id].length;
}

/**
 * How many of the last `window` turns each id was retrieved in, as a Map from
 * id to count. Ids the buffer has never seen are simply absent.
 */
export function readRecallCounts(timelineId, window = 10) {
    const id = String(timelineId || '');
    const bucket = id ? getRecallStore().timelines[id] : null;
    const counts = new Map();
    if (!Array.isArray(bucket)) return counts;
    const size = Math.max(1, Math.min(MAX_RECALL_TURNS, Math.floor(Number(window)) || 10));
    for (const turn of bucket.slice(-size)) {
        for (const value of new Set(Array.isArray(turn) ? turn : [])) {
            counts.set(String(value), (counts.get(String(value)) || 0) + 1);
        }
    }
    return counts;
}

/** Timeline deletion cascade. */
export function clearRetrievalRecall(timelineId) {
    const store = getRecallStore();
    const id = String(timelineId || '');
    if (!id || !store.timelines[id]) return false;
    delete store.timelines[id];
    getContext().saveSettingsDebounced();
    return true;
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && value.timelines && typeof value.timelines === 'object' && !Array.isArray(value.timelines));
}
