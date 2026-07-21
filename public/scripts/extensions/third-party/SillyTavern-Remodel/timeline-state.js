import { getContext } from '../../../st-context.js';

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
        }

        delete store.arcs[arcId];
    }

    delete store.timelines[timelineId];
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
    }

    for (const arc of Object.values(store.arcs)) {
        arc.sceneIds = (arc.sceneIds || []).filter((id) => store.scenes[id]?.arcId === arc.id);
    }

    for (const scene of Object.values(store.scenes)) {
        // Backward-compat for scenes saved before story scenes bound to a
        // StoryDoc instead of a chat.
        scene.storyDocId ??= null;
    }
}

function sanitizeTimelinePatch(patch) {
    return {
        ...(patch.title !== undefined ? { title: normalizeText(patch.title, 'Untitled Timeline') } : {}),
        ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
        ...(patch.thumbnail !== undefined ? { thumbnail: patch.thumbnail ? String(patch.thumbnail) : null } : {}),
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
    };
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
