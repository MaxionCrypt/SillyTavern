// Acting on a placement.
//
// `placeLivingLoreInformation` decides; this performs. Two outcomes only:
//
//  - APPEND: the header the Loom suggested is discarded and the content is
//    added to the end of an existing entry's content.
//  - CREATE: a new native entry carrying the suggested name and keys.
//
// Native World Info is the only store. There is no proposal record, no review
// queue and no rollback ledger: the mechanic this implements decides placement
// from evidence rather than asking someone to confirm it, so a parallel copy of
// the lore would be a second source of truth with nothing to reconcile it
// against. The lorebook is the lore.
//
// Every write is all-or-nothing against a snapshot of the book. If the save
// fails the book is restored, because a half-applied entry is worse than a
// rejected one.

import { getContext } from '../../../st-context.js';
import { recordLivingLoreWrite, upsertLivingLoreMetadata } from './living-lore-store.js';

/** The same ceiling the proposal engine enforced. An entry that outgrows it
 * stops being retrievable lore and becomes a document. */
export const MAX_ENTRY_CHARS = 12000;

export const WRITE_REFUSALS = Object.freeze([
    'book-unavailable', 'missing-entry', 'entry-too-large', 'empty-content', 'save-failed', 'already-recorded',
]);

/**
 * @param {object} options
 * @param {string} options.timelineId
 * @param {string} options.book lorebook name
 * @param {{decision: string, target: ?object}} options.placement from placeLivingLoreInformation
 * @param {{content: string, name: string, keys: string[]}} options.information
 */
export async function applyLivingLoreIntake({ timelineId = '', book = '', placement = null, information = null, source = {} } = {}) {
    const content = String(information?.content || '').trim();
    if (!content) return refusal('empty-content');
    if (!book) return refusal('book-unavailable');

    const context = getContext();
    const data = await context.loadWorldInfo?.(book);
    if (!data?.entries || typeof context.saveWorldInfo !== 'function') return refusal('book-unavailable');

    // Writing directly means a retried, reloaded or re-settled turn would file
    // the same information twice, and an append cannot be taken back once it is
    // in the lore. The book itself is the ledger: if this exact content is
    // already recorded somewhere, the work is done. That survives reloads and
    // needs no parallel state to keep in sync.
    const already = findRecorded(data, content);
    if (already) {
        return Object.freeze({
            ok: true, decision: 'already-recorded', target: { book, uid: String(already.uid) },
            name: String(already.comment || ''), chars: String(already.content || '').length, reason: '',
        });
    }

    // Snapshot first: every failure below restores this exact book.
    const original = structuredClone(data);
    const working = structuredClone(data);

    const applied = placement?.decision === 'append'
        ? appendToEntry(working, placement.target, content)
        : createEntry(working, information, content);
    if (!applied.ok) return refusal(applied.code);

    try {
        await context.saveWorldInfo(book, working, true);
    } catch (error) {
        try { await context.saveWorldInfo(book, original, true); } catch { /* best effort; the refusal is still reported */ }
        return refusal('save-failed', String(error?.message || error));
    }

    // The sidecar is written only after the lore is safely saved, so a failed
    // write can never leave metadata describing an entry that does not exist.
    // createdAt matters: it is what the temporal signal scores against later,
    // and upsert sets it on first write and never moves it afterwards.
    const ref = { book, uid: applied.uid };
    upsertLivingLoreMetadata(timelineId, ref, { origin: 'loom' }, { incrementRevision: applied.decision === 'append' });

    // Writing directly means there is no unapplied proposal to discard when the
    // turn that produced this is superseded. Remembering exactly what went in,
    // and where, is the only way it can come back out.
    const write = recordLivingLoreWrite(timelineId, {
        book, uid: applied.uid, decision: applied.decision, content,
        directionId: source?.directionId, sceneId: source?.sceneId, messageId: source?.messageId,
    });

    return Object.freeze({
        ok: true,
        decision: applied.decision,
        target: ref,
        name: applied.name,
        chars: applied.chars,
        reason: '',
        // The ledger's own id for this write: the handle a caller keeps so it
        // can later say which filed piece of lore a turn was responsible for.
        writeId: write?.id || null,
    });
}

/** The header is dropped here. Only the content joins the existing entry. */
function appendToEntry(data, target, content) {
    const entry = findEntry(data, target?.uid);
    if (!entry) return { ok: false, code: 'missing-entry' };
    const existing = String(entry.content || '').trimEnd();
    const next = existing ? `${existing}\n\n${content}` : content;
    if (next.length > MAX_ENTRY_CHARS) return { ok: false, code: 'entry-too-large' };
    entry.content = next;
    return { ok: true, decision: 'append', uid: String(entry.uid), name: String(entry.comment || ''), chars: next.length };
}

/**
 * A new entry keeps the name and keys the Loom suggested, because this is the
 * case where it was right that the information is its own subject.
 *
 * Defaults mirror an ordinary authored entry: it is scanned by key like any
 * other, and it is not constant, because "always include this" is an authoring
 * decision and nothing generated should be making it.
 */
function createEntry(data, information, content) {
    if (content.length > MAX_ENTRY_CHARS) return { ok: false, code: 'entry-too-large' };
    const uid = nextUid(data.entries);
    const keys = cleanKeys(information?.keys);
    const name = String(information?.name || '').trim().slice(0, 120) || firstLine(content);
    data.entries[uid] = {
        uid,
        key: keys.length ? keys : [name],
        keysecondary: [],
        comment: name,
        content,
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        probability: 100,
        useProbability: true,
    };
    return { ok: true, decision: 'create', uid: String(uid), name, chars: content.length };
}

/** Whether this exact information is already in the book, wherever it landed. */
function findRecorded(data, content) {
    const needle = content.trim();
    if (!needle) return null;
    return Object.values(data?.entries || {}).find((entry) => String(entry?.content || '').includes(needle)) || null;
}

function findEntry(data, uid) {
    const wanted = String(uid ?? '');
    return Object.values(data?.entries || {}).find((entry) => String(entry?.uid) === wanted) || null;
}

function nextUid(entries) {
    const used = new Set(Object.values(entries || {}).map((entry) => Number(entry?.uid)).filter(Number.isInteger));
    let uid = 0;
    while (used.has(uid)) uid += 1;
    return uid;
}

function cleanKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : [])
        .map((key) => String(key ?? '').trim())
        .filter(Boolean)
        .map((key) => key.slice(0, 120)))].slice(0, 12);
}

function firstLine(content) {
    const first = String(content).trim().split(/\r?\n|(?<=[.!?])\s+/)[0].replace(/^[-*]\s*/, '').trim();
    return (first || 'Living Lore').slice(0, 120);
}

function refusal(code, detail = '') {
    return Object.freeze({ ok: false, decision: '', target: null, name: '', chars: 0, reason: code, detail });
}
