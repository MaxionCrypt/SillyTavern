// Layer 2: the REAL custom Narrator path, end to end without the performer test
// adapter. The Director is faked (a requestDirection adapter), but the Narrator
// runs the production code: self-created message, compileNarratorPrompt, and
// streamChatPrompt over core's request shape (via __setOpenAIRequestHandler).
// This is what proves the rewire works without a browser.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    getLiveDirectionRun,
    stopLiveDirection,
    clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { __setExtensionSettings, __getChat, __setContextOverrides, __onEvent } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';
import { __setOpenAIRequestHandler } from './util/openai-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-stream',
    timelineId: 'timeline-stream',
    title: 'Stream Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];

function wireWithoutPerformerAdapter() {
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
    // Only the Director is faked; the Narrator runs the real streaming path.
    setLiveDirectionTestAdapters({ requestDirection: async () => '[note] The rooftop is tense.' });
}

/** Feed the Narrator's streamChatPrompt cumulative chunks over core's shape. */
function narratorStreams(chunks, { reasoning = '' } = {}) {
    __setOpenAIRequestHandler(({ signal }) => async function* streamData() {
        let text = '';
        for (const chunk of chunks) {
            if (signal?.aborted) return;
            text += chunk;
            yield { text, state: { reasoning } };
        }
    });
}

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/** Yield the first delta, signal it, then wait on a gate before the rest — so a
 *  test can abort mid-stream and assert only the pre-abort prose survives. */
function narratorStreamsGated(firstDelta, restDeltas, { onFirst, gate }) {
    __setOpenAIRequestHandler(({ signal }) => async function* streamData() {
        let text = firstDelta;
        yield { text, state: { reasoning: '' } };
        onFirst?.();
        await gate.promise;
        for (const chunk of restDeltas) {
            if (signal?.aborted) return;
            text += chunk;
            yield { text, state: { reasoning: '' } };
        }
    });
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
    // canStreamStory() must be true or the gate refuses the turn.
    __setContextOverrides({ mainApi: 'openai', chatCompletionSettings: { stream_openai: true } });
    wireWithoutPerformerAdapter();
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
    __setOpenAIRequestHandler(null);
});

test('the custom path creates the performer message and reveals the streamed text', async () => {
    const received = [];
    __onEvent('MESSAGE_RECEIVED', (id) => received.push(id));
    narratorStreams(['Wren ', 'steps ', 'forward.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const chat = __getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].mes).toBe('Wren steps forward.');
    expect(chat[0].name).toBe('Wren');
    expect(chat[0].is_user).toBe(false);
    // The custom path fires MESSAGE_RECEIVED itself (core fires nothing) so
    // Remodel's roleplay scene and downstream extensions still react — exactly
    // once, for the finalized message.
    expect(received).toEqual([0]);
});

test('interrupting mid-stream keeps the revealed prose and drops the rest', async () => {
    let firstEmitted = false;
    const gate = deferred();
    narratorStreamsGated('Wren steps forward.', [' She never finishes the step.'], {
        onFirst: () => { firstEmitted = true; },
        gate,
    });
    const turn = requestNextDirection(scene);
    // Wait until the first delta has streamed and revealed.
    expect(await until(() => firstEmitted && getLiveDirectionRun()?.acceptedVisibleText?.includes('forward'))).toBe(true);
    // Interrupt: aborts the run's controller. Release the gate so the paused
    // generator resumes and observes the abort instead of hanging.
    const stopping = stopLiveDirection();
    gate.resolve();
    await stopping;
    await turn;
    const chat = __getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].mes).toBe('Wren steps forward.');
    expect(chat[0].mes).not.toContain('never finishes');
});

test('the directed Narrator is refused when the backend cannot stream', async () => {
    __setContextOverrides({ mainApi: 'textgenerationwebui', chatCompletionSettings: { stream_openai: false } });
    let failure = '';
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
        onFailure: (message) => { failure = String(message || ''); },
        setNativePromptContent: () => {},
    });
    setLiveDirectionTestAdapters({ requestDirection: async () => '[note] The rooftop is tense.' });
    await requestNextDirection(scene);
    expect(await until(() => failure.length > 0)).toBe(true);
    expect(failure.toLowerCase()).toContain('stream');
    // No performer message was left behind by a refused turn.
    expect(__getChat()).toHaveLength(0);
});
