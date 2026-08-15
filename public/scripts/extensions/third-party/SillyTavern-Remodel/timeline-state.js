import { getContext } from '../../../st-context.js';
import { detachStoryGoalsFromScene, deleteStoryGoalsForTimeline } from './story-goals-store.js';
import { deleteVariablesForTimeline } from './variables-store.js';

export const CHAT_METADATA_KEY = 'remodelScene';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'timelineV1';
const STORE_VERSION = 1;

export function getTimelineStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};

    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];

    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = createEmptyStore();
    }

    normalizeStore(namespace[SETTINGS_KEY]);
    return namespace[SETTINGS_KEY];
}

export function saveTimelineStore() {
    getContext().saveSettingsDebounced();
}

export function createTimeline(title = 'New Timeline') {
    const store = getTimelineStore();
    const timeline = {
        id: createId('timeline'),
        title: normalizeText(title, 'New Timeline'),
        description: '',
        thumbnail: null,
        arcIds: [],
        activeArcId: null,
        activeSceneId: null,
        // { [slotName]: { text, sourceSceneId, sourceSceneTitle, wordMode, wordCount, savedAt } } —
        // named prior-scene-text snippets a user has explicitly fetched and
        // saved (see the Prior Text drawer in timeline-spine.js), each exposed
        // as a synchronous {{inserted_text_<slotName>}} macro.
        insertedTextSlots: {},
        // A lorebook bound to the whole timeline, so every Scene in it shares
        // the same world without binding the book to each document by hand.
        // Null means the timeline adds none of its own; global, character and
        // persona lorebooks still apply as usual.
        lorebookName: null,
        createdAt: now(),
        updatedAt: now(),
    };

    store.timelines[timeline.id] = timeline;
    store.timelineIds.push(timeline.id);
    store.activeTimelineId = timeline.id;
    saveTimelineStore();
    return timeline;
}

// Slot names are dynamic keys (not a fixed field), so they're managed via
// dedicated functions rather than folded into sanitizeTimelinePatch's
// fixed-field allowlist.
export function setInsertedTextSlot(timelineId, slotName, slotData) {
    const store = getTimelineStore();
    const timeline = store.timelines[timelineId];

    if (!timeline) {
        return null;
    }

    timeline.insertedTextSlots ??= {};
    timeline.insertedTextSlots[slotName] = { ...slotData, savedAt: now() };
    touchTimeline(timelineId);
    saveTimelineStore();
    return timeline.insertedTextSlots[slotName];
}

export function deleteInsertedTextSlot(timelineId, slotName) {
    const store = getTimelineStore();
    const timeline = store.timelines[timelineId];

    if (!timeline?.insertedTextSlots) {
        return;
    }

    delete timeline.insertedTextSlots[slotName];
    touchTimeline(timelineId);
    saveTimelineStore();
}

export function updateTimeline(timelineId, patch) {
    const store = getTimelineStore();
    const timeline = store.timelines[timelineId];

    if (!timeline) {
        return null;
    }

    Object.assign(timeline, sanitizeTimelinePatch(patch), { updatedAt: now() });
    saveTimelineStore();
    return timeline;
}

export function deleteTimeline(timelineId) {
    const store = getTimelineStore();
    const timeline = store.timelines[timelineId];

    if (!timeline) {
        return;
    }

    for (const arcId of timeline.arcIds) {
        const arc = store.arcs[arcId];

        for (const sceneId of arc?.sceneIds || []) {
            delete store.scenes[sceneId];
            detachStoryGoalsFromScene(sceneId);
        }

        delete store.arcs[arcId];
    }

    delete store.timelines[timelineId];
    deleteStoryGoalsForTimeline(timelineId);
    deleteVariablesForTimeline(timelineId);
    store.timelineIds = store.timelineIds.filter((id) => id !== timelineId);
    store.activeTimelineId = store.activeTimelineId === timelineId ? store.timelineIds[0] || null : store.activeTimelineId;
    saveTimelineStore();
}

export function createArc(timelineId, title = 'New Arc') {
    const store = getTimelineStore();
    const timeline = store.timelines[timelineId];

    if (!timeline) {
        return null;
    }

    const arc = {
        id: createId('arc'),
        timelineId,
        title: normalizeText(title, 'New Arc'),
        summary: '',
        sceneIds: [],
        createdAt: now(),
        updatedAt: now(),
    };

    store.arcs[arc.id] = arc;
    timeline.arcIds.push(arc.id);
    timeline.activeArcId = arc.id;
    timeline.updatedAt = now();
    saveTimelineStore();
    return arc;
}

export function updateArc(arcId, patch) {
    const store = getTimelineStore();
    const arc = store.arcs[arcId];

    if (!arc) {
        return null;
    }

    Object.assign(arc, sanitizeArcPatch(patch), { updatedAt: now() });
    touchTimeline(arc.timelineId);
    saveTimelineStore();
    return arc;
}

export function deleteArc(arcId) {
    const store = getTimelineStore();
    const arc = store.arcs[arcId];
    const timeline = store.timelines[arc?.timelineId];

    if (!arc || !timeline) {
        return;
    }

    for (const sceneId of arc.sceneIds) {
        delete store.scenes[sceneId];
        detachStoryGoalsFromScene(sceneId);
    }

    delete store.arcs[arcId];
    timeline.arcIds = timeline.arcIds.filter((id) => id !== arcId);
    timeline.activeArcId = timeline.activeArcId === arcId ? timeline.arcIds[0] || null : timeline.activeArcId;
    timeline.activeSceneId = arc.sceneIds.includes(timeline.activeSceneId) ? null : timeline.activeSceneId;
    touchTimeline(timeline.id);
    saveTimelineStore();
}

export function createScene(arcId, mode = 'roleplay', title = 'New Scene') {
    const store = getTimelineStore();
    const arc = store.arcs[arcId];
    const timeline = store.timelines[arc?.timelineId];

    if (!arc || !timeline) {
        return null;
    }

    const scene = {
        id: createId('scene'),
        timelineId: arc.timelineId,
        arcId,
        title: normalizeText(title, mode === 'story' ? 'New Story Scene' : 'New Roleplay Scene'),
        mode: mode === 'story' ? 'story' : 'roleplay',
        linkedChat: null,
        // Story scenes bind to a StoryDoc (redesigned document Story mode);
        // roleplay scenes use linkedChat. Null until bound.
        storyDocId: null,
        // Optional per-Scene Prompt Studio overrides. Null means inherit the
        // account-wide default for this Scene mode and API boundary.
        promptRecipeIds: { chat: null, text: null },
        // How the Scene is staged — who speaks, and in what order.
        //   'free'     : today's behaviour. The group's own activation strategy
        //                decides; no pipeline, no injections.
        //   'directed' : the bound roles run in order each turn.
        // Defaults to 'free' so nothing about an ordinary Scene changes.
        staging: 'free',
        // Ordered job -> cast-member bindings for a directed Scene, e.g.
        // [{ job: 'director', characterId: 3 }, { job: 'narrator', characterId: 1 }].
        // Bound explicitly by the user; never matched by character name.
        roles: [],
        // How the Scene's cast is shaped.
        //   'open' : any number of cards; the Director seat is assigned after
        //            the fact from whoever is in the group. Every Scene created
        //            before the two-seat model is this, and keeps behaving
        //            exactly as it did.
        //   'duet' : exactly two bound cards, chosen when the Scene is cast —
        //            one Director, one Narrator. The cast is not editable from
        //            the Scene, because the two seats ARE the Scene.
        // Set at creation; normalizeStore never upgrades an existing Scene.
        ensemble: 'open',
        // Continuous direction state. A native character card may occupy the
        // non-speaking Roleplay Director seat while narratorRef points at a
        // stable visible performer identity. Direction records are extension
        // UI state only; they are never native chat messages.
        liveDirection: normalizeLiveDirection(),
        status: 'unbound',
        summary: '',
        summaryUpdatedAt: null,
        createdAt: now(),
        updatedAt: now(),
    };

    store.scenes[scene.id] = scene;
    arc.sceneIds.push(scene.id);
    arc.updatedAt = now();
    timeline.activeArcId = arcId;
    // Do NOT auto-activate the new scene: the row should appear in the arc column,
    // not immediately pop the scene inspector open below (which hid the arcs).
    touchTimeline(timeline.id);
    saveTimelineStore();
    return scene;
}

export function updateScene(sceneId, patch) {
    const store = getTimelineStore();
    const scene = store.scenes[sceneId];

    if (!scene) {
        return null;
    }

    Object.assign(scene, sanitizeScenePatch(patch), { updatedAt: now() });
    touchArc(scene.arcId);
    touchTimeline(scene.timelineId);
    saveTimelineStore();
    return scene;
}

export function deleteScene(sceneId) {
    const store = getTimelineStore();
    const scene = store.scenes[sceneId];
    const arc = store.arcs[scene?.arcId];
    const timeline = store.timelines[scene?.timelineId];

    if (!scene || !arc || !timeline) {
        return;
    }

    delete store.scenes[sceneId];
    detachStoryGoalsFromScene(sceneId);
    arc.sceneIds = arc.sceneIds.filter((id) => id !== sceneId);
    timeline.activeSceneId = timeline.activeSceneId === sceneId ? arc.sceneIds[0] || null : timeline.activeSceneId;
    arc.updatedAt = now();
    touchTimeline(timeline.id);
    saveTimelineStore();
}

export function setActiveTimeline(timelineId) {
    const store = getTimelineStore();

    if (!store.timelines[timelineId]) {
        return null;
    }

    store.activeTimelineId = timelineId;
    saveTimelineStore();
    return store.timelines[timelineId];
}

export function setActiveArc(arcId) {
    const store = getTimelineStore();
    const arc = store.arcs[arcId];
    const timeline = store.timelines[arc?.timelineId];

    if (!arc || !timeline || !timeline.arcIds.includes(arcId)) {
        return null;
    }

    store.activeTimelineId = timeline.id;
    timeline.activeArcId = arcId;
    timeline.updatedAt = now();
    saveTimelineStore();
    return arc;
}

export function setActiveScene(sceneId) {
    const store = getTimelineStore();
    const scene = store.scenes[sceneId];

    if (!scene) {
        return null;
    }

    store.activeTimelineId = scene.timelineId;
    store.timelines[scene.timelineId].activeArcId = scene.arcId;
    store.timelines[scene.timelineId].activeSceneId = scene.id;
    saveTimelineStore();
    return scene;
}

export function getActiveTimeline() {
    const store = getTimelineStore();
    return store.timelines[store.activeTimelineId] || store.timelines[store.timelineIds[0]] || null;
}

export function getScene(sceneId) {
    return getTimelineStore().scenes[sceneId] || null;
}

export function getSceneFromMetadata(metadata) {
    if (!metadata?.sceneId) {
        return null;
    }

    const store = getTimelineStore();
    const scene = store.scenes[metadata.sceneId];

    if (!scene || scene.timelineId !== metadata.timelineId || scene.arcId !== metadata.arcId) {
        return null;
    }

    return scene;
}

function createEmptyStore() {
    return {
        version: STORE_VERSION,
        timelineIds: [],
        timelines: {},
        arcs: {},
        scenes: {},
        activeTimelineId: null,
    };
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.timelineIds));
}

function normalizeStore(store) {
    store.version = STORE_VERSION;
    store.timelines ??= {};
    store.arcs ??= {};
    store.scenes ??= {};
    store.timelineIds = store.timelineIds.filter((id) => store.timelines[id]);
    store.activeTimelineId = store.timelines[store.activeTimelineId] ? store.activeTimelineId : store.timelineIds[0] || null;

    for (const timeline of Object.values(store.timelines)) {
        timeline.arcIds = (timeline.arcIds || []).filter((id) => store.arcs[id]?.timelineId === timeline.id);
        timeline.activeArcId = timeline.arcIds.includes(timeline.activeArcId) ? timeline.activeArcId : timeline.arcIds[0] || null;
        timeline.activeSceneId = store.scenes[timeline.activeSceneId]?.timelineId === timeline.id ? timeline.activeSceneId : null;
        timeline.insertedTextSlots ??= {}; // backward-compat for Timelines saved before this field existed
        // Backward-compat for Timelines saved before they could carry a lorebook.
        timeline.lorebookName = timeline.lorebookName ? String(timeline.lorebookName) : null;
    }

    for (const arc of Object.values(store.arcs)) {
        arc.sceneIds = (arc.sceneIds || []).filter((id) => store.scenes[id]?.arcId === arc.id);
    }

    for (const scene of Object.values(store.scenes)) {
        // Backward-compat for scenes saved before story scenes bound to a
        // StoryDoc instead of a chat.
        scene.storyDocId ??= null;
        scene.promptRecipeIds = normalizePromptRecipeIds(scene.promptRecipeIds);
        // Backward-compat for scenes saved before staging existed. Every one of
        // them must keep behaving exactly as it did, so they default to 'free'.
        scene.staging = normalizeStaging(scene.staging);
        // Absent means the Scene predates the two-seat model, so it stays
        // 'open'. Deliberately not inferred from member count: a two-card
        // Scene cast under the old flow is still an open cast the user may
        // add to, and silently locking it would take that away.
        scene.ensemble = normalizeEnsemble(scene.ensemble);
        scene.roles = normalizeSceneRoles(scene.roles);
        scene.liveDirection = normalizeLiveDirection(scene.liveDirection, scene.roles);
        scene.roles = scene.roles.filter((binding) => binding.job === 'narrator');
    }
}

function sanitizeTimelinePatch(patch) {
    return {
        ...(patch.title !== undefined ? { title: normalizeText(patch.title, 'Untitled Timeline') } : {}),
        ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
        ...(patch.thumbnail !== undefined ? { thumbnail: patch.thumbnail ? String(patch.thumbnail) : null } : {}),
        ...(patch.lorebookName !== undefined ? { lorebookName: patch.lorebookName ? String(patch.lorebookName) : null } : {}),
    };
}

function sanitizeArcPatch(patch) {
    return {
        ...(patch.title !== undefined ? { title: normalizeText(patch.title, 'Untitled Arc') } : {}),
        ...(patch.summary !== undefined ? { summary: String(patch.summary) } : {}),
    };
}

function sanitizeScenePatch(patch) {
    return {
        ...(patch.title !== undefined ? { title: normalizeText(patch.title, 'Untitled Scene') } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode === 'story' ? 'story' : 'roleplay' } : {}),
        ...(patch.status !== undefined ? { status: String(patch.status) } : {}),
        ...(patch.summary !== undefined ? { summary: String(patch.summary) } : {}),
        ...(patch.summaryUpdatedAt !== undefined ? { summaryUpdatedAt: patch.summaryUpdatedAt ? String(patch.summaryUpdatedAt) : null } : {}),
        ...(patch.linkedChat !== undefined ? { linkedChat: patch.linkedChat || null } : {}),
        // Story scenes bind to a StoryDoc (the redesigned document-editor Story
        // mode) instead of a chat file; roleplay scenes keep linkedChat.
        ...(patch.storyDocId !== undefined ? { storyDocId: patch.storyDocId || null } : {}),
        ...(patch.promptRecipeIds !== undefined ? { promptRecipeIds: normalizePromptRecipeIds(patch.promptRecipeIds) } : {}),
        ...(patch.staging !== undefined ? { staging: normalizeStaging(patch.staging) } : {}),
        ...(patch.ensemble !== undefined ? { ensemble: normalizeEnsemble(patch.ensemble) } : {}),
        ...(patch.roles !== undefined ? { roles: normalizeSceneRoles(patch.roles) } : {}),
        ...(patch.liveDirection !== undefined ? { liveDirection: normalizeLiveDirection(patch.liveDirection) } : {}),
    };
}

function normalizePromptRecipeIds(value) {
    return {
        chat: value?.chat ? String(value.chat) : null,
        text: value?.text ? String(value.text) : null,
    };
}

/** The jobs a bound cast member can hold in a directed Scene. */
export const SCENE_STAGINGS = Object.freeze(['free', 'directed']);
export const SCENE_ROLE_JOBS = Object.freeze(['director', 'narrator']);
export const SCENE_ENSEMBLES = Object.freeze(['open', 'duet']);

function normalizeStaging(value) {
    return SCENE_STAGINGS.includes(value) ? value : 'free';
}

function normalizeEnsemble(value) {
    return SCENE_ENSEMBLES.includes(value) ? value : 'open';
}

/** A Scene cast as one Director and one Narrator, with both seats filled. */
export function isDuetScene(scene) {
    return Boolean(
        scene?.mode === 'roleplay'
        && scene.ensemble === 'duet'
        && scene.liveDirection?.directorRef?.id
        && scene.liveDirection?.narratorRef?.id,
    );
}

/**
 * Binds both seats of a two-seat Scene in one write.
 *
 * Separate from setSceneRoleplayDirector because that function exists to
 * assign a Director seat over an already-cast open Scene. Here the two seats
 * and the staging are established together, at creation, as one decision.
 */
export function setSceneDuetSeats(sceneId, { directorRef, narratorRef } = {}) {
    const scene = getTimelineStore().scenes[sceneId];
    if (!scene || scene.mode !== 'roleplay') return null;
    const director = normalizeDirectionPerformerRef(directorRef);
    const narrator = normalizeDirectionPerformerRef(narratorRef);
    if (!director || !narrator || director.id === narrator.id) return null;
    return updateScene(sceneId, {
        ensemble: 'duet',
        staging: 'directed',
        liveDirection: {
            ...scene.liveDirection,
            enabled: true,
            directorRef: director,
            narratorRef: { ...narrator, kind: 'narrator' },
        },
    });
}

/**
 * Role bindings are an ordered list, one entry per job at most. A binding with
 * no resolvable cast member is kept (the character may simply not be loaded
 * yet) but carries a null characterId, and the pipeline skips it.
 */
function normalizeSceneRoles(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const roles = [];
    for (const entry of value) {
        const job = SCENE_ROLE_JOBS.includes(entry?.job) ? entry.job : null;
        if (!job || seen.has(job)) {
            continue;
        }
        seen.add(job);
        const characterId = entry?.characterId == null || entry.characterId === ''
            ? null
            : Number(entry.characterId);
        roles.push({ job, characterId: Number.isInteger(characterId) ? characterId : null });
    }
    return roles;
}

export const LIVE_DIRECTION_PACING = Object.freeze(['slow', 'natural', 'fast', 'instant']);

function normalizeLiveDirection(value = {}, legacyRoles = []) {
    const pacing = LIVE_DIRECTION_PACING.includes(value?.pacing) ? value.pacing : 'natural';
    const limit = Math.max(1, Math.min(10, Math.round(Number(value?.autonomousResponseLimit) || 3)));
    let narratorRef = normalizeDirectionPerformerRef(value?.narratorRef);
    if (!narratorRef) {
        const legacy = legacyRoles.find((binding) => binding.job === 'narrator' && Number.isInteger(binding.characterId));
        if (legacy) narratorRef = { kind: 'legacy-character-index', id: String(legacy.characterId), label: 'Narrator' };
    }
    let directorRef = normalizeDirectionPerformerRef(value?.directorRef);
    if (!directorRef) {
        const legacy = legacyRoles.find((binding) => binding.job === 'director' && Number.isInteger(binding.characterId));
        if (legacy) directorRef = { kind: 'legacy-character-index', id: String(legacy.characterId), label: 'Roleplay Director' };
    }
    const directionLog = (Array.isArray(value?.directionLog) ? value.directionLog : [])
        .map(normalizeDirectionRecord)
        .filter(Boolean)
        .slice(-60);
    return {
        enabled: value?.enabled !== false,
        pacing,
        autoplay: value?.autoplay !== false,
        autonomousResponseLimit: limit,
        narratorRef,
        directorRef,
        directionLog,
    };
}

function normalizeDirectionRecord(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || '').trim();
    const objective = String(value.objective || '').trim();
    if (!id || !objective) return null;
    return {
        id,
        createdAt: String(value.createdAt || new Date().toISOString()),
        directorRef: normalizeDirectionPerformerRef(value.directorRef),
        directorLabel: String(value.directorLabel || 'Game Director').trim() || 'Game Director',
        performerRef: normalizeDirectionPerformerRef(value.performerRef),
        performerLabel: String(value.performerLabel || 'Performer').trim() || 'Performer',
        objective,
        // LEGACY ONLY — nothing writes these any more. The director rework
        // deleted decision traces, constraints, openings, and the immediate/
        // checkpoint split; persistDirectionRecord emits none of them, so for
        // every new record they normalize to empty and the roleplay stream's
        // corresponding sections simply do not render. They are still read
        // back so records saved before the rework keep displaying what they
        // captured. Delete this block once those records no longer matter.
        decisionTrace: {
            observations: (Array.isArray(value.decisionTrace?.observations) ? value.decisionTrace.observations : []).map(String).filter(Boolean).slice(0, 8),
            intent: String(value.decisionTrace?.intent || '').trim(),
            performerReason: String(value.decisionTrace?.performerReason || '').trim(),
        },
        constraints: (Array.isArray(value.constraints) ? value.constraints : []).map(String).filter(Boolean).slice(0, 20),
        openings: (Array.isArray(value.openings) ? value.openings : []).map((item) => ({
            id: String(item?.id || ''),
            label: String(item?.label || ''),
        })).filter((item) => item.id && item.label).slice(0, 20),
        immediateCount: Math.max(0, Math.round(Number(value.immediateCount) || 0)),
        checkpointCount: Math.max(0, Math.round(Number(value.checkpointCount) || 0)),
        // `kind` is deliberately not defaulted. Every operation now applies at
        // the same point — when the response is accepted — so defaulting a
        // missing kind to 'immediate' invented a distinction that no longer
        // exists, and nothing reads it.
        operations: (Array.isArray(value.operations) ? value.operations : []).map((item) => ({
            ...(item?.kind === 'checkpoint' || item?.kind === 'immediate' ? { kind: item.kind } : {}),
            capability: String(item?.capability || '').trim(),
            reason: String(item?.reason || '').trim(),
        })).filter((item) => item.capability).slice(0, 40),
        // Reasoning is stored per Scene and can be long, so it is capped:
        // sixty of these live in the log at once and they all ride in settings.
        reasoning: String(value.reasoning || '').slice(0, 4000),
        continueAfter: Boolean(value.continueAfter),
        hardPauseAfter: Boolean(value.hardPauseAfter),
    };
}

function normalizeDirectionPerformerRef(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = ['character', 'narrator', 'legacy-character-index'].includes(value.kind) ? value.kind : null;
    const id = String(value.id || '').trim();
    if (!kind || !id) return null;
    return { kind, id, label: String(value.label || 'Narrator').trim() || 'Narrator' };
}

/**
 * Assigns (or clears) the extension-only Roleplay Director seat. The card
 * remains a native group member; no native chat role or character data moves.
 */
export function setSceneRoleplayDirector(sceneId, directorRef) {
    const scene = getTimelineStore().scenes[sceneId];
    if (!scene || scene.mode !== 'roleplay') return null;
    const normalized = directorRef ? normalizeDirectionPerformerRef(directorRef) : null;
    return updateScene(sceneId, {
        // Assigning the explicit Director seat means the user is opting into
        // Live Direction. Clearing the seat does not silently change their
        // chosen staging mode.
        ...(normalized ? { staging: 'directed' } : {}),
        liveDirection: { ...scene.liveDirection, ...(normalized ? { enabled: true } : {}), directorRef: normalized },
    });
}

function touchTimeline(timelineId) {
    const timeline = getTimelineStore().timelines[timelineId];

    if (timeline) {
        timeline.updatedAt = now();
    }
}

function touchArc(arcId) {
    const arc = getTimelineStore().arcs[arcId];

    if (arc) {
        arc.updatedAt = now();
    }
}

function normalizeText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function createId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}

function now() {
    return new Date().toISOString();
}
