/**
 * Resolve a ranked World Sense selection back to the native World Info rows.
 * The ranking receipt deliberately stores identities rather than prompt
 * content; native rows remain the sole source of insertion and activation
 * behavior.
 */
export function materializeWorldSenseActivations(selection = {}, data = {}) {
    const book = String(selection?.book || '').trim();
    const selected = Array.isArray(selection?.selected) ? selection.selected : [];
    const requested = [...new Set(selected
        .filter((item) => String(item?.book ?? item?.world ?? book).trim() === book)
        .map((item) => String(item?.uid ?? '').trim())
        .filter(Boolean))];
    const requestedSet = new Set(requested);
    const entries = [];
    const found = new Set();

    const nativeEntries = Array.isArray(data) ? data : Object.values(data?.entries || {});
    for (const nativeEntry of nativeEntries) {
        const uid = String(nativeEntry?.uid ?? '').trim();
        const nativeBook = String(nativeEntry?.world ?? book).trim();
        if (nativeBook !== book || !uid || !requestedSet.has(uid) || found.has(uid)) continue;
        found.add(uid);
        // checkWorldInfo mutates activation candidates while resolving macros.
        // Detach the row so a Preview or dry-run cannot mutate the loaded book.
        entries.push(structuredClone({ ...nativeEntry, world: book }));
    }

    return {
        book,
        requested,
        missing: requested.filter((uid) => !found.has(uid)),
        entries,
    };
}

/**
 * Apply a selection through SillyTavern's native WORLDINFO_FORCE_ACTIVATE
 * event. Every failure is returned as data so local retrieval can never block
 * ordinary deterministic World Info.
 */
export async function activateWorldSenseSelection(context, selection = {}, { phase = 'generation' } = {}) {
    const book = String(selection?.book || '').trim();
    const selected = Array.isArray(selection?.selected) ? selection.selected : [];
    if (!book || selected.length === 0) return activationResult({ phase, book });

    try {
        if (typeof context?.getWorldInfoEntriesForBook !== 'function') throw new Error('Native World Info entry preparation is unavailable.');
        const eventType = context?.eventTypes?.WORLDINFO_FORCE_ACTIVATE;
        if (!eventType || typeof context?.eventSource?.emit !== 'function') throw new Error('Native World Info force-activation is unavailable.');
        // Use the same decorator-parsed, sorted native rows checkWorldInfo will
        // scan. Loading the raw book here would reinsert decorator directives
        // as lore content and would not be true Preview/generation parity.
        const materialized = materializeWorldSenseActivations(selection, await context.getWorldInfoEntriesForBook(book));
        if (materialized.entries.length) await context.eventSource.emit(eventType, materialized.entries);
        return activationResult({
            phase,
            book,
            requested: materialized.requested.length,
            activated: materialized.entries.length,
            missing: materialized.missing,
        });
    } catch (error) {
        return activationResult({ phase, book, ok: false, error: String(error?.message || error) });
    }
}

function activationResult({ phase, book, ok = true, requested = 0, activated = 0, missing = [], error = '' } = {}) {
    return { ok, phase: String(phase || ''), book: String(book || ''), requested, activated, missing, error };
}
