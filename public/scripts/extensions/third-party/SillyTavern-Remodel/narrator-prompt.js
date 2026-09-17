import { getSceneGoals, getTimelineGoals } from './story-goals-store.js';
import { listVariableValues, formatVariable } from './variables-store.js';

/**
 * Active Goals for the Loom's readable Archive view. The Narrator receives
 * Goals once through the recipe-owned story.goals macro.
 */
export function buildGoalObjectives(sceneId, { limit = null } = {}) {
    const goals = getSceneGoals(sceneId, { includeResolved: false, states: ['active', 'background'] });
    const selected = boundedTail(goals, limit);
    if (!selected.length) return '';
    const lines = selected.map((goal) => {
        const desc = String(goal.description || '').trim();
        const holders = (Array.isArray(goal.holderRefs) ? goal.holderRefs : [])
            .map((holder) => String(holder?.label || holder?.id || '').trim())
            .filter(Boolean);
        const owner = holders.length ? holders.join(', ') : 'Unassigned';
        return `- ${owner} — ${goal.title}${desc ? `: ${desc}` : ''}`;
    });
    return `## Goals — consequential pressures\n${lines.join('\n')}`;
}

// --- Loom state renderers (Goals / Variables / player action) --------------
//
// The Archive-backed renderers (scene facts, characters, events, secrets,
// prev.events) were dissolved with the Loom Archive. What survives reads the
// Goals and Variables stores, which are separate systems.

/** {{loom.action}} — the player's authoritative turn input. */
export function renderLoomAction(action) {
    const text = String(action || '').trim();
    if (!text) return '';
    return [
        'CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT',
        'This is the player\'s explicit speech, voluntary action, or attempted action for this turn. It outranks conflicting inference in the Narrator draft. Preserve what the player explicitly said or attempted, judge only uncertain outcomes and world reactions, and never invent additional voluntary player speech, thoughts, decisions, or actions.',
        text,
    ].join('\n');
}

/** {{loom.goals}} — every open Goal for the Timeline, with its numbers. Secret
 *  Goals are hidden unless secret=true, so this macro is safe in a player-facing
 *  recipe; the Loom recipe passes secret=true to see them. */
export function renderLoomGoals(timelineId, { limit = null, secret = false } = {}) {
    const all = getTimelineGoals(String(timelineId || ''), { includeResolved: false });
    const goals = secret === true ? all : all.filter((goal) => goal.visibility !== 'secret');
    const selected = limit === null || limit === undefined || limit === ''
        ? goals
        : goals.slice(-Math.max(0, Math.floor(Number(limit) || 0)));
    if (!selected.length) return '';
    const lines = selected.map((goal) => {
        const rate = Number.isFinite(Number(goal.successRate)) ? ` — ${Number(goal.successRate)}%` : '';
        const facets = [goal.status, goal.visibility].filter(Boolean).join(', ');
        const holders = (Array.isArray(goal.holderRefs) ? goal.holderRefs : [])
            .map((holder) => holder?.label || holder?.id).filter(Boolean).join(', ');
        const detail = [String(goal.description || '').trim(), holders ? `Held by: ${holders}` : '']
            .filter(Boolean).map((line) => `  ${line}`);
        return [`- ${goal.title}${rate}${facets ? ` (${facets})` : ''}`, ...detail].join('\n');
    });
    return `## Goals\n${lines.join('\n')}`;
}

/** {{loom.variables}} — every Variable for the Timeline, with its value. */
export function renderLoomVariables(timelineId, { limit = null } = {}) {
    const variables = listVariableValues({ timelineId: String(timelineId || '') });
    const selected = limit === null || limit === undefined || limit === ''
        ? variables
        : variables.slice(-Math.max(0, Math.floor(Number(limit) || 0)));
    if (!selected.length) return '';
    const lines = selected.map((variable) => {
        const value = formatVariable(variable);
        const meaning = String(variable.description || '').trim();
        return `- ${variable.name}: ${value}${meaning ? ` — ${meaning}` : ''}`;
    });
    return `## Variables\n${lines.join('\n')}`;
}

function boundedTail(items, requested) {
    if (requested === null || requested === undefined || requested === '') return items;
    const count = Math.max(0, Math.floor(Number(requested) || 0));
    return count > 0 ? items.slice(-count) : [];
}

/**
 * The extra instruction a Narrator retry carries after an empty response.
 *
 * THE DEFECT THIS FIXES: the empty-response path re-sent a BYTE-IDENTICAL
 * request. Captured on the wire — attempts 2 and 3 of one turn produced
 * request bodies that compared equal character for character, 72 seconds
 * apart. Asking a model the identical question it just failed to answer is a
 * repetition, not a retry, and it burned the whole retry budget (and, in three
 * observed turns, the entire turn) on the same failure.
 *
 * The observed failure is specific: the provider spends the response on
 * private reasoning and returns no visible content — 3,000 to 8,000 characters
 * of thinking against an empty `mes`. So the nudge names exactly that, rather
 * than being a generic "try again".
 *
 * Returns '' for a first attempt, so the initial request is never altered.
 *
 * @param {number} attempt 1 for the first try; 2+ for a retry
 * @param {{reasoningLength?: number}} [previous] what the failed attempt returned
 */
export function buildEmptyResponseNudge(attempt, { reasoningLength = 0, failureCause = '' } = {}) {
    const n = Number(attempt);
    if (!Number.isFinite(n) || n < 2) return '';
    const malformed = ['reasoning-in-content', 'instruction-echo', 'protocol-output'].includes(String(failureCause));
    const thought = failureCause === 'reasoning-in-content'
        ? 'The previous attempt exposed private planning in the visible content channel.'
        : failureCause === 'instruction-echo'
            ? 'The previous attempt copied prompt instructions into the response.'
            : failureCause === 'protocol-output'
                ? 'The previous attempt returned state or protocol JSON instead of narration.'
                : Number(reasoningLength) > 0
        ? 'The previous attempt spent its entire response on private reasoning and returned no prose.'
        : 'The previous attempt returned an empty response.';
    return [
        '## Output required',
        thought,
        malformed
            ? 'Return only the scene prose. Do not explain your approach, repeat any instruction, quote the prompt, or emit JSON/protocol data.'
            : 'Write the scene prose itself in your reply, as visible text. Do not answer with reasoning alone, and do not return an empty message.',
    ].join('\n');
}
