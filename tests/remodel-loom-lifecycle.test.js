// A full Loom turn at the lifecycle level: the Narrator drafts, the Loom
// reconciles at completeVisibleRun, and the
// turn settles waiting for the user. (State recording by the Loom is covered by
// remodel-loom-reconciliation-turn.test.js; this suite covers the shared turn
// machinery — settle/Continue and empty-response handling.)
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    getLiveDirectionRun,
    handleLiveDirectionDraft,
    stopLiveDirection,
    clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents, recordEvent } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-editor-lc',
    timelineId: 'timeline-editor-lc',
    title: 'Editor Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, mode: 'loom', narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];
const RESPONSE = 'Wren steps between them. The blade catches her forearm.';

async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

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
        generatePerformer: speak,
        // No Loom adapter: reconciliation falls back to the draft
        // unchanged, records nothing — exactly the no-roll turn.
    });
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('a Loom turn commits the Narrator draft and waits for the user', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    // The Narrator's held draft became the committed message.
    expect(__getChat().at(-1).mes).toBe(RESPONSE);
});

test('Narrator Archive grounding resolves through the recipe macro and is cleared after assembly', async () => {
    const promptContent = [];
    recordEvent(scene.timelineId, scene.id, 'Wren entered the courtyard.');
    initLiveDirection({
        setNativePromptContent: (...args) => {
            promptContent.push(args);
            return true;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const grounding = promptContent.filter(([key]) => key === 'narratorGrounding');
    expect(grounding[0]?.[1]).toContain('Wren entered the courtyard.');
    expect(grounding[0]?.[1]).not.toMatch(/Continue the scene forward/i);
    expect(grounding.at(-1)?.[1]).toBe('');
});

test('a completed turn waits for the user and Continue advances the next one', async () => {
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
        // Pushes an empty row, the way a provider that returns nothing does.
        generatePerformer: async () => {
            const chat = __getChat();
            chat.push({ name: 'Wren', is_user: false, mes: '', extra: {} });
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
    });
    await requestNextDirection(scene);
    // The empty run never becomes a finished turn: it does not reach the
    // waiting state with a kept message, and the empty row is not left behind.
    expect(await until(() => getLiveDirectionRun() === null || getLiveDirectionRun()?.state !== 'Speaking', 3000)).toBe(true);
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});

test('an intervention stores only the visible Loom prefix and never the private draft or buffered tail', async () => {
    const visible = 'The guard reaches for the alarm—';
    const full = `${visible}and presses it before Wren can move.`;
    let pushTail = () => {};
    let archivePrompt = '';
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        loomReconciliation: ({ onChunk, signal }) => new Promise((resolve) => {
            onChunk(visible);
            pushTail = () => onChunk(full);
            signal.addEventListener('abort', () => resolve(`${full}\n\n\`\`\`state\n{"requests":[],"flow":{"continue":false}}\n\`\`\``), { once: true });
        }),
        archiveCatchup: async ({ prompt }) => {
            archivePrompt = prompt.map((message) => message.content).join('\n');
            return `${visible}\n\n\`\`\`state\n{"requests":[{"id":"archive-1","capability":"event.record","arguments":{"summary":"The guard reached for the alarm"},"reason":"This is the accepted interrupted prefix."}],"flow":{"continue":false}}\n\`\`\``;
        },
    });

    const pending = requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.acceptedVisibleText === visible)).toBe(true);
    handleLiveDirectionDraft('I catch his wrist.');
    pushTail();
    expect(getLiveDirectionRun()?.rawBufferedText).toBe(full);
    await stopLiveDirection();
    await pending;

    expect(__getChat().at(-1).mes).toBe(visible);
    expect(__getChat().at(-1).mes).not.toContain('presses it');
    expect(__getChat().at(-1).mes).not.toBe(RESPONSE);
    expect(await until(() => listEvents(scene.timelineId, scene.id).length === 1)).toBe(true);
    expect(listEvents(scene.timelineId, scene.id)[0].summary).toBe('The guard reached for the alarm');
    expect(archivePrompt).toContain(visible);
    expect(archivePrompt).not.toContain('presses it');
    expect(archivePrompt).not.toContain(RESPONSE);
});


// buildGoalObjectives had two call sites and both were inside the Loom. Its own
// docstring says "for the narrator view", which was intent rather than wiring —
// the Narrator had never once been shown a Goal, so it knew what everyone had
// DONE and never what anyone WANTED, and the cheapest continuation of any user
// action was that it simply worked.
//
// Asserts the value actually handed to setNativePromptContent, NOT
// buildGoalObjectives in isolation: a helper-only version of this test passed
// identically with the wiring removed.
test('a character Goal reaches the Narrator grounding, not only the Loom', async () => {
    const { createTimelineGoal, linkGoalToScene } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js');
    const goal = createTimelineGoal(scene.timelineId, {
        title: 'Marissa means to be home by six',
        holderRefs: [{ kind: 'character', id: 'marissa', label: 'Marissa' }],
        successRate: 30,
    }, { sceneId: scene.id, actor: 'mechanics' });
    linkGoalToScene(scene.id, goal.id);

    const promptContent = [];
    initLiveDirection({
        setNativePromptContent: (...args) => {
            promptContent.push(args);
            return true;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const grounding = promptContent.filter(([key]) => key === 'narratorGrounding');
    expect(grounding[0]?.[1]).toContain('Marissa means to be home by six');
    // The odds stay on the Loom's private board — the Narrator sees the want,
    // never the number behind it.
    expect(grounding[0]?.[1]).not.toMatch(/\b30\b/);
});
