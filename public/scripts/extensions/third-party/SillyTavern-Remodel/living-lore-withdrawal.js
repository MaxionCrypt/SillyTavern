// Taking lore back out.
//
// Intake writes into native World Info at settlement, so by the time a turn is
// superseded — retried, swiped away, edited and rerun — its information is
// already lore. There is no unapplied proposal left to discard, which is what
// the old review queue relied on. The ledger records exactly what went in and
// where, and this removes it again.
//
// Withdrawal is by exact content, most recent first. Later writes are removed
// before earlier ones so that an entry appended to twice unwinds in the order
// it was built, and so an entry created by one write and appended to by a
// later one is not deleted out from under the append.
//
// An entry left empty by withdrawal is deleted: it was created by information
// that has now been taken back, so nothing of it remains to keep.

import { getContext } from '../../../st-context.js';
import { listLivingLoreWrites, markLivingLoreWriteWithdrawn } from './living-lore-store.js';

/**
 * @param {object} options
 * @param {string} options.timelineId
 * @param {string[]} options.directionIds turns whose lore should be taken back
 * @param {Array<string|number>} options.messageIds same, addressed by message
 */
export async function withdrawLivingLoreWrites({ timelineId = '', directionIds = [], messageIds = [], reason = 'superseded' } = {}) {
    const directions = new Set(strings(directionIds));
    const messages = new Set(strings(messageIds));
    if (!directions.size && !messages.size) return result();

    const doomed = listLivingLoreWrites({ timelineId, status: 'written' })
        .filter((record) => directions.has(record.directionId) || messages.has(record.messageId))
        // Most recent first: unwind in reverse of how the lore was built.
        .reverse();
    if (!doomed.length) return result();

    const context = getContext();
    const withdrawn = [];
    const failed = [];
    const books = new Map();

    for (const record of doomed) {
        try {
            const data = books.get(record.book) || await context.loadWorldInfo?.(record.book);
            if (!data?.entries) { failed.push({ id: record.id, code: 'book-unavailable' }); continue; }
            books.set(record.book, data);

            const entry = Object.values(data.entries).find((item) => String(item?.uid) === String(record.uid));
            if (!entry) {
                // Already gone. The lore is not there, which is the outcome
                // withdrawal wanted, so the ledger should stop tracking it.
                markLivingLoreWriteWithdrawn(timelineId, record.id, 'entry-missing');
                withdrawn.push({ ...record, removed: false });
                continue;
            }

            const next = removeBlock(String(entry.content || ''), record.content);
            if (!next.changed) {
                // Edited since, so the exact text is no longer there. Rewriting
                // around an author's edit would be worse than leaving it.
                failed.push({ id: record.id, code: 'content-changed' });
                continue;
            }
            if (next.content) entry.content = next.content;
            else delete data.entries[entry.uid];
            withdrawn.push({ ...record, removed: true, deletedEntry: !next.content });
        } catch (error) {
            failed.push({ id: record.id, code: 'withdraw-failed', detail: String(error?.message || error) });
        }
    }

    for (const [book, data] of books) {
        try {
            if (typeof context.saveWorldInfo === 'function') await context.saveWorldInfo(book, data, true);
        } catch (error) {
            return result({ withdrawn: [], failed: [...failed, { id: '', code: 'save-failed', detail: String(error?.message || error) }] });
        }
    }

    // Only marked once the book is safely saved, so a failed save leaves the
    // ledger claiming the lore is still there — which it is.
    for (const record of withdrawn) markLivingLoreWriteWithdrawn(timelineId, record.id, reason);

    return result({ withdrawn, failed });
}

/**
 * Remove one written block from an entry's content, taking its separator with
 * it so withdrawal does not leave a hole of blank lines behind.
 */
export function removeBlock(content, block) {
    const needle = String(block || '').trim();
    const text = String(content || '');
    if (!needle || !text.includes(needle)) return { changed: false, content: text };

    for (const candidate of [`\n\n${needle}`, `${needle}\n\n`, needle]) {
        if (!text.includes(candidate)) continue;
        return { changed: true, content: text.replace(candidate, '').trim() };
    }
    return { changed: false, content: text };
}

function strings(values) {
    return (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
}

function result({ withdrawn = [], failed = [] } = {}) {
    return Object.freeze({
        ok: !failed.length,
        withdrawn: Object.freeze(withdrawn),
        failed: Object.freeze(failed),
    });
}
