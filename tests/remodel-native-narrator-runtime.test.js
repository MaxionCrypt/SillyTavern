import { jest } from '@jest/globals';
import { ConnectionManagerRequestService } from './util/connection-request-stub.js';
import {
    captureNativeNarratorPrompt,
    createNativeNarratorTransport,
    prepareNativeNarratorPrompt,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/native-narrator-runtime.js';

async function collect(iterator) {
    const frames = [];
    for await (const frame of iterator) frames.push(frame);
    return frames;
}

test('native transport preserves cumulative provider frames and the strict profile route', async () => {
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
        { type: 'snapshot', text: 'The door', reasoning: '' },
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

test('autonomous continuation adds one request-only turn boundary without mutating the native prompt', () => {
    const native = [{ role: 'system', content: 'Policy' }, { role: 'assistant', content: 'Accepted prose.' }];
    const autonomous = prepareNativeNarratorPrompt(native, { autonomousContinue: true });
    const playerTurn = prepareNativeNarratorPrompt(native, { autonomousContinue: false });

    expect(native).toHaveLength(2);
    expect(playerTurn).toEqual(native);
    expect(autonomous.slice(0, -1)).toEqual(native);
    expect(autonomous.at(-1)).toEqual(expect.objectContaining({
        role: 'user',
        content: expect.stringMatching(/Continue the scene autonomously/),
    }));
});

test('native transport rejects visible reasoning or Loom protocol before accepting it as prose', async () => {
    const send = jest.fn(async ({ onChunk }) => {
        onChunk({ text: '<think>I need to plan this response.</think>', reasoning: '' });
        return { text: '<think>I need to plan this response.</think>', reasoning: '', streamed: true };
    });
    const transport = createNativeNarratorTransport({ pacing: 'instant', send });

    await expect(collect(transport.stream({
        prompt: { messages: [{ role: 'user', content: 'Continue.' }] },
        route: { profileId: 'profile-narrator' },
    }))).rejects.toThrow(/private planning/);
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
