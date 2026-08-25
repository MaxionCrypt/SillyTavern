import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'worldSenseV1';
const STORE_VERSION = 2;
export const DEFAULT_WORLD_SENSE_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const WORLD_SENSE_MODES = Object.freeze(['off', 'observe', 'suggest', 'auto-safe']);

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
    if (patch.mode !== undefined) store.profile.mode = WORLD_SENSE_MODES.includes(patch.mode) ? patch.mode : 'suggest';
    if (patch.modelId !== undefined) store.profile.modelId = String(patch.modelId || '').trim().slice(0, 200) || DEFAULT_WORLD_SENSE_MODEL;
    if (patch.warmQueryTargetMs !== undefined) store.profile.warmQueryTargetMs = clamp(patch.warmQueryTargetMs, 50, 5000, 500);
    if (patch.supportedBookSize !== undefined) store.profile.supportedBookSize = clamp(patch.supportedBookSize, 10, 5000, 250);
    if (patch.maxEntries !== undefined) store.profile.maxEntries = clamp(patch.maxEntries, 1, 50, 12);
    if (patch.maxTokens !== undefined) store.profile.maxTokens = clamp(patch.maxTokens, 100, 12000, 1800);
    if (patch.semanticThreshold !== undefined) store.profile.semanticThreshold = clampDecimal(patch.semanticThreshold, 0, 1, 0.30);
    if (patch.semanticOnlyLimit !== undefined) store.profile.semanticOnlyLimit = clamp(patch.semanticOnlyLimit, 1, 20, 3);
    if (patch.autoSafeConfidence !== undefined) store.profile.autoSafeConfidence = clampDecimal(patch.autoSafeConfidence, 0.5, 1, 0.92);
    if (patch.autoSafeOperations !== undefined) store.profile.autoSafeOperations = normalizeAutoSafeOperations(patch.autoSafeOperations);
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

export function saveWorldSenseReceipt(receipt) {
    const store = getWorldSenseStore();
    const saved = isObject(receipt) ? structuredClone(receipt) : null;
    if (!saved) return null;
    store.receipts.push(saved);
    if (store.receipts.length > 100) store.receipts.splice(0, store.receipts.length - 100);
    if (saved.sceneId) store.continuityByScene[String(saved.sceneId)] = (saved.selected || [])
        .filter(({ book, uid }) => book && uid != null)
        .map(({ book, uid }) => ({ book, uid })).slice(0, 20);
    save();
    return saved;
}

export function listWorldSenseReceipts({ sceneId = '' } = {}) {
    const receipts = getWorldSenseStore().receipts;
    return (sceneId ? receipts.filter((item) => item.sceneId === String(sceneId)) : receipts).map((item) => structuredClone(item));
}

export function getWorldSenseContinuity(sceneId) {
    return structuredClone(getWorldSenseStore().continuityByScene[String(sceneId)] || []);
}

function emptyStore() {
    return {
        version: STORE_VERSION,
        profile: { mode: 'suggest', modelId: DEFAULT_WORLD_SENSE_MODEL, warmQueryTargetMs: 500, supportedBookSize: 250, maxEntries: 12, maxTokens: 1800, semanticThreshold: 0.30, semanticOnlyLimit: 3, autoSafeConfidence: 0.92, autoSafeOperations: ['fact.append', 'alias.add', 'entry.link', 'current.set'], updatedAt: now() },
        indexes: {},
        benchmark: null,
        receipts: [],
        continuityByScene: {},
    };
}

function indexState(timelineId) {
    return { timelineId, collectionId: '', modelId: '', bookHash: '', archiveHash: '', hashes: {}, status: 'idle', error: '', updatedAt: now() };
}

function normalizeStore(store) {
    const defaults = emptyStore();
    store.version = STORE_VERSION;
    store.profile = { ...defaults.profile, ...(isObject(store.profile) ? store.profile : {}) };
    store.profile.mode = WORLD_SENSE_MODES.includes(store.profile.mode) ? store.profile.mode : 'suggest';
    store.profile.modelId = String(store.profile.modelId || DEFAULT_WORLD_SENSE_MODEL).trim().slice(0, 200) || DEFAULT_WORLD_SENSE_MODEL;
    store.profile.warmQueryTargetMs = clamp(store.profile.warmQueryTargetMs, 50, 5000, 500);
    store.profile.supportedBookSize = clamp(store.profile.supportedBookSize, 10, 5000, 250);
    store.profile.maxEntries = clamp(store.profile.maxEntries, 1, 50, 12);
    store.profile.maxTokens = clamp(store.profile.maxTokens, 100, 12000, 1800);
    store.profile.semanticThreshold = clampDecimal(store.profile.semanticThreshold, 0, 1, 0.30);
    store.profile.semanticOnlyLimit = clamp(store.profile.semanticOnlyLimit, 1, 20, 3);
    store.profile.autoSafeConfidence = clampDecimal(store.profile.autoSafeConfidence, 0.5, 1, 0.92);
    store.profile.autoSafeOperations = normalizeAutoSafeOperations(store.profile.autoSafeOperations);
    store.indexes = isObject(store.indexes) ? store.indexes : {};
    for (const [timelineId, raw] of Object.entries(store.indexes)) {
        store.indexes[timelineId] = { ...indexState(timelineId), ...(isObject(raw) ? raw : {}), timelineId };
        store.indexes[timelineId].hashes = isObject(store.indexes[timelineId].hashes) ? store.indexes[timelineId].hashes : {};
    }
    store.benchmark = isObject(store.benchmark) ? store.benchmark : null;
    store.receipts = Array.isArray(store.receipts) ? store.receipts.filter(isObject).slice(-100) : [];
    store.continuityByScene = isObject(store.continuityByScene) ? store.continuityByScene : {};
}

function save() { getContext().saveSettingsDebounced(); }
function now() { return new Date().toISOString(); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
}
function clampDecimal(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
function normalizeAutoSafeOperations(values) {
    const allowed = ['fact.append', 'alias.add', 'entry.link', 'current.set'];
    const source = Array.isArray(values) ? values : allowed;
    return [...new Set(source.map((value) => String(value || '').trim()).filter((value) => allowed.includes(value)))];
}
