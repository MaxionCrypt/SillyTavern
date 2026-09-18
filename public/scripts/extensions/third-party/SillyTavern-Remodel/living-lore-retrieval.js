// Living Lore retrieval: turn the Loom's keyword groups into native World Info
// entry refs, scoped to the timeline's bound book plus the active World Info.
//
// It reuses the native-faithful matcher (world-info-scan.js) over an explicit,
// book-scoped entry list rather than native checkWorldInfo — checkWorldInfo has
// no book-list parameter (its scope comes from module globals) and is not
// side-effect-free even as a dry run, so a synthetic per-group scan through it
// would disturb the real turn. getWorldInfoEntriesForBook loads one book's
// prepared entries without selecting it globally, which is exactly what we need.

import { getContext } from '../../../st-context.js';
import { selected_world_info } from '../../../world-info.js';
import { getScene, getTimelineStore } from './timeline-state.js';
import { matchEntry, MAX_SCAN_DEPTH } from './world-info-scan.js';
import { isSecretEntry } from './living-lore-secret.js';

/** The book set a keyword query scans: active World Info (global + chat +
 *  character) unioned with the timeline's bound lorebook. Deduped. */
export function scopedBookNames({ sceneId = '', timelineId = '' } = {}) {
    const ctx = getContext();
    const names = new Set();
    for (const n of Array.isArray(selected_world_info) ? selected_world_info : []) if (n) names.add(String(n));
    const chatBook = ctx.chatMetadata?.world_info;
    if (chatBook) names.add(String(chatBook));
    const character = ctx.characters?.[ctx.characterId];
    const charBook = character?.data?.extensions?.world;
    if (charBook) names.add(String(charBook));
    const tid = String(timelineId || getScene(sceneId)?.timelineId || '');
    const tlBook = tid ? getTimelineStore()?.timelines?.[tid]?.lorebookName : '';
    if (tlBook) names.add(String(tlBook));
    return [...names];
}

/**
 * Activate each keyword group SEPARATELY against the scoped books and union the
 * hits, so `["event","Rayse"]` and `["Rayse","Silvia"]` cannot combine to fire
 * an entry that needs `event`+`Silvia`. Returns deduped refs by `${book}.${uid}`.
 * @returns {Promise<Array<{ book:string, uid:string, name:string, keys:string[], secondaryKeys:string[], content:string }>>}
 */
export async function activateKeywordGroups(groups, { sceneId = '', timelineId = '' } = {}) {
    const list = Array.isArray(groups) ? groups.filter((g) => Array.isArray(g) && g.length) : [];
    if (!list.length) return [];
    const ctx = getContext();
    const books = scopedBookNames({ sceneId, timelineId });
    const byBook = new Map();
    for (const book of books) {
        try { byBook.set(book, (await ctx.getWorldInfoEntriesForBook?.(book)) || []); }
        catch { byBook.set(book, []); }
    }
    const out = new Map();
    for (const group of list) {
        const corpus = [group.join('\n')];
        for (const [book, entries] of byBook) {
            for (const item of Array.isArray(entries) ? entries : []) {
                // A secret entry is disabled so native activation skips it for
                // the Narrator; the Loom's own retrieval still pulls it in.
                if (item.disable === true && !isSecretEntry(item)) continue;
                const uid = String(item.uid);
                const key = `${book}.${uid}`;
                if (out.has(key)) continue;
                const match = matchEntry(item, { corpus, recursionText: [], scanDepth: MAX_SCAN_DEPTH, recursion: false, globalScanData: {}, macroOptions: {} });
                if (!match.active) continue;
                out.set(key, {
                    book,
                    uid,
                    name: item.comment || (Array.isArray(item.key) ? item.key[0] : '') || `Entry ${uid}`,
                    keys: Array.isArray(item.key) ? [...item.key] : [],
                    secondaryKeys: Array.isArray(item.keysecondary) ? [...item.keysecondary] : [],
                    content: String(item.content ?? ''),
                });
            }
        }
    }
    return [...out.values()];
}
