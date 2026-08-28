import { setCharacterId, setCharacterName } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { normalizeReasoningEffortForModel } from '../../../reasoning-compat.js';
import { describeIncompleteProse } from './generation-budget.js';
import { describeNarratorOutput } from './narrator-output-contract.js';
import { limitBoundedChatHistory } from './prompt-history-limit.js';
import { streamChatPrompt } from './story-stream.js';

const PACING_DELAYS = Object.freeze({ slow: 75, natural: 30, fast: 10, instant: 0 });
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
export function createNativeNarratorTransport({ pacing = 'natural', send = streamChatPrompt } = {}) {
    const delayMs = PACING_DELAYS[pacing] ?? PACING_DELAYS.natural;
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
            const overridePayload = recovery?.requestReasoning === false
                ? reasoningDisabledPayload(route?.profileId)
                : {};
            const request = send({
                prompt: Array.isArray(prompt?.messages) ? prompt.messages : prompt,
                profileId: route?.profileId,
                signal,
                overridePayload,
                onChunk: ({ text, reasoning }) => push({ type: 'snapshot', text, reasoning }),
            }).then((result) => {
                final = result || final;
                // Streaming transports commonly trim their returned final
                // value even though the last cumulative snapshot retains a
                // trailing space. A shorter final value is not a rewrite and
                // must not be emitted as one. A non-streamed response, or a
                // genuine final extension, still becomes a snapshot.
                if (final.text && final.text !== latestText && (!latestText || final.text.startsWith(latestText))) {
                    push({ type: 'snapshot', text: final.text, reasoning: final.reasoning });
                }
            }).catch((error) => {
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
                if (delayMs && previousLength && frame.text.length > previousLength) {
                    // Reveal pacing throttles provider snapshots; it never waits
                    // for Loom, Archive, saving, or another model.
                    // eslint-disable-next-line no-await-in-loop
                    await abortableDelay(delayMs, signal);
                }
                previousLength = frame.text.length;
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
