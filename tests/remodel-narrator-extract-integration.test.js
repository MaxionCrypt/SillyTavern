// Pass 2 end to end: after the Narrator's prose is finalized, the extraction
// adapter returns a state fence and the archivist records it — so the next
// turn's injection is grounded in what actually happened.
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
const RESPONSE = 'Wren steps between them. The blade catches her forearm.';

const NARRATOR_REASONING = 'Wren is protecting the boy; taking the blade should cost her HP.';

async function speak() {
    const chat = __getChat();
    // Native generation records the model's thinking on message.extra.reasoning.
    chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: { reasoning: NARRATOR_REASONING } });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

const extractionFence = JSON.stringify({
    requests: [
        { id: 'e1', capability: 'event.record', arguments: { summary: 'Wren took the blade on her forearm' }, reason: 'She stepped between them.' },
        { id: 'e2', capability: 'scene.set', arguments: { key: 'mood', value: 'tense' }, reason: 'Violence just broke out.' },
        { id: 'e3', capability: 'variable.adjust', arguments: { variableRef: "Wren's HP", delta: -4 }, reason: 'The blade caught her forearm.' },
    ],
    flow: { continue: false },
});

let variableId = '';

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
    capturedExtractionPrompt = null;
    setLiveDirectionTestAdapters({
        requestDirection: async () => '[note] The rooftop is tense.',
        generatePerformer: speak,
        extractState: async ({ prompt }) => {
            capturedExtractionPrompt = prompt;
            return ['```state', extractionFence, '```'].join('\n');
        },
    });
});

let capturedExtractionPrompt = null;

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('extraction records the narration into the archivist after the turn completes', async () => {
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Wren took the blade on her forearm']);
    expect(listSceneFacts(scene.timelineId, scene.id)).toEqual([{ key: 'mood', value: 'tense', establishedMsgId: 0 }]);
    // v2: extraction also authored the numeric consequence, resolved against the
    // run's address book — Wren's HP fell from 12 to 8.
    expect(Number(getVariableValue(variableId, scene.timelineId)?.value)).toBe(8);
});

test("the narrator's own reasoning (message.extra.reasoning) reaches the extractor", async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const promptText = (capturedExtractionPrompt || []).map((m) => m.content).join('\n');
    expect(promptText).toContain(NARRATOR_REASONING);
    // Reasoning was present, so the gate does not warn.
    expect(getLiveDirectionUiState(scene).reasoningWarning).toBe(false);
});
