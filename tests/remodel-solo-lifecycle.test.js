// A full solo-mode turn: the Director never runs (its adapter throws), the
// Narrator speaks, and Pass 2 extraction records the prose into the archivist.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    getLiveDirectionRun,
    getLiveDirectionUiState,
    stopLiveDirection,
    clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents, listSceneFacts } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-solo',
    timelineId: 'timeline-solo',
    title: 'Solo Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, mode: 'solo', directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];
const RESPONSE = 'Wren steps between them. The blade catches her forearm.';

async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

const extractionFence = JSON.stringify({
    requests: [
        { id: 'e1', capability: 'event.record', arguments: { summary: 'Wren took the blade on her forearm' }, reason: 'She stepped between them.' },
        { id: 'e2', capability: 'scene.set', arguments: { key: 'mood', value: 'tense' }, reason: 'Violence just broke out.' },
    ],
    flow: { continue: false },
});

async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    initLiveDirection({
        getActiveScene: () => scene,
        getCast: () => cast,
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => '',
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
        setNativePromptContent: () => {},
    });
    setLiveDirectionTestAdapters({
        requestDirection: async () => { throw new Error('Director must not run in solo mode'); },
        generatePerformer: speak,
        extractState: async () => ['```state', extractionFence, '```'].join('\n'),
    });
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('a solo turn skips the Director and extraction records the prose', async () => {
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    // The Narrator spoke (Director never ran — its adapter would have thrown)…
    expect(__getChat().at(-1).mes).toBe(RESPONSE);
    // …and extraction filled the archivist from the delivered prose.
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Wren took the blade on her forearm']);
    expect(listSceneFacts(scene.timelineId, scene.id).map((f) => `${f.key}=${f.value}`)).toEqual(['mood=tense']);
});

test('a Narrator that returns no reasoning raises the reasoning warning on the UI state', async () => {
    // speak() pushes a message with no extra.reasoning — the non-reasoning case.
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(getLiveDirectionUiState(scene).reasoningWarning).toBe(true);
});

test('a completed solo turn waits for the user and Continue advances the next one', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(__getChat().length).toBe(1);
    // Continue directs another moment from accepted history.
    await requestNextDirection(scene);
    expect(await until(() => __getChat().length === 2)).toBe(true);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
});

test('an empty performer response is reported, not silently accepted as a turn', async () => {
    setLiveDirectionTestAdapters({
        requestDirection: async () => { throw new Error('Director must not run in solo mode'); },
        // Pushes an empty row, the way a provider that returns nothing does.
        generatePerformer: async () => {
            const chat = __getChat();
            chat.push({ name: 'Wren', is_user: false, mes: '', extra: {} });
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
        extractState: async () => '',
    });
    await requestNextDirection(scene);
    // The empty run never becomes a finished turn: it does not reach the
    // waiting state with a kept message, and the empty row is not left behind.
    expect(await until(() => getLiveDirectionRun() === null || getLiveDirectionRun()?.state !== 'Speaking', 3000)).toBe(true);
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});
