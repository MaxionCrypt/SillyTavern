// Scene-scoped Living Lore cache.
//
// Per Scene it holds the entry refs ({book, uid}) currently pulled in and the
// deduped set of keyword GROUPS the Loom has queried this Scene. It is a NEW
// store (livingLoreCacheV1) that coexists with the timeline-scoped livingLoreV1
// used by the Living Lore intake/mutation modules — it does not touch that one.
// Refs are pointers; entry content is re-read from native World Info at render
// time (a later phase), so an edit reflects immediately.

import { getContext } from '../../../st-context.js';
import { getScene, getTimelineStore } from './timeline-state.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'livingLoreCacheV1';
const STORE_VERSION = 1;
const GROUP_SEP = '';

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function emptyStore() { return { version: STORE_VERSION, scenes: {} }; }

function getStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isObject(namespace[SETTINGS_KEY])) namespace[SETTINGS_KEY] = emptyStore();
    const store = namespace[SETTINGS_KEY];
    if (store.version !== STORE_VERSION) store.version = STORE_VERSION;
    if (!isObject(store.scenes)) store.scenes = {};
    return store;
}

function save() { getContext().saveSettingsDebounced(); }

function sceneBucket(sceneId) { return { sceneId: String(sceneId), entryRefs: {}, keywordGroups: [] }; }

/** Canonical form of a keyword group: trimmed, de-duped, sorted — so that
 *  ["a","b"] and ["b","a"] compare equal and are summoned once. */
function canonicalGroup(group) {
    const seen = new Set();
    const out = [];
    for (const word of Array.isArray(group) ? group : []) {
        const value = String(word ?? '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out.sort();
}
function canonicalKey(group) { return canonicalGroup(group).join(GROUP_SEP); }

/** The Scene's cache bucket (created on demand unless create=false). */
export function getSceneLivingLore(sceneId, { create = true } = {}) {
    const id = String(sceneId ?? '').trim();
    if (!id) return null;
    const store = getStore();
    if (!isObject(store.scenes[id])) {
        if (!create) return null;
        store.scenes[id] = sceneBucket(id);
        save();
    }
    const bucket = store.scenes[id];
    if (!isObject(bucket.entryRefs)) bucket.entryRefs = {};
    if (!Array.isArray(bucket.keywordGroups)) bucket.keywordGroups = [];
    bucket.sceneId = id;
    return bucket;
}

/** The canonicalised groups from `groups` this Scene has NOT queried yet
 *  (also de-duped within this call). */
export function unseenGroups(sceneId, groups) {
    const bucket = getSceneLivingLore(sceneId, { create: false });
    const seen = new Set((bucket?.keywordGroups || []).map(canonicalKey));
    const local = new Set();
    const out = [];
    for (const group of Array.isArray(groups) ? groups : []) {
        const canon = canonicalGroup(group);
        if (!canon.length) continue;
        const key = canon.join(GROUP_SEP);
        if (seen.has(key) || local.has(key)) continue;
        local.add(key);
        out.push(canon);
    }
    return out;
}

/** Add each new (canonicalised) group to the Scene's queried set. */
export function recordKeywordGroups(sceneId, groups) {
    const bucket = getSceneLivingLore(sceneId, { create: true });
    if (!bucket) return;
    const seen = new Set(bucket.keywordGroups.map(canonicalKey));
    let changed = false;
    for (const group of Array.isArray(groups) ? groups : []) {
        const canon = canonicalGroup(group);
        if (!canon.length) continue;
        const key = canon.join(GROUP_SEP);
        if (seen.has(key)) continue;
        seen.add(key);
        bucket.keywordGroups.push(canon);
        changed = true;
    }
    if (changed) save();
}

/** Union {book, uid} refs into the Scene cache, keyed `${book}.${uid}`. */
export function addEntryRefs(sceneId, refs) {
    const bucket = getSceneLivingLore(sceneId, { create: true });
    if (!bucket) return;
    let changed = false;
    for (const ref of Array.isArray(refs) ? refs : []) {
        const book = String(ref?.book ?? ref?.world ?? '').trim();
        const uid = String(ref?.uid ?? '').trim();
        if (!book || !uid) continue;
        const key = `${book}.${uid}`;
        if (bucket.entryRefs[key]) continue;
        bucket.entryRefs[key] = { book, uid };
        changed = true;
    }
    if (changed) save();
}

/** The Scene's cached entry refs as an array of { book, uid }. */
export function listSceneEntryRefs(sceneId) {
    const bucket = getSceneLivingLore(sceneId, { create: false });
    return bucket ? Object.values(bucket.entryRefs) : [];
}

/** A timeline's Scene ids in play order: arcs in arcIds order, then each arc's
 *  sceneIds in order. The Scene arrays are the authoritative sequence (a user
 *  reorder moves a Scene here), so "prior" means earlier in this walk. */
export function orderedTimelineSceneIds(timelineId) {
    const tid = String(timelineId ?? '').trim();
    if (!tid) return [];
    const store = getTimelineStore();
    const timeline = store?.timelines?.[tid];
    if (!timeline) return [];
    const out = [];
    for (const arcId of timeline.arcIds || []) {
        for (const sceneId of store.arcs?.[arcId]?.sceneIds || []) out.push(String(sceneId));
    }
    return out;
}

/** The deduped union of keyword groups queried in Scenes BEFORE `sceneId` in its
 *  timeline's play order — what earlier Scenes established, each distinct group
 *  once (canonical: order- and duplicate-insensitive). A Scene absent from the
 *  timeline ordering has no determinable predecessors, so it yields nothing.
 *
 *  `scenes` bounds the lookback to that many of the NEAREST prior Scenes (the N
 *  immediately before the current one). Only a positive integer limits; anything
 *  else — omitted, 0, NaN, null, '' — means all prior Scenes, so a value that
 *  coerces to 0 never silently blanks the macro. */
export function listPriorSceneKeywordGroups({ sceneId = '', timelineId = '', scenes } = {}) {
    const id = String(sceneId ?? '').trim();
    if (!id) return [];
    const tid = String(timelineId ?? '').trim() || String(getScene(id)?.timelineId ?? '');
    const order = orderedTimelineSceneIds(tid);
    const index = order.indexOf(id);
    if (index < 0) return [];
    let priorIds = order.slice(0, index);
    const limit = Number(scenes);
    if (Number.isFinite(limit) && limit >= 1) priorIds = priorIds.slice(-Math.floor(limit));
    const store = getStore();
    const seen = new Set();
    const out = [];
    for (const priorId of priorIds) {
        for (const group of store.scenes[priorId]?.keywordGroups || []) {
            const canon = canonicalGroup(group);
            if (!canon.length) continue;
            const key = canon.join(GROUP_SEP);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(canon);
        }
    }
    return out;
}
