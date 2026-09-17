import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, MECHANICS_PROTOCOL } from './mechanics-capabilities.js';
import {
    buildNarratorArchivistSections,
    renderLoomAction, renderLoomScene, renderLoomCharacters, renderLoomEvents,
    renderLoomSecrets, renderLoomGoals, renderLoomVariables, renderPrevEvents,
} from './narrator-prompt.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe, getPromptStudioRecipe, getStoryArchivePromptStudioRecipe, recordSentPromptTranscript } from './prompt-studio.js';
import { buildLoomRecipeSources, parseLoomReply } from './loom-reconciliation.js';
import { reasoningDisabledPayload } from './narrator-reasoning-policy.js';
import { resolveGenerationRoute } from './generation-route.js';
import { streamChatPrompt } from './story-stream.js';
import { createArchiveIngestion } from './archive-ingestion.js';
import { legacyArchiveIngestionAdapter } from './legacy-archive-ingestion-adapter.js';
import { createArchiveJobRepository } from './archive-job-store.js';
import { createArchiveWorker } from './archive-worker.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';
import { createArchiveSettlementEvent, publishArchiveSettlement } from './archive-consequences.js';
import { ensureTimelineLifecycleProjectionRegistered } from './timeline-lifecycle-projection.js';

let productionRuntime = null;
const listeners = new Set();

export function createBackgroundArchiveRuntime({
    repository = createArchiveJobRepository(),
    transport,
    ingestion = backgroundArchiveIngestion,
    commit,
    schedule = (task, delay = 0) => setTimeout(task, delay),
    now = () => Date.now(),
    maxAttempts = 3,
    retryDelayMs = 1_000,
    timeoutMs = 30_000,
    onStateChange = () => {},
} = {}) {
    const scheduled = new Set();
    const waits = new Map();
    // The job store keeps only what the Archive needs and drops the rest, so
    // the Living Lore packet a job was shown, and what its reply said about
    // lore, live here beside the runtime rather than on the job. In memory
    // only: a reload between reply and filing loses the lore for that job,
    // which is the same best-effort the live Loom already accepts.
    const packets = new Map();
    const replies = new Map();
    const worker = createArchiveWorker({
        repository,
        transport,
        ingestion,
        commit,
        observeReply: ({ jobId, raw }) => {
            const id = String(jobId || '');
            const livingLorePacket = packets.get(id) || null;
            const parsed = parseLoomReply(raw, { livingLorePacket });
            replies.set(id, Object.freeze({
                livingLorePacket,
                loreProposals: parsed.loreProposals,
                loreProposalRejections: parsed.loreProposalRejections,
                loreKeywords: parsed.loreKeywords || [],
                lorePromotionDecisions: parsed.lorePromotionDecisions || [],
                lorePromotionDecisionRejections: parsed.lorePromotionDecisionRejections || [],
            }));
        },
        now,
        maxAttempts,
        retryDelayMs,
        timeoutMs,
    });

    function forget(jobId) {
        const id = String(jobId || '');
        packets.delete(id);
        replies.delete(id);
    }

    /**
     * What the reply said about lore, once. Null until the job has replied —
     * and a miss forgets nothing, because asking early must not throw away the
     * packet the job is about to be parsed against.
     */
    function takeReply(jobId) {
        const id = String(jobId || '');
        const reply = replies.get(id) || null;
        if (reply) forget(id);
        return reply;
    }

    function notify(timelineId, settledJob = null) {
        // The usual state is intentionally compact (and becomes `idle` as
        // soon as a successful job leaves the queue).  A terminal job is
        // supplied separately so consumers that own a post-Archive side effect
        // — Living Lore, for example — can still identify the exact reply that
        // just settled without pretending an idle worker is still running.
        try { onStateChange(status(timelineId), settledJob); } catch { /* UI listeners cannot break Archive work */ }
    }

    function scheduleTimeline(timelineId, delay = 0) {
        const id = String(timelineId || '');
        if (!id || scheduled.has(id)) return;
        scheduled.add(id);
        schedule(async () => {
            let result = null;
            try {
                notify(id);
                result = await worker.runNext(id);
            } finally {
                scheduled.delete(id);
                if (result) journalArchiveOutcome(result);
                notify(id, result);
                resolveWaiters(id);
            }
            if (!result) return;
            const nextAt = Number(result.nextAttemptAt || 0);
            if (result.status === 'retrying' && nextAt > now()) {
                scheduleTimeline(id, nextAt - now());
            } else if (repository.next(id)) {
                scheduleTimeline(id);
            }
        }, Math.max(0, delay));
    }

    function enqueue(input) {
        const job = worker.enqueue(input);
        if (input?.livingLorePacket && typeof input.livingLorePacket === 'object') {
            packets.set(job.jobId, structuredClone(input.livingLorePacket));
        }
        notify(job.timelineId);
        scheduleTimeline(job.timelineId);
        return job;
    }

    function retry(jobId) {
        const job = worker.retry(jobId);
        if (job?.status === 'pending') scheduleTimeline(job.timelineId);
        if (job) notify(job.timelineId);
        return job;
    }

    function recover() {
        const recovered = worker.recover();
        for (const timelineId of repository.timelineIds()) {
            if (repository.next(timelineId)) scheduleTimeline(timelineId);
        }
        return recovered;
    }

    function status(timelineId) {
        return worker.status(String(timelineId || ''));
    }

    function waitForTimeline(timelineId) {
        const id = String(timelineId || '');
        if (!repository.next(id) && !['pending', 'running', 'retrying'].includes(status(id).status)) return Promise.resolve(status(id));
        return new Promise((resolve) => {
            const bucket = waits.get(id) || [];
            bucket.push(resolve);
            waits.set(id, bucket);
        });
    }

    function resolveWaiters(timelineId) {
        const current = status(timelineId);
        if (['pending', 'running', 'retrying'].includes(current.status)) return;
        for (const resolve of waits.get(timelineId) || []) resolve(current);
        waits.delete(timelineId);
    }

    return Object.freeze({
        enqueue, retry, recover, status, waitForTimeline, takeReply,
        // A job that will never be taken must not keep its packet alive.
        supersede: (jobId, replacementJobId) => { forget(jobId); return worker.supersede(jobId, replacementJobId); },
        cancel: (jobId, reason) => { forget(jobId); return worker.cancel(jobId, reason); },
        get: worker.get,
        list: worker.list,
    });
}

export function prepareBackgroundArchiveJob({
    scene,
    mode,
    acceptedProse,
    provenance,
    currentPlayerAction = '',
    archiveContext = '',
    recipe = null,
    // The Selected Living Lore this pass may report against, already
    // formatted, and the packet it came from. Both Story and Roleplay Archive
    // passes receive these: canonical Roleplay has no foreground Loom round
    // trip, so this background reply is its only Living Lore reporting path.
    livingLore = '',
    livingLorePacket = null,
    // What earlier Scenes already settled that bears on this passage, already
    // formatted. Without it the Loom starts every Story pass with amnesia
    // about every other Scene and records known things as new.
    recall = '',
    profiles = getContext().extensionSettings?.connectionManager?.profiles || [],
} = {}) {
    const resolvedRecipe = recipe || resolveSceneLoomRecipe(scene, mode);
    const routeSnapshot = resolveGenerationRoute({ scene, role: 'loom', profiles });
    const context = String(archiveContext || buildNarratorArchivistSections(scene.timelineId, scene.id));
    const promptSnapshot = compileArchivePrompt({ acceptedProse, currentPlayerAction, archiveContext: context, recipe: resolvedRecipe, livingLore, recall, timelineId: scene.timelineId, sceneId: scene.id });
    return {
        mode,
        timelineId: scene.timelineId,
        sceneId: scene.id,
        acceptedProse,
        provenance,
        currentPlayerAction,
        archiveContext: context,
        routeSnapshot,
        promptSnapshot,
        livingLorePacket: livingLorePacket && typeof livingLorePacket === 'object' ? livingLorePacket : null,
    };
}

export function compileArchivePrompt({ acceptedProse, currentPlayerAction = '', archiveContext = '', recipe, lifecycleProjection = {}, lifecycleContext = '', livingLore = '', recall = '', timelineId = '', sceneId = '' } = {}) {
    const sources = buildLoomRecipeSources({
        draft: acceptedProse,
        playerAction: currentPlayerAction,
        narrativeState: archiveContext,
        livingLore,
    });
    sources.narratorDraft = `Accepted canonical prose (evidence only; never reproduce it):\n${String(acceptedProse || '').trim()}`;
    sources.storyArchiveCapture = sources.narratorDraft;
    // Split state macros, rooted in the live Scene the same way the live Loom
    // path roots them — the worker compiles at capture time, so the stores are
    // current. The Archive is trusted, so its Goals board includes secrets.
    const tl = String(timelineId || '');
    const sc = String(sceneId || '');
    sources.loomAction = renderLoomAction(currentPlayerAction);
    sources.loomScene = renderLoomScene(tl, sc);
    sources.loomCharacters = renderLoomCharacters(tl, sc);
    sources.loomEvents = (args = {}) => renderLoomEvents(tl, sc, { events: args.events });
    sources.loomGoals = (args = {}) => renderLoomGoals(tl, { limit: args.limit, secret: args.secret });
    sources.loomVariables = (args = {}) => renderLoomVariables(tl, { limit: args.limit });
    sources.loomSecrets = renderLoomSecrets(tl, sc);
    // prev.events reads the earlier Scenes' events directly, completely.
    sources.prevEvents = (args = {}) => renderPrevEvents(tl, sc, { scenes: args.scenes });
    const messages = [...compilePromptRecipe(recipe, sources).messages];
    // A Loom recipe owns every model-facing instruction, including its policy
    // and output contract. The worker still validates the returned state fence;
    // it must not silently add a second policy or contract behind the owner's
    // recipe, because that makes Prompt Studio previews dishonest.
    return {
        recipeId: String(recipe?.id || ''),
        recipeName: String(recipe?.name || 'Loom Archive'),
        revision: Number(recipe?.revision || recipe?.updatedAt || 0) || 0,
        messages,
    };
}

/**
 * Say in the journal what happened to an Archive job.
 *
 * Until this existed the only Archive event was `job.queued`. A job that
 * retried three times and gave up left no trace at all, so "Archive needs
 * attention" was a dead end: the Debug Console showed the job going out and
 * nothing coming back, and the only way to find the cause was to export the
 * journal and hand-correlate `api.response.loom` records by timestamp.
 *
 * Every terminal and retrying outcome is recorded, with the failure code and
 * the reply shape that produced it, so the three failures that look identical
 * from the UI read differently here.
 */
const ARCHIVE_OUTCOME_SEVERITY = Object.freeze({
    succeeded: 'info',
    retrying: 'warn',
    'failed-repairable': 'error',
    rejected: 'error',
    cancelled: 'info',
    superseded: 'info',
});

function journalArchiveOutcome(job) {
    const status = String(job?.status || '');
    const severity = ARCHIVE_OUTCOME_SEVERITY[status];
    // Pending/running are not outcomes; a job mid-flight has nothing to report.
    if (!severity) return;
    const attempts = Number(job?.attempts || 0);
    const error = job?.error || null;
    const operations = Number(job?.result?.operations?.length || 0);
    recordDebugEvent('archive-worker', `job.${status}`, {
        jobId: job.jobId,
        timelineId: job.timelineId,
        sceneId: job.sceneId,
        mode: job.mode,
        attempts,
        status,
        profileId: job?.routeSnapshot?.profileId || '',
        recipeName: job?.promptSnapshot?.recipeName || '',
        operations,
        transactionId: job?.result?.commitReceipt?.transactionId || null,
        ingestionReceipt: job?.result?.ingestionReceipt || null,
        error,
    }, {
        correlationId: job.jobId,
        severity,
        summary: describeArchiveOutcome(status, attempts, operations, error),
    });
}

function describeArchiveOutcome(status, attempts, operations, error) {
    const cause = error?.code ? `${error.code}${describeReplyShape(error.detail)}` : 'unknown cause';
    if (status === 'succeeded') return `Archive saved ${operations} operation${operations === 1 ? '' : 's'}`;
    if (status === 'retrying') return `Archive attempt ${attempts} failed (${cause}); retrying`;
    if (status === 'failed-repairable') return `Archive needs attention after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${cause}`;
    if (status === 'rejected') return `Archive rejected permanently: ${cause}`;
    return `Archive ${status}`;
}

/** The half a reader actually needs: what the model gave back. */
function describeReplyShape(detail) {
    if (!detail || typeof detail !== 'object') return '';
    const parts = [];
    if (detail.textChars !== undefined) parts.push(`text ${detail.textChars} chars`);
    if (detail.reasoningChars) parts.push(`reasoning ${detail.reasoningChars} chars`);
    if (detail.hasFence !== undefined) parts.push(detail.hasFence ? 'fence present but unparseable' : 'no fence');
    return parts.length ? ` — ${parts.join(', ')}` : '';
}

/**
 * What to add to an Archive retry so it is materially different from the
 * attempt that failed.
 *
 * Only a reasoning-only reply earns an override, and only the provider fields
 * that turn reasoning off. Every other failure — a malformed fence, a refusal,
 * a timeout — is retried unchanged, because for those the identical request is
 * the right request and quietly disabling reasoning would change the answer
 * for a reason that had nothing to do with reasoning.
 *
 * Derived from the Connection Profile, never from the saved profile's stored
 * settings: this is request-scoped and leaves the owner's reasoning controls
 * exactly where they set them.
 */
export function archiveRetryOverride({ previousError, profileId } = {}) {
    if (String(previousError?.code || '') !== 'reasoning-only') return {};
    return reasoningDisabledPayload(profileId);
}

export function enqueueBackgroundArchive(input) {
    const runtime = getProductionRuntime();
    const job = runtime.enqueue(input);
    recordSentPromptTranscript('loom', {
        recipeName: `${job.promptSnapshot.recipeName || 'Loom'} · Background Archive`,
        messages: job.promptSnapshot.messages,
        request: { prompt: job.promptSnapshot.messages, transport: 'chat', purpose: 'background-archive' },
        transport: 'chat',
    }, { correlationId: job.jobId });
    recordDebugEvent('archive-worker', 'job.queued', {
        jobId: job.jobId, timelineId: job.timelineId, sceneId: job.sceneId, mode: job.mode,
        profileId: job.routeSnapshot.profileId, sourceId: job.provenance.sourceId,
    }, { correlationId: job.jobId, summary: 'Accepted prose queued for the Loom Archive' });
    return job;
}

export function describeBackgroundArchive(timelineId) {
    const runtime = getProductionRuntime();
    const state = runtime.status(timelineId);
    if (state.status !== 'idle') return state;
    const latest = [...runtime.list(String(timelineId || ''))].reverse().find((job) => job.status === 'succeeded');
    return latest ? { status: 'saved', label: 'Archive saved', jobId: latest.jobId } : state;
}

export function retryBackgroundArchive(jobId) {
    return getProductionRuntime().retry(jobId);
}

export function getBackgroundArchiveJob(jobId) {
    return getProductionRuntime().get(jobId);
}

/**
 * What a job's reply said about Living Lore, taken once. The Archive port is
 * archive-only and stays that way; this is the sibling channel a caller that
 * files lore reads after the job has succeeded.
 */
export function takeBackgroundArchiveReply(jobId) {
    return getProductionRuntime().takeReply(jobId);
}

export function supersedeBackgroundArchive(jobId, replacementJobId = '') {
    return getProductionRuntime().supersede(jobId, replacementJobId);
}

export function waitForBackgroundArchive(timelineId) {
    return getProductionRuntime().waitForTimeline(timelineId);
}

export function recoverBackgroundArchive() {
    return getProductionRuntime().recover();
}

export function subscribeBackgroundArchive(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test seam for the one process-wide adapter. Production never calls this. */
export function setBackgroundArchiveRuntimeForTests(runtime = null) {
    productionRuntime = runtime;
}

function getProductionRuntime() {
    if (productionRuntime) return productionRuntime;
    ensureTimelineLifecycleProjectionRegistered();
    productionRuntime = createBackgroundArchiveRuntime({
        transport: async ({ job, promptSnapshot, routeSnapshot, previousError, signal }) => {
            // A reply that was all reasoning and no text must not be retried
            // identically: the next request otherwise carries the same
            // reasoning mode and can spend its whole output budget the same
            // way, so three attempts fail for one reason and the Archive
            // stalls on "needs attention" with nothing to distinguish it from
            // a model that simply does not answer.
            //
            // The Narrator has had this recovery at the
            // CHAT_COMPLETION_SETTINGS_READY seam. The Loom never saw it: it
            // sends its own request through streamChatPrompt and that event
            // never fires for it. Same policy, applied where this path can
            // reach it — profile-derived, and it never touches the saved
            // profile or the owner's reasoning controls.
            const overridePayload = archiveRetryOverride({ previousError, profileId: routeSnapshot.profileId });
            if (Object.keys(overridePayload).length) {
                recordDebugEvent('archive-worker', 'retry.reasoning-disabled', {
                    jobId: job.jobId,
                    timelineId: job.timelineId,
                    sceneId: job.sceneId,
                    mode: job.mode,
                    attempt: Number(job.attempts || 0),
                    profileId: routeSnapshot.profileId,
                    providerFieldsApplied: Object.keys(overridePayload).length > 0,
                }, {
                    correlationId: job.jobId,
                    severity: 'warn',
                    summary: 'Archive retry: reasoning disabled after a reasoning-only reply',
                });
            }
            const response = await streamChatPrompt({ prompt: promptSnapshot.messages, profileId: routeSnapshot.profileId, signal, overridePayload });
            const responseText = typeof response === 'string' ? response : String(response?.text || '');
            const responseReasoning = typeof response === 'object' ? String(response?.reasoning || '') : '';
            const responseStreamed = typeof response === 'object' ? Boolean(response?.streamed) : false;
            recordApiTranscript('response', {
                mode: 'loom', purpose: 'background-archive', text: responseText,
                reasoning: responseReasoning,
                streamed: responseStreamed,
            }, { type: 'api.response.loom', correlationId: job.jobId, summary: 'Background Loom Archive response received' });
            // Keep a compact worker receipt beside the full transcript. It
            // makes a completed Archive legible even when the console is
            // filtered away from response rows, and ties its shape to the
            // queued job without duplicating its potentially private text.
            recordDebugEvent('archive-worker', 'response.received', {
                jobId: job.jobId,
                timelineId: job.timelineId,
                sceneId: job.sceneId,
                mode: job.mode,
                textChars: responseText.length,
                reasoningChars: responseReasoning.length,
                streamed: responseStreamed,
            }, {
                correlationId: job.jobId,
                summary: `Background Loom response received (${responseText.length} chars)`,
            });
            return response;
        },
        commit: commitArchiveOperations,
        onStateChange: (state, settledJob = null) => {
            for (const listener of listeners) {
                try { listener(state, settledJob); } catch { /* one view cannot break another */ }
            }
        },
    });
    productionRuntime.recover();
    return productionRuntime;
}

async function commitArchiveOperations({ jobId, timelineId, sceneId, mode, provenance, routeSnapshot, recipeId, acceptedProse, operations, lifecycleProposals, archiveFacts, ingestionReceipt }) {
    let transactionId = null;
    if (operations.length) {
        const result = executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: operations }, {
            timelineId,
            sceneId,
            turnId: provenance.sourceId,
            directionId: jobId,
            messageId: provenance.messageId,
            checkpointId: jobId,
            variableRefs: {},
            goalRefs: {},
            source: { kind: 'background-archive', mode: provenance.kind, documentId: provenance.documentId },
        });
        if (!result.ok) throw new Error((result.errors || []).join(' ') || 'The Archive transaction was rejected.');
        transactionId = result.transaction?.id || null;
    }
    let consequenceReceipt = null;
    try {
        const event = createArchiveSettlementEvent({
            jobId, timelineId, sceneId, mode, provenance, routeSnapshot, recipeId, acceptedProse,
            operations, lifecycleProposals, archiveFacts, ingestionReceipt, transactionId,
        });
        consequenceReceipt = await publishArchiveSettlement(event);
    } catch (error) {
        // The base Archive transaction has already committed. Consequence
        // projection is a downstream concern and must never turn that durable
        // success (or accepted prose) into a failed/retried Archive job.
        consequenceReceipt = {
            protocol: 'remodel/archive-settlement/1',
            status: 'failed-isolated',
            error: { name: String(error?.name || 'Error'), message: String(error?.message || error) },
        };
        recordDebugEvent('archive-consequences', 'dispatch.failed', {
            jobId, timelineId, sceneId, error: consequenceReceipt.error,
        }, { correlationId: jobId, severity: 'warn', summary: 'Archive saved; downstream consequence dispatch failed in isolation' });
    }
    return { ok: true, transactionId, archiveFacts, ingestionReceipt, consequenceReceipt };
}

function resolveSceneLoomRecipe(scene, mode) {
    const selected = getPromptStudioRecipe(scene?.promptRecipeIds?.loom);
    if (selected?.mode === 'loom' && selected?.apiType === 'chat') return selected;
    return mode === 'story' ? getStoryArchivePromptStudioRecipe() : getCurrentPromptStudioRecipe('loom', 'chat');
}

/**
 * Does this recipe place a given Loom source itself? Read from the recipe's own
 * enabled blocks rather than from a compiled result, because the question is
 * what the owner arranged, not what happened to render.
 */
export const backgroundArchiveIngestion = createArchiveIngestion(legacyArchiveIngestionAdapter);
