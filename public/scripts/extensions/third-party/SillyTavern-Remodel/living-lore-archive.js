// The Living Lore Archive is a Scene-local view over native World Info.
// The cache owns only refs; this module re-reads those refs and is the one
// narrow write-through boundary used by its inline editor.

import { getContext } from '../../../st-context.js';
import { listSceneEntryRefs, orderedTimelineSceneIds } from './living-lore-cache-store.js';

const MAX_ENTRY_CHARS = 12_000;

function tagKey(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

export function normalizeLivingLoreTags(value) {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
    const seen = new Set();
    const tags = [];
    for (const candidate of raw) {
        const text = String(candidate ?? '').trim();
        const key = tagKey(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        tags.push(text);
    }
    return tags;
}

function entryKey(entry) {
    return `${entry.book}\u0000${entry.uid}`;
}

export function filterLivingLoreEntries(entries, query = '') {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    const list = Array.isArray(entries) ? entries : [];
    if (!needle) return [...list];
    return list.filter((entry) => [entry.title, ...(entry.tags || []), ...(entry.secondaryTags || [])]
        .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)));
}

/**
 * Deterministically form tag-connected sections. An entry appears once: any
 * entries joined by one or more shared tags form one group; unconnected
 * entries become "Other active lore". This keeps a tag-led structure without
 * duplicating a long entry beneath several headings.
 */
export function groupLivingLoreEntries(entries) {
    const list = (Array.isArray(entries) ? entries : []).slice().sort((left, right) =>
        String(left.title || '').localeCompare(String(right.title || ''), undefined, { sensitivity: 'base' }));
    const parent = list.map((_item, index) => index);
    const find = (index) => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== index) { const next = parent[index]; parent[index] = root; index = next; }
        return root;
    };
    const join = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    };
    const firstByTag = new Map();
    list.forEach((entry, index) => {
        for (const tag of normalizeLivingLoreTags([...(entry.tags || []), ...(entry.secondaryTags || [])])) {
            const key = tagKey(tag);
            if (firstByTag.has(key)) join(index, firstByTag.get(key));
            else firstByTag.set(key, index);
        }
    });
    const components = new Map();
    list.forEach((entry, index) => {
        const root = find(index);
        if (!components.has(root)) components.set(root, []);
        components.get(root).push(entry);
    });
    const grouped = [];
    const other = [];
    for (const members of components.values()) {
        const frequencies = new Map();
        for (const entry of members) {
            for (const tag of normalizeLivingLoreTags([...(entry.tags || []), ...(entry.secondaryTags || [])])) {
                const key = tagKey(tag);
                const prior = frequencies.get(key) || { tag, count: 0 };
                prior.count += 1;
                frequencies.set(key, prior);
            }
        }
        const sharedTags = [...frequencies.values()]
            .filter((item) => item.count >= 2)
            .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, undefined, { sensitivity: 'base' }))
            .map((item) => item.tag);
        if (!sharedTags.length) {
            other.push(...members);
            continue;
        }
        grouped.push({ id: sharedTags.map(tagKey).join('|'), label: sharedTags.slice(0, 3).join(' · '), sharedTags, entries: members });
    }
    grouped.sort((left, right) => right.entries.length - left.entries.length || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
    if (other.length) grouped.push({ id: 'other', label: 'Other active lore', sharedTags: [], entries: other });
    return grouped;
}

async function listLivingLoreEntries(refs, sceneIdsByRef = new Map()) {
    if (!refs.length) return [];
    const context = getContext();
    const byBook = new Map();
    for (const book of [...new Set(refs.map((ref) => ref.book))]) {
        try {
            const entries = await context.getWorldInfoEntriesForBook?.(book);
            byBook.set(book, new Map((entries || []).map((entry) => [String(entry.uid), entry])));
        } catch {
            byBook.set(book, new Map());
        }
    }
    return refs.flatMap((ref) => {
        const entry = byBook.get(ref.book)?.get(String(ref.uid));
        if (!entry) return [];
        const refKey = entryKey(ref);
        return [{
            book: ref.book,
            uid: String(ref.uid),
            title: String(entry.comment || (Array.isArray(entry.key) ? entry.key[0] : '') || `Entry ${ref.uid}`),
            tags: normalizeLivingLoreTags(entry.key),
            secondaryTags: normalizeLivingLoreTags(entry.keysecondary),
            content: String(entry.content ?? ''),
            sceneIds: sceneIdsByRef.get(refKey) || [],
        }];
    }).sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }));
}

export async function listSceneLivingLoreEntries(sceneId) {
    const refs = listSceneEntryRefs(sceneId);
    const sceneIdsByRef = new Map(refs.map((ref) => [entryKey(ref), [String(sceneId)]]));
    return listLivingLoreEntries(refs, sceneIdsByRef);
}

/**
 * The Timeline Archive is available even before a Scene is opened. It reads
 * the union of refs its Scenes have activated, but preserves which Scene(s)
 * supplied every ref so an edit still has a narrow, authorised write path.
 */
export async function listTimelineLivingLoreEntries(timelineId) {
    const refsByKey = new Map();
    const sceneIdsByRef = new Map();
    for (const sceneId of orderedTimelineSceneIds(timelineId)) {
        for (const ref of listSceneEntryRefs(sceneId)) {
            const key = entryKey(ref);
            if (!refsByKey.has(key)) refsByKey.set(key, ref);
            const sceneIds = sceneIdsByRef.get(key) || [];
            sceneIds.push(sceneId);
            sceneIdsByRef.set(key, sceneIds);
        }
    }
    return listLivingLoreEntries([...refsByKey.values()], sceneIdsByRef);
}

/** Update one cached native entry. No cache ref, no write. */
export async function updateSceneLivingLoreEntry({ sceneId = '', book = '', uid = '', title = '', tags = [], secondaryTags = [], content = '' } = {}) {
    const targetBook = String(book).trim();
    const targetUid = String(uid).trim();
    if (!targetBook || !targetUid) return { ok: false, reason: 'malformed' };
    const cached = new Set(listSceneEntryRefs(sceneId).map(entryKey));
    if (!cached.has(`${targetBook}\u0000${targetUid}`)) return { ok: false, reason: 'not-in-cache' };
    const context = getContext();
    let original = null;
    try { original = await context.loadWorldInfo?.(targetBook); } catch { original = null; }
    if (!original || typeof original !== 'object') return { ok: false, reason: 'book-unavailable' };
    const working = structuredClone(original);
    const entry = working.entries?.[targetUid];
    if (!entry) return { ok: false, reason: 'entry-missing' };
    const resolvedTitle = String(title ?? '').trim() || String(entry.comment || entry.key?.[0] || `Entry ${targetUid}`);
    entry.comment = resolvedTitle;
    entry.key = normalizeLivingLoreTags(tags);
    entry.keysecondary = normalizeLivingLoreTags(secondaryTags);
    entry.content = String(content ?? '').slice(0, MAX_ENTRY_CHARS);
    try {
        await context.saveWorldInfo?.(targetBook, working, true);
        return { ok: true, entry: { book: targetBook, uid: targetUid, title: resolvedTitle, tags: entry.key, secondaryTags: entry.keysecondary, content: entry.content } };
    } catch {
        try { await context.saveWorldInfo?.(targetBook, original, true); } catch { /* best-effort restore */ }
        return { ok: false, reason: 'save-failed' };
    }
}
