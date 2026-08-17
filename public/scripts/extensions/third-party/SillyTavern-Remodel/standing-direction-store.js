import { getContext } from '../../../st-context.js';

// A direction that was produced and never spoken, kept across reloads.
//
// The Director has no message in the transcript on purpose — one there would
// put its entries, secrets included, into the chat history the Narrator reads
// — so unlike a run, a standing direction has nothing to hang its metadata
// off. It gets its own per-Scene bucket instead, following the same
// settings-bucket shape as director-notes-store.js and retrieval-recall.js.
//
// WHAT IS AT STAKE HERE, because it is not the obvious thing. The expensive
// part of a pass is the Director call; losing that to a reload is annoying.
// The part that has to be right is the ADDRESS BOOK travelling with it: the
// closed set of Variable and Goal names this pass advertised, which is the
// only thing standing between the model and a write to something it was never
// shown. Persisting the direction means persisting that authorization, so this
// store validates on read rather than trusting what it loaded — a record for
// another Scene, from another protocol, or from before the chat moved on is
// dropped instead of spoken.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'standingDirectionV1';
const STORE_VERSION = 1;

function getStandingStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isStore(namespace[SETTINGS_KEY])) namespace[SETTINGS_KEY] = { version: STORE_VERSION, scenes: {} };
    return namespace[SETTINGS_KEY];
}

/**
 * Store one Scene's standing direction, replacing any previous one.
 *
 * At most one per Scene, and that is not a simplification: a second standing
 * direction would mean two unspoken takes competing for the same moment, and
 * nothing in the loop could say which one Continue meant.
 */
export function saveStandingDirection(record) {
    const sceneId = String(record?.sceneId || '');
    if (!sceneId) return null;
    const store = getStandingStore();
    store.scenes[sceneId] = { ...record, sceneId, at: new Date().toISOString() };
    getContext().saveSettingsDebounced();
    return store.scenes[sceneId];
}

/**
 * The Scene's standing direction, or null when there is none this can vouch
 * for. Every rejection below is a case where the record loaded fine and is
 * still not safe to speak.
 *
 * @param {string} sceneId
 * @param {{protocol?: string, chatLength?: number}} [expected]
 *   `protocol` is the direction protocol this build speaks; a record written
 *   by another one describes an envelope shape this code no longer reads.
 *   `chatLength` is how long the chat was when the direction was made; if the
 *   chat has grown, the moment this direction was about is no longer the
 *   moment at the end of the scene.
 */
export function readStandingDirection(sceneId, { protocol = '', chatLength = null } = {}) {
    const record = getStandingStore().scenes[String(sceneId || '')];
    if (!record) return null;
    if (protocol && record.protocol && record.protocol !== protocol) return null;
    // Strictly greater, not different. A shorter chat means messages were
    // deleted from under it, which does not invalidate a direction about the
    // moment that is still at the end — but a longer one means something was
    // said after this direction was made, and it is answering a question the
    // scene has moved past.
    if (chatLength !== null && Number.isFinite(record.chatLength) && chatLength > record.chatLength) return null;
    return record;
}

export function clearStandingDirection(sceneId) {
    const store = getStandingStore();
    const key = String(sceneId || '');
    if (!key || !store.scenes[key]) return false;
    delete store.scenes[key];
    getContext().saveSettingsDebounced();
    return true;
}

/** Timeline deletion cascade. Records carry their Timeline so this needs no Scene list. */
export function clearStandingDirectionsForTimeline(timelineId) {
    const store = getStandingStore();
    const key = String(timelineId || '');
    if (!key) return 0;
    let removed = 0;
    for (const [sceneId, record] of Object.entries(store.scenes)) {
        if (record?.timelineId !== key) continue;
        delete store.scenes[sceneId];
        removed++;
    }
    if (removed) getContext().saveSettingsDebounced();
    return removed;
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && value.scenes && typeof value.scenes === 'object' && !Array.isArray(value.scenes));
}
