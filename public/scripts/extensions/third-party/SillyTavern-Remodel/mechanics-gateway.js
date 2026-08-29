// The Narrator-facing mechanics gateway.
//
// The Narrator has narrative authority over WHY a change is warranted. This
// module is the boundary where that authority stops and deterministic code
// takes over: it advertises a deliberately small tool vocabulary, freezes the
// inputs a calculation will run against, hands the frozen request to the
// mechanics engine, and returns a compact receipt the same logical Narrator
// turn has to obey.
//
// It is built beside the working pipeline and has no production callers yet
// (rebuild rule 4). Commit 12 reconnects it.

import { executeMechanicsRequest } from './mechanics-capabilities.js';
import { listMechanicsTransactions } from './variables-store.js';

/**
 * The bounded vocabulary. Deliberately four verbs, not the engine's full
 * capability dictionary: the Narrator is writing prose under time pressure,
 * and every extra verb is another way for it to invent a shape that fails
 * closed. Lifecycle work — creating, relating, retiring — stays with the Loom,
 * which reads accepted fiction rather than predicting it.
 */
export const NARRATOR_MECHANIC_TOOLS = Object.freeze(['goal.attempt', 'goal.adjust', 'variable.adjust', 'mechanic.check']);

/**
 * How each advertised verb reaches the engine. `mechanic.check` maps to null on
 * purpose: it is a calculation that must never write, so it never becomes an
 * engine request at all.
 */
const TOOL_CAPABILITY = Object.freeze({
    'goal.attempt': 'goal.reach',
    'goal.adjust': 'goal.edit',
    'variable.adjust': 'variable.adjust',
    'mechanic.check': null,
});

export class MechanicsGatewayError extends Error {}

/**
 * What the Narrator may name this turn, and nothing else. An address book the
 * model did not receive is an address it cannot legitimately reference, so the
 * advertisement and the resolver are built from one source here rather than
 * drifting apart the way the prompt and the validator once did.
 */
export function buildNarratorToolAdvertisement({ goals = [], variables = [] } = {}) {
    const openGoals = goals.filter((goal) => !['achieved', 'abandoned', 'impossible'].includes(String(goal?.status || '').toLowerCase()));
    return Object.freeze({
        tools: NARRATOR_MECHANIC_TOOLS.map((name) => Object.freeze({ name, capability: TOOL_CAPABILITY[name] })),
        goalRefs: Object.freeze(openGoals.map((goal) => String(goal.title || ''))),
        variableRefs: Object.freeze(variables.map((variable) => String(variable.name || ''))),
    });
}

/**
 * Freeze everything a calculation will read BEFORE anything is rolled or
 * applied. The engine already freezes a Goal's odds and modifier inside
 * `goal.reach`; what it cannot see is the turn-level context — which actor is
 * attempting, what they are attempting it against, what is at stake, and which
 * attempt this is within the turn. Without that, two identical-looking
 * attempts in one turn are indistinguishable, and a retry cannot tell whether
 * it is repeating work or doing new work.
 *
 * @returns {object} frozen attempt record; `attemptKey` is its exact-once identity
 */
export function freezeMechanicsAttempt({
    tool,
    actor,
    target,
    stakes = '',
    reason = '',
    directionId,
    attemptIndex = 0,
    advertisement = null,
    odds = null,
    value = null,
    modifiers = [],
} = {}) {
    const name = String(tool || '');
    if (!NARRATOR_MECHANIC_TOOLS.includes(name)) throw new MechanicsGatewayError(`Unknown mechanic tool ${name || '(none)'}.`);
    const actorId = String(actor || '').trim();
    if (!actorId) throw new MechanicsGatewayError(`${name}: an actor is required.`);
    const targetRef = String(target || '').trim();
    if (!targetRef) throw new MechanicsGatewayError(`${name}: a target is required.`);
    const direction = String(directionId || '').trim();
    if (!direction) throw new MechanicsGatewayError(`${name}: a directionId is required to keep the attempt exactly-once.`);

    // An advertised address is the only address. Checked here rather than at
    // execution time so a hallucinated Goal name fails before anything freezes.
    if (advertisement) {
        const table = name.startsWith('goal.') ? advertisement.goalRefs : advertisement.variableRefs;
        if (name !== 'mechanic.check' && !(table || []).includes(targetRef)) {
            throw new MechanicsGatewayError(`${name}: "${targetRef}" was not advertised this turn.`);
        }
    }

    const index = Number.isInteger(attemptIndex) && attemptIndex >= 0 ? attemptIndex : 0;
    return Object.freeze({
        tool: name,
        capability: TOOL_CAPABILITY[name],
        actor: actorId,
        target: targetRef,
        stakes: String(stakes || ''),
        reason: String(reason || ''),
        directionId: direction,
        attemptIndex: index,
        odds: odds === null ? null : Number(odds),
        value: value === null ? null : Number(value),
        modifiers: Object.freeze([...modifiers].map((item) => String(item))),
        attemptKey: `${direction}:${actorId}:${name}:${targetRef}:${index}`,
    });
}

/**
 * A receipt the Narrator can actually obey mid-prose. The engine's receipt
 * carries whole before/after store objects; sending those back into a
 * continuation would bury the one fact that matters — what happened — under
 * state the model must not start narrating.
 */
export function toCompactReceipt(frozen, engineReceipt = null, extra = {}) {
    return Object.freeze({
        attemptKey: frozen.attemptKey,
        tool: frozen.tool,
        actor: frozen.actor,
        target: frozen.target,
        status: String(engineReceipt?.status || extra.status || 'rejected'),
        outcome: extra.outcome ?? null,
        roll: engineReceipt?.roll ? Object.freeze({ ...engineReceipt.roll }) : (extra.roll ?? null),
        frozen: Object.freeze({ odds: frozen.odds, value: frozen.value, modifiers: frozen.modifiers, stakes: frozen.stakes }),
        rejectionReason: engineReceipt?.rejectionReason || extra.rejectionReason || '',
    });
}

/**
 * Has this exact attempt already been committed? A provider reconnect, a Retry,
 * or a duplicated tool call all arrive looking like new work. The attempt key
 * is stable across every one of them, so a prior applied transaction carrying
 * the same key is the same attempt, and its receipt is replayed rather than its
 * numbers applied a second time.
 */
export function findCommittedAttempt(attemptKey, { timelineId, sceneId, listTransactions = listMechanicsTransactions } = {}) {
    const key = String(attemptKey || '');
    if (!key) return null;
    const transactions = listTransactions({ timelineId, sceneId }) || [];
    for (const transaction of transactions) {
        if (transaction?.status !== 'applied') continue;
        if (String(transaction?.source?.attemptKey || '') === key) return transaction;
    }
    return null;
}

/**
 * Resolve one frozen attempt. Code owns the die and the write; the Narrator
 * owns only the claim that a change is warranted.
 *
 * `mechanic.check` never reaches the engine — it is a calculation whose whole
 * point is that it does not close a Goal, so giving it a write path would make
 * "just checking" indistinguishable from acting.
 */
export function resolveMechanicsAttempt(frozen, {
    timelineId,
    sceneId,
    turnId = '',
    goalRefs = {},
    variableRefs = {},
    authorizedGoalIds = [],
    execute = executeMechanicsRequest,
    listTransactions = listMechanicsTransactions,
    random = Math.random,
} = {}) {
    const committed = findCommittedAttempt(frozen.attemptKey, { timelineId, sceneId, listTransactions });
    if (committed) {
        const prior = (committed.receipts || []).find((item) => item?.status === 'applied') || null;
        return { ok: true, reused: true, transaction: committed, receipt: toCompactReceipt(frozen, prior, { status: 'applied' }) };
    }

    if (frozen.tool === 'mechanic.check') {
        // Deterministic, read-only. The roll is still code's, never the model's.
        const rate = Number.isFinite(frozen.odds) ? frozen.odds : 0;
        const modifier = frozen.modifiers.length;
        const roll = Math.floor(random() * 100) + 1;
        const hit = roll <= rate + modifier;
        return {
            ok: true,
            reused: false,
            transaction: null,
            receipt: toCompactReceipt(frozen, null, { status: 'applied', outcome: hit ? 'hit' : 'miss', roll: { roll, rate, modifier, hit } }),
        };
    }

    const envelope = {
        protocol: 'remodel-mechanics/1',
        requests: [{
            id: frozen.attemptKey,
            capability: frozen.capability,
            arguments: buildEngineArguments(frozen),
            reason: frozen.reason || frozen.stakes || 'Narrator-initiated mechanical attempt.',
        }],
    };

    const result = execute(envelope, {
        timelineId,
        sceneId,
        turnId,
        directionId: frozen.directionId,
        goalRefs,
        variableRefs,
        authorizedGoalIds,
        // Travels onto the transaction so a later reconnect can recognise this
        // exact attempt instead of applying it twice.
        source: { attemptKey: frozen.attemptKey, actor: frozen.actor, tool: frozen.tool, attemptIndex: frozen.attemptIndex },
    });

    const engineReceipt = (result?.receipts || [])[0] || null;
    const outcome = engineReceipt?.roll ? (engineReceipt.roll.hit ? 'hit' : 'miss') : null;
    return {
        ok: Boolean(result?.ok),
        reused: false,
        transaction: result?.transaction || null,
        receipt: toCompactReceipt(frozen, engineReceipt, { outcome, rejectionReason: (result?.errors || [])[0] || '' }),
    };
}

function buildEngineArguments(frozen) {
    switch (frozen.tool) {
        case 'goal.attempt':
            return { goalRef: frozen.target };
        case 'goal.adjust':
            return { goalRef: frozen.target, successRate: frozen.value };
        case 'variable.adjust':
            return { variableRef: frozen.target, delta: frozen.value };
        default:
            throw new MechanicsGatewayError(`${frozen.tool} has no engine arguments.`);
    }
}
