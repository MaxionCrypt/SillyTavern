import {
    extension_prompt_roles,
    extension_prompt_types,
    main_api,
    sendMessageAsUser,
    setExtensionPrompt,
} from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import {
    executeMechanicsRequest,
    getCapabilityDictionary,
    getMechanicsRequestSchema,
    MECHANICS_PROTOCOL,
    undoMechanicsTransaction,
} from './mechanics-capabilities.js';
import {
    buildMechanicalSnapshot,
    formatMechanicsReceipts,
    mechanicalHandbook,
} from './mechanics-runtime.js';
import { getMechanicsProfile, listMechanicsTransactions } from './story-variables-store.js';
import { readDirectionUnit, sanitizeDirectionText } from './live-direction-markers.js';
import {
    beginDirectionFlight,
    finishDirectionFlight,
    installLiveDirectionDiagnostics,
    recordDirectionFlight,
    setActiveDirectionFlight,
} from './live-direction-diagnostics.js';
import { updateScene } from './timeline-state.js';

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
    installLiveDirectionDiagnostics();
    const context = getContext();
    context.eventSource.on(context.eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        const messageId = Number(context.streamingProcessor?.messageId);
        if (Number.isInteger(messageId)) activeRun.messageId = messageId;
        recordDirectionFlight('native.stream', { messageId: activeRun.messageId, rawLength: String(text ?? '').length }, activeRun.flightId);
        acceptNativeBuffer(text);
    });
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, (messageId) => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        const id = Number(messageId);
        const message = context.chat?.[id];
        if (!message || message.is_user) return;
        activeRun.messageId = id;
        recordDirectionFlight('native.message.received', { messageId: id, messageLength: String(message.mes || '').length }, activeRun.flightId);
        acceptNativeBuffer(message.mes);
    });
    const finish = () => {
        if (!ownsLiveDirectionGeneration() || !activeRun) return;
        activeRun.generationFinished = true;
        activeRun.generationSettled = true;
        recordDirectionFlight('native.generation.settled', { messageId: activeRun.messageId }, activeRun.flightId);
        scheduleReveal(0);
    };
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, finish);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, finish);
    const recover = () => setTimeout(recoverLiveDirectionMessages, 0);
    context.eventSource.on(context.eventTypes.CHAT_LOADED, recover);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, recover);
    recoverLiveDirectionMessages();
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
    return {
        active: true,
        state: activeRun?.state || 'Ready',
        pacing: scene.liveDirection?.pacing || 'natural',
        openingLabel: activeRun?.openingLabel || '',
        canContinue: activeRun?.state === 'Waiting for you',
        canStop: Boolean(activeRun && !['Ready', 'Complete'].includes(activeRun.state)),
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
        recordDirectionFlight('submission.duplicate.blocked', { sceneId: scene.id, action });
        return false;
    }
    pendingSubmission = submissionKey;
    const flightId = beginDirectionFlight({ sceneId: scene.id, timelineId: scene.timelineId, action, insertUser: true });
    try {
    if (activeRun?.acceptedComplete) {
        await finalizeRunMessage(activeRun, { state: 'complete' });
        activeRun = null;
        notifyState();
    } else if (activeRun) {
        await interruptLiveDirection({ preserveForIntervention: true });
    }
        return await beginDirection({ scene, action, insertUser: true, authorizedGoalIds, autonomousSequence: 0, flightId });
    } finally {
        if (pendingSubmission === submissionKey) pendingSubmission = null;
    }
}

export async function requestNextDirection(scene = hooks.getActiveScene()) {
    if (!isDirectedLiveScene(scene) || activeRun && !['Waiting for you', 'Complete'].includes(activeRun.state)) return false;
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
            recordDirectionFlight('reveal.held.typing', { acceptedLength: activeRun.acceptedVisibleText.length, rawOffset: activeRun.rawOffset }, activeRun.flightId);
            clearRevealTimer();
            persistRun(activeRun, true);
            notifyState();
        }
        return;
    }
    if (activeRun.holdReason === 'typing') {
        activeRun.holdReason = '';
        activeRun.state = 'Speaking';
        recordDirectionFlight('reveal.resumed', { acceptedLength: activeRun.acceptedVisibleText.length, rawOffset: activeRun.rawOffset }, activeRun.flightId);
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
    if (!activeRun) return false;
    await interruptLiveDirection({ preserveForIntervention: false });
    return true;
}

export async function retryLiveDirection() {
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

export async function regenerateLastDirectedResponse(scene = hooks.getActiveScene()) {
    if (!isDirectedLiveScene(scene) || activeRun) return false;
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
    const movement = saved.movement;
    const performer = resolvePerformer(saved.performerRef, scene);
    if (!movement || !performer) return requestNextDirection(scene);
    const envelope = normalizeEnvelope(saved.envelope, scene, performer.ref);
    return generateDirectedPerformer({ scene, envelope, performer, autonomousSequence: Number(saved.autonomousSequence) || 0 });
}

async function beginDirection({ scene, action, insertUser, authorizedGoalIds = [], autonomousSequence = 0, flightId = '' } = {}) {
    flightId ||= beginDirectionFlight({ sceneId: scene?.id, timelineId: scene?.timelineId, action, insertUser: Boolean(insertUser), autonomousSequence });
    setActiveDirectionFlight(flightId);
    recordDirectionFlight('direction.begin', { sceneId: scene?.id, insertUser: Boolean(insertUser), autonomousSequence, chatLength: getContext().chat?.length || 0 }, flightId);
    if (!scene || main_api !== 'openai') {
        return directionFailure(new Error('Live Direction requires the current Chat Completion connection.'), { scene, action, insertUser, authorizedGoalIds, autonomousSequence, flightId }, flightId);
    }
    try {
        pendingFailure = null;
        notifyTransient('Directing');
        const ready = await hooks.ensureSceneReady(scene);
        recordDirectionFlight('scene.ready', { ready, groupId: getContext().groupId, chatId: getContext().chatId }, flightId);
        if (!ready) throw new Error('The native chat linked to this Scene could not be loaded.');
        const snapshot = await buildDirectionSnapshot(scene, action, authorizedGoalIds);
        recordDirectionFlight('director.snapshot', { cast: snapshot.cast, director: snapshot.director?.ref || null, historyCount: snapshot.acceptedHistory.length }, flightId);
        const envelope = await requestDirectionEnvelope(scene, snapshot);
        recordDirectionFlight('director.envelope', envelope, flightId);
        const performer = resolvePerformer(performerOverride || envelope.performerRef, scene);
        performerOverride = null;
        if (!performer) {
            const requested = normalizeRef(performerOverride || envelope.performerRef);
            const available = snapshot.cast.map((item) => `${item.label} (${item.ref?.id || '?'})`).join(', ') || 'none';
            throw new Error(`The Director selected ${requested?.label || requested?.id || 'an unknown performer'}, but the available performers are: ${available}.`);
        }
        const normalized = normalizeEnvelope(envelope, scene, performer.ref);
        const immediate = executeDirectionRequests(normalized.mechanics.immediateRequests, {
            scene, directionId: normalized.directionId, checkpointId: 'immediate', authorizedGoalIds,
        });
        if (!immediate.ok) throw new Error(immediate.errors?.join(' ') || 'Immediate mechanical requests were rejected.');
        normalized.immediateReceipts = immediate.receipts || [];
        if (insertUser) {
            await sendMessageAsUser(action);
            recordDirectionFlight('user.inserted', { chatLength: getContext().chat?.length || 0, messageId: (getContext().chat?.length || 1) - 1 }, flightId);
            hooks.clearComposer();
        }
        return generateDirectedPerformer({ scene, envelope: normalized, performer, autonomousSequence, flightId });
    } catch (error) {
        return directionFailure(error, { scene, action, insertUser, authorizedGoalIds, autonomousSequence, flightId }, flightId);
    }
}

async function buildDirectionSnapshot(scene, action, authorizedGoalIds) {
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
    const mechanics = buildMechanicalSnapshot(scene, action, performingCast.map((member) => member.ref || member), persona, authorizedGoalIds);
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
        recentReceipts: listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id }).slice(-6).map((tx) => ({ id: tx.id, status: tx.status, receipts: tx.receipts })),
    };
}

async function requestDirectionEnvelope(scene, snapshot) {
    const profile = getMechanicsProfile();
    const capabilityDictionary = profile.enabled ? getCapabilityDictionary() : [];
    const prompt = [
        { role: 'system', content: directionHandbook(profile.handbookAdditions) },
        ...(snapshot.director ? [{ role: 'system', content: directorDoctrine(snapshot.director) }] : []),
        { role: 'system', content: profile.enabled
            ? `MECHANICAL HANDBOOK\n${mechanicalHandbook(profile.handbookAdditions)}\n\nCAPABILITY DICTIONARY\n${JSON.stringify(capabilityDictionary)}`
            : 'MECHANICAL AUTOMATION IS DISABLED. Return no immediate requests and no checkpoint requests; Goals and Variables are read-only memory.' },
        { role: 'user', content: `DIRECTOR SNAPSHOT\n${JSON.stringify(snapshot)}\n\nReturn exactly one ${DIRECTION_PROTOCOL} envelope. Choose only an advertised performerRef and capability IDs.` },
    ];
    recordDirectionFlight('director.request.started', { promptMessages: prompt.length });
    const raw = testAdapters?.requestDirection
        ? await testAdapters.requestDirection({ scene, snapshot, prompt, schema: getDirectionEnvelopeSchema(snapshot.cast).schema })
        : await getContext().generateRaw({
            api: 'openai', prompt, responseLength: Math.max(512, Math.min(3000, Math.round(profile.contextBudget / 3))),
            instructOverride: false, jsonSchema: getDirectionEnvelopeSchema(snapshot.cast).schema,
        });
    recordDirectionFlight('director.request.completed', { raw });
    let envelope;
    try { envelope = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new Error('The Game Director returned invalid structured JSON.'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) envelope = {};
    // Protocol identity is transport metadata owned by Remodel. Providers
    // vary in how faithfully they echo const-valued schema fields; accepting
    // their prose decision must never let them rename the local protocol.
    envelope.protocol = DIRECTION_PROTOCOL;
    // Performer identity is extension-owned, not model-owned. When only one
    // native speaking card is available (the common Director + Narrator
    // setup), an empty, fictional, or malformed performerRef from the model
    // cannot create ambiguity. Pin it to the sole advertised native card
    // before beginDirection validates the envelope.
    if (snapshot.cast.length === 1 && snapshot.cast[0]?.ref?.id) {
        envelope.performerRef = structuredClone(snapshot.cast[0].ref);
    }
    // Some OpenAI-compatible providers advertise JSON Schema support but
    // omit required nested objects. Repair only the transport skeleton here;
    // retain every valid semantic value the Director did return. A useful
    // movement fallback keeps the scene operable without inventing events.
    const returnedObjective = String(
        envelope.movement?.objective
        || envelope.display?.summary
        || envelope.objective
        || envelope.summary
        || '',
    ).trim();
    const safeObjective = returnedObjective
        || `Respond naturally to the current action while preserving accepted scene facts: ${String(snapshot.currentAction || '').trim()}`;
    envelope.directionId = String(envelope.directionId || createId('direction'));
    envelope.movement = {
        objective: safeObjective,
        constraints: Array.isArray(envelope.movement?.constraints) ? envelope.movement.constraints : [],
        breathingGuidance: String(envelope.movement?.breathingGuidance || ''),
    };
    envelope.display = {
        summary: String(envelope.display?.summary || returnedObjective || safeObjective),
        beats: Array.isArray(envelope.display?.beats) ? envelope.display.beats : [],
        observations: Array.isArray(envelope.display?.observations) ? envelope.display.observations : [],
        intent: String(envelope.display?.intent || ''),
        performerReason: String(envelope.display?.performerReason || ''),
    };
    envelope.flow = {
        continueAfter: Boolean(envelope.flow?.continueAfter),
        hardPauseAfter: Boolean(envelope.flow?.hardPauseAfter),
    };
    envelope.openings = Array.isArray(envelope.openings) ? envelope.openings : [];
    envelope.mechanics = {
        immediateRequests: Array.isArray(envelope.mechanics?.immediateRequests) ? envelope.mechanics.immediateRequests : [],
        checkpoints: Array.isArray(envelope.mechanics?.checkpoints) ? envelope.mechanics.checkpoints : [],
    };
    if (!profile.enabled && envelope?.mechanics) {
        envelope.mechanics.immediateRequests = [];
        envelope.mechanics.checkpoints = [];
    }
    return envelope;
}

async function generateDirectedPerformer({ scene, envelope, performer, autonomousSequence, flightId = '' }) {
    flightId ||= beginDirectionFlight({ sceneId: scene?.id, timelineId: scene?.timelineId, directionId: envelope?.directionId, replay: true });
    const director = resolveDirector(scene);
    persistDirectionRecord(scene, envelope, performer, director);
    const movementPrompt = formatMovementPrompt(envelope, performer);
    activeRun = {
        flightId,
        directionId: envelope.directionId,
        sceneId: scene.id,
        timelineId: scene.timelineId,
        messageId: null,
        performer,
        director,
        envelope,
        movement: envelope.movement,
        rawBufferedText: '',
        acceptedVisibleText: '',
        rawOffset: 0,
        lastBreathOffset: 0,
        holdReason: '',
        state: 'Speaking',
        openingLabel: '',
        emittedCheckpointIds: new Set(),
        checkpointTransactionIds: [],
        generationFinished: false,
        generationSettled: false,
        interrupted: false,
        waitingAtEnd: false,
        pacing: scene.liveDirection?.pacing || 'natural',
        autonomousSequence: Number(autonomousSequence) || 0,
        authorizedGoalIds: envelope.authorizedGoalIds || [],
    };
    setActiveDirectionFlight(flightId);
    recordDirectionFlight('performer.selected', { performer: performer.ref, characterId: performer.characterId, directionId: envelope.directionId }, flightId);
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
    recordDirectionFlight('performer.request.started', { ownedGenerationDepth, chatLength: getContext().chat?.length || 0 }, flightId);
    try {
        const options = getContext().groupId ? { force_chid: performer.characterId } : {};
        if (testAdapters?.generatePerformer) {
            await testAdapters.generatePerformer({ scene, envelope, performer, options, context: getContext() });
        } else {
            await getContext().generate('normal', options);
        }
    } finally {
        recordDirectionFlight('performer.request.returned', { chatLength: getContext().chat?.length || 0, messageId: activeRun?.messageId }, flightId);
        ownedGenerationDepth = Math.max(0, ownedGenerationDepth - 1);
        setExtensionPrompt(DIRECTION_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
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
    // Core writes its cumulative streaming buffer immediately after emitting
    // STREAM_TOKEN_RECEIVED. Reassert the accepted fragment on the next task
    // so unrelated readers never inherit markers or unseen future prose.
    setTimeout(() => mirrorAcceptedNative(activeRun), 0);
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
    let emitted = 0;
    while (activeRun === run && !run.holdReason && emitted < budget) {
        const unit = readDirectionUnit(run.rawBufferedText, run.rawOffset, { final: run.generationFinished });
        if (unit.kind === 'end' || unit.kind === 'partial') break;
        run.rawOffset = unit.nextOffset;
        if (unit.kind === 'text') {
            run.acceptedVisibleText += unit.value;
            emitted++;
            continue;
        }
        if (unit.kind === 'unknown') continue;
        if (unit.kind === 'commit') {
            recordDirectionFlight('marker.commit', { checkpointId: unit.id, visibleOffset: run.acceptedVisibleText.length }, run.flightId);
            await executeCheckpoint(run, unit.id);
            continue;
        }
        if (unit.kind === 'hard-pause') {
            run.holdReason = 'hard';
            run.state = 'Waiting for you';
            recordDirectionFlight('marker.hard-pause', { visibleOffset: run.acceptedVisibleText.length }, run.flightId);
            persistRun(run, true);
            notifyState();
            return;
        }
        const words = run.acceptedVisibleText.slice(run.lastBreathOffset).trim().split(/\s+/).filter(Boolean).length;
        run.lastBreathOffset = run.acceptedVisibleText.length;
        run.state = unit.kind === 'opening' ? 'Opening' : 'Breathing';
        run.openingLabel = unit.kind === 'opening' ? openingLabel(run.envelope, unit.id) : '';
        recordDirectionFlight(`marker.${unit.kind}`, { id: unit.id || '', visibleOffset: run.acceptedVisibleText.length, words }, run.flightId);
        persistRun(run, true);
        notifyState();
        const adaptive = pace.cps === Infinity ? 0 : Math.max(pace.min, Math.min(pace.max, words * pace.wordMs));
        scheduleReveal(adaptive + (unit.kind === 'opening' ? pace.opening : 0));
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

async function executeCheckpoint(run, checkpointId) {
    if (run.emittedCheckpointIds.has(checkpointId)) return;
    const checkpoint = run.envelope.mechanics.checkpoints.find((item) => item.id === checkpointId);
    run.emittedCheckpointIds.add(checkpointId);
    if (!checkpoint) return;
    const scene = hooks.getActiveScene();
    if (!scene || scene.id !== run.sceneId) return;
    const result = executeDirectionRequests(checkpoint.requests, {
        scene, directionId: run.directionId, messageId: run.messageId, checkpointId,
        authorizedGoalIds: run.authorizedGoalIds,
    });
    if (result.transaction?.id) run.checkpointTransactionIds.push(result.transaction.id);
    if (!result.ok) run.checkpointDiagnostics = [...(run.checkpointDiagnostics || []), ...(result.errors || ['Checkpoint failed.'])];
    persistRun(run, true);
}

function executeDirectionRequests(requests, context) {
    const scene = context.scene;
    if (!Array.isArray(requests) || requests.length === 0) return { ok: true, receipts: [], transaction: null };
    return executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: Array.isArray(requests) ? requests : [] }, {
        timelineId: scene.timelineId,
        sceneId: scene.id,
        turnId: context.directionId,
        directionId: context.directionId,
        messageId: context.messageId,
        checkpointId: context.checkpointId,
        authorizedGoalIds: context.authorizedGoalIds || [],
        authorizedOwnerRefs: hooks.getPersona ? [hooks.getPersona()].filter(Boolean) : [],
        allowUserGoalCreate: false,
        allowVariableProposal: false,
    });
}

async function completeVisibleRun(run) {
    if (activeRun !== run) return;
    await finalizeRunMessage(run, { state: 'complete' });
    recordDirectionFlight('reveal.complete', { messageId: run.messageId, acceptedLength: run.acceptedVisibleText.length }, run.flightId);
    run.acceptedComplete = true;
    run.autonomousSequence += 1;
    const scene = hooks.getActiveScene();
    const draft = String(hooks.getComposerDraft() || '').trim();
    const limit = scene?.liveDirection?.autonomousResponseLimit || 3;
    const hard = run.envelope.flow.hardPauseAfter || !run.envelope.flow.continueAfter || run.autonomousSequence >= limit;
    if (hard || draft) {
        run.waitingAtEnd = true;
        run.holdReason = 'hard';
        run.state = draft ? 'Held while you write' : 'Waiting for you';
        notifyState();
        hooks.onSettled();
        finishDirectionFlight('waiting', { messageId: run.messageId, hard, draft: Boolean(draft) }, run.flightId);
        return;
    }
    if (scene?.liveDirection?.autoplay !== false) {
        const sequence = run.autonomousSequence;
        activeRun = null;
        notifyState();
        hooks.onSettled();
        setTimeout(() => {
            if (String(hooks.getComposerDraft() || '').trim()) {
                activeRun = run;
                run.waitingAtEnd = true;
                run.holdReason = 'hard';
                run.state = 'Held while you write';
                notifyState();
                hooks.onSettled();
                return;
            }
            beginDirection({ scene, action: '[Autonomous continuation from accepted history.]', insertUser: false, autonomousSequence: sequence });
        }, 250);
        return;
    }
    activeRun = null;
    notifyState();
    hooks.onSettled();
}

async function interruptLiveDirection({ preserveForIntervention }) {
    const run = activeRun;
    if (!run) return;
    clearRevealTimer();
    run.interrupted = true;
    run.holdReason = 'interrupt';
    recordDirectionFlight('reveal.interrupt', { preserveForIntervention, acceptedLength: run.acceptedVisibleText.length, rawLength: run.rawBufferedText.length }, run.flightId);
    if (!run.generationSettled && ownsLiveDirectionGeneration()) {
        getContext().stopGeneration?.();
        await waitFor(() => run.generationSettled, 2200);
    }
    // A completed API call can still have an unseen suffix buffered. It no
    // longer owns a native generation, but it is equally discardable.
    await finalizeRunMessage(run, { state: preserveForIntervention ? 'interrupted' : 'stopped' });
    finishDirectionFlight(preserveForIntervention ? 'interrupted' : 'stopped', { messageId: run.messageId, acceptedLength: run.acceptedVisibleText.length }, run.flightId);
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
    if (!message || message.is_user) return;
    const accepted = sanitizeDirectionText(run.acceptedVisibleText);
    if (!accepted && run.interrupted) {
        await context.deleteMessage(run.messageId);
        run.messageId = null;
        return;
    }
    message.mes = accepted;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
    message.extra ??= {};
    message.extra.remodelDirection = serializeRun(run, state);
    if (run.performer.ref.kind === 'narrator') message.extra.type = 'narrator';
    await context.saveChat();
    recordDirectionFlight('chat.finalized', { state, messageId: run.messageId, acceptedLength: accepted.length, chatLength: context.chat.length }, run.flightId);
}

function persistRun(run, immediate) {
    clearTimeout(persistTimer);
    const commit = async () => {
        const message = getContext().chat?.[run.messageId];
        if (!message || message.is_user) return;
        mirrorAcceptedNative(run);
        message.extra ??= {};
        message.extra.remodelDirection = serializeRun(run, run.state.toLowerCase().replaceAll(' ', '-'));
        await getContext().saveChat();
    };
    if (immediate) commit();
    else persistTimer = setTimeout(commit, 350);
}

function mirrorAcceptedNative(run) {
    if (!run || !Number.isInteger(run.messageId)) return;
    const message = getContext().chat?.[run.messageId];
    if (!message || message.is_user) return;
    const accepted = sanitizeDirectionText(run.acceptedVisibleText);
    message.mes = accepted;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipes[message.swipe_id] != null) {
        message.swipes[message.swipe_id] = accepted;
    }
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
        const accepted = sanitizeDirectionText(metadata.acceptedText ?? message.mes ?? '');
        message.mes = accepted;
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = accepted;
        metadata.acceptedText = accepted;
        metadata.state = 'recovered-hard-pause';
        metadata.recovered = true;
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
                envelope: recovered.metadata.envelope || { flow: { continueAfter: false, hardPauseAfter: true }, openings: [], mechanics: { immediateRequests: [], checkpoints: [] } },
                movement: recovered.metadata.movement || null,
                rawBufferedText: recovered.metadata.acceptedText || '',
                acceptedVisibleText: recovered.metadata.acceptedText || '',
                rawOffset: String(recovered.metadata.acceptedText || '').length,
                lastBreathOffset: String(recovered.metadata.acceptedText || '').length,
                holdReason: 'hard', state: 'Waiting for you', openingLabel: '',
                emittedCheckpointIds: new Set(recovered.metadata.emittedCheckpointIds || []),
                checkpointTransactionIds: [...(recovered.metadata.checkpointTransactionIds || [])],
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
        flightId: run.flightId,
        directionId: run.directionId,
        sceneId: run.sceneId,
        state,
        acceptedText: sanitizeDirectionText(run.acceptedVisibleText),
        revealOffset: run.rawOffset,
        performerRef: run.performer.ref,
        movement: run.movement,
        envelope: run.envelope,
        emittedCheckpointIds: [...run.emittedCheckpointIds],
        checkpointTransactionIds: [...run.checkpointTransactionIds],
        interrupted: Boolean(run.interrupted),
        autonomousSequence: run.autonomousSequence,
        updatedAt: new Date().toISOString(),
    };
}

function publicRun(run) {
    return { ...run, emittedCheckpointIds: [...run.emittedCheckpointIds], envelope: undefined };
}

function notifyTransient(state) {
    hooks.onStateChange({ state, acceptedVisibleText: activeRun?.acceptedVisibleText || '' });
}

function notifyState() {
    hooks.onStateChange(activeRun ? publicRun(activeRun) : null);
}

function directionFailure(error, retry, flightId = retry?.flightId || '') {
    console.error('Remodel Live Direction failed', error);
    pendingFailure = retry;
    activeRun = null;
    notifyState();
    hooks.onFailure(error);
    finishDirectionFlight('failed', { error }, flightId);
    return false;
}

function resolvePerformer(ref, scene) {
    const director = normalizeRef(scene.liveDirection?.directorRef);
    const cast = (hooks.getCast() || []).filter((item) => {
        const candidate = item.ref || normalizeRef(item);
        return !item.disabled && (!director || candidate?.id !== director.id);
    });
    const normalized = normalizeRef(ref);
    // Do not reject an empty model-selected ref before considering the only
    // native performer the Scene actually makes available.
    if (!normalized && cast.length !== 1) return null;
    const member = cast.find((item) => {
        const candidate = item.ref || normalizeRef(item);
        return candidate?.id === normalized?.id;
    });
    if (!member) {
        // Some providers accept the structured schema but still return a
        // fictional actor (for example, an NPC named in the movement) instead
        // of the native character card that must render the prose. A Scene's
        // explicitly bound Narrator is the safe rendering fallback: it does
        // not change the Director's movement, only which available card voices
        // that movement. Scenes without a valid Narrator continue to fail
        // loudly rather than selecting an arbitrary cast member.
        const narrator = normalizeRef(scene.liveDirection?.narratorRef);
        const narratorMember = narrator && cast.find((item) => {
            const candidate = item.ref || normalizeRef(item);
            return candidate?.id === narrator.id;
        });
        // A directed Scene with exactly one available speaking card is
        // unambiguous. Some Chat Completion providers still return a display
        // label or fictional NPC despite the enum-constrained schema; code,
        // not that label, owns performer identity. Use the sole native card.
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

function persistDirectionRecord(scene, envelope, performer, director) {
    if (!scene || !envelope?.movement?.objective) return;
    const existing = Array.isArray(scene.liveDirection?.directionLog) ? scene.liveDirection.directionLog : [];
    const record = {
        id: envelope.directionId,
        createdAt: new Date().toISOString(),
        directorRef: director?.ref || null,
        directorLabel: director?.label || 'Game Director',
        performerRef: performer.ref,
        performerLabel: performer.label,
        objective: envelope.display?.summary || envelope.movement.objective,
        decisionTrace: {
            observations: (Array.isArray(envelope.display?.observations) ? envelope.display.observations : []).map(String).filter(Boolean).slice(0, 8),
            intent: String(envelope.display?.intent || envelope.display?.summary || '').trim(),
            performerReason: String(envelope.display?.performerReason || '').trim(),
        },
        constraints: envelope.display?.beats || [],
        openings: envelope.openings,
        immediateCount: envelope.mechanics.immediateRequests.length,
        checkpointCount: envelope.mechanics.checkpoints.length,
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

function normalizeEnvelope(value, scene, performerRef) {
    if (!value || value.protocol !== DIRECTION_PROTOCOL) throw new Error(`Direction protocol must be ${DIRECTION_PROTOCOL}.`);
    const directionId = String(value.directionId || createId('direction'));
    const movement = {
        objective: String(value.movement?.objective || '').trim(),
        constraints: (Array.isArray(value.movement?.constraints) ? value.movement.constraints : []).map(String).filter(Boolean).slice(0, 20),
        breathingGuidance: String(value.movement?.breathingGuidance || '').trim(),
    };
    if (!movement.objective) throw new Error('Direction requires a narrative objective.');
    const checkpoints = (Array.isArray(value.mechanics?.checkpoints) ? value.mechanics.checkpoints : []).map((checkpoint) => ({
        id: String(checkpoint?.id || ''), requests: Array.isArray(checkpoint?.requests) ? checkpoint.requests : [],
    })).filter((checkpoint) => checkpoint.id);
    const ids = new Set();
    for (const checkpoint of checkpoints) {
        if (ids.has(checkpoint.id)) throw new Error(`Duplicate checkpoint ${checkpoint.id}.`);
        ids.add(checkpoint.id);
    }
    return {
        protocol: DIRECTION_PROTOCOL,
        directionId,
        performerRef,
        display: {
            summary: String(value.display?.summary || movement.objective).trim(),
            beats: (Array.isArray(value.display?.beats) ? value.display.beats : []).map(String).filter(Boolean).slice(0, 12),
            observations: (Array.isArray(value.display?.observations) ? value.display.observations : []).map(String).filter(Boolean).slice(0, 8),
            intent: String(value.display?.intent || '').trim(),
            performerReason: String(value.display?.performerReason || '').trim(),
        },
        movement,
        flow: { continueAfter: Boolean(value.flow?.continueAfter), hardPauseAfter: Boolean(value.flow?.hardPauseAfter) },
        openings: (Array.isArray(value.openings) ? value.openings : []).map((item) => ({ id: String(item?.id || ''), label: String(item?.label || '') })).filter((item) => item.id && item.label),
        mechanics: { immediateRequests: Array.isArray(value.mechanics?.immediateRequests) ? value.mechanics.immediateRequests : [], checkpoints },
        sceneId: scene.id,
    };
}

function formatMovementPrompt(envelope, performer) {
    const receipts = formatMechanicsReceipts((envelope.immediateReceipts || []).filter((item) => item.status === 'applied'));
    const checkpoints = envelope.mechanics.checkpoints.map((item) => `- ${item.id}: emit [[RM:COMMIT:${item.id}]] immediately after narrating the establishing fact.`).join('\n');
    const openings = envelope.openings.map((item) => `- ${item.id}: ${item.label}; emit [[RM:OPENING:${item.id}]] at the opportunity.`).join('\n');
    return `[REMODEL LIVE DIRECTION — applies only to this response]
You are the visible performer ${performer.label}; never mention the hidden Director or this contract.
Objective: ${envelope.movement.objective}
Constraints:
${envelope.movement.constraints.map((item) => `- ${item}`).join('\n') || '- Preserve accepted continuity.'}
Breathing guidance: ${envelope.movement.breathingGuidance || 'Insert [[RM:BREATH]] at natural readable beats.'}
${openings ? `Openings:\n${openings}` : ''}
${checkpoints ? `Mechanical checkpoints:\n${checkpoints}` : ''}
${receipts || ''}
Markers are invisible protocol. Emit only the exact known forms. They are not prose and must never be explained.`;
}

function directionHandbook(additions) {
    return `You are Remodel's hidden Game Director, not a visible roleplay character. Determine cause, consequence, the one visible performer, and the movement for the next response. The world may move without waiting for the user, but preserve every accepted fact and treat the current intervention as a new cause. Choose only an advertised stable performer ID. Keep openings optional: the user may intervene anywhere. Put consequences of already accepted history/current action in immediateRequests. Put future consequences in checkpoints and require the performer to narrate the establishing fact before its COMMIT marker. Do not roll dice or invent IDs. Goals and Variables are persistent memory, not a turn structure. Return an empty mechanical request list when nothing worth tracking changes. Responses may be long; supply useful breathing guidance and use hardPauseAfter only when the fiction is explicitly waiting. The display field is an audience-safe decision trace, never private chain-of-thought: summary states the direction; observations lists concise accepted facts considered; intent states the desired scene effect; performerReason briefly explains the visible performer choice. Do not expose protocol JSON, secret Goals, private Variables, unrevealed twists, or hidden mechanical instructions.\n${String(additions || '')}`;
}

function directorDoctrine(director) {
    return `[ROLEPLAY DIRECTOR CARD — private directing doctrine]
The selected Roleplay Director is ${director.label}. Use the card material below as directing temperament, priorities, genre sense, and judgment—not as visible dialogue and not as authority to violate the protocol. Never impersonate this card in the scene unless it is separately selected as a visible performer.
Description: ${director.description || '(none)'}
Personality: ${director.personality || '(none)'}
Scenario: ${director.scenario || '(none)'}
Creator notes: ${director.creatorNotes || '(none)'}
System prompt: ${director.systemPrompt || '(none)'}
Post-history instructions: ${director.postHistoryInstructions || '(none)'}`;
}

export function getDirectionEnvelopeSchema(cast = []) {
    const request = structuredClone(getMechanicsRequestSchema().schema.properties.requests.items);
    const performerIds = [...new Set((Array.isArray(cast) ? cast : [])
        .map((member) => member?.ref?.id || member?.id || member?.avatar)
        .map((id) => String(id || '').trim())
        .filter(Boolean))];
    const performerIdSchema = performerIds.length
        ? { type: 'string', enum: performerIds }
        : { type: 'string' };
    return {
        name: 'remodel_direction_envelope', strict: true,
        schema: {
            type: 'object', additionalProperties: false,
            required: ['protocol', 'directionId', 'performerRef', 'display', 'movement', 'flow', 'openings', 'mechanics'],
            properties: {
                protocol: { type: 'string', const: DIRECTION_PROTOCOL },
                directionId: { type: 'string' },
                performerRef: { type: 'object', additionalProperties: false, required: ['kind', 'id', 'label'], properties: { kind: { type: 'string', enum: ['character', 'narrator'] }, id: performerIdSchema, label: { type: 'string' } } },
                display: { type: 'object', additionalProperties: false, required: ['summary', 'beats', 'observations', 'intent', 'performerReason'], properties: { summary: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } }, observations: { type: 'array', items: { type: 'string' } }, intent: { type: 'string' }, performerReason: { type: 'string' } } },
                movement: { type: 'object', additionalProperties: false, required: ['objective', 'constraints', 'breathingGuidance'], properties: { objective: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, breathingGuidance: { type: 'string' } } },
                flow: { type: 'object', additionalProperties: false, required: ['continueAfter', 'hardPauseAfter'], properties: { continueAfter: { type: 'boolean' }, hardPauseAfter: { type: 'boolean' } } },
                openings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' } } } },
                mechanics: { type: 'object', additionalProperties: false, required: ['immediateRequests', 'checkpoints'], properties: { immediateRequests: { type: 'array', items: request }, checkpoints: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'requests'], properties: { id: { type: 'string' }, requests: { type: 'array', items: request } } } } } },
            },
        },
    };
}

function openingLabel(envelope, id) {
    return envelope.openings.find((item) => item.id === id)?.label || 'Opportunity';
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
