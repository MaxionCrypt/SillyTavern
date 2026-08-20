// Archivist-first end to end: BEFORE the narrator writes, the archivist pass
// reads the user's action + the previous narration, applies its state fence,
// and resolves the mechanics — so the narrator narrates an already-updated state.
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
import { createVariableValue, getVariableValue, updateMechanicsProfile } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-extract',
    timelineId: 'timeline-extract',
    title: 'Extract Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, mode: 'solo', directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];

// The PREVIOUS narration, already on the page when this turn begins — this is
// what the archivist-first pass reads and records.
const PRIOR_NARRATION = 'Wren steps between them. The blade catches her forearm.';
const PRIOR_REASONING = 'Wren is protecting the boy; taking the blade should cost her HP.';
// This turn's narrator output (not archived until the NEXT turn).
const THIS_NARRATION = 'She grits her teeth and keeps her feet.';

async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: THIS_NARRATION, extra: { reasoning: 'She is hurt but standing.' } });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

const archivistFence = JSON.stringify({
    requests: [
        { id: 'e1', capability: 'event.record', arguments: { summary: 'Wren took the blade on her forearm' }, reason: 'She stepped between them.' },
        { id: 'e2', capability: 'scene.set', arguments: { key: 'mood', value: 'tense' }, reason: 'Violence just broke out.' },
        { id: 'e3', capability: 'variable.adjust', arguments: { variableRef: "Wren's HP", delta: -4 }, reason: 'The blade caught her forearm.' },
    ],
    flow: { continue: false },
});

let variableId = '';
let capturedArchivistPrompt = null;

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
    updateMechanicsProfile({ enabled: true });
    variableId = createVariableValue({
        timelineId: scene.timelineId,
        name: "Wren's HP",
        valueType: 'number',
        value: 12,
        description: 'capacity to withstand injury',
        authority: 'world',
        retrieval: { mode: 'always' },
    }).id;
    // Seed the previous narration onto the page.
    const chat = __getChat();
    chat.length = 0;
    chat.push({ name: 'Wren', is_user: false, mes: PRIOR_NARRATION, extra: { reasoning: PRIOR_REASONING } });
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
    capturedArchivistPrompt = null;
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        archivistPass: async ({ prompt }) => {
            capturedArchivistPrompt = prompt;
            return ['```state', archivistFence, '```'].join('\n');
        },
    });
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('the archivist-first pass records + resolves state before the narrator writes', async () => {
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Wren took the blade on her forearm']);
    expect(listSceneFacts(scene.timelineId, scene.id)).toEqual([{ key: 'mood', value: 'tense', establishedMsgId: null }]);
    // Mechanics resolved against the run's address book — Wren's HP fell 12 → 8.
    expect(Number(getVariableValue(variableId, scene.timelineId)?.value)).toBe(8);
});

test('the previous narration and its reasoning reach the archivist pass', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const promptText = (capturedArchivistPrompt || []).map((m) => m.content).join('\n');
    expect(promptText).toContain(PRIOR_NARRATION);
    expect(promptText).toContain(PRIOR_REASONING);
    // This turn's narrator produced reasoning, so the gate does not warn.
    expect(getLiveDirectionUiState(scene).reasoningWarning).toBe(false);
});
