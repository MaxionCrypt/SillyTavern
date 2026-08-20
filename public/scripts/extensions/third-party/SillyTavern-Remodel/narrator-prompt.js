import { listSceneFacts, listCharStates, listEvents, getBeat } from './archivist-store.js';
import { canStreamStory } from './story-stream.js';

// The Narrator's grounding window: the most recent chat lines, newest last,
// bounded so the prompt stays affordable. Long-range memory is the archivist's
// job, not raw history — so this is a window, not the whole log.
export const NARRATOR_HISTORY_BUDGET = 8000;        // characters (~2000 tokens)
export const NARRATOR_HISTORY_MAX_MESSAGES = 40;

// The Narrator is framed as a camera to make append-only intuitive: it can
// only move forward, so it never restates what is already on the page.
export const CAMERA_CONSTRAINT = 'You are a camera. You can only move forward. You see the current scene, you hear the director\'s instruction, and you write what happens next. You never cut away, never rewind, and never restate what is already on the page.';

// The anti-rewriting instruction injected with every directed turn. The
// Narrator generates natively and therefore sees the real chat history, so
// append-only is enforced by instruction + the "already happened" ledger, not
// by starving it of context.
export const APPEND_ONLY_DIRECTIVE = 'Continue the scene forward from the most recent message. Everything listed under "What has happened" is already written on the page — never restate, rewrite, summarise, or replay it. Advance the story: write only what happens next. Output only the story prose itself: never restate, repeat, quote, or acknowledge these notes, your instructions, or your role — begin directly with the narration.';

/**
 * Assemble the direction injected into the native Narrator prompt (the roleplay
 * recipe's Director's Notes slot): the append-only directive first, then the
 * archivist's structured state, then any Director direction. The directive is
 * always present, even when there is no state yet.
 *
 * @param {{archivistState?: string, directorDirection?: string}} input
 * @returns {string}
 */
export function buildDirectionInjection({ archivistState = '', directorDirection = '' } = {}) {
    return [APPEND_ONLY_DIRECTIVE, archivistState, directorDirection]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join('\n\n');
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
 * Build the Narrator's message array. Order: a single system message (card +
 * persona + camera constraint), then world info, archivist state, and the
 * framed Director reasoning as system context, then the voice window as the
 * only prior prose. The full chat history is deliberately absent.
 */
export function compileNarratorPrompt(input = {}) {
    const { card = '', persona = '', worldInfo = '', archivistSections = '', reasoning = '', recentHistory = [] } = input;
    const systemParts = [card, persona, CAMERA_CONSTRAINT].filter((p) => String(p || '').trim());
    const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
    if (String(worldInfo || '').trim()) messages.push({ role: 'system', content: worldInfo });
    if (String(archivistSections || '').trim()) messages.push({ role: 'system', content: archivistSections });
    if (String(reasoning || '').trim()) messages.push({ role: 'system', content: reasoning });
    for (const line of Array.isArray(recentHistory) ? recentHistory : []) {
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
