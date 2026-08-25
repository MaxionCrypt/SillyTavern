import { loreEntryKey, normalizeLivingLoreMetadata } from './living-lore-model.js';

export const CULTIVATION_ACTIONS = Object.freeze(['grow', 'establish', 'update', 'create', 'link']);

/**
 * Turn an explicit owner instruction into one detached Living Lore proposal.
 * This module is deliberately pure: it cannot queue, apply, or save anything.
 */
export function draftCultivationProposal({ action = '', book = '', entry = null, metadata = null, value = '', entryType = 'entity', linkTarget = null, relation = 'related' } = {}) {
    const instruction = String(value || '').trim();
    const type = String(entryType || metadata?.entryType || 'entity');
    if (!CULTIVATION_ACTIONS.includes(action)) return failure('unsupported-action');
    if (!String(book || '').trim()) return failure('missing-book');
    if (action !== 'link' && !instruction) return failure('missing-value');

    const source = entry ? selectedTarget(book, entry, metadata) : null;
    if (!source && !['create'].includes(action)) return failure('missing-entry');
    const common = {
        id: cultivationId(action, source?.uid || 'new', instruction || relation),
        target: action === 'create' ? { book: String(book) } : source,
        entryType: action === 'create' ? type : String(metadata?.entryType || type),
        evidence: instruction || `Link ${entry?.name || source?.uid} to ${linkTarget?.name || linkTarget?.uid}`,
        confidence: 1,
        reason: 'Explicitly drafted by the Timeline owner in World Sense cultivation.',
    };

    if (action === 'grow') return success({ ...common, operation: 'thread.add', section: 'Open threads', value: instruction });
    if (action === 'establish') return success({ ...common, operation: 'fact.append', section: 'Established', value: instruction });
    if (action === 'update') return success({ ...common, operation: 'current.set', section: 'Current', value: instruction });
    if (action === 'create') return success({ ...common, operation: 'entry.create', section: 'Open threads', value: instruction });

    const linked = selectedTarget(book, linkTarget, linkTarget?.metadata);
    if (!linked) return failure('missing-link-target');
    if (linked.uid === source.uid) return failure('self-link');
    return success({
        ...common,
        operation: 'entry.link',
        section: 'Links',
        value: { target: linked, relation: normalizeRelation(relation) },
        evidence: `Link ${entry?.name || source.uid} to ${linkTarget?.name || linked.uid}`,
    });
}

/** Build the smallest packet that can validate a pointed owner proposal. */
export function buildCultivationPacket({ timelineId = '', book = '', bookHash = '', entries = [], metadata = [], proposal = null } = {}) {
    const metadataByKey = new Map((metadata || []).map((item) => [loreEntryKey(item), item]));
    const wanted = new Set();
    if (proposal?.target?.uid != null) wanted.add(String(proposal.target.uid));
    if (proposal?.operation === 'entry.link' && proposal.value?.target?.uid != null) wanted.add(String(proposal.value.target.uid));
    const packetEntries = (entries || []).filter((entry) => wanted.has(String(entry.uid))).map((entry) => {
        const sidecar = normalizeLivingLoreMetadata(metadataByKey.get(loreEntryKey(entry)) || {}, entry);
        return {
            target: { book: String(book), uid: String(entry.uid), revision: Number(sidecar?.revision || 1) },
            name: String(entry.name || ''),
            entryType: sidecar?.entryType || 'entity',
            protectedFields: [...(sidecar?.protectedFields || [])],
            keys: [...(entry.keys || [])],
            secondaryKeys: [...(entry.secondaryKeys || [])],
            content: String(entry.content || ''),
            selectedBecause: ['owner.cultivation'],
        };
    });
    return {
        protocol: 'living-lore.loom-packet.v1', timelineId: String(timelineId), book: String(book), bookHash: String(bookHash),
        entries: packetEntries, bounds: { maxEntries: packetEntries.length, maxEntryChars: 12000, maxChars: 24000, usedEntries: packetEntries.length, usedChars: packetEntries.reduce((sum, item) => sum + item.content.length, 0) },
    };
}

export function cultivationSearchText(entry = {}) {
    return [entry.name, ...(entry.keys || []), ...(entry.secondaryKeys || []), String(entry.content || '').slice(0, 1200)]
        .map((value) => String(value || '').trim()).filter(Boolean).join('\n');
}

/**
 * Cheap deterministic linting. It warns; it never claims semantic certainty or
 * mutates content. Semantic search remains responsible for broader relations.
 */
export function inspectCultivationConflicts(entries = [], selected = null) {
    if (!selected) return [];
    const sourceClaims = claims(selected.content);
    const sourceKeys = normalizedKeys(selected);
    const warnings = [];
    for (const candidate of entries || []) {
        if (loreEntryKey(candidate) === loreEntryKey(selected)) continue;
        const keyOverlap = intersection(sourceKeys, normalizedKeys(candidate));
        if (keyOverlap.length) warnings.push(warning('duplicate-key', candidate, `Shared key: ${keyOverlap.join(', ')}`));
        for (const left of sourceClaims) {
            for (const right of claims(candidate.content)) {
                if (left.normalized === right.normalized) warnings.push(warning('duplicate-claim', candidate, left.text));
                else if (left.signature && left.signature === right.signature && left.negative !== right.negative) {
                    warnings.push(warning('possible-contradiction', candidate, `${left.text} / ${right.text}`));
                }
            }
        }
    }
    return dedupeWarnings(warnings).slice(0, 20);
}

export function seedProtectionSummary(metadata = {}) {
    const protectedFields = new Set(metadata.protectedFields || []);
    return {
        premiseProtected: protectedFields.has('identity') && protectedFields.has('established'),
        currentProtected: protectedFields.has('current'),
        hooksProtected: protectedFields.has('openThreads'),
    };
}

function selectedTarget(book, entry, metadata) {
    if (!entry || entry.uid == null) return null;
    return { book: String(book), uid: String(entry.uid), revision: Number(metadata?.revision || 1) };
}

function claims(content) {
    return String(content || '').split(/\r?\n|(?<=[.!?])\s+/).map((text) => text.replace(/^[-*]\s*/, '').trim()).filter((text) => text.length >= 12).map((text) => {
        const normalized = normalize(text);
        const negative = /\b(?:not|never|no longer|cannot|can't|isn't|wasn't|without)\b/i.test(text);
        return { text, normalized, negative, signature: normalize(text.replace(/\b(?:not|never|no longer|cannot|can't|isn't|wasn't|without)\b/gi, '')) };
    });
}
function normalizedKeys(entry) { return [...(entry.keys || []), ...(entry.secondaryKeys || [])].map(normalize).filter((key) => key.length > 2); }
function intersection(left, right) { const other = new Set(right); return [...new Set(left.filter((item) => other.has(item)))]; }
function warning(kind, entry, detail) { return { kind, target: { book: String(entry.book || ''), uid: String(entry.uid ?? '') }, name: String(entry.name || ''), detail }; }
function dedupeWarnings(items) { const seen = new Set(); return items.filter((item) => { const key = `${item.kind}:${item.target.book}.${item.target.uid}:${normalize(item.detail)}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function cultivationId(action, uid, value) { return `cultivation-${action}-${uid}-${hash(value)}`; }
function normalizeRelation(value) { return String(value || 'related').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'related'; }
function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function hash(value) { let result = 0x811c9dc5; for (const char of String(value || '')) { result ^= char.charCodeAt(0); result = Math.imul(result, 0x01000193); } return (result >>> 0).toString(16).padStart(8, '0'); }
function success(proposal) { return { ok: true, proposal }; }
function failure(code) { return { ok: false, code, proposal: null }; }
