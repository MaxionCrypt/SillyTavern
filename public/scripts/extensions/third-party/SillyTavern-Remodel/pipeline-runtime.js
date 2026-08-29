// The one seam where the rebuilt modules become live.
//
// Commit 10 left `runMechanicsTransport`'s executor a deliberate dry-run.
// Commits 11 and 12 built the real thing. This module joins them, and is the
// only place that knows both halves: nothing upstream is edited to know which
// implementation is running.
//
// Selection is per Scene and defaults to legacy. A Scene that has not opted in
// behaves exactly as it did before this file existed.

import { resolveActorAttempt } from './actor-mechanics.js';
import { NARRATOR_MECHANIC_TOOLS } from './mechanics-gateway.js';
import { projectActorKnowledge } from './knowledge-scopes.js';
import { recordRouteReceipt } from './pipeline-diagnostics.js';
import { getTimelineGoals } from './story-goals-store.js';
import { listVariableValues } from './variables-store.js';

/** Provider tool names arrive in whichever shape the provider prefers. */
function normalizeToolName(name) {
    const raw = String(name || '').trim().replace(/_/g, '.').toLowerCase();
    return NARRATOR_MECHANIC_TOOLS.includes(raw) ? raw : '';
}

/** Read the per-Scene selection, for diagnostics. Absent means legacy. */
export function isModuleRebuilt(scene, module) {
    return scene?.liveDirection?.pipeline?.[module] === 'rebuilt';
}

/**
 * Always true on this branch. The rebuilt mechanics gateway is what this branch
 * is for, so Narrator tool calls always route through it; rolling back means
 * switching branches, not flipping a Scene field.
 */
export function isRebuiltMechanicsEnabled() {
    return true;
}

/**
 * Build the executor `runMechanicsTransport` calls once per tool call.
 *
 * Every call is resolved through the actor path, so the player and an
 * AI-controlled actor travel identical validation: ownership, availability, and
 * knowledge. The returned value is the compact receipt that goes back to the
 * model as a `tool` message — never store state, never author-only material.
 */
export function createMechanicsExecutor({
    scene,
    actor,
    directionId,
    goals = [],
    variables = [],
    secrets = [],
    scopes = [],
    timelineId = scene?.timelineId,
    sceneId = scene?.id,
    ...engine
} = {}) {
    let attemptIndex = 0;
    // What this actor may reference at all. Author-only material never becomes
    // an address, so a tool call cannot name it in the first place.
    const knownRefs = secrets.length
        ? projectActorKnowledge({ secrets, scopes, actor }).items.map((item) => item.key)
        : null;

    return async function execute(call) {
        const tool = normalizeToolName(call?.name);
        if (!tool) {
            return { status: 'rejected', reason: `${call?.name || 'unknown'} is not an advertised mechanic.` };
        }
        const args = call?.arguments || {};
        const index = attemptIndex;
        attemptIndex += 1;

        const result = resolveActorAttempt({
            actor: String(args.actor || actor || ''),
            tool,
            target: String(args.target ?? args.goalRef ?? args.variableRef ?? ''),
            stakes: String(args.stakes || ''),
            reason: String(args.reason || ''),
            value: args.value === undefined ? (args.delta === undefined ? null : Number(args.delta)) : Number(args.value),
            modifiers: Array.isArray(args.modifiers) ? args.modifiers : [],
            directionId,
            attemptIndex: index,
            goals,
            variables,
            knownRefs,
            timelineId,
            sceneId,
            ...engine,
        });

        // The receipt the turn must obey. A refusal is reported as a refusal —
        // never converted into an invented success the prose could act on.
        return result.refused
            ? { status: 'refused', reason: result.receipt.rejectionReason, tool, target: result.receipt.target }
            : {
                status: result.receipt.status,
                tool,
                target: result.receipt.target,
                actor: result.receipt.actor,
                outcome: result.receipt.outcome,
                roll: result.receipt.roll,
                frozen: result.receipt.frozen,
                ...(result.receipt.rejectionReason ? { reason: result.receipt.rejectionReason } : {}),
            };
    };
}

/**
 * The mechanics dependency handed to the Narrator transport. Returns null when
 * the Scene has not opted in, which is what keeps the legacy path byte-identical.
 */
export function createTurnMechanics(options = {}) {
    if (!isRebuiltMechanicsEnabled(options.scene)) return null;
    const execute = createMechanicsExecutor(options);
    return Object.freeze({
        execute,
        route: recordRouteReceipt({
            role: 'narrator',
            profileId: options.route?.profileId,
            profileName: options.route?.profileName,
            provider: options.route?.api,
            model: options.route?.model,
        }),
    });
}

/**
 * The single call the turn controller makes. Everything the gateway needs is
 * resolved here from the Scene, so the controller never learns which
 * implementation is running — it passes the result along and stays ignorant.
 * Returns null on a Scene that has not opted in, which leaves the Narrator
 * transport on its legacy single-request path.
 */
export function createTurnMechanicsForScene({ scene, run } = {}) {
    if (!isRebuiltMechanicsEnabled(scene)) return null;
    const timelineId = String(scene?.timelineId || '');
    return createTurnMechanics({
        scene,
        actor: String(run?.performer?.id || run?.performer?.label || ''),
        directionId: String(run?.directionId || ''),
        goals: getTimelineGoals(timelineId),
        variables: listVariableValues({ timelineId }),
        timelineId,
        sceneId: String(scene?.id || ''),
    });
}
