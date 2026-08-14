import { getContext } from '../../../st-context.js';
import { clampRate } from './story-goals-math.js';
import {
    STORY_GOAL_RELATION_TYPES,
    STORY_GOAL_STATUSES,
    STORY_GOAL_VISIBILITIES,
    createConstitutionPool,
    createStoryGoal,
    createStoryGoalRelation,
    normalizeGoalOwnerRefs,
    normalizeGoalResolution,
    normalizeHolders,
} from './story-goals-model.js';
import {
    createVariableDefinition,
    createVariableInstance,
    findVariableInstance,
    getVariableDefinition,
    normalizeOwnerRef,
} from './story-variables-store.js';

// Canonical Story Goals persistence. Goals and relationships belong to a
// Timeline; Scenes contain only presentation state and links to those goals.
// V2 was scene-owned prototype storage and is deliberately not promoted.

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyGoalsV3';
const RETIRED_SETTINGS_KEYS = Object.freeze(['storyGoalsV1', 'storyGoalsV2']);
const STORE_VERSION = 2;
const LINK_STATES = Object.freeze(['active', 'background', 'hidden']);

export function getStoryGoalsStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    let changed = false;
    for (const key of RETIRED_SETTINGS_KEYS) {
        if (Object.hasOwn(namespace, key)) {
            delete namespace[key];
            changed = true;
        }
    }
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = emptyStore();
        changed = true;
    }
    changed = normalizeStore(namespace[SETTINGS_KEY]) || changed;
    changed = migrateEmbeddedConstitutions(namespace[SETTINGS_KEY]) || changed;
    if (changed) saveStoryGoalsStore();
    return namespace[SETTINGS_KEY];
}

export function saveStoryGoalsStore() {
    getContext().saveSettingsDebounced();
}

export function snapshotStoryGoalsStore() {
    return copy(getStoryGoalsStore());
}

export function restoreStoryGoalsStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = copy(snapshot);
    normalizeStore(context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY]);
    if (save) saveStoryGoalsStore();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

export function getTimelineGoalState(timelineId, { create = true } = {}) {
    const store = getStoryGoalsStore();
    const id = String(timelineId || '');
    if (!id) return null;
    if (!store.timelines[id] && create) {
        store.timelines[id] = timelineState(id);
        saveStoryGoalsStore();
    }
    return store.timelines[id] || null;
}

export function getSceneGoalState(sceneId, { timelineId = '', create = true } = {}) {
    const store = getStoryGoalsStore();
    const id = String(sceneId || '');
    if (!id) return null;
    const existing = store.scenes[id];
    if (existing) return timelineId && existing.timelineId !== String(timelineId) ? null : existing;
    if (!create || !timelineId) return null;
    getTimelineGoalState(timelineId);
    store.scenes[id] = sceneState(id, String(timelineId));
    saveStoryGoalsStore();
    return store.scenes[id];
}

export function updateSceneGoalState(sceneId, patch = {}, { timelineId = '' } = {}) {
    const state = getSceneGoalState(sceneId, { timelineId, create: true });
    if (!state) return null;
    if (patch.enabled !== undefined) state.enabled = Boolean(patch.enabled);
    if (patch.boardOpen !== undefined) state.boardOpen = Boolean(patch.boardOpen);
    if (patch.revealSecrets !== undefined) state.revealSecrets = Boolean(patch.revealSecrets);
    state.updatedAt = now();
    saveStoryGoalsStore();
    return state;
}

export function nextStoryGoalTurn(sceneId, { timelineId = '' } = {}) {
    const state = getSceneGoalState(sceneId, { timelineId, create: true });
    if (!state) return null;
    state.turnCounter += 1;
    state.updatedAt = now();
    saveStoryGoalsStore();
    return `goal-turn-${state.sceneId}-${state.turnCounter}`;
}

export function getStoryGoal(goalId) {
    return getStoryGoalsStore().goals[String(goalId || '')] || null;
}

export function getTimelineGoals(timelineId, { includeResolved = true } = {}) {
    const store = getStoryGoalsStore();
    const state = getTimelineGoalState(timelineId, { create: false });
    return state ? state.goalIds.map((id) => store.goals[id]).filter(Boolean).filter((goal) => includeResolved || goal.status === 'active') : [];
}

export function getSceneGoalLinks(sceneId) {
    const state = getSceneGoalState(sceneId, { create: false });
    return state ? Object.values(state.links).map(copy) : [];
}

export function getSceneGoals(sceneId, { includeResolved = true, states = ['active'] } = {}) {
    const store = getStoryGoalsStore();
    const scene = getSceneGoalState(sceneId, { create: false });
    if (!scene) return [];
    const allowed = new Set((Array.isArray(states) ? states : [states]).filter((state) => LINK_STATES.includes(state)));
    return Object.values(scene.links)
        .filter((link) => allowed.has(link.state))
        .map((link) => store.goals[link.goalId])
        .filter(Boolean)
        .filter((goal) => includeResolved || goal.status === 'active');
}

export function createTimelineGoal(timelineId, input = {}, { sceneId = '', actor = 'user', reason = '' } = {}) {
    const timeline = getTimelineGoalState(timelineId);
    if (!timeline) return null;
    const store = getStoryGoalsStore();
    const originSceneId = String(input.originSceneId || sceneId || '');
    const goal = createStoryGoal({ ...input, timelineId: timeline.timelineId, originSceneId });
    store.goals[goal.id] = goal;
    timeline.goalIds.push(goal.id);
    if (originSceneId) linkGoalToScene(originSceneId, goal.id, 'active', { timelineId: timeline.timelineId, recordEvent: false });
    appendEvent({ goalId: goal.id, timelineId: timeline.timelineId, sceneId: originSceneId, type: 'goal.created', after: goal, actor, reason }, false);
    saveStoryGoalsStore();
    return goal;
}

// Scene-oriented adapter retained for callers that create and link in one step.
export function createSceneGoal(sceneId, input = {}) {
    const scene = getSceneGoalState(sceneId, { timelineId: input.timelineId, create: Boolean(input.timelineId) });
    return scene ? createTimelineGoal(scene.timelineId, input, { sceneId, actor: input.actor || 'director', reason: input.reason || '' }) : null;
}

export function updateStoryGoal(goalId, patch = {}, context = {}) {
    const goal = getStoryGoal(goalId);
    if (!goal) return null;
    const before = copy(goal);
    if (typeof patch.title === 'string' && patch.title.trim()) goal.title = patch.title.trim();
    if (typeof patch.description === 'string') goal.description = patch.description;
    if (patch.successRate !== undefined) goal.successRate = clampRate(patch.successRate);
    if (patch.holders !== undefined) goal.holders = normalizeHolders(patch.holders);
    if (patch.holderRefs !== undefined) goal.holderRefs = normalizeGoalOwnerRefs(patch.holderRefs, goal.holders);
    if (patch.targetRefs !== undefined) goal.targetRefs = normalizeGoalOwnerRefs(patch.targetRefs);
    if (patch.resolution !== undefined) goal.resolution = normalizeGoalResolution(patch.resolution);
    if (typeof patch.token === 'string' && patch.token.trim()) goal.token = patch.token.trim();
    if (STORY_GOAL_STATUSES.includes(patch.status)) goal.status = patch.status;
    if (STORY_GOAL_VISIBILITIES.includes(patch.visibility)) goal.visibility = patch.visibility;
    if ('constitution' in patch) goal.constitution = patch.constitution ? createConstitutionPool(patch.constitution) : null;
    goal.updatedAt = now();
    appendEvent({ goalId: goal.id, timelineId: goal.timelineId, sceneId: context.sceneId, turnId: context.turnId, type: context.type || 'goal.updated', before, after: goal, reason: context.reason, actor: context.actor || 'system' }, false);
    saveStoryGoalsStore();
    return goal;
}

export function deleteStoryGoal(goalId, context = {}) {
    const store = getStoryGoalsStore();
    const goal = getStoryGoal(goalId);
    if (!goal) return false;
    const timeline = store.timelines[goal.timelineId];
    if (timeline) {
        timeline.goalIds = timeline.goalIds.filter((id) => id !== goal.id);
        for (const relationId of [...timeline.relationIds]) {
            const relation = store.relations[relationId];
            if (!relation || relation.fromGoalId === goal.id || relation.toGoalId === goal.id) {
                delete store.relations[relationId];
                timeline.relationIds = timeline.relationIds.filter((id) => id !== relationId);
            }
        }
    }
    for (const scene of Object.values(store.scenes)) delete scene.links[goal.id];
    appendEvent({ goalId: goal.id, timelineId: goal.timelineId, sceneId: context.sceneId, type: 'goal.deleted', before: goal, actor: context.actor || 'user', reason: context.reason }, false);
    delete store.goals[goal.id];
    saveStoryGoalsStore();
    return true;
}

export function linkGoalToScene(sceneId, goalId, state = 'active', { timelineId = '', recordEvent = true } = {}) {
    const goal = getStoryGoal(goalId);
    const resolvedTimelineId = String(timelineId || goal?.timelineId || '');
    const scene = getSceneGoalState(sceneId, { timelineId: resolvedTimelineId, create: true });
    if (!goal || !scene || goal.timelineId !== scene.timelineId) return null;
    const previous = scene.links[goal.id] || null;
    const timestamp = now();
    const link = { sceneId: scene.sceneId, goalId: goal.id, state: LINK_STATES.includes(state) ? state : 'active', linkedAt: previous?.linkedAt || timestamp, updatedAt: timestamp };
    scene.links[goal.id] = link;
    scene.updatedAt = timestamp;
    if (recordEvent) {
        appendEvent({ goalId: goal.id, timelineId: goal.timelineId, sceneId: scene.sceneId, type: previous ? 'scene-link.updated' : 'scene-link.created', before: previous, after: link, actor: 'user' }, false);
        saveStoryGoalsStore();
    }
    return copy(link);
}

export function unlinkGoalFromScene(sceneId, goalId, { recordEvent = true } = {}) {
    const scene = getSceneGoalState(sceneId, { create: false });
    const link = scene?.links?.[String(goalId || '')];
    if (!scene || !link) return false;
    delete scene.links[link.goalId];
    scene.updatedAt = now();
    if (recordEvent) {
        appendEvent({ goalId: link.goalId, timelineId: scene.timelineId, sceneId: scene.sceneId, type: 'scene-link.deleted', before: link, actor: 'user' }, false);
        saveStoryGoalsStore();
    }
    return true;
}

export function getTimelineGoalRelations(timelineId) {
    const store = getStoryGoalsStore();
    const timeline = getTimelineGoalState(timelineId, { create: false });
    return timeline ? timeline.relationIds.map((id) => store.relations[id]).filter(Boolean) : [];
}

export function getSceneGoalRelations(sceneId) {
    const scene = getSceneGoalState(sceneId, { create: false });
    if (!scene) return [];
    const linked = new Set(Object.keys(scene.links));
    return getTimelineGoalRelations(scene.timelineId).filter((relation) => linked.has(relation.fromGoalId) && linked.has(relation.toGoalId));
}

export function getGoalRelations(goalId, { direction = 'either' } = {}) {
    const goal = getStoryGoal(goalId);
    if (!goal) return [];
    return getTimelineGoalRelations(goal.timelineId).filter((relation) => direction === 'from'
        ? relation.fromGoalId === goal.id
        : direction === 'to'
            ? relation.toGoalId === goal.id
            : relation.fromGoalId === goal.id || relation.toGoalId === goal.id);
}

export function createTimelineGoalRelation(timelineId, fromGoalId, toGoalId, type = 'antagonistic', reason = '', context = {}) {
    const store = getStoryGoalsStore();
    const timeline = getTimelineGoalState(timelineId);
    const from = getStoryGoal(fromGoalId);
    const to = getStoryGoal(toGoalId);
    if (!timeline || !from || !to || from.timelineId !== timeline.timelineId || to.timelineId !== timeline.timelineId) return null;
    const existing = getTimelineGoalRelations(timeline.timelineId).find((relation) => relation.fromGoalId === from.id && relation.toGoalId === to.id);
    if (existing) {
        const before = copy(existing);
        existing.type = STORY_GOAL_RELATION_TYPES.includes(type) ? type : existing.type;
        existing.reason = String(reason || existing.reason || '');
        appendEvent({ goalId: from.id, timelineId, sceneId: context.sceneId, type: 'relationship.updated', before, after: existing, actor: context.actor || 'system', reason }, false);
        saveStoryGoalsStore();
        return existing;
    }
    const relation = createStoryGoalRelation({ timelineId, fromGoalId: from.id, toGoalId: to.id, type, reason });
    if (!relation) return null;
    store.relations[relation.id] = relation;
    timeline.relationIds.push(relation.id);
    appendEvent({ goalId: from.id, timelineId, sceneId: context.sceneId, type: 'relationship.created', after: relation, actor: context.actor || 'system', reason }, false);
    saveStoryGoalsStore();
    return relation;
}

export function createSceneGoalRelation(sceneId, fromGoalId, toGoalId, type = 'antagonistic', reason = '') {
    const scene = getSceneGoalState(sceneId, { create: false });
    return scene ? createTimelineGoalRelation(scene.timelineId, fromGoalId, toGoalId, type, reason, { sceneId, actor: 'director' }) : null;
}

export function deleteStoryGoalRelation(relationId, context = {}) {
    const store = getStoryGoalsStore();
    const relation = store.relations[String(relationId || '')];
    if (!relation) return false;
    const timeline = store.timelines[relation.timelineId];
    if (timeline) timeline.relationIds = timeline.relationIds.filter((id) => id !== relation.id);
    appendEvent({ goalId: relation.fromGoalId, timelineId: relation.timelineId, sceneId: context.sceneId, type: 'relationship.deleted', before: relation, actor: context.actor || 'user', reason: context.reason }, false);
    delete store.relations[relation.id];
    saveStoryGoalsStore();
    return true;
}

export function addStoryGoalEvent(input = {}) {
    const event = appendEvent(input, true);
    return event ? copy(event) : null;
}

export function getTimelineGoalEvents(timelineId) {
    const store = getStoryGoalsStore();
    const timeline = getTimelineGoalState(timelineId, { create: false });
    return timeline ? timeline.eventIds.map((id) => store.events[id]).filter(Boolean).map(copy) : [];
}

export function getGoalEvents(goalId) {
    const goal = getStoryGoal(goalId);
    return goal ? getTimelineGoalEvents(goal.timelineId).filter((event) => event.goalId === goal.id) : [];
}

export function queuePendingOps(sceneId, ops = [], { summary = '', timelineId = '' } = {}) {
    const state = getSceneGoalState(sceneId, { timelineId, create: Boolean(timelineId) });
    if (!state || !ops.length) return [];
    const queued = ops.map((op) => ({ id: createId('pending'), summary: String(summary || ''), op: copy(op), createdAt: now() }));
    state.pendingOps.push(...queued);
    state.updatedAt = now();
    saveStoryGoalsStore();
    return queued;
}

export function getPendingOps(sceneId) {
    return getSceneGoalState(sceneId, { create: false })?.pendingOps || [];
}

export function takePendingOp(sceneId, pendingId) {
    const state = getSceneGoalState(sceneId, { create: false });
    if (!state) return null;
    const entry = state.pendingOps.find((item) => item.id === String(pendingId || ''));
    if (!entry) return null;
    state.pendingOps = state.pendingOps.filter((item) => item.id !== entry.id);
    saveStoryGoalsStore();
    return entry;
}

// Deleting a scene removes only its link/presentation record. Goal history and
// state survive in the Timeline. Deleting the Timeline is the cascade boundary.
export function detachStoryGoalsFromScene(sceneId) {
    const store = getStoryGoalsStore();
    if (!store.scenes[String(sceneId || '')]) return;
    delete store.scenes[String(sceneId || '')];
    saveStoryGoalsStore();
}

export const deleteStoryGoalsForScene = detachStoryGoalsFromScene;

export function deleteStoryGoalsForTimeline(timelineId) {
    const store = getStoryGoalsStore();
    const id = String(timelineId || '');
    const timeline = store.timelines[id];
    if (!timeline) return;
    for (const goalId of timeline.goalIds) delete store.goals[goalId];
    for (const relationId of timeline.relationIds) delete store.relations[relationId];
    for (const eventId of timeline.eventIds) delete store.events[eventId];
    for (const [sceneId, scene] of Object.entries(store.scenes)) if (scene.timelineId === id) delete store.scenes[sceneId];
    delete store.timelines[id];
    saveStoryGoalsStore();
}

function appendEvent(input, save) {
    const store = getStoryGoalsStore();
    const timeline = getTimelineGoalState(input.timelineId, { create: false });
    if (!timeline) return null;
    const event = {
        id: createId('goal-event'), goalId: String(input.goalId || ''), timelineId: timeline.timelineId,
        sceneId: String(input.sceneId || ''), turnId: String(input.turnId || ''), type: String(input.type || 'goal.note'),
        before: copy(input.before ?? null), after: copy(input.after ?? null), reason: String(input.reason || ''),
        actor: String(input.actor || 'system'), createdAt: now(),
    };
    store.events[event.id] = event;
    timeline.eventIds.push(event.id);
    timeline.updatedAt = event.createdAt;
    if (save) saveStoryGoalsStore();
    return event;
}

function emptyStore() {
    return { version: STORE_VERSION, timelines: {}, scenes: {}, goals: {}, relations: {}, events: {} };
}

function timelineState(timelineId) {
    const timestamp = now();
    return { timelineId, goalIds: [], relationIds: [], eventIds: [], createdAt: timestamp, updatedAt: timestamp };
}

function sceneState(sceneId, timelineId) {
    const timestamp = now();
    return { sceneId, timelineId, enabled: false, boardOpen: false, revealSecrets: false, turnCounter: 0, links: {}, pendingOps: [], createdAt: timestamp, updatedAt: timestamp };
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && value.timelines && value.scenes && value.goals && value.relations && value.events);
}

function normalizeStore(store) {
    const original = JSON.stringify(store);
    let changed = Number(store.version) !== STORE_VERSION;
    store.version = STORE_VERSION;
    for (const key of ['timelines', 'scenes', 'goals', 'relations', 'events']) {
        if (!store[key] || typeof store[key] !== 'object' || Array.isArray(store[key])) {
            store[key] = {};
            changed = true;
        }
    }
    for (const [id, raw] of Object.entries(store.goals)) {
        const goal = normalizeGoal({ ...raw, id });
        if (!goal) { delete store.goals[id]; changed = true; } else store.goals[id] = goal;
    }
    for (const [timelineId, raw] of Object.entries(store.timelines)) {
        const state = { ...timelineState(timelineId), ...raw, timelineId };
        state.goalIds = ids(state.goalIds).filter((id) => store.goals[id]?.timelineId === timelineId);
        state.relationIds = ids(state.relationIds);
        state.eventIds = ids(state.eventIds);
        store.timelines[timelineId] = state;
    }
    for (const goal of Object.values(store.goals)) {
        const timeline = store.timelines[goal.timelineId] || (store.timelines[goal.timelineId] = timelineState(goal.timelineId));
        if (!timeline.goalIds.includes(goal.id)) timeline.goalIds.push(goal.id);
    }
    normalizeRelations(store);
    normalizeEvents(store);
    for (const [timelineId, timeline] of Object.entries(store.timelines)) {
        timeline.relationIds = ids(timeline.relationIds).filter((id) => store.relations[id]?.timelineId === timelineId);
        timeline.eventIds = ids(timeline.eventIds).filter((id) => store.events[id]?.timelineId === timelineId);
    }
    for (const [sceneId, raw] of Object.entries(store.scenes)) {
        const timelineId = String(raw?.timelineId || '');
        if (!store.timelines[timelineId]) { delete store.scenes[sceneId]; changed = true; continue; }
        const state = { ...sceneState(sceneId, timelineId), ...raw, sceneId, timelineId };
        state.enabled = Boolean(state.enabled);
        state.boardOpen = Boolean(state.boardOpen);
        state.revealSecrets = Boolean(state.revealSecrets);
        state.turnCounter = Math.max(0, Math.floor(Number(state.turnCounter) || 0));
        state.links = normalizeLinks(state.links, sceneId, timelineId, store.goals);
        state.pendingOps = Array.isArray(state.pendingOps) ? state.pendingOps.filter((entry) => entry?.id && entry?.op) : [];
        store.scenes[sceneId] = state;
    }
    return changed || JSON.stringify(store) !== original;
}

function normalizeGoal(value) {
    if (!value?.id || !value?.timelineId) return null;
    return {
        id: String(value.id), timelineId: String(value.timelineId), originSceneId: String(value.originSceneId || ''),
        title: String(value.title || '').trim() || 'Untitled Goal', description: String(value.description || ''),
        successRate: clampRate(value.successRate ?? 30), constitution: value.constitution ? createConstitutionPool(value.constitution) : null,
        holders: normalizeHolders(value.holders), token: String(value.token || '').trim() || '[goal]',
        holderRefs: normalizeGoalOwnerRefs(value.holderRefs, value.holders), targetRefs: normalizeGoalOwnerRefs(value.targetRefs),
        resolution: normalizeGoalResolution(value.resolution),
        status: STORY_GOAL_STATUSES.includes(value.status) ? value.status : 'active',
        visibility: STORY_GOAL_VISIBILITIES.includes(value.visibility) ? value.visibility : 'public',
        createdAt: value.createdAt || now(), updatedAt: value.updatedAt || now(),
    };
}

function migrateEmbeddedConstitutions(store) {
    let changed = false;
    for (const goal of Object.values(store.goals)) {
        if (!goal.constitution || goal.resolution?.kind === 'tracked') continue;
        const pool = goal.constitution;
        const ownerRef = normalizeOwnerRef({ kind: 'goal', id: goal.id, label: goal.title });
        let definition = getVariableDefinition(`legacy-constitution-${goal.id}`, goal.timelineId);
        if (!definition) {
            definition = createVariableDefinition({
                id: `legacy-constitution-${goal.id}`,
                key: `${goal.title}-constitution`,
                name: pool.label || `${goal.title} Constitution`,
                kind: 'resource',
                summary: 'Migrated from the former embedded Story Goal Constitution pool.',
                defaultValue: pool.current,
                constraints: { minimum: 0, defaultMaximum: pool.max },
            }, { timelineId: goal.timelineId, actor: 'migration' });
        }
        const instance = definition && (findVariableInstance(goal.timelineId, ownerRef, definition.id)
            || createVariableInstance({ timelineId: goal.timelineId, definitionId: definition.id, ownerRef, value: pool.current, maximum: pool.max }, { actor: 'migration' }));
        if (!instance) continue;
        goal.resolution = normalizeGoalResolution({
            kind: 'tracked',
            variableInstanceId: instance.id,
            direction: pool.winDirection === 'fill' ? 'increase' : 'decrease',
            completionThreshold: pool.winDirection === 'fill' ? pool.max : 0,
        });
        goal.constitution = null;
        goal.updatedAt = now();
        changed = true;
    }
    return changed;
}

function normalizeRelations(store) {
    for (const [id, raw] of Object.entries(store.relations)) {
        const from = store.goals[String(raw?.fromGoalId || '')];
        const to = store.goals[String(raw?.toGoalId || '')];
        if (!from || !to || from.timelineId !== to.timelineId || from.id === to.id) { delete store.relations[id]; continue; }
        const relation = { id: String(id), timelineId: from.timelineId, fromGoalId: from.id, toGoalId: to.id, type: STORY_GOAL_RELATION_TYPES.includes(raw.type) ? raw.type : 'antagonistic', reason: String(raw.reason || ''), createdAt: raw.createdAt || now() };
        store.relations[id] = relation;
        const timeline = store.timelines[relation.timelineId];
        if (!timeline.relationIds.includes(relation.id)) timeline.relationIds.push(relation.id);
    }
}

function normalizeEvents(store) {
    for (const [id, raw] of Object.entries(store.events)) {
        const timeline = store.timelines[String(raw?.timelineId || '')];
        if (!timeline) { delete store.events[id]; continue; }
        const event = { id: String(id), goalId: String(raw.goalId || ''), timelineId: timeline.timelineId, sceneId: String(raw.sceneId || ''), turnId: String(raw.turnId || ''), type: String(raw.type || 'goal.note'), before: copy(raw.before ?? null), after: copy(raw.after ?? null), reason: String(raw.reason || ''), actor: String(raw.actor || 'system'), createdAt: raw.createdAt || now() };
        store.events[id] = event;
        if (!timeline.eventIds.includes(event.id)) timeline.eventIds.push(event.id);
    }
}

function normalizeLinks(value, sceneId, timelineId, goals) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [goalId, raw] of Object.entries(value)) {
        if (goals[goalId]?.timelineId !== timelineId) continue;
        result[goalId] = { sceneId, goalId, state: LINK_STATES.includes(raw?.state) ? raw.state : 'active', linkedAt: raw?.linkedAt || now(), updatedAt: raw?.updatedAt || now() };
    }
    return result;
}

function ids(value) { return Array.isArray(value) ? [...new Set(value.filter(Boolean).map(String))] : []; }
function copy(value) { return value == null ? value : structuredClone(value); }
function now() { return new Date().toISOString(); }
function createId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}
