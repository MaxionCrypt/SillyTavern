// Actor-initiated mechanics.
//
// An AI-controlled actor may start a decisive attempt exactly the way the
// player does, through the same frozen gateway and the same deterministic
// engine. Actor identity changes authorization and knowledge — who may attempt
// what, and against which objects — never mathematical truth. Nothing here
// touches the die.
//
// Reconnected at one seam: `isActorMechanicsEnabled(scene)`. Off by default,
// so the legacy path stays the running implementation until a Scene opts in.

import {
    freezeMechanicsAttempt,
    resolveMechanicsAttempt,
    NARRATOR_MECHANIC_TOOLS,
} from './mechanics-gateway.js';

export const ACTOR_MECHANICS_SWITCH = 'actorMechanics';

const TERMINAL = ['achieved', 'abandoned', 'impossible'];

export class ActorMechanicsRefusal extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/** The per-Scene experimental switch. Absent means off: an experiment must be
 * chosen, never inherited by every Scene that happens to load. */
export function isActorMechanicsEnabled(scene) {
    return scene?.liveDirection?.[ACTOR_MECHANICS_SWITCH] === true;
}

/**
 * What THIS actor may attempt. Ownership is the filter: an actor acts on the
 * outcomes they are pursuing, not on every Goal in the Timeline. Advertising
 * more than that is what lets a model reach for another character's stakes and
 * call it their own initiative.
 */
export function buildActorAdvertisement({ actor, goals = [], variables = [] } = {}) {
    const actorId = String(actor || '').trim();
    const held = goals.filter((goal) => !TERMINAL.includes(String(goal?.status || '').toLowerCase())
        && (goal?.holderRefs || []).some((ref) => String(ref?.id || '') === actorId));
    return Object.freeze({
        actor: actorId,
        tools: Object.freeze([...NARRATOR_MECHANIC_TOOLS]),
        goalRefs: Object.freeze(held.map((goal) => String(goal.title || ''))),
        variableRefs: Object.freeze(variables.map((variable) => String(variable.name || ''))),
    });
}

/**
 * Refuse before freezing. Every refusal here is a legitimate story outcome —
 * an actor reaching for something they do not hold or cannot see — so each one
 * carries a code the caller can narrate, rather than surfacing as a fault.
 */
export function validateActorAttempt({ actor, tool, target, goals = [], variables = [], knownRefs = null } = {}) {
    const actorId = String(actor || '').trim();
    if (!actorId) throw new ActorMechanicsRefusal('An attempt needs an actor.', 'no-actor');
    if (!NARRATOR_MECHANIC_TOOLS.includes(String(tool || ''))) {
        throw new ActorMechanicsRefusal(`${tool} is not an advertised mechanic.`, 'unknown-tool');
    }
    const ref = String(target || '').trim();
    if (!ref) throw new ActorMechanicsRefusal('An attempt needs a target.', 'no-target');

    if (String(tool).startsWith('goal.')) {
        const goal = goals.find((item) => String(item?.title || '') === ref);
        if (!goal) throw new ActorMechanicsRefusal(`No Goal named "${ref}" is available.`, 'unavailable-object');
        if (TERMINAL.includes(String(goal.status || '').toLowerCase())) {
            throw new ActorMechanicsRefusal(`"${ref}" is already ${goal.status}.`, 'goal-closed');
        }
        if (!(goal.holderRefs || []).some((holder) => String(holder?.id || '') === actorId)) {
            throw new ActorMechanicsRefusal(`${actorId} does not hold "${ref}".`, 'not-holder');
        }
    } else if (tool === 'variable.adjust') {
        if (!variables.some((item) => String(item?.name || '') === ref)) {
            throw new ActorMechanicsRefusal(`No Variable named "${ref}" is available.`, 'unavailable-object');
        }
    }

    // Knowledge, when the caller supplies a scope. An actor cannot act on what
    // only the author knows; the full scope contract lands with knowledge scopes.
    if (knownRefs && !knownRefs.includes(ref)) {
        throw new ActorMechanicsRefusal(`${actorId} does not know about "${ref}".`, 'unknown-to-actor');
    }
    return true;
}

/**
 * One actor-initiated attempt, end to end. The Narrator supplies intent — who,
 * against what, and for a proposed delta — and deterministic code decides
 * whether it is allowed, freezes it, and applies it exactly once.
 */
export function resolveActorAttempt({
    actor,
    tool,
    target,
    stakes = '',
    reason = '',
    value = null,
    odds = null,
    modifiers = [],
    directionId,
    attemptIndex = 0,
    goals = [],
    variables = [],
    knownRefs = null,
    timelineId,
    sceneId,
    ...engine
} = {}) {
    try {
        validateActorAttempt({ actor, tool, target, goals, variables, knownRefs });
    } catch (error) {
        if (!(error instanceof ActorMechanicsRefusal)) throw error;
        return Object.freeze({
            ok: false,
            refused: true,
            code: error.code,
            receipt: Object.freeze({ actor: String(actor || ''), tool, target, status: 'refused', rejectionReason: error.message }),
        });
    }

    const goal = goals.find((item) => String(item?.title || '') === String(target));
    const frozen = freezeMechanicsAttempt({
        tool,
        actor,
        target,
        stakes,
        reason,
        directionId,
        attemptIndex,
        // Odds come from the store, never from the model: the Narrator may say a
        // thing is hard, but it does not get to say how hard.
        odds: odds === null ? (goal ? Number(goal.successRate) : null) : odds,
        value,
        modifiers,
        advertisement: buildActorAdvertisement({ actor, goals, variables }),
    });

    const result = resolveMechanicsAttempt(frozen, { timelineId, sceneId, ...engine });
    return Object.freeze({ ...result, refused: false, code: '', frozen });
}
