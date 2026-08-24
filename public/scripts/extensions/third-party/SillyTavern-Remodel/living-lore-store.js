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

function timelineBucket(timelineId) {
    const timestamp = now();
    return { timelineId, book: '', entries: {}, createdAt: timestamp, updatedAt: timestamp };
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
            createdAt: String(bucket.createdAt ?? '').trim() || fallbackTime,
            updatedAt: String(bucket.updatedAt ?? '').trim() || fallbackTime,
        };
    }
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
