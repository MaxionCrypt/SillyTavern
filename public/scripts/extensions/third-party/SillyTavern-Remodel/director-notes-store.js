import { getContext } from '../../../st-context.js';
import { ENTRY_TYPES } from './director-reply.js';

// Persistence for the Director's typed notebook: the entries `director-reply.js`
// parses out of a free-form reply, kept per Timeline so they survive across
// Scenes and sessions. Follows story-goals-store.js for the settings-bucket
// shape (a per-Timeline bucket under `getContext().extensionSettings`,
// `saveSettingsDebounced()` on write).
//
// Two properties this file exists to hold, not just implement:
//
// - `readNarratorEntries` is the ONLY path the Narrator's prompt-builder is
//   meant to use, and it filters `secret` entries itself. The type's entire
//   value is that a secret never reaches the Narrator; that must not depend
//   on every future call site remembering to filter one out.
// - `depth` counts Director TURNS, not stored entries. A turn can be several
//   entries (e.g. a `ruling` and the `result` that resolves it); handing the
//   Narrator half of one is worse than handing it none, so depth always
//   rounds up to whole turns.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'directorNotesV1';
const STORE_VERSION = 1;

function getDirectorNotesStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = emptyStore();
        saveDirectorNotesStore();
    }
    return namespace[SETTINGS_KEY];
}

function saveDirectorNotesStore() {
    getContext().saveSettingsDebounced();
}

/**
 * Append parsed entries for one Director turn. Entries whose `type` is not
 * one of `ENTRY_TYPES` are dropped rather than stored — an unrecognised type
 * is a sign the reply parser or a caller drifted, not a new kind of note.
 * Returns only the entries that were actually stored, each with its
 * assigned id.
 */
export function appendDirectorEntries(timelineId, { sceneId, turn, entries } = {}) {
    const id = String(timelineId || '');
    if (!id) return [];
    const scene = String(sceneId || '');
    const turnNumber = Math.floor(Number(turn)) || 0;
    const timestamp = now();
    const stored = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && ENTRY_TYPES.includes(entry.type))
        .map((entry) => ({
            id: createId('director-entry'),
            sceneId: scene,
            turn: turnNumber,
            at: timestamp,
            type: entry.type,
            text: String(entry.text || ''),
        }));
    if (!stored.length) return [];
    const bucket = getTimelineNotesState(id, { create: true });
    for (const entry of stored) {
        bucket.entryIds.push(entry.id);
        bucket.entries[entry.id] = entry;
    }
    bucket.updatedAt = timestamp;
    saveDirectorNotesStore();
    return stored.map(copy);
}

/**
 * The Narrator-facing read: never returns `secret` entries, and `depth`
 * selects the most recent N turns (not the most recent N entries) of the
 * Scene, so a turn is always delivered whole or not at all.
 */
export function readNarratorEntries(timelineId, { sceneId, depth } = {}) {
    const entries = entriesForScene(timelineId, sceneId);
    const allowedTurns = turnsForDepth(entries, depth);
    return entries
        .filter((entry) => entry.type !== 'secret' && allowedTurns.has(entry.turn))
        .map(copy);
}

/** The owner-facing read: every entry, including secrets. No depth limit. */
export function readAllEntries(timelineId, { sceneId } = {}) {
    return entriesForScene(timelineId, sceneId).map(copy);
}

export function deleteDirectorEntry(timelineId, entryId) {
    const bucket = getTimelineNotesState(String(timelineId || ''), { create: false });
    const id = String(entryId || '');
    if (!bucket || !bucket.entries[id]) return false;
    delete bucket.entries[id];
    bucket.entryIds = bucket.entryIds.filter((entryIdValue) => entryIdValue !== id);
    bucket.updatedAt = now();
    saveDirectorNotesStore();
    return true;
}

export function clearDirectorNotes(timelineId) {
    const store = getDirectorNotesStore();
    const id = String(timelineId || '');
    if (!store.timelines[id]) return;
    delete store.timelines[id];
    saveDirectorNotesStore();
}

function getTimelineNotesState(timelineId, { create = true } = {}) {
    const store = getDirectorNotesStore();
    if (!timelineId) return null;
    if (!isBucket(store.timelines[timelineId])) {
        if (!create) return null;
        store.timelines[timelineId] = timelineState(timelineId);
    }
    return store.timelines[timelineId];
}

function entriesForScene(timelineId, sceneId) {
    const bucket = getTimelineNotesState(String(timelineId || ''), { create: false });
    if (!bucket) return [];
    const scene = String(sceneId || '');
    return bucket.entryIds.map((id) => bucket.entries[id]).filter(Boolean).filter((entry) => entry.sceneId === scene);
}

/** The set of turn numbers making up the last `depth` turns present, oldest first. */
function turnsForDepth(entries, depth) {
    const turns = [...new Set(entries.map((entry) => entry.turn))].sort((a, b) => a - b);
    const count = Math.max(0, Math.floor(Number(depth)) || 0);
    return new Set(turns.slice(Math.max(0, turns.length - count)));
}

function emptyStore() {
    return { version: STORE_VERSION, timelines: {} };
}

function timelineState(timelineId) {
    const timestamp = now();
    return { timelineId, entryIds: [], entries: {}, createdAt: timestamp, updatedAt: timestamp };
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.timelines && typeof value.timelines === 'object');
}

function isBucket(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.entryIds) && value.entries && typeof value.entries === 'object');
}

function copy(value) { return value == null ? value : structuredClone(value); }
function now() { return new Date().toISOString(); }
function createId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}
