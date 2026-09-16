import { jest } from '@jest/globals';
import { ConnectionManagerRequestService } from './util/connection-request-stub.js';
import {
    captureNativeNarratorPrompt,
    createNativeNarratorTransport,
    prepareNativeNarratorPrompt,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/native-narrator-runtime.js';
import { tagNextAction } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-history-limit.js';

async function collect(iterator) {
    const frames = [];
    for await (const frame of iterator) frames.push(frame);
    return frames;
}

test('native transport keeps the strict profile route and emits the completed response once', async () => {
    const send = jest.fn(async ({ profileId, onChunk }) => {
        expect(profileId).toBe('profile-narrator');
        onChunk({ text: 'The door', reasoning: '' });
        onChunk({ text: 'The door opened.', reasoning: '' });
        return { text: 'The door opened.', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });
    const frames = await collect(transport.stream({
        prompt: { messages: [{ role: 'user', content: 'Continue.' }] },
        route: { profileId: 'profile-narrator' },
    }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].prompt).toEqual([{ role: 'user', content: 'Continue.' }]);
    expect(frames).toEqual([
        { type: 'snapshot', text: 'The door opened.', reasoning: '' },
        { type: 'complete', finishReason: 'stop', truncated: false },
    ]);
});

test('native transport turns a non-streamed reply into one visible snapshot', async () => {
    const send = jest.fn(async () => ({ text: 'One complete reply.', reasoning: '', streamed: false }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });
    const frames = await collect(transport.stream({
        prompt: { messages: [{ role: 'user', content: 'Continue.' }] },
        route: { profileId: 'profile-narrator' },
    }));

    expect(frames).toEqual([
        { type: 'snapshot', text: 'One complete reply.', reasoning: '' },
        { type: 'complete', finishReason: 'stop', truncated: false },
    ]);
});

test('autonomous continuation does not append a hidden request instruction', () => {
    const native = [{ role: 'system', content: 'Policy' }, { role: 'assistant', content: 'Accepted prose.' }];
    const autonomous = prepareNativeNarratorPrompt(native, { autonomousContinue: true });
    const playerTurn = prepareNativeNarratorPrompt(native, { autonomousContinue: false });

    expect(native).toHaveLength(2);
    expect(playerTurn).toEqual(native);
    expect(autonomous).toEqual(native);
});

test('native transport keeps tagged reasoning out of visible prose', async () => {
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: '<think>I need to plan this response.</think>', reasoning: '' });
        return { text: '<think>I need to plan this response.</think>', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });

    const frames = await collect(transport.stream({
        prompt: { messages: [{ role: 'user', content: 'Continue.' }] },
        route: { profileId: 'profile-narrator' },
    }));
    expect(frames).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'snapshot', text: '', reasoning: 'I need to plan this response.' }),
        expect.objectContaining({ type: 'complete' }),
    ]));
});

test('reasoning-only recovery disables reasoning only on its retried request', async () => {
    const originalGetProfile = ConnectionManagerRequestService.getProfile;
    const originalValidateProfile = ConnectionManagerRequestService.validateProfile;
    ConnectionManagerRequestService.getProfile = jest.fn(() => ({ model: 'deepseek-chat' }));
    ConnectionManagerRequestService.validateProfile = jest.fn(() => ({ selected: 'openai', source: 'openrouter' }));
    try {
        const send = jest.fn(async () => ({ text: 'Recovered prose.', reasoning: '', streamed: false }));
        const transport = createNativeNarratorTransport({ pacing: 'instant', send });
        await collect(transport.stream({
            prompt: { messages: [{ role: 'user', content: 'Continue.' }] },
            route: { profileId: 'profile-deepseek' },
            recovery: { kind: 'reasoning-only', requestReasoning: false },
        }));

        expect(send.mock.calls[0][0].overridePayload).toEqual(expect.objectContaining({ include_reasoning: false }));
    } finally {
        ConnectionManagerRequestService.getProfile = originalGetProfile;
        ConnectionManagerRequestService.validateProfile = originalValidateProfile;
    }
});

test('prompt capture uses native dry-run assembly and restores group ordering', async () => {
    const listeners = new Map();
    const eventSource = {
        once(type, handler) { listeners.set(type, handler); },
        removeListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    };
    const group = { id: 'group-1', members: ['other.png', 'narrator.png'], generation_mode: 0 };
    const prompt = [{ role: 'system', content: 'Native prompt' }, { role: 'user', content: 'Continue.' }];
    const context = {
        characterId: 0,
        name2: 'Other',
        groupId: 'group-1',
        groups: [group],
        characters: [{ avatar: 'other.png' }, { avatar: 'narrator.png' }],
        eventSource,
        eventTypes: {
            GENERATE_AFTER_DATA: 'after',
            CHAT_COMPLETION_PROMPT_READY: 'ready',
        },
        async generate(type) {
            expect(type).toBe('continue');
            expect(group.members[0]).toBe('narrator.png');
            listeners.get('ready')?.({ chat: [] });
            listeners.get('after')?.({ prompt });
        },
    };

    const captured = await captureNativeNarratorPrompt({
        context,
        performer: { characterId: 1, name: 'Narrator' },
        generationType: 'continue',
    });

    expect(captured).toEqual(prompt);
    expect(captured).not.toBe(prompt);
    expect(group.members).toEqual(['other.png', 'narrator.png']);
    expect(group.generation_mode).toBe(0);
    expect(listeners.size).toBe(0);
});

test('prompt capture removes the separately routed newest player action before limiting history', async () => {
    const listeners = new Map();
    const eventSource = {
        once(type, handler) { listeners.set(type, handler); },
        removeListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    };
    const boundary = { start: '[[RM:CHAT_HISTORY_START:2]]', end: '[[RM:CHAT_HISTORY_END]]' };
    const context = {
        characterId: 0,
        name2: 'Narrator',
        eventSource,
        eventTypes: { GENERATE_AFTER_DATA: 'after', CHAT_COMPLETION_PROMPT_READY: 'ready' },
        async generate() {
            const chat = [
                { role: 'system', content: boundary.start },
                { role: 'user', content: 'Earlier player action.' },
                { role: 'assistant', content: 'Earlier narrator response.' },
                { role: 'user', content: 'Newest player action.' },
                { role: 'system', content: boundary.end },
                { role: 'user', content: tagNextAction('Newest player action.') },
            ];
            listeners.get('ready')?.({ chat });
            listeners.get('after')?.({ prompt: chat });
        },
    };

    const captured = await captureNativeNarratorPrompt({
        context,
        performer: { characterId: 0, name: 'Narrator' },
        nextAction: 'Newest player action.',
    });

    expect(captured.map((message) => message.content)).toEqual([
        'Earlier player action.', 'Earlier narrator response.', 'Newest player action.',
    ]);
});

test('paced reveal subdivides the completed response rather than provider chunks', async () => {
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: 'Open.', reasoning: '' });
        onChunk({ text: 'Open. She crossed the room.', reasoning: '' });
        return { text: 'Open. She crossed the room.', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'fast', send });
    const frames = await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    const snapshots = frames.filter((frame) => frame.type === 'snapshot').map((frame) => frame.text);

    expect(snapshots[0].length).toBeLessThan('Open. She crossed the room.'.length);
    expect(snapshots[0]).not.toBe('Open.');
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots.at(-1)).toBe('Open. She crossed the room.');
    for (let i = 1; i < snapshots.length; i += 1) {
        expect(snapshots[i].startsWith(snapshots[i - 1])).toBe(true);
    }
});

test('instant drops only the completed response, adding no intermediate frames', async () => {
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: 'Open.', reasoning: '' });
        onChunk({ text: 'Open. She crossed the room.', reasoning: '' });
        return { text: 'Open. She crossed the room.', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });
    const frames = await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));

    expect(frames.filter((frame) => frame.type === 'snapshot').map((frame) => frame.text))
        .toEqual(['Open. She crossed the room.']);
});

test('switching Pacing mid-turn takes effect on prose still being revealed', async () => {
    let pacing = 'slow';
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: 'A.', reasoning: '' });
        onChunk({ text: 'A. ' + 'x'.repeat(60), reasoning: '' });
        return { text: 'A. ' + 'x'.repeat(60), reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ getPacing: () => pacing, send });
    const frames = [];
    for await (const frame of transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } })) {
        frames.push(frame);
        // Flip to instant as soon as the paced reveal starts; the rest of the
        // text must arrive at once rather than finishing at the slow rate.
        if (frames.filter((f) => f.type === 'snapshot').length === 2) pacing = 'instant';
    }
    const snapshots = frames.filter((frame) => frame.type === 'snapshot');
    expect(snapshots.length).toBeLessThan(10);
    expect(snapshots.at(-1).text).toBe('A. ' + 'x'.repeat(60));
});

test('paced reveal starts from a prefix of the completed response', async () => {
    const prose = 'x'.repeat(60);
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: prose, reasoning: '' });
        return { text: prose, reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'fast', send });
    const started = Date.now();
    const iterator = transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } });
    const first = await iterator.next();
    expect(first.value.text.length).toBeGreaterThan(0);
    expect(first.value.text.length).toBeLessThan(prose.length);
    expect(Date.now() - started).toBeLessThan(200);
    await collect(iterator);
});

test('paced reveal does not turn a long completed response into catch-up bursts', async () => {
    const prose = 'x'.repeat(2400);
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: prose, reasoning: '' });
        return { text: prose, reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'fast', send });
    const iterator = transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } });
    const first = await iterator.next();

    // Fast reveals at 120 cps on a ~60fps cadence: two characters per paint,
    // not the 60-character burst the former 40-tick catch-up limiter created.
    expect(first.value).toMatchObject({ type: 'snapshot', text: 'xx' });
    await iterator.return();
});

test('transport withholds every provider burst until the Narrator request settles', async () => {
    let release;
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: 'A small', reasoning: '' });
        await new Promise((resolve) => { release = resolve; });
        onChunk({ text: 'A small buffer makes the visible reveal smooth and steady.', reasoning: '' });
        return { text: 'A small buffer makes the visible reveal smooth and steady.', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({
        pacing: 'instant',
        send,
    });
    const iterator = transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } });
    let yielded = false;
    const next = iterator.next().then((value) => {
        yielded = true;
        return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(yielded).toBe(false);
    release();
    const first = await next;
    const frames = [first.value, ...(await collect(iterator))];
    const snapshots = frames.filter((frame) => frame.type === 'snapshot').map((frame) => frame.text);

    expect(snapshots).toEqual(['A small buffer makes the visible reveal smooth and steady.']);
});

// --- Commit 11-12 reconnection: resumable mechanics inside one logical turn ---

const toolCall = (name, args) => ({ id: 'call-1', name, arguments: args });

test('with no mechanics dependency the provider is called exactly once', async () => {
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: 'She reaches for the latch.', reasoning: '' });
        return { text: 'She reaches for the latch.', reasoning: '', streamed: true, toolCalls: [toolCall('goal.attempt', {})] };
    });
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });
    await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    expect(send).toHaveBeenCalledTimes(1);
});

test('a tool call pauses the turn, resolves locally, and resumes the same message', async () => {
    let call = 0;
    const send = jest.fn(async ({ onChunk }) => {
        call += 1;
        if (call === 1) {
            onChunk({ text: 'She reaches for the latch.', reasoning: '' });
            return { text: 'She reaches for the latch.', reasoning: '', streamed: true, toolCalls: [toolCall('goal.attempt', { target: 'Reach the gate' })] };
        }
        onChunk({ text: ' The lock gives.', reasoning: '' });
        return { text: ' The lock gives.', reasoning: '', streamed: true };
    });
    const execute = jest.fn(async () => ({ status: 'applied', outcome: 'hit' }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send, mechanics: { execute } });
    const frames = await collect(transport.stream({ prompt: { messages: [{ role: 'user', content: 'go' }] }, route: { profileId: 'p' } }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ name: 'goal.attempt', arguments: { target: 'Reach the gate' } });

    // One visible message: the continuation extends the prefix, never restarts it.
    const snapshots = frames.filter((frame) => frame.type === 'snapshot').map((frame) => frame.text);
    expect(snapshots.at(-1)).toBe('She reaches for the latch. The lock gives.');
    for (let i = 1; i < snapshots.length; i += 1) expect(snapshots[i].startsWith(snapshots[i - 1])).toBe(true);
});

test('the receipt is handed back as a tool message on the continuation request', async () => {
    let call = 0;
    const send = jest.fn(async () => {
        call += 1;
        return call === 1
            ? { text: 'A', reasoning: '', streamed: true, toolCalls: [toolCall('goal.attempt', { target: 'g' })] }
            : { text: 'B', reasoning: '', streamed: true };
    });
    const execute = jest.fn(async () => ({ status: 'applied', outcome: 'miss', roll: { roll: 91 } }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send, mechanics: { execute } });
    await collect(transport.stream({ prompt: { messages: [{ role: 'user', content: 'go' }] }, route: { profileId: 'p' } }));

    const second = send.mock.calls[1][0].prompt;
    expect(second.at(-1)).toMatchObject({ role: 'tool', name: 'goal.attempt' });
    expect(JSON.parse(second.at(-1).content)).toMatchObject({ status: 'applied', outcome: 'miss' });
});

test('continuations are bounded so a looping model cannot spend the turn', async () => {
    const send = jest.fn(async () => ({ text: 'x', reasoning: '', streamed: true, toolCalls: [toolCall('goal.attempt', {})] }));
    const execute = jest.fn(async () => ({ status: 'applied' }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send, mechanics: { execute }, maxContinuations: 2 });
    await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    expect(send).toHaveBeenCalledTimes(3); // initial + 2 continuations
});

test('a refused mechanic still continues the turn rather than failing it', async () => {
    let call = 0;
    const send = jest.fn(async () => {
        call += 1;
        return call === 1
            ? { text: 'A', reasoning: '', streamed: true, toolCalls: [toolCall('goal.attempt', { target: 'not-hers' })] }
            : { text: 'B', reasoning: '', streamed: true };
    });
    const execute = jest.fn(async () => ({ status: 'refused', reason: 'piper does not hold it' }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send, mechanics: { execute } });
    const frames = await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(JSON.parse(send.mock.calls[1][0].prompt.at(-1).content)).toMatchObject({ status: 'refused' });
});

test('advertised tools reach the provider payload', async () => {
    const send = jest.fn(async () => ({ text: 'x', reasoning: '', streamed: true }));
    const tools = [{ type: 'function', function: { name: 'goal.attempt' } }];
    const transport = createNativeNarratorTransport({ pacing: 'instant', send, tools });
    await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    expect(send.mock.calls[0][0].overridePayload).toMatchObject({ tools, tool_choice: 'auto' });
});

test('no tools advertised means no tool field is sent at all', async () => {
    const send = jest.fn(async () => ({ text: 'x', reasoning: '', streamed: true }));
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });
    await collect(transport.stream({ prompt: { messages: [] }, route: { profileId: 'p' } }));
    const payload = send.mock.calls[0][0].overridePayload;
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
});
