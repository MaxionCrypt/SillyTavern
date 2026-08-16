import {
    addVariableModifier,
    adjustVariableValue,
    computeVariable,
    getVariableValue,
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
    takePendingOp,
} from './story-goals-store.js';
import { clampRate, openingRateForBand, resolveReach, shiftForMagnitude } from './story-goals-math.js';

export const MECHANICS_PROTOCOL = 'remodel-mechanics/1';

const CAPABILITY_NAMES = Object.freeze([
    'goal.create', 'goal.shift', 'goal.reach', 'goal.relate', 'goal.close',
    'variable.set', 'variable.adjust', 'variable.transition', 'variable.subvalue.set',
    'modifier.add', 'modifier.remove',
]);

const CAPABILITIES = Object.freeze({
    'goal.create': capability('Create a meaningful unresolved Story Goal using typed holders and targets.', ['timeline'], 'hybrid'),
    'goal.shift': capability('Move a Goal Success Rate by one named movement band. A separate fictional reason is required.', ['goal'], 'hybrid'),
    'goal.reach': capability('Declare one decisive attempt against a Goal. Code freezes inputs and rolls d100.', ['goal'], 'hybrid'),
    'goal.relate': capability('Create or update a directional sympathetic or antagonistic Goal relationship.', ['goal'], 'hybrid'),
    'goal.close': capability('Mark a Goal achieved, abandoned, or impossible.', ['goal'], 'hybrid'),
    'variable.set': capability('Set the primary scalar value of an advertised Variable.', ['number', 'enum', 'text', 'boolean'], 'hybrid'),
    'variable.adjust': capability('Adjust an advertised numeric Variable or numeric subvalue.', ['number'], 'hybrid'),
    'variable.transition': capability('Move an advertised enum Variable or enum subvalue to an allowed state.', ['enum'], 'hybrid'),
    'variable.subvalue.set': capability('Set one advertised scalar subvalue.', ['number', 'enum', 'text', 'boolean'], 'hybrid'),
    'modifier.add': capability('Attach a bounded value or maximum modifier to an advertised Variable.', ['variable'], 'hybrid'),
    'modifier.remove': capability('Remove one existing Variable modifier by ID.', ['variable'], 'hybrid'),
});

export function getCapabilityDictionary() {
    return CAPABILITY_NAMES.map((name) => ({ name, ...CAPABILITIES[name] }));
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
                                    title: { type: 'string', description: 'goal.create only: the new Goal\'s title.' },
                                    description: { type: 'string', description: 'goal.create only: what this Goal is, for the Goal record itself.' },
                                    visibility: { type: 'string', enum: ['public', 'secret'], description: 'goal.create only: whether the user can see this Goal exists. Use secret for a twist or a threat the user has not discovered.' },
                                    holderRefs: { type: 'array', items: ownerRefSchema(), description: 'goal.create only: who holds this Goal — at least one typed owner is required.' },
                                    targetRefs: { type: 'array', items: ownerRefSchema(), description: 'goal.create only: who or what the Goal is directed at, if it has a target. Optional.' },
                                    openingBand: { type: 'string', enum: ['nearly_impossible', 'extreme', 'difficult', 'uncertain', 'favorable', 'strongly_favored', 'nearly_assured'], description: 'goal.create only: the new Goal\'s starting difficulty, named rather than numeric. Use this or successRate, not both.' },
                                    successRate: { type: 'number', description: 'goal.create only: the new Goal\'s exact starting Success Rate (0-100). Use this or openingBand, not both.' },
                                    resolution: {
                                        type: 'object', additionalProperties: false,
                                        description: 'goal.create only: how this Goal resolves when reached. Omit, or set kind to instant, for a Goal that just succeeds or fails outright. Set kind to tracked to bind it to a Variable that must cross a threshold.',
                                        properties: {
                                            kind: { type: 'string', enum: ['instant', 'tracked'], description: 'instant: goal.reach settles this Goal outright. tracked: goal.reach instead moves the named Variable, and the Goal completes only once it crosses completionThreshold.' },
                                            variableRef: { type: 'string', description: 'tracked only: the exact advertised name of the Variable this Goal tracks.' },
                                            field: { type: 'string', description: 'tracked only: which subvalue of that Variable is tracked. Omit for the Variable\'s primary value.' },
                                            direction: { type: 'string', enum: ['increase', 'decrease'], description: 'tracked only: whether completion means the tracked field rising to, or falling to, completionThreshold.' },
                                            completionThreshold: { type: 'number', description: 'tracked only: the value the tracked field must reach to complete this Goal.' },
                                        },
                                    },
                                    direction: { type: 'string', enum: ['up', 'down'], description: 'goal.shift only: which way to move the Goal\'s Success Rate.' },
                                    magnitude: { type: 'string', enum: ['minor', 'meaningful', 'major', 'decisive'], description: 'goal.shift only: how large a Success Rate move this is. Code converts it to a number; never state a percentage yourself.' },
                                    impactMagnitude: { type: 'string', enum: ['minor', 'meaningful', 'major', 'decisive'], description: 'goal.reach only, for a tracked Goal: how large the tracked Variable moves when this reach hits.' },
                                    type: { type: 'string', enum: ['antagonistic', 'sympathetic'], description: 'goal.relate only: whether progress on fromGoalRef helps (sympathetic) or hurts (antagonistic) toGoalRef.' },
                                    status: { type: 'string', enum: ['achieved', 'abandoned', 'impossible'], description: 'goal.close only: the terminal state to close the Goal at.' },
                                    variableRef: { type: 'string', description: 'The exact advertised name of the Variable this request addresses. Required by every variable.* and modifier.* capability except where modifierVariableRef applies instead.' },
                                    modifierVariableRef: { type: 'string', description: 'modifier.add / modifier.remove only: the exact advertised name of the Variable the modifier is attached to or removed from.' },
                                    modifierId: { type: 'string', description: 'modifier.remove only: the id of the existing modifier to remove, as it appears on the Variable\'s record.' },
                                    field: { type: 'string', description: 'variable.subvalue.set: which advertised subvalue to set. variable.adjust / variable.transition: which field to change; omit for the Variable\'s primary value.' },
                                    value: { type: ['number', 'string', 'boolean'], description: 'variable.set / variable.subvalue.set only: the exact value to write, matching the field\'s type.' },
                                    delta: { type: 'number', description: 'variable.adjust only: the numeric amount to add (negative to subtract). modifier.add only: the modifier\'s amount.' },
                                    nextState: { type: ['string', 'boolean'], description: 'variable.transition only: the state to move the enum (or boolean) Variable to. Must be a state the Variable\'s definition allows.' },
                                    label: { type: 'string', description: 'modifier.add only: a short label identifying this modifier, e.g. "Wounded" or "Blessed".' },
                                    target: { type: 'string', enum: ['value', 'maximum'], description: 'modifier.add only: whether the modifier bounds the Variable\'s value or its maximum.' },
                                    endingCondition: { type: 'string', description: 'modifier.add only: in prose, when this modifier should end. Code does not expire it automatically — this is a note for whoever reviews it later.' },
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
            undo: { variables: variableSnapshot, goals: goalSnapshot },
        });
        return { ok: true, transaction, receipts: transaction.receipts, pending: runtime.pending.length };
    } catch (error) {
        restoreVariableStore(variableSnapshot, { save: false });
        restoreStoryGoalsStore(goalSnapshot, { save: false });
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
    recordMechanicsTransaction({ protocol: MECHANICS_PROTOCOL, timelineId: transaction.timelineId, sceneId: transaction.sceneId, status: 'applied', requests: [], receipts: [{ status: 'applied', capability: 'transaction.undo', before: beforeUndo, after: { restored: true }, reason: 'User reversed an automatic mechanical transaction.' }] });
    return true;
}

function applyRequest(request, runtime) {
    const args = request.arguments;
    switch (request.capability) {
        case 'variable.set': return setVariable(request, args, runtime);
        case 'variable.subvalue.set': return setVariable(request, args, runtime, true);
        case 'variable.adjust': return adjustVariable(request, args, runtime);
        case 'variable.transition': return transitionVariable(request, args, runtime);
        case 'modifier.add': return addModifier(request, args, runtime);
        case 'modifier.remove': return removeModifier(request, args, runtime);
        case 'goal.create': return createGoal(request, args, runtime);
        case 'goal.shift': return shiftGoal(request, args, runtime);
        case 'goal.relate': return relateGoals(request, args, runtime);
        case 'goal.close': return closeGoal(request, args, runtime);
        case 'goal.reach': return reachGoal(request, args, runtime);
        default: throw new MechanicsError(`Unsupported capability ${request.capability}.`);
    }
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
    const resolution = normalizeResolutionArgs(args.resolution, runtime);
    const rate = args.openingBand ? openingRateForBand(args.openingBand) : clampRate(args.successRate);
    const goal = createTimelineGoal(runtime.timelineId, { title: args.title, description: args.description, holderRefs, targetRefs, successRate: rate, visibility: args.visibility, resolution }, { sceneId: runtime.sceneId, actor: 'mechanics', reason: request.reason });
    if (!goal) throw new MechanicsError(`${request.id}: Goal could not be created.`);
    setAlias(runtime, args.alias, goal.id, 'goal');
    receipt(runtime, request, null, goal);
}

function shiftGoal(request, args, runtime) {
    const goal = requireGoal(resolveReference(args.goalRef ?? args.goalId, runtime, 'goal'), runtime);
    if (!isAuthorizedGoal(goal, runtime)) return deferGoal(request, runtime, { [String(args.goalRef ?? args.goalId)]: goal.id }, `Changing the user-owned Goal “${goal.title}” requires review.`);
    const amount = shiftForMagnitude(args.magnitude);
    if (!amount) throw new MechanicsError(`${request.id}: invalid shift magnitude.`);
    const before = copy(goal);
    const direction = args.direction === 'down' ? -1 : 1;
    const after = updateStoryGoal(goal.id, { successRate: clampRate(goal.successRate + direction * amount) }, { ...txContext(runtime, request), type: 'goal.shifted' });
    receipt(runtime, request, before, after, { shift: direction * amount });
}

function relateGoals(request, args, runtime) {
    const from = requireGoal(resolveReference(args.fromGoalRef ?? args.fromGoalId, runtime, 'goal'), runtime);
    const to = requireGoal(resolveReference(args.toGoalRef ?? args.toGoalId, runtime, 'goal'), runtime);
    if (!isAuthorizedGoal(from, runtime)) return deferGoal(request, runtime, { [String(args.fromGoalRef ?? args.fromGoalId)]: from.id, [String(args.toGoalRef ?? args.toGoalId)]: to.id }, `Changing a relationship from the user-owned Goal “${from.title}” requires review.`);
    const relation = createTimelineGoalRelation(runtime.timelineId, from.id, to.id, args.type, request.reason, txContext(runtime, request));
    if (!relation) throw new MechanicsError(`${request.id}: invalid Goal relationship.`);
    receipt(runtime, request, null, relation);
}

function closeGoal(request, args, runtime) {
    const goal = requireGoal(resolveReference(args.goalRef ?? args.goalId, runtime, 'goal'), runtime);
    if (!isAuthorizedGoal(goal, runtime)) return deferGoal(request, runtime, { [String(args.goalRef ?? args.goalId)]: goal.id }, `Closing the user-owned Goal “${goal.title}” requires review.`);
    if (!['achieved', 'abandoned', 'impossible'].includes(args.status)) throw new MechanicsError(`${request.id}: invalid terminal Goal status.`);
    const before = copy(goal);
    const after = updateStoryGoal(goal.id, { status: args.status }, { ...txContext(runtime, request), type: 'goal.closed' });
    receipt(runtime, request, before, after);
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
    // The tracked Variable comes from stored Goal data, not from model input, so
    // it is resolved by id rather than by ref — but it must still be a Variable
    // this pass advertised. Otherwise a reach reads and writes a Variable the
    // Director was never shown, which is the containment this check exists for.
    //
    // Read off retrievedVariableIds, not the address table: the address table
    // holds only the names THIS BATCH resolved, so a reach that names no
    // Variable of its own would otherwise look like a pass that retrieved
    // nothing.
    const trackedId = String(goal.resolution?.variableId || goal.resolution?.variableInstanceId || '');
    if (goal.resolution?.kind === 'tracked' && trackedId && !runtime.retrievedVariableIds.size) {
        throw new MechanicsError(`${request.id}: the Goal tracks a Variable that was not retrieved for this request.`);
    }
    if (goal.resolution?.kind === 'tracked' && trackedId && !runtime.retrievedVariableIds.has(trackedId)) {
        throw new MechanicsError(`${request.id}: the Goal tracks a Variable that was not advertised for this request.`);
    }
    const trackedInstance = goal.resolution?.kind === 'tracked' ? requireVariable(trackedId, runtime) : null;
    const frozen = {
        successRate: goal.successRate,
        modifierVariableId: modifierInstance?.id || '', modifier,
        variableId: trackedInstance?.id || '', field: goal.resolution?.field || 'value', direction: goal.resolution?.direction || '',
        completionThreshold: goal.resolution?.completionThreshold ?? null,
        impactMagnitude: String(args.impactMagnitude || 'meaningful'),
    };
    const result = resolveReach({ rate: frozen.successRate, modifier });
    let variableAfter = null;
    let goalAfter = goal;
    if (!result.hit) {
        goalAfter = updateStoryGoal(goal.id, { successRate: clampRate(goal.successRate - result.rateCost) }, { ...txContext(runtime, request), type: 'goal.reach.missed' });
    } else if (goal.resolution.kind === 'instant') {
        goalAfter = updateStoryGoal(goal.id, { status: 'achieved' }, { ...txContext(runtime, request), type: 'goal.reach.hit' });
    } else {
        const impact = shiftForMagnitude(frozen.impactMagnitude);
        if (!impact) throw new MechanicsError(`${request.id}: tracked Goal requires a numeric Variable and a valid impact magnitude.`);
        const delta = goal.resolution.direction === 'increase' ? impact : -impact;
        variableAfter = adjustVariableValue(trackedInstance.id, delta, { ...txContext(runtime, request), field: frozen.field, type: 'goal.impact' });
        if (!variableAfter) throw new MechanicsError(`${request.id}: tracked Goal field is not numeric.`);
        const trackedValue = frozen.field === 'value' ? variableAfter.value : variableAfter.subvalues.find((item) => item.key === frozen.field)?.value;
        const reachedThreshold = goal.resolution.direction === 'increase'
            ? Number(trackedValue) >= Number(goal.resolution.completionThreshold)
            : Number(trackedValue) <= Number(goal.resolution.completionThreshold);
        if (reachedThreshold) goalAfter = updateStoryGoal(goal.id, { status: 'achieved' }, { ...txContext(runtime, request), type: 'goal.reach.hit' });
    }
    receipt(runtime, request, before, goalAfter, { frozen, roll: result, variableAfter });
}

function validateArguments(request) {
    const args = request.arguments;
    // `goalRef` also accepts the older `goalId` spelling, so a request deferred
    // for review under the previous schema still validates when it is approved.
    const legacy = { goalRef: 'goalId', fromGoalRef: 'fromGoalId', toGoalRef: 'toGoalId' };
    const missing = (key) => (args[key] == null || args[key] === '') && (!legacy[key] || args[legacy[key]] == null || args[legacy[key]] === '');
    const require = (...keys) => { for (const key of keys) if (missing(key)) throw new MechanicsError(`${request.id}: ${key} is required.`); };
    switch (request.capability) {
        case 'goal.create': require('title', 'holderRefs', 'resolution'); break;
        case 'goal.shift': require('goalRef', 'direction', 'magnitude'); break;
        case 'goal.reach': require('goalRef', 'impactMagnitude'); break;
        case 'goal.relate': require('fromGoalRef', 'toGoalRef', 'type'); break;
        case 'goal.close': require('goalRef', 'status'); break;
        case 'variable.set': require('variableRef', 'value'); break;
        case 'variable.subvalue.set': require('variableRef', 'field', 'value'); break;
        case 'variable.adjust': require('variableRef', 'delta'); break;
        case 'variable.transition': require('variableRef', 'nextState'); break;
        case 'modifier.add': require('variableRef', 'label', 'delta', 'target'); break;
        case 'modifier.remove': require('variableRef', 'modifierId'); break;
    }
}

function normalizeResolutionArgs(value, runtime) {
    if (!value || value.kind !== 'tracked') return { kind: 'instant' };
    return { kind: 'tracked', variableId: resolveVariableReference(value.variableRef, runtime), field: value.field || 'value', direction: value.direction, completionThreshold: value.completionThreshold };
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

function requireGoal(id, runtime) {
    const goal = getStoryGoal(id);
    if (!goal || goal.timelineId !== runtime.timelineId || goal.status !== 'active') throw new MechanicsError(`Goal ${id || '(missing)'} is unavailable or inactive.`);
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
