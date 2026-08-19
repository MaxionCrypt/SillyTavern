import {
    VARIABLE_KINDS,
    addVariableModifier,
    adjustVariableValue,
    computeVariable,
    createVariableValue,
    getVariableValue,
    listVariableValues,
    normalizeOwnerRef,
    recordMechanicsTransaction,
    removeVariableModifier,
    setVariableField,
    restoreVariableStore,
    snapshotVariableStore,
    transitionVariableValue,
} from './variables-store.js';
import {
    createTimelineGoal,
    createTimelineGoalRelation,
    getPendingOps,
    getStoryGoal,
    queuePendingOps,
    restoreStoryGoalsStore,
    snapshotStoryGoalsStore,
    updateStoryGoal,
    deleteStoryGoal,
    takePendingOp,
} from './story-goals-store.js';
import { clampRate, resolveReach } from './story-goals-math.js';
import { STORY_GOAL_STATUSES, STORY_GOAL_VISIBILITIES } from './story-goals-model.js';
import {
    setSceneFact,
    clearSceneFact,
    recordEvent,
    setCharStateFacet,
    clearCharStateFacet,
    setBeat,
    setSecret,
    clearSecret,
    snapshotArchivistStore,
    restoreArchivistStore,
} from './archivist-store.js';

export const MECHANICS_PROTOCOL = 'remodel-mechanics/1';

const CAPABILITY_NAMES = Object.freeze([
    'goal.create', 'goal.edit', 'goal.delete', 'goal.reach', 'goal.relate',
    'variable.create', 'variable.set', 'variable.adjust', 'variable.transition', 'variable.subvalue.set',
    'modifier.add', 'modifier.remove',
    'scene.set', 'scene.clear', 'event.record', 'char_state.set', 'char_state.clear', 'beat.set', 'secret.set', 'secret.clear',
]);

const CAPABILITIES = Object.freeze({
    'goal.create': capability('Create a meaningful unresolved Story Goal using typed holders and targets.', ['timeline'], 'hybrid'),
    'goal.edit': capability('Change anything about an existing Goal: its Success Rate, status, title, description, or visibility. Supply only the fields you are changing. A separate fictional reason is always required.', ['goal'], 'hybrid'),
    'goal.delete': capability('Remove a Goal that should no longer exist at all. Prefer goal.edit with a terminal status when the Goal simply ended — a Goal that was achieved or abandoned is part of the record.', ['goal'], 'hybrid'),
    'goal.reach': capability('Declare one decisive attempt against a Goal. Code freezes inputs and rolls d100.', ['goal'], 'hybrid'),
    'goal.relate': capability('Create or update a directional sympathetic or antagonistic Goal relationship.', ['goal'], 'hybrid'),
    'variable.create': capability('Bring into being a Variable this Timeline does not have yet, when a mechanical fact matters and none of the Variables above covers it. Give it a name no existing Variable already uses; you may address it from the NEXT turn onward, never the turn you create it. Changes you later request to it are held for the user to review.', ['number', 'enum', 'text', 'boolean'], 'review'),
    'variable.set': capability('Set the primary scalar value of an advertised Variable.', ['number', 'enum', 'text', 'boolean'], 'hybrid'),
    'variable.adjust': capability('Adjust an advertised numeric Variable or numeric subvalue.', ['number'], 'hybrid'),
    'variable.transition': capability('Move an advertised enum Variable or enum subvalue to an allowed state.', ['enum'], 'hybrid'),
    'variable.subvalue.set': capability('Set one advertised scalar subvalue.', ['number', 'enum', 'text', 'boolean'], 'hybrid'),
    'modifier.add': capability('Attach a bounded value or maximum modifier to an advertised Variable.', ['variable'], 'hybrid'),
    'modifier.remove': capability('Remove one existing Variable modifier by ID.', ['variable'], 'hybrid'),
    'scene.set': capability('Record or update a scene fact the Narrator treats as given — location, time of day, weather, atmosphere. Overwriting the same key replaces it.', ['narrative'], 'hybrid'),
    'scene.clear': capability('Remove a scene fact that no longer holds.', ['narrative'], 'hybrid'),
    'event.record': capability('Append one thing that has just happened to the permanent event log. Append-only — the Narrator reads this as "already written, do not restate".', ['narrative'], 'hybrid'),
    'char_state.set': capability("Set one facet of a character's current state — mood, injury, stance. Overwrites that facet.", ['narrative'], 'hybrid'),
    'char_state.clear': capability("Remove one facet of a character's current state that no longer applies.", ['narrative'], 'hybrid'),
    'beat.set': capability("Set the current beat — what should happen next. Replaces the previous beat. This is the Narrator's forward instruction.", ['narrative'], 'hybrid'),
    'secret.set': capability('Store knowledge the Narrator must not see — a twist or hidden motive. Overwriting the same key replaces it.', ['narrative'], 'hybrid'),
    'secret.clear': capability('Remove a secret, e.g. once it has been revealed.', ['narrative'], 'hybrid'),
});

export function getCapabilityDictionary() {
    // `requiredArguments` travels with every capability so direction-sources.js
    // can render it without importing this module — it is required to stay free
    // of anything that reaches st-context.js.
    return CAPABILITY_NAMES.map((name) => ({
        name,
        ...CAPABILITIES[name],
        requiredArguments: (REQUIRED_ARGUMENTS[name] || []).map(([key, hint]) => ({ key, hint })),
    }));
}

/**
 * Adapt one of our schema descriptors to the shape core actually reads.
 *
 * This boundary bites. Our builders describe a schema as `{ name, strict,
 * schema }`, but core's `JsonSchema` typedef (script.js, `@typedef JsonSchema`)
 * is `{ name, value, description?, strict? }` — the payload lives under
 * **value**, not `schema`. The server then forwards it per provider, e.g. for
 * OpenRouter (src/endpoints/backends/chat-completions.js):
 *
 *     response_format = { type: 'json_schema', json_schema: {
 *         name: body.json_schema.name, schema: body.json_schema.value, … } }
 *
 * Hand it a bare schema object and both reads come back undefined, so what
 * ships is `{"type":"json_schema","json_schema":{"strict":true}}` — a
 * structured-output request with no schema in it. Nothing errors. The provider
 * shrugs, the model never sees the protocol, and it invents a plausible reply
 * shape instead. Always cross this boundary through here.
 *
 * @param {{name: string, description?: string, strict?: boolean, schema: object}} descriptor
 * @returns {{name: string, description: string, strict: boolean, value: object}}
 */
export function toCoreJsonSchema(descriptor) {
    return {
        name: descriptor?.name || 'remodel_structured_reply',
        description: descriptor?.description || 'Well-formed JSON object',
        strict: descriptor?.strict !== false,
        value: descriptor?.schema,
    };
}

export function getMechanicsRequestSchema() {
    return {
        name: 'remodel_mechanics_request',
        description: 'A batch of semantic requests for Remodel deterministic mechanics.',
        strict: true,
        schema: {
            type: 'object', additionalProperties: false, required: ['protocol', 'requests'],
            properties: {
                protocol: { type: 'string', const: MECHANICS_PROTOCOL },
                requests: {
                    type: 'array', maxItems: 32,
                    items: {
                        type: 'object', additionalProperties: false, required: ['id', 'capability', 'arguments', 'reason'],
                        properties: {
                            id: { type: 'string', minLength: 1, maxLength: 80, description: 'A unique id for this request within the batch. Used only to reference it in receipts and errors — invent any short stable string.' },
                            capability: { type: 'string', enum: CAPABILITY_NAMES, description: 'The operation to perform. Must be one of the advertised capabilities; each has its own required arguments below.' },
                            arguments: {
                                type: 'object', additionalProperties: false,
                                description: 'Only the fields the chosen capability needs are read; the rest are ignored. Every *Ref field below is the exact Variable or Goal name advertised this turn — never an id, and never a name that was not advertised.',
                                properties: {
                                    alias: { type: 'string', description: 'A local name ($alias) for a Goal this request creates, so a later request in the same batch can address it before it has a real name — see goalRef.' },
                                    goalRef: { type: 'string', description: 'The Goal this request addresses: its exact advertised name, or an earlier request\'s $alias.' },
                                    fromGoalRef: { type: 'string', description: 'goal.relate only: the Goal the relationship starts from, addressed the same way as goalRef.' },
                                    toGoalRef: { type: 'string', description: 'goal.relate only: the Goal the relationship points to, addressed the same way as goalRef.' },
                                    title: { type: 'string', description: 'goal.create and goal.edit: the Goal\'s title.' },
                                    description: { type: 'string', description: 'goal.create: what this Goal is, for the Goal record itself. variable.create: what this new Variable means in the fiction, in one line — you are shown it again every time the Variable is retrieved, so write it for your future self.' },
                                    visibility: { type: 'string', enum: ['public', 'secret'], description: 'goal.create and goal.edit: whether the user can see this Goal exists. Use secret for a twist or a threat the user has not discovered.' },
                                    holderRefs: { type: 'array', items: ownerRefSchema(), description: 'goal.create only: who holds this Goal — at least one typed owner is required.' },
                                    targetRefs: { type: 'array', items: ownerRefSchema(), description: 'goal.create only: who or what the Goal is directed at, if it has a target. Optional.' },
                                    successRate: { type: 'number', description: 'goal.create and goal.edit: the Goal\'s Success Rate as a number. It is clamped to 5-95, because a Goal that is already certain or already impossible is a status rather than a roll. Your guidance gives reference points for what a given chance is worth; choose the number that fits this Goal.' },
                                    impact: { type: 'number', description: 'goal.reach only, for a tracked Goal: how far the tracked Variable moves when this reach hits, in that Variable\'s own units.' },
                                    type: { type: 'string', enum: ['antagonistic', 'sympathetic'], description: 'goal.relate only: whether progress on fromGoalRef helps (sympathetic) or hurts (antagonistic) toGoalRef.' },
                                    status: { type: 'string', enum: ['active', 'achieved', 'abandoned', 'impossible'], description: 'goal.edit only: the Goal\'s state. Use achieved, abandoned or impossible to end it; active to reopen one that ended.' },
                                    name: { type: 'string', description: 'variable.create only: the new Variable\'s name. It must not match any Variable this Timeline already has (compared ignoring case and surrounding spaces) and it is the exact name you will address it by from the next turn on, so name it the way you would want to read it back: "Aiden\'s Corruption", not "corruption2".' },
                                    valueType: { type: 'string', enum: ['number', 'enum', 'text', 'boolean'], description: 'variable.create only: what the new Variable holds. number for a quantity that rises and falls, enum for one of a fixed set of named states, boolean for a fact that is simply true or false, text for a short phrase.' },
                                    enumValues: { type: 'array', items: { type: 'string' }, description: 'variable.create only, and only when valueType is enum: every state this Variable may ever occupy, at least two of them. variable.transition can later move it to one of these and to nothing else, so list them all now.' },
                                    minimum: { type: 'number', description: 'variable.create only, and only when valueType is number: the lowest this value may fall to. Omit it for no floor.' },
                                    maximum: { type: 'number', description: 'variable.create only, and only when valueType is number: the highest this value may rise to — the "20" in "12 / 20". Omit it for no ceiling.' },
                                    variableRef: { type: 'string', description: 'The exact advertised name of the Variable this request addresses. Required by every variable.* and modifier.* capability except variable.create (which names a Variable that does not exist yet — see name) and except where modifierVariableRef applies instead.' },
                                    modifierVariableRef: { type: 'string', description: 'modifier.add / modifier.remove only: the exact advertised name of the Variable the modifier is attached to or removed from.' },
                                    modifierId: { type: 'string', description: 'modifier.remove only: the id of the existing modifier to remove, as it appears on the Variable\'s record.' },
                                    field: { type: 'string', description: 'variable.subvalue.set: which advertised subvalue to set. variable.adjust / variable.transition: which field to change; omit for the Variable\'s primary value.' },
                                    value: { type: ['number', 'string', 'boolean'], description: 'variable.set / variable.subvalue.set: the exact value to write, matching the field\'s type. variable.create: the value the new Variable starts at, matching its valueType — one of the enumValues for an enum, and within minimum/maximum for a number.' },
                                    delta: { type: 'number', description: 'variable.adjust only: the numeric amount to add (negative to subtract). modifier.add only: the modifier\'s amount.' },
                                    nextState: { type: ['string', 'boolean'], description: 'variable.transition only: the state to move the enum (or boolean) Variable to. Must be a state the Variable\'s definition allows.' },
                                    label: { type: 'string', description: 'modifier.add only: a short label identifying this modifier, e.g. "Wounded" or "Blessed".' },
                                    target: { type: 'string', enum: ['value', 'maximum'], description: 'modifier.add only: whether the modifier bounds the Variable\'s value or its maximum.' },
                                    endingCondition: { type: 'string', description: 'modifier.add only: in prose, when this modifier should end. Code does not expire it automatically — this is a note for whoever reviews it later.' },
                                    key: { type: 'string', description: 'scene.set / scene.clear / secret.set / secret.clear: the fact or secret name — the stable key you address it by.' },
                                    summary: { type: 'string', description: 'event.record only: what just happened, one line. Appended to the permanent log the Narrator reads as already-written.' },
                                    charId: { type: 'string', description: 'char_state.set / char_state.clear: which character, by cast name.' },
                                    facet: { type: 'string', description: 'char_state.set / char_state.clear: which facet of the character\'s current state, e.g. "mood", "injury", "stance".' },
                                    directive: { type: 'string', description: 'beat.set only: what should happen next — the Narrator\'s forward instruction.' },
                                    tone: { type: 'string', description: 'beat.set only, optional: the emotional register of the next beat, e.g. "tense", "tender".' },
                                },
                            },
                            reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'The in-fiction reason for this request — required, and shown alongside the mechanical receipt as why the change happened.' },
                        },
                    },
                },
            },
        },
    };
}

function ownerRefSchema() {
    return { type: 'object', additionalProperties: false, required: ['kind', 'id', 'label'], properties: { kind: { type: 'string', enum: ['character', 'persona', 'group', 'faction', 'object', 'location', 'timeline', 'goal', 'custom'] }, id: { type: 'string' }, label: { type: 'string' } } };
}

export function validateMechanicsRequest(value) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('Envelope must be an object.');
    if (value?.protocol !== MECHANICS_PROTOCOL) errors.push(`Protocol must be ${MECHANICS_PROTOCOL}.`);
    if (!Array.isArray(value?.requests)) errors.push('requests must be an array.');
    const ids = new Set();
    for (const [index, request] of (value?.requests || []).entries()) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) { errors.push(`Request ${index + 1} is not an object.`); continue; }
        const id = String(request.id || '');
        if (!id || ids.has(id)) errors.push(`Request ${index + 1} has a missing or duplicate id.`);
        ids.add(id);
        if (!CAPABILITIES[request.capability]) errors.push(`Unknown capability: ${request.capability || '(missing)'}.`);
        if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) errors.push(`${id || index + 1}: arguments must be an object.`);
        if (!String(request.reason || '').trim()) errors.push(`${id || index + 1}: a reason is required.`);
    }
    return { valid: errors.length === 0, errors };
}

export function executeMechanicsRequest(envelope, context = {}) {
    const validation = validateMechanicsRequest(envelope);
    if (!validation.valid) return rejectedTransaction(envelope, context, validation.errors);
    const variableSnapshot = snapshotVariableStore();
    const goalSnapshot = snapshotStoryGoalsStore();
    const archivistSnapshot = snapshotArchivistStore();
    const transactionId = createId('mechanics-tx');
    const runtime = {
        transactionId,
        timelineId: String(context.timelineId || ''),
        sceneId: String(context.sceneId || ''),
        turnId: String(context.turnId || ''),
        aliases: new Map(),
        // Address tables: a key here is a name this pass advertised, and
        // nothing else. `.get()` answering anything else is a validation hole
        // (design section 3), so callers must not seed these with entries a
        // request could not legitimately have named.
        variableRefs: context.variableRefs instanceof Map ? context.variableRefs : new Map(Object.entries(context.variableRefs || {})),
        goalRefs: context.goalRefs instanceof Map ? context.goalRefs : new Map(Object.entries(context.goalRefs || {})),
        // What retrieval put in front of the model this pass, which is a
        // different question from what a request may address — goal.reach asks
        // the first, everything else asks the second. Defaults to the address
        // table's ids for callers that have no separate retrieval step, which
        // is what approvePendingMechanics wants: its one-entry table IS its
        // retrieved set.
        retrievedVariableIds: new Set((Array.isArray(context.retrievedVariableIds)
            ? context.retrievedVariableIds
            : [...(context.variableRefs instanceof Map ? context.variableRefs.values() : Object.values(context.variableRefs || {}))]
        ).map(String)),
        receipts: [],
        pending: [],
        reached: new Set(),
        authorizedGoalIds: new Set((context.authorizedGoalIds || []).map(String)),
        authorizedVariableRefs: new Set((context.authorizedVariableRefs || []).map(String)),
        allowUserGoalCreate: Boolean(context.allowUserGoalCreate),
        directionId: String(context.directionId || ''),
        messageId: context.messageId == null ? null : Number(context.messageId),
        checkpointId: String(context.checkpointId || ''),
    };
    if (!runtime.timelineId) return rejectedTransaction(envelope, context, ['A Timeline is required.']);

    try {
        const deferredReaches = [];
        for (const request of envelope.requests) {
            validateArguments(request, runtime);
            if (request.capability === 'goal.reach') deferredReaches.push(request);
            else applyRequest(request, runtime);
        }
        // All setup changes land before any reach is frozen or rolled.
        for (const request of deferredReaches) applyRequest(request, runtime);
        if (runtime.pending.length && runtime.receipts.some((receipt) => receipt.dependsOnPending)) {
            throw new MechanicsError('An applied operation depends on a proposal awaiting user review.');
        }
        if (runtime.pending.length) queuePendingOps(runtime.sceneId, runtime.pending.map((item) => item.request), { timelineId: runtime.timelineId, summary: 'Mechanical AI proposal awaiting authority.' });
        const status = runtime.pending.length && !runtime.receipts.some((item) => item.status === 'applied') ? 'pending' : 'applied';
        const transaction = recordMechanicsTransaction({
            id: transactionId, protocol: MECHANICS_PROTOCOL, timelineId: runtime.timelineId, sceneId: runtime.sceneId,
            turnId: runtime.turnId, directionId: runtime.directionId, messageId: runtime.messageId, checkpointId: runtime.checkpointId,
            status, requests: envelope.requests, receipts: [...runtime.receipts, ...runtime.pending.map((item) => item.receipt)],
            undo: { variables: variableSnapshot, goals: goalSnapshot, archivist: archivistSnapshot },
        });
        return { ok: true, transaction, receipts: transaction.receipts, pending: runtime.pending.length };
    } catch (error) {
        restoreVariableStore(variableSnapshot, { save: false });
        restoreStoryGoalsStore(goalSnapshot, { save: false });
        restoreArchivistStore(archivistSnapshot, { save: false });
        const message = error instanceof MechanicsError ? error.message : `Mechanical transaction failed: ${error.message}`;
        const transaction = recordMechanicsTransaction({ id: transactionId, protocol: MECHANICS_PROTOCOL, timelineId: runtime.timelineId, sceneId: runtime.sceneId, turnId: runtime.turnId, directionId: runtime.directionId, messageId: runtime.messageId, checkpointId: runtime.checkpointId, status: 'rolled-back', requests: envelope.requests, receipts: [{ status: 'rejected', rejectionReason: message }] });
        return { ok: false, transaction, receipts: transaction.receipts, errors: [message] };
    }
}

export function approvePendingMechanics(sceneId, pendingId, timelineId) {
    const entry = getPendingOps(sceneId).find((item) => item.id === String(pendingId || ''));
    if (!entry) return { ok: false, errors: ['Pending proposal not found.'] };
    const request = entry.op;
    const args = request.arguments || {};
    const variableRef = String(args.variableRef || args.modifierVariableRef || '');
    const variableRefs = args._resolvedVariableId && variableRef ? new Map([[variableRef, args._resolvedVariableId]]) : new Map();
    if ('_resolvedVariableId' in args) delete args._resolvedVariableId;
    // The refs a deferred request carries were advertised by a pass that is long
    // over, so approval rebuilds a one-entry table from the ids resolved when the
    // request was first validated. Without it every approval would be rejected
    // as "not advertised for this request".
    const goalRefs = new Map(Object.entries(args._resolvedGoalIds || {}));
    if ('_resolvedGoalIds' in args) delete args._resolvedGoalIds;
    const result = executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: [request] }, {
        timelineId, sceneId,
        authorizedGoalIds: [...goalRefs.values()],
        authorizedVariableRefs: [variableRef].filter(Boolean),
        variableRefs, goalRefs,
        allowUserGoalCreate: request.capability === 'goal.create',
    });
    if (result.ok) takePendingOp(sceneId, entry.id);
    return result;
}

export function rejectPendingMechanics(sceneId, pendingId) {
    return Boolean(takePendingOp(sceneId, pendingId));
}

export function undoMechanicsTransaction(transaction) {
    if (!transaction?.undo?.variables || !transaction?.undo?.goals) return false;
    const beforeUndo = { transactionId: transaction.id, restoredAt: new Date().toISOString() };
    restoreVariableStore(transaction.undo.variables, { save: false });
    restoreStoryGoalsStore(transaction.undo.goals, { save: false });
    if (transaction.undo.archivist) restoreArchivistStore(transaction.undo.archivist, { save: false });
    recordMechanicsTransaction({ protocol: MECHANICS_PROTOCOL, timelineId: transaction.timelineId, sceneId: transaction.sceneId, status: 'applied', requests: [], receipts: [{ status: 'applied', capability: 'transaction.undo', before: beforeUndo, after: { restored: true }, reason: 'User reversed an automatic mechanical transaction.' }] });
    return true;
}

function applyRequest(request, runtime) {
    const args = request.arguments;
    switch (request.capability) {
        case 'variable.create': return createVariable(request, args, runtime);
        case 'variable.set': return setVariable(request, args, runtime);
        case 'variable.subvalue.set': return setVariable(request, args, runtime, true);
        case 'variable.adjust': return adjustVariable(request, args, runtime);
        case 'variable.transition': return transitionVariable(request, args, runtime);
        case 'modifier.add': return addModifier(request, args, runtime);
        case 'modifier.remove': return removeModifier(request, args, runtime);
        case 'goal.create': return createGoal(request, args, runtime);
        case 'goal.edit': return editGoal(request, args, runtime);
        case 'goal.delete': return deleteGoal(request, args, runtime);
        case 'goal.relate': return relateGoals(request, args, runtime);
        case 'goal.reach': return reachGoal(request, args, runtime);
        case 'scene.set': return applySceneSet(request, args, runtime);
        case 'scene.clear': return applySceneClear(request, args, runtime);
        case 'event.record': return applyEventRecord(request, args, runtime);
        case 'char_state.set': return applyCharStateSet(request, args, runtime);
        case 'char_state.clear': return applyCharStateClear(request, args, runtime);
        case 'beat.set': return applyBeatSet(request, args, runtime);
        case 'secret.set': return applySecretSet(request, args, runtime);
        case 'secret.clear': return applySecretClear(request, args, runtime);
        default: throw new MechanicsError(`Unsupported capability ${request.capability}.`);
    }
}

function applySceneSet(request, args, runtime) {
    const { before, after } = setSceneFact(runtime.timelineId, runtime.sceneId, args.key, args.value, { establishedMsgId: runtime.messageId });
    return receipt(runtime, request, before, after);
}
function applySceneClear(request, args, runtime) {
    return receipt(runtime, request, clearSceneFact(runtime.timelineId, runtime.sceneId, args.key), null);
}
function applyEventRecord(request, args, runtime) {
    return receipt(runtime, request, null, recordEvent(runtime.timelineId, runtime.sceneId, args.summary, { msgId: runtime.messageId, turnIndex: null }));
}
function applyCharStateSet(request, args, runtime) {
    const { before, after } = setCharStateFacet(runtime.timelineId, runtime.sceneId, args.charId, args.facet, args.value);
    return receipt(runtime, request, before, after);
}
function applyCharStateClear(request, args, runtime) {
    return receipt(runtime, request, clearCharStateFacet(runtime.timelineId, runtime.sceneId, args.charId, args.facet), null);
}
function applyBeatSet(request, args, runtime) {
    const { before, after } = setBeat(runtime.timelineId, runtime.sceneId, args.directive, args.tone || '');
    return receipt(runtime, request, before, after);
}
function applySecretSet(request, args, runtime) {
    const { before, after } = setSecret(runtime.timelineId, runtime.sceneId, args.key, args.value);
    return receipt(runtime, request, before, after);
}
function applySecretClear(request, args, runtime) {
    return receipt(runtime, request, clearSecret(runtime.timelineId, runtime.sceneId, args.key), null);
}

/**
 * Let the Director author a Variable the owner never wrote.
 *
 * WHY: with nothing authored, the mechanics layer has nothing to advertise and
 * can never do anything — every pass journalled `retrieval.skipped :: "This
 * Timeline has no Variables."` and there was no verb that could change that.
 *
 * Three decisions make this safe rather than a mess.
 *
 * **Uniqueness.** Every address in this system is a name (design §3), and
 * `buildAddressBook` refuses a name held by two records rather than guessing —
 * so creating a second "Morale" does not create an ambiguity, it silently makes
 * BOTH Variables unaddressable forever. Refused here on the address book's own
 * comparison: trimmed and case-insensitive, so "Morale" and "morale " collide.
 *
 * **Retrieval mode `always`.** A Variable surfaces through its lore links plus
 * semantic evidence, and a Variable the Director invented has no lorebook entry
 * to hang off — it is not describing prose the owner wrote. Under the default
 * `corroborated` mode it could never be corroborated, so it would be created
 * and then never retrieved again: write-only. `always` is the one mode in
 * RETRIEVAL_MODES that surfaces without linked evidence, and the store agrees —
 * `createVariableValue` rejects an unlinked Variable in any other mode outright.
 *
 * **Authority `review`.** The store defaults an authority-less Variable to
 * `world` on the stated grounds that it "is attached to a lorebook entry about
 * the fiction, not to the user" — grounds that do not hold here, because this
 * one is attached to nothing. Nothing in the request types the subject either:
 * the model supplies a bare name, so the capability layer cannot tell "Keep's
 * Repair" from "Aiden's Corruption" where Aiden is the user's own persona.
 * `review` is the only value that is conservative for every subject, and it is
 * one dropdown away from `world` in the Codex once the owner accepts the
 * invention. Creation itself still applies — it is additive, and the
 * transaction snapshot undoes it — but every later write to the invented fact
 * defers.
 */
function createVariable(request, args, runtime) {
    const name = String(args.name ?? '').trim();
    const valueType = String(args.valueType ?? '').trim();
    if (!VARIABLE_KINDS.includes(valueType)) throw new MechanicsError(`${request.id}: valueType must be one of ${VARIABLE_KINDS.join(', ')}.`);
    // Read live rather than from a snapshot: an earlier request in this same
    // batch may already have created the name being asked for.
    const clash = listVariableValues({ timelineId: runtime.timelineId }).find((item) => sameVariableName(item.name, name));
    if (clash) throw new MechanicsError(`${request.id}: this Timeline already has a Variable named “${clash.name}”. Address that one by name instead of creating a second — a duplicated name makes both unaddressable.`);
    const states = createStates(request, args, valueType);
    const subvalues = createBounds(request, args, valueType);
    const value = openingValue(request, args, valueType, states, subvalues);
    const created = createVariableValue({
        timelineId: runtime.timelineId, name, description: String(args.description ?? '').trim(),
        valueType, value, enumValues: states, subvalues, loreLinks: [],
        retrieval: { mode: 'always', semanticThreshold: 0.7, continuity: true },
        authority: 'review',
    }, txContext(runtime, request));
    if (!created) throw new MechanicsError(`${request.id}: Variable could not be created.`);
    receipt(runtime, request, null, created);
}

/** The address book's own comparison — direction-address.js `normalize`. */
function sameVariableName(left, right) {
    return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function createStates(request, args, valueType) {
    const states = [...new Set((Array.isArray(args.enumValues) ? args.enumValues : [])
        .map((item) => String(item ?? '').trim()).filter(Boolean))];
    if (valueType !== 'enum') {
        if (states.length) throw new MechanicsError(`${request.id}: enumValues only applies to an enum Variable.`);
        return [];
    }
    // One state is not a state machine: variable.transition would have nowhere
    // to move it, so the Variable could never do the one thing enum is for.
    if (states.length < 2) throw new MechanicsError(`${request.id}: an enum Variable needs at least two distinct states in enumValues.`);
    return states;
}

/**
 * Bounds in the exact shape the Codex editor writes (variables-ui.js
 * `saveFromForm`), so a Director-created Variable and an owner-created one are
 * one record type rather than two that merely look alike.
 */
function createBounds(request, args, valueType) {
    const minimum = optionalBound(request, args.minimum, 'minimum');
    const maximum = optionalBound(request, args.maximum, 'maximum');
    if ((minimum !== null || maximum !== null) && valueType !== 'number') {
        throw new MechanicsError(`${request.id}: only a number Variable takes a minimum or a maximum.`);
    }
    if (minimum !== null && maximum !== null && minimum > maximum) {
        throw new MechanicsError(`${request.id}: minimum ${minimum} is above maximum ${maximum}.`);
    }
    const subvalues = [];
    if (minimum !== null) subvalues.push({ key: 'minimum', label: 'Minimum', type: 'number', value: minimum, role: 'minimum' });
    if (maximum !== null) subvalues.push({ key: 'maximum', label: 'Maximum', type: 'number', value: maximum, role: 'maximum' });
    return subvalues;
}

/**
 * An absent bound is null/undefined/'' — NOT merely something that coerces
 * badly. `Number(null)` is 0 and passes Number.isFinite, so testing presence by
 * coercion reads "no floor" as "floor of 0"; `hasBound` in variables-store.js
 * exists for the same reason.
 */
function optionalBound(request, value, label) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new MechanicsError(`${request.id}: ${label} must be a finite number when it is given.`);
    return number;
}

/**
 * The starting value, validated rather than coerced.
 *
 * `normalizeScalar` in the store is deliberately lenient so a malformed *stored*
 * record still loads — an unknown enum state becomes `enumValues[0]`, an
 * out-of-range number is clamped. Neither is acceptable for a create request:
 * both would report success while quietly storing something else.
 */
function openingValue(request, args, valueType, states, subvalues) {
    if (valueType === 'enum') {
        const state = String(args.value ?? '').trim();
        if (!states.includes(state)) throw new MechanicsError(`${request.id}: value must be one of the states listed in enumValues.`);
        return state;
    }
    if (valueType !== 'number') return args.value;
    const number = Number(args.value);
    if (!Number.isFinite(number)) throw new MechanicsError(`${request.id}: value must be a finite number.`);
    const minimum = subvalues.find((item) => item.role === 'minimum')?.value ?? null;
    const maximum = subvalues.find((item) => item.role === 'maximum')?.value ?? null;
    if (minimum !== null && number < minimum || maximum !== null && number > maximum) {
        throw new MechanicsError(`${request.id}: value ${number} falls outside the bounds ${minimum ?? '−∞'} to ${maximum ?? '∞'}.`);
    }
    return number;
}

function setVariable(request, args, runtime, subvalue = false) {
    const variable = requireVariable(resolveVariableReference(args.variableRef, runtime), runtime);
    if (!isAuthorizedVariable(variable, args.variableRef, runtime)) return deferVariable(request, runtime, variable, `Changing ${variable.name} requires review.`);
    const field = subvalue ? String(args.field || '') : 'value';
    if (subvalue && !variable.subvalues.some((item) => item.key === field)) throw new MechanicsError(`${request.id}: subvalue ${field || '(missing)'} was not advertised.`);
    const before = copy(variable);
    const after = setVariableField(variable.id, field, args.value, txContext(runtime, request));
    if (!after) throw new MechanicsError(`${request.id}: value is invalid for ${variable.name}.`);
    receipt(runtime, request, before, after);
}

function adjustVariable(request, args, runtime) {
    const instance = requireVariable(resolveVariableReference(args.variableRef, runtime), runtime);
    if (!isAuthorizedVariable(instance, args.variableRef, runtime)) return deferVariable(request, runtime, instance, `Adjusting ${instance.name} requires review.`);
    const before = copy(instance);
    const after = adjustVariableValue(instance.id, requiredNumber(args.delta, 'delta'), { ...txContext(runtime, request), field: args.field || 'value' });
    if (!after) throw new MechanicsError(`${request.id}: Variable cannot be numerically adjusted.`);
    receipt(runtime, request, before, after);
}

function transitionVariable(request, args, runtime) {
    const instance = requireVariable(resolveVariableReference(args.variableRef, runtime), runtime);
    if (!isAuthorizedVariable(instance, args.variableRef, runtime)) return deferVariable(request, runtime, instance, `Transitioning ${instance.name} requires review.`);
    const before = copy(instance);
    const after = transitionVariableValue(instance.id, args.nextState, { ...txContext(runtime, request), field: args.field || 'value' });
    if (!after) throw new MechanicsError(`${request.id}: transition is not permitted by the definition.`);
    receipt(runtime, request, before, after);
}

function addModifier(request, args, runtime) {
    const instance = requireVariable(resolveVariableReference(args.variableRef, runtime), runtime);
    if (!isAuthorizedVariable(instance, args.variableRef, runtime)) return deferVariable(request, runtime, instance, `Modifying ${instance.name} requires review.`);
    const before = copy(instance);
    if (args.target && !['value', 'maximum'].includes(args.target)) {
        throw new MechanicsError(`${request.id}: modifier target must be value or maximum.`);
    }
    const modifier = addVariableModifier(instance.id, { label: args.label, amount: requiredNumber(args.delta, 'delta'), target: args.target, endingCondition: args.endingCondition, reason: request.reason, source: 'mechanics' }, txContext(runtime, request));
    if (!modifier) throw new MechanicsError(`${request.id}: modifier was invalid.`);
    receipt(runtime, request, before, getVariableValue(instance.id), { modifier });
}

function removeModifier(request, args, runtime) {
    const instance = requireVariable(resolveVariableReference(args.variableRef, runtime), runtime);
    if (!isAuthorizedVariable(instance, args.variableRef, runtime)) return deferVariable(request, runtime, instance, `Changing ${instance.name}'s modifiers requires review.`);
    const before = copy(instance);
    if (!removeVariableModifier(instance.id, String(args.modifierId || ''), txContext(runtime, request))) throw new MechanicsError(`${request.id}: modifier not found.`);
    receipt(runtime, request, before, getVariableValue(instance.id));
}

function createGoal(request, args, runtime) {
    const holderRefs = requireOwners(args.holderRefs);
    const targetRefs = requireOwners(args.targetRefs || [], true);
    if (holderRefs.some((owner) => !isAuthorizedOwner(owner, runtime)) && !runtime.allowUserGoalCreate) return defer(request, runtime, 'A user-owned Goal proposal requires review.');
    // The Director states a number, informed by the rate guidance in its
    // prompt. `?? 30` is the record's own default for a Goal created without a
    // stated rate — clampRate returns null rather than reading an absent value
    // as zero, which would have made such a Goal nearly impossible.
    const rate = clampRate(args.successRate) ?? 30;
    const goal = createTimelineGoal(runtime.timelineId, { title: args.title, description: args.description, holderRefs, targetRefs, successRate: rate, visibility: args.visibility }, { sceneId: runtime.sceneId, actor: 'mechanics', reason: request.reason });
    if (!goal) throw new MechanicsError(`${request.id}: Goal could not be created.`);
    setAlias(runtime, args.alias, goal.id, 'goal');
    receipt(runtime, request, null, goal);
}

function editGoal(request, args, runtime) {
    const goal = requireGoal(resolveReference(args.goalRef ?? args.goalId, runtime, 'goal'), runtime, { mustBeActive: false });
    if (!isAuthorizedGoal(goal, runtime)) return deferGoal(request, runtime, { [String(args.goalRef ?? args.goalId)]: goal.id }, `Changing the user-owned Goal \u201c${goal.title}\u201d requires review.`);
    const patch = {};
    if (args.successRate !== undefined) {
        // A number the Director chose. The four magnitudes used to be welded to
        // 3/7/12/20 here and the schema told the model "never state a percentage
        // yourself", so it could not say how far a Goal had actually moved. The
        // reference points now live in its prompt; the clamp stays code's.
        const rate = clampRate(args.successRate);
        if (rate === null) throw new MechanicsError(`${request.id}: successRate must be a number.`);
        patch.successRate = rate;
    }
    if (args.status !== undefined) {
        if (!STORY_GOAL_STATUSES.includes(args.status)) throw new MechanicsError(`${request.id}: unknown Goal status.`);
        patch.status = args.status;
    }
    if (args.visibility !== undefined) {
        if (!STORY_GOAL_VISIBILITIES.includes(args.visibility)) throw new MechanicsError(`${request.id}: unknown Goal visibility.`);
        patch.visibility = args.visibility;
    }
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.description !== undefined) patch.description = String(args.description);
    // An edit that changes nothing still costs a receipt and reads as a change
    // in the ledger, so say so rather than recording a no-op.
    if (!Object.keys(patch).length) throw new MechanicsError(`${request.id}: an edit must change at least one field.`);
    const before = copy(goal);
    const after = updateStoryGoal(goal.id, patch, { ...txContext(runtime, request), type: 'goal.edited' });
    receipt(runtime, request, before, after, { patch });
}

function deleteGoal(request, args, runtime) {
    const goal = requireGoal(resolveReference(args.goalRef ?? args.goalId, runtime, 'goal'), runtime, { mustBeActive: false });
    if (!isAuthorizedGoal(goal, runtime)) return deferGoal(request, runtime, { [String(args.goalRef ?? args.goalId)]: goal.id }, `Deleting the user-owned Goal \u201c${goal.title}\u201d requires review.`);
    const before = copy(goal);
    deleteStoryGoal(goal.id, { ...txContext(runtime, request), type: 'goal.deleted' });
    receipt(runtime, request, before, null);
}

function relateGoals(request, args, runtime) {
    const from = requireGoal(resolveReference(args.fromGoalRef ?? args.fromGoalId, runtime, 'goal'), runtime);
    const to = requireGoal(resolveReference(args.toGoalRef ?? args.toGoalId, runtime, 'goal'), runtime);
    if (!isAuthorizedGoal(from, runtime)) return deferGoal(request, runtime, { [String(args.fromGoalRef ?? args.fromGoalId)]: from.id, [String(args.toGoalRef ?? args.toGoalId)]: to.id }, `Changing a relationship from the user-owned Goal “${from.title}” requires review.`);
    const relation = createTimelineGoalRelation(runtime.timelineId, from.id, to.id, args.type, request.reason, txContext(runtime, request));
    if (!relation) throw new MechanicsError(`${request.id}: invalid Goal relationship.`);
    receipt(runtime, request, null, relation);
}

function reachGoal(request, args, runtime) {
    const goal = requireGoal(resolveReference(args.goalRef ?? args.goalId, runtime, 'goal'), runtime);
    if (runtime.reached.has(goal.id)) throw new MechanicsError(`${request.id}: a Goal may be reached only once per transaction.`);
    if (!isAuthorizedGoal(goal, runtime)) return deferGoal(request, runtime, { [String(args.goalRef ?? args.goalId)]: goal.id }, `A reach for the user-owned Goal “${goal.title}” must be explicitly declared.`);
    runtime.reached.add(goal.id);
    const before = copy(goal);
    let modifierInstance = null;
    let modifier = 0;
    if (args.modifierVariableRef) {
        modifierInstance = requireVariable(resolveVariableReference(args.modifierVariableRef, runtime), runtime);
        modifier = Number(computeVariable(modifierInstance)?.value || 0);
    }
    // Frozen before the die so the receipt shows exactly what was rolled
    // against what, and cannot be re-derived differently afterwards.
    const frozen = { successRate: goal.successRate, modifierVariableId: modifierInstance?.id || '', modifier };
    const result = resolveReach({ rate: frozen.successRate, modifier });
    // A hit achieves the Goal; a miss changes nothing. How badly a miss went is
    // the Director's to judge in the fiction and to request as its own change
    // with its own reason — code used to dock 2/5/10/18 points by depth band.
    const goalAfter = result.hit
        ? updateStoryGoal(goal.id, { status: 'achieved' }, { ...txContext(runtime, request), type: 'goal.reach.hit' })
        : goal;
    receipt(runtime, request, before, goalAfter, { frozen, roll: result });
}

/**
 * The arguments each capability cannot run without, and a one-line shape for
 * each so the Director can supply them.
 *
 * ONE TABLE, read by BOTH the validator and the prompt. They used to be
 * separate, and the result was the defect the owner spent three sessions
 * hitting: `validateArguments` demanded `valueType`, `holderRefs` and
 * `enumValues`, and NONE of those words appeared anywhere in the Director's
 * prompt. The full per-argument schema exists further up this file, but it was
 * only ever consumed by the structured-output path that was deleted with the
 * envelope — the Director now writes a free-form state fence and is handed
 * only `describeCapabilities`, which printed a name and a sentence.
 *
 * So the Director guessed its arguments from the single example in the
 * protocol block, and every write it attempted was refused:
 * `valueType is required`, `holderRefs is required`, four turns running.
 *
 * Keeping the requirement and its explanation in one place is the point. A
 * required argument the model is never told about is indistinguishable, from
 * the outside, from a capability that does not work.
 */
export const REQUIRED_ARGUMENTS = Object.freeze({
    'goal.create': Object.freeze([
        ['title', 'what is being attempted, as a short line'],
        ['holderRefs', 'who holds it: [{"kind":"character","id":"<cast name>","label":"<cast name>"}] — at least one'],
    ]),
    'goal.edit': Object.freeze([["goalRef", "the Goal's exact advertised name"]]),
    'goal.delete': Object.freeze([["goalRef", "the Goal's exact advertised name"]]),
    'goal.reach': Object.freeze([["goalRef", "the Goal's exact advertised name"]]),
    'goal.relate': Object.freeze([
        ['fromGoalRef', 'the Goal the relationship starts from'],
        ['toGoalRef', 'the Goal it points at'],
        ['type', '"antagonistic" or "sympathetic"'],
    ]),
    'variable.create': Object.freeze([
        ['name', 'the name you will address it by from next turn on'],
        ['valueType', 'one of "number", "enum", "text", "boolean"'],
        ['value', 'its starting value'],
        ['description', 'what it means in the fiction, one line, written for your future self'],
    ]),
    'variable.set': Object.freeze([['variableRef', 'its exact advertised name'], ['value', 'the new value']]),
    'variable.subvalue.set': Object.freeze([['variableRef', 'its exact advertised name'], ['field', 'which subvalue'], ['value', 'the new value']]),
    'variable.adjust': Object.freeze([['variableRef', 'its exact advertised name'], ['delta', 'how much it moves, positive or negative']]),
    'variable.transition': Object.freeze([['variableRef', 'its exact advertised name'], ['nextState', 'one of its declared states']]),
    'modifier.add': Object.freeze([
        ['variableRef', 'its exact advertised name'], ['label', 'what the modifier is'],
        ['delta', 'how much it shifts'], ['target', 'which field it applies to'],
    ]),
    'modifier.remove': Object.freeze([['variableRef', 'its exact advertised name'], ["modifierId", "the modifier's id on the record"]]),
    'scene.set': Object.freeze([['key', 'the fact name, e.g. "location"'], ['value', 'the fact itself, e.g. "rain-soaked rooftop"']]),
    'scene.clear': Object.freeze([['key', 'the fact name to remove']]),
    'event.record': Object.freeze([['summary', 'what just happened, one line']]),
    'char_state.set': Object.freeze([['charId', 'the character, by cast name'], ['facet', 'which facet, e.g. "mood"'], ['value', 'the new value, e.g. "desperate"']]),
    'char_state.clear': Object.freeze([['charId', 'the character, by cast name'], ['facet', 'which facet to remove']]),
    'beat.set': Object.freeze([['directive', 'what should happen next, one or two lines']]),
    'secret.set': Object.freeze([['key', 'the secret name'], ['value', 'the secret itself']]),
    'secret.clear': Object.freeze([['key', 'the secret name to remove']]),
});

function validateArguments(request) {
    const args = request.arguments;
    // `goalRef` also accepts the older `goalId` spelling, so a request deferred
    // for review under the previous schema still validates when it is approved.
    const legacy = { goalRef: 'goalId', fromGoalRef: 'fromGoalId', toGoalRef: 'toGoalId' };
    const missing = (key) => (args[key] == null || args[key] === '') && (!legacy[key] || args[legacy[key]] == null || args[legacy[key]] === '');
    const require = (...keys) => { for (const key of keys) if (missing(key)) throw new MechanicsError(`${request.id}: ${key} is required.`); };
    // Read from the same table the prompt is built from, so a requirement can
    // never again exist here without the Director being told about it.
    require(...(REQUIRED_ARGUMENTS[request.capability] || []).map(([key]) => key));
}

function isAuthorizedVariable(variable, ref, runtime) {
    if (variable.authority === 'world') return true;
    return runtime.authorizedVariableRefs.has(String(ref || ''));
}

function isAuthorizedGoal(goal, runtime) {
    if (!goal.holderRefs?.some((ref) => ref.kind === 'persona')) return true;
    return runtime.authorizedGoalIds.has(goal.id);
}

function defer(request, runtime, reason) {
    const entry = { request: copy(request), receipt: { requestId: request.id, capability: request.capability, status: 'pending', approvalStatus: 'required', rejectionReason: reason, validatedInputs: copy(request.arguments) } };
    runtime.pending.push(entry);
    return entry.receipt;
}

function deferVariable(request, runtime, variable, reason) {
    const copyRequest = copy(request);
    copyRequest.arguments._resolvedVariableId = variable.id;
    return defer(copyRequest, runtime, reason);
}

/**
 * Defer a Goal request, remembering which persistent Goal each ref meant.
 *
 * Refs are only valid for the pass that advertised them, and approval happens
 * later — so the resolution is frozen here rather than re-derived from a ref
 * table that no longer exists.
 */
function deferGoal(request, runtime, resolved, reason) {
    const copyRequest = copy(request);
    copyRequest.arguments._resolvedGoalIds = Object.fromEntries(
        Object.entries(resolved).filter(([ref, id]) => ref && id),
    );
    return defer(copyRequest, runtime, reason);
}

function receipt(runtime, request, before, after, extra = {}) {
    const value = { requestId: request.id, capability: request.capability, status: 'applied', approvalStatus: 'authorized', validatedInputs: copy(request.arguments), before: copy(before), after: copy(after), reason: request.reason, ...copy(extra) };
    runtime.receipts.push(value);
    return value;
}

function setAlias(runtime, alias, id, type) {
    if (!alias) return;
    const key = String(alias);
    if (runtime.aliases.has(key)) throw new MechanicsError(`Duplicate transaction alias ${key}.`);
    runtime.aliases.set(key, { id, type });
}

function resolveReference(value, runtime, type) {
    const raw = String(value || '');
    const alias = raw.startsWith('$') ? runtime.aliases.get(raw.slice(1)) : runtime.aliases.get(raw);
    if (alias) {
        if (alias.type !== type) throw new MechanicsError(`${raw} does not refer to a ${type}.`);
        return alias.id;
    }
    // Goals are addressed by the temporary refs advertised in this request, the
    // same rule Variables follow. Falling through to the raw string would let a
    // model reach a Goal that was never offered — including one from another
    // Scene — by guessing or replaying an id it saw earlier.
    if (type === 'goal') {
        const id = runtime.goalRefs.get(raw);
        if (!id) throw new MechanicsError(`Goal reference ${raw || '(missing)'} was not advertised for this request.`);
        return id;
    }
    return raw;
}

function resolveVariableReference(value, runtime) {
    const ref = String(value || '');
    const id = runtime.variableRefs.get(ref);
    if (!id) throw new MechanicsError(`Variable reference ${ref || '(missing)'} was not advertised for this request.`);
    const variable = getVariableValue(id, runtime.timelineId);
    if (!variable) throw new MechanicsError(`Variable reference ${ref} is no longer available.`);
    return variable.id;
}

function requireVariable(id, runtime = null) {
    const instance = getVariableValue(id, runtime?.timelineId || '');
    if (!instance || (runtime && instance.timelineId !== runtime.timelineId)) throw new MechanicsError(`Variable instance ${id || '(missing)'} is unavailable.`);
    return instance;
}

/**
 * Fetch an advertised Goal, by default only a live one.
 *
 * `mustBeActive` is false for edit and delete: a Goal that ended is still a
 * record the Director may correct, retitle, or reopen — `goal.edit` offers
 * `active` precisely so an ended Goal can come back. Only a reach needs the
 * Goal to be live, because reaching a settled Goal is meaningless.
 */
function requireGoal(id, runtime, { mustBeActive = true } = {}) {
    const goal = getStoryGoal(id);
    if (!goal || goal.timelineId !== runtime.timelineId) throw new MechanicsError(`Goal ${id || '(missing)'} is unavailable.`);
    if (mustBeActive && goal.status !== 'active') throw new MechanicsError(`Goal ${id || '(missing)'} is not active.`);
    return goal;
}

function requiredOwner(value) {
    const owner = normalizeOwnerRef(value);
    if (!owner) throw new MechanicsError('A typed ownerRef with stable id and label is required.');
    return owner;
}

function requireOwners(value, allowEmpty = false) {
    const owners = (Array.isArray(value) ? value : []).map(requiredOwner);
    if (!allowEmpty && !owners.length) throw new MechanicsError('At least one typed owner is required.');
    return owners;
}

function requiredNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new MechanicsError(`${label} must be a finite number.`);
    return number;
}

function txContext(runtime, request) {
    return { timelineId: runtime.timelineId, sceneId: runtime.sceneId, turnId: runtime.turnId, directionId: runtime.directionId, messageId: runtime.messageId, checkpointId: runtime.checkpointId, transactionId: runtime.transactionId, actor: 'mechanics', reason: request.reason };
}

function rejectedTransaction(envelope, context, errors) {
    const transaction = recordMechanicsTransaction({ protocol: MECHANICS_PROTOCOL, timelineId: context.timelineId, sceneId: context.sceneId, turnId: context.turnId, directionId: context.directionId, messageId: context.messageId, checkpointId: context.checkpointId, status: 'rejected', requests: envelope?.requests || [], receipts: errors.map((reason) => ({ status: 'rejected', rejectionReason: reason })) });
    return { ok: false, transaction, receipts: transaction.receipts, errors };
}

function capability(description, applicableKinds, authorityPolicy) {
    return { description, inputSchema: { type: 'object' }, applicableKinds, authorityPolicy };
}

class MechanicsError extends Error {}
function copy(value) { return value == null ? value : structuredClone(value); }
function createId(prefix) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
