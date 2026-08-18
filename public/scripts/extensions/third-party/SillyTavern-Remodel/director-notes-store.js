import { getContext } from '../../../st-context.js';
import { NARRATOR_VISIBLE_TYPES, STORED_ENTRY_TYPES } from './director-reply.js';

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
 *
 * Two flags describe a Director the user stopped mid-reply. Both are stored
 * rather than dropped, because what it managed to say is still part of this
 * turn's record — the owner may want to read it, keep it, or edit it.
 *
 * - `abandoned`: the take as a whole was cancelled. `readNarratorEntries`
 *   withholds these entirely. A cancelled take produced no message and changed
 *   no state, so promoting its rulings to "settled fact" on the next turn
 *   would let a take the user explicitly discarded legislate over the one that
 *   replaced it.
 * - `incomplete`: this specific entry is where the reply was severed. An
 *   owner-facing detail — it marks a fragment as a fragment in a store the
 *   owner edits by hand.
 */
export function appendDirectorEntries(timelineId, { sceneId, turn, entries } = {}) {
    const id = String(timelineId || '');
    if (!id) return [];
    const scene = String(sceneId || '');
    const turnNumber = Math.floor(Number(turn)) || 0;
    const timestamp = now();
    const stored = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && STORED_ENTRY_TYPES.includes(entry.type))
        .map((entry) => ({
            id: createId('director-entry'),
            sceneId: scene,
            turn: turnNumber,
            at: timestamp,
            type: entry.type,
            text: String(entry.text || ''),
            abandoned: entry.abandoned === true,
            incomplete: entry.incomplete === true,
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
 * The Narrator-facing read: never returns `secret` entries, never returns a
 * cancelled take's entries, and `depth` selects the most recent N turns (not
 * the most recent N entries) of the Scene, so a turn is always delivered whole
 * or not at all.
 *
 * The two exclusions are applied at different points, and the difference is
 * the point. A turn containing a secret still HAPPENED — its other entries are
 * real, its results stand — so it consumes a slot in the depth window and only
 * the secret line is withheld. An `abandoned` turn did not happen at all: the
 * user cancelled it, nothing was generated from it and nothing was stored by
 * it, so it is removed BEFORE the window is counted. Otherwise a cancelled
 * take would push a real turn out of the Narrator's view while contributing
 * nothing in its place.
 */
export function readNarratorEntries(timelineId, { sceneId, depth } = {}) {
    const entries = entriesForScene(timelineId, sceneId).filter((entry) => !entry.abandoned);
    const allowedTurns = turnsForDepth(entries, depth);
    return entries
        // ALLOWLIST. This was `entry.type !== 'secret'`, which could only
        // withhold what it already knew to name — so a secret the Director
        // wrote without the exact tag was not typed `secret`, was not caught,
        // and reached the performer. Anything not positively recognised as
        // performer-safe is withheld now, `unknown` included.
        .filter((entry) => NARRATOR_VISIBLE_TYPES.includes(entry.type) && allowedTurns.has(entry.turn))
        .map(copy);
}

/**
 * The owner-facing read: every entry, including secrets. No depth limit.
 * Named `...ForOwner`, not `readAllEntries`, on purpose: it must not sit one
 * plausible-sounding function name away from `readNarratorEntries` — the
 * entire value of the `secret` type is that it never reaches the Narrator,
 * and a name a future contributor could reach for by mistake while wiring a
 * Narrator-facing feature is not a safe neighbor for that guarantee.
 */
export function readAllEntriesForOwner(timelineId, { sceneId } = {}) {
    return entriesForScene(timelineId, sceneId).map(copy);
}

/**
 * The retrieval-facing read: the last `turns` turns of this Scene, as one blob
 * of text for name matching. Secrets INCLUDED, deliberately.
 *
 * This feeds the Director's own prompt, and the Director owns its own secrets:
 * a `[secret]` noting that Faction Heat is about to matter should pull Faction
 * Heat. That is safe here and nowhere else, because the Narrator never receives
 * Variables or Goals at all — it receives notes, through `readNarratorEntries`,
 * which withholds secrets itself. This is the one place a secret legitimately
 * shapes selection, which is why it is a separate function with the reason
 * written on it rather than a flag on an existing one.
 *
 * Abandoned turns are excluded on the same grounds as everywhere else: a take
 * the user cancelled produced nothing and should not steer what the take that
 * replaces it gets to see.
 */
export function readRetrievalNotes(timelineId, { sceneId, turns = 3 } = {}) {
    const entries = entriesForScene(timelineId, sceneId).filter((entry) => !entry.abandoned);
    const allowedTurns = turnsForDepth(entries, turns);
    return entries.filter((entry) => allowedTurns.has(entry.turn)).map((entry) => entry.text).filter(Boolean).join('\n');
}

/**
 * Mark one turn's entries as a take that produced nothing, so the Narrator
 * stops being shown them. Returns how many entries were marked.
 *
 * ONE WAY on purpose. There is no un-abandon, and `updateDirectorEntry` cannot
 * reach this flag any more than it can reach `type`: a take that produced no
 * message and changed no state did not happen, and the value of that statement
 * is that nothing later can quietly reverse it.
 *
 * Separate from `appendDirectorEntries` because the outcome is not known when
 * the entries are written. The Director's reply has to be in the store before
 * the Narrator generates from it, which is several steps before anyone can say
 * whether this pass produced anything — so the entries go in first and the
 * turn is marked afterwards, by whichever exit the pass actually takes.
 */
export function abandonDirectorTurn(timelineId, { sceneId, turn } = {}) {
    const bucket = getTimelineNotesState(String(timelineId || ''), { create: false });
    if (!bucket) return 0;
    const scene = String(sceneId || '');
    const turnNumber = Math.floor(Number(turn));
    if (!Number.isFinite(turnNumber)) return 0;
    let marked = 0;
    for (const entry of Object.values(bucket.entries)) {
        if (!entry || entry.sceneId !== scene || entry.turn !== turnNumber || entry.abandoned) continue;
        entry.abandoned = true;
        marked++;
    }
    if (!marked) return 0;
    bucket.updatedAt = now();
    saveDirectorNotesStore();
    return marked;
}

/**
 * Edit an entry's text in place. The patch only reads `text` — `type` is
 * deliberately never consulted, even if present on the patch object — because
 * a `secret` silently becoming a `note` (or any other retype) would move it
 * across the one boundary this store exists to enforce. Returns the updated
 * entry, or null if it doesn't exist.
 */
export function updateDirectorEntry(timelineId, entryId, { text } = {}) {
    const bucket = getTimelineNotesState(String(timelineId || ''), { create: false });
    const id = String(entryId || '');
    const entry = bucket?.entries?.[id];
    if (!entry) return null;
    if (text !== undefined) entry.text = String(text);
    bucket.updatedAt = now();
    saveDirectorNotesStore();
    return copy(entry);
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
