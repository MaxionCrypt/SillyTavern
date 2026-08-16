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
    getLiveDirectionUiState,
    clearLiveDirectionFailure,
    regenerateLastDirectedResponse,
    retryLiveDirection,
    sendWithoutLiveDirection,
    canSendWithoutLiveDirection,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { resolveDirectionChromeMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-chrome.js';
import {
    createVariableValue,
    getVariableValue,
    updateMechanicsProfile,
    listMechanicsTransactions,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { createTimelineGoal, linkGoalToScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { createArc, createScene, createTimeline, getScene, updateScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { createPromptRecipe, setActivePromptRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { appendDirectorEntries, readAllEntriesForOwner, readNarratorEntries } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus, __getExtensionPrompt, __clearExtensionPromptCalls } from './util/script-stub.js';
import { __setOpenAIRequestHandler } from './util/openai-stub.js';
import { __getDebugEvents, __clearDebugEvents } from './util/debug-console-stub.js';

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

/**
 * The Director's reply, in the free-form notebook shape the contract teaches
 * (direction-sources.js's PROTOCOL) — tagged lines, then a fenced state block.
 * Requests are addressed by NAME, which is the whole point of the rework, and
 * carry the exact top-level shape validateMechanicsRequest checks: `id`,
 * `capability`, `arguments` as a nested object, and a `reason`.
 */
function directorReply({ requests = null, flow = { continue: false } } = {}) {
    const state = JSON.stringify({
        requests: requests || [{
            id: 'req-1',
            capability: 'variable.adjust',
            arguments: { variableRef: "Wren's HP", delta: -4 },
            reason: 'She took the blade on her forearm.',
        }],
        flow,
    });
    return [
        '[ruling] Wren takes the blow meant for the boy.',
        '[secret] The boy already knows she will.',
        '```state',
        state,
        '```',
    ].join('\n');
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
        requestDirection: async () => directorReply(),
        generatePerformer: onSpeak,
    });
}

/**
 * Install a Director that answers over the REAL transport — core's
 * `sendOpenAIRequest` shape, through story-stream.js's streamChatPrompt and
 * live-direction's own parse — rather than through the test adapter that
 * short-circuits both. Everything about streaming (chunking, cumulative text,
 * reasoning, and what an abort mid-reply leaves behind) is only reachable
 * this way.
 *
 * @param {string[]} chunks   cumulative-text pieces, emitted in order
 * @param {(context: {index: number}) => void} [onChunkEmitted]
 *        runs after each chunk, so a test can interrupt part-way through
 */
function streamDirector(chunks, { reasoning = '', onChunkEmitted = null } = {}) {
    setLiveDirectionTestAdapters({ generatePerformer: speak });
    __setOpenAIRequestHandler(({ signal }) => async function* streamData() {
        let text = '';
        for (const [index, chunk] of chunks.entries()) {
            if (signal?.aborted) return;
            text += chunk;
            // Core's generator yields CUMULATIVE text with reasoning carried
            // on `state`, which is the shape streamChatPrompt reads.
            yield { text, state: { reasoning } };
            onChunkEmitted?.({ index, text });
        }
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
    __clearExtensionPromptCalls();
    __clearDebugEvents();
    __setOpenAIRequestHandler(null);
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
    __setOpenAIRequestHandler(null);
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
        // The ONLY request. It names the Goal, never the Variable, so the
        // address table ends the pass holding one goal entry and zero
        // variable entries.
        requestDirection: async () => directorReply({
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

// --------------------------------------- posting the user's message first
//
// beginDirection now calls sendMessageAsUser before building the Director's
// snapshot, not after the round trip returns — a real Director call has
// measured 101-202s, during which the user's own words used to be nowhere
// on screen. The trap: acceptedHistory is built from context.chat, so
// without excluding the newest entry the same text would render twice in
// the Director's prompt (once via STORY SO FAR, once via CURRENT ACTION).
//
// Both assertions below are on what the Director actually receives / when
// it receives it — not on internal bookkeeping like `insertUser` or
// `storedTurn`. The second one in particular captures state at the moment
// the (stubbed) Director is called, not after the run settles: this branch
// has already shipped a test whose named ordering property survived the
// ordering being inverted, precisely because it only checked state once
// everything had finished.

/**
 * Captures the snapshot handed to the (stubbed) Director for one submitted
 * action, and renders it through the real, pure buildDirectionSources —
 * the same function direction-sources.js's own tests exercise — so an
 * assertion here is about the compiled text the Director reads, not about
 * some intermediate shape nobody actually sends anywhere.
 */
async function capturedDirectorSourcesForAction(actionText) {
    let capturedSnapshot = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ snapshot }) => {
            capturedSnapshot = snapshot;
            return directorReply();
        },
        generatePerformer: speak,
    });
    await submitDirectedRoleplay({ scene, text: actionText });
    await until(() => getLiveDirectionRun()?.state === 'Waiting for you');
    return buildDirectionSources(capturedSnapshot, { mechanicsEnabled: true });
}

test("the user's action appears exactly once in the Director's prompt, and prior history still reaches it", async () => {
    // Seeded with a prior message on purpose. An empty chat cannot tell the
    // difference between "the newest entry was correctly excluded" and "the
    // whole history window was thrown away" — a fixture with nothing in it
    // passes the occurrences-equal-1 assertion below either way, which is
    // exactly the gap a reviewer found in an earlier version of this test.
    __getChat().push({ name: 'Wren', is_user: false, mes: 'The corridor smells of rain.', extra: {} });

    const sources = await capturedDirectorSourcesForAction('I push the door open.');

    const occurrences = sources.directorSnapshot.split('I push the door open.').length - 1;
    expect(occurrences).toBe(1);
    // The only way this passes is if acceptedHistory still carries the prior
    // turn — proof the exclusion removed the ONE entry it was supposed to
    // and nothing else.
    expect(sources.directorSnapshot).toContain('The corridor smells of rain.');
});

test("the user's message is in the chat before the Director is called", async () => {
    // Captured from INSIDE the (stubbed) Director call, which is the
    // earliest point a test can stand in for "the Director stream begins" —
    // not by inspecting the chat after submitDirectedRoleplay resolves,
    // which would prove nothing about ordering.
    let chatAtDirectorCall = null;
    setLiveDirectionTestAdapters({
        requestDirection: async () => {
            chatAtDirectorCall = __getChat().map((message) => ({ is_user: message.is_user, mes: message.mes }));
            return directorReply();
        },
        generatePerformer: speak,
    });

    await submitDirectedRoleplay({ scene, text: 'I push the door open.' });
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(chatAtDirectorCall).toEqual([{ is_user: true, mes: 'I push the door open.' }]);
});

test("an autonomous pass still sees the previous performer response in its history", async () => {
    // requestNextDirection never calls sendMessageAsUser (insertUser: false),
    // so postedMessage stays null for the whole pass and buildDirectionSnapshot
    // must exclude nothing from acceptedHistory. This is the risk the ordering
    // change itself was reviewed against: an exclusion that runs unconditionally
    // would silently hide the immediately-preceding performer response from
    // every autonomous continuation, and nothing before this test could catch
    // that — the two tests above only ever exercise a user-initiated pass.
    await completeAndSettle();
    expect(__getChat().map((message) => message.mes)).toContain(RESPONSE);

    let capturedSnapshot = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ snapshot }) => { capturedSnapshot = snapshot; return directorReply(); },
        generatePerformer: speak,
    });
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const sources = buildDirectionSources(capturedSnapshot, { mechanicsEnabled: true });
    expect(sources.directorSnapshot).toContain(RESPONSE);
});

// ------------------------------ retry and "Send Normally" after that point
//
// Posting the user's message before the Director round trip (above) means a
// failure can now land AFTER the message is already in the chat — something
// that could not happen before this task, since the old call site ran only
// once the whole pass had already succeeded. retryLiveDirection and
// sendWithoutLiveDirection both re-run against the SAME pendingFailure.action,
// and neither used to know whether that text had already landed — so both
// would post it a second time, producing a duplicate user bubble.
//
// The fix records that fact on the pending failure as `postedMessage` — the
// actual chat message object, not a boolean or a captured index — separate
// from `insertUser` (which still decides lock priority and the journal's
// user/autonomous label — a fact about what KIND of pass this is, not about
// whether THIS attempt already posted), and has beginDirection consult it
// before deciding to call sendMessageAsUser again. Cases below are asserted
// on the chat's actual contents after a retry, not on the field itself.

function userMessages() {
    return __getChat().filter((message) => message.is_user).map((message) => message.mes);
}

test('a retry after the message already posted does not duplicate it', async () => {
    // The Director itself fails, but only AFTER beginDirection has already
    // posted the user's text — the common case now that insertion runs first.
    setLiveDirectionTestAdapters({
        requestDirection: async () => { throw new Error('simulated Director failure'); },
    });
    const consoleError = console.error;
    console.error = () => {};
    try {
        await submitDirectedRoleplay({ scene, text: 'I push the door open.' });
    } finally {
        console.error = consoleError;
    }
    expect(userMessages()).toEqual(['I push the door open.']);

    setLiveDirectionTestAdapters({ requestDirection: async () => directorReply(), generatePerformer: speak });
    await retryLiveDirection();
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // Still exactly one copy — the retry read the message that was already
    // there instead of posting it again.
    expect(userMessages()).toEqual(['I push the door open.']);
});

test('a retry after generation wrote an orphaned response excludes the right entry from history', async () => {
    // The specific repro a reviewer found: generation itself writes a message
    // and the pass STILL fails afterward (a downstream error after the native
    // call already succeeded — generateDirectedPerformer propagates whatever
    // its call throws, whether or not it already produced a message).
    // context.chat's newest entry is now the PERFORMER's orphaned response,
    // not the user's — so "exclude the last entry" would strip the wrong one:
    // the user's action would stay in acceptedHistory (read twice by the
    // Director) while the orphaned response vanished from it entirely.
    setLiveDirectionTestAdapters({
        requestDirection: async () => directorReply(),
        generatePerformer: async () => {
            __getChat().push({ name: 'Wren', is_user: false, mes: 'An orphaned response.', extra: {} });
            throw new Error('generation failed after writing a message');
        },
    });
    const consoleError = console.error;
    console.error = () => {};
    try {
        await submitDirectedRoleplay({ scene, text: 'I push the door open.' });
    } finally {
        console.error = consoleError;
    }
    // Both entries are really there: the user's action, then the orphaned
    // response generation left behind before the pass still failed.
    expect(__getChat().map((message) => message.mes)).toEqual(['I push the door open.', 'An orphaned response.']);

    let capturedSnapshot = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ snapshot }) => { capturedSnapshot = snapshot; return directorReply(); },
        generatePerformer: speak,
    });
    await retryLiveDirection();
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const sources = buildDirectionSources(capturedSnapshot, { mechanicsEnabled: true });
    // The action still appears exactly once — under CURRENT ACTION — which is
    // only possible if the exclusion removed the USER's entry, not the
    // orphaned response sitting after it.
    const occurrences = sources.directorSnapshot.split('I push the door open.').length - 1;
    expect(occurrences).toBe(1);
    // And the orphaned response is a real prior turn — it must reach the
    // Director via STORY SO FAR, not be silently dropped.
    expect(sources.directorSnapshot).toContain('An orphaned response.');
});

test('a retry after an early refusal, before the message ever posted, still posts it', async () => {
    // No connection at all: beginDirection's blocked-check fails before it
    // ever reaches sendMessageAsUser, so nothing has landed in the chat yet.
    __setOnlineStatus('no_connection');
    const consoleError = console.error;
    console.error = () => {};
    try {
        await submitDirectedRoleplay({ scene, text: 'I open the window.' });
    } finally {
        console.error = consoleError;
    }
    expect(userMessages()).toEqual([]);

    __setOnlineStatus('connected');
    await retryLiveDirection();
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The retry is the first and only chance to post it — losing this would
    // silently drop the user's words rather than merely delaying them.
    expect(userMessages()).toEqual(['I open the window.']);
});

test('"Send Normally" is withheld once the message is already posted, rather than duplicating it', async () => {
    // sendWithoutLiveDirection has the identical duplication shape as retry —
    // it bypasses Direction and re-sends pendingFailure.action through core's
    // own send path, which would also post the text a second time.
    const sentNormally = [];
    initLiveDirection({ sendNormally: (text) => { sentNormally.push(text); } });
    setLiveDirectionTestAdapters({
        requestDirection: async () => { throw new Error('simulated Director failure'); },
    });
    const consoleError = console.error;
    console.error = () => {};
    try {
        await submitDirectedRoleplay({ scene, text: 'I push the door open.' });
    } finally {
        console.error = consoleError;
    }
    expect(userMessages()).toEqual(['I push the door open.']);

    expect(canSendWithoutLiveDirection()).toBe(false);
    expect(sendWithoutLiveDirection()).toBe(false);
    expect(sentNormally).toEqual([]);
    expect(userMessages()).toEqual(['I push the door open.']);
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
        requestDirection: async () => directorReply({
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

// ------------------------------------------------- the streamed Director
//
// Everything below drives the REAL transport — live-direction's own
// requestDirection, story-stream.js's streamChatPrompt, and core's
// `sendOpenAIRequest` generator shape — with only the network itself stubbed.
// The `requestDirection` test adapter used above short-circuits all three, so
// nothing it covers says anything about streaming, about what an abort
// mid-reply leaves behind, or about the parse that sits between them.

function notebook() {
    return readAllEntriesForOwner(scene.timelineId, { sceneId: scene.id });
}

function journalEntries(type) {
    return __getDebugEvents().filter((event) => event.category === 'direction' && event.type === type);
}

/** Everything the performer's prompt was given this turn, as one string. */
function performerPrompt() {
    return String(__getExtensionPrompt('remodel_director_notes') || '');
}

test('a streamed Director reply becomes notebook entries and applies its requests', async () => {
    const chunks = [
        '[ruling] Wren takes the blow',
        ' meant for the boy.\n[secret] The boy already knows.\n',
        '```state\n{"requests":[{"id":"req-1","capability":"variable.adjust",',
        '"arguments":{"variableRef":"Wren\'s HP","delta":-4},"reason":"She took the blade."}],"flow":{"continue":false}}\n```',
    ];
    streamDirector(chunks, { reasoning: 'She has to be the one who moves.' });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // 1. The reply became typed entries, and the state fence is not one of them.
    const entries = notebook();
    expect(entries.map((entry) => entry.type)).toEqual(['ruling', 'secret']);
    expect(entries[0].text).toBe('Wren takes the blow meant for the boy.');
    expect(entries.map((entry) => entry.turn)).toEqual([1, 1]);
    expect(JSON.stringify(entries)).not.toContain('```state');
    expect(JSON.stringify(entries)).not.toContain('variable.adjust');

    // 2. The request in the fence reached the real capability layer and moved
    //    the named Variable — 12 - 4.
    expect(hp()).toBe(8);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })
        .filter((transaction) => transaction.status === 'applied')).toHaveLength(1);

    // 3. The raw reply never reaches the performer. The notes block delivers
    //    the ruling; the secret, the fence and the tags stay out of it.
    const prompt = performerPrompt();
    expect(prompt).toContain('Wren takes the blow meant for the boy.');
    expect(prompt).not.toContain('The boy already knows.');
    expect(prompt).not.toContain('```state');
    expect(prompt).not.toContain('[ruling]');
    expect(prompt).not.toContain('req-1');

    // 4. The streamed reasoning arrived with the text, so it is available
    //    without a fetch patch to steal it back off the wire.
    const [notebookEvent] = journalEntries('notebook');
    expect(notebookEvent.detail.reasoningLength).toBe('She has to be the one who moves.'.length);
    expect(notebookEvent.detail.streamed).toBe(true);
    expect(notebookEvent.detail.entryCount).toBe(2);

    // 5. The record joins to the generation it directed. correlationId groups
    //    by pass; generation.start/end are keyed by directionId, so an export
    //    can only follow one turn through both records if this carries it.
    const [generationEvent] = journalEntries('generation.start');
    expect(notebookEvent.detail.directionId).toBeTruthy();
    expect(notebookEvent.detail.directionId).toBe(generationEvent.detail.directionId);
});

/**
 * What this test proves, stated precisely, because its first version claimed
 * more than it did (review I7.1).
 *
 * It proves TWO things, neither of which is "a DOM card filled":
 *
 *  1. beginDirection's onChunk closure forwards EVERY chunk to
 *     hooks.onDirectorChunk — cumulative, strictly growing, each capture a
 *     prefix of the next — rather than only the first (which used to feed a
 *     debug journal timestamp and nothing else) or a single backfill at
 *     settle time.
 *  2. Throughout that stream the Roleplay chrome is in the state that puts a
 *     Director card on screen for the hook to fill
 *     (direction-chrome.js's `resolveDirectionChromeMode` -> 'directing').
 *
 * The second one is the half that was missing and it is why the original
 * version was hollow: it replayed `updateDirectionStreamCard`'s rules INLINE
 * (`hiddenSequence = seen.map(…)`), never called that function, never created
 * a card — and drove `requestNextDirection`, which at the time was one of the
 * paths where no card was ever created at all. It was green while the named
 * behaviour was absent on the very path it used. The card's DOM writes cannot
 * be exercised from Jest (timeline-spine.js touches the DOM at module scope
 * through its imports), so the honest split is: the hook contract and the
 * chrome state here, the card's own branch in remodel-direction-chrome.test.js.
 */
test("every chunk of the Director's reply reaches the card's hook while the chrome is showing a card to fill", async () => {
    const seen = [];
    // wire()'s hooks stay in place — initLiveDirection merges into the
    // existing hooks object rather than replacing it, so this only adds
    // onDirectorChunk.
    initLiveDirection({
        onDirectorChunk: (update) => seen.push({
            text: update.text,
            reasoning: update.reasoning,
            // Resolved at the instant the chunk arrives — the moment
            // timeline-spine.js's updateDirectionStreamCard would be looking
            // for a card to write into.
            chrome: resolveDirectionChromeMode({
                run: getLiveDirectionRun(),
                uiState: getLiveDirectionUiState(scene),
            }),
        }),
    });
    setLiveDirectionTestAdapters({ generatePerformer: speak });

    // Four cumulative chunks over the real transport (streamChatPrompt →
    // sendOpenAIRequest, stubbed at the network boundary only). Reasoning is
    // empty on the first two and arrives from the third chunk on — the real
    // shape a thinking model produces (it reasons for a while before writing
    // anything conclusive), and the one shape that actually exercises
    // "hidden while empty, un-hides the moment it isn't".
    const textChunks = [
        '[ruling] Wren takes the blow',
        ' meant for the boy.\n[secret] The boy already knows.\n',
        '```state\n{"requests":[],',
        '"flow":{"continue":false}}\n```',
    ];
    const reasoningByChunk = ['', '', 'She has to be the one who moves.', 'She has to be the one who moves, fully.'];
    __setOpenAIRequestHandler(() => async function* streamData() {
        let text = '';
        for (let i = 0; i < textChunks.length; i++) {
            text += textChunks[i];
            // eslint-disable-next-line no-await-in-loop
            yield { text, state: { reasoning: reasoningByChunk[i] } };
        }
    });

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // All four chunks reached the hook — not zero, not one backfilled call.
    expect(seen).toHaveLength(textChunks.length);

    // PROPERTY 1: content changes BETWEEN chunks, growing every step and each
    // capture a strict prefix of the next. A hook that only fires once the run
    // settles would fail the length assertion above; a subtler regression that
    // fires once per chunk but always forwards the CURRENT cumulative total
    // captured at settle time is what this loop catches — text would be
    // identical (or already-final) at every step.
    for (let i = 1; i < seen.length; i++) {
        expect(seen[i].text).not.toBe(seen[i - 1].text);
        expect(seen[i].text.length).toBeGreaterThan(seen[i - 1].text.length);
        expect(seen[i].text.startsWith(seen[i - 1].text)).toBe(true);
    }
    expect(seen[0].text).toBe(textChunks[0]);
    expect(seen[seen.length - 1].text).toContain('```state');

    // PROPERTY 2 (review I1): there is a card on screen to receive all of
    // that. `requestNextDirection` is one of the four paths that used to open
    // no card at all, so this assertion is the one the original version of
    // this test was missing — it filled a card that, on this path, did not
    // exist.
    expect(seen.map((update) => update.chrome)).toEqual(new Array(textChunks.length).fill('directing'));

    // The payload the card's reasoning disclosure keys off
    // (`panel.hidden = !String(update.reasoning || '').trim()`): empty for the
    // two chunks before the model reasons, non-empty from the third on, and it
    // does not flicker back. Asserted on the values the hook RECEIVED — the
    // rule itself is applied inside updateDirectionStreamCard, which is DOM
    // code this harness cannot reach.
    expect(seen.map((update) => String(update.reasoning || '').trim() === '')).toEqual([true, true, false, false]);
});

test('an unparseable tail costs the turn its requests, not its prose', async () => {
    streamDirector([
        '[ruling] Wren takes the blow meant for the boy.\n',
        '```state\n{"requests": [oh no\n```',
    ]);

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The entries survive the broken tail…
    expect(notebook().map((entry) => entry.text)).toEqual(['Wren takes the blow meant for the boy.']);
    // …nothing mechanical happened…
    expect(hp()).toBe(12);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })).toHaveLength(0);
    // …the failure is recorded rather than swallowed…
    const [tailEvent] = journalEntries('tail.unparseable');
    expect(tailEvent).toBeTruthy();
    expect(tailEvent.detail.error).toBeTruthy();
    // …and the Narrator still ran and its prose was accepted.
    const chat = __getChat();
    expect(chat).toHaveLength(1);
    expect(chat[0].mes).toBe(RESPONSE);
    expect(performerPrompt()).toContain('Wren takes the blow meant for the boy.');
});

test('a reply with no state fence at all is not an error, and the scene waits', async () => {
    streamDirector(['[note] Nothing mechanical happened. The rain keeps on.']);

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(notebook()).toHaveLength(1);
    expect(hp()).toBe(12);
    expect(journalEntries('tail.unparseable')).toHaveLength(0);
    // Flow defaults to stopping (design §3), so the run holds for the user
    // rather than chaining another autonomous pass.
    expect(getLiveDirectionRun()?.waitingAtEnd).toBe(true);
});

test('an interrupted Director stores what arrived, marked incomplete, and applies nothing', async () => {
    // Stop lands after the second chunk — mid-sentence, and before the fence
    // that would have changed a Variable.
    streamDirector([
        '[ruling] Wren takes the blow meant for the boy.\n',
        '[note] The blade is still',
        ' rising.\n```state\n{"requests":[{"id":"req-1","capability":"variable.adjust","arguments":{"variableRef":"Wren\'s HP","delta":-4},"reason":"cut off"}],"flow":{"continue":true}}\n```',
    ], {
        onChunkEmitted: ({ index }) => {
            if (index === 1) stopLiveDirection();
        },
    });

    await requestNextDirection(scene);

    const entries = notebook();
    expect(entries.map((entry) => entry.text)).toEqual([
        'Wren takes the blow meant for the boy.',
        'The blade is still',
    ]);
    // Only the trailing entry is the severed one; the line before it was
    // closed by a newline the Director did write.
    expect(entries.map((entry) => entry.incomplete)).toEqual([false, true]);
    // The third chunk never arrived, so nothing mechanical could apply — and
    // the pass was abandoned before the performer was ever asked to speak.
    expect(hp()).toBe(12);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })).toHaveLength(0);
    expect(__getChat()).toHaveLength(0);
    expect(journalEntries('notebook')[0].detail.interrupted).toBe(true);
});

test('an interrupted Director is not read for state even when its fence did arrive', async () => {
    // The severed reply happens to contain a complete, parseable state fence:
    // the Director wrote it and was stopped while still writing after it. It
    // must not be applied. "Interrupted" is a fact about the reply, not a
    // guess about whether the fence looks finished — a Director cut off
    // mid-thought had not finished deciding, whatever its tail parses to.
    streamDirector([
        '[ruling] Wren takes the blow meant for the boy.\n',
        '```state\n{"requests":[{"id":"req-1","capability":"variable.adjust","arguments":{"variableRef":"Wren\'s HP","delta":-4},"reason":"cut off"}],"flow":{"continue":true}}\n```\n',
        '[note] And then the room went quiet.',
    ], {
        onChunkEmitted: ({ index }) => {
            if (index === 1) stopLiveDirection();
        },
    });

    await requestNextDirection(scene);

    // The fence parsed — and was ignored.
    expect(hp()).toBe(12);
    expect(listMechanicsTransactions({ timelineId: scene.timelineId })).toHaveLength(0);
    // The entries still landed, and the fence is not one of them.
    expect(notebook().map((entry) => entry.text)).toEqual(['Wren takes the blow meant for the boy.']);
    const [notebookEvent] = journalEntries('notebook');
    expect(notebookEvent.detail).toMatchObject({ interrupted: true, requestCount: 0, continueAfter: false });
});

test('a cancelled take never binds the turn that replaces it', async () => {
    // The failure this replaces: entries from a take the user stopped — which
    // produced no message and changed no state — were delivered on the NEXT
    // turn under "treat as settled fact" with "Ruling — binding:" in front of
    // them. A discarded take must not legislate.
    streamDirector([
        '[ruling] Wren will lose the arm.\n',
        '[note] The blade is still',
        ' rising.',
    ], {
        onChunkEmitted: ({ index }) => {
            if (index === 1) stopLiveDirection();
        },
    });
    await requestNextDirection(scene);
    expect(notebook()).toHaveLength(2);

    // The next turn runs normally.
    streamDirector(['[ruling] The real ruling for this turn.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const prompt = performerPrompt();
    expect(prompt).toContain('The real ruling for this turn.');
    expect(prompt).not.toContain('Wren will lose the arm.');
    expect(prompt).not.toContain('The blade is still');
    // Withheld, not erased: the owner keeps the whole record of what the
    // Director managed to say before it was stopped.
    expect(notebook().map((entry) => entry.text)).toEqual([
        'Wren will lose the arm.',
        'The blade is still',
        'The real ruling for this turn.',
    ]);
    expect(notebook().map((entry) => entry.abandoned)).toEqual([true, true, false]);
});

test('a take that stored entries and then failed does not bind the turn that follows', async () => {
    // The same defect as the interrupt case, by a route keyed on the wrong
    // thing. Pressing Stop is only ONE way a take produces nothing: here the
    // Director answers in full, its entries are stored, and the pass then
    // throws because the Scene's Narrator is no longer in the cast. No
    // message, no state change — and, before this, rulings that were live.
    streamDirector(['[ruling] A ruling from a pass that produced nothing.']);
    const performers = cast.splice(0, cast.length);
    const consoleError = console.error;
    console.error = () => {};
    try {
        await requestNextDirection(scene);
    } finally {
        console.error = consoleError;
        cast.push(...performers);
    }
    expect(__getChat()).toHaveLength(0);
    expect(notebook().map((entry) => entry.abandoned)).toEqual([true]);
    expect(journalEntries('notebook.abandoned')[0].detail).toMatchObject({ entryCount: 1 });

    // The next turn runs normally and must not read the failed take.
    clearLiveDirectionFailure();
    streamDirector(['[ruling] The turn that actually happened.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const prompt = performerPrompt();
    expect(prompt).toContain('The turn that actually happened.');
    expect(prompt).not.toContain('A ruling from a pass that produced nothing.');
});

test('a take whose generation failed keeps its notes, because the performer was already asked', async () => {
    // The boundary is "the performer was asked", not "a message survived", and
    // this is the case that decides between them: generation itself fails
    // AFTER the turn went live.
    //
    // Withholding here would be defensible on the letter of "produced
    // nothing" — and would break the more common repair. failEmptyVisibleRun
    // re-runs THIS turn against THESE notes when a provider returns empty
    // content (measured repeatedly in one recorded session), and it runs after
    // beginDirection has already returned. Notes withheld here would make that
    // retry generate with no direction at all, silently — the exact failure
    // this rework exists to end. A stale turn from a hard generation failure
    // is the cheaper mistake, and the user sees a Retry button for it.
    setLiveDirectionTestAdapters({
        generatePerformer: async () => { throw new Error('the native group generator is still busy'); },
    });
    __setOpenAIRequestHandler(() => async function* streamData() {
        yield { text: '[ruling] Asked, and the generator failed.', state: { reasoning: '' } };
    });
    const consoleError = console.error;
    console.error = () => {};
    try {
        await requestNextDirection(scene);
    } finally {
        console.error = consoleError;
    }

    expect(__getChat()).toHaveLength(0);
    expect(notebook().map((entry) => entry.abandoned)).toEqual([false]);
    expect(journalEntries('notebook.abandoned')).toHaveLength(0);
});

test('a cancelled take does not consume a slot in the Narrator depth window', () => {
    // A turn withheld in full must not also push a real turn out of view: it
    // is removed before the window is counted, unlike a secret, whose turn
    // genuinely happened.
    appendDirectorEntries('tl-window', { sceneId: 's', turn: 1, entries: [{ type: 'ruling', text: 'oldest real turn' }] });
    appendDirectorEntries('tl-window', { sceneId: 's', turn: 2, entries: [{ type: 'ruling', text: 'cancelled', abandoned: true }] });
    appendDirectorEntries('tl-window', { sceneId: 's', turn: 3, entries: [{ type: 'ruling', text: 'newest real turn' }] });

    const window = readNarratorEntries('tl-window', { sceneId: 's', depth: 2 });
    expect(window.map((entry) => entry.text)).toEqual(['oldest real turn', 'newest real turn']);
});

test('a request the mechanics layer cannot read does not void its valid siblings', async () => {
    streamDirector([[
        '[ruling] Two things happen.',
        '```state',
        '{"requests":[["not","an","object"],{"id":"req-1","capability":"variable.adjust","arguments":{"variableRef":"Wren\'s HP","delta":-4},"reason":"She took the blade."}],"flow":{"continue":false}}',
        '```',
    ].join('\n')]);

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // parseDirectorReply keeps array-shaped entries (an array IS an object),
    // and validateMechanicsRequest rejects the WHOLE batch over one of them.
    // The readable sibling still applies.
    expect(hp()).toBe(8);
});

// ------------------------------------------- regenerate and the notebook
//
// Ruled for this task: a regenerated turn replaces its predecessor's entries
// rather than appending beside them. The notebook must never hold two takes'
// rulings for one moment in the fiction, because the Narrator reads both.

test('regenerate reuses the same notebook turn rather than writing a second one', async () => {
    streamDirector(['[ruling] Wren takes the blow meant for the boy.']);
    await completeAndSettle();
    expect(notebook()).toHaveLength(1);
    const before = notebook()[0];

    await regenerateLastDirectedResponse(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // Same turn, same entry — and no second Director call, which on the
    // owner's own connection measured 101–202 seconds.
    const after = notebook();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].turn).toBe(1);
});

test('a regenerate that has to re-direct discards the superseded take rather than stacking on it', async () => {
    streamDirector(['[ruling] The first take.']);
    await completeAndSettle();
    const [first] = notebook();
    expect(first.text).toBe('The first take.');

    // The Narrator card left the Scene between takes, so the saved direction
    // cannot be replayed and regenerate has to re-direct. THIS is the path
    // where a discarded take's notes would otherwise linger beside the new
    // turn's — two takes' rulings for one moment in the fiction, and the
    // Narrator reads both.
    const performers = cast.splice(0, cast.length);
    streamDirector(['[ruling] The second take.']);
    const consoleError = console.error;
    console.error = () => {};
    try {
        await regenerateLastDirectedResponse(scene);
    } finally {
        console.error = consoleError;
        cast.push(...performers);
    }

    const after = notebook();
    expect(after.map((entry) => entry.text)).toEqual(['The second take.']);
    expect(after[0].id).not.toBe(first.id);
    // And it took the discarded take's turn number back, so the Narrator's
    // depth window still counts one turn for one moment.
    expect(after[0].turn).toBe(1);
    expect(journalEntries('notebook.discarded')[0].detail).toMatchObject({ turn: 1, entryCount: 1 });
});

test('a retake of an earlier moment is filed under that moment, not after the turns that follow it', async () => {
    // The regenerate-discard test above cannot see this: its notebook only
    // ever holds one turn, which is exactly the case where "one past the
    // highest" happens to equal the freed number.
    //
    // Reaching the real case needs a turn ABOVE the one being retaken, which
    // an interrupted pass produces for free: it consumes a turn number and
    // writes no message, so the chat's last message is no longer the highest
    // turn. Recomputing max+1 then files the retake of the EARLIER moment as
    // the NEWEST turn, and groupNotebookEntriesByTurn hands the Narrator the
    // fiction out of order.
    streamDirector(['[ruling] Turn one.']);
    await completeAndSettle();

    streamDirector(['[ruling] A take that was cancelled.', ' And more.'], {
        onChunkEmitted: ({ index }) => {
            if (index === 0) stopLiveDirection();
        },
    });
    await requestNextDirection(scene);
    expect(notebook().map((entry) => entry.turn)).toEqual([1, 2]);

    // The chat's last message is still turn ONE's. Regenerate it on the
    // re-direct branch, with turn 2 sitting above it in the notebook.
    const performers = cast.splice(0, cast.length);
    streamDirector(['[ruling] Turn one, retaken.']);
    const consoleError = console.error;
    console.error = () => {};
    try {
        await regenerateLastDirectedResponse(scene);
    } finally {
        console.error = consoleError;
        cast.push(...performers);
    }

    const retake = notebook().find((entry) => entry.text === 'Turn one, retaken.');
    expect(retake).toBeTruthy();
    // 1, because that is the moment it is a retake OF. Recomputing max+1 files
    // it as 3 — after a turn that happened later than the one it replaces.
    expect(retake.turn).toBe(1);
    expect(notebook().map((entry) => entry.text)).not.toContain('Turn one.');
});

test('consecutive passes advance the notebook turn', async () => {
    // Every other notebook assertion in this suite lives inside turn 1, so
    // `nextNotebookTurn` returning a constant would satisfy all of them —
    // including the regenerate assertions, which is why the ordering defect
    // above went unnoticed. This is the test that a constant cannot pass.
    streamDirector(['[ruling] First.']);
    await completeAndSettle();
    streamDirector(['[ruling] Second.']);
    await completeAndSettle();
    streamDirector(['[ruling] Third.']);
    await completeAndSettle();

    expect(notebook().map((entry) => entry.turn)).toEqual([1, 2, 3]);
    // Depth is what turn numbering feeds: three distinct turns, not three
    // entries in one.
    expect(readNarratorEntries(scene.timelineId, { sceneId: scene.id, depth: 2 }).map((entry) => entry.text))
        .toEqual(['Second.', 'Third.']);
});

test('a Director that returns nothing at all is reported rather than silently directing nothing', async () => {
    const failures = [];
    initLiveDirection({ onFailure: (error) => failures.push(error) });
    streamDirector(['']);
    const consoleError = console.error;
    console.error = () => {};
    try {
        await requestNextDirection(scene);
    } finally {
        console.error = consoleError;
    }

    expect(failures).toHaveLength(1);
    expect(String(failures[0].message)).toMatch(/returned nothing at all/i);
    expect(notebook()).toHaveLength(0);
    expect(__getChat()).toHaveLength(0);
});

test('a turn whose notes nothing will carry says so instead of generating in silence', async () => {
    // Since the depth-0 injection was removed, the Director's Notes block is
    // the ONLY route direction takes to the Narrator. A recipe without one
    // looks completely healthy from outside — notebook fills, card renders,
    // prose generates — so the absence has to be reported, or it is
    // indistinguishable from a Director that had nothing to say.
    const recipe = createPromptRecipe({
        name: 'RP without notes', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'message', role: 'instruction', content: 'no notes block here' }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);

    streamDirector(['[ruling] Nobody will ever read this.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The turn ran and stored its entries…
    expect(notebook()).toHaveLength(1);
    expect(performerPrompt()).toBe('');
    // …and said, once, that they reach no one.
    const [warning] = journalEntries('notes.unrouted');
    expect(warning).toBeTruthy();
    expect(warning.severity).toBe('warn');
    expect(warning.detail.entryCount).toBe(1);
    expect(warning.detail.remedy).toMatch(/Director's Notes/);
});

test('the warning stays quiet when a block is there to carry the notes', async () => {
    // Proves the warning discriminates rather than firing on every pass.
    streamDirector(['[ruling] Someone will read this.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(performerPrompt()).toContain('Someone will read this.');
    expect(journalEntries('notes.unrouted')).toHaveLength(0);
});

test('switching the notes block off is a choice, not a warning repeated every turn', async () => {
    // The eye toggle is a visible control the user just used. Warning them
    // once per pass for a decision they made teaches them to skip the warning,
    // which costs it the missing-block case it exists for.
    const recipe = createPromptRecipe({
        name: 'RP notes disabled', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: false, settings: { depth: 3 } }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);

    streamDirector(['[ruling] Deliberately unread.']);
    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // Delivered to no one, exactly as the user asked…
    expect(performerPrompt()).toBe('');
    // …and silently, because they asked.
    expect(journalEntries('notes.unrouted')).toHaveLength(0);
});

test('reasoning survives a connection that answers in one piece instead of streaming', async () => {
    // The deleted fetch patch captured reasoning regardless of streaming.
    // Every user with SillyTavern's streaming toggle off — plus o1 and Workers
    // AI JSON mode — gets a whole response object rather than a generator, and
    // returning '' there would leave the direction card's reasoning
    // permanently blank for them while everything else looked fine.
    setLiveDirectionTestAdapters({ generatePerformer: speak });
    __setOpenAIRequestHandler(() => ({
        choices: [{
            message: {
                content: '[ruling] Wren steps in.',
                reasoning_content: 'She is the only one close enough.',
            },
        }],
    }));

    await requestNextDirection(scene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const [notebookEvent] = journalEntries('notebook');
    expect(notebookEvent.detail.streamed).toBe(false);
    expect(notebookEvent.detail.reasoningLength).toBe('She is the only one close enough.'.length);
    // And the one-piece text still parsed into the notebook.
    expect(notebook().map((entry) => entry.text)).toEqual(['Wren steps in.']);
});

// ------------------------------------ the direction card is a second surface
//
// persistDirectionRecord writes the turn's notebook into the Scene's
// directionLog, and timeline-spine renders that record's `objective` inline in
// the Roleplay stream. That is a NEW place a `secret` could surface, created by
// this task — and the design names secret leakage as the risk most in need of a
// test that fails if it ever happens. This one drives the real record through a
// real Scene in the real timeline store, because `updateScene` writes nothing
// for a Scene that does not exist in it.

test('a secret never reaches the direction card the user reads beside the prose', async () => {
    const timeline = createTimeline('Card Timeline');
    const arc = createArc(timeline.id, 'Card Arc');
    const realScene = createScene(arc.id, 'roleplay', 'Card Scene');
    updateScene(realScene.id, {
        staging: 'directed',
        liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
    });
    const directedScene = getScene(realScene.id);
    initLiveDirection({ getActiveScene: () => directedScene });

    streamDirector([
        '[ruling] Wren steps in front of the boy.\n',
        '[secret] The boy is the one who called them here.',
    ]);
    await requestNextDirection(directedScene);
    expect(await until(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    const [record] = getScene(realScene.id).liveDirection.directionLog;
    expect(record).toBeTruthy();
    // The card carries the direction the user is entitled to read…
    expect(record.objective).toContain('Wren steps in front of the boy.');
    // …and not the one entry whose whole purpose is that it stays hidden.
    expect(record.objective).not.toContain('The boy is the one who called them here.');
    expect(JSON.stringify(record)).not.toContain('called them here');
    // The secret is still stored — withheld from surfaces, not discarded.
    expect(readAllEntriesForOwner(timeline.id, { sceneId: realScene.id }).map((entry) => entry.type))
        .toEqual(['ruling', 'secret']);
});
