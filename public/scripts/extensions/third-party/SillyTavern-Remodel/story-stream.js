import { extractReasoningFromData } from '../../../reasoning.js';
import { getContext } from '../../../st-context.js';
import { getMaxResponseTokens } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { collectMechanicsToolCalls, readMechanicsFinishReason } from './mechanics-transport.js';

// Streaming transport for Remodel's own hidden Chat Completion calls — Story
// prose and the Loom's notebook both go out through here.
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
// `noMultiSwipeTypes` so a settings.n > 1 user cannot get a swipe fan-out from
// one of these calls, and "continue what is here" is what both requests are.

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
 * Stream one compiled chat prompt.
 *
 * Named for what it does rather than for who calls it: Story asks it for prose
 * and Live Direction asks it for the Loom's notebook, and neither shape is
 * this function's business — it carries messages out and text back.
 *
 * @param {object[]} prompt   compiled chat-style messages
 * @param {(update: { text: string, reasoning: string, toolCalls?: object[], finishReason?: string }) => void} onChunk
 *        called with the CUMULATIVE text and reasoning so far — core's
 *        generator accumulates rather than emitting deltas, and passing that
 *        through unchanged keeps the caller from having to reassemble it
 * @param {AbortSignal} [signal]
 * @param {string} [profileId] optional Connection Manager route
 * @returns {Promise<{ text: string, reasoning: string, streamed: boolean, toolCalls?: object[], finishReason?: string }>}
 *          `streamed: false` means the provider answered in one piece despite
 *          the request — the caller should treat the text as a final answer.
 */
export async function streamChatPrompt({ prompt, onChunk, signal, profileId, overridePayload = {} } = {}) {
    const route = String(profileId || '').trim();
    if (!route) throw new Error('This generation job has no Connection Profile assigned.');
    const routedPrompt = ConnectionManagerRequestService.constructPrompt(prompt, route);
    const response = await ConnectionManagerRequestService.sendRequest(
        route,
        routedPrompt,
        getMaxResponseTokens(),
        { stream: true, signal, extractData: true, includePreset: true, includeInstruct: true },
        overridePayload,
    );

    // A provider that ignores `stream` (or a source core refuses to stream, such
    // as o1) returns the plain response object instead of a generator.
    if (typeof response !== 'function') {
        return {
            text: readWholeResponse(response), reasoning: readWholeReasoning(response), streamed: false,
            toolCalls: collectMechanicsToolCalls(response), finishReason: readMechanicsFinishReason(response),
        };
    }

    let text = '';
    let reasoning = '';
    let toolCalls = [];
    let finishReason = '';
    for await (const chunk of response()) {
        if (signal?.aborted) {
            break;
        }
        text = String(chunk?.text ?? text);
        reasoning = String(chunk?.state?.reasoning ?? reasoning);
        const detectedCalls = collectMechanicsToolCalls(chunk);
        if (detectedCalls.length) toolCalls = detectedCalls;
        finishReason = readMechanicsFinishReason(chunk) || finishReason;
        onChunk?.({ text, reasoning, toolCalls, finishReason });
    }
    return { text: text.trim(), reasoning: reasoning.trim(), streamed: true, toolCalls, finishReason };
}

/**
 * Reasoning off a non-streamed reply.
 *
 * A streaming reply carries reasoning on the generator's `state`; a one-piece
 * reply carries it on the response object, in a different place for every
 * provider (`choices[0].message.reasoning_content`, `.reasoning`, Claude's
 * `thinking` content parts, Gemini's thought parts…). Core already knows all
 * of them, so ask core rather than re-deriving the list here and drifting from
 * it.
 *
 * WHY THIS EXISTS AT ALL: the deleted `withCapturedResponse` fetch patch read
 * reasoning off the wire regardless of streaming. Returning `reasoning: ''`
 * here would have made the Loom's reasoning permanently blank for every
 * user with SillyTavern's streaming toggle off, plus o1 and Workers AI JSON
 * mode — a capability regression disguised as a neutral trade, since the text
 * still arrives and nothing looks broken.
 *
 * `ignoreShowThoughts`: this feeds Remodel's own surfaces, so it must not
 * depend on SillyTavern's native "show thoughts" display toggle.
 */
function readWholeReasoning(data) {
    try {
        return String(extractReasoningFromData(data, { mainApi: 'openai', ignoreShowThoughts: true }) || '').trim();
    } catch {
        return '';
    }
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
