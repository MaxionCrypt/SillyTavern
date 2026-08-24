import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'worldSenseV1';
const STORE_VERSION = 1;
export const DEFAULT_WORLD_SENSE_MODEL = 'Xenova/all-MiniLM-L6-v2';

export function getWorldSenseStore() {
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

export function getWorldSenseProfile() { return getWorldSenseStore().profile; }

export function updateWorldSenseProfile(patch = {}) {
    const store = getWorldSenseStore();
    if (patch.modelId !== undefined) store.profile.modelId = String(patch.modelId || '').trim().slice(0, 200) || DEFAULT_WORLD_SENSE_MODEL;
    if (patch.warmQueryTargetMs !== undefined) store.profile.warmQueryTargetMs = clamp(patch.warmQueryTargetMs, 50, 5000, 500);
    if (patch.supportedBookSize !== undefined) store.profile.supportedBookSize = clamp(patch.supportedBookSize, 10, 5000, 250);
    store.profile.updatedAt = now();
    save();
    return store.profile;
}

export function getWorldSenseIndexState(timelineId) {
    const id = String(timelineId ?? '').trim();
    if (!id) return null;
    const store = getWorldSenseStore();
    return store.indexes[id] ??= indexState(id);
}

export function updateWorldSenseIndexState(timelineId, patch = {}) {
    const state = getWorldSenseIndexState(timelineId);
    if (!state) return null;
    Object.assign(state, patch, { updatedAt: now() });
    save();
    return state;
}

export function saveWorldSenseBenchmark(result) {
    const store = getWorldSenseStore();
    store.benchmark = isObject(result) ? structuredClone(result) : null;
    save();
    return store.benchmark;
}

function emptyStore() {
    return {
        version: STORE_VERSION,
        profile: { modelId: DEFAULT_WORLD_SENSE_MODEL, warmQueryTargetMs: 500, supportedBookSize: 250, updatedAt: now() },
        indexes: {},
        benchmark: null,
    };
}

function indexState(timelineId) {
    return { timelineId, collectionId: '', modelId: '', bookHash: '', hashes: {}, status: 'idle', error: '', updatedAt: now() };
}

function normalizeStore(store) {
    const defaults = emptyStore();
    store.version = STORE_VERSION;
    store.profile = { ...defaults.profile, ...(isObject(store.profile) ? store.profile : {}) };
    store.profile.modelId = String(store.profile.modelId || DEFAULT_WORLD_SENSE_MODEL).trim().slice(0, 200) || DEFAULT_WORLD_SENSE_MODEL;
    store.profile.warmQueryTargetMs = clamp(store.profile.warmQueryTargetMs, 50, 5000, 500);
    store.profile.supportedBookSize = clamp(store.profile.supportedBookSize, 10, 5000, 250);
    store.indexes = isObject(store.indexes) ? store.indexes : {};
    for (const [timelineId, raw] of Object.entries(store.indexes)) {
        store.indexes[timelineId] = { ...indexState(timelineId), ...(isObject(raw) ? raw : {}), timelineId };
        store.indexes[timelineId].hashes = isObject(store.indexes[timelineId].hashes) ? store.indexes[timelineId].hashes : {};
    }
    store.benchmark = isObject(store.benchmark) ? store.benchmark : null;
}

function save() { getContext().saveSettingsDebounced(); }
function now() { return new Date().toISOString(); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
}
