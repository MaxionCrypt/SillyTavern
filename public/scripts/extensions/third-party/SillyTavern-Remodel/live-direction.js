import {
    extension_prompt_roles,
    extension_prompt_types,
    main_api,
    online_status,
    sendMessageAsUser,
    setExtensionPrompt,
} from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { generateGroupWrapper, is_group_generating } from '../../../group-chats.js';
import {
    executeMechanicsRequest,
    MECHANICS_PROTOCOL,
    undoMechanicsTransaction,
} from './mechanics-capabilities.js';
import { buildMechanicalSnapshot, previewMechanicalContext } from './mechanics-runtime.js';
import { buildDirectionSources, describeAllLore } from './direction-sources.js';
import { resolveByName } from './direction-address.js';
import { resolveDirectionActions } from './direction-chrome.js';
import { deriveBeats } from './direction-beats.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe, resolveDirectorRecipe } from './prompt-studio.js';
import { PROMPT_SOURCE_DEFINITIONS } from './prompt-studio-store.js';
import { parseDirectorReply } from './director-reply.js';
import { filterNarratorHistory } from './narrator-history.js';
import {
    abandonDirectorTurn,
    appendDirectorEntries,
    deleteDirectorEntry,
    readAllEntriesForOwner,
    readNarratorEntries,
} from './director-notes-store.js';
import { getMechanicsProfile, listMechanicsTransactions } from './variables-store.js';
import { readDirectionUnit, sanitizeDirectionText } from './live-direction-markers.js';
import { StructuredReplyError } from './structured-reply.js';
import { streamChatPrompt } from './story-stream.js';
import { updateScene } from './timeline-state.js';
import { recordDebugEvent } from './debug-console.js';

export const DIRECTION_PROTOCOL = 'remodel-direction/1';
const PACING = Object.freeze({
    slow: { cps: 28, wordMs: 35, min: 700, max: 2200, opening: 750 },
    natural: { cps: 45, wordMs: 25, min: 400, max: 1400, opening: 600 },
    fast: { cps: 75, wordMs: 12, min: 150, max: 650, opening: 350 },
    instant: { cps: Infinity, wordMs: 0, min: 0, max: 0, opening: 0 },
});

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
    onFailure: () => {},
    // Fires on every chunk of the Director's own streamed reply — cumulative
    // { text, reasoning }, same shape story-stream.js's onChunk already
    // hands callers. No-op by default so a caller that never registers one
    // costs nothing; timeline-spine.js registers updateDirectionStreamCard.
    onDirectorChunk: () => {},
};

let initialized = false;
let activeRun = null;
let revealTimer = null;
let persistTimer = null;
let pendingFailure = null;
let performerOverride = null;
let ownedGenerationDepth = 0;
let pendingSubmission = null;
let testAdapters = null;

/**
 * The hidden half of a direction pass — everything before a visible run exists.
 *
 * WHY THIS EXISTS: `activeRun` is assigned only in generateDirectedPerformer,
 * which is reached after the Director round-trip. That call is a real request
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
        // The Director now streams, so `aborted` is no longer only a flag the
        // pass checks between stages: it has to reach the open request itself.
        // Without this, pressing Stop during a two-minute Director call left
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
    // narrator-history.js): it renders what the Director decided, informed
    // only by its OWN prior prose, never by the user's words or another cast
    // member's. Everything the user did reaches it solely through the
    // Director's notes, which arrive as a separate injected system-role entry
    // (setExtensionPrompt('remodel_director_notes', …) above) — not through
    // this array — so this listener only ever narrows chat history, never
    // context.chat itself (still the true record other surfaces read) and
    // never the notes block.
    //
    // Guarded exactly like the listeners above: this fires for every native
    // Chat Completion request in the app, not only the directed performer's,
    // so it must do nothing outside the window Remodel's own
    // generateDirectedPerformer owns. Remodel's OWN hidden calls (the
    // Director's own request, Story prose) go out through story-stream.js's
    // sendOpenAIRequest directly and never reach prepareOpenAIMessages, so
    // they never fire this event at all — only the visible performer's native
    // context.generate()/generateGroupWrapper call does.
    context.eventSource.on(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        if (!eventData || !Array.isArray(eventData.chat)) return;
        eventData.chat = filterNarratorHistory(eventData.chat, { narratorName: activeRun.performer?.label || '' });
    });
    const finish = () => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
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
 * The trap is that Remodel's Director and mechanics calls go through
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
    if (!isDirectedLiveScene(scene)) return { active: false, state: 'Free play', pacing: scene?.liveDirection?.pacing || 'natural' };
    // A hidden Director pass is a busy pipeline with no visible run yet. It used
    // to report 'Ready' with Stop disabled, which is what invited the second
    // send that produced a second bubble — notifyTransient('Directing') is a
    // one-shot push, and any re-render (onSettled calls renderRoleplayScene)
    // repainted this idle state straight over it.
    const directing = Boolean(directionInFlight && !activeRun);
    return {
        active: true,
        state: activeRun?.state || (directing ? 'Directing' : 'Ready'),
        pacing: scene.liveDirection?.pacing || 'natural',
        openingLabel: activeRun?.openingLabel || '',
        canContinue: activeRun?.state === 'Waiting for you',
        canSend: !directing,
        canStop: directing || Boolean(activeRun && !['Ready', 'Complete'].includes(activeRun.state)),
        performerLabel: activeRun?.performer?.label || '',
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
    // otherwise pressing Stop during the Director call did nothing and the
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
 * A direction that was produced and never spoken.
 *
 * The Director has no message in the transcript on purpose — one there would
 * put its entries, secrets included, into the chat history the Narrator reads
 * — so "the Director went last" is this state rather than anything readable
 * off the chat. It is what a failed or stopped performer leaves behind, and it
 * is what the owner sees as "Direction paused".
 *
 * IN MEMORY ONLY, and deliberately. The envelope carries this pass's resolved
 * address book — the closed set of Variable and Goal names the model may
 * write to — and re-establishing that from a reload would mean persisting the
 * authorization alongside it. A reload therefore costs the standing direction
 * and Continue falls back to a fresh pass, which is a worse outcome than
 * keeping it and a much better one than speaking a direction against an
 * address book nobody can vouch for.
 */
let standingDirection = null;

function rememberStandingDirection({ scene, turn, envelope, performer, autonomousSequence, asked }) {
    // `asked` is the same fact the abandon-check in beginDirection's `finally`
    // keys on, and it has to be: a take the performer was never asked to speak
    // has its entries abandoned there, so remembering it here would leave
    // Continue offering to speak a direction that has been withdrawn.
    if (!asked || !envelope || !performer || turn === null) return;
    standingDirection = { sceneId: scene?.id || '', turn, envelope, performer, autonomousSequence: Number(autonomousSequence) || 0 };
    journal('standing.kept', { sceneId: standingDirection.sceneId, turn }, {
        summary: 'direction.standing: the direction was not spoken and is held for Continue',
    });
}

function readStandingDirection(scene) {
    if (!standingDirection) return null;
    // Scene-scoped for the same reason regenerate is: nothing structurally
    // prevents two Scenes resolving to the same chat, and a direction spoken
    // into the wrong one would apply an address book that Scene never
    // advertised.
    if (standingDirection.sceneId !== scene?.id) return null;
    // The turn has to still be there. The owner can delete it from the
    // notebook panel, and a direction whose entries are gone is a direction
    // that no longer says anything.
    if (!notebookTurnEntries(scene, standingDirection.turn).length) {
        standingDirection = null;
        return null;
    }
    return standingDirection;
}

/** Whether Continue should speak an existing direction rather than make a new one. */
export function hasStandingDirection(scene = hooks.getActiveScene()) {
    return Boolean(readStandingDirection(scene));
}

export function clearStandingDirection() {
    standingDirection = null;
}

/**
 * Retry: re-run the last step IN PLACE, discarding what it produced.
 *
 * Which step that is comes from the same pure resolver the buttons are
 * labelled from, so the button and the action cannot disagree about what
 * "last" means — they read one function.
 */
export async function retryLiveStep(scene = hooks.getActiveScene()) {
    const { retry } = resolveDirectionActions(describeDirectionStep(scene));
    if (retry.target === 'director') {
        const standing = readStandingDirection(scene);
        standingDirection = null;
        // The entries go with the direction they belong to: this is a retake
        // of that moment, and leaving the discarded take's rulings behind
        // would have the next Director read its own withdrawn judgment as
        // settled fact. Filed under the SAME turn number, so a retake of an
        // earlier moment is not stored as the newest turn.
        if (standing) discardNotebookTurn(scene, standing.turn);
        return requestNextDirection(scene, { notebookTurn: standing?.turn ?? null });
    }
    if (retry.target === 'narrator') return regenerateLastDirectedResponse(scene);
    journal('retry.rejected', { reason: retry.reason }, { severity: 'warn' });
    return false;
}

/**
 * Continue: advance to the next step, touching nothing that already exists.
 */
export async function continueLiveStep(scene = hooks.getActiveScene()) {
    const { continue: advance } = resolveDirectionActions(describeDirectionStep(scene));
    if (advance.target === 'narrator') return speakStandingDirection(scene);
    if (advance.target === 'director') return requestNextDirection(scene);
    journal('continue.rejected', { reason: advance.reason }, { severity: 'warn' });
    return false;
}

/**
 * Ask the performer again for a direction that already exists. No Director
 * call — that is the entire point, and on the owner's own connection it is the
 * half of the pass that costs seconds rather than milliseconds.
 */
async function speakStandingDirection(scene) {
    const standing = readStandingDirection(scene);
    if (!standing) return false;
    standingDirection = null;
    journal('standing.spoken', { sceneId: standing.sceneId, turn: standing.turn }, {
        summary: 'direction.standing: speaking the direction that was already made',
    });
    return generateDirectedPerformer({
        scene, envelope: standing.envelope, performer: standing.performer,
        autonomousSequence: standing.autonomousSequence,
    });
}

/** The inputs resolveDirectionActions needs, read from the chat and the store. */
function describeDirectionStep(scene) {
    const chat = getContext().chat || [];
    const last = chat[chat.length - 1];
    return {
        hasMessages: chat.length > 0,
        lastMessageIsUser: Boolean(last?.is_user),
        standingDirection: hasStandingDirection(scene),
        busy: Boolean(directionInFlight || activeRun && !['Waiting for you', 'Complete'].includes(activeRun.state)),
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
    if (!isDirectedLiveScene(scene) || activeRun || directionInFlight) return false;
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
    await context.deleteMessage(messageId);
    const performer = resolvePerformer(saved.performerRef, scene);
    // Is the discarded take's direction still there to replay?
    //
    // The direction is now the notebook turn the saved envelope points at, so
    // "replayable" is a question about the store, not about a string on the
    // message. When the entries are still there, a regenerate is one native
    // generation against the SAME turn — no second Director call, which on the
    // owner's own connection measured 101–202 seconds. A message saved before
    // this build carries no notebookTurn and is never replayable; it earns a
    // fresh pass instead, which is also what a deleted turn earns.
    const savedTurn = toTurnNumber(saved.envelope?.notebookTurn);
    const replayable = savedTurn !== null && notebookTurnEntries(scene, savedTurn).length > 0;
    if (!replayable || !performer) {
        // A fresh Director pass is about to write this moment again. Whatever
        // the discarded take left behind must go with the message it belonged
        // to — otherwise the notebook accumulates rulings from takes the user
        // never saw, and the Narrator reads a discarded attempt's judgment
        // beside the one that replaced it. Scoped to that turn, and a no-op
        // when the turn is already empty (which is why it can sit here).
        //
        // The retake is then filed under the SAME turn number rather than a
        // fresh one. `nextNotebookTurn` is max+1, so recomputing would only
        // give the freed number back when the discarded turn happened to be
        // the highest; with any later turn present, a retake of the earliest
        // moment would be filed as the newest turn and
        // groupNotebookEntriesByTurn would hand the Narrator the fiction out
        // of order.
        discardNotebookTurn(scene, savedTurn);
        return requestNextDirection(scene, { notebookTurn: savedTurn });
    }
    const envelope = normalizeEnvelope(saved.envelope, scene);
    // Every pending request that survived to this point (the undo loop above
    // reversed the ones this run actually applied) still needs the same
    // name-to-id resolution it had originally. Without these, regenerate
    // would resolve every name against empty Maps and reject them all as
    // "not advertised" — reverting a Variable or Goal change the user already
    // read, silently, while the notebook it was reasoned from still stands.
    envelope.variableRefs = new Map(Object.entries(saved.variableRefs || {}));
    envelope.goalRefs = new Map(Object.entries(saved.goalRefs || {}));
    envelope.addressBook = saved.addressBook || { entries: [], duplicates: [] };
    // Same reason: without the original authorization a persona-held Goal
    // request would be deferred for review on the replay of a turn the user
    // already authorized.
    envelope.authorizedGoalIds = [...(saved.authorizedGoalIds || [])];
    return generateDirectedPerformer({ scene, envelope, performer, autonomousSequence: Number(saved.autonomousSequence) || 0 });
}

async function beginDirection({ scene, action, insertUser, authorizedGoalIds = [], autonomousSequence = 0, notebookTurn = null, postedMessage = null } = {}) {
    // Checked before the Director call, not after: the Director costs a real
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
        // Any direction held from an earlier pass is superseded by this one.
        // Kept beside pendingFailure because they answer the same question —
        // what is left over from a pass that did not finish — and a leftover
        // that outlives the moment it was made would have Continue offering to
        // speak a direction about a scene that has since moved on.
        standingDirection = null;
        notifyTransient('Directing');
        const ready = await hooks.ensureSceneReady(scene);
        if (!ready) throw new Error('The native chat linked to this Scene could not be loaded.');
        if (token.aborted) return abandonPass(token, 'scene-ready');
        // Posted here, before the Director is asked anything, rather than
        // after the round trip returns — a real request that has measured
        // 101-202s, during which the user's own words used to be nowhere on
        // screen. buildDirectionSnapshot is told to leave this same entry out
        // of acceptedHistory below — NOT necessarily "the newest thing in
        // context.chat" (a retry after generation itself wrote a message and
        // then still failed can leave that message sitting after this one) —
        // so the Director sees it exactly once, under CURRENT ACTION
        // (direction-sources.js's describeSnapshot), not once there and once
        // more inside STORY SO FAR. `action` stays the single source handed to
        // the World Info scan and buildMechanicalSnapshot just below, so
        // neither scores it twice either.
        //
        // Once this runs there is no undoing it on a later failure in this
        // same pass: nothing downstream removes the message, so it stays in
        // the chat even if the Director call or the performer that follows it
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
            directorLabel: snapshot.director?.label || null,
            // Key names deliberately avoid the journal's sensitive-key regex
            // (debug-console.js SENSITIVE_KEY): it matches on the KEY before it
            // looks at the value, so `historyCount: 12` would be redacted to a
            // placeholder even though a count discloses nothing.
            acceptedLines: snapshot.acceptedHistory.length,
            goalCount: snapshot.mechanics?.goals?.length ?? null,
            receiptCount: snapshot.recentReceipts.length,
        }, { correlationId: token.id });
        if (token.aborted) return abandonPass(token, 'snapshot');
        const startedAt = Date.now();
        const reply = await requestDirection(scene, snapshot, {
            signal: token.controller.signal,
            onChunk: (update) => {
                // Forwarded on EVERY chunk, unconditionally — this is the one
                // line that makes the direction card fill live rather than
                // only appear at the start. The journal entry below stays
                // once-per-pass; the UI hook does not.
                hooks.onDirectorChunk(update);
                if (token.firstChunkAt) return;
                token.firstChunkAt = Date.now();
                // Time-to-first-token is the number the whole "the wait is
                // opaque" complaint is about, and it is invisible in a total
                // duration. Recorded once, not per chunk.
                journal('stream.first-chunk', { passId: token.id, afterMs: token.firstChunkAt - startedAt, chars: update.text.length }, { correlationId: token.id });
            },
        });
        // The notebook is written whatever happens next, including for a
        // Director the user interrupted: what it managed to say is a record of
        // this turn, and discarding it silently would be the one failure this
        // rework cannot afford. A cancelled take is stamped `abandoned` so it
        // never binds a later turn, and its trailing entry `incomplete` so the
        // owner's own record says where the cut landed.
        //
        // `notebookTurn` is supplied only by regenerate, which frees the
        // superseded take's turn and needs the retake to occupy that same
        // number — recomputing max+1 would file a retake of the earliest
        // moment as the newest turn and hand the Narrator the fiction out of
        // order.
        const turn = toTurnNumber(notebookTurn) ?? nextNotebookTurn(scene);
        const stored = appendDirectorEntries(scene.timelineId, {
            sceneId: scene.id,
            turn,
            entries: markSeveredEntry(reply.entries, reply.interrupted),
        });
        if (stored.length) storedTurn = turn;
        // The one place that knows both facts: this pass stored entries, and
        // nothing is configured to carry them. Since the depth-0 injection was
        // removed, that combination is a scene about to generate with no
        // direction at all — and every other symptom looks healthy.
        //
        // Only when the block is MISSING. A user who switched it off with the
        // per-block eye toggle chose this, and a warning repeated every turn
        // for a choice they just made is noise that teaches them to skip the
        // one case this exists for.
        const routing = describeDirectorNotesRouting();
        if (stored.length && !routing.block && !routing.present) {
            journal('notes.unrouted', {
                passId: token.id,
                turn,
                entryCount: stored.length,
                remedy: 'The active Roleplay · Chat recipe has no "Director\'s Notes" block, so this turn\'s direction reaches no one. Add it in Prompt Studio (Add context → Director\'s Notes).',
            }, { correlationId: token.id, severity: 'warn', summary: 'direction.notes: stored, but no block carries them to the Narrator' });
        }
        const envelope = buildDirectionEnvelope(reply, turn);
        journal('notebook', {
            passId: token.id,
            turn,
            // Kept, as the old `envelope` event carried it: correlationId joins
            // records by pass, but this is what joins this record to
            // generation.start/end, which are keyed by directionId.
            directionId: envelope.directionId,
            durationMs: Date.now() - startedAt,
            firstChunkMs: token.firstChunkAt ? token.firstChunkAt - startedAt : null,
            streamed: reply.streamed,
            interrupted: reply.interrupted,
            replyChars: reply.raw.length,
            reasoningLength: reply.reasoning.length,
            entryCount: stored.length,
            entryTypes: stored.map((entry) => entry.type),
            tailFound: reply.tailFound,
            requestCount: reply.state.requests.length,
            continueAfter: reply.state.flow.continue,
        }, { correlationId: token.id });
        // Design §3: a missing or unparseable tail is never an error. The turn
        // proceeds with no state changes — and this journal entry, which is the
        // only way a user ever finds out their recipe lost the fence.
        if (reply.tailError) {
            journal('tail.unparseable', { passId: token.id, turn, error: reply.tailError }, { correlationId: token.id, severity: 'warn', summary: 'direction.tail: unparseable, no state changed' });
        }
        // The Director round-trip is the long window. Anything that happened
        // during it — Stop, a user intervention outranking an autonomous pass —
        // lands here, before a single native token is spent.
        if (token.aborted) return abandonPass(token, 'director');
        // Performer selection is no longer the Director's to make — whoever
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
        // A direction the performer was asked to speak and did not is not
        // wasted — it is the expensive half of the pass, already paid for, and
        // its notebook entries are standing (the `finally` below abandons a
        // turn only when the performer was never asked). Keeping it lets
        // Continue ask the performer again for free, instead of spending a
        // second Director call to re-derive a direction that already exists.
        rememberStandingDirection({
            scene, turn: storedTurn, envelope: standingEnvelope,
            performer: standingPerformer, autonomousSequence, asked: askedThePerformer,
        });
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
        // by `abandonCancelledTurn`, called from finalizeRunMessage's
        // nothing-accepted exits. Deliberately not merged into one check:
        // this one keys on "was the performer asked", which must stay true
        // for a generation failure so failEmptyVisibleRun can re-run the same
        // turn against the same notes, and that one keys on the user having
        // cancelled, which failEmptyVisibleRun never claims.
        if (storedTurn !== null && !askedThePerformer) {
            const marked = abandonDirectorTurn(scene.timelineId, { sceneId: scene.id, turn: storedTurn });
            if (marked) {
                journal('notebook.abandoned', {
                    passId: token.id,
                    turn: storedTurn,
                    entryCount: marked,
                }, { correlationId: token.id, severity: 'warn', summary: `direction.notebook: turn ${storedTurn} produced nothing and is withheld` });
            }
        }
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
    // context.chat itself, so it is read back into the Director's prompt
    // exactly once, as `action` (CURRENT ACTION), rather than a second time
    // here (STORY SO FAR).
    //
    // Filtered by identity rather than "drop the last entry": on a retry
    // after a failure that left an orphaned performer response in
    // context.chat (generation wrote a message and then the pass still
    // failed), the user's own message is no longer last — the orphaned
    // response is. Dropping the tail there would strip the WRONG message: the
    // action would stay in acceptedHistory (so the Director reads it twice —
    // once here, once as CURRENT ACTION), the orphaned response would be
    // hidden from the Director entirely, and resolveVariableContext below
    // would score the action's text twice. Filtering by the object itself
    // finds the right entry regardless of what else has been appended since.
    //
    // Computing `id` against this filtered length rather than against
    // context.chat.length is what keeps every other message's id identical to
    // what it would have been without the insertion.
    const rawChat = context.chat || [];
    const effectiveChat = excludeFromHistory ? rawChat.filter((message) => message !== excludeFromHistory) : rawChat;
    // How many of the most recent messages ride along as raw prose, on top of
    // the Director's own notebook (which now carries continuity via
    // `[result]` entries) — user-settable, resolved from the active director
    // recipe's `directorSnapshot` block rather than the old hardcoded 40. See
    // resolveDirectorSnapshotHistoryDepth for the fallback rules.
    //
    // `effectiveChat.slice(-historyDepth)` is NOT safe at a depth of 0:
    // `-0 === 0` in JS, and `Array.prototype.slice(0)` returns the WHOLE
    // array, not an empty one — the exact opposite of what a depth of 0 must
    // mean. `sliceCount` is clamped into `[0, effectiveChat.length]` first and
    // only sliced when it is actually positive, which is what keeps a depth
    // of 0 meaning zero messages rather than silently reverting to
    // "everything".
    const historyDepth = resolveDirectorSnapshotHistoryDepth();
    const sliceCount = Math.min(Math.max(historyDepth, 0), effectiveChat.length);
    const recentChat = sliceCount > 0 ? effectiveChat.slice(-sliceCount) : [];
    const history = recentChat.map((message, index) => ({
        id: effectiveChat.length - sliceCount + index,
        role: message.is_user ? 'user' : 'assistant',
        name: message.name || '',
        content: sanitizeDirectionText(message.extra?.remodelDirection?.acceptedText ?? message.mes ?? ''),
        // A transcript line that simply stops mid-sentence is exactly what made
        // the Director re-issue a beat it had already been given: nothing in the
        // text said the line was cut rather than finished. Every interrupted
        // turn in the window is marked, not only the newest one, because a
        // truncated line two turns back is just as unreadable as a fresh one.
        interrupted: Boolean(readInterruptionRecord(message)),
    })).filter((message) => message.content.trim());
    // The interruption this pass is being asked to direct around: the newest
    // thing in the chat is a performance the user cut into, and no performer
    // has spoken since. A later completed response answers the question by
    // existing, so only the LAST entry is consulted — an older interruption is
    // history the Director already ruled on, and re-offering its unsaid
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
    const directorRef = normalizeRef(scene.liveDirection?.directorRef);
    const director = directorRef && cast.find((member) => normalizeRef(member.ref || member)?.id === directorRef.id);
    const performingCast = cast.filter((member) => !member.disabled && (!directorRef || normalizeRef(member.ref || member)?.id !== directorRef.id));
    const activatedEntries = [...(lore.allActivatedEntries || [])];
    // Preview never rolls or mutates and never carries authorized Goal ids —
    // but retrieval (resolveVariableContext) scores against action/history/
    // activatedEntries, so it still gets the real ones: the same `action`
    // this function was called with (the composer draft when there is one —
    // see previewDirectorPrompt), and the same history/activatedEntries just
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
        director: director ? {
            ref: director.ref || directorRef,
            label: director.label || director.name || directorRef.label,
            description: director.description || '',
            personality: director.personality || '',
            scenario: director.scenario || '',
            creatorNotes: director.creatorNotes || '',
            systemPrompt: director.systemPrompt || '',
            postHistoryInstructions: director.postHistoryInstructions || '',
        } : null,
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
        // Director reads from a plain fixture.
        interruption: cutOffRecord ? { performer: String(cutOff.name || '').trim(), ...cutOffRecord } : null,
        // The Director's own notebook, read back to its author.
        //
        // `readAllEntriesForOwner`, deliberately, NOT `readNarratorEntries`:
        // the Director wrote the secrets and is the one reader they were
        // always meant to reach. Only the Narrator is excluded, at a
        // different funnel entirely (formatDirectorNotesPrompt).
        //
        // Built HERE, before requestDirection appends this turn's reply, so
        // what the Director reads is strictly earlier turns — the memory,
        // not a copy of the thing it is about to write.
        //
        // It is not rendered by describeSnapshot (which picks its fields
        // explicitly, so a new snapshot field starts life unrendered rather
        // than arriving in the prompt because someone added it upstream). It
        // reaches the prompt only through the `directorNotebook` recipe
        // source, which is director-mode only.
        notebook: readAllEntriesForOwner(scene.timelineId, { sceneId: scene.id }),
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
 * Compiles the Director's prompt from a snapshot: resolve the active director
 * recipe, build its sources, compile it. The SAME steps a real request takes
 * (requestDirection below) and the ONLY place they run — the Prompt
 * Studio preview calls this too (see previewDirectorPrompt), so the preview
 * can never drift from what actually gets sent. A recipe that compiles to
 * nothing (emptied, or missing its protocol block) falls back to a minimal
 * built-in prompt rather than silently producing an unusable request.
 */
function compileDirectorPrompt(snapshot, { mechanicsEnabled = false, trace = false } = {}) {
    const recipe = resolveDirectorRecipe();
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled });
    let prompt;
    // Per-block provenance for the preview panel. Asking for it cannot change
    // `messages` (see compilePromptRecipe's own note), so the real send path
    // below is compiling the identical prompt whether or not this is on.
    let trail = [];
    if (recipe) {
        const compiled = compilePromptRecipe(recipe, sources, { trace });
        prompt = compiled.messages;
        trail = compiled.trace || [];
    }
    // Captured before any fallback swap: this is what the user's OWN recipe
    // compiled to, which is the number a diagnostic needs — after the swap
    // below, prompt.length would only ever report the fallback's own size.
    const compiledCount = prompt?.length || 0;
    const usedFallback = !prompt?.length || !prompt.some((message) => message.content.includes(sources.directionProtocol.slice(0, 40)));
    if (usedFallback) {
        // The notebook is resolved at the DECLARED default depth here, read
        // from the source definition rather than written out again — the
        // fallback has no recipe and therefore no block settings to consult,
        // and a second copy of the number would be one more place for the
        // vocabulary to drift. A Director whose recipe is broken still gets
        // its memory; losing that as well as the user's style block would
        // make the fallback worse than it needs to be.
        const notebook = sources.directorNotebook({ depth: declaredDirectorNotebookDepth() });
        // World Info as one block here, not four. The fallback exists for a
        // recipe that compiled to nothing, so it has no block order to honour
        // — but it still must not be the path where the Director quietly
        // loses its world information, which is exactly what would happen if
        // this list kept reading only the sources it read before the split.
        const lore = describeAllLore(snapshot?.lore);
        prompt = [
            { role: 'system', content: sources.directionProtocol },
            ...(lore ? [{ role: 'system', content: lore }] : []),
            ...(sources.directorCard ? [{ role: 'system', content: sources.directorCard }] : []),
            ...(sources.mechanicsSkill ? [{ role: 'system', content: sources.mechanicsSkill }] : []),
            ...(notebook ? [{ role: 'system', content: notebook }] : []),
            { role: 'user', content: sources.directorSnapshot },
        ];
        // The trace describes the user's recipe, and the recipe is no longer
        // what is being sent. Dropping it is what keeps the by-source panel
        // from captioning the built-in fallback with the blocks it replaced.
        trail = [];
    }
    return { recipe, sources, prompt, usedFallback, compiledCount, trace: trail };
}

/** The `directorNotebook` source's own declared default depth — one place. */
function declaredDirectorNotebookDepth() {
    return PROMPT_SOURCE_DEFINITIONS.director
        .find((source) => source.key === 'directorNotebook')?.settings?.depth?.default;
}

/**
 * How many of the most recent chat messages `buildDirectionSnapshot` slices
 * into the Director's own snapshot — the resolved `history` setting on the
 * active director recipe's `directorSnapshot` block.
 *
 * Resolved HERE, not read out of a compiled recipe: buildDirectionSnapshot
 * runs BEFORE compileDirectorPrompt/compilePromptRecipe — the snapshot this
 * function feeds is the very input buildDirectionSources renders into
 * `sources`, which is what the compile then reads — so by the time a recipe's
 * blocks are normally consulted for a per-block setting, the slice this one
 * governs has already happened. This is the one place in the pass that CAN
 * read it.
 *
 * No active director recipe, no `directorSnapshot` block on it, and a block
 * switched off are all the same case for this function: the setting is not in
 * effect for this pass. All three fall back to the source definition's own
 * declared default — never to the old hardcoded 40 — and the whole function is
 * wrapped so a lookup failure (a corrupt or mid-migration recipe store) can
 * never throw out of a direction pass; it degrades to the same default.
 *
 * `normalizeBlock` (prompt-studio-store.js) has already coerced, clamped and
 * defaulted this value into `block.settings.history` by the time any recipe
 * reaches here — see `coerceSettingValue`'s own comment on the
 * `Number(null) === 0` trap it exists to close — so this is a lookup, not a
 * second coercion site. Checked with `Number.isFinite`, not truthiness: a
 * user-set depth of 0 is a real value this must hand back as 0, not treat as
 * absent and fall through to the default because 0 is falsy.
 *
 * `recipe` defaults to the live lookup so the real call site
 * (buildDirectionSnapshot) never has to pass it — but it is still a real
 * parameter, not a hardcoded read, so a test can hand this an explicit `null`
 * or a hand-built recipe shape to exercise every fallback branch (no recipe,
 * no block, a disabled block) directly, without needing to contort the actual
 * prompt-studio store into an unreachable state to prove they hold.
 */
export function resolveDirectorSnapshotHistoryDepth(recipe = resolveDirectorRecipe()) {
    const declaredDefault = PROMPT_SOURCE_DEFINITIONS.director
        .find((source) => source.key === 'directorSnapshot')?.settings?.history?.default ?? 12;
    try {
        const block = recipe?.blocks?.find((entry) => entry.kind === 'source' && entry.sourceKey === 'directorSnapshot');
        if (!block || block.enabled === false) return declaredDefault;
        const value = block.settings?.history;
        return Number.isFinite(value) ? value : declaredDefault;
    } catch {
        return declaredDefault;
    }
}

/**
 * Preview-only: compiles the Director's prompt for the current Scene without
 * sending a request, rolling, or mutating anything (see buildDirectionSnapshot's
 * `preview` flag). Shares compileDirectorPrompt with the real request path, so
 * the recipe resolution, buildDirectionSources call, and compilePromptRecipe
 * call are the exact same code a real direction pass runs — that part cannot
 * drift.
 *
 * One input cannot be made exact: Variables/Goals retrieval
 * (resolveVariableContext, inside buildMechanicalSnapshot) is scored against
 * the message the user has not sent yet. This passes the real accepted
 * history, the real activated lore entries, and the current composer draft as
 * the action — the best available stand-in — but the retrieved set can still
 * differ from a real pass once the user's actual next action is known.
 *
 * Also returns `trace`: one record per enabled recipe block, saying which of
 * the compiled messages it merged into. Requesting it cannot change `prompt`
 * — see compilePromptRecipe — which is what lets the preview show the merge
 * without spending the parity that makes the preview worth showing. Empty when
 * `usedFallback`, because then the recipe's blocks are not what is being sent.
 */
export async function previewDirectorPrompt(scene) {
    if (!scene) return { prompt: [], recipe: null, snapshot: null, usedFallback: false, trace: [] };
    const action = hooks.getComposerDraft() || '[preview only: retrieve state; do not mutate or roll]';
    const snapshot = await buildDirectionSnapshot(scene, action, [], { preview: true });
    const profile = getMechanicsProfile();
    const { recipe, prompt, usedFallback, trace } = compileDirectorPrompt(snapshot, { mechanicsEnabled: profile.enabled, trace: true });
    return { prompt, recipe, snapshot, usedFallback, trace };
}

/**
 * Ask the Director for this turn's notebook, streaming.
 *
 * WHY STREAMING, AND WHY NO SCHEMA: core decides streaming in one line
 * (`openai.js`, `createGenerationParameters`) — `settings.stream_openai && type
 * !== 'quiet'` — and generateRaw/generateRawData hard-code the type to 'quiet'.
 * A schema-enforced call is therefore structurally unstreamable, and worse,
 * generateRawData returns `extractJsonFromData(...)` when a jsonSchema is
 * supplied and throws the provider's response object away — the only place
 * reasoning lives. Dropping the schema is what buys both back at once: the
 * Director's text arrives as it is written, and `state.reasoning` comes with
 * it instead of having to be stolen off the wire.
 *
 * Measured, which is why this is not a preference: one recorded pass spent
 * 101s producing 11,795 characters of reasoning and a 100-character
 * instruction, because reasoning and the envelope shared one token allowance.
 * The reply is free-form now; only the trailing state fence is machine-read.
 *
 * @returns {Promise<{entries: Array<{type: string, text: string}>,
 *   state: {requests: object[], flow: {continue: boolean}}, reasoning: string,
 *   raw: string, tailFound: boolean, tailError: string, interrupted: boolean,
 *   streamed: boolean}>}
 */
async function requestDirection(scene, snapshot, { onChunk, signal } = {}) {
    const profile = getMechanicsProfile();
    const { recipe, prompt, usedFallback, compiledCount } = compileDirectorPrompt(snapshot, { mechanicsEnabled: profile.enabled });
    if (usedFallback) {
        journal('recipe.fallback', { hadRecipe: Boolean(recipe), messages: compiledCount }, { severity: 'warn' });
    }
    // Held outside the try so an abort mid-reply keeps whatever arrived: the
    // transport may either return early having seen the signal, or throw from
    // the open fetch, and only one of those hands the text back.
    let raw = '';
    let reasoning = '';
    let streamed = false;
    const collect = (update) => {
        raw = update.text;
        reasoning = update.reasoning;
        onChunk?.(update);
    };
    if (testAdapters?.requestDirection) {
        const answer = await testAdapters.requestDirection({ scene, snapshot, prompt });
        raw = String(typeof answer === 'string' ? answer : answer?.text || '');
        reasoning = String(answer?.reasoning || '');
    } else {
        try {
            const result = await streamChatPrompt({ prompt, onChunk: collect, signal });
            raw = result.text;
            reasoning = result.reasoning;
            streamed = result.streamed;
        } catch (error) {
            // A cancelled request is not a failure to report — the user
            // cancelled it. Anything else still is.
            if (!signal?.aborted) throw error;
        }
    }
    lastDirectorReasoning = String(reasoning || '').trim();
    const interrupted = Boolean(signal?.aborted);
    raw = String(raw || '').trim();
    if (!raw && !interrupted) {
        throw new StructuredReplyError(
            'empty',
            'The Game Director returned nothing at all. This is almost always the token budget: reasoning is paid for out of the same allowance as the reply, so a thinking model can exhaust it before writing a single character. Reduce the model\'s reasoning effort, or raise its response length on this connection.',
        );
    }
    const reply = parseDirectorReply(raw);
    return {
        entries: reply.entries,
        // An interrupted reply is never read for state. Its tail either never
        // arrived or arrived half-written, and a fence that happens to parse
        // out of a severed reply would apply changes the Director had not
        // finished deciding.
        state: interrupted ? { requests: [], flow: { continue: false } } : reply.state,
        tailFound: interrupted ? false : reply.tailFound,
        tailError: interrupted ? '' : reply.tailError,
        reasoning: lastDirectorReasoning,
        raw,
        interrupted,
        streamed,
    };
}

/**
 * The envelope the rest of the pass runs on, built by code from what the
 * Director actually said.
 *
 * Everything here that is not the Director's judgment is Remodel's: the
 * protocol string is a local constant, and the direction id is generated. Both
 * used to be schema fields the model filled in, and both were observed being
 * filled in wrongly — one provider returned the literal `"dir-001"` for every
 * pass in a session, which made persistDirectionRecord's id-keyed log replace
 * its single record over and over and let one run's completion guards match
 * another run's id.
 *
 * `flow` is the one place the shapes differ. The reply carries a single
 * `continue`; the pipeline downstream reads `continueAfter`/`hardPauseAfter`.
 * Not continuing IS the scene waiting for the user, so the second field is
 * derived rather than invented — and with no tail at all both land on "wait",
 * which is the direction design §3 chose to fail in.
 */
function buildDirectionEnvelope(reply, turn) {
    const requests = getMechanicsProfile().enabled ? usableRequests(reply.state.requests) : [];
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId: createId('direction'),
        notebookTurn: turn,
        flow: {
            continueAfter: reply.state.flow.continue === true,
            hardPauseAfter: reply.state.flow.continue !== true,
        },
        requests,
    };
}

/**
 * Requests the mechanics layer can at least read.
 *
 * `parseDirectorReply` keeps anything object-typed, which includes arrays —
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
 * purpose: `appendDirectorEntries` uses it as its own "unknown" fallback, and
 * real turns start at 1.
 */
function toTurnNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const turn = Math.floor(Number(value));
    return Number.isFinite(turn) && turn > 0 ? turn : null;
}

/** The next turn number for this Scene's notebook: one past the highest stored. */
function nextNotebookTurn(scene) {
    return readAllEntriesForOwner(scene.timelineId, { sceneId: scene.id })
        .reduce((highest, entry) => Math.max(highest, Number(entry.turn) || 0), 0) + 1;
}

/**
 * One turn's stored entries, secrets included.
 *
 * `readAllEntriesForOwner`, deliberately, not `readNarratorEntries`: these
 * callers ask what the Director wrote, not what the performer may read, and a
 * turn that consists only of secrets is still a turn that happened.
 */
function notebookTurnEntries(scene, turn) {
    const wanted = toTurnNumber(turn);
    if (!scene?.timelineId || wanted === null) return [];
    return readAllEntriesForOwner(scene.timelineId, { sceneId: scene.id })
        .filter((entry) => Number(entry.turn) === wanted);
}

/** Erase one turn from the notebook. Used only when its take is discarded. */
function discardNotebookTurn(scene, turn) {
    const entries = notebookTurnEntries(scene, turn);
    if (!entries.length) return 0;
    for (const entry of entries) deleteDirectorEntry(scene.timelineId, entry.id);
    journal('notebook.discarded', { turn: toTurnNumber(turn), entryCount: entries.length }, { severity: 'warn', summary: `direction.notebook: turn ${turn} discarded with its take` });
    return entries.length;
}

/**
 * Mark where an interrupted reply was cut: the LAST entry, and only that one.
 * Every earlier entry was closed by a newline the Director did write.
 *
 * This is the owner's record of what was severed, and nothing else. Whether
 * the TAKE counts — whether the Narrator ever sees any of it — is a separate
 * question with a separate answer, decided by beginDirection's `finally` on
 * what the pass actually produced rather than on how it ended. An interrupted
 * pass is one way to produce nothing; a pass that stored entries and then
 * threw is another, and keying the withholding here would only have caught
 * the first.
 */
function markSeveredEntry(entries, interrupted) {
    const list = Array.isArray(entries) ? entries : [];
    if (!interrupted || !list.length) return list;
    return list.map((entry, index) => (index === list.length - 1 ? { ...entry, incomplete: true } : entry));
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
 * The Director is NOT re-run: the direction was valid, only its rendering
 * failed, and re-directing would cost a second long call and could change the
 * direction the user is waiting on.
 */
const EMPTY_RESPONSE_RETRIES = 2;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 400;

async function generateDirectedPerformer({ scene, envelope, performer, autonomousSequence, token = null, emptyRetries = 0 }) {
    const director = resolveDirector(scene);
    persistDirectionRecord(scene, envelope, performer, director);
    activeRun = {
        directionId: envelope.directionId,
        sceneId: scene.id,
        timelineId: scene.timelineId,
        messageId: null,
        performer,
        director,
        envelope,
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
    // NOTE: there is no depth-0 direction injection any more (design §7). It
    // carried the Director's one-line `instruction`, and there is no longer an
    // instruction to carry: this turn's notebook entries ARE the direction and
    // they reach the performer through the Director's Notes block below. A
    // second channel here would deliver the same entries twice, at two depths,
    // inside one prompt.
    //
    // Re-mirror the Director's Notes HERE, at the generation seam — not only
    // from renderRoleplayScene's idle-state mirror (which stays in place for
    // when no generation is in flight). renderRoleplayScene only runs on UI
    // and post-generation events; nothing calls it in the window between this
    // turn's entries landing in the store (appendDirectorEntries) and
    // context.generate() a few lines below. Without this call the Narrator
    // would always read last turn's notebook and never the one just written
    // for it — reproducing, from outside, the exact "Narrator ignoring the
    // direction" symptom this whole rework exists to fix.
    setExtensionPrompt('remodel_director_notes', formatDirectorNotesPrompt(scene), extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM, () => hooks.getActiveScene()?.id === scene.id);
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
        }, { correlationId: envelope.directionId });
        if (testAdapters?.generatePerformer) {
            await testAdapters.generatePerformer({ scene, envelope, performer, options, context });
        } else if (context.groupId) {
            // Do not route an owned performer request back through generic
            // Generate(). In a native group that function conditionally enters
            // the group wrapper; if core still considers a preceding group
            // operation active, it silently falls through as a solo request and
            // can return after only /api/ping. The Director has already selected
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
            // Re-checked here as well as before the Director call: the Director
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
        journal('generation.end', {
            directionId: envelope.directionId,
            durationMs: Date.now() - generationStartedAt,
            messageId: activeRun?.directionId === envelope.directionId ? activeRun.messageId : null,
            bufferedLength: activeRun?.directionId === envelope.directionId ? activeRun.rawBufferedText.length : null,
            stillOwned: activeRun?.directionId === envelope.directionId,
        }, { correlationId: envelope.directionId });
        if (activeRun?.directionId === envelope.directionId) {
            activeRun.generationFinished = true;
            activeRun.generationSettled = true;
            scheduleReveal(0);
        }
    }
    return true;
}

function acceptNativeBuffer(text) {
    if (!activeRun) return;
    activeRun.rawBufferedText = String(text ?? '');
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
    // empty rows that each fed the next Director pass as accepted history.
    if (!sanitizeDirectionText(run.acceptedVisibleText)) {
        await failEmptyVisibleRun(run);
        return;
    }
    await finalizeRunMessage(run, { state: 'complete' });
    run.acceptedComplete = true;
    run.autonomousSequence += 1;
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
            });
        } finally {
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
        willDeleteMessage: !sanitizeDirectionText(run.acceptedVisibleText),
    }, { correlationId: run.directionId, severity: 'warn' });
    run.interrupted = true;
    run.holdReason = 'interrupt';
    if (!run.generationSettled && ownsLiveDirectionGeneration()) {
        getContext().stopGeneration?.();
        await waitFor(() => run.generationSettled, 2200);
    }
    // A completed API call can still have an unseen suffix buffered. It no
    // longer owns a native generation, but it is equally discardable.
    await finalizeRunMessage(run, { state: preserveForIntervention ? 'interrupted' : 'stopped' });
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
        abandonCancelledTurn(run);
        return;
    }
    const accepted = sanitizeDirectionText(run.acceptedVisibleText);
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
        abandonCancelledTurn(run);
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
        // performer's unspoken intention for the Director to rule on.
        discardedLength: Math.max(0, run.rawBufferedText.length - run.rawOffset),
        interrupted: Boolean(run.interrupted),
        cutShort: Boolean(interruption),
        unspokenLength: interruption?.unspokenRemainder.length ?? 0,
    }, { correlationId: run.directionId });
    message.mes = accepted;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
    message.extra ??= {};
    message.extra.remodelDirection = serializeRun(run, state);
    if (run.performer.ref.kind === 'narrator') message.extra.type = 'narrator';
    await context.saveChat();
}

/**
 * A take the USER cancelled that accepted nothing did not happen, so withhold
 * its notebook turn from the next one.
 *
 * beginDirection's `finally` already covers every take that never reached the
 * performer. This is the gap on the other side of that line: the Director
 * returns, its entries are stored, `askedThePerformer` is set, generation
 * begins — and the user presses Stop before the reveal emits a single
 * character. `finalizeRunMessage` then DELETES the message and returns before
 * `applyPendingRequests`, so no message and no state change survive. Without
 * this call, that turn's `[ruling]` and `[result]` entries were still
 * delivered to the Narrator on the next turn under "treat as settled fact",
 * with "Ruling — binding: " in front of them, describing prose that does not
 * exist in the chat. The withholding ruling's own words for that situation
 * are "a cancelled take produced no message and changed no state"; the branch
 * implemented it for a Stop during the Director stream and the opposite for a
 * Stop two seconds later, with nothing on screen distinguishing the two.
 *
 * Keyed on `run.interrupted`, which is what makes it disjoint from
 * `failEmptyVisibleRun`: that path deliberately does NOT set the flag (the
 * user did nothing, so recording an interruption would misreport the
 * failure), and it re-runs this SAME turn against these SAME notes. Withholding
 * there would make the retry generate with no direction at all.
 *
 * Called from both of `finalizeRunMessage`'s nothing-accepted exits rather
 * than only the delete-empty one, so a run whose message went missing
 * entirely is covered by construction instead of by remembering — the same
 * reasoning that moved the beginDirection check into a `finally`.
 */
function abandonCancelledTurn(run) {
    if (!run?.interrupted || !run.timelineId) return;
    const turn = toTurnNumber(run.envelope?.notebookTurn);
    if (turn === null) return;
    const marked = abandonDirectorTurn(run.timelineId, { sceneId: run.sceneId, turn });
    if (!marked) return;
    journal('notebook.abandoned', {
        directionId: run.directionId,
        turn,
        entryCount: marked,
        reason: 'the user stopped this take before it produced a single visible character',
    }, { correlationId: run.directionId, severity: 'warn', summary: `direction.notebook: turn ${turn} was cancelled and is withheld` });
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

function serializeRun(run, state) {
    // beginDirection attaches the pass's runtime state to the envelope; none
    // of it belongs in the saved copy. The two Maps stringify to `{}`, which
    // reads like data and is not, and addressBook/authorizedGoalIds are
    // written once at the top level below — storing them twice per message
    // made the inert copy look like the authoritative one.
    const { variableRefs, goalRefs, addressBook, authorizedGoalIds, ...envelope } = run.envelope || {};
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId: run.directionId,
        sceneId: run.sceneId,
        state,
        acceptedText: sanitizeDirectionText(run.acceptedVisibleText),
        revealOffset: run.rawOffset,
        performerRef: run.performer.ref,
        envelope,
        checkpointTransactionIds: [...run.checkpointTransactionIds],
        // As plain objects: a Map stringifies to {}, so a recovered run would
        // otherwise resolve no refs at all and every surviving request would
        // be rejected as never advertised.
        variableRefs: Object.fromEntries(run.variableRefs || []),
        goalRefs: Object.fromEntries(run.goalRefs || []),
        addressBook: run.addressBook || { entries: [], duplicates: [] },
        // The user's attached Goal attempts. Without these a request applied
        // after recovery or regenerate loses its authority and is deferred to
        // the pending-review queue instead of applying — fail-safe, but the
        // user already read the fiction that earned it.
        authorizedGoalIds: [...(run.authorizedGoalIds || [])],
        pendingRequestsApplied: Boolean(run.pendingRequestsApplied),
        interrupted: Boolean(run.interrupted),
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
 * as interruptions would put a cut-off notice on the Director's desk for every
 * ordinary completed turn — the loudest possible way to be wrong. `acceptedComplete`
 * is what completeVisibleRun sets once the whole buffer has been revealed and
 * accepted, so `interrupted && !acceptedComplete` is the pair that means the
 * reveal stopped early because the user made it stop.
 *
 * NOTHING ACCEPTED RETURNS NULL, and that is the design's distinction, not a
 * defensive guard. An interruption at character zero is not a small version of
 * an interruption at character four hundred: nothing was read, so nothing
 * became fiction, and finalizeRunMessage deletes the message and applies no
 * state at all. There is no turn for the Director to direct around, and telling
 * it a beat was cut short would invite it to write around a beat the user never
 * saw a word of. Mid-sentence is the opposite case: the read half IS fiction and
 * has to be worked with. The two must not arrive as one flag.
 *
 * The remainder is KEPT rather than dropped. It is the tail of the buffer past
 * `rawOffset` — the exact text the reveal loop had not emitted when it froze —
 * and it is the only evidence of what the performer was in the middle of doing.
 * Destroying it is what made an interruption an error instead of an event: a
 * Director asked to rule on "someone grabs you and drags you toward the door"
 * cut after "grabs you" cannot decide whether the drag still happens if the
 * drag no longer exists anywhere. It is stored, and rendered, as an unspoken
 * intention (direction-sources.js's describeInterruption) — never as something
 * that occurred, because only fiction the user actually read may change what
 * is established.
 */
function describeRunInterruption(run) {
    if (!run?.interrupted || run.acceptedComplete) return null;
    const accepted = sanitizeDirectionText(run.acceptedVisibleText);
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
    return { ...run, envelope: undefined };
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
    const director = normalizeRef(scene.liveDirection?.directorRef);
    const cast = (hooks.getCast() || []).filter((item) => {
        const candidate = item.ref || normalizeRef(item);
        return !item.disabled && (!director || candidate?.id !== director.id);
    });
    const normalized = normalizeRef(ref);
    // Do not reject an empty ref before considering the only native performer
    // the Scene actually makes available. `ref` is never model-selected —
    // performer selection is code's, not the Director's — but a Scene may
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

function resolveDirector(scene) {
    const requested = normalizeRef(scene?.liveDirection?.directorRef);
    if (!requested) return null;
    const member = (hooks.getCast() || []).find((item) => normalizeRef(item.ref || item)?.id === requested.id);
    if (!member) return null;
    return {
        characterId: Number(member.characterId),
        label: member.label || member.name || requested.label || 'Roleplay Director',
        ref: { kind: 'character', id: requested.id, label: member.label || member.name || requested.label || 'Roleplay Director' },
    };
}

/**
 * The Director's raw reasoning, from the most recent direction request.
 *
 * It arrives on the stream now — `sendOpenAIRequest`'s generator accumulates
 * `state.reasoning` alongside the text — so this is just the last value that
 * came off it, held for `persistDirectionRecord` to put on the direction card.
 *
 * Getting hold of it used to require wrapping `globalThis.fetch` for the
 * duration of the call and reading a clone of the response, because
 * `generateRawData` returns `extractJsonFromData(data)` whenever a jsonSchema
 * is supplied and the provider's response object — the only place reasoning
 * lives — never escaped the function. Dropping the schema deleted that patch.
 */
let lastDirectorReasoning = '';

/** Compact, storable summary of what the Director asked the system to do. */
function summarizeRequests(requests) {
    return (Array.isArray(requests) ? requests : []).filter(Boolean).map((request) => ({
        capability: String(request.capability || 'unknown'),
        reason: String(request.reason || '').trim(),
    })).slice(0, 40);
}

/**
 * The direction card's headline, drawn from the notebook turn this direction
 * belongs to.
 *
 * Secrets are left out. The card renders inline in the Roleplay stream right
 * beside the prose, and while a secret IS the owner's to see, "the owner
 * happens to be looking at the story" is not the moment to put it on screen
 * unlabelled. The owner-facing notebook surface is where secrets belong, and
 * it can mark them as withheld.
 */
function describeDirectionForRecord(scene, turn) {
    return notebookTurnEntries(scene, turn)
        .filter((entry) => entry.type !== 'secret')
        .map((entry) => String(entry.text || '').trim())
        .filter(Boolean)
        .join('\n');
}

function persistDirectionRecord(scene, envelope, performer, director) {
    if (!scene) return;
    // normalizeDirectionRecord (timeline-state.js) drops a record with no
    // objective, so a turn that produced nothing readable writes no card
    // rather than an empty one.
    const objective = describeDirectionForRecord(scene, envelope?.notebookTurn);
    if (!objective) return;
    const existing = Array.isArray(scene.liveDirection?.directionLog) ? scene.liveDirection.directionLog : [];
    const record = {
        id: envelope.directionId,
        createdAt: new Date().toISOString(),
        directorRef: director?.ref || null,
        directorLabel: director?.label || 'Game Director',
        performerRef: performer.ref,
        performerLabel: performer.label,
        // Still `objective`: this is the field timeline-state.js's
        // normalizeDirectionRecord requires (and the roleplay stream's
        // direction card already reads) to keep the record instead of silently
        // dropping it. Its content is the turn's notebook now.
        objective,
        operations: summarizeRequests(envelope.mechanics.pendingRequests),
        reasoning: lastDirectorReasoning,
        continueAfter: envelope.flow.continueAfter,
        hardPauseAfter: envelope.flow.hardPauseAfter,
    };
    const next = [...existing.filter((item) => item?.id !== record.id), record].slice(-60);
    updateScene(scene.id, { liveDirection: { ...scene.liveDirection, directionLog: next } });
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
        flow: { continueAfter: Boolean(value.flow?.continueAfter), hardPauseAfter: Boolean(value.flow?.hardPauseAfter) },
        mechanics: { pendingRequests },
        sceneId: scene.id,
    };
}

/**
 * The Director's recent notes for this Scene, as prose for the Narrator's
 * directorNotes recipe block — the counterpart to direction-sources.js's
 * `section()` register: a heading with nothing under it tells the Narrator
 * less than no heading, so no entries renders nothing at all, never an empty
 * bracketed block.
 *
 * `entries` is expected to already be Narrator-safe (readNarratorEntries has
 * filtered `secret` and applied the depth window) — this function only
 * renders what it is given and does not re-check `type` itself. Re-checking
 * here would suggest the boundary might not already be enforced, when the
 * whole point of readNarratorEntries is that it is.
 *
 * Grouped by turn and sorted ascending, so the newest turn's notes land last
 * — closest to the generation point, the same ordering direction-sources.js
 * uses for STORY SO FAR. `ruling` and `result` are labelled, because unlike a
 * `note` they are not colour: a ruling binds the next response and a result
 * is a settled fact, and the performer needs to tell those apart from
 * scene-setting observation.
 */
export function buildDirectorNotesSource(entries) {
    const turns = groupNotebookEntriesByTurn(entries);
    if (!turns.length) return '';
    const body = turns
        .map(([turn, turnEntries]) => describeNotebookTurn(turn, turnEntries))
        .filter(Boolean)
        .join('\n\n');
    if (!body) return '';
    return `[DIRECTOR'S NOTES — established by the hidden director; treat as settled fact]\n${body}`;
}

function groupNotebookEntriesByTurn(entries) {
    const byTurn = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry) continue;
        const turn = Number.isFinite(Number(entry.turn)) ? Number(entry.turn) : 0;
        if (!byTurn.has(turn)) byTurn.set(turn, []);
        byTurn.get(turn).push(entry);
    }
    return [...byTurn.entries()].sort((a, b) => a[0] - b[0]);
}

const NOTEBOOK_ENTRY_LABELS = Object.freeze({ ruling: 'Ruling — binding: ', result: 'Established: ' });

function describeNotebookTurn(turn, turnEntries) {
    const lines = turnEntries.map(describeNotebookEntry).filter(Boolean);
    return lines.length ? `Turn ${turn}\n${lines.join('\n')}` : '';
}

/**
 * No `incomplete` marker here, deliberately. A severed entry only ever exists
 * inside a cancelled take, and `readNarratorEntries` withholds a cancelled
 * take in full — so a fragment cannot reach this function through any
 * production path, and a marker rendered here would be a caption for
 * something the performer never sees. The flag is the owner's record; the
 * withholding is the performer's protection.
 */
function describeNotebookEntry(entry) {
    const text = String(entry?.text || '').trim();
    if (!text) return '';
    return `- ${NOTEBOOK_ENTRY_LABELS[entry?.type] || ''}${text}`;
}

/**
 * Ties the notes source to the currently active Roleplay/Chat recipe: reads
 * that recipe's OWN directorNotes block for its `settings.depth`, rather than
 * a hardcoded default, so the depth the user configured in Prompt Studio is
 * the one that actually governs what the Narrator reads — this is the
 * "settings feed the compile" requirement, applied at the one real call site
 * that reaches production generation (timeline-spine.js mirrors this into
 * SillyTavern's native prompt manager via setExtensionPrompt, the same way it
 * does for Story Goals).
 *
 * No directorNotes block on the recipe (removed by the user, or a recipe
 * imported from native settings that never carried one) means the Narrator
 * gets no notes — an explicit opt-out, not a fallback default. A block that
 * is merely disabled (Prompt Studio's per-block eye toggle) is the same
 * opt-out: the toggle is a visible, discoverable control and must not be the
 * one thing on this block that silently does nothing.
 *
 * Since the depth-0 direction injection was removed, this block is the ONLY
 * route the Director's direction takes to the Narrator — so its absence is no
 * longer a missing extra, it is a scene generating against no direction at
 * all. That is why beginDirection journals a warning when a pass stores
 * entries and findDirectorNotesBlock returns nothing: silence here is
 * indistinguishable from a Director that had nothing to say.
 */
export function formatDirectorNotesPrompt(scene) {
    if (!scene?.timelineId) return '';
    const { block } = describeDirectorNotesRouting();
    if (!block) return '';
    const entries = readNarratorEntries(scene.timelineId, { sceneId: scene.id, depth: block.settings?.depth });
    return buildDirectorNotesSource(entries);
}

/**
 * How the active Roleplay/Chat recipe is set up to carry the Director's notes.
 *
 * `block` is the enabled one, if any. `present` says whether the recipe has a
 * Director's Notes block AT ALL — which is the difference between a user who
 * switched it off and a user who never had it. Both deliver nothing; only one
 * of them is a surprise, and warning about the other one every single turn
 * trains the user to ignore the warning, costing it the case it exists for.
 */
function describeDirectorNotesRouting() {
    const recipe = getCurrentPromptStudioRecipe('roleplay', 'chat');
    const blocks = (recipe?.blocks || []).filter((entry) => entry.kind === 'source' && entry.sourceKey === 'directorNotes');
    return { block: blocks.find((entry) => entry.enabled !== false) || null, present: blocks.length > 0 };
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
