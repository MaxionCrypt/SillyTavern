import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'storyVariablesV1';
const LEGACY_KEY = 'storyStatsV1';
const STORE_VERSION = 2;

export const VARIABLE_KINDS = Object.freeze(['resource', 'number', 'enum', 'boolean']);
export const OWNER_KINDS = Object.freeze(['character', 'persona', 'group', 'faction', 'object', 'location', 'timeline', 'goal', 'custom']);
export const IMPACT_MAGNITUDES = Object.freeze(['minor', 'meaningful', 'major', 'decisive']);
export const MODIFIER_TARGETS = Object.freeze(['value', 'maximum', 'reach']);

const RESOURCE_IMPACT = Object.freeze({ minor: .1, meaningful: .2, major: .35, decisive: .5 });
const NUMBER_IMPACT = Object.freeze({ minor: 1, meaningful: 2, major: 5, decisive: 10 });

// These are selectable starting scales, not a universal Resource default.
// A definition may replace them, omit them, or provide several different
// interpretations linked to the same lorebook entry.
export const STANDARD_RESOURCE_SCALE_BANDS = Object.freeze([
    Object.freeze({ id: 'fragile', label: 'Fragile', maximum: 10 }),
    Object.freeze({ id: 'ordinary', label: 'Ordinary', maximum: 20 }),
    Object.freeze({ id: 'trained', label: 'Trained', maximum: 40 }),
    Object.freeze({ id: 'formidable', label: 'Formidable', maximum: 100 }),
    Object.freeze({ id: 'monstrous', label: 'Monstrous', maximum: 250 }),
    Object.freeze({ id: 'boss', label: 'Boss', maximum: 500 }),
    Object.freeze({ id: 'mythic', label: 'Mythic', maximum: 1000 }),
]);

export function getVariableStore() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const namespace = context.extensionSettings[SETTINGS_NAMESPACE];
    let changed = false;
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = emptyStore();
        changed = true;
    }
    changed = normalizeStore(namespace[SETTINGS_KEY]) || changed;
    if (!namespace[SETTINGS_KEY].migration.legacyStatsImported && namespace[LEGACY_KEY]) {
        migrateLegacyStats(namespace[SETTINGS_KEY], namespace[LEGACY_KEY]);
        delete namespace[LEGACY_KEY];
        namespace[SETTINGS_KEY].migration.legacyStatsImported = true;
        changed = true;
    }
    if (changed) saveVariableStore();
    return namespace[SETTINGS_KEY];
}

export function saveVariableStore() {
    getContext().saveSettingsDebounced();
}

export function snapshotVariableStore() {
    return clone(getVariableStore());
}

export function restoreVariableStore(snapshot, { save = true } = {}) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = clone(snapshot);
    normalizeStore(context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY]);
    if (save) saveVariableStore();
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
}

export function getMechanicsProfile() {
    return getVariableStore().mechanicsProfile;
}

export function updateMechanicsProfile(patch = {}) {
    const profile = getVariableStore().mechanicsProfile;
    if (patch.enabled !== undefined) profile.enabled = Boolean(patch.enabled);
    if (typeof patch.handbookAdditions === 'string') profile.handbookAdditions = patch.handbookAdditions;
    if (patch.contextBudget !== undefined) profile.contextBudget = clampInt(patch.contextBudget, 1000, 32000, 6000);
    if (['hybrid', 'review-all', 'automatic'].includes(patch.automationPolicy)) profile.automationPolicy = patch.automationPolicy;
    if (['pause', 'bypass', 'retry-once'].includes(patch.failureBehavior)) profile.failureBehavior = patch.failureBehavior;
    profile.updatedAt = now();
    saveVariableStore();
    return profile;
}

export function listVariableDefinitions({ includeTimeline = null } = {}) {
    const store = getVariableStore();
    const account = store.definitionIds.map((id) => store.definitions[id]).filter(Boolean);
    if (!includeTimeline) return account;
    return [...account, ...Object.values(store.timelineDefinitions[includeTimeline] || {})];
}

export function getVariableDefinition(definitionId, timelineId = '') {
    const store = getVariableStore();
    return store.definitions[String(definitionId || '')]
        || store.timelineDefinitions[String(timelineId || '')]?.[String(definitionId || '')]
        || null;
}

export function createVariableDefinition(input = {}, { timelineId = '', actor = 'user' } = {}) {
    const store = getVariableStore();
    const definition = normalizeDefinition({ ...input, id: input.id || createId('var-def'), scope: timelineId ? 'timeline' : 'account', timelineId });
    if (!definition) return null;
    if (timelineId) {
        store.timelineDefinitions[timelineId] ??= {};
        store.timelineDefinitions[timelineId][definition.id] = definition;
    } else {
        store.definitions[definition.id] = definition;
        if (!store.definitionIds.includes(definition.id)) store.definitionIds.push(definition.id);
    }
    appendEvent(store, { timelineId, definitionId: definition.id, type: 'definition.created', after: definition, actor });
    saveVariableStore();
    return definition;
}

export function updateVariableDefinition(definitionId, patch = {}, { timelineId = '', actor = 'user' } = {}) {
    const store = getVariableStore();
    const current = getVariableDefinition(definitionId, timelineId);
    if (!current) return null;
    const before = clone(current);
    const normalized = normalizeDefinition({ ...current, ...patch, id: current.id, scope: current.scope, timelineId: current.timelineId });
    if (!normalized) return null;
    Object.assign(current, normalized, { updatedAt: now() });
    appendEvent(store, { timelineId: current.timelineId, definitionId: current.id, type: 'definition.updated', before, after: current, actor });
    saveVariableStore();
    return current;
}

export function deleteVariableDefinition(definitionId, { timelineId = '' } = {}) {
    const store = getVariableStore();
    const definition = getVariableDefinition(definitionId, timelineId);
    if (!definition || listVariableInstances({ definitionId: definition.id }).length) return false;
    if (definition.scope === 'timeline') delete store.timelineDefinitions[definition.timelineId]?.[definition.id];
    else {
        delete store.definitions[definition.id];
        store.definitionIds = store.definitionIds.filter((id) => id !== definition.id);
    }
    for (const [id, template] of Object.entries(store.templates)) if (template.definitionId === definition.id) delete store.templates[id];
    appendEvent(store, { timelineId: definition.timelineId, definitionId: definition.id, type: 'definition.deleted', before: definition, actor: 'user' });
    saveVariableStore();
    return true;
}

export function promoteTimelineDefinition(timelineId, definitionId, { loreRef = undefined } = {}) {
    const store = getVariableStore();
    const source = store.timelineDefinitions[timelineId]?.[definitionId];
    if (!source) return null;
    const promoted = normalizeDefinition({ ...source, id: createId('var-def'), scope: 'account', timelineId: '', loreRef: loreRef === undefined ? source.loreRef : loreRef });
    store.definitions[promoted.id] = promoted;
    store.definitionIds.push(promoted.id);
    for (const instance of listVariableInstances({ timelineId, definitionId })) instance.definitionId = promoted.id;
    delete store.timelineDefinitions[timelineId][definitionId];
    appendEvent(store, { timelineId, definitionId: promoted.id, type: 'definition.promoted', before: source, after: promoted, actor: 'user' });
    saveVariableStore();
    return promoted;
}

export function listVariableTemplates({ ownerRef = null } = {}) {
    const values = Object.values(getVariableStore().templates);
    if (!ownerRef) return values;
    const key = ownerKey(ownerRef);
    return values.filter((template) => ownerKey(template.ownerRef) === key);
}

export function listDefinitionsForLoreRef(loreRef, { timelineId = '' } = {}) {
    const book = String(loreRef?.book || '');
    const uid = String(loreRef?.uid ?? '');
    if (!book || !uid) return [];
    return listVariableDefinitions({ includeTimeline: timelineId }).filter((definition) => definition.loreRef?.book === book && String(definition.loreRef.uid) === uid);
}

export function upsertVariableTemplate(input = {}) {
    const store = getVariableStore();
    const ownerRef = normalizeOwnerRef(input.ownerRef);
    const definition = getVariableDefinition(input.definitionId);
    if (!ownerRef || !definition || !['character', 'persona'].includes(ownerRef.kind)) return null;
    const existing = Object.values(store.templates).find((item) => item.definitionId === definition.id && ownerKey(item.ownerRef) === ownerKey(ownerRef));
    const template = normalizeTemplate({ ...existing, ...input, id: existing?.id || createId('var-template'), definitionId: definition.id, ownerRef }, definition);
    if (!template) return null;
    store.templates[template.id] = template;
    saveVariableStore();
    return template;
}

export function deleteVariableTemplate(templateId) {
    const store = getVariableStore();
    if (!store.templates[templateId]) return false;
    delete store.templates[templateId];
    saveVariableStore();
    return true;
}

export function instantiateTemplatesForOwner(timelineId, ownerRef) {
    const created = [];
    for (const template of listVariableTemplates({ ownerRef })) {
        if (!findVariableInstance(timelineId, template.ownerRef, template.definitionId)) {
            const instance = createVariableInstance({ timelineId, definitionId: template.definitionId, ownerRef: template.ownerRef, value: template.value, maximum: template.maximum, scaleBandId: template.scaleBandId }, { actor: 'template' });
            if (instance) created.push(instance);
        }
    }
    return created;
}

export function listVariableInstances({ timelineId = '', definitionId = '', owners = null } = {}) {
    const store = getVariableStore();
    const buckets = timelineId ? [store.timelineInstances[timelineId]].filter(Boolean) : Object.values(store.timelineInstances);
    let values = buckets.flatMap((bucket) => bucket.instanceIds.map((id) => bucket.instances[id]).filter(Boolean));
    if (definitionId) values = values.filter((instance) => instance.definitionId === definitionId);
    if (Array.isArray(owners)) {
        const wanted = new Set(owners.map(ownerKey));
        values = values.filter((instance) => wanted.has(ownerKey(instance.ownerRef)));
    }
    return values;
}

export function getVariableInstance(instanceId, timelineId = '') {
    const store = getVariableStore();
    if (timelineId) return store.timelineInstances[timelineId]?.instances?.[String(instanceId || '')] || null;
    for (const bucket of Object.values(store.timelineInstances)) {
        if (bucket.instances?.[String(instanceId || '')]) return bucket.instances[String(instanceId || '')];
    }
    return null;
}

export function findVariableInstance(timelineId, ownerRef, definitionId) {
    const key = ownerKey(ownerRef);
    return listVariableInstances({ timelineId, definitionId }).find((instance) => ownerKey(instance.ownerRef) === key) || null;
}

export function createVariableInstance(input = {}, context = {}) {
    const store = getVariableStore();
    const timelineId = String(input.timelineId || context.timelineId || '');
    const definition = getVariableDefinition(input.definitionId, timelineId);
    const ownerRef = normalizeOwnerRef(input.ownerRef);
    if (!timelineId || !definition || !ownerRef) return null;
    store.timelineInstances[timelineId] ??= timelineBucket(timelineId);
    const duplicate = findVariableInstance(timelineId, ownerRef, definition.id);
    if (duplicate) return duplicate;
    const instance = normalizeInstance({ ...input, id: input.id || createId('var'), timelineId, definitionId: definition.id, ownerRef }, definition);
    if (!instance) return null;
    store.timelineInstances[timelineId].instances[instance.id] = instance;
    store.timelineInstances[timelineId].instanceIds.push(instance.id);
    appendEvent(store, { timelineId, instanceId: instance.id, definitionId: definition.id, type: 'instance.created', after: instance, actor: context.actor || 'user', reason: context.reason });
    saveVariableStore();
    return instance;
}

export function updateVariableInstance(instanceId, patch = {}, context = {}) {
    const store = getVariableStore();
    const instance = getVariableInstance(instanceId, context.timelineId);
    if (!instance) return null;
    const definition = getVariableDefinition(instance.definitionId, instance.timelineId);
    if (!definition) return null;
    const before = clone(instance);
    if ('value' in patch) instance.value = normalizeValue(patch.value, definition, instance.maximum);
    if ('maximum' in patch && definition.kind === 'resource') {
        const maximum = normalizeMaximum(patch.maximum, definition);
        if (maximum != null) instance.maximum = maximum;
    }
    if ('ownerRef' in patch) instance.ownerRef = normalizeOwnerRef(patch.ownerRef) || instance.ownerRef;
    if (Array.isArray(patch.modifiers)) instance.modifiers = patch.modifiers.map(normalizeModifier).filter(Boolean);
    instance.value = normalizeValue(instance.value, definition, instance.maximum);
    instance.updatedAt = now();
    appendEvent(store, { timelineId: instance.timelineId, instanceId: instance.id, definitionId: instance.definitionId, type: context.type || 'instance.updated', before, after: instance, actor: context.actor || 'system', reason: context.reason, transactionId: context.transactionId });
    saveVariableStore();
    return instance;
}

export function adjustVariableInstance(instanceId, delta, context = {}) {
    const instance = getVariableInstance(instanceId, context.timelineId);
    const definition = instance && getVariableDefinition(instance.definitionId, instance.timelineId);
    if (!instance || !definition || !['resource', 'number'].includes(definition.kind)) return null;
    return updateVariableInstance(instance.id, { value: Number(instance.value) + Number(delta || 0) }, { ...context, type: context.type || 'instance.adjusted' });
}

export function transitionVariableInstance(instanceId, nextState, context = {}) {
    const instance = getVariableInstance(instanceId, context.timelineId);
    const definition = instance && getVariableDefinition(instance.definitionId, instance.timelineId);
    if (!instance || !definition || !['enum', 'boolean'].includes(definition.kind)) return null;
    const target = definition.kind === 'boolean' ? Boolean(nextState) : String(nextState || '');
    if (definition.kind === 'enum') {
        if (!definition.enumStates.some((state) => state.id === target)) return null;
        const restricted = definition.enumTransitions.length > 0;
        if (restricted && !definition.enumTransitions.some((edge) => edge.from === instance.value && edge.to === target)) return null;
    }
    return updateVariableInstance(instance.id, { value: target }, { ...context, type: 'instance.transitioned' });
}

export function addVariableModifier(instanceId, input = {}, context = {}) {
    const instance = getVariableInstance(instanceId, context.timelineId);
    if (!instance) return null;
    const modifier = normalizeModifier({ ...input, id: input.id || createId('var-mod'), createdAt: now() });
    if (!modifier) return null;
    const updated = updateVariableInstance(instance.id, { modifiers: [...instance.modifiers, modifier] }, { ...context, type: 'modifier.added' });
    return updated?.modifiers.find((item) => item.id === modifier.id) || null;
}

export function removeVariableModifier(instanceId, modifierId, context = {}) {
    const instance = getVariableInstance(instanceId, context.timelineId);
    if (!instance || !instance.modifiers.some((modifier) => modifier.id === modifierId)) return false;
    updateVariableInstance(instance.id, { modifiers: instance.modifiers.filter((modifier) => modifier.id !== modifierId) }, { ...context, type: 'modifier.removed' });
    return true;
}

export function computeVariable(instance) {
    if (!instance) return null;
    const definition = getVariableDefinition(instance.definitionId, instance.timelineId);
    if (!definition) return null;
    const sum = (target) => instance.modifiers.filter((modifier) => modifier.target === target).reduce((total, modifier) => total + modifier.delta, 0);
    let maximum = definition.kind === 'resource' ? Math.max(0, Number(instance.maximum) + sum('maximum')) : null;
    let value = instance.value;
    if (['resource', 'number'].includes(definition.kind)) {
        value = Number(value) + sum('value');
        value = normalizeValue(value, definition, maximum);
    }
    const reachModifier = reachContribution(definition, value) + sum('reach');
    return { definition, value, maximum, reachModifier, derivedState: deriveVariableState(definition, value, maximum), modifiers: clone(instance.modifiers) };
}

export function formatVariable(instance) {
    const computed = computeVariable(instance);
    if (!computed) return '';
    if (computed.definition.kind === 'resource') return `${computed.value}/${computed.maximum}`;
    if (computed.definition.kind === 'boolean') return computed.value ? 'Yes' : 'No';
    const state = computed.definition.enumStates.find((item) => item.id === computed.value);
    return state?.label || String(computed.value);
}

export function getVariableScaleBands(definitionOrId, timelineId = '') {
    const definition = typeof definitionOrId === 'string' ? getVariableDefinition(definitionOrId, timelineId) : definitionOrId;
    return definition?.kind === 'resource' ? clone(definition.scaleBands || []) : [];
}

export function getVariableScaleBand(definitionOrId, scaleBandId, timelineId = '') {
    const id = String(scaleBandId || '');
    return getVariableScaleBands(definitionOrId, timelineId).find((band) => band.id === id) || null;
}

export function resolveImpactDelta(instance, magnitude) {
    const computed = computeVariable(instance);
    if (!computed || !IMPACT_MAGNITUDES.includes(magnitude) || !['resource', 'number'].includes(computed.definition.kind)) return null;
    const configured = computed.definition.impactScale[magnitude];
    if (computed.definition.kind === 'resource') {
        const ratio = Number.isFinite(Number(configured)) ? Number(configured) : RESOURCE_IMPACT[magnitude];
        return Math.max(1, Math.round(computed.maximum * ratio));
    }
    return Math.max(0, Math.round(Number.isFinite(Number(configured)) ? Number(configured) : NUMBER_IMPACT[magnitude]));
}

export function listVariableEvents({ timelineId = '', instanceId = '' } = {}) {
    const store = getVariableStore();
    return store.eventIds.map((id) => store.events[id]).filter(Boolean)
        .filter((event) => !timelineId || event.timelineId === timelineId)
        .filter((event) => !instanceId || event.instanceId === instanceId)
        .map(clone);
}

export function recordMechanicsTransaction(input = {}) {
    const store = getVariableStore();
    const transaction = {
        id: String(input.id || createId('mechanics-tx')),
        protocol: String(input.protocol || 'remodel-mechanics/1'),
        timelineId: String(input.timelineId || ''),
        sceneId: String(input.sceneId || ''),
        turnId: String(input.turnId || ''),
        directionId: String(input.directionId || ''),
        messageId: input.messageId == null ? null : Number(input.messageId),
        checkpointId: String(input.checkpointId || ''),
        status: ['applied', 'pending', 'rejected', 'rolled-back'].includes(input.status) ? input.status : 'applied',
        requests: clone(input.requests || []),
        receipts: clone(input.receipts || []),
        undo: clone(input.undo || null),
        createdAt: input.createdAt || now(),
    };
    store.transactions[transaction.id] = transaction;
    if (!store.transactionIds.includes(transaction.id)) store.transactionIds.push(transaction.id);
    saveVariableStore();
    return transaction;
}

export function listMechanicsTransactions({ timelineId = '', sceneId = '' } = {}) {
    const store = getVariableStore();
    return store.transactionIds.map((id) => store.transactions[id]).filter(Boolean)
        .filter((item) => !timelineId || item.timelineId === timelineId)
        .filter((item) => !sceneId || item.sceneId === sceneId)
        .map(clone);
}

export function deleteVariablesForTimeline(timelineId) {
    const store = getVariableStore();
    delete store.timelineDefinitions[timelineId];
    delete store.timelineInstances[timelineId];
    for (const [id, event] of Object.entries(store.events)) if (event.timelineId === timelineId) delete store.events[id];
    store.eventIds = store.eventIds.filter((id) => store.events[id]);
    for (const [id, transaction] of Object.entries(store.transactions)) if (transaction.timelineId === timelineId) delete store.transactions[id];
    store.transactionIds = store.transactionIds.filter((id) => store.transactions[id]);
    saveVariableStore();
}

export function normalizeOwnerRef(value, fallbackLabel = '') {
    if (!value || typeof value !== 'object') return null;
    const kind = OWNER_KINDS.includes(value.kind) ? value.kind : 'custom';
    const id = String(value.id || '').trim();
    const label = String(value.label || fallbackLabel || id).trim();
    return id && label ? { kind, id, label } : null;
}

export function ownerKey(value) {
    const owner = normalizeOwnerRef(value);
    return owner ? `${owner.kind}:${owner.id}` : '';
}

function emptyStore() {
    return {
        version: STORE_VERSION, definitionIds: [], definitions: {}, templates: {}, timelineDefinitions: {}, timelineInstances: {},
        eventIds: [], events: {}, transactionIds: [], transactions: {}, legacyReview: [], migration: { legacyStatsImported: false },
        mechanicsProfile: { enabled: false, handbookAdditions: '', contextBudget: 6000, automationPolicy: 'hybrid', failureBehavior: 'pause', updatedAt: now() },
    };
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && value.definitions && value.timelineInstances && value.events);
}

function normalizeStore(store) {
    const original = JSON.stringify(store);
    const previousVersion = Math.max(1, Math.round(Number(store.version) || 1));
    if (previousVersion < 2) {
        migrateResourceDefaultsToBands(store);
        store.version = STORE_VERSION;
    }
    Object.assign(store, { version: STORE_VERSION });
    for (const key of ['definitions', 'templates', 'timelineDefinitions', 'timelineInstances', 'events', 'transactions']) if (!plainObject(store[key])) store[key] = {};
    store.definitionIds = uniqueIds(store.definitionIds).filter((id) => store.definitions[id]);
    store.eventIds = uniqueIds(store.eventIds).filter((id) => store.events[id]);
    store.transactionIds = uniqueIds(store.transactionIds).filter((id) => store.transactions[id]);
    store.legacyReview = Array.isArray(store.legacyReview) ? store.legacyReview : [];
    store.migration = { legacyStatsImported: Boolean(store.migration?.legacyStatsImported) };
    store.mechanicsProfile = { ...emptyStore().mechanicsProfile, ...(plainObject(store.mechanicsProfile) ? store.mechanicsProfile : {}) };
    for (const [id, raw] of Object.entries(store.definitions)) {
        const definition = normalizeDefinition({ ...raw, id, scope: 'account', timelineId: '' });
        if (definition) { store.definitions[id] = replaceObject(raw, definition); if (!store.definitionIds.includes(id)) store.definitionIds.push(id); } else delete store.definitions[id];
    }
    for (const [timelineId, rawDefinitions] of Object.entries(store.timelineDefinitions)) {
        if (!plainObject(rawDefinitions)) { delete store.timelineDefinitions[timelineId]; continue; }
        for (const [id, raw] of Object.entries(rawDefinitions)) {
            const definition = normalizeDefinition({ ...raw, id, scope: 'timeline', timelineId });
            if (definition) rawDefinitions[id] = replaceObject(raw, definition); else delete rawDefinitions[id];
        }
    }
    for (const [id, raw] of Object.entries(store.templates)) {
        const definition = store.definitions[raw?.definitionId];
        const template = definition ? normalizeTemplate({ ...raw, id }, definition) : null;
        if (template) store.templates[id] = replaceObject(raw, template); else delete store.templates[id];
    }
    for (const [timelineId, rawBucket] of Object.entries(store.timelineInstances)) {
        const bucket = plainObject(rawBucket) ? rawBucket : timelineBucket(timelineId);
        bucket.timelineId = timelineId;
        if (!plainObject(bucket.instances)) bucket.instances = {};
        bucket.instanceIds = uniqueIds(bucket.instanceIds);
        for (const [id, raw] of Object.entries(bucket.instances)) {
            const definition = store.definitions[raw?.definitionId] || store.timelineDefinitions[timelineId]?.[raw?.definitionId];
            const instance = definition ? normalizeInstance({ ...raw, id, timelineId }, definition) : null;
            if (instance) { bucket.instances[id] = replaceObject(raw, instance); if (!bucket.instanceIds.includes(id)) bucket.instanceIds.push(id); } else delete bucket.instances[id];
        }
        bucket.instanceIds = bucket.instanceIds.filter((id) => bucket.instances[id]);
        store.timelineInstances[timelineId] = bucket;
    }
    return JSON.stringify(store) !== original;
}

function normalizeDefinition(value) {
    if (!value?.id) return null;
    const kind = VARIABLE_KINDS.includes(value.kind) ? value.kind : 'number';
    const enumStates = kind === 'enum' ? normalizeEnumStates(value.enumStates) : [];
    const constraints = normalizeConstraints(value.constraints, kind, enumStates);
    const defaultValue = kind === 'resource' ? null : normalizeValue(value.defaultValue ?? defaultFor(kind, enumStates), { kind, constraints, enumStates }, null);
    return {
        id: String(value.id), key: slug(value.key || value.name || 'variable'), name: String(value.name || value.key || 'Variable').trim(), kind,
        scope: value.scope === 'timeline' ? 'timeline' : 'account', timelineId: value.scope === 'timeline' ? String(value.timelineId || '') : '',
        loreRef: normalizeLoreRef(value.loreRef), summary: String(value.summary || ''), defaultValue, constraints,
        scaleBands: kind === 'resource' ? normalizeScaleBands(value.scaleBands) : [],
        enumStates, enumTransitions: kind === 'enum' ? normalizeTransitions(value.enumTransitions, enumStates) : [],
        reachContribution: normalizeReachContribution(value.reachContribution, kind, enumStates), impactScale: normalizeImpactScale(value.impactScale, kind),
        capabilities: normalizeCapabilities(value.capabilities, kind), createdAt: value.createdAt || now(), updatedAt: value.updatedAt || now(),
    };
}

function normalizeInstance(value, definition) {
    const ownerRef = normalizeOwnerRef(value.ownerRef);
    if (!value?.id || !value.timelineId || !ownerRef) return null;
    const scaleBand = definition.kind === 'resource' ? resolveScaleBand(definition, value.scaleBandId) : null;
    const maximum = definition.kind === 'resource' ? normalizeMaximum(value.maximum ?? scaleBand?.maximum, definition) : null;
    if (definition.kind === 'resource' && maximum == null) return null;
    const initialValue = definition.kind === 'resource' ? (value.value ?? maximum) : (value.value ?? definition.defaultValue);
    return { id: String(value.id), timelineId: String(value.timelineId), definitionId: definition.id, ownerRef, value: normalizeValue(initialValue, definition, maximum), maximum, scaleBandId: scaleBand?.id || '', modifiers: Array.isArray(value.modifiers) ? value.modifiers.map(normalizeModifier).filter(Boolean) : [], createdAt: value.createdAt || now(), updatedAt: value.updatedAt || now() };
}

function normalizeTemplate(value, definition) {
    const ownerRef = normalizeOwnerRef(value.ownerRef);
    if (!value?.id || !ownerRef) return null;
    const scaleBand = definition.kind === 'resource' ? resolveScaleBand(definition, value.scaleBandId) : null;
    const maximum = definition.kind === 'resource' ? normalizeMaximum(value.maximum ?? scaleBand?.maximum, definition) : null;
    if (definition.kind === 'resource' && maximum == null) return null;
    const initialValue = definition.kind === 'resource' ? (value.value ?? maximum) : (value.value ?? definition.defaultValue);
    return { id: String(value.id), definitionId: definition.id, ownerRef, value: normalizeValue(initialValue, definition, maximum), maximum, scaleBandId: scaleBand?.id || '', createdAt: value.createdAt || now(), updatedAt: now() };
}

function normalizeValue(value, definition, maximum = null) {
    if (definition.kind === 'boolean') return Boolean(value);
    if (definition.kind === 'enum') return definition.enumStates.some((state) => state.id === String(value)) ? String(value) : definition.enumStates[0]?.id || '';
    let number = Number(value);
    if (!Number.isFinite(number)) number = 0;
    const min = Number.isFinite(definition.constraints?.minimum) ? definition.constraints.minimum : -Infinity;
    const max = definition.kind === 'resource' ? Number(maximum) : (Number.isFinite(definition.constraints?.maximum) ? definition.constraints.maximum : Infinity);
    return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeMaximum(value, definition) {
    const minimum = Math.max(1, Number(definition.constraints.minimum) || 0);
    const maximum = Number(value);
    return Number.isFinite(maximum) && maximum > 0 ? Math.max(minimum, Math.round(maximum)) : null;
}

function normalizeConstraints(value, kind, enumStates) {
    const finiteOr = (candidate, fallback) => candidate !== null && candidate !== undefined && candidate !== '' && Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
    if (kind === 'resource') return { minimum: finiteOr(value?.minimum, 0), maximum: null, defaultMaximum: null, clamp: true };
    if (kind === 'number') return { minimum: finiteOr(value?.minimum, null), maximum: finiteOr(value?.maximum, null), defaultMaximum: null, clamp: value?.clamp !== false };
    return { minimum: null, maximum: null, defaultMaximum: null, clamp: true, allowed: kind === 'enum' ? enumStates.map((state) => state.id) : [false, true] };
}

function normalizeEnumStates(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map((entry) => typeof entry === 'string' ? { id: slug(entry), label: entry } : { id: slug(entry?.id || entry?.label), label: String(entry?.label || entry?.id || '').trim(), reachModifier: Math.round(Number(entry?.reachModifier) || 0) }).filter((entry) => entry.id && entry.label && !seen.has(entry.id) && seen.add(entry.id));
}

function normalizeScaleBands(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map((entry) => {
        const label = String(entry?.label || entry?.id || '').trim();
        const id = slug(entry?.id || label);
        const maximum = Math.round(Number(entry?.maximum));
        return { id, label, maximum };
    }).filter((entry) => {
        if (!entry.id || !entry.label || !Number.isFinite(entry.maximum) || entry.maximum <= 0 || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
    });
}

function resolveScaleBand(definition, scaleBandId) {
    const id = String(scaleBandId || '');
    return definition.scaleBands?.find((band) => band.id === id) || null;
}

function normalizeTransitions(value, states) {
    const allowed = new Set(states.map((state) => state.id));
    return (Array.isArray(value) ? value : []).map((edge) => ({ from: String(edge?.from || ''), to: String(edge?.to || '') })).filter((edge) => allowed.has(edge.from) && allowed.has(edge.to) && edge.from !== edge.to);
}

function normalizeReachContribution(value, kind, states) {
    const allowed = ['none', 'numeric', 'enum-map', 'boolean-map'];
    let mode = allowed.includes(value?.mode) ? value.mode : 'none';
    if (kind === 'enum' && mode === 'numeric') mode = 'enum-map';
    if (kind === 'boolean' && mode === 'numeric') mode = 'boolean-map';
    const values = plainObject(value?.values) ? Object.fromEntries(Object.entries(value.values).map(([key, number]) => [key, Math.round(Number(number) || 0)])) : {};
    for (const state of states) if (state.reachModifier && values[state.id] == null) values[state.id] = state.reachModifier;
    return { mode, values };
}

function normalizeImpactScale(value, kind) {
    const defaults = kind === 'resource' ? RESOURCE_IMPACT : kind === 'number' ? NUMBER_IMPACT : {};
    return Object.fromEntries(IMPACT_MAGNITUDES.map((key) => [key, Number.isFinite(Number(value?.[key])) ? Number(value[key]) : defaults[key] ?? 0]));
}

function normalizeCapabilities(value, kind) {
    const defaults = kind === 'resource' || kind === 'number' ? ['variable.adjust', 'modifier.add', 'modifier.remove'] : ['variable.transition', 'modifier.add', 'modifier.remove'];
    return [...new Set((Array.isArray(value) ? value : defaults).map(String).filter(Boolean))];
}

function normalizeLoreRef(value) {
    const book = String(value?.book || '').trim();
    return book && value?.uid != null ? { book, uid: String(value.uid) } : null;
}

function normalizeModifier(value) {
    if (!value || typeof value !== 'object') return null;
    const target = MODIFIER_TARGETS.includes(value.target) ? value.target : 'value';
    const delta = Math.round(Number(value.delta) || 0);
    if (!delta) return null;
    const legacyDuration = value.legacyDuration ?? (value.duration == null ? null : Math.max(1, Math.round(Number(value.duration) || 1)));
    const legacyNote = legacyDuration == null ? '' : `Legacy duration was ${legacyDuration}; it now persists until fiction explicitly ends it.`;
    return {
        id: String(value.id || createId('var-mod')),
        label: String(value.label || 'Effect').trim(),
        delta,
        target,
        scope: value.scope === 'scene' ? 'scene' : 'persistent',
        sceneId: value.scope === 'scene' ? String(value.sceneId || '') : '',
        endingCondition: String(value.endingCondition || legacyNote),
        legacyDuration,
        reason: String(value.reason || ''),
        source: String(value.source || 'user'),
        createdAt: value.createdAt || now(),
    };
}

function reachContribution(definition, value) {
    const config = definition.reachContribution;
    if (config.mode === 'numeric') return Math.round(Number(value) || 0);
    if (config.mode === 'enum-map') return Math.round(Number(config.values[String(value)]) || 0);
    if (config.mode === 'boolean-map') return Math.round(Number(config.values[String(Boolean(value))]) || 0);
    return 0;
}

function deriveVariableState(definition, value, maximum) {
    if (definition.kind === 'enum') return definition.enumStates.find((state) => state.id === value)?.label || '';
    if (definition.kind === 'boolean') return value ? 'Active' : 'Inactive';
    if (definition.kind !== 'resource' || !maximum) return '';
    const ratio = Number(value) / Number(maximum);
    if (ratio <= 0) return 'Depleted';
    if (ratio <= .3) return 'Critical';
    if (ratio <= .6) return 'Strained';
    return 'Stable';
}

function migrateResourceDefaultsToBands(store) {
    const migrate = (definition) => {
        if (!definition || definition.kind !== 'resource' || Array.isArray(definition.scaleBands)) return;
        const maximum = Math.round(Number(definition.constraints?.defaultMaximum));
        definition.scaleBands = Number.isFinite(maximum) && maximum > 0
            ? [{ id: 'legacy-default', label: 'Legacy default', maximum }]
            : [];
    };
    for (const definition of Object.values(store.definitions || {})) migrate(definition);
    for (const definitions of Object.values(store.timelineDefinitions || {})) {
        for (const definition of Object.values(definitions || {})) migrate(definition);
    }
}

function migrateLegacyStats(store, legacy) {
    const definitionsByKey = new Map();
    for (const raw of Object.values(legacy?.instances || {})) {
        const name = String(raw?.name || '').trim();
        const owner = String(raw?.owner || '').trim();
        if (!name || !owner) continue;
        const key = `${String(raw?.typeRef?.book || '')}:${String(raw?.typeRef?.uid ?? '')}:${name.toLowerCase()}`;
        let definition = definitionsByKey.get(key);
        if (!definition) {
            definition = normalizeDefinition({
                id: createId('var-def'),
                key: slug(name),
                name,
                kind: raw.max == null ? 'number' : 'resource',
                loreRef: raw.typeRef ? { book: raw.typeRef.book, uid: raw.typeRef.uid } : null,
                defaultValue: raw.max == null ? raw.base : null,
                scaleBands: raw.max == null ? [] : [{ id: 'legacy-import', label: 'Imported scale', maximum: raw.max }],
                summary: 'Imported from the Story Stats prototype.',
            });
            store.definitions[definition.id] = definition;
            store.definitionIds.push(definition.id);
            definitionsByKey.set(key, definition);
        }
        store.legacyReview.push({ id: createId('legacy-var'), definitionId: definition.id, ownerLabel: owner, value: raw.base, maximum: raw.max, modifiers: clone(raw.modifiers || []), reason: 'The legacy stat used a free-form owner name and needs a stable owner and Timeline.' });
    }
}

function appendEvent(store, input) {
    const event = { id: createId('var-event'), timelineId: String(input.timelineId || ''), definitionId: String(input.definitionId || ''), instanceId: String(input.instanceId || ''), transactionId: String(input.transactionId || ''), type: String(input.type || 'variable.note'), before: clone(input.before ?? null), after: clone(input.after ?? null), reason: String(input.reason || ''), actor: String(input.actor || 'system'), createdAt: now() };
    store.events[event.id] = event;
    store.eventIds.push(event.id);
    return event;
}

function timelineBucket(timelineId) { return { timelineId, instanceIds: [], instances: {} }; }
function defaultFor(kind, states) { return kind === 'boolean' ? false : kind === 'enum' ? states[0]?.id || '' : kind === 'resource' ? 100 : 0; }
function replaceObject(target, source) {
    if (!plainObject(target)) return source;
    for (const key of Object.keys(target)) delete target[key];
    return Object.assign(target, source);
}
function plainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function uniqueIds(value) { return [...new Set((Array.isArray(value) ? value : []).filter(Boolean).map(String))]; }
function slug(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'variable'; }
function clampInt(value, min, max, fallback) { const number = Math.round(Number(value)); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback; }
function clone(value) { return value == null ? value : structuredClone(value); }
function now() { return new Date().toISOString(); }
function createId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
