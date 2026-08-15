import { RATE_CEIL, RATE_FLOOR, clampRate } from './story-goals-math.js';
import { normalizeOwnerRef } from './variables-store.js';

// Story Goals — the goal data model.
//
// A Story Goal is any outcome someone in the fiction is actively working
// toward, carried by a single number: its Success Rate. Everything else is
// optional depth.
//
// Deliberately NOT here (retired during design):
//   * Standing Advantage — it duplicated what the stat system does better.
//   * Secondary pools    — a goal never owned another character's health. A
//                          reach now names a stat instance to feed, and the
//                          stat store owns that number.
//
// All numeric rules live in story-goals-math.js; this module never invents a
// bound of its own.

export { RATE_CEIL, RATE_FLOOR, clampRate };

export const STORY_GOAL_STATUSES = Object.freeze(['active', 'achieved', 'impossible', 'abandoned']);
export const STORY_GOAL_VISIBILITIES = Object.freeze(['public', 'secret']);
/** Which direction on a Constitution pool counts as winning (spec §6). */
export const STORY_GOAL_WIN_DIRECTIONS = Object.freeze(['drain', 'fill']);
/** A relationship runs one way; A opposing B implies nothing about B (spec §3). */
export const STORY_GOAL_RELATION_TYPES = Object.freeze(['antagonistic', 'sympathetic']);
export const STORY_GOAL_RESOLUTION_KINDS = Object.freeze(['instant', 'tracked']);

/**
 * A Constitution pool: depth behind a goal, so a formidable outcome has to be
 * ground down rather than won on one lucky die.
 *
 * `statRef` optionally points the pool at a character stat instance
 * ({ owner, name }) instead of carrying its own number — that is how a goal
 * targeting someone's wakefulness reads and drains the real stat, rather than
 * keeping a private copy of it.
 */
export function createConstitutionPool({ label = 'Resolve', current = 100, max = 100, winDirection = 'drain', statRef = null } = {}) {
    const ceiling = Math.max(1, Math.round(Number(max) || 1));
    return {
        label: String(label || 'Resolve'),
        max: ceiling,
        current: Math.max(0, Math.min(ceiling, Math.round(Number(current) || 0))),
        winDirection: STORY_GOAL_WIN_DIRECTIONS.includes(winDirection) ? winDirection : 'drain',
        statRef: normalizeStatRef(statRef),
    };
}

/** A stat reference is just owner + name — the same pair the Director uses. */
export function normalizeStatRef(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const owner = String(value.owner || '').trim();
    const name = String(value.name || '').trim();
    return owner && name ? { owner, name } : null;
}

/**
 * Holders are plain strings. A goal can be held by several people at once, and
 * the string is the join key to stat instances — so "Aiden"'s goals and
 * "Aiden"'s HP find each other by name and nothing else.
 */
export function normalizeHolders(value) {
    const list = Array.isArray(value) ? value : [value];
    const seen = new Set();
    const holders = [];
    for (const entry of list) {
        const name = String(entry || '').trim();
        const key = name.toLowerCase();
        if (name && !seen.has(key)) {
            seen.add(key);
            holders.push(name);
        }
    }
    return holders;
}

export function normalizeGoalOwnerRefs(value, legacy = []) {
    const list = Array.isArray(value) ? value : [];
    const fallback = list.length ? [] : normalizeHolders(legacy).map((label) => ({ kind: 'custom', id: legacyOwnerId(label), label }));
    const refs = [...list, ...fallback].map((entry) => normalizeOwnerRef(entry)).filter(Boolean);
    return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
}

export function normalizeGoalResolution(value) {
    const kind = STORY_GOAL_RESOLUTION_KINDS.includes(value?.kind) ? value.kind : 'instant';
    if (kind === 'instant') return { kind: 'instant', variableId: '', field: '', direction: '', completionThreshold: null };
    const direction = value?.direction === 'increase' ? 'increase' : 'decrease';
    const threshold = Number(value?.completionThreshold);
    return {
        kind,
        variableId: String(value?.variableId || value?.variableInstanceId || ''),
        field: String(value?.field || 'value'),
        direction,
        completionThreshold: Number.isFinite(threshold) ? threshold : direction === 'increase' ? 100 : 0,
    };
}

export function createStoryGoal({
    id = null,
    timelineId = '',
    originSceneId = '',
    title = 'Untitled Goal',
    description = '',
    successRate = 30,
    constitution = null,
    holders = [],
    holderRefs = [],
    targetRefs = [],
    resolution = null,
    token = '',
    status = 'active',
    visibility = 'public',
} = {}) {
    const resolvedTitle = String(title || 'Untitled Goal');
    return {
        id: id == null ? createStoryGoalId('goal') : String(id),
        timelineId: String(timelineId || ''),
        originSceneId: String(originSceneId || ''),
        title: resolvedTitle,
        description: String(description || ''),
        successRate: clampRate(successRate),
        // Legacy fields remain readable only long enough for the store migration
        // to externalize them into a typed Variable instance.
        constitution: constitution ? createConstitutionPool(constitution) : null,
        holders: normalizeHolders(holders),
        holderRefs: normalizeGoalOwnerRefs(holderRefs, holders),
        targetRefs: normalizeGoalOwnerRefs(targetRefs),
        resolution: normalizeGoalResolution(resolution),
        // The token is the lorebook activation key for this goal's own rules
        // (spec §10): an entry keyed to it is present exactly while the goal is
        // live, and disappears when it closes, with no manual bookkeeping.
        token: String(token || '') || defaultTokenFor(resolvedTitle),
        status: STORY_GOAL_STATUSES.includes(status) ? status : 'active',
        visibility: STORY_GOAL_VISIBILITIES.includes(visibility) ? visibility : 'public',
        createdAt: now(),
        updatedAt: now(),
    };
}

/**
 * A directional relationship between two goals. `from` opposes or supports
 * `to`; the reverse is a separate record and may not exist, or may differ.
 */
export function createStoryGoalRelation({ id = null, timelineId = '', fromGoalId = '', toGoalId = '', type = 'antagonistic', reason = '' } = {}) {
    const from = String(fromGoalId || '');
    const to = String(toGoalId || '');
    if (!from || !to || from === to) {
        return null;
    }
    return {
        id: id == null ? createStoryGoalId('rel') : String(id),
        timelineId: String(timelineId || ''),
        fromGoalId: from,
        toGoalId: to,
        type: STORY_GOAL_RELATION_TYPES.includes(type) ? type : 'antagonistic',
        reason: String(reason || ''),
        createdAt: now(),
    };
}

/** Present a goal's holders the way they should read in prose and UI. */
export function formatHolders(goal) {
    const holders = goal?.holderRefs?.map((ref) => ref.label) || goal?.holders || [];
    if (!holders.length) {
        return 'Unassigned';
    }
    if (holders.length === 1) {
        return holders[0];
    }
    return `${holders.slice(0, -1).join(', ')} & ${holders[holders.length - 1]}`;
}

// --- internals -------------------------------------------------------------

function defaultTokenFor(title) {
    const slug = String(title || 'goal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return `[${slug || 'goal'}]`;
}

function legacyOwnerId(label) {
    return `legacy-${String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'owner'}`;
}

function createStoryGoalId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}

function now() {
    return new Date().toISOString();
}
