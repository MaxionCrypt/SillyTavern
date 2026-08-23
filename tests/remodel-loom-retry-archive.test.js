// Retry must roll back the Archive the turn recorded — including the state the
// queued catch-up pass wrote after the run was finalized.
//
// THE DEFECT, so it is not reintroduced: catchUpArchive executes real capability
// requests but used to discard result.transaction.id, and it is queued to run
// AFTER finalizeRunMessage has already serialized the run. So the undo set
// regenerateLastDirectedResponse reads back was snapshotted before the catch-up
// transaction existed, and Retry left its events behind — describing prose that
// had just been deleted. Repairing only one of those two halves still leaves the
// events in place, which is what makes this suite worth having.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    regenerateLastDirectedResponse,
    getLiveDirectionRun,
    handleLiveDirectionDraft,
    stopLiveDirection,
    clearLiveDirectionFailure,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-retry-archive',
    timelineId: 'timeline-retry-archive',
    title: 'Retry Archive Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, mode: 'loom', narratorRef: null, pacing: 'instant', autoplay: false },
};
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];
const RESPONSE = 'Wren steps between them. The blade catches her forearm.';

function fence(prose, requests) {
    return `${prose}\n\n\`\`\`state\n${JSON.stringify({ requests, flow: { continue: false } })}\n\`\`\``;
}

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
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('Retry after an interruption rolls back the catch-up Archive event', async () => {
    const visible = 'The guard reaches for the alarm—';
    const full = `${visible}and presses it before Wren can move.`;
    let pushTail = () => {};
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        loomReconciliation: ({ onChunk, signal }) => new Promise((resolve) => {
            onChunk(visible);
            pushTail = () => onChunk(full);
            signal.addEventListener('abort', () => resolve(fence(full, [])), { once: true });
        }),
        archiveCatchup: async () => fence(visible, [{
            id: 'archive-1',
            capability: 'event.record',
            arguments: { summary: 'The guard reached for the alarm' },
            reason: 'the accepted interrupted prefix',
        }]),
    });

    const pending = requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.acceptedVisibleText === visible)).toBe(true);
    handleLiveDirectionDraft('I catch his wrist.');
    pushTail();
    await stopLiveDirection();
    await pending;

    expect(await until(() => listEvents(scene.timelineId, scene.id).length === 1)).toBe(true);

    // The retake records nothing of its own, so anything left in the Archive
    // afterwards is the undo's failure rather than the new turn's doing.
    setLiveDirectionTestAdapters({ generatePerformer: speak });
    await regenerateLastDirectedResponse(scene);

    expect(listEvents(scene.timelineId, scene.id)).toHaveLength(0);
});

// PROBE-MARKER

// Not interruption-only: completeVisibleRun queues the same catch-up whenever
// the Loom's own fence recorded no Archive operations, and queues it just as
// late — after finalizeRunMessage has snapshotted the undo set.
test('Retry after a COMPLETED turn rolls back its catch-up Archive event', async () => {
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        // Completes normally but records nothing, so archiveRequestsApplied
        // stays false and the repair path runs.
        loomReconciliation: async () => fence(RESPONSE, []),
        archiveCatchup: async () => fence(RESPONSE, [{
            id: 'archive-2',
            capability: 'event.record',
            arguments: { summary: 'Wren took the blade on her forearm' },
            reason: 'the delivered prose',
        }]),
    });

    await requestNextDirection(scene);
    expect(await until(() => listEvents(scene.timelineId, scene.id).length === 1)).toBe(true);

    setLiveDirectionTestAdapters({ generatePerformer: speak });
    await regenerateLastDirectedResponse(scene);

    expect(listEvents(scene.timelineId, scene.id)).toHaveLength(0);
});
