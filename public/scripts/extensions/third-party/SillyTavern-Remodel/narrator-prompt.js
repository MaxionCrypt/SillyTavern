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
