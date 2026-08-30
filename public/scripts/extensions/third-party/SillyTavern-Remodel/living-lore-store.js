import { getContext } from '../../../st-context.js';
import { loreEntryKey, normalizeLivingLoreMetadata, normalizeLoreEntryRef } from './living-lore-model.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'livingLoreV1';
const STORE_VERSION = 1;

/** Remodel-owned sidecar metadata. This module cannot mutate native World Info. */
export function getLivingLoreStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isObject(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = emptyStore();
        context.saveSettingsDebounced();
    }
    normalizeStore(namespace[SETTINGS_KEY]);
    return namespace[SETTINGS_KEY];
}

export function saveLivingLoreStore() {
    getContext().saveSettingsDebounced();
}

export function getTimelineLivingLoreState(timelineId, { create = true } = {}) {
    const id = String(timelineId ?? '').trim();
    if (!id) return null;
    const store = getLivingLoreStore();
    if (!store.timelines[id] && create) {
        store.timelines[id] = timelineBucket(id);
        saveLivingLoreStore();
    }
    return store.timelines[id] ?? null;
}

export function listLivingLoreMetadata({ timelineId = '', book = '' } = {}) {
    const store = getLivingLoreStore();
    const buckets = timelineId ? [store.timelines[String(timelineId)]].filter(Boolean) : Object.values(store.timelines);
    return buckets.flatMap((bucket) => Object.values(bucket.entries)).filter((metadata) => !book || metadata.book === String(book));
}

export function getLivingLoreMetadata(timelineId, ref) {
    const key = loreEntryKey(ref);
    if (!key) return null;
    return getTimelineLivingLoreState(timelineId, { create: false })?.entries?.[key] ?? null;
}

export function upsertLivingLoreMetadata(timelineId, ref, patch = {}, { incrementRevision = false } = {}) {
    const identity = normalizeLoreEntryRef(ref);
    if (!identity) return null;
    const bucket = getTimelineLivingLoreState(timelineId);
    if (!bucket) return null;
    const key = loreEntryKey(identity);
    const current = bucket.entries[key];
    const timestamp = now();
    const next = normalizeLivingLoreMetadata({
        ...current,
        ...clone(patch),
        book: identity.book,
        uid: identity.uid,
        revision: current ? current.revision + (incrementRevision ? 1 : 0) : patch.revision ?? 1,
        createdAt: current?.createdAt || patch.createdAt || timestamp,
        updatedAt: timestamp,
    }, identity);
    if (!next) return null;
    bucket.entries[key] = next;
    bucket.book ||= identity.book;
    bucket.updatedAt = timestamp;
    saveLivingLoreStore();
    return next;
}

/** Removes only Remodel metadata; the native lore entry is untouched. */
export function removeLivingLoreMetadata(timelineId, ref) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    const key = loreEntryKey(ref);
    if (!bucket || !key || !bucket.entries[key]) return false;
    delete bucket.entries[key];
    bucket.updatedAt = now();
    saveLivingLoreStore();
    return true;
}

export function snapshotLivingLoreStore() {
    return clone(getLivingLoreStore());
}

export function restoreLivingLoreStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = isObject(snapshot) ? clone(snapshot) : emptyStore();
    normalizeStore(context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY]);
    if (save) saveLivingLoreStore();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

function emptyStore() {
    return { version: STORE_VERSION, timelines: {} };
}

/**
 * Remember that intake wrote something, so it can be undone if the turn that
 * produced it is superseded. Writing lore directly means there is no unapplied
 * proposal to throw away — the only way back is to know what went in.
 */
export function recordLivingLoreWrite(timelineId, record = {}) {
    const bucket = getTimelineLivingLoreState(timelineId);
    if (!bucket) return null;
    const id = String(record.id || '').trim() || `write-${now()}-${Object.keys(bucket.writes || {}).length}`;
    bucket.writes = isObject(bucket.writes) ? bucket.writes : {};
    bucket.writes[id] = {
        id,
        book: String(record.book || ''),
        uid: String(record.uid || ''),
        decision: String(record.decision || ''),
        content: String(record.content || ''),
        directionId: String(record.directionId || ''),
        // Scoped to a Scene so withdrawing a superseded turn cannot reach into
        // another Scene's lore in the same Timeline.
        sceneId: String(record.sceneId || ''),
        messageId: record.messageId == null ? '' : String(record.messageId),
        status: 'written',
        at: now(),
    };
    bucket.updatedAt = now();
    saveLivingLoreStore();
    return clone(bucket.writes[id]);
}

export function listLivingLoreWrites({ timelineId = '', status = '' } = {}) {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    if (!bucket) return [];
    return Object.values(bucket.writes || {})
        .filter((record) => !status || record.status === status)
        .map(clone)
        .sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

export function markLivingLoreWriteWithdrawn(timelineId, id, reason = 'superseded') {
    const bucket = getTimelineLivingLoreState(timelineId, { create: false });
    if (!bucket?.writes?.[id]) return null;
    bucket.writes[id].status = 'withdrawn';
    bucket.writes[id].withdrawnAt = now();
    bucket.writes[id].reason = String(reason || '');
    bucket.updatedAt = now();
    saveLivingLoreStore();
    return clone(bucket.writes[id]);
}

function timelineBucket(timelineId) {
    const timestamp = now();
    return { timelineId, book: '', entries: {}, proposals: {}, writes: {}, history: [], createdAt: timestamp, updatedAt: timestamp };
}

function normalizeStore(store) {
    store.version = STORE_VERSION;
    store.timelines = isObject(store.timelines) ? store.timelines : {};
    for (const [timelineId, rawBucket] of Object.entries(store.timelines)) {
        const bucket = isObject(rawBucket) ? rawBucket : timelineBucket(timelineId);
        const normalized = {};
        const entries = isObject(bucket.entries) ? bucket.entries : {};
        for (const raw of Object.values(entries)) {
            if (!isObject(raw)) continue;
            const metadata = normalizeLivingLoreMetadata(raw);
            if (metadata) normalized[loreEntryKey(metadata)] = metadata;
        }
        const fallbackTime = now();
        store.timelines[timelineId] = {
            timelineId,
            book: String(bucket.book ?? '').trim(),
            entries: normalized,
            proposals: normalizeRecords(bucket.proposals),
            // What intake has written into native lore, so a superseded turn
            // can take its lore back out again. Normalised here or it would be
            // dropped on every load.
            writes: normalizeRecords(bucket.writes),
            history: (Array.isArray(bucket.history) ? bucket.history : []).filter(isObject).map(clone).slice(-500),
            createdAt: String(bucket.createdAt ?? '').trim() || fallbackTime,
            updatedAt: String(bucket.updatedAt ?? '').trim() || fallbackTime,
        };
    }
}

function normalizeRecords(value) {
    if (!isObject(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, record]) => isObject(record)).map(([id, record]) => [String(id), clone(record)]));
}

function isObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function now() {
    return new Date().toISOString();
}
