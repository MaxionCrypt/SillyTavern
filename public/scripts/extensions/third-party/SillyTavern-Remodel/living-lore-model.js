// Pure Living Lore identity and metadata contracts.
//
// Native World Info remains the source of truth for lore content. These
// helpers describe only Remodel's sidecar metadata and deliberately have no
// imports, storage access, or World Info mutation capability.

export const LIVING_LORE_ENTRY_TYPES = Object.freeze(['entity', 'rule', 'situation', 'history', 'seed']);
export const LIVING_LORE_ORIGINS = Object.freeze(['user', 'imported', 'loom', 'migration']);
export const LIVING_LORE_PROTECTED_FIELDS = Object.freeze([
    'identity', 'primaryKeys', 'secondaryKeys', 'established', 'current', 'openThreads', 'nativeSettings', 'retirement',
]);
export const GOAL_LORE_LINK_TYPES = Object.freeze(['subject', 'context', 'stake', 'origin', 'consequence']);

/** Matches native World Info's `${entry.world}.${entry.uid}` identity. */
export function loreEntryKey(ref) {
    const book = String(ref?.book ?? ref?.world ?? '').trim();
    const uid = String(ref?.uid ?? '').trim();
    return book && uid !== '' ? `${book}.${uid}` : '';
}

export function sameLoreEntry(left, right) {
    const key = loreEntryKey(left);
    return Boolean(key) && key === loreEntryKey(right);
}

export function normalizeLoreEntryRef(ref) {
    const key = loreEntryKey(ref);
    if (!key) return null;
    return { book: String(ref.book ?? ref.world).trim(), uid: String(ref.uid).trim() };
}

/** A Goal stays separate from lore; this validates only its typed reference. */
export function normalizeGoalLoreLink(value) {
    const ref = normalizeLoreEntryRef(value);
    const type = String(value?.type ?? '').trim().toLowerCase();
    if (!ref || !GOAL_LORE_LINK_TYPES.includes(type)) return null;
    return { ...ref, type };
}

/** Normalize a directed relationship between two native lore entries. */
export function normalizeLivingLoreLink(value) {
    const target = normalizeLoreEntryRef(value?.target ?? value);
    if (!target) return null;
    return { target, relation: normalizeRelation(value?.relation) };
}

export function normalizeLivingLoreMetadata(value = {}, identity = {}) {
    const ref = normalizeLoreEntryRef({
        book: identity.book ?? value.book ?? value.world,
        uid: identity.uid ?? value.uid,
    });
    if (!ref) return null;

    const entryType = LIVING_LORE_ENTRY_TYPES.includes(value.entryType)
        ? value.entryType
        : LIVING_LORE_ENTRY_TYPES.includes(value.type) ? value.type : 'entity';
    const origin = LIVING_LORE_ORIGINS.includes(value.origin) ? value.origin : 'user';
    const revision = positiveInteger(value.revision, 1);
    const protectedFields = uniqueStrings(value.protectedFields ?? value.protected, LIVING_LORE_PROTECTED_FIELDS);
    const links = uniqueLinks(value.links);
    const createdAt = normalizeTimestamp(value.createdAt);

    return {
        ...ref,
        entryType,
        revision,
        origin,
        protectedFields,
        links,
        createdAt,
        updatedAt: normalizeTimestamp(value.updatedAt, createdAt),
    };
}

function uniqueLinks(values) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const link = normalizeLivingLoreLink(value);
        if (!link) continue;
        const key = `${loreEntryKey(link.target)}:${link.relation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(link);
    }
    return result;
}

function uniqueStrings(values, allowed) {
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
        const normalized = String(value ?? '').trim();
        if (allowed.includes(normalized) && !result.includes(normalized)) result.push(normalized);
    }
    return result;
}

function normalizeRelation(value) {
    const relation = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return relation || 'related';
}

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeTimestamp(value, fallback = '') {
    const timestamp = String(value ?? '').trim();
    return timestamp || fallback;
}
