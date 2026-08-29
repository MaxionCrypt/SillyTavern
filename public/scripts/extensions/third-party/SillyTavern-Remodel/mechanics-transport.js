/**
 * Provider-neutral transport boundary for resumable mechanics.
 *
 * This module deliberately knows nothing about Goals, Variables, or the live
 * Scene. It only preserves the conversational protocol around a possible
 * tool call. A later gateway may provide the `execute` callback; this stage
 * never mutates Timeline state itself.
 */
export const MECHANICS_TRANSPORT_PROTOCOL = 'remodel/mechanics-transport/1';
export const DEFAULT_MECHANICS_CONTINUATIONS = 2;

/** Normalize one provider tool call without trusting provider-specific shape. */
export function normalizeMechanicsToolCall(value, index = 0) {
    const source = value?.function && typeof value.function === 'object'
        ? { ...value, ...value.function }
        : value;
    const id = String(source?.id || source?.callId || `tool-${index + 1}`).trim();
    const name = String(source?.name || source?.function?.name || '').trim();
    const rawArguments = source?.arguments ?? source?.parameters ?? source?.function?.arguments ?? {};
    let argumentsValue = rawArguments;
    let parseError = '';
    if (typeof rawArguments === 'string') {
        try { argumentsValue = JSON.parse(rawArguments); }
        catch (error) { argumentsValue = {}; parseError = String(error?.message || 'invalid JSON arguments'); }
    }
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
        argumentsValue = {};
        parseError ||= 'tool arguments must be an object';
    }
    return Object.freeze({
        id,
        name,
        arguments: structuredClone(argumentsValue),
        ...(parseError ? { parseError } : {}),
    });
}

/**
 * Extract tool calls from raw responses or cumulative stream chunks. No model
 * names are inspected: the adapter accepts whichever chat-completion shape a
 * provider supplies and otherwise returns an empty list.
 */
export function collectMechanicsToolCalls(payload) {
    const candidates = [
        ...(Array.isArray(payload?.toolCalls) ? payload.toolCalls : []),
        ...(Array.isArray(payload?.tool_calls) ? payload.tool_calls : []),
        ...(Array.isArray(payload?.state?.toolCalls) ? payload.state.toolCalls : []),
        ...(Array.isArray(payload?.choices?.[0]?.message?.tool_calls) ? payload.choices[0].message.tool_calls : []),
        ...(Array.isArray(payload?.choices?.[0]?.delta?.tool_calls) ? payload.choices[0].delta.tool_calls : []),
    ];
    const seen = new Set();
    return candidates.map((item, index) => normalizeMechanicsToolCall(item, index))
        .filter((call) => {
            const key = `${call.id}:${call.name}:${JSON.stringify(call.arguments)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return Boolean(call.name || call.parseError);
        });
}

/** Read a provider finish reason without assuming OpenAI's exact envelope. */
export function readMechanicsFinishReason(payload) {
    return String(
        payload?.finishReason
        ?? payload?.finish_reason
        ?? payload?.choices?.[0]?.finish_reason
        ?? payload?.choices?.[0]?.delta?.finish_reason
        ?? '',
    ).trim();
}

/**
 * Capability declaration is explicit and provider-neutral. An unknown source
 * is not treated as unsupported; it simply falls back to text until a call is
 * actually observed or the caller supplies a capability probe.
 */
export function detectMechanicsCapabilities({ profile = {}, sample = null } = {}) {
    const observedCalls = collectMechanicsToolCalls(sample);
    return Object.freeze({
        chatCompletion: String(profile?.mode || 'cc').toLowerCase() === 'cc',
        toolCalls: profile?.supportsToolCalls === true || observedCalls.length > 0,
        source: String(profile?.api || profile?.source || '').trim(),
        model: String(profile?.model || '').trim(),
        evidence: observedCalls.length ? 'observed' : profile?.supportsToolCalls === true ? 'declared' : 'unknown',
    });
}

/** Add the assistant tool call and its receipts to the next provider request. */
export function appendMechanicsContinuation(messages, assistant, receipts = []) {
    const next = structuredClone(Array.isArray(messages) ? messages : []);
    const calls = collectMechanicsToolCalls(assistant);
    if (!calls.length) return next;
    next.push({
        role: 'assistant',
        ...(typeof assistant?.text === 'string' && assistant.text ? { content: assistant.text } : { content: null }),
        tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
    });
    for (const [index, call] of calls.entries()) {
        const receipt = receipts[index];
        next.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: typeof receipt === 'string' ? receipt : JSON.stringify(receipt ?? { status: 'rejected', reason: 'No receipt returned.' }),
        });
    }
    return next;
}

/** Remove a known control fence, or suppress a response that is only control JSON. */
export function textOnlyMechanicsFallback(value) {
    let text = String(value ?? '');
    text = text.replace(/\s*```(?:state|json)\s*\n?[\s\S]*?```\s*$/i, '').trimEnd();
    if (!text.trim()) return '';
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && (Object.hasOwn(parsed, 'requests') || Object.hasOwn(parsed, 'protocol') || Object.hasOwn(parsed, 'tool_calls'))) return '';
    } catch { /* prose with incidental braces is preserved */ }
    return text;
}

function responseText(response) {
    return String(response?.text ?? response?.content ?? response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.text ?? '');
}

/**
 * Run a bounded continuation loop. `execute` is intentionally supplied by a
 * caller and should be a dry-run in this commit; no state store is imported or
 * changed here. A provider that never exposes tools simply returns its text.
 */
export async function runMechanicsTransport({
    messages = [], request, execute = async () => ({ status: 'rejected', reason: 'No mechanics executor installed.' }),
    profile = {}, maxContinuations = DEFAULT_MECHANICS_CONTINUATIONS, signal = null,
} = {}) {
    if (typeof request !== 'function') throw new TypeError('Mechanics transport requires a request function.');
    const limit = Math.max(0, Number.isFinite(maxContinuations) ? Math.floor(maxContinuations) : DEFAULT_MECHANICS_CONTINUATIONS);
    let nextMessages = structuredClone(Array.isArray(messages) ? messages : []);
    const calls = [];
    const receipts = [];
    let response = null;
    let continuationCount = 0;
    for (;;) {
        if (signal?.aborted) return { protocol: MECHANICS_TRANSPORT_PROTOCOL, status: 'aborted', messages: nextMessages, calls, receipts };
        // eslint-disable-next-line no-await-in-loop
        response = await request({ messages: structuredClone(nextMessages), profile, continuationIndex: continuationCount, signal });
        const detected = collectMechanicsToolCalls(response);
        calls.push(...detected);
        const capabilities = detectMechanicsCapabilities({ profile, sample: response });
        if (!detected.length) {
            return {
                protocol: MECHANICS_TRANSPORT_PROTOCOL,
                status: 'complete',
                text: textOnlyMechanicsFallback(responseText(response)),
                reasoning: String(response?.reasoning || '').trim(),
                finishReason: readMechanicsFinishReason(response),
                capabilities,
                continuationCount,
                messages: nextMessages,
                calls,
                receipts,
            };
        }
        if (continuationCount >= limit) {
            return {
                protocol: MECHANICS_TRANSPORT_PROTOCOL,
                status: 'continuation-limit',
                text: textOnlyMechanicsFallback(responseText(response)),
                finishReason: readMechanicsFinishReason(response),
                capabilities,
                continuationCount,
                messages: nextMessages,
                calls,
                receipts,
            };
        }
        const batchReceipts = [];
        for (const call of detected) {
            // eslint-disable-next-line no-await-in-loop
            batchReceipts.push(await execute(structuredClone(call), { continuationIndex: continuationCount, profile, signal }));
        }
        receipts.push(...batchReceipts);
        nextMessages = appendMechanicsContinuation(nextMessages, response, batchReceipts);
        continuationCount += 1;
    }
}

