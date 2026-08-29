import { expect, jest, test } from '@jest/globals';
import {
    appendMechanicsContinuation,
    collectMechanicsToolCalls,
    detectMechanicsCapabilities,
    readMechanicsFinishReason,
    runMechanicsTransport,
    textOnlyMechanicsFallback,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-transport.js';

test.each([
    ['GLM', { api: 'openrouter', model: 'z-ai/glm-5.3' }],
    ['Kimi', { api: 'openrouter', model: 'moonshotai/kimi-k2.5' }],
    ['Hermes', { api: 'openrouter', model: 'nousresearch/hermes-4-405b' }],
])('%s is treated as an ordinary chat-completion profile', (_label, profile) => {
    const capabilities = detectMechanicsCapabilities({ profile });
    expect(capabilities.chatCompletion).toBe(true);
    expect(capabilities.model).toBe(profile.model);
    expect(capabilities.evidence).toBe('unknown');
});

test('tool calls normalize across raw and nested chat-completion envelopes', () => {
    expect(collectMechanicsToolCalls({ choices: [{ delta: { tool_calls: [{ id: 'call-1', function: { name: 'goal.attempt', arguments: '{"goalRef":"Escape"}' } }] } }] })).toEqual([
        expect.objectContaining({ id: 'call-1', name: 'goal.attempt', arguments: { goalRef: 'Escape' } }),
    ]);
    expect(collectMechanicsToolCalls({ toolCalls: [{ id: 'call-2', name: 'mechanic.check', parameters: { value: 3 } }] })[0]).toEqual(expect.objectContaining({ id: 'call-2', name: 'mechanic.check', arguments: { value: 3 } }));
});

test('continuation preserves the exact assistant call and structured receipts', () => {
    const next = appendMechanicsContinuation([{ role: 'user', content: 'Try the lock.' }], {
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mechanic.check', arguments: '{"difficulty":4}' } }],
    }, [{ status: 'applied', result: 72 }]);
    expect(next).toEqual([
        { role: 'user', content: 'Try the lock.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mechanic.check', arguments: '{"difficulty":4}' } }] },
        { role: 'tool', tool_call_id: 'call-1', name: 'mechanic.check', content: '{"status":"applied","result":72}' },
    ]);
});

test('the bounded transport executes a tool then continues the same logical request', async () => {
    const requests = [];
    const request = jest.fn(async ({ messages, continuationIndex }) => {
        requests.push(messages);
        return continuationIndex === 0
            ? { tool_calls: [{ id: 'call-1', name: 'mechanic.check', arguments: { difficulty: 4 } }], finish_reason: 'tool_calls' }
            : { content: 'The lock gives way.', finish_reason: 'stop' };
    });
    const execute = jest.fn(async (call) => ({ status: 'applied', callId: call.id, result: 72 }));
    const result = await runMechanicsTransport({ messages: [{ role: 'user', content: 'Try the lock.' }], request, execute, profile: { api: 'openrouter', model: 'z-ai/glm-5.3' } });
    expect(result.status).toBe('complete');
    expect(result.text).toBe('The lock gives way.');
    expect(result.continuationCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[1]).toEqual(expect.arrayContaining([{ role: 'tool', tool_call_id: 'call-1', name: 'mechanic.check', content: '{"status":"applied","callId":"call-1","result":72}' }]));
});

test('text-only fallback removes control fences and suppresses control-only JSON', () => {
    expect(textOnlyMechanicsFallback('Visible prose.\n```state\n{"requests":[]}\n```')).toBe('Visible prose.');
    expect(textOnlyMechanicsFallback('{"protocol":"remodel-mechanics/1","requests":[]}')).toBe('');
    expect(textOnlyMechanicsFallback('A character says {hello} aloud.')).toBe('A character says {hello} aloud.');
});

test('finish reason supports both native and OpenAI-shaped responses', () => {
    expect(readMechanicsFinishReason({ finishReason: 'tool_calls' })).toBe('tool_calls');
    expect(readMechanicsFinishReason({ choices: [{ finish_reason: 'stop' }] })).toBe('stop');
});

