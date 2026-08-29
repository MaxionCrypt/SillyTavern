// When the vector index refreshes.
//
// The index itself is already incremental: `ensureWorldSenseIndex` diffs by
// content hash and only embeds documents whose hash changed. What it never had
// was a trigger — it ran when someone pressed Reindex and at no other time, so
// anything the Loom wrote stayed invisible to semantic search until a human
// noticed. This is the missing half.
//
// The policy is coalescing, not immediate. A settling turn can write several
// entries in quick succession and each write would otherwise start its own
// pass over the book; one pass after the writes stop is the same result for a
// fraction of the work. A ceiling stops a continuous stream of writes from
// deferring indexing forever.
//
// Timers are injected so this is testable without waiting.

export const DEFAULT_INDEX_DEBOUNCE_MS = 1200;
export const DEFAULT_INDEX_MAX_WAIT_MS = 8000;

export function createLoreIndexScheduler({
    index,
    debounceMs = DEFAULT_INDEX_DEBOUNCE_MS,
    maxWaitMs = DEFAULT_INDEX_MAX_WAIT_MS,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (handle) => clearTimeout(handle),
    onError = () => {},
} = {}) {
    if (typeof index !== 'function') throw new TypeError('A lore index scheduler needs an index function.');
    /** @type {Map<string, {timer: any, firstRequestedAt: number, running: boolean, rerun: boolean}>} */
    const states = new Map();

    const stateFor = (timelineId) => {
        const id = String(timelineId || '');
        if (!states.has(id)) states.set(id, { timer: null, firstRequestedAt: 0, running: false, rerun: false });
        return states.get(id);
    };

    async function run(timelineId) {
        const state = stateFor(timelineId);
        state.timer = null;
        state.firstRequestedAt = 0;
        state.running = true;
        try {
            await index(timelineId);
        } catch (error) {
            // An index failure must never surface as a turn failure: retrieval
            // degrades to whatever the last good index held.
            onError(error, timelineId);
        } finally {
            state.running = false;
        }
        if (state.rerun) {
            // Writes that landed mid-run are not in what was just indexed, so
            // exactly one more pass is owed — not one per write.
            state.rerun = false;
            request(timelineId);
        }
    }

    function request(timelineId) {
        const id = String(timelineId || '');
        if (!id) return false;
        const state = stateFor(id);
        if (state.running) {
            state.rerun = true;
            return false;
        }
        const at = now();
        if (!state.firstRequestedAt) state.firstRequestedAt = at;
        if (state.timer !== null) cancel(state.timer);
        // Never wait past the ceiling measured from the FIRST request in this
        // burst, so a steady write stream still gets indexed.
        const remaining = Math.max(0, state.firstRequestedAt + maxWaitMs - at);
        state.timer = schedule(() => { run(id); }, Math.max(0, Math.min(debounceMs, remaining)));
        return true;
    }

    /** Run now, skipping the wait. Used by an explicit Reindex and by tests. */
    function flush(timelineId) {
        const id = String(timelineId || '');
        const state = stateFor(id);
        if (state.timer !== null) {
            cancel(state.timer);
            state.timer = null;
        }
        if (state.running) {
            state.rerun = true;
            return Promise.resolve(false);
        }
        return run(id).then(() => true);
    }

    function pending(timelineId) {
        const state = states.get(String(timelineId || ''));
        return Boolean(state && (state.timer !== null || state.running || state.rerun));
    }

    function stop() {
        for (const state of states.values()) {
            if (state.timer !== null) cancel(state.timer);
            state.timer = null;
            state.rerun = false;
        }
    }

    return Object.freeze({ request, flush, pending, stop });
}
