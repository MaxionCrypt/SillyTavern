import { getContext } from '../../../st-context.js';
import { entryKey } from './variables-lore-key.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyVariablesV3';
const STORE_VERSION = 3;
const MAX_EVENTS = 800;
const MAX_TRANSACTIONS = 300;

export const VARIABLE_TYPES = Object.freeze(['number', 'enum', 'text', 'boolean']);
export const VARIABLE_KINDS = VARIABLE_TYPES;
export const SUBVALUE_ROLES = Object.freeze(['ordinary', 'minimum', 'maximum']);
export const LORE_LINK_HINTS = Object.freeze(['subject', 'concept', 'context']);
export const RETRIEVAL_MODES = Object.freeze(['corroborated', 'any', 'all', 'always']);
export const MODIFIER_TARGETS = Object.freeze(['value', 'maximum']);
export const VARIABLE_AUTHORITIES = Object.freeze(['review', 'world', 'user', 'persona']);

export function getVariableStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = emptyStore();
        migrateLegacyStores(namespace, namespace[SETTINGS_KEY]);
        context.saveSettingsDebounced();
    }
    normalizeStore(namespace[SETTINGS_KEY]);
    return namespace[SETTINGS_KEY];
}

export function saveVariableStore() {
    getContext().saveSettingsDebounced();
}

export function listVariableValues({ timelineId = '', loreRef = null, entryRef = null } = {}) {
    const store = getVariableStore();
    const buckets = timelineId ? [store.timelines[String(timelineId)]].filter(Boolean) : Object.values(store.timelines);
    let values = buckets.flatMap((bucket) => bucket.variableIds.map((id) => bucket.variables[id]).filter(Boolean));
    const linked = loreRef || entryRef;
    if (linked) {
        const key = entryKey(linked);
        values = values.filter((variable) => variable.loreLinks.some((link) => entryKey(link) === key));
    }
    return values;
}

export const listVariables = listVariableValues;

export function getVariableValue(variableId, timelineId = '') {
    const store = getVariableStore();
    if (timelineId) return store.timelines[String(timelineId)]?.variables?.[String(variableId)] || null;
    for (const bucket of Object.values(store.timelines)) {
        if (bucket.variables?.[String(variableId)]) return bucket.variables[String(variableId)];
    }
    return null;
}

export const getVariable = getVariableValue;

export function createVariableValue(input = {}, context = {}) {
    const store = getVariableStore();
    const timelineId = String(input.timelineId || context.timelineId || '');
    const variable = normalizeVariable({ ...input, id: input.id || createId('var'), timelineId });
    if (!timelineId || !variable || (!variable.loreLinks.length && variable.retrieval.mode !== 'always')) return null;
    const bucket = (store.timelines[timelineId] ??= timelineBucket(timelineId));
    if (bucket.variables[variable.id]) return bucket.variables[variable.id];
    bucket.variables[variable.id] = variable;
    bucket.variableIds.push(variable.id);
    invalidateVectorRecord(store, variable, 'created');
    appendEvent(store, eventInput(variable, 'variable.created', null, variable, context));
    saveVariableStore();
    return variable;
}

export const createVariable = createVariableValue;

export function updateVariableValue(variableId, patch = {}, context = {}) {
    const store = getVariableStore();
    const current = getVariableValue(variableId, context.timelineId);
    if (!current) return null;
    const before = clone(current);
    const next = normalizeVariable({ ...current, ...patch, id: current.id, timelineId: current.timelineId, createdAt: current.createdAt, updatedAt: now() });
    if (!next || (!next.loreLinks.length && next.retrieval.mode !== 'always')) return null;
    store.timelines[current.timelineId].variables[current.id] = next;
    if (meaningChanged(before, next)) invalidateVectorRecord(store, next, 'meaning-changed');
    appendEvent(store, eventInput(next, context.type || 'variable.updated', before, next, context));
    saveVariableStore();
    return next;
}

export const updateVariable = updateVariableValue;

export function setVariableField(variableId, field = 'value', value, context = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    if (!variable) return null;
    if (field === 'value') return updateVariableValue(variable.id, { value }, { ...context, type: 'variable.value-set' });
    const index = variable.subvalues.findIndex((item) => item.key === String(field));
    if (index < 0) return null;
    const subvalues = variable.subvalues.map((item, i) => i === index ? { ...item, value } : item);
    return updateVariableValue(variable.id, { subvalues }, { ...context, type: 'variable.subvalue-set' });
}

export function adjustVariableValue(variableId, delta, { field = 'value', ...context } = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    const amount = Number(delta);
    if (!variable || !Number.isFinite(amount)) return null;
    if (field === 'value') {
        if (variable.valueType !== 'number') return null;
        return setVariableField(variable.id, 'value', Number(variable.value) + amount, { ...context, type: 'variable.adjusted' });
    }
    const subvalue = variable.subvalues.find((item) => item.key === String(field));
    if (!subvalue || subvalue.type !== 'number') return null;
    return setVariableField(variable.id, field, Number(subvalue.value) + amount, { ...context, type: 'variable.subvalue-adjusted' });
}

export function transitionVariableValue(variableId, nextState, { field = 'value', ...context } = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    if (!variable) return null;
    const target = String(nextState ?? '').trim();
    const source = field === 'value' ? variable : variable.subvalues.find((item) => item.key === String(field));
    const type = field === 'value' ? variable.valueType : source?.type;
    const options = field === 'value' ? variable.enumValues : source?.enumValues;
    if (type !== 'enum' || !options?.includes(target)) return null;
    return setVariableField(variable.id, field, target, { ...context, type: 'variable.transitioned' });
}

export function deleteVariableValue(variableId, context = {}) {
    const store = getVariableStore();
    const variable = getVariableValue(variableId, context.timelineId);
    if (!variable) return false;
    const bucket = store.timelines[variable.timelineId];
    appendEvent(store, eventInput(variable, 'variable.deleted', variable, null, context));
    delete bucket.variables[variable.id];
    bucket.variableIds = bucket.variableIds.filter((id) => id !== variable.id);
    invalidateVectorRecord(store, variable, 'deleted');
    saveVariableStore();
    return true;
}

export const deleteVariable = deleteVariableValue;

export function attachEntry(variableId, ref, context = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    const link = normalizeLoreLink(ref);
    if (!variable || !link) return null;
    const key = entryKey(link);
    if (variable.loreLinks.some((item) => entryKey(item) === key)) return variable;
    return updateVariableValue(variable.id, { loreLinks: [...variable.loreLinks, link] }, { ...context, type: 'variable.link-attached' });
}

export function detachEntry(variableId, ref, context = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    if (!variable) return null;
    const key = entryKey(ref);
    const loreLinks = variable.loreLinks.filter((item) => entryKey(item) !== key);
    if (!loreLinks.length && variable.retrieval.mode !== 'always') return null;
    return updateVariableValue(variable.id, { loreLinks }, { ...context, type: 'variable.link-detached' });
}

export function listVariablesForLoreRef(ref, { timelineId = '' } = {}) {
    return listVariableValues({ timelineId, loreRef: ref });
}

export function addVariableModifier(variableId, input = {}, context = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    const amount = Number(input.amount);
    if (!variable || !Number.isFinite(amount)) return null;
    const modifier = {
        id: createId('mod'), label: String(input.label || 'Modifier').trim() || 'Modifier', amount,
        target: MODIFIER_TARGETS.includes(input.target) ? input.target : 'value',
        reason: String(input.reason || '').trim(), source: String(input.source || context.actor || 'user'), createdAt: now(),
    };
    const updated = updateVariableValue(variable.id, { modifiers: [...variable.modifiers, modifier] }, { ...context, type: 'modifier.added' });
    return updated ? modifier : null;
}

export function removeVariableModifier(variableId, modifierId, context = {}) {
    const variable = getVariableValue(variableId, context.timelineId);
    if (!variable || !variable.modifiers.some((item) => item.id === String(modifierId))) return false;
    return Boolean(updateVariableValue(variable.id, {
        modifiers: variable.modifiers.filter((item) => item.id !== String(modifierId)),
    }, { ...context, type: 'modifier.removed' }));
}

export function computeVariable(variable) {
    if (!variable) return null;
    const modifiers = Array.isArray(variable.modifiers) ? variable.modifiers : [];
    if (variable.valueType !== 'number') return { type: variable.valueType, value: variable.value, subvalues: variable.subvalues };
    const minimum = numericRole(variable, 'minimum');
    const maximumBase = numericRole(variable, 'maximum');
    const valueDelta = modifiers.filter((item) => item.target === 'value').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const maximumDelta = modifiers.filter((item) => item.target === 'maximum').reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const maximum = maximumBase == null ? null : maximumBase + maximumDelta;
    const raw = Number(variable.value || 0) + valueDelta;
    const value = clampNumber(raw, minimum, maximum);
    return { type: 'number', value, base: Number(variable.value || 0), minimum, maximum, modified: value !== Number(variable.value || 0), subvalues: variable.subvalues };
}

export function formatVariable(variable) {
    const computed = computeVariable(variable);
    if (!computed) return '';
    if (computed.type !== 'number') return String(computed.value ?? '');
    return computed.maximum == null ? String(computed.value) : `${computed.value} / ${computed.maximum}`;
}

export function variableHandle(variable, _definition = null, peers = []) {
    const slug = String(variable?.name || 'variable').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'variable';
    const matches = (peers || []).filter((item) => String(item?.name || '').toLowerCase() === String(variable?.name || '').toLowerCase());
    return matches.length > 1 ? `${slug}.${matches.indexOf(variable) + 1}` : slug;
}

export function listVariableEvents({ timelineId = '' } = {}) {
    const store = getVariableStore();
    return store.eventIds.map((id) => store.events[id]).filter(Boolean).filter((event) => !timelineId || event.timelineId === timelineId);
}

export function recordMechanicsTransaction(transaction) {
    const store = getVariableStore();
    const id = String(transaction?.id || createId('tx'));
    store.transactions[id] = { ...clone(transaction), id, createdAt: transaction?.createdAt || now() };
    store.transactionIds.push(id);
    trimMap(store.transactionIds, store.transactions, MAX_TRANSACTIONS);
    saveVariableStore();
    return store.transactions[id];
}

export function listMechanicsTransactions({ timelineId = '', sceneId = '' } = {}) {
    const store = getVariableStore();
    return store.transactionIds.map((id) => store.transactions[id]).filter(Boolean)
        .filter((tx) => (!timelineId || tx.timelineId === timelineId) && (!sceneId || tx.sceneId === sceneId));
}

export function snapshotVariableStore() { return clone(getVariableStore()); }

export function restoreVariableStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = clone(snapshot);
    normalizeStore(context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY]);
    if (save) saveVariableStore();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

export function getMechanicsProfile() { return getVariableStore().mechanicsProfile; }

export function updateMechanicsProfile(patch = {}) {
    const profile = getVariableStore().mechanicsProfile;
    if (patch.enabled !== undefined) profile.enabled = Boolean(patch.enabled);
    if (typeof patch.handbookAdditions === 'string') profile.handbookAdditions = patch.handbookAdditions;
    if (patch.contextBudget !== undefined) profile.contextBudget = clampInt(patch.contextBudget, 1000, 32000, 6000);
    if (patch.directorResponseTokens !== undefined) profile.directorResponseTokens = clampInt(patch.directorResponseTokens, 1500, 32000, 4000);
    if (patch.retrievalLimit !== undefined || patch.sweepLimit !== undefined) profile.retrievalLimit = clampInt(patch.retrievalLimit ?? patch.sweepLimit, 1, 12, 6);
    if (patch.retrievalWindow !== undefined || patch.sweepWindow !== undefined) profile.retrievalWindow = clampInt(patch.retrievalWindow ?? patch.sweepWindow, 1, 60, 12);
    if (['hybrid', 'review-all', 'automatic'].includes(patch.automationPolicy)) profile.automationPolicy = patch.automationPolicy;
    if (['pause', 'bypass', 'retry-once'].includes(patch.failureBehavior)) profile.failureBehavior = patch.failureBehavior;
    profile.updatedAt = now();
    saveVariableStore();
    return profile;
}

/**
 * Timeline deletion cascade. Removes the Variables, their history, and their
 * mechanical receipts, and marks the vector collection for purge — the purge
 * itself happens on the next `ensureVariableVectorIndex`, since deletion is
 * synchronous and the vector backend is not.
 *
 * Returns true when anything was removed, so a Timeline with history but no
 * surviving Variables still reports the cascade.
 */
export function deleteVariablesForTimeline(timelineId) {
    const store = getVariableStore();
    const key = String(timelineId || '');
    if (!key) return false;
    const hadBucket = Boolean(store.timelines[key]);
    delete store.timelines[key];
    const removedEvents = pruneByTimeline(store.eventIds, store.events, key);
    const removedTransactions = pruneByTimeline(store.transactionIds, store.transactions, key);
    if (!hadBucket && !removedEvents && !removedTransactions) return false;
    store.vectorIndexState[key] = { collectionId: vectorCollectionId(key), dirty: true, deleted: true, updatedAt: now() };
    saveVariableStore();
    return true;
}

function pruneByTimeline(ids, records, timelineId) {
    let removed = 0;
    for (const id of [...ids]) {
        if (records[id]?.timelineId !== timelineId) continue;
        delete records[id];
        ids.splice(ids.indexOf(id), 1);
        removed++;
    }
    return removed;
}

export function getVectorIndexState(timelineId) {
    const store = getVariableStore();
    const key = String(timelineId || '');
    return store.vectorIndexState[key] ??= { collectionId: vectorCollectionId(key), dirty: true, degraded: false, hashes: {}, updatedAt: now() };
}

export function updateVectorIndexState(timelineId, patch = {}) {
    const state = getVectorIndexState(timelineId);
    Object.assign(state, patch, { updatedAt: now() });
    saveVariableStore();
    return state;
}

export function getMigrationBackup() { return getVariableStore().migrationBackup; }

/**
 * Mark every Timeline holding lore-linked Variables for re-embedding.
 *
 * Called when World Info changes. A linked entry's prose is part of the
 * document that was embedded, so editing an entry silently invalidates the
 * index — and `ensureVariableVectorIndex` early-returns when the Timeline is
 * clean, so without this the stale document survives indefinitely.
 *
 * Which book changed is not reliably reported, so this flags every linked
 * Timeline. That is cheap: reindexing is hash-diffed, so an unaffected Timeline
 * costs one list-and-compare with nothing to insert. Already-dirty Timelines are
 * skipped so a burst of edits does not churn settings.
 */
export function markLoreLinkedTimelinesDirty(reason = 'lore-changed') {
    const store = getVariableStore();
    let marked = 0;
    for (const [timelineId, bucket] of Object.entries(store.timelines)) {
        const linked = bucket.variableIds.some((id) => bucket.variables[id]?.loreLinks?.length);
        if (!linked) continue;
        const current = store.vectorIndexState[timelineId];
        if (current?.dirty) continue;
        store.vectorIndexState[timelineId] = {
            ...(current || { collectionId: vectorCollectionId(timelineId), hashes: {} }),
            dirty: true, dirtyReason: reason, updatedAt: now(),
        };
        marked++;
    }
    if (marked) saveVariableStore();
    return marked;
}

export function normalizeOwnerRef(value = {}, fallbackKind = 'custom') {
    const kind = ['character', 'persona', 'group', 'faction', 'object', 'location', 'timeline', 'goal', 'custom'].includes(value?.kind) ? value.kind : fallbackKind;
    const label = String(value?.label || value?.name || value?.id || 'Unknown').trim() || 'Unknown';
    return { kind, id: String(value?.id || label).trim(), label };
}

export function ownerKey(value) {
    const owner = normalizeOwnerRef(value);
    return `${owner.kind}:${owner.id}`;
}

function emptyStore() {
    return {
        version: STORE_VERSION, timelines: {}, eventIds: [], events: {}, transactionIds: [], transactions: {}, vectorIndexState: {},
        mechanicsProfile: {
            enabled: false, handbookAdditions: '', contextBudget: 6000, directorResponseTokens: 4000,
            retrievalWindow: 12, retrievalLimit: 6, automationPolicy: 'hybrid', failureBehavior: 'pause', updatedAt: now(),
        },
        migrationBackup: { migratedAt: '', sources: {}, unresolved: [], idMap: {} },
    };
}

function timelineBucket(timelineId) { return { timelineId, variableIds: [], variables: {} }; }

function isStore(value) { return Boolean(value && typeof value === 'object' && Number(value.version) === STORE_VERSION && value.timelines); }

function normalizeStore(store) {
    store.version = STORE_VERSION;
    store.timelines ??= {}; store.events ??= {}; store.transactions ??= {}; store.vectorIndexState ??= {};
    store.eventIds = Array.isArray(store.eventIds) ? store.eventIds.filter((id) => store.events[id]) : [];
    store.transactionIds = Array.isArray(store.transactionIds) ? store.transactionIds.filter((id) => store.transactions[id]) : [];
    store.mechanicsProfile = { ...emptyStore().mechanicsProfile, ...(store.mechanicsProfile || {}) };
    store.mechanicsProfile.retrievalWindow = clampInt(store.mechanicsProfile.retrievalWindow ?? store.mechanicsProfile.sweepWindow, 1, 60, 12);
    store.mechanicsProfile.retrievalLimit = clampInt(store.mechanicsProfile.retrievalLimit ?? store.mechanicsProfile.sweepLimit, 1, 12, 6);
    store.migrationBackup = { ...emptyStore().migrationBackup, ...(store.migrationBackup || {}) };
    for (const [timelineId, rawBucket] of Object.entries(store.timelines)) {
        const bucket = rawBucket && typeof rawBucket === 'object' ? rawBucket : timelineBucket(timelineId);
        bucket.variables ??= bucket.values ?? {};
        const normalized = {};
        for (const [id, raw] of Object.entries(bucket.variables)) {
            const variable = normalizeVariable({ ...raw, id, timelineId });
            if (variable && (variable.loreLinks.length || variable.retrieval.mode === 'always')) normalized[id] = variable;
            else store.migrationBackup.unresolved.push({ source: 'v3-normalize', timelineId, id, raw: clone(raw), reason: 'Invalid or unlinked Variable' });
        }
        bucket.variables = normalized;
        bucket.variableIds = (Array.isArray(bucket.variableIds) ? bucket.variableIds : bucket.valueIds || []).filter((id) => normalized[id]);
        for (const id of Object.keys(normalized)) if (!bucket.variableIds.includes(id)) bucket.variableIds.push(id);
        delete bucket.values; delete bucket.valueIds;
        store.timelines[timelineId] = bucket;
    }
}

function normalizeVariable(raw) {
    const name = String(raw?.name ?? raw?.label ?? '').trim();
    const timelineId = String(raw?.timelineId || '');
    if (!name || !timelineId) return null;
    const valueType = normalizeType(raw?.valueType ?? raw?.kind);
    const enumValues = normalizeEnum(raw?.enumValues ?? raw?.states);
    const subvalues = normalizeSubvalues(raw?.subvalues, raw, valueType);
    const bounds = boundsFromSubvalues(subvalues);
    const value = normalizeScalar(raw?.value, valueType, enumValues, bounds.minimum, bounds.maximum);
    return {
        id: String(raw?.id || createId('var')), timelineId, name, description: String(raw?.description ?? raw?.note ?? '').trim(),
        valueType, value, enumValues, subvalues,
        loreLinks: (Array.isArray(raw?.loreLinks) ? raw.loreLinks : raw?.entryRefs || []).map(normalizeLoreLink).filter(Boolean)
            .filter((link, index, all) => all.findIndex((item) => entryKey(item) === entryKey(link)) === index),
        retrieval: normalizeRetrieval(raw?.retrieval),
        authority: VARIABLE_AUTHORITIES.includes(raw?.authority) ? raw.authority : authorityFromOwner(raw?.ownerRef),
        modifiers: normalizeModifiers(raw?.modifiers),
        createdAt: String(raw?.createdAt || now()), updatedAt: String(raw?.updatedAt || now()),
    };
}

/**
 * Authority for a record that did not state one.
 *
 * V3 Variables have no owner — the lore link replaced it — so this only ever
 * fires for migrated V1/V2 records, where `ownerRef` still says who the value
 * belonged to. A V3 Variable created without an explicit authority is world
 * state: it is attached to a lorebook entry about the fiction, not to the user.
 * Defaulting those to `review` (what the ownerless branch used to return) made
 * every AI write wait for approval that nothing in the UI could grant.
 */
function authorityFromOwner(ownerRef) {
    const kind = String(ownerRef?.kind || '');
    if (kind === 'persona') return 'persona';
    if (kind === 'character') return 'review';
    return 'world';
}

function normalizeSubvalues(input, legacy, valueType) {
    const list = Array.isArray(input) ? input : [];
    if (!list.length && valueType === 'number') {
        if (legacy?.min != null) list.push({ key: 'minimum', label: 'Minimum', type: 'number', value: legacy.min, role: 'minimum' });
        if (legacy?.max != null) list.push({ key: 'maximum', label: 'Maximum', type: 'number', value: legacy.max, role: 'maximum' });
        if (legacy?.maximum != null && legacy?.max == null) list.push({ key: 'maximum', label: 'Maximum', type: 'number', value: legacy.maximum, role: 'maximum' });
    }
    const seenKeys = new Set(); let minimumSeen = false; let maximumSeen = false;
    return list.map((item, index) => {
        const key = String(item?.key || `field_${index + 1}`).trim().replace(/[^a-zA-Z0-9_.-]+/g, '_');
        if (!key || seenKeys.has(key)) return null;
        seenKeys.add(key);
        const type = normalizeType(item?.type);
        let role = SUBVALUE_ROLES.includes(item?.role) ? item.role : 'ordinary';
        if (role === 'minimum' && minimumSeen || role === 'maximum' && maximumSeen || role !== 'ordinary' && type !== 'number') role = 'ordinary';
        if (role === 'minimum') minimumSeen = true;
        if (role === 'maximum') maximumSeen = true;
        const enumValues = normalizeEnum(item?.enumValues ?? item?.states);
        return { key, label: String(item?.label || key).trim() || key, type, value: normalizeScalar(item?.value, type, enumValues), enumValues, role };
    }).filter(Boolean);
}

function normalizeLoreLink(value) {
    const book = String(value?.book ?? '').trim();
    const uid = String(value?.uid ?? '').trim();
    if (!book || uid === '') return null;
    return { book, uid, hint: LORE_LINK_HINTS.includes(value?.hint) ? value.hint : 'context' };
}

function normalizeRetrieval(value = {}) {
    const mode = RETRIEVAL_MODES.includes(value?.mode) ? value.mode : 'corroborated';
    const threshold = Number(value?.semanticThreshold);
    return { mode, semanticThreshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.70, continuity: value?.continuity !== false };
}

function normalizeModifiers(value) {
    return (Array.isArray(value) ? value : []).map((item) => {
        const amount = Number(item?.amount);
        if (!Number.isFinite(amount)) return null;
        return { id: String(item.id || createId('mod')), label: String(item.label || 'Modifier'), amount, target: MODIFIER_TARGETS.includes(item.target) ? item.target : 'value', reason: String(item.reason || ''), source: String(item.source || 'legacy'), createdAt: String(item.createdAt || now()) };
    }).filter(Boolean);
}

function migrateLegacyStores(namespace, store) {
    const v2 = namespace.storyVariablesV2;
    const nested = v2?.retired?.data || {};
    const v1 = namespace.storyVariablesV1 || nested.storyVariablesV1;
    const goals = namespace.storyGoalsV3 || nested.storyGoalsV3;
    store.migrationBackup = { migratedAt: now(), sources: { ...(v1 ? { storyVariablesV1: clone(v1) } : {}), ...(v2 ? { storyVariablesV2: clone(v2) } : {}), ...(goals ? { storyGoalsV3: clone(goals) } : {}) }, unresolved: [], idMap: {} };
    if (!namespace.storyGoalsV3 && goals) namespace.storyGoalsV3 = clone(goals);
    const profile = v2?.mechanicsProfile || v1?.mechanicsProfile;
    if (profile) store.mechanicsProfile = { ...store.mechanicsProfile, ...clone(profile) };
    migrateV2(v2, store);
    migrateV1(v1, store);
}

function migrateV2(v2, store) {
    for (const [timelineId, bucket] of Object.entries(v2?.timelines || {})) {
        for (const raw of Object.values(bucket?.values || bucket?.variables || {})) {
            const id = `v2-${String(raw?.id || createId('legacy'))}`;
            const variable = normalizeVariable({ ...raw, id, timelineId, name: raw?.name || raw?.label, description: raw?.description || raw?.note, valueType: raw?.valueType || (raw?.kind === 'state' ? 'enum' : raw?.kind), loreLinks: raw?.loreLinks || raw?.entryRefs });
            importVariable(store, variable, { source: 'v2', oldId: raw?.id });
        }
    }
}

function migrateV1(v1, store) {
    for (const [timelineId, bucket] of Object.entries(v1?.timelineInstances || {})) {
        for (const raw of Object.values(bucket?.instances || {})) {
            const definition = v1?.definitions?.[raw?.definitionId] || v1?.timelineDefinitions?.[timelineId]?.[raw?.definitionId];
            if (!definition) { store.migrationBackup.unresolved.push({ source: 'v1', timelineId, raw: clone(raw), reason: 'Missing definition' }); continue; }
            const owner = raw?.ownerRef?.label || 'Unassigned';
            const type = definition.kind === 'enum' ? 'enum' : definition.kind === 'boolean' ? 'boolean' : definition.kind === 'number' || definition.kind === 'resource' ? 'number' : 'text';
            const loreLinks = definition.loreRefs || (definition.loreRef ? [definition.loreRef] : []);
            const variable = normalizeVariable({
                id: `v1-${raw.id}`, timelineId, name: `${owner} ${definition.name || definition.key || 'Variable'}`.trim(),
                description: definition.summary || '', valueType: type, value: raw.value, enumValues: definition.enumStates,
                maximum: raw.maximum, min: definition.constraints?.minimum, loreLinks, modifiers: raw.modifiers,
                retrieval: { mode: loreLinks.length ? 'corroborated' : 'always' },
            });
            importVariable(store, variable, { source: 'v1', oldId: raw.id });
        }
    }
}

function importVariable(store, variable, { source, oldId } = {}) {
    if (!variable || (!variable.loreLinks.length && variable.retrieval.mode !== 'always')) {
        store.migrationBackup.unresolved.push({ source, oldId: String(oldId || ''), raw: clone(variable), reason: 'Invalid migrated Variable' });
        return;
    }
    const bucket = (store.timelines[variable.timelineId] ??= timelineBucket(variable.timelineId));
    if (!bucket.variables[variable.id]) { bucket.variables[variable.id] = variable; bucket.variableIds.push(variable.id); }
    if (oldId) store.migrationBackup.idMap[String(oldId)] = variable.id;
    invalidateVectorRecord(store, variable, 'migration');
}

function eventInput(variable, type, before, after, context) {
    return { timelineId: variable.timelineId, variableId: variable.id, type, before, after, actor: context.actor, reason: context.reason, transactionId: context.transactionId };
}

function appendEvent(store, input) {
    const id = createId('evt');
    store.events[id] = { id, at: now(), timelineId: String(input.timelineId || ''), variableId: String(input.variableId || ''), type: String(input.type || 'variable.updated'), actor: String(input.actor || 'system'), reason: String(input.reason || ''), transactionId: String(input.transactionId || ''), before: input.before ? clone(input.before) : null, after: input.after ? clone(input.after) : null };
    store.eventIds.push(id); trimMap(store.eventIds, store.events, MAX_EVENTS);
}

function invalidateVectorRecord(store, variable, reason) {
    const timelineId = variable.timelineId;
    const current = store.vectorIndexState[timelineId] || { collectionId: vectorCollectionId(timelineId), hashes: {} };
    store.vectorIndexState[timelineId] = { ...current, dirty: true, dirtyReason: reason, updatedAt: now() };
}

function meaningChanged(left, right) {
    return JSON.stringify([left.name, left.description, left.loreLinks, left.retrieval]) !== JSON.stringify([right.name, right.description, right.loreLinks, right.retrieval]);
}

function boundsFromSubvalues(subvalues) { return { minimum: subvalues.find((item) => item.role === 'minimum')?.value ?? null, maximum: subvalues.find((item) => item.role === 'maximum')?.value ?? null }; }
function numericRole(variable, role) { const value = variable.subvalues.find((item) => item.role === role && item.type === 'number')?.value; return Number.isFinite(Number(value)) ? Number(value) : null; }
function normalizeType(value) { return value === 'state' ? 'enum' : VARIABLE_TYPES.includes(value) ? value : 'number'; }
function normalizeEnum(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item ?? '').trim()).filter(Boolean))]; }
function normalizeScalar(value, type, enumValues = [], minimum = null, maximum = null) {
    if (type === 'number') return clampNumber(Number(value), minimum, maximum);
    if (type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
    if (type === 'enum') { const candidate = String(value ?? '').trim(); return enumValues.includes(candidate) ? candidate : enumValues[0] || ''; }
    return String(value ?? '');
}
/**
 * A bound is absent when it is null/undefined/'' — NOT merely when it coerces
 * badly. `Number(null)` is 0 and passes Number.isFinite, so testing presence by
 * coercion reads "no maximum" as "maximum 0" and clamps every value to zero.
 */
function hasBound(bound) { return bound !== null && bound !== undefined && bound !== '' && Number.isFinite(Number(bound)); }
function clampNumber(value, minimum = null, maximum = null) {
    let number = Number(value);
    if (!Number.isFinite(number)) number = hasBound(minimum) ? Number(minimum) : 0;
    if (hasBound(minimum)) number = Math.max(Number(minimum), number);
    if (hasBound(maximum)) number = Math.min(Number(maximum), number);
    return number;
}
function normalizeSubvalueKey(value) { return String(value || '').trim(); }
function vectorCollectionId(timelineId) { return `remodel-variables-${String(timelineId).replace(/[^a-zA-Z0-9_.-]/g, '_')}`; }
function trimMap(ids, map, maximum) { if (ids.length <= maximum) return; for (const id of ids.splice(0, ids.length - maximum)) delete map[id]; }
function clampInt(value, min, max, fallback) { const number = Math.round(Number(value)); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
function clone(value) { return value == null ? value : structuredClone(value); }
function createId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function now() { return new Date().toISOString(); }
