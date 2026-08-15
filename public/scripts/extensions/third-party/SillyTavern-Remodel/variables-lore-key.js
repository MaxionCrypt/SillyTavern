// Lorebook entry identity.
//
// A Variable's identity in this system is the entry it is attached to, and that
// identity is the pair `{ book, uid }` — deliberately the same one
// `checkWorldInfo` uses internally for its `allActivatedEntries` map, whose keys
// are `${entry.world}.${entry.uid}`, so an activation lookup is a Map hit rather
// than a scan.
//
// This lives apart from `variables-lore.js` because that module reads native
// World Info through `st-context.js`, which pulls in the macro engine and the
// rest of the app. Identity is needed by the pure layers — relevance scoring and
// migration — which must stay testable without booting SillyTavern.
//
// No imports. Keep it that way.

/** Matches checkWorldInfo's own `${entry.world}.${entry.uid}` map key. */
export function entryKey(ref) {
    const book = String(ref?.book ?? ref?.world ?? '').trim();
    const uid = String(ref?.uid ?? '').trim();
    return book && uid !== '' ? `${book}.${uid}` : '';
}

export function sameEntry(left, right) {
    const key = entryKey(left);
    return Boolean(key) && key === entryKey(right);
}
