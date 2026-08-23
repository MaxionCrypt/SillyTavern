import { listSceneFacts, listCharStates, listEvents, getBeat } from './archivist-store.js';
import { getSceneGoals } from './story-goals-store.js';

/**
 * The scene's active goals as narrative OBJECTIVES for the narrator view — what
 * characters are trying to do, never the odds behind it. The odds and status
 * numbers stay on the Loom's private board. Empty when none.
 */
export function buildGoalObjectives(sceneId) {
    const goals = getSceneGoals(sceneId, { includeResolved: false, states: ['active', 'background'] });
    if (!goals.length) return '';
    const lines = goals.map((goal) => {
        const desc = String(goal.description || '').trim();
        return `- ${goal.title}${desc ? `: ${desc}` : ''}`;
    });
    return `## Objectives\n${lines.join('\n')}`;
}

/**
 * Render the archivist's Narrator-visible state as labelled sections.
 *
 * Secrets are excluded by construction: this function never reads the secret
 * store, so a secret cannot leak through a formatting mistake. Returns '' when
 * the scene has no state yet.
 */
export function buildNarratorArchivistSections(timelineId, sceneId) {
    const facts = listSceneFacts(timelineId, sceneId);
    const charStates = listCharStates(timelineId, sceneId);
    const events = listEvents(timelineId, sceneId);
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
    if (events.length) {
        sections.push(['What has happened (already written — do NOT narrate this again)', events.map((e) => `- ${e.summary}`).join('\n')]);
    }
    if (beat) {
        const tone = beat.tone ? ` (tone: ${beat.tone})` : '';
        sections.push(['What happens next', `${beat.directive}${tone}`]);
    }
    return sections.map(([label, body]) => `## ${label}\n${body}`).join('\n\n');
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
export function buildEmptyResponseNudge(attempt, { reasoningLength = 0 } = {}) {
    const n = Number(attempt);
    if (!Number.isFinite(n) || n < 2) return '';
    const thought = Number(reasoningLength) > 0
        ? 'The previous attempt spent its entire response on private reasoning and returned no prose.'
        : 'The previous attempt returned an empty response.';
    return [
        '## Output required',
        thought,
        'Write the scene prose itself in your reply, as visible text. Do not answer with reasoning alone, and do not return an empty message.',
    ].join('\n');
}
