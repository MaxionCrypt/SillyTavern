import { getContext } from '../../../st-context.js';
import { extractProse, hasPromptContent } from './story-prose-extract.js';
import { canStreamStory, streamStoryProse } from './story-stream.js';

// Prose generation with a diagnosable failure surface.
//
// Story generation used to call generateRaw() directly, which hands back only a
// cleaned string. When that came back empty there was no way to tell which of
// four very different things had gone wrong:
//
//   1. our prompt compiled to nothing and no request was ever sent;
//   2. SillyTavern's own backend rejected the request — the provider never sees
//      it, so its logs stay empty and look innocent;
//   3. the model replied, but the reply carried no prose (reasoning-only,
//      tool-call-only, or a shape core's reader mishandles);
//   4. the model genuinely returned an empty completion.
//
// All four surfaced as "the model returned nothing", which sends you looking in
// the wrong place. This calls generateRawData() — the raw response object —
// extracts from it defensively, and reports which of the four happened.

/** Carries a `stage` so callers can report the real failure. */
export class StoryGenerationError extends Error {
    constructor(stage, message, detail = null) {
        super(message);
        this.name = 'StoryGenerationError';
        this.stage = stage;
        this.detail = detail;
    }
}

/**
 * @param {object[]|string} prompt compiled messages, or a plain string
 * @returns {Promise<{ text: string, raw: any, source: string }>}
 */
export async function generateProse({ prompt, responseLength = null, instructOverride = false, systemPrompt = '', onStream = null, signal = null } = {}) {
    // Stage 1 — never let an empty prompt reach the API layer, where it
    // surfaces as a connection error and sends you hunting the wrong bug.
    // A system prompt alone is enough to have something to send.
    if (!hasPromptContent(prompt) && !String(systemPrompt || '').trim()) {
        throw new StoryGenerationError(
            'empty-prompt',
            'The story prompt came out empty, so nothing was sent — no request reached your API. Check that the Story prompt recipe for this API type has at least one enabled block with content.',
        );
    }

    // Stage 2 — stream when the caller wants live text and the connection can
    // actually do it. Everything else falls through to the one-shot path below,
    // unchanged, so Text Completion and non-streaming providers are untouched.
    if (typeof onStream === 'function' && canStreamStory() && !systemPrompt) {
        try {
            const streamed = await streamStoryProse({ prompt, onChunk: onStream, signal });
            if (streamed.text) {
                return { text: streamed.text, raw: null, source: streamed.streamed ? 'stream' : 'stream-fallback', reasoning: streamed.reasoning };
            }
            // An empty stream is the same failure as an empty one-shot reply,
            // so it gets the same diagnosis rather than a bespoke message.
            throw new StoryGenerationError('no-prose', describeEmptyResponse({ reasoningOnly: Boolean(streamed.reasoning), shape: 'streamed reply' }, null));
        } catch (error) {
            if (error instanceof StoryGenerationError || /cancel|abort|stopped/i.test(String(error?.message || error))) {
                throw error;
            }
            // A transport that fails mid-stream should not cost the user their
            // request: fall through and try the ordinary one-shot path.
            console.warn('Remodel Story: streaming failed, falling back to a single request', error);
        }
    }

    const context = getContext();
    let raw;
    try {
        raw = await context.generateRawData({ prompt, responseLength, instructOverride, systemPrompt });
    } catch (error) {
        const message = String(error?.message || error);
        // A user-pressed Stop arrives here as an abort; let the caller ignore it.
        if (/cancel|abort|stopped/i.test(message)) {
            throw error;
        }
        throw new StoryGenerationError('request', describeRequestFailure(message), message);
    }

    const extracted = extractProse(raw, context.extractMessageFromData);
    if (extracted.text) {
        return { text: extracted.text, raw, source: extracted.source };
    }
    throw new StoryGenerationError('no-prose', describeEmptyResponse(extracted, raw), extracted.shape);
}

function describeRequestFailure(message) {
    if (/kudos/i.test(message)) {
        return 'Not enough Horde kudos for a request this size. Try a shorter response length or another backend.';
    }
    if (/401|403|unauthor|api key|invalid.*key/i.test(message)) {
        return 'The backend rejected the credentials. Check the API key for the selected connection.';
    }
    if (/404|not found|no such model|unknown model/i.test(message)) {
        return 'The backend rejected the request — commonly a model name that is not available on this connection.';
    }
    if (/fetch|network|econn|timeout|failed to fetch/i.test(message)) {
        return 'Could not reach the backend, so the model never saw anything. Check the server URL and that SillyTavern can reach it.';
    }
    return `The request failed before any prose came back: ${message}`;
}

function describeEmptyResponse(extracted, raw) {
    if (extracted.reasoningOnly) {
        // Reasoning tokens are spent from the same budget as the answer, so the
        // usual cause is a response length too small for the model to think AND
        // write. Point at the lever that actually moves rather than at
        // "reasoning effort", which often cannot get under a small cap.
        return 'The model used its whole token budget reasoning and never reached the prose. Raise Response Length in your API settings (reasoning is paid for out of the same budget as the answer) — a thinking model usually needs well over 1000. Turning reasoning off for this connection also works.';
    }
    if (!raw || (typeof raw === 'object' && !Object.keys(raw).length)) {
        return 'SillyTavern returned an empty response. That usually means the request failed at SillyTavern\'s own backend rather than at the model — which is why your provider shows no request at all.';
    }
    return `The reply contained no prose. What came back — ${extracted.shape}`;
}
