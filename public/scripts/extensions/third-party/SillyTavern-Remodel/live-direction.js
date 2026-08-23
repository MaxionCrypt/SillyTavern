import { getMaxResponseTokens, main_api, online_status, sendMessageAsUser } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { generateGroupWrapper, is_group_generating } from '../../../group-chats.js';
import {
    executeMechanicsRequest,
    getCapabilityDictionary,
    MECHANICS_PROTOCOL,
    undoMechanicsTransaction,
} from './mechanics-capabilities.js';
import { buildMechanicalSnapshot, previewMechanicalContext } from './mechanics-runtime.js';
import { buildLoomContext } from './loom-context.js';
import { resolveByName } from './direction-address.js';
import { resolveDirectionActions } from './turn-chrome.js';
import { deriveBeats } from './direction-beats.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe, recordLoomPromptTranscript } from './prompt-studio.js';
import { repairDirectedNarratorRoles } from './narrator-history.js';
import { getMechanicsProfile, listMechanicsTransactions } from './variables-store.js';
import { readDirectionUnit, sanitizeDirectionText, stripEchoedScaffolding } from './live-direction-markers.js';
import { streamChatPrompt } from './story-stream.js';
import { buildEmptyResponseNudge, buildNarratorArchivistSections, buildGoalObjectives } from './narrator-prompt.js';
import { applySwaps, describeLoomReply, buildLoomPrompt, buildLoomRecipeSources, parseLoomReply, readLoomProse } from './loom-reconciliation.js';
import { describeBudgetWarning, describeGenerationBudget } from './generation-budget.js';
import { createLoomTurnEnvelope } from './loom-turn.js';
import { updateScene } from './timeline-state.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';

export const DIRECTION_PROTOCOL = 'remodel-direction/1';
const PACING = Object.freeze({
    slow: { cps: 28, wordMs: 35, min: 700, max: 2200, opening: 750 },
    natural: { cps: 45, wordMs: 25, min: 400, max: 1400, opening: 600 },
    fast: { cps: 75, wordMs: 12, min: 150, max: 650, opening: 350 },
    instant: { cps: Infinity, wordMs: 0, min: 0, max: 0, opening: 0 },
});
const ARCHIVE_CAPABILITIES = new Set([
    'scene.set', 'scene.clear', 'event.record',
    'char_state.set', 'char_state.clear', 'beat.set',
    'secret.set', 'secret.clear',
]);
const archiveCatchups = new Map();

const hooks = {
    getActiveScene: () => null,
    getCast: () => [],
    getPersona: () => null,
    ensureSceneReady: async () => true,
    getComposerDraft: () => '',
    clearComposer: () => {},
    sendNormally: () => {},
    onStateChange: () => {},
    onSettled: () => {},
    // Writes one of Remodel's own native prompts. Injected as a hook rather
    // than imported, because prompt-studio.js reaches oai_settings and this
    // module is driven from timeline-spine.js, which already owns that seam.
    setNativePromptContent: () => false,
    activateConnectionProfile: async () => null,
    // A response landed after a failure was reported. The notice is stale.
    onRecovered: () => {},
    onFailure: () => {},
    // Fires on every chunk of the Loom's own streamed reply — cumulative
    // { text, reasoning }, same shape story-stream.js's onChunk already
    // hands callers. No-op by default so a caller that never registers one
    // costs nothing; timeline-spine.js registers updateDirectionStreamCard.
};

let initialized = false;
let activeRun = null;
let revealTimer = null;
let persistTimer = null;
let pendingFailure = null;
// Per-scene: did the last turn's Narrator return no reasoning? Surfaced by
// getLiveDirectionUiState so the toolbar can warn that extraction ran prose-only.
const reasoningAbsentByScene = new Map();
let performerOverride = null;
let ownedGenerationDepth = 0;
let pendingSubmission = null;
let testAdapters = null;

/**
 * The hidden half of a direction pass — everything before a visible run exists.
 *
 * WHY THIS EXISTS: `activeRun` is assigned only in generateDirectedPerformer,
 * which is reached after the Loom round-trip. That call is a real request
 * costing many seconds, and for its entire duration `activeRun` was null. Every
 * entry point guards on `activeRun`, so all of them — Send, Next, Continue,
 * autoplay — saw an idle pipeline and happily started a second one. Two
 * concurrent passes produce two performer generations (two bubbles), and the
 * loser is orphaned: the winner overwrites `activeRun`, so the loser's message
 * never reaches finalizeRunMessage and keeps its raw markers.
 *
 * The lock deliberately covers ONLY the hidden phase. It is released the moment
 * `activeRun` exists, because interrupting a revealing response is a feature,
 * not a collision — `activeRun` is the correct guard from that point on.
 */
let directionInFlight = null;

/**
 * Autoplay's handle. Previously an uncancellable setTimeout: Stop, an
 * interruption, or leaving the Scene all left it armed, so a chain the user had
 * ended fired anyway and spoke over whatever came next.
 */
let autoplayTimer = null;

/** Correlate every record of one pass under its directionId. */
function journal(type, detail = {}, { severity = 'info', correlationId = null, summary = '' } = {}) {
    try {
        recordDebugEvent('direction', type, detail, {
            severity,
            correlationId: correlationId || directionInFlight?.id || activeRun?.directionId || null,
            summary: summary || type,
        });
    } catch {
        // Diagnostics must never be able to break a generation.
    }
}

function journalResponse(mode, detail, { correlationId = null, purpose = mode } = {}) {
    try {
        recordApiTranscript('response', { mode, purpose, ...detail }, {
            type: `api.response.${mode}`,
            correlationId: correlationId || directionInFlight?.id || activeRun?.directionId || null,
            summary: `${mode === 'loom' ? 'Loom' : 'Narrator'} response received${purpose !== mode ? ` (${purpose})` : ''}`,
        });
    } catch {
        // Diagnostics must never be able to break a generation.
    }
}

function acquireDirectionLock({ scene, insertUser, autonomousSequence }) {
    const token = {
        id: createId('direction-pass'),
        sceneId: scene?.id || null,
        // A user intervention outranks an autonomous continuation; an
        // autonomous pass never outranks anything.
        userInitiated: Boolean(insertUser),
        autonomousSequence: Number(autonomousSequence) || 0,
        startedAt: Date.now(),
        aborted: false,
        // The Loom now streams, so `aborted` is no longer only a flag the
        // pass checks between stages: it has to reach the open request itself.
        // Without this, pressing Stop during a two-minute Loom call left
        // the request running to completion and merely discarded its answer.
        controller: new AbortController(),
    };
    directionInFlight = token;
    return token;
}

/**
 * Cancel a pass: raise the flag every stage boundary checks AND abort the
 * request that may be open right now. Both, always — a caller that raises only
 * the flag leaves a stream running with nobody waiting for it.
 */
function abortDirectionPass(token) {
    if (!token) return;
    token.aborted = true;
    try {
        token.controller?.abort();
    } catch {
        // An already-aborted controller is the normal case for a second Stop.
    }
}

/** Idempotent, and never releases a lock some later pass already took. */
function releaseDirectionLock(token) {
    if (token && directionInFlight === token) directionInFlight = null;
}

function cancelAutoplay(reason = 'superseded') {
    if (!autoplayTimer) return false;
    clearTimeout(autoplayTimer);
    autoplayTimer = null;
    journal('autoplay.cancelled', { reason });
    return true;
}

// Browser tests may replace only the two nondeterministic model boundaries.
// Production never calls this; clearing with null immediately restores the
// native generateRaw/generate path.
export function setLiveDirectionTestAdapters(adapters = null) {
    testAdapters = adapters && typeof adapters === 'object' ? adapters : null;
}

export function initLiveDirection(options = {}) {
    Object.assign(hooks, Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value === 'function')));
    if (initialized) return;
    initialized = true;
    const context = getContext();
    context.eventSource.on(context.eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        const messageId = Number(context.streamingProcessor?.messageId);
        if (Number.isInteger(messageId)) activeRun.messageId = messageId;
        acceptNativeBuffer(text);
    });
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, (messageId) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        const id = Number(messageId);
        const message = context.chat?.[id];
        if (!message || message.is_user) return;
        activeRun.messageId = id;
        acceptNativeBuffer(message.mes);
    });
    // The Narrator is a passive voice (see the module doc on
    // narrator-history.js): it renders what the Loom decided, informed
    // only by its OWN prior prose, never by the user's words or another cast
    // member's. Everything the user did reaches it solely through the
    // Loom's notes, which arrive as a separate injected system-role entry
    // (setNativePromptContent('loomNotes', …) above) — not through
    // this array — so this listener only ever narrows chat history, never
    // context.chat itself (still the true record other surfaces read) and
    // never the notes block.
    //
    // Guarded exactly like the listeners above: this fires for every native
    // Chat Completion request in the app, not only the directed performer's,
    // so it must do nothing outside the window Remodel's own
    // generateDirectedPerformer owns. Remodel's OWN hidden calls (the
    // Loom's own request, Story prose) go out through story-stream.js's
    // sendOpenAIRequest directly and never reach prepareOpenAIMessages, so
    // they never fire this event at all — only the visible performer's native
    // context.generate()/generateGroupWrapper call does.
    context.eventSource.on(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        if (!eventData || !Array.isArray(eventData.chat)) return;
        // NOTHING IS REWRITTEN HERE, and two hard-won facts explain why.
        //
        // 1. filterNarratorHistory used to be applied by REASSIGNING
        //    eventData.chat. That is inert: openai.js holds `chat` in a const and
        //    returns its own reference, so every user message the filter claimed
        //    to drop went out on the wire regardless. Confirmed by capturing the
        //    request body. A rewrite here must splice IN PLACE to have any effect.
        //
        // 2. Hoisting the trailing system blocks above the last spoken turn was
        //    tried, to stop the model echoing them back. It made things worse: on
        //    a Continue there is no new user message, so the request then ended on
        //    the assistant's OWN previous prose and the model returned 12-94
        //    character fragments. Those trailing blocks are not noise — on a
        //    Continue they are the only thing instructing the model to write.
        //
        // Whether the Narrator should see the user at all, and how to stop the
        // echo, are live questions. Neither is answered by silently reshaping
        // every prompt.
    });
    const finish = () => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        if (activeRun.phase === 'narrator') {
            activeRun.narratorGenerationFinished = true;
            return;
        }
        activeRun.generationFinished = true;
        activeRun.generationSettled = true;
        scheduleReveal(0);
    };
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, finish);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, finish);
    const recover = () => setTimeout(recoverLiveDirectionMessages, 0);
    context.eventSource.on(context.eventTypes.CHAT_LOADED, recover);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, recover);
    recoverLiveDirectionMessages();
}

/**
 * Why a native performer request would go nowhere, or '' when it can run.
 *
 * `generateGroupWrapper` opens with `if (online_status === 'no_connection')
 * return Promise.resolve()` (group-chats.js). No throw, no toast, no event —
 * it just resolves having done nothing, and `Generate()` has no matching guard
 * of its own, so the caller sees a completed generation that produced no
 * message. Directed sends then blame the performer ("X did not produce a
 * response") and Free play spins its indicator forever waiting on a
 * GENERATION_ENDED that will never arrive.
 *
 * The trap is that Remodel's Loom and mechanics calls go through
 * `generateRawData`, which fetches the backend directly and never consults
 * `online_status`. So with Auto-connect off — or after any reload that leaves
 * SillyTavern disconnected — the hidden passes all succeed while every visible
 * performer silently produces nothing. Name it instead of guessing.
 */
export function describeNativeGenerationBlock() {
    if (main_api !== 'openai') {
        return 'Roleplay generation requires the current Chat Completion connection.';
    }
    if (online_status === 'no_connection') {
        return 'SillyTavern is not connected to your API, so no performer can speak. Open the API panel (the plug icon) and press Connect — or turn on Auto-connect so it reconnects after a reload. Direction still runs while disconnected because it calls the backend directly, which is why only the visible reply goes missing.';
    }
    return '';
}

export function isDirectedLiveScene(scene = hooks.getActiveScene()) {
    return Boolean(scene?.mode === 'roleplay' && scene.staging === 'directed' && scene.liveDirection?.enabled !== false);
}

export function ownsLiveDirectionGeneration() {
    return ownedGenerationDepth > 0;
}

export function getLiveDirectionRun() {
    return activeRun ? structuredClone(publicRun(activeRun)) : null;
}

export function getLiveDirectionUiState(scene = hooks.getActiveScene()) {
    if (!isDirectedLiveScene(scene)) return { active: false, state: 'Free play', pacing: scene?.liveDirection?.pacing || 'natural', mode: 'loom' };
    // A hidden Loom pass is a busy pipeline with no visible run yet. It used
    // to report 'Ready' with Stop disabled, which is what invited the second
    // send that produced a second bubble — notifyTransient('Directing') is a
    // one-shot push, and any re-render (onSettled calls renderRoleplayScene)
    // repainted this idle state straight over it.
    const directing = Boolean(directionInFlight && !activeRun);
    return {
        active: true,
        state: activeRun?.state || (directing ? 'Directing' : 'Ready'),
        pacing: scene.liveDirection?.pacing || 'natural',
        mode: 'loom',
        openingLabel: activeRun?.openingLabel || '',
        canContinue: activeRun?.state === 'Waiting for you',
        canSend: !directing,
        canStop: directing || Boolean(activeRun && !['Ready', 'Complete'].includes(activeRun.state)),
        performerLabel: activeRun?.performer?.label || '',
        // True when the last turn's Narrator produced no reasoning — extraction
        // ran on prose alone, which is less accurate. The toolbar surfaces this
        // as a prompt to enable thinking or switch to a reasoning-capable model.
        reasoningWarning: reasoningAbsentByScene.get(String(scene.id)) === true,
    };
}

export function clearLiveDirectionFailure() {
    pendingFailure = null;
}

export function setLiveDirectionPacing(scene, pacing) {
    if (!scene || !PACING[pacing]) return false;
    updateScene(scene.id, { liveDirection: { ...scene.liveDirection, pacing } });
    if (activeRun?.sceneId === scene.id) activeRun.pacing = pacing;
    notifyState();
    return true;
}

export function setLiveDirectionMode(scene, mode) {
    // 'loom' is the only engine; the old two-agent and solo engines
    // have been removed.
    if (!scene || mode !== 'loom') return false;
    updateScene(scene.id, { liveDirection: { ...scene.liveDirection, mode } });
    notifyState();
    return true;
}

export function setLiveDirectionEnabled(scene, enabled) {
    if (!scene) return false;
    updateScene(scene.id, { staging: enabled ? 'directed' : 'free', liveDirection: { ...scene.liveDirection, enabled: Boolean(enabled) } });
    notifyState();
    return true;
}

export function setNextPerformerOverride(ref) {
    performerOverride = ref ? normalizeRef(ref) : null;
}

export async function submitDirectedRoleplay({ scene, text, authorizedGoalIds = [] } = {}) {
    if (!isDirectedLiveScene(scene)) return false;
    const action = String(text || '');
    if (!action.trim()) return false;
    const submissionKey = `${scene.id}\n${action.trim()}`;
    if (pendingSubmission === submissionKey) {
        return false;
    }
    // An armed autoplay continuation is not the user's turn. Disarm it before
    // anything else so it cannot fire alongside this intervention.
    cancelAutoplay('user-intervention');
    // A hidden pass is already running. If it is the world continuing on its
    // own, the user outranks it and it is abandoned. If it is the user's own
    // previous send still directing, this is a double-submit and is refused —
    // starting a second pipeline is exactly what produced two bubbles.
    if (directionInFlight) {
        if (directionInFlight.userInitiated) {
            journal('submit.rejected', { reason: 'a user-initiated direction is already in flight' }, { severity: 'warn' });
            return false;
        }
        journal('submit.supersedes-autonomous', { supersededPassId: directionInFlight.id });
        abortDirectionPass(directionInFlight);
        directionInFlight = null;
    }
    pendingSubmission = submissionKey;
    try {
        if (activeRun?.acceptedComplete) {
            await finalizeRunMessage(activeRun, { state: 'complete' });
            activeRun = null;
            notifyState();
        } else if (activeRun) {
            await interruptLiveDirection({ preserveForIntervention: true });
        }
        return await beginDirection({ scene, action, insertUser: true, authorizedGoalIds, autonomousSequence: 0 });
    } finally {
        if (pendingSubmission === submissionKey) pendingSubmission = null;
    }
}

/**
 * @param {object} scene
 * @param {{notebookTurn?: number|null}} [options] `notebookTurn` files this
 *        pass's entries under an existing turn number instead of a new one.
 *        Regenerate supplies it after discarding the superseded take, so the
 *        retake occupies the moment it is a retake OF.
 */
export async function requestNextDirection(scene = hooks.getActiveScene(), { notebookTurn = null } = {}) {
    if (!isDirectedLiveScene(scene) || activeRun && !['Waiting for you', 'Complete'].includes(activeRun.state)) return false;
    // Guarded as well as activeRun: between a completed reveal and the moment a
    // new run exists there is a multi-second hidden window in which activeRun is
    // null, and Next used to sail straight through it into a parallel pass.
    if (directionInFlight) {
        journal('next.rejected', { reason: 'a direction is already in flight', passId: directionInFlight.id }, { severity: 'warn' });
        return false;
    }
    cancelAutoplay('manual-next');
    const sequence = activeRun?.autonomousSequence || 0;
    if (activeRun?.messageId != null) await finalizeRunMessage(activeRun, { state: 'complete' });
    activeRun = null;
    return beginDirection({ scene, action: '[Continue the scene from accepted history.]', insertUser: false, autonomousSequence: sequence, notebookTurn });
}

export function handleLiveDirectionDraft(value) {
    if (!activeRun) return;
    const meaningful = Boolean(String(value || '').trim());
    if (meaningful) {
        if (activeRun.holdReason !== 'hard') {
            activeRun.holdReason = 'typing';
            activeRun.state = 'Held while you write';
            clearRevealTimer();
            persistRun(activeRun, true);
            notifyState();
        }
        return;
    }
    if (activeRun.holdReason === 'typing') {
        activeRun.holdReason = '';
        activeRun.state = 'Speaking';
        notifyState();
        scheduleReveal(0);
    }
}

export function continueLiveDirection() {
    if (!activeRun || activeRun.state !== 'Waiting for you') return false;
    if (activeRun.waitingAtEnd) {
        requestNextDirection(hooks.getActiveScene());
        return true;
    }
    activeRun.holdReason = '';
    activeRun.state = 'Speaking';
    activeRun.openingLabel = '';
    notifyState();
    scheduleReveal(0);
    return true;
}

export async function stopLiveDirection() {
    const stoppedAutoplay = cancelAutoplay('stopped');
    // Stop must also reach a pass that has not produced a visible run yet,
    // otherwise pressing Stop during the Loom call did nothing and the
    // performer spoke anyway a few seconds later.
    if (directionInFlight) {
        journal('stopped.in-flight', { passId: directionInFlight.id });
        abortDirectionPass(directionInFlight);
        directionInFlight = null;
        notifyState();
        hooks.onSettled();
        if (!activeRun) return true;
    }
    if (!activeRun) return stoppedAutoplay;
    await interruptLiveDirection({ preserveForIntervention: false });
    return true;
}

/**
 * `retry` (== the failed pass's `pendingFailure`) carries `postedMessage`
 * forward unchanged — the actual chat message object beginDirection posted,
 * or `null` if it never got that far. beginDirection reads it back out to
 * decide whether `sendMessageAsUser` needs to run again. No branching needed
 * HERE: whether the text is already in the chat, and which entry it is, are
 * beginDirection's (and buildDirectionSnapshot's) questions to answer, not
 * this function's to guess at.
 */
/**
 * Retry: re-run the last turn IN PLACE, discarding what it produced.
 *
 * Which step that is comes from the same pure resolver the buttons are
 * labelled from, so the button and the action cannot disagree about what
 * "last" means — they read one function.
 */
export async function retryLiveStep(scene = hooks.getActiveScene()) {
    const { retry } = resolveDirectionActions(describeDirectionStep(scene));
    if (retry.target === 'narrator') return regenerateLastDirectedResponse(scene);
    journal('retry.rejected', { reason: retry.reason }, { severity: 'warn' });
    return false;
}

/**
 * Continue: advance to the next turn, touching nothing that already exists.
 */
export async function continueLiveStep(scene = hooks.getActiveScene()) {
    const { continue: advance } = resolveDirectionActions(describeDirectionStep(scene));
    // One control, two meanings: a held reveal resumes where it stopped, an
    // idle scene advances to the next turn. Resolved from the same function
    // the button is labelled from, so the two cannot disagree.
    if (advance.target === 'resume') return continueLiveDirection();
    if (advance.target === 'loom') return requestNextDirection(scene);
    journal('continue.rejected', { reason: advance.reason }, { severity: 'warn' });
    return false;
}

/** The inputs resolveDirectionActions needs, read from the chat. */
function describeDirectionStep() {
    const chat = getContext().chat || [];
    const last = chat[chat.length - 1];
    return {
        hasMessages: chat.length > 0,
        lastMessageIsUser: Boolean(last?.is_user),
        busy: Boolean(directionInFlight || activeRun && !['Waiting for you', 'Complete'].includes(activeRun.state)),
        // continueLiveDirection() is the only thing that can clear a hold, and
        // it refuses unless the run is actually waiting — so this mirrors its
        // guard rather than guessing, and the button cannot offer a resume the
        // handler would then decline.
        resumable: Boolean(activeRun && activeRun.state === 'Waiting for you'),
    };
}

/** What Retry and Continue would do right now, for labelling the buttons. */
export function describeLiveStepActions(scene = hooks.getActiveScene()) {
    return resolveDirectionActions(describeDirectionStep(scene));
}

export async function retryLiveDirection() {
    if (directionInFlight) {
        journal('retry.rejected', { reason: 'a direction is already in flight' }, { severity: 'warn' });
        return false;
    }
    const retry = pendingFailure;
    pendingFailure = null;
    if (!retry) return false;
    return beginDirection(retry);
}

/**
 * Bypasses Direction entirely and sends `retry.action` through core's own
 * send flow (`hooks.sendNormally`), which posts the text itself.
 *
 * Refused when `postedMessage` is set: the text is already in the chat
 * (beginDirection posted it before this pass failed), and sendNormally would
 * post it a SECOND time — there is nothing left for this bypass to do. Retry
 * is the recovery action for that case, and it already knows not to re-post
 * either. canSendWithoutLiveDirection hides the button for the same reason,
 * so reaching here with `postedMessage` set should not happen in the UI —
 * refused anyway, since a caller other than the button should not have to
 * re-derive this rule to stay safe.
 */
export function sendWithoutLiveDirection() {
    const retry = pendingFailure;
    pendingFailure = null;
    if (!retry?.insertUser || retry.postedMessage) return false;
    hooks.sendNormally(retry.action);
    return true;
}

/**
 * Discard a direction from the stream: remove its direction log record,
 * discard its notebook turn, and clear any standing direction it left behind.
 *
 * Used when the user dismisses a direction card — typically a direction whose
 * Narrator generation failed and cannot be retried, or one the user simply
 * wants to undo so they can retype their message.
 */
/**
 * Whether the pending failure has user text a bypass could actually send.
 *
 * A failure on an autonomous continuation has none — there is no intervention
 * to re-send — so offering "Send Normally" there is a button that cannot do
 * anything when clicked. Same reasoning when the text is already posted
 * (`postedMessage`): the bypass would only duplicate it, so the button is
 * withheld and Retry is left as the one recovery action for that case.
 */
export function canSendWithoutLiveDirection() {
    return Boolean(pendingFailure?.insertUser) && !pendingFailure?.postedMessage;
}

export async function regenerateLastDirectedResponse(scene = hooks.getActiveScene()) {
    if (!isDirectedLiveScene(scene) || directionInFlight) return false;
    // A SETTLED run stays in activeRun so the finished turn keeps its chrome.
    // Loom envelopes are built with hardPauseAfter: true, so `hard` in
    // completeVisibleRun is always true and that is EVERY completed turn, not
    // an edge case. Refusing whenever activeRun was merely truthy therefore
    // made Retry a no-op after every turn — silently, because
    // describeDirectionStep reports those same states as not-busy and left the
    // button enabled. Accept exactly the states requestNextDirection advances
    // from, so Retry and Continue cannot disagree about when a turn is over.
    if (activeRun && !['Waiting for you', 'Complete'].includes(activeRun.state)) return false;
    cancelAutoplay('regenerate');
    const context = getContext();
    const messageId = context.chat.length - 1;
    const message = context.chat[messageId];
    const saved = message?.extra?.remodelDirection;
    if (!saved || message.is_user) return false;
    // Every other acceptance path checks this — applyPendingRequests refuses
    // when `scene.id !== run.sceneId`. Without it here, regenerate undoes
    // another Scene's transactions, re-attaches that Scene's advertised
    // address book, and hands it to generateDirectedPerformer, which stamps
    // the CURRENT Scene's id onto the result. A cross-Timeline replay fails
    // closed on requireVariable/requireGoal, but a same-Timeline replay into a
    // different Scene would succeed against a set this Scene never advertised.
    // Nothing structurally prevents two Scenes resolving to the same chat.
    if (saved.sceneId && saved.sceneId !== scene.id) {
        journal('regenerate.rejected', {
            reason: 'the saved direction belongs to a different Scene',
            savedSceneId: saved.sceneId,
            sceneId: scene.id,
        }, { severity: 'warn' });
        return requestNextDirection(scene);
    }
    const transactionIds = [...(saved.checkpointTransactionIds || [])].reverse();
    const transactions = listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id });
    for (const id of transactionIds) {
        const tx = transactions.find((item) => item.id === id);
        if (tx) undoMechanicsTransaction(tx);
    }
    // Release the settled run before its message goes. requestNextDirection
    // below finalizes whatever activeRun still points at, and once this row is
    // deleted that index names a different turn's message.
    activeRun = null;
    await context.deleteMessage(messageId);
    // Re-run the turn fresh: the Narrator drafts again and the Loom reconciles.
    // Undoing the transaction above already rolled back this turn's Archive
    // events and mechanics atomically, so the retake starts clean. It reuses the
    // same turn number rather than allocating a new one (a retake, not a new
    // turn).
    const savedTurn = toTurnNumber(saved.envelope?.notebookTurn);
    return requestNextDirection(scene, { notebookTurn: savedTurn });
}

async function beginDirection({ scene, action, insertUser, authorizedGoalIds = [], autonomousSequence = 0, notebookTurn = null, postedMessage = null } = {}) {
    // Checked before the Loom call, not after: the Loom costs a real
    // request and ~17s, and there is no point spending either when the
    // performer that follows it cannot speak.
    const blocked = !scene ? 'No active Scene.' : describeNativeGenerationBlock();
    if (blocked) {
        journal('blocked', { reason: blocked }, { severity: 'warn' });
        return directionFailure(new Error(blocked), { scene, action, insertUser, authorizedGoalIds, autonomousSequence, postedMessage });
    }
    // Last line of defence. Every caller checks the lock, but they are all async
    // and a caller that awaited something in between could still arrive here
    // after another pass took it.
    if (directionInFlight) {
        journal('begin.rejected', { reason: 'a direction is already in flight', passId: directionInFlight.id }, { severity: 'warn' });
        return false;
    }
    const token = acquireDirectionLock({ scene, insertUser, autonomousSequence });
    // The two facts the `finally` below needs to decide whether this take
    // produced anything. See the comment there — this is the N1 fix, and the
    // reason it is scoped here rather than inside the try is that a throw must
    // not be able to skip it.
    let storedTurn = null;
    let askedThePerformer = false;
    // What Continue needs to speak a direction that was produced and never
    // said. Scoped beside the two above and for the same reason: the catch has
    // to be able to read them, and a throw must not be able to skip past them.
    let standingEnvelope = null;
    let standingPerformer = null;
    journal('begin', {
        passId: token.id,
        sceneId: scene.id,
        insertUser: Boolean(insertUser),
        // Distinct from `insertUser`: this says whether the text is already
        // sitting in context.chat from an earlier attempt at this same action
        // (a retry), not whether this kind of pass posts text at all. A
        // boolean here for the journal only — the record itself carries the
        // actual message object, never logged whole (see the comment below).
        alreadyPosted: Boolean(postedMessage),
        autonomousSequence,
        authorizedGoalIds,
        actionLength: String(action || '').length,
    }, { correlationId: token.id, summary: insertUser ? 'direction.begin (user)' : 'direction.begin (autonomous)' });
    try {
        pendingFailure = null;
        notifyTransient('Directing');
        const ready = await hooks.ensureSceneReady(scene);
        if (!ready) throw new Error('The native chat linked to this Scene could not be loaded.');
        if (token.aborted) return abandonPass(token, 'scene-ready');
        // Posted here, before the Loom is asked anything, rather than
        // after the round trip returns — a real request that has measured
        // 101-202s, during which the user's own words used to be nowhere on
        // screen. buildDirectionSnapshot is told to leave this same entry out
        // of acceptedHistory below — NOT necessarily "the newest thing in
        // context.chat" (a retry after generation itself wrote a message and
        // then still failed can leave that message sitting after this one) —
        // so the Loom sees it exactly once, under CURRENT ACTION
        // (direction-sources.js's describeSnapshot), not once there and once
        // more inside STORY SO FAR. `action` stays the single source handed to
        // the World Info scan and buildMechanicalSnapshot just below, so
        // neither scores it twice either.
        //
        // Once this runs there is no undoing it on a later failure in this
        // same pass: nothing downstream removes the message, so it stays in
        // the chat even if the Loom call or the performer that follows it
        // never succeeds. `postedMessage` — the actual message OBJECT
        // sendMessageAsUser returns, not a boolean or an index — is what stops
        // a RETRY from posting it again: directionFailure carries whatever it
        // is at the moment of failure forward on pendingFailure,
        // retryLiveDirection hands that whole record back into this function,
        // and a chain of retries after the text has landed skips this block
        // and reads the message that is already there.
        //
        // It has to be the object, not a boolean or a captured index. A
        // boolean only says "posted at some point"; it does not say which
        // entry, so a later exclusion-by-position can grab the wrong one — and
        // an index goes stale the moment anything else changes context.chat's
        // length before that exclusion runs, which generation doing exactly
        // that (writing the performer's response) and then failing makes
        // routine, not rare. The object survives both: it identifies the SAME
        // entry wherever it ends up sitting.
        //
        // Kept separate from `insertUser`, which still decides lock priority
        // (userInitiated) and the journal's user/autonomous label — a fact
        // about what KIND of pass this is, not about whether this particular
        // attempt already posted.
        if (insertUser && !postedMessage) {
            postedMessage = await sendMessageAsUser(action);
            hooks.clearComposer();
        }
        if (token.aborted) return abandonPass(token, 'insert-user');
        const snapshot = await buildDirectionSnapshot(scene, action, authorizedGoalIds, { excludeFromHistory: postedMessage });
        journal('snapshot', {
            passId: token.id,
            castCount: snapshot.cast.length,
            castLabels: snapshot.cast.map((item) => item.label),
            // Key names deliberately avoid the journal's sensitive-key regex
            // (debug-console.js SENSITIVE_KEY): it matches on the KEY before it
            // looks at the value, so `historyCount: 12` would be redacted to a
            // placeholder even though a count discloses nothing.
            acceptedLines: snapshot.acceptedHistory.length,
            goalCount: snapshot.mechanics?.goals?.length ?? null,
            receiptCount: snapshot.recentReceipts.length,
        }, { correlationId: token.id });
        if (token.aborted) return abandonPass(token, 'snapshot');
        // Connection point 1 — the turn's direction. The narrator drafts first
        // (no pre-call, no LLM round-trip here); the Loom reconciles that draft
        // against the dice at completeVisibleRun. Everything downstream —
        // performer, reveal, finalize, editor pass — is shared. `notebookTurn`
        // is supplied only by regenerate, which reuses a freed turn number
        // rather than allocating a new one.
        const turn = toTurnNumber(notebookTurn) ?? nextNotebookTurn(scene);
        const { envelope, storedTurn: storedTurnValue } = createLoomTurnEnvelope(scene, snapshot, turn);
        if (storedTurnValue) storedTurn = storedTurnValue;
        if (token.aborted) return abandonPass(token, 'envelope');
        // Performer selection is no longer the Loom's to make — whoever
        // holds the Scene's Narrator badge speaks. A manual "speak next"
        // override still outranks it when one is armed.
        const requestedRef = performerOverride || scene.liveDirection?.narratorRef;
        const performer = resolvePerformer(requestedRef, scene);
        performerOverride = null;
        if (!performer) {
            const requested = normalizeRef(requestedRef);
            const available = snapshot.cast.map((item) => `${item.label} (${item.ref?.id || '?'})`).join(', ') || 'none';
            throw new Error(requested
                ? `The Scene's Narrator (${requested.label || requested.id}) is not an active cast member. Available performers: ${available}.`
                : `No performer could be resolved to speak this direction — bind a Narrator for this Scene, or leave only one active performer. Available performers: ${available}.`);
        }
        journal('performer', {
            passId: token.id,
            requestedRef: normalizeRef(requestedRef),
            resolvedRef: performer.ref,
            nativeIndex: performer.characterId,
            // resolvePerformer substitutes the sole available card when no
            // Narrator is bound.
            substituted: normalizeRef(requestedRef)?.id !== performer.ref.id,
        }, { correlationId: token.id });
        const normalized = normalizeEnvelope(envelope, scene);
        // Mechanical requests are addressed by name against exactly what this
        // pass advertised (direction-address.js); they are validated and
        // applied once the response is accepted, not here — see
        // finalizeRunMessage. Carried on the envelope rather than executed
        // eagerly, which is the change this task makes.
        normalized.variableRefs = snapshot.mechanics.variableRefs;
        normalized.goalRefs = snapshot.mechanics.goalRefs;
        normalized.addressBook = snapshot.mechanics.addressBook;
        normalized.authorizedGoalIds = authorizedGoalIds;
        // Carried so Pass 2 extraction can advertise the same Variables/Goals to
        // the extractor and resolve its requests against the same address book —
        // without paying for a second retrieval after the turn. A distinct field:
        // envelope.mechanics is the Loom's pending-requests payload.
        normalized.mechanicsSnapshot = snapshot.mechanics;
        if (token.aborted) return abandonPass(token, 'normalized');
        // Set BEFORE the call, not after: from here the performer has been
        // asked, so the turn is live even if generation then fails. The
        // empty-response retry path (failEmptyVisibleRun) re-runs this same
        // turn and must be able to read its own notes.
        askedThePerformer = true;
        standingEnvelope = normalized;
        standingPerformer = performer;
        return await generateDirectedPerformer({ scene, envelope: normalized, performer, autonomousSequence, token });
    } catch (error) {
        // The empty-response retry chain already owns this turn's outcome, and
        // this throw is the same generation reported a second time. Declaring
        // the pass failed here would put "Direction paused" over a scene that
        // is mid-retry and about to succeed.
        if (ownedByEmptyRetry(standingEnvelope?.directionId)) {
            journal('failed.superseded', {
                passId: token.id,
                directionId: standingEnvelope.directionId,
                message: String(error?.message || error),
            }, { correlationId: token.id, severity: 'warn', summary: 'direction.failed: suppressed, the empty-response retry owns this turn' });
            return false;
        }
        return directionFailure(error, { scene, action, insertUser, authorizedGoalIds, autonomousSequence, postedMessage });
    } finally {
        // A take that never reached the performer produced nothing — no
        // message, no state change — so its entries must not bind the turn
        // that follows. Keyed on THAT, not on how the pass ended: pressing
        // Stop is only one of the ways a take produces nothing, and a pass
        // that stored entries and then threw (the Scene's Narrator is no
        // longer in the cast, say) took the other one. That path left its
        // rulings live, and the next turn read them as settled fact.
        //
        // In a `finally`, so an exit added later is covered by construction
        // rather than by remembering to mark it.
        //
        // This covers the takes that never reached the performer. The other
        // side of that line — the performer WAS asked, and the user then
        // stopped the reveal before its first visible character — is covered
        // Normally already released the moment activeRun was assigned; this
        // covers every early return and throw.
        releaseDirectionLock(token);
    }
}

/** A pass cancelled before it spent a native generation. Leaves no wreckage. */
function abandonPass(token, stage) {
    journal('abandoned', { passId: token.id, stage }, { correlationId: token.id, severity: 'warn', summary: `direction.abandoned (${stage})` });
    releaseDirectionLock(token);
    notifyState();
    hooks.onSettled();
    return false;
}

async function buildDirectionSnapshot(scene, action, authorizedGoalIds, { preview = false, excludeFromHistory = null } = {}) {
    const context = getContext();
    const cast = hooks.getCast() || [];
    const persona = hooks.getPersona() || null;
    // beginDirection now posts the user's message to context.chat BEFORE
    // calling this function, so on a real (non-preview) user-initiated pass
    // it is already sitting in there somewhere. `excludeFromHistory` — the
    // exact message OBJECT beginDirection posted, not a position — is
    // filtered out of the window this function slices, not out of
    // context.chat itself, so it is read back into the Loom's prompt
    // exactly once, as `action` (CURRENT ACTION), rather than a second time
    // here (STORY SO FAR).
    //
    // Filtered by identity rather than "drop the last entry": on a retry
    // after a failure that left an orphaned performer response in
    // context.chat (generation wrote a message and then the pass still
    // failed), the user's own message is no longer last — the orphaned
    // response is. Dropping the tail there would strip the WRONG message: the
    // action would stay in acceptedHistory (so the Loom reads it twice —
    // once here, once as CURRENT ACTION), the orphaned response would be
    // hidden from the Loom entirely, and resolveVariableContext below
    // would score the action's text twice. Filtering by the object itself
    // finds the right entry regardless of what else has been appended since.
    //
    // Computing `id` against this filtered length rather than against
    // context.chat.length is what keeps every other message's id identical to
    // what it would have been without the insertion.
    const rawChat = context.chat || [];
    const effectiveChat = excludeFromHistory ? rawChat.filter((message) => message !== excludeFromHistory) : rawChat;
    // How many of the most recent messages ride along as raw prose, on top of
    // the Loom's own notebook (which now carries continuity via
    // `[result]` entries) — user-settable, resolved from the active loom
    // recipe's `loomSnapshot` block rather than the old hardcoded 40. See
    // resolveLoomSnapshotHistoryDepth for the fallback rules.
    //
    // `effectiveChat.slice(-historyDepth)` is NOT safe at a depth of 0:
    // `-0 === 0` in JS, and `Array.prototype.slice(0)` returns the WHOLE
    // array, not an empty one — the exact opposite of what a depth of 0 must
    // mean. `sliceCount` is clamped into `[0, effectiveChat.length]` first and
    // only sliced when it is actually positive, which is what keeps a depth
    // of 0 meaning zero messages rather than silently reverting to
    // "everything".
    const historyDepth = 12; // messages of accepted history carried in the snapshot (was the loom recipe's snapshot default)
    const sliceCount = Math.min(Math.max(historyDepth, 0), effectiveChat.length);
    const recentChat = sliceCount > 0 ? effectiveChat.slice(-sliceCount) : [];
    const history = recentChat.map((message, index) => ({
        id: effectiveChat.length - sliceCount + index,
        role: message.is_user ? 'user' : 'assistant',
        name: message.name || '',
        content: sanitizeDirectionText(message.extra?.remodelDirection?.acceptedText ?? message.mes ?? ''),
        // A transcript line that simply stops mid-sentence is exactly what made
        // the Loom re-issue a beat it had already been given: nothing in the
        // text said the line was cut rather than finished. Every interrupted
        // turn in the window is marked, not only the newest one, because a
        // truncated line two turns back is just as unreadable as a fresh one.
        interrupted: Boolean(readInterruptionRecord(message)),
    })).filter((message) => message.content.trim());
    // The interruption this pass is being asked to direct around: the newest
    // thing in the chat is a performance the user cut into, and no performer
    // has spoken since. A later completed response answers the question by
    // existing, so only the LAST entry is consulted — an older interruption is
    // history the Loom already ruled on, and re-offering its unsaid
    // remainder would invite the same beat to be replayed turns later.
    //
    // `effectiveChat`, so the user's own just-posted message (excluded from
    // this window by identity, above) does not hide the response it interrupted.
    //
    // Gated on that message still being inside the rendered history window:
    // the section below talks about "the last response under STORY SO FAR", and
    // at a history depth that drops it there is no such response to talk about.
    const cutOff = effectiveChat[effectiveChat.length - 1];
    const cutOffRecord = recentChat[recentChat.length - 1] === cutOff ? readInterruptionRecord(cutOff) : null;
    let lore = {};
    try {
        const scan = [action, ...history.slice(-12).reverse().map((message) => message.content)];
        lore = await context.getWorldInfoPrompt(scan, context.maxContext, true);
    } catch (error) {
        lore = { warning: String(error?.message || error) };
    }
    const performingCast = cast.filter((member) => !member.disabled);
    const activatedEntries = [...(lore.allActivatedEntries || [])];
    // Preview never rolls or mutates and never carries authorized Goal ids —
    // but retrieval (resolveVariableContext) scores against action/history/
    // activatedEntries, so it still gets the real ones: the same `action`
    // this function was called with (the composer draft when there is one —
    // see previewLoomPrompt), and the same history/activatedEntries just
    // computed above. Only the write-adjacent authority (authorizedGoalIds)
    // is withheld; the retrieval inputs are identical to a real pass's.
    const mechanics = preview
        ? await previewMechanicalContext(scene, {
            cast: performingCast.map((member) => member.ref || member), persona, action,
            evidence: { history, activatedEntries },
        })
        : await buildMechanicalSnapshot(scene, action, performingCast.map((member) => member.ref || member), persona, authorizedGoalIds, {
            history,
            activatedEntries,
            correlationId: directionInFlight?.id || null,
        });
    return {
        scene: { id: scene.id, timelineId: scene.timelineId, title: scene.title },
        currentAction: action,
        cast: performingCast
            .map((member) => ({ ref: member.ref || normalizeRef(member), label: member.label || member.name, description: member.description || '', personality: member.personality || '', scenario: member.scenario || '' })),
        narratorRef: scene.liveDirection?.narratorRef || null,
        persona,
        acceptedHistory: history,
        // What the user cut into, in the performer's own words — the half that
        // reached them (already in acceptedHistory, ending exactly where the
        // reveal froze) and the half that did not. Null on an ordinary turn.
        //
        // Carried on the snapshot rather than fetched by the renderer because
        // direction-sources.js takes data in and returns text and imports
        // nothing at all; a renderer that reached into context.chat for this
        // would end that, and with it the ability to assert the exact prose the
        // Loom reads from a plain fixture.
        interruption: cutOffRecord ? { performer: String(cutOff.name || '').trim(), ...cutOffRecord } : null,
        lore: { before: lore.worldInfoBefore || '', after: lore.worldInfoAfter || '', examples: lore.worldInfoExamples || [], depth: lore.worldInfoDepth || [] },
        mechanics,
        // Receipts carry before/after snapshots of whole records, which is how
        // persistent Variable and Goal ids used to reach the model even though
        // everything else addresses them by ref. The model needs what changed,
        // not which row it was.
        recentReceipts: listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id })
            .slice(-6).map((tx) => ({ status: tx.status, receipts: (tx.receipts || []).map(scrubReceipt) })),
    };
}

/** Drops storage identity from a receipt, keeping the mechanical record. */
function scrubReceipt(receipt) {
    const withoutIds = (value) => {
        if (Array.isArray(value)) return value.map(withoutIds);
        if (!value || typeof value !== 'object') return value;
        const { id, timelineId, sceneId, variableId, definitionId, ...rest } = value;
        return Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, withoutIds(item)]));
    };
    const { requestId, capability, status, approvalStatus, reason, rejectionReason } = receipt || {};
    return {
        requestId, capability, status, approvalStatus, reason, rejectionReason,
        ...withoutIds(Object.fromEntries(Object.entries(receipt || {}).filter(([key]) =>
            !['requestId', 'capability', 'status', 'approvalStatus', 'reason', 'rejectionReason'].includes(key)))),
    };
}

/**
 * Requests the mechanics layer can at least read.
 *
 * `parseLoomReply` keeps anything object-typed, which includes arrays —
 * and `validateMechanicsRequest` rejects the WHOLE batch when one entry is not
 * a plain object. Dropping the unreadable ones here is what stops a single
 * malformed sibling from voiding four valid requests. It is not containment:
 * every surviving request still has its names resolved against the set this
 * pass advertised, and its shape still checked, by code this task did not touch.
 */
function usableRequests(requests) {
    return (Array.isArray(requests) ? requests : []).filter((request) => request && typeof request === 'object' && !Array.isArray(request));
}

/**
 * A usable notebook turn number, or null.
 *
 * `Number.isFinite(Number(value))` is NOT this test: `Number(null)` is 0 and
 * passes it, which silently files a whole pass under turn 0. This codebase has
 * now been bitten by that exact coercion three times — `clampNumber` in
 * variables-store.js, `coerceSettingValue` in prompt-studio-store.js, and here
 * — so it gets one answer that every caller shares. Turn 0 is rejected on
 * purpose: `appendLoomEntries` uses it as its own "unknown" fallback, and
 * real turns start at 1.
 */
function toTurnNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const turn = Math.floor(Number(value));
    return Number.isFinite(turn) && turn > 0 ? turn : null;
}

/** The next turn number for this Scene: one past the directed responses so far.
 * A plain per-turn counter — the Loom keeps the durable record. */
function nextNotebookTurn() {
    const chat = getContext().chat || [];
    return chat.filter((message) => message && !message.is_user).length + 1;
}


/**
 * How many times a performer that renders nothing is asked again before the
 * pass is declared failed.
 *
 * Measured, not guessed: in one recorded session the same performer, prompt,
 * model and parameters produced 664 and 756 characters on two generations and
 * nothing at all on two others — once by spending the whole reply on reasoning,
 * once by emitting thirteen empty tokens and stopping. At temperature 1 an
 * empty completion is a transient provider outcome, so the correct response is
 * to ask again rather than to surface a failure the user can only answer by
 * pressing Retry themselves.
 *
 * The Loom is NOT re-run: the direction was valid, only its rendering
 * failed, and re-directing would cost a second long call and could change the
 * direction the user is waiting on.
 */
const EMPTY_RESPONSE_RETRIES = 2;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 400;
// How long the empty-response path waits for the native generation it is
// replacing to actually finish.
//
// Much longer than the interrupt path's 2200ms, and for a different reason:
// that one has just called stopGeneration() and is bounding how long an ABORT
// takes, while this one is waiting for a call to end on its own. A provider
// that is slow is not a provider that is stuck, and cutting the wait short
// here is what produced overlapping generations in the first place.
const EMPTY_SETTLE_TIMEOUT_MS = 15000;

// Direction ids whose empty-response retry chain is still running.
//
// A generation that produces no message reports itself TWICE: the reveal
// pipeline notices nothing was revealed and calls failEmptyVisibleRun, and
// generateDirectedPerformer throws "the group generator returned without
// producing a message" for the same generation. Those are one event. The retry
// chain owns the outcome for that turn, so while it is running the throw must
// not also declare the pass dead — the owner's log shows two "Direction
// paused" notices posted while attempt 3 was still in flight and about to
// succeed, leaving a permanent error over a scene that had recovered.
const retryingEmpty = new Set();

function ownedByEmptyRetry(directionId) {
    return Boolean(directionId) && retryingEmpty.has(directionId);
}

async function generateDirectedPerformer({ scene, envelope, performer, autonomousSequence, token = null, emptyRetries = 0, previousReasoningLength = 0 }) {
    activeRun = {
        directionId: envelope.directionId,
        sceneId: scene.id,
        timelineId: scene.timelineId,
        messageId: null,
        performer,
        envelope,
        phase: 'narrator',
        narratorDraft: '',
        narratorGenerationFinished: false,
        loomProfileId: scene.generationProfileIds?.loom || '',
        loomController: null,
        rawBufferedText: '',
        acceptedVisibleText: '',
        rawOffset: 0,
        lastBreathOffset: 0,
        holdReason: '',
        state: 'Speaking',
        openingLabel: '',
        checkpointTransactionIds: [],
        generationFinished: false,
        generationSettled: false,
        interrupted: false,
        waitingAtEnd: false,
        pacing: scene.liveDirection?.pacing || 'natural',
        autonomousSequence: Number(autonomousSequence) || 0,
        authorizedGoalIds: envelope.authorizedGoalIds || [],
        variableRefs: envelope.variableRefs instanceof Map ? envelope.variableRefs : new Map(),
        goalRefs: envelope.goalRefs instanceof Map ? envelope.goalRefs : new Map(),
        addressBook: envelope.addressBook || { entries: [], duplicates: [] },
        pendingRequestsApplied: false,
        emptyRetries: Number(emptyRetries) || 0,
    };
    // A visible run now exists, so activeRun is the authoritative guard and the
    // hidden-phase lock has done its job. Releasing it here — rather than when
    // beginDirection returns — is what keeps interruption working: the user must
    // be able to submit over a revealing response.
    releaseDirectionLock(token);
    notifyState();
    // The Narrator generates natively — its full configured prompt (system
    // prompt, card, persona, world info, author's notes, examples, history) —
    // with the Loom's readable Archive state resolved into the recipe-owned
    // Narrator Grounding macro. Placement and policy remain user-authored.
    const archivistState = buildNarratorArchivistSections(scene.timelineId, scene.id);
    // What the other characters are after, which is the only thing in the whole
    // request that is not downstream of the player. Without it the Narrator knows
    // what everyone DID and never what anyone WANTS, and the lowest-energy
    // continuation of any user action is that it simply works.
    //
    // buildGoalObjectives had two call sites, both inside the Loom. Its own
    // docstring says "for the narrator view" — which was intent, not wiring: the
    // Narrator had never once been shown a Goal.
    const objectives = buildGoalObjectives(scene.id);
    // A retry must not re-send the request that just failed. The empty-response
    // path was re-issuing a byte-identical body — verified on the wire — so the
    // nudge rides the grounding channel, which is the one injection point already
    // proven to reach the request (notes.bridge reports its length every turn).
    const retryNudge = buildEmptyResponseNudge(Number(emptyRetries) + 1, {
        // Passed in, not read back: activeRun.messageId is only assigned when
        // MESSAGE_RECEIVED lands, so at this point it names nothing.
        reasoningLength: Number(previousReasoningLength) || 0,
    });
    const groundedState = [archivistState, objectives, retryNudge].filter(Boolean).join('\n\n');
    const groundingRouted = hooks.setNativePromptContent('narratorGrounding', groundedState);
    journal('notes.bridge', {
        directionId: envelope.directionId,
        routed: groundingRouted ? 'recipe-macro' : 'recipe-macro-disabled',
        groundingChars: groundedState.length,
        retryNudged: Boolean(retryNudge),
        hasArchivist: Boolean(String(archivistState || '').trim()),
    }, { correlationId: envelope.directionId });
    // The user message was inserted explicitly above. Native normal
    // generation also reads #send_textarea and would send any stale draft a
    // second time, producing a duplicate user line and a second response.
    // Empty it immediately before handing generation to core.
    const nativeComposer = document.getElementById('send_textarea');
    if (nativeComposer instanceof HTMLTextAreaElement && nativeComposer.value) {
        nativeComposer.value = '';
        nativeComposer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ownedGenerationDepth++;
    const generationStartedAt = Date.now();
    try {
        const context = getContext();
        // Releases Remodel-authored prose that older builds accidentally
        // stored as native system Narrator messages before core assembles the
        // next prompt. Persist once so future turns and reloads stay repaired.
        const repairedHistoryRoles = repairDirectedNarratorRoles(context.chat);
        if (repairedHistoryRoles) {
            await context.saveChat();
            journal('history.roles-repaired', {
                directionId: envelope.directionId,
                count: repairedHistoryRoles,
            }, { correlationId: envelope.directionId });
        }
        const narratorProfileId = scene.generationProfileIds?.narrator;
        if (narratorProfileId) {
            await hooks.activateConnectionProfile(narratorProfileId);
        }
        // force_chid is read by generateGroupWrapper as `typeof … == 'number'`,
        // and NaN passes that test — a member with no resolvable index would
        // activate character NaN rather than falling back. Refuse instead.
        if (context.groupId && !Number.isInteger(performer.characterId)) {
            throw new Error(`${performer.label || 'The selected performer'} is not a loaded character card in this group, so no native index could be resolved for it.`);
        }
        const options = context.groupId ? { force_chid: performer.characterId } : {};
        journal('generation.start', {
            directionId: envelope.directionId,
            performerLabel: performer.label,
            nativeIndex: performer.characterId,
            transport: context.groupId ? 'group' : 'solo',
            pacing: activeRun.pacing,
            connectionProfileId: narratorProfileId || null,
        }, { correlationId: envelope.directionId });
        if (testAdapters?.generatePerformer) {
            await testAdapters.generatePerformer({ scene, envelope, performer, options, context });
        } else if (context.groupId) {
            // Do not route an owned performer request back through generic
            // Generate(). In a native group that function conditionally enters
            // the group wrapper; if core still considers a preceding group
            // operation active, it silently falls through as a solo request and
            // can return after only /api/ping. The Loom has already selected
            // one validated cast member, so invoke the real group boundary
            // explicitly and force that member.
            const idleDeadline = Date.now() + 5000;
            while (is_group_generating && Date.now() < idleDeadline) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (is_group_generating) {
                throw new Error('The native group generator is still busy. Try Direction again.');
            }
            // Re-checked here as well as before the Loom call: the Loom
            // round-trip takes many seconds, and the connection can drop inside
            // that window.
            const lateBlock = describeNativeGenerationBlock();
            if (lateBlock) {
                throw new Error(lateBlock);
            }
            const messageCount = context.chat?.length || 0;
            await generateGroupWrapper(false, 'normal', options);
            if ((getContext().chat?.length || 0) <= messageCount) {
                // Reaching here means core accepted the request and returned
                // without writing a message. Say that plainly rather than
                // implying the model replied with nothing.
                throw new Error(`${performer.name || performer.label || 'The selected performer'} was asked to speak, but SillyTavern's group generator returned without producing a message. ${describeNativeGenerationBlock() || 'Check the Debug Console for a failed request.'}`);
            }
        } else {
            await context.generate('normal', options);
        }
    } finally {
        ownedGenerationDepth = Math.max(0, ownedGenerationDepth - 1);
        // Dynamic macro content is request-scoped even though its native prompt
        // object persists with the recipe. Clear the resolved Archive after
        // assembly so a later free-play request cannot inherit it.
        hooks.setNativePromptContent('narratorGrounding', '');
        journal('generation.end', {
            directionId: envelope.directionId,
            durationMs: Date.now() - generationStartedAt,
            messageId: activeRun?.directionId === envelope.directionId ? activeRun.messageId : null,
            bufferedLength: activeRun?.directionId === envelope.directionId ? activeRun.rawBufferedText.length : null,
            stillOwned: activeRun?.directionId === envelope.directionId,
        }, { correlationId: envelope.directionId });
        if (activeRun?.directionId === envelope.directionId) {
            activeRun.narratorGenerationFinished = true;
        }
    }
    if (activeRun?.directionId === envelope.directionId) {
        await beginLoomVisibleStream(activeRun, scene);
    }
    return true;
}

/**
 * The run's accepted prose, as it should be stored and read back.
 *
 * Markers out, then the scaffolding a performer echoed instead of speaking —
 * `[IMPORTANT: …]The Narrator II:` and friends. Core strips the name half in
 * cleanUpMessage; Live Direction owns its own buffer and writes the accepted
 * text itself, so it never passed through that.
 *
 * Applied HERE, at the points that finalize or read a run, and deliberately
 * not in acceptNativeBuffer where it would be caught a token earlier: the
 * reveal walks `rawBufferedText` by `rawOffset`, so shortening that buffer
 * mid-stream would leave the offset pointing past the text it names. The cost
 * is that an echoed prefix is visible while the reply streams and gone once it
 * lands; the alternative risks desyncing the reveal against the user's prose.
 */
function acceptedProse(run) {
    return stripEchoedScaffolding(sanitizeDirectionText(run?.acceptedVisibleText), run?.performer?.label || '');
}

function acceptNativeBuffer(text) {
    if (!activeRun) return;
    activeRun.rawBufferedText = String(text ?? '');
    // The native Narrator is private source material. Its cumulative stream is
    // collected at provider speed and handed to the Loom whole; it never owns
    // the paced visible offset.
    if (activeRun.phase === 'narrator') return;
    // Streaming fills our buffer and nothing else. We used to re-assert the
    // accepted fragment into the native message on the next task after every
    // token, which meant racing core's own streaming writer for ownership of
    // message.mes for the whole generation.
    //
    // We do not need to win that race. The Roleplay workspace renders its own
    // stream, so during generation the native message is a data record nobody
    // is reading on screen. The accepted text is written once by
    // finalizeRunMessage when the run completes, is interrupted, or is
    // stopped — and recoverLiveDirectionMessages sanitizes any message that
    // still carries markers if the browser dies mid-generation.
    scheduleReveal(0);
}

/**
 * Was this generation cut off by its own token ceiling?
 *
 * A provider stops at max_tokens exactly, and SillyTavern never surfaces
 * finish_reason — it appears nowhere in the repository — so the ceiling and
 * the returned text are all there is to go on. See generation-budget.js.
 *
 * WHY THIS IS WORTH A ROUND-TRIP: without it a truncated turn is stored as
 * `state: 'complete', cutShort: false, interrupted: false` and is
 * indistinguishable from a clean one. The turn that prompted this ended
 * mid-word, recorded nothing to the Archive, and raised no error anywhere —
 * the journal showed a perfect turn.
 *
 * Never throws and never blocks the turn: a tokenizer that is unavailable or
 * slow must not be able to hold up prose that has already arrived.
 */
async function checkGenerationBudget({ text, reasoning, label, directionId }) {
    try {
        const countTokens = getContext()?.getTokenCountAsync;
        if (typeof countTokens !== 'function') return null;
        const [visibleTokens, reasoningTokens] = await Promise.all([
            countTokens(String(text || '')),
            countTokens(String(reasoning || '')),
        ]);
        const budget = describeGenerationBudget({
            visibleTokens, reasoningTokens, maxTokens: getMaxResponseTokens(),
        });
        if (!budget.exhausted) return budget;
        const warning = describeBudgetWarning(budget, label);
        journal('generation.truncated', {
            directionId: directionId || null,
            usedTokens: budget.used,
            maxTokens: budget.max,
            visibleTokens: budget.visible,
            reasoningTokens: budget.reasoning,
            reasoningShare: Number(budget.reasoningShare.toFixed(3)),
        }, { correlationId: directionId || undefined, severity: 'warn', summary: warning });
        return budget;
    } catch (error) {
        journal('generation.truncated.unchecked', { error: String(error?.message || error) }, { severity: 'info' });
        return null;
    }
}

/** Move one finished private Narrator draft into the only visible generation:
 * the Loom's cumulative final-prose stream. */
async function beginLoomVisibleStream(run, scene) {
    if (activeRun !== run) return false;
    const message = getContext().chat?.[run.messageId];
    const draft = stripEchoedScaffolding(
        sanitizeDirectionText(run.rawBufferedText || message?.mes || ''),
        run.performer?.label || '',
    );
    if (!draft) {
        run.generationFinished = true;
        run.generationSettled = true;
        await failEmptyVisibleRun(run);
        return false;
    }
    journalResponse('narrator', {
        text: String(run.rawBufferedText || message?.mes || ''),
        renderedText: draft,
        reasoning: narratorReasoning(run),
        streamed: true,
    }, { correlationId: run.directionId });

    // Before the draft becomes the Loom's input: if the provider cut it off at
    // the ceiling, every downstream stage inherits a half-sentence, and the Loom
    // — which must reproduce the whole turn AND emit a state fence on the same
    // budget — will not reach its fence either. Recording it here names the
    // cause once, at the point it happened.
    const draftBudget = await checkGenerationBudget({
        text: draft,
        reasoning: narratorReasoning(run),
        label: 'The Narrator draft',
        directionId: run.directionId,
    });
    // The tokenizer call is a round-trip; the run can have been replaced or
    // stopped while it was out.
    if (activeRun !== run) return false;
    if (draftBudget?.exhausted) {
        run.truncated = true;
        run.checkpointDiagnostics = [
            ...(run.checkpointDiagnostics || []),
            describeBudgetWarning(draftBudget, 'The Narrator draft'),
        ];
    }

    run.narratorDraft = draft;
    run.phase = 'loom';
    run.rawBufferedText = '';
    run.acceptedVisibleText = '';
    run.rawOffset = 0;
    run.lastBreathOffset = 0;
    run.generationFinished = false;
    run.generationSettled = false;
    run.state = 'Speaking';
    run.openingLabel = '';
    run.completing = false;
    run.loomController = new AbortController();

    // The native row is only a slot reservation. Remove the private draft from
    // it before the Loom request begins so a crash or unrelated re-render can
    // never expose or persist the wrong version.
    if (message && !message.is_user) {
        message.mes = '';
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = '';
    }
    notifyState();

    // An interrupted previous turn is archived from only the prefix the user
    // accepted. Let the Narrator draft concurrently, then join that catch-up
    // here so this Loom request reads fully current state.
    await waitForArchiveCatchup(run.sceneId);
    if (activeRun !== run || run.loomController.signal.aborted) return false;

    const snapshot = await __buildLoomSnapshot({ id: run.sceneId, timelineId: run.timelineId });
    const token = { controller: run.loomController };
    const result = await runLoomReconciliation({
        scene: { ...scene, id: run.sceneId, timelineId: run.timelineId },
        snapshot,
        draft,
        draftReasoning: narratorReasoning(run),
        token,
        deferRequests: true,
        onChunk: ({ text }) => {
            if (activeRun !== run || run.loomController.signal.aborted) return;
            run.rawBufferedText = String(text || '');
            scheduleReveal(0);
        },
    });
    if (activeRun !== run || run.loomController.signal.aborted || result?.aborted) return false;

    // A non-streaming provider, or a legacy swap-only recipe, arrives here in
    // one piece. The same reveal path handles it; there is still only one
    // canonical buffer and one interruption offset.
    run.rawBufferedText = String(result?.committedProse || draft);
    run.envelope.mechanics.pendingRequests = [...(result?.requests || [])];
    if (result?.flow) run.envelope.flow = result.flow;
    run.generationFinished = true;
    run.generationSettled = true;
    scheduleReveal(0);
    return true;
}

function scheduleReveal(delay = 50) {
    if (!activeRun || activeRun.holdReason) return;
    clearRevealTimer();
    revealTimer = setTimeout(revealStep, Math.max(0, delay));
}

async function revealStep() {
    revealTimer = null;
    const run = activeRun;
    if (!run || run.holdReason) return;
    if (run.state === 'Breathing' || run.state === 'Opening') {
        run.state = 'Speaking';
        run.openingLabel = '';
        notifyState();
    }
    const pace = PACING[run.pacing] || PACING.natural;
    const budget = pace.cps === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.ceil(pace.cps / 20));
    // Beats come from the prose itself now, not from markers the model was
    // asked to type — see direction-beats.js. Derived once per revealed
    // chunk, not per character: the offsets are stable positions in whatever
    // text has streamed in so far, so recomputing per character would just
    // repeat the same answer.
    const beats = deriveBeats(run.rawBufferedText);
    let emitted = 0;
    while (activeRun === run && !run.holdReason && emitted < budget) {
        const unit = readDirectionUnit(run.rawBufferedText, run.rawOffset, { final: run.generationFinished });
        if (unit.kind === 'end' || unit.kind === 'partial') break;
        run.rawOffset = unit.nextOffset;
        // The performer is never told to emit a Remodel marker under this
        // contract, so anything shaped like one is a stray artifact — treated
        // exactly like readDirectionUnit's own 'unknown' kind: consumed, never
        // shown, never actioned.
        if (unit.kind !== 'text') continue;
        run.acceptedVisibleText += unit.value;
        emitted++;
        const beat = beats.find((item) => item.offset === run.rawOffset);
        if (!beat) continue;
        const words = run.acceptedVisibleText.slice(run.lastBreathOffset).trim().split(/\s+/).filter(Boolean).length;
        run.lastBreathOffset = run.acceptedVisibleText.length;
        run.state = beat.kind === 'opening' ? 'Opening' : 'Breathing';
        run.openingLabel = beat.kind === 'opening' ? 'Opportunity' : '';
        persistRun(run, true);
        notifyState();
        const adaptive = pace.cps === Infinity ? 0 : Math.max(pace.min, Math.min(pace.max, words * pace.wordMs));
        scheduleReveal(adaptive + (beat.kind === 'opening' ? pace.opening : 0));
        return;
    }
    notifyState();
    persistRun(run, false);
    if (run.rawOffset >= run.rawBufferedText.length && run.generationFinished) {
        await completeVisibleRun(run);
        return;
    }
    if (run.rawOffset < run.rawBufferedText.length) scheduleReveal(pace.cps === Infinity ? 0 : 50);
}

/**
 * Requests name Variables and Goals by the Timeline's address book (see
 * direction-address.js), not by an opaque ref. This resolves each request's
 * name against the book this pass actually advertised and returns maps the
 * capability layer reads with `.get(ref)` — so mechanics-capabilities.js needs
 * no change, it just gets handed names as keys instead of synthetic refs. A
 * name absent from the book is simply left unresolved, which the capability
 * layer already refuses as "not advertised for this request"; the specific
 * reason (unknown vs. duplicated) is collected in `unresolvedReasons` for the
 * caller to surface — the generic downstream refusal alone is actively
 * misleading for a duplicated name, since it *was* advertised, twice.
 *
 * **The returned maps contain name-resolved entries and nothing else.** That
 * is the validation boundary design §3 asks for — "code validates the name
 * against the set advertised this turn and rejects anything else" — and it is
 * structural rather than probabilistic: there is no key in these maps that was
 * not resolved through `resolveByName`, so there is nothing to guess, mistype,
 * or collide with. Two earlier shapes both failed this. Seeding from the base
 * maps inherited their `v1…vN` / `g1…gN` keys and made every one of them a
 * second unvalidated address. Re-keying those entries under an unguessable
 * placeholder made them unlikely to be reached rather than unreachable — a
 * request carrying that placeholder still resolved and still wrote, while the
 * diagnostic reported it refused. Probability is not a validation boundary.
 *
 * The base maps are still read, but only for their VALUES, and those leave
 * through `retrievedVariableIds` / `retrievedGoalIds` instead. `goal.reach`
 * is their only consumer — it asks whether a Goal's tracked Variable was
 * retrieved this pass — and it now reads those arrays directly rather than
 * inferring the answer from a map that has to double as an address table.
 *
 * @returns {{variableRefs: Map<string, string>, goalRefs: Map<string, string>,
 *   retrievedVariableIds: string[], retrievedGoalIds: string[], unresolvedReasons: string[]}}
 */
export function addressRequestsByName(requests, addressBook, variableRefs, goalRefs) {
    const idsOf = (refs) => (refs instanceof Map ? [...refs.values()] : []);
    const retrievedVariableIds = idsOf(variableRefs);
    const retrievedGoalIds = idsOf(goalRefs);
    const resolvedVariableRefs = new Map();
    const resolvedGoalRefs = new Map();
    const unresolvedReasons = [];
    const attempted = new Set();
    const addResolved = (refs, tag, name) => {
        if (!name) return;
        const key = `${tag}:${name}`;
        if (attempted.has(key)) return;
        attempted.add(key);
        const result = resolveByName(addressBook, name);
        if (result.ok) refs.set(name, result.id);
        else unresolvedReasons.push(result.reason);
    };
    for (const request of requests) {
        const args = request?.arguments || {};
        addResolved(resolvedVariableRefs, 'variable', args.variableRef);
        addResolved(resolvedVariableRefs, 'variable', args.modifierVariableRef);
        // other Variable reference does — see mechanics-capabilities.js's
        // normalizeResolutionArgs, which resolves it through this same
        // lookup. Missing this is the only way to create a tracked Goal.
        addResolved(resolvedGoalRefs, 'goal', args.goalRef);
        addResolved(resolvedGoalRefs, 'goal', args.fromGoalRef);
        addResolved(resolvedGoalRefs, 'goal', args.toGoalRef);
    }
    return { variableRefs: resolvedVariableRefs, goalRefs: resolvedGoalRefs, retrievedVariableIds, retrievedGoalIds, unresolvedReasons };
}

function executeDirectionRequests(requests, context) {
    const scene = context.scene;
    if (!Array.isArray(requests) || requests.length === 0) return { ok: true, receipts: [], transaction: null, unresolvedReasons: [] };
    const { variableRefs, goalRefs, retrievedVariableIds, unresolvedReasons } = addressRequestsByName(requests, context.addressBook, context.variableRefs, context.goalRefs);
    const result = executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests }, {
        timelineId: scene.timelineId,
        sceneId: scene.id,
        turnId: context.directionId,
        directionId: context.directionId,
        messageId: context.messageId,
        checkpointId: context.checkpointId,
        authorizedGoalIds: context.authorizedGoalIds || [],
        authorizedVariableRefs: [],
        variableRefs, goalRefs,
        // What retrieval advertised this pass, carried separately from the
        // address table so goal.reach can answer "was this tracked Variable
        // retrieved" without the address table having to hold entries nobody
        // may address.
        retrievedVariableIds,
        allowUserGoalCreate: false,
    });
    return { ...result, unresolvedReasons };
}

/**
 * The mechanics snapshot (advertised Variables/Goals + address book) the editor
 * resolves its requests against, without running a full turn. Exported for
 * editor-mode wiring and tests.
 */
export async function __buildLoomSnapshot(scene) {
    const mechanics = await buildMechanicalSnapshot(scene, '', [], null, [], {});
    return { mechanics };
}

/**
 * Loom mode — reconcile the Narrator's DRAFT: build
 * the Loom prompt (draft + reasoning + readable narrative state + the
 * mechanical board WITH numbers), transport it, parse the committed prose +
 * state fence, and execute the requests against the address book. Returns the
 * committed prose to post. Never throws — a failure falls back to the draft
 * unchanged. Dice inside goal.reach are code-rolled by the mechanics layer.
 */
export async function runLoomReconciliation({
    scene, snapshot, draft, draftReasoning = '', token = null, onChunk = null, deferRequests = false,
}) {
    const narrativeState = [
        buildNarratorArchivistSections(scene.timelineId, scene.id),
        buildGoalObjectives(scene.id),
    ].filter((part) => String(part || '').trim()).join('\n\n');
    const mechanicsSkill = buildLoomSkill(snapshot?.mechanics);
    const sources = buildLoomRecipeSources({ draft, draftReasoning, narrativeState, mechanicsSkill });
    const recipe = getCurrentPromptStudioRecipe('loom', 'chat');
    const compiled = compilePromptRecipe(recipe, sources, { trace: true });
    const prompt = compiled.messages.length
        ? compiled.messages
        : buildLoomPrompt({ draft, draftReasoning, narrativeState, mechanicsSkill });
    recordLoomPromptTranscript(recipe?.name, prompt);
    let raw = '';
    let responseReasoning = '';
    let responseStreamed = false;
    try {
        if (testAdapters?.loomReconciliation) {
            let emitted = false;
            raw = String(await testAdapters.loomReconciliation({
                scene,
                draft,
                prompt,
                signal: token?.controller?.signal,
                onChunk: (value) => {
                    emitted = true;
                    onChunk?.({ text: readLoomProse(String(value || '')), reasoning: '' });
                },
            }) || '');
            if (!emitted) onChunk?.({ text: readLoomProse(raw, { final: true }), reasoning: '' });
        } else if (testAdapters) {
            return { committedProse: draft, result: null }; // opt-in for tests
        } else {
            const out = await streamChatPrompt({
                prompt,
                signal: token?.controller?.signal,
                profileId: scene.generationProfileIds?.loom || undefined,
                onChunk: ({ text, reasoning }) => onChunk?.({ text: readLoomProse(text), reasoning }),
            });
            raw = String(out?.text || '');
            responseReasoning = String(out?.reasoning || '');
            responseStreamed = Boolean(out?.streamed);
        }
    } catch (error) {
        journal('loom.failed', { phase: 'generate', error: String(error?.message || error) }, { severity: 'warn' });
        return { committedProse: draft, result: null };
    }
    // Preserve-and-patch: the draft is canonical. The Loom only names the
    // exact span(s) a roll changed; code applies them. No swaps → draft stands.
    if (token?.controller?.signal?.aborted) return { committedProse: '', requests: [], result: null, flow: null, aborted: true };
    journalResponse('loom', { text: raw, reasoning: responseReasoning, streamed: responseStreamed }, {
        correlationId: directionInFlight?.id || activeRun?.directionId || null,
        purpose: 'loom-pass',
    });
    // The Loom must reproduce the whole turn AND close a state fence on the
    // same ceiling as the draft, so it runs out sooner. A truncated Loom reply
    // loses the fence entirely, which surfaces only as an Archive that quietly
    // did not advance — name the real cause here instead.
    await checkGenerationBudget({ text: raw, reasoning: '', label: 'The Loom pass', directionId: null });
    journalLoomReply(raw, 'loom-pass', scene?.id || null);
    const { prose, swaps, requests, flow } = parseLoomReply(raw);
    // Full-prose replies are the v12 contract. Preserve-and-patch remains a
    // compatibility fallback for owner-authored recipes using the old fence.
    const committedProse = prose || applySwaps(draft, swaps).prose;
    if (deferRequests || !requests.length) return { committedProse, requests, result: null, flow };
    try {
        const result = executeDirectionRequests(requests, {
            scene: { id: scene.id, timelineId: scene.timelineId },
            addressBook: snapshot?.mechanics?.addressBook,
            variableRefs: snapshot?.mechanics?.variableRefs,
            goalRefs: snapshot?.mechanics?.goalRefs,
            authorizedGoalIds: [],
        });
        journal('loom', { requestCount: requests.length, ok: result.ok, patched: committedProse !== draft }, { summary: 'Loom reconciled and recorded the turn' });
        return { committedProse, requests, result, flow };
    } catch (error) {
        journal('loom.failed', { phase: 'apply', error: String(error?.message || error) }, { severity: 'warn' });
        return { committedProse, requests, result: null, flow };
    }
}

/**
 * The Narrator's own thinking for this turn — the intent channel Pass 2 reads.
 * Native generation records a reasoning model's hidden thinking on
 * message.extra.reasoning; the Loom's envelope reasoning is the legacy
 * fallback (empty in Loom mode). Empty here means the model produced no
 * reasoning at all, which the reasoning gate reports.
 */
function narratorReasoning(run) {
    const message = getContext().chat?.[run.messageId];
    return String(message?.extra?.reasoning || run.envelope?.reasoning || '').trim();
}

async function completeVisibleRun(run) {
    if (activeRun !== run) return;
    // revealStep is async and nulls revealTimer before it awaits, so a
    // scheduleReveal landing while this function is inside finalizeRunMessage
    // (which awaits saveChat over the network) re-enters it with activeRun
    // still pointing at the same run. Every effect below would then happen
    // twice — including arming a second autoplay continuation.
    if (run.completing || run.acceptedComplete) return;
    run.completing = true;
    // A run that reveals nothing is a failed response, not a finished one.
    // Treating it as complete wrote a blank Narrator row into the chat AND
    // chained autoplay off it, so one silent provider reply became a run of
    // empty rows that each fed the next Loom pass as accepted history.
    if (!acceptedProse(run)) {
        await failEmptyVisibleRun(run);
        return;
    }
    // Loom mode: the accepted Narrator text is a DRAFT. Run Loom reconciliation
    // over it and commit its reconciled version instead — the draft is never
    // stored (the reveal-hold that keeps the draft off screen is Task 7).
    await finalizeRunMessage(run, { state: 'complete' });
    if (!run.archiveRequestsApplied) queueArchiveCatchup(run, 'no-archive-requests');
    run.acceptedComplete = true;
    // The main Loom fence normally records state. If it omitted every Archive
    // operation, the queued same-recipe catch-up above repairs that omission
    // without holding the visible turn open.
    run.autonomousSequence += 1;
    // A response landed, so any failure notice still on screen is describing a
    // turn that has since recovered. The empty-response retries are the case
    // that produces one: attempts 1 and 2 report, attempt 3 succeeds, and
    // nothing used to take the notice down again.
    pendingFailure = null;
    hooks.onRecovered();
    const scene = hooks.getActiveScene();
    const draft = String(hooks.getComposerDraft() || '').trim();
    const limit = scene?.liveDirection?.autonomousResponseLimit || 3;
    const hard = run.envelope.flow.hardPauseAfter || !run.envelope.flow.continueAfter || run.autonomousSequence >= limit;
    journal('complete', {
        directionId: run.directionId,
        acceptedLength: run.acceptedVisibleText.length,
        autonomousSequence: run.autonomousSequence,
        limit,
        mechanicsTransactionIds: run.checkpointTransactionIds,
        checkpointDiagnostics: run.checkpointDiagnostics || [],
        continueAfter: run.envelope.flow.continueAfter,
        hardPauseAfter: run.envelope.flow.hardPauseAfter,
        heldByComposer: Boolean(draft),
        next: hard || draft ? 'wait' : (scene?.liveDirection?.autoplay !== false ? 'autoplay' : 'idle'),
    }, { correlationId: run.directionId });
    if (hard || draft) {
        run.waitingAtEnd = true;
        run.holdReason = 'hard';
        run.state = draft ? 'Held while you write' : 'Waiting for you';
        notifyState();
        hooks.onSettled();
        return;
    }
    if (scene?.liveDirection?.autoplay !== false) {
        const sequence = run.autonomousSequence;
        const sceneId = scene?.id;
        activeRun = null;
        notifyState();
        hooks.onSettled();
        cancelAutoplay('replaced');
        journal('autoplay.scheduled', { directionId: run.directionId, autonomousSequence: sequence, delayMs: 250 }, { correlationId: run.directionId });
        autoplayTimer = setTimeout(() => {
            autoplayTimer = null;
            // The Scene can change, or direction can be switched off, in the
            // gap. Continuing into a Scene the user has left would speak into
            // the wrong chat.
            const current = hooks.getActiveScene();
            if (!current || current.id !== sceneId || !isDirectedLiveScene(current)) {
                journal('autoplay.dropped', { reason: 'scene is no longer the directed Scene that armed it' }, { severity: 'warn' });
                return;
            }
            if (String(hooks.getComposerDraft() || '').trim()) {
                activeRun = run;
                run.waitingAtEnd = true;
                run.holdReason = 'hard';
                run.state = 'Held while you write';
                notifyState();
                hooks.onSettled();
                return;
            }
            journal('autoplay.fired', { autonomousSequence: sequence });
            beginDirection({ scene: current, action: '[Autonomous continuation from accepted history.]', insertUser: false, autonomousSequence: sequence });
        }, 250);
        return;
    }
    activeRun = null;
    notifyState();
    hooks.onSettled();
}

/**
 * The performer produced no visible prose.
 *
 * Observed live with a reasoning model on an OpenAI-compatible backend: over a
 * hundred STREAM_TOKEN_RECEIVED events all carried an empty string, the stream
 * stats reported 109 tokens, and the entire response arrived through
 * STREAM_REASONING_DONE instead. Core wrote an empty message, so there was
 * nothing to reveal and nothing to accept.
 *
 * That is a provider-side outcome Remodel cannot fix, but it must not be
 * presented as a completed response — so the empty message is removed, the
 * chain is stopped, and the reason is named precisely enough to act on.
 */
async function failEmptyVisibleRun(run) {
    const context = getContext();
    const message = Number.isInteger(run.messageId) ? context.chat?.[run.messageId] : null;
    // Core stores the provider's reasoning on the message, so the empty-text
    // case can be distinguished from a genuinely empty reply without adding a
    // listener for the reasoning stream.
    const reasoning = String(message?.extra?.reasoning || '').trim();
    const attempt = (run.emptyRetries || 0) + 1;
    journal('complete.empty', {
        directionId: run.directionId,
        messageId: run.messageId,
        attempt,
        bufferedLength: run.rawBufferedText.length,
        reasoningLength: reasoning.length,
        performerLabel: run.performer?.label || '',
    }, { correlationId: run.directionId, severity: 'warn', summary: `direction.complete: no visible text (attempt ${attempt})` });

    // WAIT FOR THE CALL THIS IS REPLACING TO ACTUALLY END.
    //
    // completeVisibleRun decides "nothing was revealed" from the reveal
    // pipeline, which can settle while `generateGroupWrapper` is still
    // pending. Without this wait the retry below fired a SECOND native
    // generation into a generator that was still running the first: the
    // owner's log shows three overlapping generations from one failure
    // (17:39:01-11 containing 17:39:04-09), "The native group generator is
    // still busy" thrown from inside the retry, unhandled rejections escaping
    // this function, and empty results from the collision itself — which then
    // looked like the provider refusing the prompt and consumed the retry
    // budget chasing its own tail.
    //
    // Same guard the interrupt path already used (interruptLiveDirection), for
    // the same reason. This path is the one that never learned it.
    if (!run.generationSettled && ownsLiveDirectionGeneration()) {
        await waitFor(() => run.generationSettled, EMPTY_SETTLE_TIMEOUT_MS);
        if (!run.generationSettled) {
            journal('empty.settle-timeout', {
                directionId: run.directionId,
                waitedMs: EMPTY_SETTLE_TIMEOUT_MS,
            }, { correlationId: run.directionId, severity: 'warn', summary: 'direction.empty: the native generation never reported settling' });
        }
    }

    // finalizeRunMessage removes a message with no accepted text, so the blank
    // row never reaches the chat. Deliberately NOT marked interrupted: the user
    // did nothing here, and recording it as an interruption would misreport the
    // failure in the saved metadata.
    await finalizeRunMessage(run, { state: 'empty' });
    cancelAutoplay('empty-response');

    const scene = hooks.getActiveScene();
    const sceneIntact = scene && scene.id === run.sceneId && isDirectedLiveScene(scene);

    // Ask again before giving up. The movement, performer and direction record
    // are reused verbatim, so a retry is one native call and the user sees a
    // continuous "Speaking" state rather than an error they must clear.
    if (sceneIntact && run.emptyRetries < EMPTY_RESPONSE_RETRIES) {
        journal('retry.empty', { directionId: run.directionId, attempt, of: EMPTY_RESPONSE_RETRIES + 1 }, { correlationId: run.directionId, severity: 'warn' });
        // Held as a normal in-flight pass rather than dropping to idle: the
        // pipeline is still working on the user's turn, so the chrome must keep
        // saying so and Send must stay refused across the pause. Marked
        // autonomous, which means a user intervention correctly supersedes it.
        const retryToken = acquireDirectionLock({ scene, insertUser: false, autonomousSequence: run.autonomousSequence });
        activeRun = null;
        notifyState();
        // Claimed BEFORE the pause below, not after: the throw from the
        // generation this retry replaces is already on its way up to
        // beginDirection's catch, and the claim has to be visible when it
        // arrives or the redundant failure is posted anyway.
        retryingEmpty.add(run.directionId);
        try {
            await new Promise((resolve) => setTimeout(resolve, EMPTY_RESPONSE_RETRY_DELAY_MS));
            const current = hooks.getActiveScene();
            if (retryToken.aborted || !current || current.id !== run.sceneId) {
                journal('retry.empty.dropped', {
                    directionId: run.directionId,
                    reason: retryToken.aborted ? 'superseded during the retry pause' : 'the Scene changed during the retry pause',
                }, { correlationId: run.directionId, severity: 'warn' });
                notifyState();
                hooks.onSettled();
                return;
            }
            await generateDirectedPerformer({
                scene: current,
                envelope: run.envelope,
                performer: run.performer,
                autonomousSequence: run.autonomousSequence,
                token: retryToken,
                emptyRetries: run.emptyRetries + 1,
                previousReasoningLength: reasoning.length,
            });
        } catch (error) {
            // Nothing awaits this function. completeVisibleRun is driven by the
            // reveal loop, so a throw from here escaped as an unhandled
            // rejection and the user got a console error with no matching
            // state change — three of them in the owner's log. Routed through
            // directionFailure instead, which is the one exit that leaves the
            // chrome, the pending-retry record and the journal agreeing.
            directionFailure(error, {
                scene: hooks.getActiveScene() || scene,
                action: '[Continue the scene from accepted history.]',
                insertUser: false,
                autonomousSequence: run.autonomousSequence,
            });
        } finally {
            retryingEmpty.delete(run.directionId);
            releaseDirectionLock(retryToken);
        }
        return;
    }

    const performer = run.performer?.label || 'The performer';
    const exhausted = `${attempt} attempt${attempt === 1 ? '' : 's'} produced no visible text`;
    const detail = reasoning.length > 200
        ? `${exhausted}. The last reply spent its whole output on the model's reasoning channel (${reasoning.length} characters) and returned empty content. Lowering the reasoning effort, or using a model that returns reasoning alongside content rather than in place of it, will make this rarer.`
        : `${exhausted}, and the provider returned empty content each time. This is usually transient — Retry asks again. If it persists, the model or provider is refusing this prompt.`;
    activeRun = null;
    directionFailure(new Error(`${performer} was directed but rendered nothing: ${detail}`), {
        scene,
        action: '[Continue the scene from accepted history.]',
        insertUser: false,
        autonomousSequence: run.autonomousSequence,
    });
    hooks.onSettled();
}

async function interruptLiveDirection({ preserveForIntervention }) {
    const run = activeRun;
    if (!run) return;
    cancelAutoplay('interrupted');
    clearRevealTimer();
    journal('interrupt', {
        directionId: run.directionId,
        preserveForIntervention: Boolean(preserveForIntervention),
        acceptedLength: run.acceptedVisibleText.length,
        bufferedLength: run.rawBufferedText.length,
        discardedLength: Math.max(0, run.rawBufferedText.length - run.rawOffset),
        generationSettled: run.generationSettled,
        // An interruption before the first visible character deletes the
        // message outright — the "it produced no bubble at all" case.
        willDeleteMessage: !acceptedProse(run),
    }, { correlationId: run.directionId, severity: 'warn' });
    run.interrupted = true;
    run.holdReason = 'interrupt';
    if (run.phase === 'loom') {
        try { run.loomController?.abort(); } catch { /* already aborted */ }
    } else if (!run.narratorGenerationFinished && ownsLiveDirectionGeneration()) {
        getContext().stopGeneration?.();
        await waitFor(() => run.narratorGenerationFinished, 2200);
    }
    // The Loom's completed fence can describe prose still sitting in the
    // unrevealed tail. Once the user cuts that tail off, none of its requests
    // may become canon. Archive the accepted prefix afresh below instead.
    run.envelope.mechanics.pendingRequests = [];
    run.archiveRequestsApplied = false;

    // Loom mode: Stop CUTS OFF, it does not delete. The reveal lags the buffer
    // for pacing, so at the moment of a Stop most of what the model generated
    // sits unrevealed in rawBufferedText — flush it into the accepted text so
    // every generated word is kept (losing it was the "everything vanishes on
    // Stop" bug). A run that generated nothing still has an empty buffer here,
    // so finalizeRunMessage still deletes the truly-empty case. Loom mode
    // keeps its original discard-the-unrevealed-tail behaviour (and its tests).
    await finalizeRunMessage(run, { state: preserveForIntervention ? 'interrupted' : 'stopped' });
    queueArchiveCatchup(run, preserveForIntervention ? 'user-interruption' : 'stopped');
    activeRun = null;
    notifyState();
    hooks.onSettled();
}

async function finalizeRunMessage(run, { state }) {
    // Before the first await, and here rather than at each caller: this is the
    // one funnel every run passes through, so a path added later is covered by
    // construction instead of by remembering. See clearPersistTimer.
    clearPersistTimer();
    const context = getContext();
    if (!Number.isInteger(run.messageId)) {
        const last = context.chat.length - 1;
        if (last >= 0 && !context.chat[last]?.is_user) run.messageId = last;
    }
    const message = context.chat?.[run.messageId];
    if (!message || message.is_user) {
        journal('finalize.no-message', {
            directionId: run.directionId,
            state,
            messageId: run.messageId,
            chatLength: context.chat?.length ?? null,
            reason: message ? 'the resolved message is the user line' : 'no message at the resolved id',
        }, { correlationId: run.directionId, severity: 'warn' });
        return;
    }
    const accepted = acceptedProse(run);
    if (!accepted) {
        // Nothing was ever accepted, so there is nothing to keep — whether the
        // user interrupted before the first character or the performer returned
        // no visible text at all. Writing the empty message was what left blank
        // Narrator rows sitting in the stream.
        journal('finalize.deleted-empty', {
            directionId: run.directionId,
            state,
            messageId: run.messageId,
            bufferedLength: run.rawBufferedText.length,
        }, { correlationId: run.directionId, severity: 'warn', summary: 'direction.finalize: deleted an empty interrupted message' });
        await context.deleteMessage(run.messageId);
        run.messageId = null;
        return;
    }
    // State changes land here, not at a marker in the prose the model wrote:
    // this is the one place every run passes through once *something* was
    // accepted, whether that is the full response or the prefix a user
    // interruption froze. An early interruption returned above with nothing
    // accepted and applied nothing — the property this replaces the commit
    // marker to preserve: only fiction the user actually read may change
    // stored state.
    applyPendingRequests(run);
    const interruption = describeRunInterruption(run);
    journal('finalize', {
        directionId: run.directionId,
        state,
        messageId: run.messageId,
        acceptedLength: accepted.length,
        // Still "discarded" from the VISIBLE message — the user never read it
        // and it never becomes prose. It is no longer destroyed: when this turn
        // was cut short, the same tail is kept on the record below as the
        // performer's unspoken intention for the Loom to rule on.
        discardedLength: Math.max(0, run.rawBufferedText.length - run.rawOffset),
        interrupted: Boolean(run.interrupted),
        // A provider-truncated turn must not read back as a clean one.
        truncated: Boolean(run.truncated),
        cutShort: Boolean(interruption),
        unspokenLength: interruption?.unspokenRemainder.length ?? 0,
    }, { correlationId: run.directionId });
    message.mes = accepted;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
    message.extra ??= {};
    message.extra.remodelDirection = serializeRun(run, state);
    await context.saveChat();
}


/**
 * Apply the direction's mechanical requests exactly once, now that some
 * fiction has been accepted (see finalizeRunMessage). Failures are recorded
 * on the run rather than thrown: the performer has already spoken, so there
 * is no earlier point left in this pass to refuse it at.
 */
function applyPendingRequests(run) {
    if (run.pendingRequestsApplied) return;
    run.pendingRequestsApplied = true;
    const pending = run.envelope.mechanics.pendingRequests;
    if (!pending?.length) return;
    const archiveRequestCount = pending.filter((request) => ARCHIVE_CAPABILITIES.has(request?.capability)).length;
    const scene = hooks.getActiveScene();
    if (!scene || scene.id !== run.sceneId) {
        journal('mechanics.accepted.skipped', {
            directionId: run.directionId,
            reason: 'the Scene changed before the response was accepted',
        }, { correlationId: run.directionId, severity: 'warn' });
        return;
    }
    const result = executeDirectionRequests(pending, {
        scene, directionId: run.directionId, messageId: run.messageId, checkpointId: 'accepted',
        authorizedGoalIds: run.authorizedGoalIds,
        variableRefs: run.variableRefs, goalRefs: run.goalRefs, addressBook: run.addressBook,
    });
    journal('mechanics.accepted', {
        directionId: run.directionId,
        requested: pending.length,
        ok: result.ok,
        errors: result.errors || [],
        unresolvedReasons: result.unresolvedReasons || [],
        transactionId: result.transaction?.id || null,
    }, { correlationId: run.directionId, severity: result.ok ? 'info' : 'error' });
    if (result.transaction?.id) run.checkpointTransactionIds.push(result.transaction.id);
    if (result.ok && archiveRequestCount) run.archiveRequestsApplied = true;
    // unresolvedReasons carries the specific reason (unknown vs. duplicated
    // name) that addressRequestsByName already worked out; folded in even on
    // an otherwise-ok result, since one request can name an unresolvable
    // Variable while the rest of the batch still succeeds.
    if (!result.ok || result.unresolvedReasons?.length) {
        run.checkpointDiagnostics = [
            ...(run.checkpointDiagnostics || []),
            ...(result.ok ? [] : (result.errors || ['Mechanical request failed.'])),
            ...(result.unresolvedReasons || []),
        ];
    }
}

/**
 * Record what a Loom-shaped reply actually contained.
 *
 * Logged at `warn` when it carries no Archive operation, because that is the
 * case where the scene silently stops remembering: the prose lands, the turn
 * reads as complete, and nothing says the Archive did not move.
 */
function journalLoomReply(raw, phase, sceneId, directionId = null) {
    try {
        const reply = describeLoomReply(raw);
        const archiveCount = reply.capabilities.filter((name) => ARCHIVE_CAPABILITIES.has(name)).length;
        const reason = !reply.hasFence
            ? 'no state fence in the reply'
            : (!reply.fenceParsed
                ? 'the state fence is not valid JSON'
                : (!archiveCount
                    ? 'the fence carried no Archive operation'
                    : ''));
        journal('loom.reply', { phase, sceneId, directionId, archiveCount, ...reply }, {
            correlationId: directionId || undefined,
            severity: reason ? 'warn' : 'info',
            summary: reason
                ? `Loom reply (${phase}): ${reason}.`
                : `Loom reply (${phase}): ${archiveCount} Archive operation(s).`,
        });
    } catch { /* diagnostics must never break a turn */ }
}

/**
 * Reconcile accepted prose into the Archive when the visible Loom pass could
 * not supply a trustworthy state fence (most importantly, an interruption).
 * This deliberately reuses the selected Loom recipe and connection profile;
 * its returned prose is ignored and only narrative Archive requests apply.
 */
async function catchUpArchive(run, reason) {
    const prose = acceptedProse(run);
    if (!prose) return;
    if (testAdapters && !testAdapters.archiveCatchup) return;

    const scene = { id: run.sceneId, timelineId: run.timelineId };
    const mechanics = run.envelope?.mechanicsSnapshot || null;
    const mechanicsSkill = buildLoomSkill(mechanics);
    const narrativeState = [
        buildNarratorArchivistSections(run.timelineId, run.sceneId),
        buildGoalObjectives(run.sceneId),
    ].filter((part) => String(part || '').trim()).join('\n\n');
    const sources = buildLoomRecipeSources({
        draft: prose,
        draftReasoning: narratorReasoning(run),
        narrativeState,
        mechanicsSkill,
    });
    const recipe = getCurrentPromptStudioRecipe('loom', 'chat');
    const compiled = compilePromptRecipe(recipe, sources, { trace: true });
    const prompt = compiled.messages.length
        ? compiled.messages
        : buildLoomPrompt({ draft: prose, draftReasoning: narratorReasoning(run), narrativeState, mechanicsSkill });
    recordLoomPromptTranscript(recipe?.name, prompt);

    let raw = '';
    let responseReasoning = '';
    let responseStreamed = false;
    try {
        if (testAdapters?.archiveCatchup) {
            raw = String(await testAdapters.archiveCatchup({ run, prose, prompt, reason }) || '');
        } else {
            const out = await streamChatPrompt({
                prompt,
                profileId: run.loomProfileId || undefined,
            });
            raw = String(out?.text || '');
            responseReasoning = String(out?.reasoning || '');
            responseStreamed = Boolean(out?.streamed);
        }
    } catch (error) {
        journal('archive.catchup.failed', { directionId: run.directionId, reason, phase: 'generate', error: String(error?.message || error) }, { correlationId: run.directionId, severity: 'warn' });
        return;
    }

    journalResponse('loom', { text: raw, reasoning: responseReasoning, streamed: responseStreamed }, {
        correlationId: run.directionId,
        purpose: `archive-catchup:${reason}`,
    });
    journalLoomReply(raw, `archive-catchup:${reason}`, run.sceneId, run.directionId);
    const requests = parseLoomReply(raw).requests.filter((request) => ARCHIVE_CAPABILITIES.has(request?.capability));
    if (!requests.length) {
        journal('archive.catchup.empty', { directionId: run.directionId, reason }, { correlationId: run.directionId, severity: 'warn' });
        return;
    }
    try {
        const result = executeDirectionRequests(requests, {
            scene,
            directionId: `${run.directionId}:archive`,
            messageId: run.messageId,
            addressBook: run.addressBook,
            variableRefs: run.variableRefs,
            goalRefs: run.goalRefs,
            authorizedGoalIds: [],
        });
        // The catch-up writes state on behalf of THIS turn, so Retry has to be
        // able to undo it. Two separate reasons it used to survive Retry, and
        // repairing either one alone leaves the bug intact:
        //
        //   1. this transaction id was recorded nowhere, unlike the one
        //      applyPendingRequests keeps above;
        //   2. finalizeRunMessage has ALREADY serialized the run by the time a
        //      queued catch-up lands, so the undo set regenerateLastDirected-
        //      Response reads back was snapshotted before this transaction
        //      existed.
        //
        // Hence the id goes onto the run AND into the saved snapshot. This is
        // deliberately not persistRun(): that recomputes the stored `state`
        // from run.state and would clobber the interrupted/stopped marker
        // finalizeRunMessage set from its own argument.
        if (result.transaction?.id) {
            run.checkpointTransactionIds.push(result.transaction.id);
            const stored = getContext().chat?.[run.messageId];
            const saved = stored && !stored.is_user ? stored.extra?.remodelDirection : null;
            // Matched on directionId rather than trusting the index: a queued
            // catch-up can land after the chat has moved under it, and amending
            // another turn's undo set would make its Retry roll back state the
            // user kept.
            if (saved?.directionId === run.directionId) {
                saved.checkpointTransactionIds = [...run.checkpointTransactionIds];
            }
        }
        journal('archive.catchup', {
            directionId: run.directionId,
            reason,
            requestCount: requests.length,
            ok: result.ok,
            errors: result.errors || [],
        }, { correlationId: run.directionId, severity: result.ok ? 'info' : 'warn', summary: 'Loom caught the Archive up to accepted prose' });
    } catch (error) {
        journal('archive.catchup.failed', { directionId: run.directionId, reason, phase: 'apply', error: String(error?.message || error) }, { correlationId: run.directionId, severity: 'warn' });
    }
}

function queueArchiveCatchup(run, reason) {
    const key = String(run?.sceneId || '');
    if (!key || !acceptedProse(run)) return Promise.resolve();
    const prior = archiveCatchups.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => catchUpArchive(run, reason));
    archiveCatchups.set(key, task);
    task.finally(() => {
        if (archiveCatchups.get(key) === task) archiveCatchups.delete(key);
    });
    return task;
}

async function waitForArchiveCatchup(sceneId) {
    const pending = archiveCatchups.get(String(sceneId || ''));
    if (pending) await pending.catch(() => {});
}

function buildLoomSkill(mechanics) {
    if (mechanics && getMechanicsProfile().enabled) {
        try { return buildLoomContext({ mechanics }, { mechanicsEnabled: true }).mechanicsSkill || ''; } catch { /* use the Archive-only guide below */ }
    }
    const guide = getCapabilityDictionary()
        .filter((capability) => ARCHIVE_CAPABILITIES.has(capability.name))
        .map((capability) => {
            const required = (capability.requiredArguments || [])
                .map((argument) => `${argument.key} — ${argument.hint}`).join('; ');
            return `- ${capability.name}: ${capability.description}${required ? `\n    arguments: ${required}` : ''}`;
        })
        .join('\n');
    return `[ARCHIVE OPERATIONS — always available]\n${guide}`;
}

function persistRun(run, immediate) {
    clearTimeout(persistTimer);
    const commit = async () => {
        const message = getContext().chat?.[run.messageId];
        if (!message || message.is_user) return;
        // Metadata only. The visible body stays core's until the run finishes,
        // so this never competes with the streaming writer; recovery reads
        // acceptedText from here rather than from message.mes.
        message.extra ??= {};
        message.extra.remodelDirection = serializeRun(run, run.state.toLowerCase().replaceAll(' ', '-'));
        await getContext().saveChat();
    };
    if (immediate) commit();
    else persistTimer = setTimeout(commit, 350);
}

async function recoverLiveDirectionMessages() {
    const context = getContext();
    let changed = false;
    let recovered = null;
    for (const [messageId, message] of (context.chat || []).entries()) {
        const metadata = message?.extra?.remodelDirection;
        if (!metadata || message.is_user) continue;
        const hadMarkers = String(message.mes || '').includes('[[RM:');
        const unfinished = !['complete', 'interrupted', 'stopped'].includes(metadata.state);
        if (!hadMarkers && !unfinished) continue;
        const previousState = metadata.state;
        const accepted = sanitizeDirectionText(metadata.acceptedText ?? message.mes ?? '');
        message.mes = accepted;
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
        metadata.acceptedText = accepted;
        metadata.state = 'recovered-hard-pause';
        metadata.recovered = true;
        // Markers surviving into a saved message mean a run never reached
        // finalizeRunMessage — a crash, or a pass that lost its activeRun to a
        // concurrent one. Worth recording: it names the orphan after the fact.
        journal('recovered', {
            messageId,
            directionId: metadata.directionId || null,
            previousState,
            hadMarkers,
            unfinished,
            acceptedLength: accepted.length,
        }, { correlationId: metadata.directionId || null, severity: 'warn' });
        recovered = { messageId, message, metadata };
        changed = true;
    }
    if (changed) await context.saveChat();
    const scene = hooks.getActiveScene();
    if (recovered && scene?.id === recovered.metadata.sceneId && isDirectedLiveScene(scene)) {
        const performer = resolvePerformer(recovered.metadata.performerRef, scene);
        if (performer) {
            activeRun = {
                directionId: recovered.metadata.directionId || createId('direction-recovered'),
                sceneId: scene.id,
                timelineId: scene.timelineId,
                messageId: recovered.messageId,
                performer,
                envelope: recovered.metadata.envelope || { flow: { continueAfter: false, hardPauseAfter: true }, mechanics: { pendingRequests: [] } },
                rawBufferedText: recovered.metadata.acceptedText || '',
                acceptedVisibleText: recovered.metadata.acceptedText || '',
                rawOffset: String(recovered.metadata.acceptedText || '').length,
                lastBreathOffset: String(recovered.metadata.acceptedText || '').length,
                holdReason: 'hard', state: 'Waiting for you', openingLabel: '',
                checkpointTransactionIds: [...(recovered.metadata.checkpointTransactionIds || [])],
                variableRefs: new Map(Object.entries(recovered.metadata.variableRefs || {})),
                goalRefs: new Map(Object.entries(recovered.metadata.goalRefs || {})),
                addressBook: recovered.metadata.addressBook || { entries: [], duplicates: [] },
                // The crash-recovery pass above already fixed the message's
                // saved text directly, without going through finalizeRunMessage
                // — so the pending requests this run may still carry were
                // never applied. Leave that decision to whatever resumes this
                // run (Continue, Next) rather than applying them silently here
                // on a page load the user did not initiate.
                pendingRequestsApplied: Boolean(recovered.metadata.pendingRequestsApplied),
                generationFinished: true, generationSettled: true, interrupted: false,
                waitingAtEnd: true, acceptedComplete: true,
                pacing: scene.liveDirection?.pacing || 'natural',
                autonomousSequence: Number(recovered.metadata.autonomousSequence) || 0,
                // Restored, not dropped. Rebuilding with [] meant a request
                // applied after recovery + Continue lost the Goal authority
                // the user granted and was deferred for review instead of
                // applying — fail-safe, but surprising and unexplained.
                authorizedGoalIds: [...(recovered.metadata.authorizedGoalIds || [])],
            };
            notifyState();
        }
    }
}

/**
 * Split an envelope into the part that stores and the authorization that
 * travels beside it.
 *
 * The two Maps stringify to `{}` — which reads like data and is not — so a
 * record that kept them inline would come back resolving no names at all and
 * every surviving request would be rejected as never advertised. That is
 * fail-safe and still wrong: the user already read the fiction those requests
 * earned.
 *
 * One function because there are now three places that persist an envelope
 * (a run's message metadata, a standing direction, and regenerate reading one
 * back), and the cost of them disagreeing is silent loss of authorization.
 */
function splitEnvelopeForStorage(source) {
    const { variableRefs, goalRefs, addressBook, authorizedGoalIds, ...envelope } = source || {};
    return {
        envelope,
        variableRefs: Object.fromEntries(variableRefs || []),
        goalRefs: Object.fromEntries(goalRefs || []),
        addressBook: addressBook || { entries: [], duplicates: [] },
        // The user's attached Goal attempts. Without these a request applied
        // after recovery loses its authority and is deferred to the pending
        // queue instead of applying.
        authorizedGoalIds: [...(authorizedGoalIds || [])],
    };
}

/** The inverse: a stored record back into an envelope that can be spoken. */
function hydrateSavedEnvelope(saved, scene) {
    const envelope = normalizeEnvelope(saved?.envelope, scene);
    envelope.variableRefs = new Map(Object.entries(saved?.variableRefs || {}));
    envelope.goalRefs = new Map(Object.entries(saved?.goalRefs || {}));
    envelope.addressBook = saved?.addressBook || { entries: [], duplicates: [] };
    envelope.authorizedGoalIds = [...(saved?.authorizedGoalIds || [])];
    return envelope;
}

function serializeRun(run, state) {
    // beginDirection attaches the pass's runtime state to the envelope; none
    // of it belongs in the saved copy. The two Maps stringify to `{}`, which
    // reads like data and is not, and addressBook/authorizedGoalIds are
    // written once at the top level below — storing them twice per message
    // made the inert copy look like the authoritative one.
    // The run's own refs, not the envelope's: beginDirection copies them onto
    // both, and the run's are the ones every acceptance path reads.
    const stored = splitEnvelopeForStorage({
        ...(run.envelope || {}),
        variableRefs: run.variableRefs, goalRefs: run.goalRefs,
        addressBook: run.addressBook, authorizedGoalIds: run.authorizedGoalIds,
    });
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId: run.directionId,
        sceneId: run.sceneId,
        state,
        acceptedText: acceptedProse(run),
        revealOffset: run.rawOffset,
        performerRef: run.performer.ref,
        ...stored,
        checkpointTransactionIds: [...run.checkpointTransactionIds],
        pendingRequestsApplied: Boolean(run.pendingRequestsApplied),
        interrupted: Boolean(run.interrupted),
        // A provider-truncated turn must not read back as a clean one: Retry
        // and reload-recovery both reconstruct from this record.
        truncated: Boolean(run.truncated),
        // What the user cut off, and what the performer had not said yet. Null
        // on every turn nobody cut into — see describeRunInterruption.
        interruption: describeRunInterruption(run),
        autonomousSequence: run.autonomousSequence,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * The record that says the user cut the performer off mid-delivery, and keeps
 * the text that never reached them.
 *
 * WHY IT IS NOT `run.interrupted`. That flag says "interruptLiveDirection ran",
 * which is a much wider set than "a performance was cut short": `Stop` on a run
 * that has already finished revealing goes through the same function and sets
 * the same flag (see the re-entrancy test in remodel-direction-lifecycle), as
 * does closing out a run that is sitting at "Waiting for you". Recording those
 * as interruptions would put a cut-off notice on the Loom's desk for every
 * ordinary completed turn — the loudest possible way to be wrong. `acceptedComplete`
 * is what completeVisibleRun sets once the whole buffer has been revealed and
 * accepted, so `interrupted && !acceptedComplete` is the pair that means the
 * reveal stopped early because the user made it stop.
 *
 * NOTHING ACCEPTED RETURNS NULL, and that is the design's distinction, not a
 * defensive guard. An interruption at character zero is not a small version of
 * an interruption at character four hundred: nothing was read, so nothing
 * became fiction, and finalizeRunMessage deletes the message and applies no
 * state at all. There is no turn for the Loom to direct around, and telling
 * it a beat was cut short would invite it to write around a beat the user never
 * saw a word of. Mid-sentence is the opposite case: the read half IS fiction and
 * has to be worked with. The two must not arrive as one flag.
 *
 * The remainder is KEPT rather than dropped. It is the tail of the buffer past
 * `rawOffset` — the exact text the reveal loop had not emitted when it froze —
 * and it is the only evidence of what the performer was in the middle of doing.
 * Destroying it is what made an interruption an error instead of an event: a
 * Loom asked to rule on "someone grabs you and drags you toward the door"
 * cut after "grabs you" cannot decide whether the drag still happens if the
 * drag no longer exists anywhere. It is stored, and rendered, as an unspoken
 * intention (direction-sources.js's describeInterruption) — never as something
 * that occurred, because only fiction the user actually read may change what
 * is established.
 */
function describeRunInterruption(run) {
    if (!run?.interrupted || run.acceptedComplete) return null;
    const accepted = acceptedProse(run);
    if (!accepted) return null;
    return {
        acceptedLength: accepted.length,
        unspokenRemainder: sanitizeDirectionText(String(run.rawBufferedText || '').slice(run.rawOffset)).trim(),
    };
}

/**
 * The saved interruption on one chat message, or null.
 *
 * `acceptedLength` must be positive for the same reason describeRunInterruption
 * refuses to write a zero one: a record claiming a performance was cut short
 * after nothing was read describes a turn that, by the design's own rule, did
 * not happen. Read defensively here as well because this reads messages saved
 * by older builds and by other passes, not only ones this session wrote.
 */
function readInterruptionRecord(message) {
    const record = message?.extra?.remodelDirection?.interruption;
    if (!record || message?.is_user) return null;
    const acceptedLength = Math.floor(Number(record.acceptedLength));
    if (!Number.isFinite(acceptedLength) || acceptedLength <= 0) return null;
    return { acceptedLength, unspokenRemainder: String(record.unspokenRemainder || '').trim() };
}

function publicRun(run) {
    // AbortController is private pipeline state. It is meaningless to the UI
    // and cannot be structured-cloned; exposing it here made
    // getLiveDirectionRun() throw after every Loom pass.
    const { envelope: _envelope, loomController: _loomController, ...snapshot } = run;
    return snapshot;
}

function notifyTransient(state) {
    hooks.onStateChange({ state, acceptedVisibleText: activeRun?.acceptedVisibleText || '' });
}

function notifyState() {
    hooks.onStateChange(activeRun ? publicRun(activeRun) : null);
}

function directionFailure(error, retry) {
    console.error('Remodel Live Direction failed', error);
    journal('failed', {
        message: String(error?.message || error),
        // structured-reply.js classifies empty / truncated / malformed replies,
        // which have completely different fixes to a transport failure.
        stage: error?.stage || null,
        detail: error?.detail || null,
        sceneId: retry?.scene?.id || null,
        insertUser: Boolean(retry?.insertUser),
        autonomousSequence: retry?.autonomousSequence || 0,
    }, { severity: 'error', summary: `direction.failed: ${String(error?.message || error).slice(0, 80)}` });
    cancelAutoplay('failed');
    pendingFailure = retry;
    activeRun = null;
    notifyState();
    hooks.onFailure(error);
    return false;
}

function resolvePerformer(ref, scene) {
    const cast = (hooks.getCast() || []).filter((item) => !item.disabled);
    const normalized = normalizeRef(ref);
    // Do not reject an empty ref before considering the only native performer
    // the Scene actually makes available. `ref` is never model-selected —
    // performer selection is code's, not the Loom's — but a Scene may
    // still have no Narrator bound.
    if (!normalized && cast.length !== 1) return null;
    const member = cast.find((item) => {
        const candidate = item.ref || normalizeRef(item);
        return candidate?.id === normalized?.id;
    });
    if (!member) {
        // The requested ref (typically the Scene's bound Narrator) does not
        // match an active cast member — removed from the Scene, or never
        // bound. A Scene's explicitly bound Narrator is the primary answer;
        // Scenes without one, and with more than one active performer, fail
        // loudly rather than guessing who should speak.
        const narrator = normalizeRef(scene.liveDirection?.narratorRef);
        const narratorMember = narrator && cast.find((item) => {
            const candidate = item.ref || normalizeRef(item);
            return candidate?.id === narrator.id;
        });
        // A directed Scene with exactly one available speaking card is
        // unambiguous even with no Narrator bound. Use the sole native card.
        const fallbackMember = narratorMember || (cast.length === 1 ? cast[0] : null);
        if (!fallbackMember) return null;
        const fallbackRef = fallbackMember.ref || normalizeRef(fallbackMember);
        if (!fallbackRef) return null;
        return {
            characterId: Number(fallbackMember.characterId),
            label: fallbackMember.label || fallbackMember.name || narrator?.label || 'Narrator',
            ref: {
                kind: 'narrator',
                id: fallbackRef.id,
                label: fallbackMember.label || fallbackMember.name || narrator?.label || 'Narrator',
            },
        };
    }
    const narrator = normalizeRef(scene.liveDirection?.narratorRef);
    const kind = normalized.kind === 'narrator' || narrator?.id === normalized.id ? 'narrator' : 'character';
    return {
        characterId: Number(member.characterId),
        label: member.label || member.name || normalized.label || 'Performer',
        ref: { kind, id: normalized.id, label: member.label || member.name || normalized.label || 'Performer' },
    };
}


function normalizeRef(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || value.avatar || '').trim();
    if (!id) return null;
    return { kind: value.kind === 'narrator' ? 'narrator' : 'character', id, label: String(value.label || value.name || id) };
}

/**
 * The envelope in the shape the run lifecycle stores and replays.
 *
 * No `instruction` any more: the direction IS this turn's notebook entries
 * (design's decision table, "The direction — this turn's entries. No separate
 * instruction field"), and they live in the store, addressed by
 * `notebookTurn`. The envelope carries the pointer, not a second copy — a copy
 * on every saved message would be the authoritative-looking inert duplicate
 * this file has already been bitten by twice.
 *
 * `mechanics.pendingRequests` also accepts an envelope this function already
 * produced, since its own output moves `requests` there — that is the
 * regenerate path re-normalizing a saved envelope.
 */
function normalizeEnvelope(value, scene) {
    if (!value || value.protocol !== DIRECTION_PROTOCOL) throw new Error(`Direction protocol must be ${DIRECTION_PROTOCOL}.`);
    const directionId = String(value.directionId || createId('direction'));
    const pendingRequests = Array.isArray(value.requests) ? value.requests : Array.isArray(value.mechanics?.pendingRequests) ? value.mechanics.pendingRequests : [];
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId,
        notebookTurn: toTurnNumber(value.notebookTurn),
        reasoning: String(value.reasoning || ''),
        flow: { continueAfter: Boolean(value.flow?.continueAfter), hardPauseAfter: Boolean(value.flow?.hardPauseAfter) },
        mechanics: { pendingRequests },
        sceneId: scene.id,
    };
}


function clearRevealTimer() {
    clearTimeout(revealTimer);
    revealTimer = null;
}

/**
 * Cancel a debounced metadata write that has not fired yet.
 *
 * `persistRun(run, false)` schedules a commit 350ms out, and that commit reads
 * `run.state` when it *fires*, not when it was scheduled. Finalizing awaits
 * `stopGeneration` and `saveChat`, so a commit scheduled just before an
 * interruption lands inside that window and writes the pre-finalize state —
 * `speaking` — back over the finished record. `recoverLiveDirectionMessages`
 * then reads that on the next load and treats a settled message as unfinished.
 */
function clearPersistTimer() {
    clearTimeout(persistTimer);
    persistTimer = null;
}

function waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (predicate() || Date.now() - started >= timeoutMs) resolve();
            else setTimeout(tick, 30);
        };
        tick();
    });
}

function createId(prefix) {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
