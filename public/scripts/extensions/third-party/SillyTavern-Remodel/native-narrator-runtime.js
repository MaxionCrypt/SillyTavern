import { setCharacterId, setCharacterName } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { normalizeReasoningEffortForModel } from '../../../reasoning-compat.js';
import { describeIncompleteProse } from './generation-budget.js';
import { describeNarratorOutput } from './narrator-output-contract.js';
import { limitBoundedChatHistory } from './prompt-history-limit.js';
import { streamChatPrompt } from './story-stream.js';
import { DEFAULT_MECHANICS_CONTINUATIONS, appendMechanicsContinuation, collectMechanicsToolCalls } from './mechanics-transport.js';

/** Canonical reveal speed in characters per second, matching the legacy Live
 * Direction curve so the four settings feel the way they used to. The previous
 * implementation throttled each whole provider snapshot by 0-75ms, which almost
 * never bound: network chunks rarely arrive closer together than that, so every
 * setting looked identical. */
const PACING_REVEAL_CPS = Object.freeze({ slow: 28, natural: 45, fast: 75, instant: Infinity });
const REVEAL_TICK_MS = 50;
/** A provider can outrun the slowest reveal. Cap how many ticks may be spent
 * draining what is pending so visible prose can never fall unboundedly behind
 * the accepted text. */
const MAX_CATCHUP_TICKS = 40;
const AUTONOMOUS_CONTINUE_REQUEST = 'Continue the scene autonomously from the accepted history. Return only the next new passage of scene prose. Do not repeat, summarize, or explain existing prose, and do not wait for player input.';

/** Add a request-only turn boundary without writing a fake player chat row. */
export function prepareNativeNarratorPrompt(prompt, { autonomousContinue = false } = {}) {
    const messages = structuredClone(Array.isArray(prompt) ? prompt : []);
    if (autonomousContinue) {
        messages.push({ role: 'user', content: AUTONOMOUS_CONTINUE_REQUEST });
    }
    return messages;
}

/** Capture the exact flattened prompt native generation would send. */
export async function captureNativeNarratorPrompt({ context, performer, generationType = 'normal' } = {}) {
    if (!context?.eventSource || typeof context.generate !== 'function') {
        throw new Error('Native Narrator prompt assembly is unavailable.');
    }
    const previousCharacterId = context.characterId;
    const previousCharacterName = context.name2;
    const group = context.groupId
        ? (context.groups || []).find((candidate) => String(candidate.id) === String(context.groupId))
        : null;
    const originalMembers = Array.isArray(group?.members) ? [...group.members] : null;
    const avatar = context.characters?.[performer?.characterId]?.avatar || performer?.ref?.id || '';
    const restoreGroupName = bridgeGroupNarratorName(group, performer?.name || performer?.label || 'Narrator');
    let generateData = null;
    const capture = (data) => { generateData = data; };
    const boundHistory = (eventData) => limitBoundedChatHistory(eventData?.chat);

    context.eventSource.once(context.eventTypes.GENERATE_AFTER_DATA, capture);
    context.eventSource.once(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, boundHistory);
    try {
        if (group && originalMembers && avatar) {
            group.members = [avatar, ...originalMembers.filter((member) => member !== avatar)];
        }
        if (Number.isInteger(performer?.characterId)) setCharacterId(performer.characterId);
        setCharacterName(performer?.name || performer?.label || context.name2 || 'Narrator');
        // Autonomous turns must use core's real Continue assembly. A normal
        // prompt with no new user row ends on the previous assistant message,
        // which several providers answer with an empty/reasoning-only result.
        // Core's Continue path carries its provider-specific continuation
        // prefill and postfix without mutating chat during this dry run.
        const type = generationType === 'continue' ? 'continue' : 'normal';
        await context.generate(type, context.groupId ? { force_chid: performer.characterId } : {}, true);
    } finally {
        context.eventSource.removeListener(context.eventTypes.GENERATE_AFTER_DATA, capture);
        context.eventSource.removeListener(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, boundHistory);
        restoreGroupName();
        if (group && originalMembers) group.members = originalMembers;
        setCharacterId(previousCharacterId);
        setCharacterName(previousCharacterName);
    }

    if (!Array.isArray(generateData?.prompt) || !generateData.prompt.length) {
        throw new Error('SillyTavern did not assemble a Chat Completion prompt for the Narrator.');
    }
    return structuredClone(generateData.prompt);
}

/** Provider/profile transport for narrator-delivery.js's cumulative frames. */
export function createNativeNarratorTransport({
    pacing = 'natural',
    getPacing = null,
    send = streamChatPrompt,
    // Absent by default: with no mechanics dependency the loop below runs
    // exactly once and this transport behaves as it did before the gateway
    // existed, which is what keeps an un-opted-in Scene on the legacy path.
    mechanics = null,
    maxContinuations = DEFAULT_MECHANICS_CONTINUATIONS,
    // Advertised to the provider so the model knows the verbs exist at all.
    // Empty means the recipe advertised none, and no tool field is sent.
    tools = [],
} = {}) {
    // Read per tick, never captured once: switching Pacing mid-turn has to take
    // effect on the prose still being revealed, not only on the next turn.
    const readCps = () => {
        const name = (typeof getPacing === 'function' ? getPacing() : pacing) || pacing;
        return PACING_REVEAL_CPS[name] ?? PACING_REVEAL_CPS.natural;
    };
    return Object.freeze({
        async *stream({ prompt, route, recovery, signal } = {}) {
            const queue = [];
            let wake = null;
            let settled = false;
            let failure = null;
            let final = { text: '', reasoning: '', streamed: false };
            let latestText = '';
            const push = (frame) => {
                const text = String(frame?.text || '');
                if (text) {
                    const malformed = describeNarratorOutput(text);
                    if (malformed.malformed) {
                        throw new Error(malformed.diagnosis);
                    }
                    latestText = text;
                }
                queue.push(frame);
                wake?.();
                wake = null;
            };
            const overridePayload = {
                ...(recovery?.requestReasoning === false ? reasoningDisabledPayload(route?.profileId) : {}),
                ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
            };
            const request = (async () => {
                let messages = Array.isArray(prompt?.messages) ? prompt.messages : prompt;
                // Text already accepted earlier in this SAME logical turn. A
                // mechanics continuation is a second HTTP request but still one
                // visible message, so its snapshots must extend what is on
                // screen rather than restart it.
                let carry = '';
                let continuations = 0;
                for (;;) {
                    // eslint-disable-next-line no-await-in-loop
                    const result = await send({
                        prompt: messages,
                        profileId: route?.profileId,
                        signal,
                        overridePayload,
                        onChunk: ({ text, reasoning }) => push({ type: 'snapshot', text: carry + String(text || ''), reasoning }),
                    });
                    final = result || final;
                    const whole = carry + String(final.text || '');
                    // Streaming transports commonly trim their returned final
                    // value even though the last cumulative snapshot retains a
                    // trailing space. A shorter final value is not a rewrite and
                    // must not be emitted as one. A non-streamed response, or a
                    // genuine final extension, still becomes a snapshot.
                    if (whole && whole !== latestText && (!latestText || whole.startsWith(latestText))) {
                        push({ type: 'snapshot', text: whole, reasoning: final.reasoning });
                    }
                    const calls = mechanics ? collectMechanicsToolCalls(final) : [];
                    if (!calls.length || continuations >= maxContinuations) {
                        final = { ...final, text: whole };
                        return;
                    }
                    // Pause the logical turn, resolve the mechanic locally, and
                    // resume the same message from its authoritative receipt.
                    const receipts = [];
                    for (const call of calls) {
                        // eslint-disable-next-line no-await-in-loop
                        receipts.push(await mechanics.execute(call));
                    }
                    messages = appendMechanicsContinuation(messages, final, receipts);
                    carry = whole;
                    continuations += 1;
                }
            })().catch((error) => {
                failure = error;
            }).finally(() => {
                settled = true;
                wake?.();
                wake = null;
            });

            let previousLength = 0;
            while (!settled || queue.length) {
                if (!queue.length) {
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => { wake = resolve; });
                    continue;
                }
                const frame = queue.shift();
                const text = String(frame.text || '');
                // The opening characters are never delayed: time to first token
                // stays gated by the Narrator alone. Non-snapshot frames and
                // snapshots that do not grow the text pass straight through.
                if (frame.type !== 'snapshot' || !previousLength || text.length <= previousLength) {
                    previousLength = Math.max(previousLength, text.length);
                    yield frame;
                    continue;
                }
                // Reveal the NEW characters at the configured speed rather than
                // throttling the snapshot as a whole. Frames are cumulative, so
                // emitting intermediate slices is what the delivery layer
                // already expects. Reveal pacing never waits for Loom, Archive,
                // saving, or another model.
                while (previousLength < text.length) {
                    const cps = readCps();
                    if (cps === Infinity) break;
                    const pending = text.length - previousLength;
                    const step = Math.max(Math.ceil(cps / (1000 / REVEAL_TICK_MS)), Math.ceil(pending / MAX_CATCHUP_TICKS));
                    const take = Math.min(step, pending);
                    // eslint-disable-next-line no-await-in-loop
                    await abortableDelay(Math.round((take / cps) * 1000), signal);
                    previousLength += take;
                    if (previousLength >= text.length) break;
                    yield { ...frame, text: text.slice(0, previousLength) };
                }
                previousLength = text.length;
                yield frame;
            }
            await request;
            if (failure) throw failure;
            const incomplete = describeIncompleteProse(final.text || '').incomplete;
            yield { type: 'complete', finishReason: incomplete ? 'length' : 'stop', truncated: incomplete };
        },
    });
}

function reasoningDisabledPayload(profileId) {
    try {
        const profile = ConnectionManagerRequestService.getProfile(profileId);
        const selected = ConnectionManagerRequestService.validateProfile(profile);
        if (selected?.selected !== 'openai') return {};
        return {
            reasoning_effort: normalizeReasoningEffortForModel(selected.source, profile?.model, 'none'),
            include_reasoning: false,
        };
    } catch {
        return {};
    }
}

function abortableDelay(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function bridgeGroupNarratorName(group, name) {
    if (!group || !name) return () => {};
    const property = 'generation_mode';
    const descriptor = Object.getOwnPropertyDescriptor(group, property);
    if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return () => {};
    let value = descriptor?.value ?? group[property];
    Object.defineProperty(group, property, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
            setCharacterName(name);
            return value;
        },
        set(next) { value = next; },
    });
    return () => {
        if (descriptor) Object.defineProperty(group, property, { ...descriptor, value });
        else delete group[property];
    };
}
