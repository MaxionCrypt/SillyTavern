import { listSceneFacts, listCharStates, listEvents, getBeat } from './archivist-store.js';

// The Narrator is framed as a camera to make append-only intuitive: it can
// only move forward, so it never restates what is already on the page.
export const CAMERA_CONSTRAINT = 'You are a camera. You can only move forward. You see the current scene, you hear the director\'s instruction, and you write what happens next. You never cut away, never rewind, and never restate what is already on the page.';

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
