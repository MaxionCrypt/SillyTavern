// A full Loom turn at the lifecycle level: the Narrator drafts, the Loom
// reconciles at completeVisibleRun, and the
// turn settles waiting for the user. (State recording by the Loom is covered by
// remodel-loom-reconciliation-turn.test.js; this suite covers the shared turn
// machinery — settle/Continue and empty-response handling.)
import { test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    getLiveDirectionRun,
    handleLiveDirectionDraft,
    stopLiveDirection,
    clearLiveDirectionFailure,
    isLatestUserMessage,
    regenerateLastDirectedResponse,
    retryLiveDirection,
    rerunDirectedRoleplayFromUserMessage,
    previewLoomPrompt,
    runLoomReconciliation,
    DIRECTION_PROTOCOL,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { directedTurnController } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-directed-turn-adapter.js';
import { listEvents, recordEvent } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { invalidateLivingLoreProposals, listLivingLoreProposals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-mutations.js';
import { upsertLivingLoreMetadata } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-store.js';
import { buildLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';
import { __setContextOverrides, __setExtensionSettings, __getChat, __emit, __onEvent } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';

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
const LORE_BOOK = 'Lifecycle Lore';
let nativeLore;

function livingLorePacket() {
    return buildLivingLorePacket({
        timelineId: scene.timelineId,
        book: LORE_BOOK,
        bookHash: 'lifecycle-hash',
        entries: [{ book: LORE_BOOK, uid: '42', name: 'Wren', keys: ['Wren'], secondaryKeys: [], content: 'Current\nWren watches the gate.' }],
        selected: [{ book: LORE_BOOK, uid: '42', reasons: [{ channel: 'history.primary' }] }],
        metadata: [{ book: LORE_BOOK, uid: '42', revision: 1, entryType: 'entity' }],
    });
}

function loreProposal(id, value, evidence = 'Wren steps between them.') {
    return {
        id, operation: 'current.set', target: { book: LORE_BOOK, uid: '42', revision: 1 },
        entryType: 'entity', section: 'Current', value, evidence,
        confidence: 0.9, reason: 'Accepted fiction changed Wren’s current state.',
    };
}

async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: {}, swipes: [RESPONSE], swipe_id: 0, swipe_info: [{ extra: {} }] });
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
    __clearDebugEvents();
    __setExtensionSettings({});
    nativeLore = { entries: { 42: { uid: 42, key: ['Wren'], keysecondary: [], comment: 'Wren', content: 'Current\nWren watches the gate.', disable: false } } };
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(nativeLore); },
        async saveWorldInfo(_book, data) { nativeLore = structuredClone(data); },
    });
    upsertLivingLoreMetadata(scene.timelineId, { book: LORE_BOOK, uid: 42 }, { entryType: 'entity', revision: 1 });
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
        activateConnectionProfile: async () => null,
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
    delete scene.generationProfileIds;
    scene.liveDirection.delivery = 'legacy';
});

test('experimental delivery reveals the Narrator before its request settles and never calls Loom', async () => {
    scene.liveDirection.delivery = 'canonical';
    scene.generationProfileIds = { narrator: 'canonical-route', loom: null };
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(nativeLore); },
        async saveWorldInfo(_book, data) { nativeLore = structuredClone(data); },
        addOneMessage() {},
    });
    let releaseCompletion;
    const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
    const loomReconciliation = jest.fn();
    const capturedGenerationTypes = [];
    const deliveredTurnBoundaries = [];
    setLiveDirectionTestAdapters({
        captureNarratorPrompt: async ({ generationType }) => {
            capturedGenerationTypes.push(generationType);
            return [{ role: 'system', content: 'Native prompt fixture.' }];
        },
        async *streamCanonicalNarrator({ prompt }) {
            deliveredTurnBoundaries.push(prompt.messages.at(-1));
            yield { type: 'snapshot', text: 'Wren answers immediately.', reasoning: '' };
            await completionGate;
            yield { type: 'complete', finishReason: 'stop' };
        },
        loomReconciliation,
    });

    const turn = directedTurnController.continue(scene);
    expect(await until(() => __getChat().at(-1)?.mes === 'Wren answers immediately.')).toBe(true);
    expect(getLiveDirectionRun()?.deliveryMode).toBe('canonical');
    expect(getLiveDirectionRun()?.acceptedVisibleText).toBe('Wren answers immediately.');
    expect(getLiveDirectionRun()?.acceptedComplete).not.toBe(true);
    expect(loomReconciliation).not.toHaveBeenCalled();

    releaseCompletion();
    await turn;
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].extra.remodelDirection).toEqual(expect.objectContaining({
        directionId: expect.any(String),
        state: 'complete',
        acceptedText: 'Wren answers immediately.',
    }));
    expect(loomReconciliation).not.toHaveBeenCalled();

    // Advancing from a completed canonical row must not hand that row back
    // through the legacy Loom finalizer before starting the next Narrator.
    await directedTurnController.continue(scene);
    expect(await until(() => __getChat().length === 2 && getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(__getChat().map((message) => message.mes)).toEqual([
        'Wren answers immediately.',
        'Wren answers immediately.',
    ]);
    expect(capturedGenerationTypes).toEqual(['normal', 'normal']);
    expect(deliveredTurnBoundaries).toHaveLength(2);
    expect(deliveredTurnBoundaries.every((message) => message.role === 'user' && /Continue the scene autonomously/.test(message.content))).toBe(true);
    expect(loomReconciliation).not.toHaveBeenCalled();
});

test('experimental Send interrupts a held stream and starts a normal user turn', async () => {
    scene.liveDirection.delivery = 'canonical';
    scene.generationProfileIds = { narrator: 'canonical-route', loom: null };
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(nativeLore); },
        async saveWorldInfo(_book, data) { nativeLore = structuredClone(data); },
        addOneMessage() {},
    });
    const capturedGenerationTypes = [];
    const deliveredTurnBoundaries = [];
    let requestNumber = 0;
    setLiveDirectionTestAdapters({
        captureNarratorPrompt: async ({ generationType }) => {
            capturedGenerationTypes.push(generationType);
            return [{ role: 'system', content: 'Native prompt fixture.' }];
        },
        async *streamCanonicalNarrator({ signal, prompt }) {
            deliveredTurnBoundaries.push(prompt.messages.at(-1));
            requestNumber += 1;
            if (requestNumber === 1) {
                yield { type: 'snapshot', text: 'The visible prefix.', reasoning: '' };
                await new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
                return;
            }
            yield { type: 'snapshot', text: 'Wren reacts to the interruption.', reasoning: '' };
            yield { type: 'complete', finishReason: 'stop' };
        },
    });

    const autonomousTurn = directedTurnController.continue(scene);
    expect(await until(() => __getChat().at(-1)?.mes === 'The visible prefix.')).toBe(true);
    handleLiveDirectionDraft('I step between them.');
    const intervention = directedTurnController.start({ scene, text: 'I step between them.' });
    await Promise.all([autonomousTurn, intervention]);

    expect(__getChat().map((message) => ({ user: Boolean(message.is_user), text: message.mes }))).toEqual([
        { user: false, text: 'The visible prefix.' },
        { user: true, text: 'I step between them.' },
        { user: false, text: 'Wren reacts to the interruption.' },
    ]);
    expect(__getChat()[0].extra.remodelDirection.state).toBe('interrupted');
    expect(capturedGenerationTypes).toEqual(['normal', 'normal']);
    expect(deliveredTurnBoundaries[0]).toEqual(expect.objectContaining({ role: 'user', content: expect.stringMatching(/Continue the scene autonomously/) }));
    expect(deliveredTurnBoundaries[1]).toEqual({ role: 'system', content: 'Native prompt fixture.' });
});

test('experimental Stop cuts off in place and preserves the visible prefix', async () => {
    scene.liveDirection.delivery = 'canonical';
    scene.generationProfileIds = { narrator: 'canonical-route', loom: null };
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(nativeLore); },
        async saveWorldInfo(_book, data) { nativeLore = structuredClone(data); },
        addOneMessage() {},
    });
    setLiveDirectionTestAdapters({
        captureNarratorPrompt: async () => [{ role: 'system', content: 'Native prompt fixture.' }],
        async *streamCanonicalNarrator({ signal }) {
            yield { type: 'snapshot', text: 'This prefix stays.', reasoning: '' };
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        },
    });

    const turn = directedTurnController.continue(scene);
    expect(await until(() => __getChat().at(-1)?.mes === 'This prefix stays.')).toBe(true);
    await directedTurnController.stop();
    await turn;

    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].mes).toBe('This prefix stays.');
    expect(__getChat()[0].extra.remodelDirection.state).toBe('stopped');
    expect(getLiveDirectionRun()).toBeNull();
});

test('a Loom turn commits the Narrator draft and waits for the user', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    // The Narrator's held draft became the committed message.
    expect(__getChat().at(-1).mes).toBe(RESPONSE);
});

test('a turn records an inspectable Archive projection receipt', async () => {
    recordEvent(scene.timelineId, scene.id, 'Wren hid the gate key under the sundial.');
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(__getDebugEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({
            type: 'archive.projection',
            detail: expect.objectContaining({ storedCount: 1, projectedCount: 1, recentIds: expect.any(Array) }),
        }),
    ]));
});

test('a completed turn queues its evidence-backed lore suggestion exactly once and persists its identity', async () => {
    const proposal = loreProposal('wren-moved', 'Wren stands between the fighters.');
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        livingLorePacket: livingLorePacket(),
        loomReconciliation: async () => `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [proposal], flow: { continue: false } })}\n\`\`\``,
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const suggestions = listLivingLoreProposals({ timelineId: scene.timelineId });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ status: 'suggested', proposal });
    expect(__getChat().at(-1).extra.remodelDirection.loreProposalIds).toEqual([suggestions[0].id]);
    expect(__getChat().at(-1).swipe_info[0].extra.remodelDirection.directionId).toBe(suggestions[0].source.directionId);

    invalidateLivingLoreProposals({ timelineId: scene.timelineId, directionIds: [suggestions[0].source.directionId], reason: 'simulate-crash-gap' });
    await __emit('CHAT_LOADED');
    expect(await until(() => listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' }).length === 1)).toBe(true);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId })).toHaveLength(1);
});

test('Retry invalidates the superseded suggestion and queues the retake once', async () => {
    let take = 0;
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        livingLorePacket: livingLorePacket(),
        loomReconciliation: async () => {
            take += 1;
            const proposal = loreProposal(`take-${take}`, take === 1 ? 'First take.' : 'Second take.');
            return `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [proposal], flow: { continue: false } })}\n\`\`\``;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    await regenerateLastDirectedResponse(scene);
    expect(await until(() => take === 2 && getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'invalidated' })).toHaveLength(1);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'take-2' }) }),
    ]);
});

test('Retry preserves the completed response until its replacement connection is ready', async () => {
    scene.generationProfileIds = { narrator: 'slow-route', loom: 'slow-route' };
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    const original = structuredClone(__getChat());
    let reported = '';
    initLiveDirection({
        activateConnectionProfile: async () => { throw new Error('Connection profile "Slow route" did not become ready within 30 seconds.'); },
        onFailure: (error) => { reported = error.message; },
    });

    expect(await regenerateLastDirectedResponse(scene)).toBe(false);
    expect(__getChat()).toEqual(original);
    expect(reported).toMatch(/Slow route/);

    initLiveDirection({ activateConnectionProfile: async () => ({ id: 'ready' }) });
    expect(await retryLiveDirection()).toBe(true);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].mes).toBe(RESPONSE);
});

test('editing the latest user message rewinds its response and reruns without duplicating the user', async () => {
    const chat = __getChat();
    chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Wren stays at the gate.', extra: {} });
    let take = 0;
    const editedEvents = [];
    const stopEdited = __onEvent('MESSAGE_EDITED', (messageId) => editedEvents.push(['edited', messageId]));
    const stopUpdated = __onEvent('MESSAGE_UPDATED', (messageId) => editedEvents.push(['updated', messageId]));
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        livingLorePacket: livingLorePacket(),
        loomReconciliation: async () => {
            take += 1;
            const proposal = loreProposal(`edit-take-${take}`, take === 1 ? 'Old action state.' : 'Edited action state.');
            const request = {
                id: `event-${take}`,
                capability: 'event.record',
                arguments: { summary: take === 1 ? 'The old action happened.' : 'The edited action happened.' },
                reason: 'Record the accepted version of the action.',
            };
            return `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [request], loreProposals: [proposal], flow: { continue: false } })}\n\`\`\``;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(isLatestUserMessage(0, chat)).toBe(true);
    expect(isLatestUserMessage(1, chat)).toBe(false);

    const reran = await rerunDirectedRoleplayFromUserMessage({
        scene,
        messageId: 0,
        text: 'Wren crosses the gate and locks it behind her.',
    });
    expect(reran).toBe(true);
    expect(await until(() => take === 2 && getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(chat).toHaveLength(2);
    expect(chat[0]).toMatchObject({ is_user: true, mes: 'Wren crosses the gate and locks it behind her.' });
    expect(chat.filter((message) => message.is_user)).toHaveLength(1);
    expect(chat[1]).toMatchObject({ is_user: false, mes: RESPONSE });
    expect(editedEvents).toEqual([['edited', 0], ['updated', 0]]);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'invalidated' })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'edit-take-1' }) }),
    ]);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'edit-take-2' }) }),
    ]);
    expect(listEvents(scene.timelineId, scene.id).map((event) => event.summary)).toEqual(['The edited action happened.']);
    stopEdited();
    stopUpdated();
});

test('only the newest user-authored message is eligible for edit-and-rerun', () => {
    const chat = [
        { is_user: true, mes: 'First action.' },
        { is_user: false, mes: 'First response.' },
        { is_user: true, mes: 'Latest action.' },
        { is_user: false, mes: 'Latest response.' },
    ];
    expect(isLatestUserMessage(0, chat)).toBe(false);
    expect(isLatestUserMessage(1, chat)).toBe(false);
    expect(isLatestUserMessage(2, chat)).toBe(true);
    expect(isLatestUserMessage(3, chat)).toBe(false);
});

test('switching native swipes invalidates the superseded proposal set and restores only the selected set', async () => {
    const first = loreProposal('swipe-one', 'First swipe state.');
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        livingLorePacket: livingLorePacket(),
        loomReconciliation: async () => `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [first], flow: { continue: false } })}\n\`\`\``,
    });
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const message = __getChat().at(-1);
    const firstSaved = structuredClone(message.extra.remodelDirection);
    const secondSaved = structuredClone(firstSaved);
    secondSaved.directionId = 'direction-second-swipe';
    secondSaved.acceptedText = RESPONSE;
    secondSaved.loreProposalIds = [];
    secondSaved.envelope.loreProposals = [loreProposal('swipe-two', 'Second swipe state.')];
    message.extra.remodelDirection = secondSaved;
    await __emit('MESSAGE_SWIPED', __getChat().length - 1);

    expect(await until(() => listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })
        .some((record) => record.proposal.id === 'swipe-two'))).toBe(true);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'invalidated' })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'swipe-one' }) }),
    ]);

    message.extra.remodelDirection = firstSaved;
    await __emit('MESSAGE_SWIPED', __getChat().length - 1);
    expect(await until(() => listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })
        .some((record) => record.proposal.id === 'swipe-one'))).toBe(true);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })).toHaveLength(1);
});

test('reload recovery queues only proposals evidenced by the prefix saved before a crash', async () => {
    const directionId = 'direction-crash-prefix';
    const accepted = 'Wren reaches the gate.';
    const envelope = {
        protocol: DIRECTION_PROTOCOL,
        directionId,
        sceneId: scene.id,
        flow: { continueAfter: false, hardPauseAfter: true },
        mechanics: { pendingRequests: [] },
        livingLore: livingLorePacket(),
        loreProposals: [
            loreProposal('crash-accepted', 'Wren is at the gate.', accepted),
            loreProposal('crash-hidden', 'The gate has opened.', 'The gate opens.'),
        ],
    };
    __getChat().push({
        name: 'Wren', is_user: false, mes: accepted, extra: { remodelDirection: {
            protocol: DIRECTION_PROTOCOL,
            directionId,
            sceneId: scene.id,
            timelineId: scene.timelineId,
            state: 'speaking',
            acceptedText: accepted,
            performerRef: cast[0].ref,
            envelope,
            checkpointTransactionIds: [],
            loreProposalIds: [],
        } },
    });

    await __emit('CHAT_LOADED');
    expect(await until(() => listLivingLoreProposals({ timelineId: scene.timelineId }).length === 1)).toBe(true);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'crash-accepted' }) }),
    ]);
    expect(__getChat()[0].mes).toBe(accepted);
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
    const resolvedGrounding = typeof grounding[0]?.[1] === 'function' ? grounding[0][1]({}) : grounding[0]?.[1];
    expect(resolvedGrounding).toContain('Wren entered the courtyard.');
    expect(resolvedGrounding).not.toMatch(/Continue the scene forward/i);
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

test('Continue answers an already-posted user action without posting or routing it twice', async () => {
    const chat = __getChat();
    const waitingAction = { name: 'User', is_user: true, is_system: false, mes: 'I tell Wren to open the gate.', extra: {} };
    chat.push(waitingAction);
    let receivedEnvelope = null;
    setLiveDirectionTestAdapters({
        generatePerformer: async ({ envelope }) => {
            receivedEnvelope = envelope;
            await speak();
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(receivedEnvelope?.currentPlayerAction).toBe(waitingAction.mes);
    expect(chat.filter((message) => message.is_user)).toEqual([waitingAction]);
    expect(chat).toHaveLength(2);
    expect(chat[1].mes).toBe(RESPONSE);
});

test('STOP during a new private Narrator pass keeps the preceding completed output and reports no failure', async () => {
    const previous = { name: 'Wren', is_user: false, mes: 'The preceding turn must remain.', extra: {} };
    __getChat().push(previous);
    let rejectGeneration = null;
    let failureCount = 0;
    initLiveDirection({ onFailure: () => { failureCount++; } });
    setLiveDirectionTestAdapters({
        generatePerformer: () => new Promise((_resolve, reject) => { rejectGeneration = reject; }),
    });
    __setContextOverrides({
        stopGeneration: () => rejectGeneration?.(new Error('Generation was aborted.')),
    });

    const pending = requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.phase === 'narrator' && rejectGeneration)).toBe(true);
    expect(getLiveDirectionRun()).not.toHaveProperty('passToken');
    await stopLiveDirection();
    await pending;

    expect(__getChat()).toEqual([previous]);
    expect(failureCount).toBe(0);
    expect(getLiveDirectionRun()).toBeNull();
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

test('a reasoning-only OpenRouter reply retries once with reasoning disabled and keeps the recovered prose', async () => {
    const requests = [];
    let attempt = 0;
    setLiveDirectionTestAdapters({
        generatePerformer: async () => {
            attempt++;
            const request = {
                chat_completion_source: 'openrouter',
                model: 'deepseek/deepseek-v4-pro',
                reasoning_effort: 'low',
                include_reasoning: true,
            };
            await __emit('CHAT_COMPLETION_SETTINGS_READY', request);
            requests.push(request);

            const chat = __getChat();
            if (attempt === 1) {
                chat.push({ name: 'Wren', is_user: false, mes: '', extra: { reasoning: 'Private reasoning with no prose.' } });
            } else {
                chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: {} });
            }
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(attempt).toBe(2);
    expect(requests[0]).toMatchObject({ reasoning_effort: 'low', include_reasoning: true });
    expect(requests[1]).toMatchObject({ reasoning_effort: 'none', include_reasoning: false });
    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].mes).toBe(RESPONSE);
});

test('an unfinished private Narrator draft is retried before the Loom can canonize it', async () => {
    const cutOff = "Wren crosses the courtyard and reaches toward the gate, but her hand stops when she'd";
    let attempt = 0;
    let loomCalls = 0;
    setLiveDirectionTestAdapters({
        generatePerformer: async () => {
            attempt++;
            const chat = __getChat();
            const prose = attempt === 1 ? cutOff : RESPONSE;
            chat.push({ name: 'Wren', is_user: false, mes: prose, extra: {}, swipes: [prose], swipe_id: 0, swipe_info: [{ extra: {} }] });
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
        loomReconciliation: async () => {
            loomCalls++;
            return `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [], flow: { continue: false } })}\n\`\`\``;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(attempt).toBe(2);
    expect(loomCalls).toBe(1);
    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].mes).toBe(RESPONSE);
    expect(__getChat()[0].mes).not.toContain("when she'd");
});

test('visible reasoning or echoed commands are retried before the Loom sees them', async () => {
    const malformed = 'Hmm, the user wants me to continue the scene. I need to write only narration.\n\nWren approaches the gate.';
    let attempt = 0;
    let loomCalls = 0;
    const grounding = [];
    initLiveDirection({
        setNativePromptContent: (_slot, content) => {
            grounding.push(typeof content === 'function' ? content({}) : content);
            return true;
        },
    });
    setLiveDirectionTestAdapters({
        generatePerformer: async () => {
            attempt++;
            const prose = attempt === 1 ? malformed : RESPONSE;
            const chat = __getChat();
            chat.push({ name: 'Wren', is_user: false, mes: prose, extra: {}, swipes: [prose], swipe_id: 0, swipe_info: [{ extra: {} }] });
            await __emit('MESSAGE_RECEIVED', chat.length - 1);
        },
        loomReconciliation: async () => {
            loomCalls++;
            return `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [], flow: { continue: false } })}\n\`\`\``;
        },
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(attempt).toBe(2);
    expect(loomCalls).toBe(1);
    expect(grounding.some((content) => /private planning/i.test(content))).toBe(true);
    expect(__getChat()).toHaveLength(1);
    expect(__getChat()[0].mes).toBe(RESPONSE);
    expect(__getChat()[0].mes).not.toContain('user wants me');
});

test('Loom preview and the real reconciliation share the exact recipe compiler', async () => {
    const reasoning = 'The private draft preserves the accepted action.';
    const preview = await previewLoomPrompt(scene, {
        action: 'Wren tests the gate.',
        draft: RESPONSE,
        draftReasoning: reasoning,
    });
    let sentPrompt = null;
    setLiveDirectionTestAdapters({
        loomReconciliation: async ({ prompt }) => {
            sentPrompt = prompt;
            return `${RESPONSE}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [], flow: { continue: false } })}\n\`\`\``;
        },
    });

    await runLoomReconciliation({ scene, snapshot: preview.snapshot, draft: RESPONSE, draftReasoning: reasoning });
    expect(sentPrompt).toEqual(preview.prompt);
    expect(preview.trace.length).toBeGreaterThan(0);
    expect(sentPrompt.map((message) => message.content).join('\n')).toContain('Wren tests the gate.');
    expect(sentPrompt.map((message) => message.content).join('\n')).toMatch(/AUTHORITATIVE TURN INPUT/);
});

test('Loom preview clearly marks the future Narrator values it cannot know yet', async () => {
    const preview = await previewLoomPrompt(scene, { action: 'Wren tests the gate.' });
    const text = preview.prompt.map((message) => message.content).join('\n');
    expect(text).toMatch(/PREVIEW PLACEHOLDER: the completed private Narrator draft/i);
    expect(text).toMatch(/PREVIEW PLACEHOLDER: private Narrator reasoning/i);
});

test('an intervention stores only the visible Loom prefix and never the private draft or buffered tail', async () => {
    const visible = 'The guard reaches for the alarm—';
    const full = `${visible}and presses it before Wren can move.`;
    let pushTail = () => {};
    let archivePrompt = '';
    setLiveDirectionTestAdapters({
        generatePerformer: speak,
        livingLorePacket: livingLorePacket(),
        loomReconciliation: ({ onChunk, signal }) => new Promise((resolve) => {
            onChunk(visible);
            pushTail = () => onChunk(full);
            signal.addEventListener('abort', () => resolve(`${full}\n\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [loreProposal('hidden-tail', 'The alarm is sounding.', 'presses it')], flow: { continue: false } })}\n\`\`\``), { once: true });
        }),
        archiveCatchup: async ({ prompt }) => {
            archivePrompt = prompt.map((message) => message.content).join('\n');
            return `${visible}\n\n\`\`\`state\n${JSON.stringify({
                requests: [{ id: 'archive-1', capability: 'event.record', arguments: { summary: 'The guard reached for the alarm' }, reason: 'This is the accepted interrupted prefix.' }],
                loreProposals: [
                    loreProposal('accepted-prefix', 'Wren sees the guard reach for the alarm.', 'The guard reaches for the alarm'),
                    loreProposal('rejected-tail', 'The alarm is sounding.', 'presses it'),
                ],
                flow: { continue: false },
            })}\n\`\`\``;
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
    expect(archivePrompt).toContain('Selected Living Lore');
    expect(archivePrompt).not.toContain('presses it');
    expect(archivePrompt).not.toContain(RESPONSE);
    expect(listLivingLoreProposals({ timelineId: scene.timelineId, status: 'suggested' })).toEqual([
        expect.objectContaining({ proposal: expect.objectContaining({ id: 'accepted-prefix' }) }),
    ]);
});


test('Narrator grounding does not duplicate the recipe-owned Story Goals source', async () => {
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
    expect(grounding[0]?.[1]).not.toContain('Marissa means to be home by six');
    expect(grounding[0]?.[1]).not.toContain('## Objectives');
});
