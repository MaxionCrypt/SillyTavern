// Apply the Loom's typed lore operations by writing NATIVE World Info.
//
// lore.edit rewrites a cached entry's content (refused unless the entry is in
// this Scene's Living Lore cache). lore.create adds a new entry to the
// timeline's bound book (refused if the timeline has none) and pulls it into the
// cache. Writes follow the mandatory pattern: load -> structuredClone working ->
// mutate working.entries -> saveWorldInfo(book, working, immediately) -> restore
// the original on save failure. State lives in the native entry; no sidecar.

import { getContext } from '../../../st-context.js';
import { listSceneEntryRefs, addEntryRefs } from './living-lore-cache-store.js';
import { getScene, getTimelineStore } from './timeline-state.js';
import { addSecretKeyword, removeSecretKeyword } from './living-lore-secret.js';

const MAX_ENTRY_CHARS = 12000;

function firstFreeUid(entries) {
    let uid = 0;
    while (Object.prototype.hasOwnProperty.call(entries, String(uid))) uid += 1;
    return uid;
}

/**
 * @returns {Promise<{ applied: Array<{op,book,uid}>, refused: Array<{op,reason}> }>}
 */
export async function applyLoreOps({ sceneId = '', timelineId = '', ops = [] } = {}) {
    const applied = [];
    const refused = [];
    const list = Array.isArray(ops) ? ops : [];
    if (!list.length) return { applied, refused };

    const cached = new Set(listSceneEntryRefs(sceneId).map((ref) => `${ref.book}.${ref.uid}`));
    const tid = String(timelineId || getScene(sceneId)?.timelineId || '');
    const timelineBook = String(getTimelineStore()?.timelines?.[tid]?.lorebookName || '');

    // Pre-validate each op and group the survivors by target book (one load/save per book).
    const perBook = new Map();
    const plan = (book, item) => { if (!perBook.has(book)) perBook.set(book, []); perBook.get(book).push(item); };
    for (const op of list) {
        if (op?.op === 'lore.edit') {
            const book = String(op.book ?? '').trim();
            const uid = String(op.uid ?? '').trim();
            if (!book || !uid) { refused.push({ op: 'lore.edit', reason: 'malformed' }); continue; }
            if (!cached.has(`${book}.${uid}`)) { refused.push({ op: 'lore.edit', book, uid, reason: 'not-in-cache' }); continue; }
            plan(book, { kind: 'edit', book, uid, content: String(op.content ?? '').slice(0, MAX_ENTRY_CHARS), secret: op.secret });
        } else if (op?.op === 'lore.create') {
            if (!timelineBook) { refused.push({ op: 'lore.create', reason: 'no-timeline-book' }); continue; }
            plan(timelineBook, {
                kind: 'create', book: timelineBook,
                name: String(op.name ?? '').trim(),
                keys: Array.isArray(op.keys) ? op.keys.map((k) => String(k)) : [],
                secondaryKeys: Array.isArray(op.secondaryKeys) ? op.secondaryKeys.map((k) => String(k)) : [],
                content: String(op.content ?? '').slice(0, MAX_ENTRY_CHARS),
                secret: op.secret === true,
            });
        } else {
            refused.push({ op: String(op?.op ?? ''), reason: 'unknown-op' });
        }
    }

    const ctx = getContext();
    for (const [book, items] of perBook) {
        let original = null;
        try { original = await ctx.loadWorldInfo?.(book); } catch { original = null; }
        const base = original && typeof original === 'object' ? original : { entries: {} };
        const working = structuredClone(base);
        if (!working.entries || typeof working.entries !== 'object') working.entries = {};

        const done = [];
        for (const item of items) {
            if (item.kind === 'edit') {
                const entry = working.entries[item.uid];
                if (!entry) { refused.push({ op: 'lore.edit', book: item.book, uid: item.uid, reason: 'entry-missing' }); continue; }
                entry.content = item.content;
                // Hide -> add the reserved keyword and disable so native activation
                // skips it; reveal -> drop the keyword and re-enable. Leave both
                // untouched when the op named no visibility change.
                if (item.secret === true) { entry.key = addSecretKeyword(entry.key); entry.disable = true; }
                else if (item.secret === false) { entry.key = removeSecretKeyword(entry.key); entry.disable = false; }
                done.push({ op: 'lore.edit', book: item.book, uid: item.uid });
            } else {
                const uid = firstFreeUid(working.entries);
                working.entries[uid] = {
                    uid, key: item.secret ? addSecretKeyword(item.keys) : [...item.keys],
                    keysecondary: [...item.secondaryKeys], comment: item.name,
                    content: item.content, constant: false, vectorized: false, selective: true, selectiveLogic: 0,
                    order: 100, position: 0, disable: Boolean(item.secret), probability: 100, useProbability: true,
                };
                done.push({ op: 'lore.create', book: item.book, uid: String(uid), cacheRef: { book: item.book, uid: String(uid) } });
            }
        }

        try {
            await ctx.saveWorldInfo?.(book, working, true);
            for (const record of done) {
                if (record.cacheRef) { addEntryRefs(sceneId, [record.cacheRef]); delete record.cacheRef; }
                applied.push(record);
            }
        } catch {
            if (original) { try { await ctx.saveWorldInfo?.(book, original, true); } catch { /* best effort restore */ } }
            for (const record of done) refused.push({ op: record.op, book: record.book, uid: record.uid, reason: 'save-failed' });
        }
    }

    return { applied, refused };
}
