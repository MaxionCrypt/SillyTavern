import { sendOpenAIRequest } from '../../../openai.js';
import { getContext } from '../../../st-context.js';

// Streaming transport for Story generation.
//
// WHY THIS BYPASSES generateRaw: SillyTavern decides streaming in
// `createGenerationParameters` (openai.js) with
//
//     const stream = settings.stream_openai && type !== 'quiet' && …
//
// and every generateRaw/generateRawData call goes out as type 'quiet'. So the
// supported raw path is structurally incapable of streaming — it is a rule, not
// an oversight. `sendOpenAIRequest` is exported, and when it streams it returns
// an async generator whose `state.reasoning` accumulates alongside the text,
// which is also the only way to show reasoning as it arrives.
//
// We ask for type 'continue': it streams (not 'quiet'), it is in core's
// `noMultiSwipeTypes` so a settings.n > 1 user cannot get a swipe fan-out from a
// story call, and "continue the manuscript" is what a Story request actually is.

/** The type handed to core. See the note above for why it is not 'quiet'. */
const STREAM_REQUEST_TYPE = 'continue';

/**
 * Whether a Story request can stream right now.
 *
 * Chat Completion only — Text Completion has an entirely separate transport —
 * and only when the user has SillyTavern's own streaming toggle on, which
 * doubles as the off switch if a provider misbehaves.
 */
export function canStreamStory() {
    try {
        const context = getContext();
        return context.mainApi === 'openai' && Boolean(context.chatCompletionSettings?.stream_openai);
    } catch {
        return false;
    }
}

/**
 * Stream one Story generation.
 *
 * @param {object[]} prompt   compiled chat-style messages
 * @param {(update: { text: string, reasoning: string }) => void} onChunk
 *        called with the CUMULATIVE text and reasoning so far — core's
 *        generator accumulates rather than emitting deltas, and passing that
 *        through unchanged keeps the caller from having to reassemble it
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ text: string, reasoning: string, streamed: boolean }>}
 *          `streamed: false` means the provider answered in one piece despite
 *          the request — the caller should treat the text as a final answer.
 */
export async function streamStoryProse({ prompt, onChunk, signal } = {}) {
    const response = await sendOpenAIRequest(STREAM_REQUEST_TYPE, prompt, signal);

    // A provider that ignores `stream` (or a source core refuses to stream, such
    // as o1) returns the plain response object instead of a generator.
    if (typeof response !== 'function') {
        return { text: readWholeResponse(response), reasoning: '', streamed: false };
    }

    let text = '';
    let reasoning = '';
    for await (const chunk of response()) {
        if (signal?.aborted) {
            break;
        }
        text = String(chunk?.text ?? text);
        reasoning = String(chunk?.state?.reasoning ?? reasoning);
        onChunk?.({ text, reasoning });
    }
    return { text: text.trim(), reasoning: reasoning.trim(), streamed: true };
}

/** Best-effort read of a non-streamed reply, mirroring core's own shapes. */
function readWholeResponse(data) {
    if (typeof data === 'string') {
        return data.trim();
    }
    const parts = [
        data?.choices?.[0]?.message?.content,
        data?.choices?.[0]?.text,
        Array.isArray(data?.content)
            ? data.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n\n')
            : '',
        data?.text,
    ];
    return String(parts.find((value) => typeof value === 'string' && value.trim()) || '').trim();
}
