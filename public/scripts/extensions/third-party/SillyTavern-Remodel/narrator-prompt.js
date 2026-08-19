import { listSceneFacts, listCharStates, listEvents, getBeat } from './archivist-store.js';
import { canStreamStory } from './story-stream.js';

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

/**
 * Build the Narrator's message array. Order: a single system message (card +
 * persona + camera constraint), then world info, archivist state, and the
 * framed Director reasoning as system context, then the voice window as the
 * only prior prose. The full chat history is deliberately absent.
 */
export function compileNarratorPrompt(input = {}) {
    const { card = '', persona = '', worldInfo = '', archivistSections = '', reasoning = '', voiceWindow = [] } = input;
    const systemParts = [card, persona, CAMERA_CONSTRAINT].filter((p) => String(p || '').trim());
    const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
    if (String(worldInfo || '').trim()) messages.push({ role: 'system', content: worldInfo });
    if (String(archivistSections || '').trim()) messages.push({ role: 'system', content: archivistSections });
    if (String(reasoning || '').trim()) messages.push({ role: 'system', content: reasoning });
    for (const line of Array.isArray(voiceWindow) ? voiceWindow : []) {
        if (line && String(line.content || '').trim()) messages.push({ role: line.role === 'user' ? 'user' : 'assistant', content: line.content });
    }
    return messages;
}

/**
 * Why the directed Narrator cannot run right now, or '' if it can. The custom
 * path streams via streamChatPrompt, which only works on Chat Completion with
 * streaming enabled; there is no native fallback.
 */
export function narratorStreamBlock() {
    if (canStreamStory()) return '';
    return 'The directed Narrator needs a Chat Completion backend with streaming enabled. Switch to a Chat Completion API and turn on streaming to use it.';
}
