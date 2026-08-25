import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyArchivistV1';
const STORE_VERSION = 1;
const MAX_EVENTS = 400;

function clone(value) { return value == null ? value : structuredClone(value); }
function createId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function emptyStore() { return { version: STORE_VERSION, timelines: {} }; }

export function getArchivistStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    const current = namespace[SETTINGS_KEY];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
        namespace[SETTINGS_KEY] = emptyStore();
        context.saveSettingsDebounced();
    }
    const store = namespace[SETTINGS_KEY];
    if (!store.timelines || typeof store.timelines !== 'object') store.timelines = {};
    return store;
}

export function saveArchivistStore() { getContext().saveSettingsDebounced(); }

function sceneBucket(store, timelineId, sceneId) {
    const tId = String(timelineId || '');
    const sId = String(sceneId || '');
    const timeline = (store.timelines[tId] ??= { timelineId: tId, scenes: {} });
    if (!timeline.scenes || typeof timeline.scenes !== 'object') timeline.scenes = {};
    const scene = (timeline.scenes[sId] ??= { sceneId: sId, facts: {}, events: [], charStates: {}, beat: null, secrets: {}, eventSeq: 0 });
    scene.facts ??= {};
    scene.events ??= [];
    scene.charStates ??= {};
    scene.secrets ??= {};
    scene.continuity = normalizeContinuitySettings(scene.continuity);
    if (typeof scene.eventSeq !== 'number') scene.eventSeq = scene.events.length;
    return scene;
}

const DEFAULT_CONTINUITY = Object.freeze({ readPrevious: true, shareForward: true, excludedSceneIds: [], pins: [] });

function normalizeContinuitySettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const excludedSceneIds = uniqueStrings(source.excludedSceneIds);
    const pins = (Array.isArray(source.pins) ? source.pins : []).map(normalizeContinuityPin).filter(Boolean);
    return {
        readPrevious: source.readPrevious !== false,
        shareForward: source.shareForward !== false,
        excludedSceneIds,
        pins: [...new Map(pins.map((pin) => [continuityPinKey(pin), pin])).values()],
    };
}

function normalizeContinuityPin(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const sourceSceneId = String(value.sourceSceneId || '').trim();
    const recordType = ['event', 'fact', 'character'].includes(value.recordType) ? value.recordType : '';
    const recordId = String(value.recordId || '').trim();
    return sourceSceneId && recordType && recordId ? { sourceSceneId, recordType, recordId } : null;
}

function continuityPinKey(value) { return `${value.sourceSceneId}:${value.recordType}:${value.recordId}`; }
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))]; }

export function getSceneFact(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.facts[String(key)] ? clone(scene.facts[String(key)]) : null;
}

export function setSceneFact(timelineId, sceneId, key, value, { establishedMsgId = null } = {}) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.facts[k] ? clone(scene.facts[k]) : null;
    scene.facts[k] = { key: k, value, establishedMsgId: establishedMsgId == null ? null : Number(establishedMsgId) };
    saveArchivistStore();
    return { before, after: clone(scene.facts[k]) };
}

export function clearSceneFact(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.facts[k] ? clone(scene.facts[k]) : null;
    if (before) { delete scene.facts[k]; saveArchivistStore(); }
    return before;
}

export function listSceneFacts(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.facts).map(clone);
}

export function recordEvent(timelineId, sceneId, summary, { msgId = null, turnIndex = null } = {}) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const event = {
        id: createId('evt'),
        summary: String(summary || ''),
        msgId: msgId == null ? null : Number(msgId),
        turnIndex: turnIndex == null ? null : Number(turnIndex),
        seq: scene.eventSeq++,
    };
    scene.events.push(event);
    if (scene.events.length > MAX_EVENTS) scene.events.splice(0, scene.events.length - MAX_EVENTS);
    saveArchivistStore();
    return clone(event);
}

export function listEvents(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.events.slice().sort((a, b) => a.seq - b.seq).map(clone);
}

/** Per-Scene controls for timeline-isolated World Sense continuity recall. */
export function getSceneContinuitySettings(timelineId, sceneId) {
    return clone(sceneBucket(getArchivistStore(), timelineId, sceneId).continuity);
}

export function setSceneContinuitySettings(timelineId, sceneId, patch = {}) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    scene.continuity = normalizeContinuitySettings({ ...scene.continuity, ...clone(patch) });
    saveArchivistStore();
    return clone(scene.continuity);
}

export function pinContinuityRecord(timelineId, sceneId, value) {
    const pin = normalizeContinuityPin(value);
    if (!pin) return null;
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    scene.continuity = normalizeContinuitySettings({ ...scene.continuity, pins: [...scene.continuity.pins, pin] });
    saveArchivistStore();
    return clone(pin);
}

export function unpinContinuityRecord(timelineId, sceneId, value) {
    const pin = normalizeContinuityPin(value);
    if (!pin) return false;
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const key = continuityPinKey(pin);
    const before = scene.continuity.pins.length;
    scene.continuity.pins = scene.continuity.pins.filter((item) => continuityPinKey(item) !== key);
    if (scene.continuity.pins.length !== before) saveArchivistStore();
    return scene.continuity.pins.length !== before;
}

/** Detached Timeline Archive snapshot used by World Sense indexing. */
export function listTimelineArchiveScenes(timelineId) {
    const timeline = getArchivistStore().timelines[String(timelineId || '')];
    return Object.values(timeline?.scenes || {}).map((scene) => ({
        ...clone(scene),
        continuity: normalizeContinuitySettings(scene.continuity),
    }));
}

export function setCharStateFacet(timelineId, sceneId, charId, facet, value) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const id = String(charId);
    const record = (scene.charStates[id] ??= { charId: id, facets: {} });
    const before = clone(record);
    record.facets[String(facet)] = value;
    saveArchivistStore();
    return { before, after: clone(record) };
}

export function clearCharStateFacet(timelineId, sceneId, charId, facet) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const id = String(charId);
    const record = scene.charStates[id];
    if (!record || !(String(facet) in record.facets)) return null;
    const before = clone(record);
    delete record.facets[String(facet)];
    if (!Object.keys(record.facets).length) delete scene.charStates[id];
    saveArchivistStore();
    return before;
}

export function listCharStates(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.charStates).map(clone);
}

export function setBeat(timelineId, sceneId, directive, tone = '') {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const before = scene.beat ? clone(scene.beat) : null;
    scene.beat = { directive: String(directive || ''), tone: String(tone || '') };
    saveArchivistStore();
    return { before, after: clone(scene.beat) };
}

export function getBeat(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return scene.beat ? clone(scene.beat) : null;
}

export function setSecret(timelineId, sceneId, key, value) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.secrets[k] ? clone(scene.secrets[k]) : null;
    scene.secrets[k] = { key: k, value };
    saveArchivistStore();
    return { before, after: clone(scene.secrets[k]) };
}

export function clearSecret(timelineId, sceneId, key) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    const k = String(key);
    const before = scene.secrets[k] ? clone(scene.secrets[k]) : null;
    if (before) { delete scene.secrets[k]; saveArchivistStore(); }
    return before;
}

export function listSecrets(timelineId, sceneId) {
    const scene = sceneBucket(getArchivistStore(), timelineId, sceneId);
    return Object.values(scene.secrets).map(clone);
}

export function snapshotArchivistStore() { return clone(getArchivistStore()); }

export function restoreArchivistStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = clone(snapshot) || emptyStore();
    if (save) context.saveSettingsDebounced();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

export function deleteArchivistForTimeline(timelineId) {
    const store = getArchivistStore();
    if (store.timelines[String(timelineId)]) {
        delete store.timelines[String(timelineId)];
        saveArchivistStore();
    }
}
