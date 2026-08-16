// The rework's central behavioural change, under test.
//
// Design section 4: without a commit marker, a Goal or Variable change can no
// longer land at the exact sentence that establishes it. Changes instead apply
// "when a response is accepted — fully revealed, or frozen by user
// interruption. An early interruption applies nothing."
//
// That principle had zero automated coverage: nothing exercised
// applyPendingRequests, the exactly-once guard, or either side of the
// interrupt boundary. This drives the real run lifecycle end to end —
// beginDirection, the reveal loop, finalizeRunMessage, executeDirectionRequests
// and the real capability layer writing to the real Variable store — with the
// two nondeterministic model boundaries replaced through
// setLiveDirectionTestAdapters. No network, no API key.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    submitDirectedRoleplay,
    stopLiveDirection,
    getLiveDirectionRun,
    clearLiveDirectionFailure,
    regenerateLastDirectedResponse,
    DIRECTION_PROTOCOL,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import {
    createVariableValue,
    getVariableValue,
    updateMechanicsProfile,
    listMechanicsTransactions,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { createTimelineGoal, linkGoalToScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

// generateDirectedPerformer clears SillyTavern's native composer before it
// hands generation to core, so it touches the DOM once. Jest's environment is
// `node`; these are the two bindings that reach for, nothing more. Kept in the
// test rather than guarded in production — the production path genuinely runs
// in a browser and should not grow a `typeof document` check for our benefit.
globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

// Pacing is per-test: `instant` reveals the whole buffer in one step, which
// keeps the completed-run cases fast, while the mid-stream interrupt needs a
// pace that actually leaves a partial reveal to catch.
const scene = {
    id: 'scene-lifecycle',
    timelineId: 'timeline-lifecycle',
    title: 'Lifecycle Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};

// One active card, no Narrator bound: resolvePerformer takes the sole
// available performer, which is the unambiguous case.
const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];

const RESPONSE = 'Wren steps between them. The blade catches her forearm.';

let variableId = '';

function directionEnvelope() {
    return {
        protocol: DIRECTION_PROTOCOL,
        instruction: 'Wren takes the blow meant for the boy.',
        flow: { continueAfter: false, hardPauseAfter: true },
        requests: [{
            id: 'req-1',
            capability: 'variable.adjust',
            // Addressed by NAME, which is the whole point of the rework.
            arguments: { variableRef: "Wren's HP", delta: -4 },
            reason: 'She took the blade on her forearm.',
        }],
    };
}

/**
 * Stands in for the native performer generation.
 *
 * Writes the message core would have written and fires MESSAGE_RECEIVED, which
 * is how live-direction.js learns the message id and fills its reveal buffer.
 * It deliberately does NOT reveal anything: the reveal is driven by the timer
 * live-direction schedules, so a test can interrupt before the first character
 * simply by not letting that timer run.
 */
async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: RESPONSE, extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

function wire({ onSpeak = speak } = {}) {
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
    });
    setLiveDirectionTestAdapters({
        requestDirection: async () => directionEnvelope(),
        generatePerformer: onSpeak,
    });
}

/** Poll rather than sleep: the reveal loop chains through its own timers. */
async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

function hp() {
    return Number(getVariableValue(variableId, scene.timelineId)?.value);
}

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    scene.liveDirection.pacing = 'instant';
    updateMechanicsProfile({ enabled: true });
    variableId = createVariableValue({
        timelineId: scene.timelineId,
        name: "Wren's HP",
        valueType: 'number',
        value: 12,
        description: 'capacity to withstand injury',
        // `world` authority applies automatically; `review` would defer and
        // this suite would be testing the approval queue instead.
        authority: 'world',
        retrieval: { mode: 'always' },
    }).id;
    wire();
});

// Deliberately no console.error spy: nothing here is supposed to reach
// directionFailure, so a failure printing itself into the suite output is
// information, not noise.
//
// The drain is load-bearing, not tidiness. `activeRun` is module state that
// outlives a test, and requestNextDirection refuses outright while a run is
// held — so a leftover run silently turns the NEXT test into an assertion
// about the previous test's run. It also cancels any armed autoplay timer.
afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('a fully revealed response applies the direction\'s requests', async () => {
    expect(hp()).toBe(12);

    await requestNextDirection(scene);
    // The run holds at "Waiting for you" once the whole buffer is revealed and
    // finalizeRunMessage has run — that is acceptance.
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(hp()).toBe(8);
    const chat = __getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].mes).toBe(RESPONSE);
    expect(chat[0].extra.remodelDirection.state).toBe('complete');
});

test('an interruption before the first character applies nothing', async () => {
    expect(hp()).toBe(12);

    // requestNextDirection resolves with the buffer filled and a reveal timer
    // armed but not yet fired, so this is genuinely character zero.
    await requestNextDirection(scene);
    expect(getLiveDirectionRun()?.acceptedVisibleText).toBe('');

    await stopLiveDirection();

    expect(hp()).toBe(12);
    // Nothing was accepted, so the empty row is removed rather than left in
    // the stream as a blank Narrator bubble.
    expect(__getChat()).toHaveLength(0);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })).toHaveLength(0);
});

test('an interruption part-way through the prose applies the requests once', async () => {
    // The "frozen by user interruption" half of design section 4: coarser
    // granularity than a commit marker, but the user did read fiction, so
    // stored state may change. `slow` leaves a real partial reveal to catch.
    scene.liveDirection.pacing = 'slow';

    await requestNextDirection(scene);
    expect(await until(() => (getLiveDirectionRun()?.acceptedVisibleText.length || 0) > 0)).toBe(true);
    const acceptedAtStop = getLiveDirectionRun().acceptedVisibleText;
    // Genuinely mid-stream, not a completed run being stopped afterwards.
    expect(acceptedAtStop.length).toBeLessThan(RESPONSE.length);

    await stopLiveDirection();

    expect(hp()).toBe(8);
    const applied = listMechanicsTransactions({ timelineId: scene.timelineId })
        .filter((transaction) => transaction.status === 'applied');
    expect(applied).toHaveLength(1);
    // The suffix the user never read is discarded, and what they did read is
    // what gets stored.
    const chat = __getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].mes).toBe(acceptedAtStop.trim());
    expect(chat[0].mes.length).toBeLessThan(RESPONSE.length);
});

test('acceptance is exactly once even when finalize is re-entered', async () => {
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);
    expect(hp()).toBe(8);

    // Stop on an already-accepted run re-enters finalizeRunMessage. The
    // pendingRequestsApplied flag is what stops -4 landing twice.
    await stopLiveDirection();
    expect(hp()).toBe(8);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })
        .filter((transaction) => transaction.status === 'applied')).toHaveLength(1);
});

// goal.reach asks "was this Goal's tracked Variable retrieved this pass?".
// That question is about retrieval, not about addressing, and it used to be
// answered by inspecting the address table — which worked only because the
// address table was seeded with everything retrieval found. Now that the table
// holds nothing but name-resolved entries, a reach that names no Variable of
// its own would look like a pass that retrieved nothing, and fail closed on a
// perfectly valid request. It reads retrievedVariableIds instead.
test('a tracked goal.reach still sees the retrieved Variable it never names', async () => {
    const goal = createTimelineGoal(scene.timelineId, {
        title: 'Bleed her out',
        successRate: 60,
        visibility: 'public',
        // A world-held Goal: no persona holder, so no review deferral.
        holderRefs: [{ kind: 'character', id: 'char-n', label: 'Wren' }],
        resolution: { kind: 'tracked', variableId, field: 'value', direction: 'decrease', completionThreshold: 0 },
    }, { sceneId: scene.id });
    linkGoalToScene(scene.id, goal.id, 'active', { timelineId: scene.timelineId });

    setLiveDirectionTestAdapters({
        requestDirection: async () => ({
            ...directionEnvelope(),
            // The ONLY request. It names the Goal, never the Variable, so the
            // address table ends the pass holding one goal entry and zero
            // variable entries.
            requests: [{
                id: 'req-1', capability: 'goal.reach',
                arguments: { goalRef: 'Bleed her out', impactMagnitude: 'meaningful' },
                reason: 'She is between the blade and the boy.',
            }],
        }),
        generatePerformer: speak,
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The roll is a real d100, so a hit adjusts the Variable and a miss drops
    // the success rate — either is a valid outcome. What must never happen is
    // the request being refused for a containment reason that does not apply.
    const diagnostics = (getLiveDirectionRun()?.checkpointDiagnostics || []).join(' ');
    expect(diagnostics).not.toMatch(/not retrieved for this request/i);
    expect(diagnostics).not.toMatch(/not advertised for this request/i);
    const applied = listMechanicsTransactions({ timelineId: scene.timelineId })
        .flatMap((transaction) => transaction.receipts || [])
        .filter((receipt) => receipt.status === 'applied' && receipt.capability === 'goal.reach');
    expect(applied).toHaveLength(1);
});

test('the saved record stores the address book once and keeps the Goal authority', async () => {
    await submitDirectedRoleplay({ scene, text: 'Wren steps in.', authorizedGoalIds: ['goal-abc'] });
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const saved = __getChat().at(-1).extra.remodelDirection;
    expect(saved.addressBook.entries.some((entry) => entry.name === "Wren's HP")).toBe(true);
    // Stored once, at the top level. The envelope used to carry a second copy
    // of the address book plus two Maps that stringify to `{}` — data-shaped
    // in the saved message, and completely inert.
    expect(saved.envelope.addressBook).toBeUndefined();
    expect(saved.envelope.variableRefs).toBeUndefined();
    expect(saved.envelope.goalRefs).toBeUndefined();
    // What the envelope must still carry, since applyPendingRequests reads it.
    expect(saved.envelope.mechanics.pendingRequests).toHaveLength(1);
    // Recovery rebuilt this as [], so a request applied after a reload lost
    // the user's attached Goal attempts and was deferred for review instead.
    expect(saved.authorizedGoalIds).toEqual(['goal-abc']);
});

// --------------------------------------------------------------- regenerate
//
// Every other acceptance path checks that the saved direction belongs to the
// Scene it is being replayed into; regenerate was the one that did not.

/** Completes a run and clears activeRun, which is regenerate's precondition. */
async function completeAndSettle() {
    await requestNextDirection(scene);
    await until(() => getLiveDirectionRun()?.state === 'Waiting for you');
    await stopLiveDirection();
}

function undoReceipts() {
    return listMechanicsTransactions({ timelineId: scene.timelineId })
        .flatMap((transaction) => transaction.receipts || [])
        .filter((receipt) => receipt.capability === 'transaction.undo');
}

test('regenerate refuses a saved direction that belongs to a different Scene', async () => {
    await completeAndSettle();
    expect(hp()).toBe(8);
    const savedMessage = __getChat()[0];

    const otherScene = {
        ...scene,
        id: 'scene-elsewhere',
        liveDirection: { ...scene.liveDirection },
    };
    await regenerateLastDirectedResponse(otherScene);

    // The other Scene's replay must not reverse this Scene's transaction, and
    // must not delete the message it did not produce.
    expect(undoReceipts()).toHaveLength(0);
    expect(__getChat()).toContain(savedMessage);
});

test('regenerate on the Scene that produced the direction does undo it', async () => {
    await completeAndSettle();
    expect(hp()).toBe(8);

    await regenerateLastDirectedResponse(scene);

    // Proves the guard above refuses on Scene identity rather than refusing
    // everything: the matching Scene still reverses and replays.
    expect(undoReceipts()).toHaveLength(1);
});

test('a request naming a Variable that was never advertised changes nothing and says why', async () => {
    setLiveDirectionTestAdapters({
        requestDirection: async () => ({
            ...directionEnvelope(),
            requests: [{ id: 'req-1', capability: 'variable.adjust', arguments: { variableRef: 'v1', delta: -4 }, reason: 'A positional ref.' }],
        }),
        generatePerformer: speak,
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The defect the whole-branch review found: `v1` used to resolve through
    // the inherited retrieval key and write to whatever ranked first, while
    // the diagnostic simultaneously reported it as refused.
    expect(hp()).toBe(12);
    expect(getLiveDirectionRun()?.checkpointDiagnostics?.join(' ')).toMatch(/not advertised/i);
});
