// Build a Living Lore packet (living-lore.loom-packet.v1) from the Scene cache.
//
// The cache holds only {book, uid} pointers; this re-reads each entry's CURRENT
// content from native World Info at build time (pointers, not snapshots), so a
// later edit reflects immediately. It builds the packet directly rather than
// via buildLivingLorePacket, whose single-book filter cannot represent a cache
// spanning several books (timeline + global + character + chat).

import { getContext } from '../../../st-context.js';
import { getScene, getTimelineStore } from './timeline-state.js';
import { listSceneEntryRefs, listPriorSceneKeywordGroups } from './living-lore-cache-store.js';

const MAX_ENTRIES = 40;
const MAX_ENTRY_CHARS = 2000;
const MAX_CHARS = 12000;

/** @returns {Promise<object|null>} a living-lore.loom-packet.v1 packet, or null when the Scene has nothing cached. */
export async function buildSceneLivingLorePacket({ sceneId = '', timelineId = '' } = {}) {
    const refs = listSceneEntryRefs(sceneId);
    if (!refs.length) return null;

    const ctx = getContext();
    const byBook = new Map();
    for (const book of [...new Set(refs.map((ref) => ref.book))]) {
        try {
            const entries = (await ctx.getWorldInfoEntriesForBook?.(book)) || [];
            byBook.set(book, new Map(entries.map((entry) => [String(entry.uid), entry])));
        } catch {
            byBook.set(book, new Map());
        }
    }

    const tid = String(timelineId || getScene(sceneId)?.timelineId || '');
    // The writable book (where the Loom creates/edits, a later phase); also the
    // packet's required `book` field. Fall back to the first ref's book so the
    // packet still renders when the timeline has no bound book of its own.
    const writableBook = String(getTimelineStore()?.timelines?.[tid]?.lorebookName || refs[0].book || '');

    const entries = [];
    let usedChars = 0;
    for (const ref of refs) {
        if (entries.length >= MAX_ENTRIES) break;
        const entry = byBook.get(ref.book)?.get(String(ref.uid));
        if (!entry) continue; // entry was removed from the book since it was pulled
        const remaining = Math.max(0, MAX_CHARS - usedChars);
        if (!remaining) break;
        const content = String(entry.content || '').slice(0, Math.min(MAX_ENTRY_CHARS, remaining));
        usedChars += content.length;
        entries.push({
            target: { book: ref.book, uid: String(ref.uid), revision: 1 },
            name: entry.comment || (Array.isArray(entry.key) ? entry.key[0] : '') || `Entry ${ref.uid}`,
            entryType: 'entity',
            protectedFields: [],
            keys: Array.isArray(entry.key) ? [...entry.key] : [],
            secondaryKeys: Array.isArray(entry.keysecondary) ? [...entry.keysecondary] : [],
            content,
            selectedBecause: ['loom-keywords'],
        });
    }
    if (!entries.length || !writableBook) return null;

    return {
        protocol: 'living-lore.loom-packet.v1',
        timelineId: tid,
        book: writableBook,
        bookHash: '',
        entries,
        bounds: { maxEntries: MAX_ENTRIES, maxEntryChars: MAX_ENTRY_CHARS, maxChars: MAX_CHARS, usedEntries: entries.length, usedChars },
    };
}

/** Pure render of prior-Scene keyword groups into a Loom prompt block. Each row
 *  is one group the Loom can re-query. Empty string when there are none, so the
 *  macro contributes nothing rather than an empty heading. */
export function formatPriorSceneKeywords(groups) {
    const rows = (Array.isArray(groups) ? groups : [])
        .map((group) => (Array.isArray(group) ? group.map((word) => String(word ?? '').trim()).filter(Boolean) : []))
        .filter((group) => group.length);
    if (!rows.length) return '';
    return [
        'Keywords earlier Scenes in this timeline drew on. Name any of these groups in "loreKeywords" to pull that lore back into this Scene:',
        ...rows.map((group) => `- ${group.join(', ')}`),
    ].join('\n');
}

/** Query the deduped prior-Scene keyword groups for a Scene and render them.
 *  `scenes` bounds the lookback to that many nearest prior Scenes (see
 *  listPriorSceneKeywordGroups); omitted means all. */
export function renderPriorSceneKeywords({ sceneId = '', timelineId = '', scenes } = {}) {
    return formatPriorSceneKeywords(listPriorSceneKeywordGroups({ sceneId, timelineId, scenes }));
}
