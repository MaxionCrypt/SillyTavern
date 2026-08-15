import {
    extension_prompt_roles,
    extension_prompt_types,
    main_api,
    online_status,
    sendMessageAsUser,
    setExtensionPrompt,
} from '../../../../script.js';
import { extractReasoningFromData } from '../../../reasoning.js';
import { getContext } from '../../../st-context.js';
import { generateGroupWrapper, is_group_generating } from '../../../group-chats.js';
import {
    executeMechanicsRequest,
    getMechanicsRequestSchema,
    MECHANICS_PROTOCOL,
    toCoreJsonSchema,
    undoMechanicsTransaction,
} from './mechanics-capabilities.js';
import { buildMechanicalSnapshot, previewMechanicalContext } from './mechanics-runtime.js';
import { buildDirectionSources } from './direction-sources.js';
import { resolveByName } from './direction-address.js';
import { deriveBeats } from './direction-beats.js';
import { compilePromptRecipe, resolveDirectorRecipe } from './prompt-studio.js';
import { getMechanicsProfile, listMechanicsTransactions } from './variables-store.js';
import { readDirectionUnit, sanitizeDirectionText } from './live-direction-markers.js';
import { directorResponseTokens, interpretStructuredReply } from './structured-reply.js';
import { updateScene } from './timeline-state.js';
import { recordDebugEvent } from './debug-console.js';

export const DIRECTION_PROTOCOL = 'remodel-direction/1';
const DIRECTION_PROMPT_KEY = 'remodel_live_direction';
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
    };
    directionInFlight = token;
    return token;
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
        directionInFlight.aborted = true;
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

export async function requestNextDirection(scene = hooks.getActiveScene()) {
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
    return beginDirection({ scene, action: '[Continue the scene from accepted history.]', insertUser: false, autonomousSequence: sequence });
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
        directionInFlight.aborted = true;
        directionInFlight = null;
        notifyState();
        hooks.onSettled();
        if (!activeRun) return true;
    }
    if (!activeRun) return stoppedAutoplay;
    await interruptLiveDirection({ preserveForIntervention: false });
    return true;
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

export function sendWithoutLiveDirection() {
    const retry = pendingFailure;
    pendingFailure = null;
    if (!retry?.insertUser) return false;
    hooks.sendNormally(retry.action);
    return true;
}

/**
 * Whether the pending failure has user text a bypass could actually send.
 *
 * A failure on an autonomous continuation has none — there is no intervention
 * to re-send — so offering "Send Normally" there is a button that cannot do
 * anything when clicked.
 */
export function canSendWithoutLiveDirection() {
    return Boolean(pendingFailure?.insertUser);
}

export async function regenerateLastDirectedResponse(scene = hooks.getActiveScene()) {
    if (!isDirectedLiveScene(scene) || activeRun || directionInFlight) return false;
    cancelAutoplay('regenerate');
    const context = getContext();
    const messageId = context.chat.length - 1;
    const message = context.chat[messageId];
    const saved = message?.extra?.remodelDirection;
    if (!saved || message.is_user) return false;
    const transactionIds = [...(saved.checkpointTransactionIds || [])].reverse();
    const transactions = listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id });
    for (const id of transactionIds) {
        const tx = transactions.find((item) => item.id === id);
        if (tx) undoMechanicsTransaction(tx);
    }
    await context.deleteMessage(messageId);
    const performer = resolvePerformer(saved.performerRef, scene);
    // `movement.objective` covers a message saved by the previous schema, the
    // same fallback normalizeEnvelope itself applies.
    const hadInstruction = Boolean(saved.envelope?.instruction || saved.envelope?.movement?.objective);
    if (!hadInstruction || !performer) return requestNextDirection(scene);
    const envelope = normalizeEnvelope(saved.envelope, scene);
    // Every pending request that survived to this point (the undo loop above
    // reversed the ones this run actually applied) still needs the same
    // name-to-id resolution it had originally. Without these, regenerate
    // would resolve every name against empty Maps and reject them all as
    // "not advertised" — reverting a Variable or Goal change the user already
    // read, silently, while the reused instruction still describes it.
    envelope.variableRefs = new Map(Object.entries(saved.variableRefs || {}));
    envelope.goalRefs = new Map(Object.entries(saved.goalRefs || {}));
    envelope.addressBook = saved.addressBook || { entries: [], duplicates: [] };
    return generateDirectedPerformer({ scene, envelope, performer, autonomousSequence: Number(saved.autonomousSequence) || 0 });
}

async function beginDirection({ scene, action, insertUser, authorizedGoalIds = [], autonomousSequence = 0 } = {}) {
    // Checked before the Director call, not after: the Director costs a real
    // request and ~17s, and there is no point spending either when the
    // performer that follows it cannot speak.
    const blocked = !scene ? 'No active Scene.' : describeNativeGenerationBlock();
    if (blocked) {
        journal('blocked', { reason: blocked }, { severity: 'warn' });
        return directionFailure(new Error(blocked), { scene, action, insertUser, authorizedGoalIds, autonomousSequence });
    }
    // Last line of defence. Every caller checks the lock, but they are all async
    // and a caller that awaited something in between could still arrive here
    // after another pass took it.
    if (directionInFlight) {
        journal('begin.rejected', { reason: 'a direction is already in flight', passId: directionInFlight.id }, { severity: 'warn' });
        return false;
    }
    const token = acquireDirectionLock({ scene, insertUser, autonomousSequence });
    journal('begin', {
        passId: token.id,
        sceneId: scene.id,
        insertUser: Boolean(insertUser),
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
        const snapshot = await buildDirectionSnapshot(scene, action, authorizedGoalIds);
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
        const envelope = await requestDirectionEnvelope(scene, snapshot);
        journal('envelope', {
            passId: token.id,
            directionId: envelope.directionId,
            durationMs: Date.now() - startedAt,
            instructionChars: String(envelope.instruction || '').length,
            requestCount: envelope.requests.length,
            continueAfter: envelope.flow.continueAfter,
            hardPauseAfter: envelope.flow.hardPauseAfter,
            reasoningLength: lastDirectorReasoning.length,
            // Logged next to the reasoning it competes with, so headroom is
            // readable straight off an export instead of inferred: reasoning
            // and the envelope share this allowance, and overrunning it shows
            // up as a truncated envelope rather than a shorter answer.
            responseLimit: directorResponseTokens(getMechanicsProfile()),
        }, { correlationId: token.id });
        // The Director round-trip is the long window. Anything that happened
        // during it — Stop, a user intervention outranking an autonomous pass —
        // lands here, before a single native token is spent.
        if (token.aborted) return abandonPass(token, 'envelope');
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
        if (insertUser) {
            await sendMessageAsUser(action);
            hooks.clearComposer();
        }
        return await generateDirectedPerformer({ scene, envelope: normalized, performer, autonomousSequence, token });
    } catch (error) {
        return directionFailure(error, { scene, action, insertUser, authorizedGoalIds, autonomousSequence });
    } finally {
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

async function buildDirectionSnapshot(scene, action, authorizedGoalIds, { preview = false } = {}) {
    const context = getContext();
    const cast = hooks.getCast() || [];
    const persona = hooks.getPersona() || null;
    const history = (context.chat || []).slice(-40).map((message, index) => ({
        id: context.chat.length - Math.min(40, context.chat.length) + index,
        role: message.is_user ? 'user' : 'assistant',
        name: message.name || '',
        content: sanitizeDirectionText(message.extra?.remodelDirection?.acceptedText ?? message.mes ?? ''),
    })).filter((message) => message.content.trim());
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
 * (requestDirectionEnvelope below) and the ONLY place they run — the Prompt
 * Studio preview calls this too (see previewDirectorPrompt), so the preview
 * can never drift from what actually gets sent. A recipe that compiles to
 * nothing (emptied, or missing its protocol block) falls back to a minimal
 * built-in prompt rather than silently producing an unusable request.
 */
function compileDirectorPrompt(snapshot, { mechanicsEnabled = false } = {}) {
    const recipe = resolveDirectorRecipe();
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled });
    let prompt;
    if (recipe) {
        prompt = compilePromptRecipe(recipe, sources).messages;
    }
    // Captured before any fallback swap: this is what the user's OWN recipe
    // compiled to, which is the number a diagnostic needs — after the swap
    // below, prompt.length would only ever report the fallback's own size.
    const compiledCount = prompt?.length || 0;
    const usedFallback = !prompt?.length || !prompt.some((message) => message.content.includes(sources.directionProtocol.slice(0, 40)));
    if (usedFallback) {
        prompt = [
            { role: 'system', content: sources.directionProtocol },
            ...(sources.directorCard ? [{ role: 'system', content: sources.directorCard }] : []),
            ...(sources.mechanicsSkill ? [{ role: 'system', content: sources.mechanicsSkill }] : []),
            { role: 'user', content: sources.directorSnapshot },
        ];
    }
    return { recipe, sources, prompt, usedFallback, compiledCount };
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
 */
export async function previewDirectorPrompt(scene) {
    if (!scene) return { prompt: [], recipe: null, snapshot: null, usedFallback: false };
    const action = hooks.getComposerDraft() || '[preview only: retrieve state; do not mutate or roll]';
    const snapshot = await buildDirectionSnapshot(scene, action, [], { preview: true });
    const profile = getMechanicsProfile();
    const { recipe, prompt, usedFallback } = compileDirectorPrompt(snapshot, { mechanicsEnabled: profile.enabled });
    return { prompt, recipe, snapshot, usedFallback };
}

async function requestDirectionEnvelope(scene, snapshot) {
    const profile = getMechanicsProfile();
    const { recipe, prompt, usedFallback, compiledCount } = compileDirectorPrompt(snapshot, { mechanicsEnabled: profile.enabled });
    if (usedFallback) {
        journal('recipe.fallback', { hadRecipe: Boolean(recipe), messages: compiledCount }, { severity: 'warn' });
    }
    const schema = toCoreJsonSchema(getDirectionEnvelopeSchema());
    let raw;
    let reasoning = '';
    if (testAdapters?.requestDirection) {
        raw = await testAdapters.requestDirection({ scene, snapshot, prompt, schema });
    } else {
        const capture = await withCapturedResponse(() => getContext().generateRawData({
            api: 'openai', prompt,
            // Its own setting, not a third of the mechanical context budget.
            // Those were the same number, but they measure different things:
            // contextBudget is how much mechanical state goes INTO the prompt,
            // while this is how much room the Director has to think and answer.
            // A Scene with no Goals at all still needs the second one.
            responseLength: directorResponseTokens(profile),
            instructOverride: false, jsonSchema: schema,
        }));
        raw = capture.result;
        reasoning = readReasoning(capture.captured);
    }
    lastDirectorReasoning = reasoning;
    // Separates an exhausted token budget from genuinely malformed output. The
    // old message blamed the model's formatting for what is usually a reasoning
    // model spending its whole allowance before writing a character.
    let envelope = interpretStructuredReply(raw, 'Game Director');
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) envelope = {};
    // Protocol identity is transport metadata owned by Remodel. Providers
    // vary in how faithfully they echo const-valued schema fields; accepting
    // their prose decision must never let them rename the local protocol.
    envelope.protocol = DIRECTION_PROTOCOL;
    // The direction ID is transport identity owned by Remodel, for the same
    // reason the protocol string above is.
    //
    // Observed live: a provider returned the literal `"dir-001"` for every
    // single pass in a session. Because persistDirectionRecord keys the Scene's
    // direction log by this id, each new record REPLACED the previous one — the
    // log never held more than one card, and that card appeared to jump down
    // the stream to whatever the newest pass's createdAt was. The same
    // collision also let one run's setExtensionPrompt filter and completion
    // guards match a different run's directionId.
    //
    // Never accept it from the model, even when it looks unique.
    envelope.directionId = createId('direction');
    // Some OpenAI-compatible providers advertise JSON Schema support but
    // omit required fields. Repair only the transport skeleton here; retain
    // every valid semantic value the Director did return. A useful fallback
    // keeps the scene operable without inventing events. `movement.objective`
    // covers a reply still in flight against the previous schema when this
    // shipped.
    const returnedInstruction = String(envelope.instruction || envelope.movement?.objective || '').trim();
    envelope.instruction = returnedInstruction
        || `Respond naturally to the current action while preserving accepted scene facts: ${String(snapshot.currentAction || '').trim()}`;
    envelope.flow = {
        continueAfter: Boolean(envelope.flow?.continueAfter),
        hardPauseAfter: Boolean(envelope.flow?.hardPauseAfter),
    };
    envelope.requests = Array.isArray(envelope.requests) ? envelope.requests : [];
    // Mechanics disabled for this account: never let a Director reply carry
    // requests forward for code that will not offer Variables or Goals to
    // resolve them against.
    if (!profile.enabled) envelope.requests = [];
    return envelope;
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
 * instruction the user is waiting on.
 */
const EMPTY_RESPONSE_RETRIES = 2;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 400;

async function generateDirectedPerformer({ scene, envelope, performer, autonomousSequence, token = null, emptyRetries = 0 }) {
    const director = resolveDirector(scene);
    persistDirectionRecord(scene, envelope, performer, director);
    const movementPrompt = formatMovementPrompt(envelope);
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
    setExtensionPrompt(DIRECTION_PROMPT_KEY, movementPrompt, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM, () => activeRun?.directionId === envelope.directionId);
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
        // Only this run's own injection. Both runs of a concurrent pair shared
        // this key, so the first to finish cleared the movement the second was
        // still generating against — that performer received no direction at
        // all and answered generically. The lock should now prevent the pair
        // from forming; this keeps the damage impossible rather than unlikely.
        if (activeRun == null || activeRun.directionId === envelope.directionId) {
            setExtensionPrompt(DIRECTION_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        }
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
 * name against the book this pass actually advertised and adds a name-keyed
 * entry to a COPY of the ref maps the capability layer already reads with
 * `.get(ref)` — so mechanics-capabilities.js needs no change, it just gets
 * handed names as keys instead of synthetic refs. A name absent from the book
 * is simply left unresolved, which the capability layer already refuses as
 * "not advertised for this request"; the specific reason (unknown vs.
 * duplicated) is collected in `unresolvedReasons` for the caller to surface
 * — the generic downstream refusal alone is actively misleading for a
 * duplicated name, since it *was* advertised, twice.
 *
 * The base Maps are copied in, not replaced, so goal.reach's "was this
 * Variable retrieved this pass" check — which reads only `.values()` on
 * `variableRefs` — still sees everything this pass retrieved, not just the
 * Variables a request happened to name. Those base Maps are keyed by the
 * synthetic v1/g1-style refs the retrieval layer still assigns internally
 * (assignVariableRefs / buildMechanicalSnapshot), which is exactly why a
 * successful resolution must be allowed to overwrite an inherited key: a
 * Variable a user actually named "v1" must resolve to itself, not to
 * whatever `v1` happened to mean as a positional ref this pass. `attempted`
 * only prevents re-resolving the same name twice; it never substitutes for
 * resolution the way checking the map itself would.
 */
export function addressRequestsByName(requests, addressBook, variableRefs, goalRefs) {
    const resolvedVariableRefs = new Map(variableRefs instanceof Map ? variableRefs : []);
    const resolvedGoalRefs = new Map(goalRefs instanceof Map ? goalRefs : []);
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
        // A tracked Goal's resolution names its Variable the same way every
        // other Variable reference does — see mechanics-capabilities.js's
        // normalizeResolutionArgs, which resolves it through this same
        // lookup. Missing this is the only way to create a tracked Goal.
        addResolved(resolvedVariableRefs, 'variable', args.resolution?.variableRef);
        addResolved(resolvedGoalRefs, 'goal', args.goalRef);
        addResolved(resolvedGoalRefs, 'goal', args.fromGoalRef);
        addResolved(resolvedGoalRefs, 'goal', args.toGoalRef);
    }
    return { variableRefs: resolvedVariableRefs, goalRefs: resolvedGoalRefs, unresolvedReasons };
}

function executeDirectionRequests(requests, context) {
    const scene = context.scene;
    if (!Array.isArray(requests) || requests.length === 0) return { ok: true, receipts: [], transaction: null, unresolvedReasons: [] };
    const { variableRefs, goalRefs, unresolvedReasons } = addressRequestsByName(requests, context.addressBook, context.variableRefs, context.goalRefs);
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
    journal('finalize', {
        directionId: run.directionId,
        state,
        messageId: run.messageId,
        acceptedLength: accepted.length,
        discardedLength: Math.max(0, run.rawBufferedText.length - run.rawOffset),
        interrupted: Boolean(run.interrupted),
    }, { correlationId: run.directionId });
    message.mes = accepted;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
    message.extra ??= {};
    message.extra.remodelDirection = serializeRun(run, state);
    if (run.performer.ref.kind === 'narrator') message.extra.type = 'narrator';
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
                authorizedGoalIds: [],
            };
            notifyState();
        }
    }
}

function serializeRun(run, state) {
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId: run.directionId,
        sceneId: run.sceneId,
        state,
        acceptedText: sanitizeDirectionText(run.acceptedVisibleText),
        revealOffset: run.rawOffset,
        performerRef: run.performer.ref,
        envelope: run.envelope,
        checkpointTransactionIds: [...run.checkpointTransactionIds],
        // As plain objects: a Map stringifies to {}, so a recovered run would
        // otherwise resolve no refs at all and every surviving request would
        // be rejected as never advertised.
        variableRefs: Object.fromEntries(run.variableRefs || []),
        goalRefs: Object.fromEntries(run.goalRefs || []),
        addressBook: run.addressBook || { entries: [], duplicates: [] },
        pendingRequestsApplied: Boolean(run.pendingRequestsApplied),
        interrupted: Boolean(run.interrupted),
        autonomousSequence: run.autonomousSequence,
        updatedAt: new Date().toISOString(),
    };
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
 * WHY THIS IS AWKWARD: core throws the reasoning away on any schema-constrained
 * call. `generateRawData` ends with `return extractJsonFromData(data)` whenever
 * a jsonSchema is supplied (script.js ~4043), so the provider's response object
 * — the only place `reasoning` / `reasoning_content` / `thinking` lives — never
 * escapes the function. There is no event and no accessor for it.
 *
 * The alternatives were worse: patching core is off the table, and dropping the
 * schema to get a plain response would lose the enforcement that keeps the
 * envelope valid in the first place. So we read the response off the wire for
 * the duration of this one call instead.
 */
let lastDirectorReasoning = '';

/**
 * Run `task` with fetch temporarily wrapped so the backend's JSON response can
 * be read alongside whatever core chooses to return.
 *
 * Deliberately narrow: it only ever reads a CLONE of the body (so core still
 * consumes the original untouched), only looks at SillyTavern's own backend
 * routes, and restores the original fetch in a finally — a throw inside the
 * task can never leave a wrapped fetch behind.
 */
async function withCapturedResponse(task) {
    const original = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (...args) => {
        const response = await original(...args);
        try {
            const url = String(args[0]?.url || args[0] || '');
            if (response.ok && /\/api\/backends\//.test(url)) {
                captured = await response.clone().json();
            }
        } catch {
            // A streamed or non-JSON body is simply not a source of reasoning.
        }
        return response;
    };
    try {
        return { result: await task(), captured };
    } finally {
        globalThis.fetch = original;
    }
}

function readReasoning(data) {
    if (!data) return '';
    try {
        // ignoreShowThoughts: this card is our own surface, so it should not
        // depend on SillyTavern's native "show thoughts" display toggle.
        return String(extractReasoningFromData(data, { mainApi: 'openai', ignoreShowThoughts: true }) || '').trim();
    } catch {
        return '';
    }
}

/** Compact, storable summary of what the Director asked the system to do. */
function summarizeRequests(requests) {
    return (Array.isArray(requests) ? requests : []).filter(Boolean).map((request) => ({
        capability: String(request.capability || 'unknown'),
        reason: String(request.reason || '').trim(),
    })).slice(0, 40);
}

function persistDirectionRecord(scene, envelope, performer, director) {
    if (!scene || !envelope?.instruction) return;
    const existing = Array.isArray(scene.liveDirection?.directionLog) ? scene.liveDirection.directionLog : [];
    const record = {
        id: envelope.directionId,
        createdAt: new Date().toISOString(),
        directorRef: director?.ref || null,
        directorLabel: director?.label || 'Game Director',
        performerRef: performer.ref,
        performerLabel: performer.label,
        // Kept as `objective`, not renamed to `instruction`: this is the field
        // timeline-state.js's normalizeDirectionRecord requires (and the
        // roleplay stream's direction card already reads) to keep the record
        // instead of silently dropping it.
        objective: envelope.instruction,
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

function normalizeEnvelope(value, scene) {
    if (!value || value.protocol !== DIRECTION_PROTOCOL) throw new Error(`Direction protocol must be ${DIRECTION_PROTOCOL}.`);
    const directionId = String(value.directionId || createId('direction'));
    // `movement.objective` is read as a fallback so a response requested
    // under the previous schema — still in flight when this shipped — parses
    // instead of throwing. `mechanics.pendingRequests` likewise covers
    // re-normalizing an envelope this function already produced (regenerate),
    // since its own output moves `requests` there.
    const instruction = String(value.instruction || value.movement?.objective || '').trim();
    if (!instruction) throw new Error('Direction requires an instruction for the performer.');
    const pendingRequests = Array.isArray(value.requests) ? value.requests : Array.isArray(value.mechanics?.pendingRequests) ? value.mechanics.pendingRequests : [];
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId,
        instruction,
        flow: { continueAfter: Boolean(value.flow?.continueAfter), hardPauseAfter: Boolean(value.flow?.hardPauseAfter) },
        mechanics: { pendingRequests },
        sceneId: scene.id,
    };
}

/**
 * What the performing character is told.
 *
 * Just the direction. It used to also carry an objective/constraint form, three
 * marker formats with ids to remember, and two prohibitions — clerical load at
 * the position closest to the next word, which is what flattened the prose.
 */
export function formatMovementPrompt(envelope) {
    const instruction = String(envelope?.instruction || '').trim();
    if (!instruction) return '';
    return `[Direction for this response only]\n${instruction}`;
}

/**
 * What the Director must reply with.
 *
 * Deliberately small: an instruction the performer will read as prose, a flow
 * decision, and mechanical requests addressed by name. No performer choice —
 * whoever holds the Scene's Narrator badge speaks — and no marker vocabulary
 * for the model to remember, since deriveBeats() reads pacing out of the
 * finished prose instead.
 */
export function getDirectionEnvelopeSchema() {
    const request = structuredClone(getMechanicsRequestSchema().schema.properties.requests.items);
    return {
        name: 'remodel_direction_envelope', strict: true,
        schema: {
            type: 'object', additionalProperties: false,
            required: ['protocol', 'directionId', 'instruction', 'flow', 'requests'],
            properties: {
                protocol: { type: 'string', const: DIRECTION_PROTOCOL },
                directionId: { type: 'string' },
                instruction: {
                    type: 'string',
                    description: 'The direction, written as prose for the performer who writes the next response: what they are doing, and what matters about how. This is the only guidance they receive — never a summary of it, never a reference to a director or a protocol.',
                },
                flow: {
                    type: 'object', additionalProperties: false, required: ['continueAfter', 'hardPauseAfter'],
                    properties: {
                        continueAfter: { type: 'boolean', description: 'True if the scene should keep moving on its own after this response, without waiting on the user.' },
                        hardPauseAfter: { type: 'boolean', description: 'True if the fiction is now explicitly waiting on the user and must not continue on its own, regardless of continueAfter.' },
                    },
                },
                requests: {
                    type: 'array', items: request,
                    description: 'Mechanical changes this direction causes, each addressing a Variable or Goal by the exact name advertised this turn. Applied once this response is accepted — never narrate, roll, or invent the outcome yourself. Return an empty array when nothing changes.',
                },
            },
        },
    };
}

function clearRevealTimer() {
    clearTimeout(revealTimer);
    revealTimer = null;
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
