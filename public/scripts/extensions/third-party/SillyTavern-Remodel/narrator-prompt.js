import { listSceneFacts, listCharStates, getBeat } from './archivist-store.js';
import { getSceneGoals } from './story-goals-store.js';
import { buildSceneArchiveProjection, renderArchiveProjection } from './archive-projection.js';

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

/**
 * Render the archivist's Narrator-visible state as labelled sections.
 *
 * Secrets are excluded by construction: this function never reads the secret
 * store, so a secret cannot leak through a formatting mistake. Returns '' when
 * the scene has no state yet.
 */
export function buildNarratorArchivistSections(timelineId, sceneId, { events: eventLimit = null, archiveProjection = null, archiveQuery = [] } = {}) {
    const facts = listSceneFacts(timelineId, sceneId);
    const charStates = listCharStates(timelineId, sceneId);
    const projection = archiveProjection && (eventLimit === null || eventLimit === undefined || eventLimit === '')
        ? archiveProjection
        : buildSceneArchiveProjection(timelineId, sceneId, { query: archiveQuery, maxEntries: eventLimit });
    const beat = getBeat(timelineId, sceneId);
    const sections = [];
    if (facts.length) {
        sections.push(['Scene', facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')]);
    }
    if (charStates.length) {
        const lines = charStates.map((c) => {
            const facets = Object.entries(c.facets || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
            return `- ${c.charId} — ${facets}`;
        });
        sections.push(['Characters', lines.join('\n')]);
    }
    if (projection.entries.length) {
        sections.push(['What has happened (already written — do NOT narrate this again)', renderArchiveProjection(projection)]);
    }
    if (beat) {
        const tone = beat.tone ? ` (tone: ${beat.tone})` : '';
        sections.push(['Open thread — provisional', `Unresolved momentum, not a required outcome. It never overrides the latest accepted action.\n${beat.directive}${tone}`]);
    }
    return sections.map(([label, body]) => `## ${label}\n${body}`).join('\n\n');
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
