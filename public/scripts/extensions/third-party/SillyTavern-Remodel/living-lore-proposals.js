import {
    LIVING_LORE_ENTRY_TYPES,
    normalizeLivingLoreMetadata,
    loreEntryKey,
} from './living-lore-model.js';
import { formatWorldSensePromotionPacket } from './world-sense-promotion.js';

export const LIVING_LORE_OPERATIONS = Object.freeze([
    'entry.create',
    'fact.append',
    'current.set',
    'thread.add',
    'alias.add',
    'entry.link',
    'entry.retire',
]);

const DEFAULT_LIMITS = Object.freeze({ maxEntries: 12, maxEntryChars: 6000, maxChars: 24000 });
const COMMON_KEYS = new Set(['id', 'operation', 'target', 'entryType', 'section', 'value', 'evidence', 'confidence', 'reason']);
const TARGET_KEYS = new Set(['book', 'uid', 'revision']);
const OPERATION_SECTIONS = Object.freeze({
    'entry.create': ['Established', 'Current', 'Open threads'],
    'fact.append': ['Established'],
    'current.set': ['Current'],
    'thread.add': ['Open threads'],
    'alias.add': ['Aliases'],
    'entry.link': ['Links'],
    'entry.retire': ['Retirement'],
});

/**
 * Build the exact, bounded lore packet the Loom may reason over. The packet is
 * detached data: this module has no World Info save path and cannot mutate a
 * lorebook.
 */
export function buildLivingLorePacket({ timelineId = '', book = '', bookHash = '', entries = [], selected = [], metadata = [], limits = {} } = {}) {
    const writableBook = String(book || '').trim();
    const cap = {
        maxEntries: positiveInteger(limits.maxEntries, DEFAULT_LIMITS.maxEntries),
        maxEntryChars: positiveInteger(limits.maxEntryChars, DEFAULT_LIMITS.maxEntryChars),
        maxChars: positiveInteger(limits.maxChars, DEFAULT_LIMITS.maxChars),
    };
    const entryMap = new Map((entries || []).map((entry) => [loreEntryKey(entry), entry]));
    const metadataMap = new Map((metadata || []).map((item) => [loreEntryKey(item), item]));
    const packetEntries = [];
    let usedChars = 0;

    for (const choice of Array.isArray(selected) ? selected : []) {
        if (packetEntries.length >= cap.maxEntries) break;
        const entry = entryMap.get(loreEntryKey(choice));
        if (!entry || String(entry.book) !== writableBook) continue;
        const sidecar = normalizeLivingLoreMetadata(metadataMap.get(loreEntryKey(entry)) || {}, entry);
        const remaining = Math.max(0, cap.maxChars - usedChars);
        if (!remaining) break;
        const content = String(entry.content || '').slice(0, Math.min(cap.maxEntryChars, remaining));
        usedChars += content.length;
        packetEntries.push({
            target: { book: writableBook, uid: String(entry.uid), revision: sidecar?.revision || 1 },
            name: String(entry.name || ''),
            entryType: sidecar?.entryType || 'entity',
            protectedFields: [...(sidecar?.protectedFields || [])],
            keys: [...(entry.keys || [])],
            secondaryKeys: [...(entry.secondaryKeys || [])],
            content,
            selectedBecause: (choice.reasons || []).map((reason) => String(reason?.channel || '')).filter(Boolean),
        });
    }

    return {
        protocol: 'living-lore.loom-packet.v1',
        timelineId: String(timelineId || ''),
        book: writableBook,
        bookHash: String(bookHash || ''),
        entries: packetEntries,
        bounds: { ...cap, usedEntries: packetEntries.length, usedChars },
    };
}

/** Render one recipe source with both the writable packet and its output rule. */
export function formatLivingLorePacket(packet) {
    if (!packet?.book || !Array.isArray(packet.entries)) return '';
    const lorePacket = { ...packet };
    delete lorePacket.promotion;
    return [
        'Selected Living Lore (the only lorebook entries available for change proposals):',
        JSON.stringify(lorePacket, null, 2),
        'Do not rewrite lore directly. If accepted fiction warrants a durable change, add a top-level "loreProposals" array to the state fence.',
        'Each proposal uses only: entry.create, fact.append, current.set, thread.add, alias.add, entry.link, or entry.retire.',
        'For an existing entry, copy target.book, target.uid, and target.revision exactly from this packet. A stale or unselected target is rejected.',
        'Sections are fixed: fact.append=Established, current.set=Current, thread.add=Open threads, alias.add=Aliases, entry.link=Links, entry.retire=Retirement. entry.create may use Established, Current, or Open threads and targets only the book.',
        'entry.link value is {"target":{"book":"...","uid":"...","revision":1},"relation":"..."}; both entries must be selected. Other non-retirement operations use a string value.',
        'Shape: {"operation":"current.set","target":{"book":"Timeline Book","uid":"42","revision":7},"entryType":"entity","section":"Current","value":"...","evidence":["one exact accepted excerpt","archive:record-id"],"confidence":0.91,"reason":"one sentence"}',
        'Evidence may be one string or an array of 1-6 independently checkable strings. Prefer archive:<record-id> for supplied Archive or promotion evidence. Never combine separate quotations into one string with "and" or semicolons.',
        'Use "loreProposals":[] when no durable lore change is warranted.',
        formatWorldSensePromotionPacket(packet.promotion),
    ].filter(Boolean).join('\n');
}

/**
 * Strictly validate proposed operations against the packet the model saw.
 * Returns detached proposals and rejection diagnostics; it performs no writes.
 */
export function parseLivingLoreProposals(value, packet) {
    const accepted = [];
    const rejected = [];
    const proposals = Array.isArray(value) ? value : [];
    for (let index = 0; index < proposals.length; index += 1) {
        const proposal = proposals[index];
        const code = validateProposal(proposal, packet);
        if (code) rejected.push({ index, code, proposal: clone(proposal) });
        else accepted.push(clone(proposal));
    }
    if (value != null && !Array.isArray(value)) rejected.push({ index: -1, code: 'not-an-array', proposal: clone(value) });
    return { accepted, rejected };
}

function validateProposal(proposal, packet) {
    if (!isObject(proposal)) return 'not-an-object';
    if (Object.keys(proposal).some((key) => !COMMON_KEYS.has(key))) return 'unknown-field';
    if (!LIVING_LORE_OPERATIONS.includes(proposal.operation)) return 'unsupported-operation';
    if (!packet?.book || !Array.isArray(packet.entries)) return 'missing-packet';
    if (!isObject(proposal.target)) return 'missing-target';
    if (Object.keys(proposal.target).some((key) => !TARGET_KEYS.has(key))) return 'unknown-target-field';
    if (String(proposal.target.book || '') !== String(packet.book)) return 'wrong-book';
    if (!LIVING_LORE_ENTRY_TYPES.includes(proposal.entryType)) return 'invalid-entry-type';
    if (!OPERATION_SECTIONS[proposal.operation].includes(proposal.section)) return 'invalid-section';
    if (!validEvidence(proposal.evidence)) return 'missing-evidence';
    if (!nonempty(proposal.reason)) return 'missing-reason';
    if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) return 'invalid-confidence';

    if (proposal.operation === 'entry.create') {
        if (proposal.target.uid != null || proposal.target.revision != null) return 'create-target-exists';
        if (!nonempty(proposal.value)) return 'missing-value';
        return '';
    }

    const uid = String(proposal.target.uid ?? '').trim();
    const selected = packet.entries.find((entry) => String(entry?.target?.book) === String(packet.book) && String(entry?.target?.uid) === uid);
    if (!selected) return 'unselected-target';
    if (!Number.isInteger(proposal.target.revision) || proposal.target.revision !== selected.target.revision) return 'stale-revision';
    if (proposal.entryType !== selected.entryType) return 'entry-type-mismatch';
    if (!['entry.retire', 'entry.link'].includes(proposal.operation) && !nonempty(proposal.value)) return 'missing-value';
    if (proposal.operation === 'entry.link') return validateLink(proposal.value, packet, selected);
    return '';
}

function validateLink(value, packet, source) {
    if (!isObject(value) || !isObject(value.target) || !nonempty(value.relation)) return 'invalid-link';
    if (Object.keys(value).some((key) => !['target', 'relation'].includes(key))) return 'invalid-link';
    if (Object.keys(value.target).some((key) => !TARGET_KEYS.has(key))) return 'invalid-link';
    if (String(value.target.book || '') !== String(packet.book)) return 'wrong-link-book';
    const linked = packet.entries.find((entry) => String(entry?.target?.uid) === String(value.target.uid ?? '').trim());
    if (!linked) return 'unselected-link-target';
    if (linked.target.revision !== value.target.revision) return 'stale-link-revision';
    if (linked.target.uid === source.target.uid) return 'self-link';
    return '';
}

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function nonempty(value) { return typeof value === 'string' && Boolean(value.trim()); }
function validEvidence(value) {
    if (nonempty(value)) return true;
    return Array.isArray(value) && value.length >= 1 && value.length <= 6 && value.every(nonempty);
}
function clone(value) { return value == null ? value : structuredClone(value); }
function positiveInteger(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
