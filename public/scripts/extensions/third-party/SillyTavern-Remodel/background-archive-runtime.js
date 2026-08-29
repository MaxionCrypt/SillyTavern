import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, getCapabilityDictionary, MECHANICS_PROTOCOL } from './mechanics-capabilities.js';
import { buildNarratorArchivistSections } from './narrator-prompt.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe, getPromptStudioRecipe, getStoryArchivePromptStudioRecipe, recordSentPromptTranscript } from './prompt-studio.js';
import { buildLoomRecipeSources } from './loom-reconciliation.js';
import { resolveGenerationRoute } from './generation-route.js';
import { streamChatPrompt } from './story-stream.js';
import { ARCHIVE_CAPABILITY_NAMES, createArchiveIngestion } from './archive-ingestion.js';
import { legacyArchiveIngestionAdapter } from './legacy-archive-ingestion-adapter.js';
import { createArchiveJobRepository } from './archive-job-store.js';
import { createArchiveWorker } from './archive-worker.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';
import { createArchiveSettlementEvent, publishArchiveSettlement } from './archive-consequences.js';
import { buildTimelineLifecyclePromptGuide } from './timeline-lifecycle-contract.js';
import { buildTimelineLifecyclePromptContext, ensureTimelineLifecycleProjectionRegistered, getTimelineLifecycleProjectionSwitches } from './timeline-lifecycle-projection.js';
import { ensureTimelineLoreProjectionRegistered } from './timeline-lore-projection.js';

const ARCHIVE_CAPABILITY_SET = new Set(ARCHIVE_CAPABILITY_NAMES);

/** Loom source keys to the macro an owner writes in a block. */
const LOOM_SOURCE_MACROS = Object.freeze({
    archiveState: 'loom.archive',
    mechanicsBoard: 'loom.mechanics',
    lifecycleBoard: 'loom.lifecycle',
    playerAction: 'player.action',
    narratorDraft: 'narrator.draft',
});
const ARCHIVE_POLICY = `You are the Loom's background Archive clerk and lifecycle observer. The accepted prose is already canonical and visible to the user. Read it as evidence and update the shared Loom Archive. When lifecycle proposal operations are advertised, you may also propose only those bounded Goal or Variable lifecycle changes; code applies them later through a separate authority boundary.

Record distinct new events, changed scene facts, changed character state, hidden truths, and the unresolved open beat. Compare against the Current Archive. Do not duplicate, paraphrase an existing entry, invent facts, rewrite prose, continue the scene, roll or adjudicate unresolved Goals, change existing Variables, or propose lore.`;
const ARCHIVE_CONTRACT = `Output NOTHING except one state fence:
\`\`\`state
{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"the accepted prose establishes it"}]}
\`\`\`

Use only the operations advertised in this request. Lifecycle requests are proposals, never Archive facts or prose instructions. An empty requests array is valid when the accepted prose adds nothing new.`;

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
    const worker = createArchiveWorker({
        repository,
        transport,
        ingestion,
        commit,
        now,
        maxAttempts,
        retryDelayMs,
        timeoutMs,
    });

    function notify(timelineId) {
        try { onStateChange(status(timelineId)); } catch { /* UI listeners cannot break Archive work */ }
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
                notify(id);
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
        enqueue, retry, recover, status, waitForTimeline,
        supersede: worker.supersede,
        cancel: worker.cancel,
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
    profiles = getContext().extensionSettings?.connectionManager?.profiles || [],
} = {}) {
    const resolvedRecipe = recipe || resolveSceneLoomRecipe(scene, mode);
    const routeSnapshot = resolveGenerationRoute({ scene, role: 'loom', profiles });
    const context = String(archiveContext || buildNarratorArchivistSections(scene.timelineId, scene.id));
    const lifecycleProjection = getTimelineLifecycleProjectionSwitches();
    const lifecycleContext = buildTimelineLifecyclePromptContext(scene.timelineId, lifecycleProjection);
    const promptSnapshot = compileArchivePrompt({ acceptedProse, currentPlayerAction, archiveContext: context, recipe: resolvedRecipe, lifecycleProjection, lifecycleContext });
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
    };
}

export function compileArchivePrompt({ acceptedProse, currentPlayerAction = '', archiveContext = '', recipe, lifecycleProjection = {}, lifecycleContext = '' } = {}) {
    const capabilities = buildArchiveCapabilityGuide(lifecycleProjection);
    const lifecycle = String(lifecycleContext || '').trim();
    // The lifecycle board has its own macro so it can be positioned on its own.
    // A recipe that does not place it still receives it, appended to the
    // mechanics board exactly as before, so splitting the macro out cannot
    // silently drop it from a recipe written before the macro existed.
    const lifecyclePlaced = recipeUsesSource(recipe, 'lifecycleBoard');
    const sources = buildLoomRecipeSources({
        draft: acceptedProse,
        playerAction: currentPlayerAction,
        narrativeState: archiveContext,
        mechanicsSkill: lifecyclePlaced ? capabilities : [capabilities, lifecycle].filter(Boolean).join('\n\n'),
        livingLore: '',
    });
    sources.narratorDraft = `Accepted canonical prose (evidence only; never reproduce it):\n${String(acceptedProse || '').trim()}`;
    sources.archiveState = `Current Loom Archive:\n${String(archiveContext || '').trim() || '[empty]'}`;
    sources.mechanicsBoard = lifecyclePlaced ? capabilities : [capabilities, lifecycle].filter(Boolean).join('\n\n');
    sources.lifecycleBoard = lifecycle;
    const messages = [...compilePromptRecipe(recipe, sources).messages];
    // Policy and contract only. Everything else is the recipe's to place, move,
    // or leave out: a block the owner removed must stay removed.
    ensureMessage(messages, ARCHIVE_POLICY, 'system', true);
    ensureMessage(messages, ARCHIVE_CONTRACT, 'system');
    return {
        recipeId: String(recipe?.id || ''),
        recipeName: String(recipe?.name || 'Loom Archive'),
        revision: Number(recipe?.revision || recipe?.updatedAt || 0) || 0,
        messages,
    };
}

export function enqueueBackgroundArchive(input) {
    const runtime = getProductionRuntime();
    const job = runtime.enqueue(input);
    recordSentPromptTranscript('loom', {
        recipeName: `${job.promptSnapshot.recipeName || 'Loom'} · Background Archive`,
        messages: job.promptSnapshot.messages,
        request: { prompt: job.promptSnapshot.messages, transport: 'chat', purpose: 'background-archive' },
        transport: 'chat',
    });
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
    ensureTimelineLoreProjectionRegistered();
    productionRuntime = createBackgroundArchiveRuntime({
        transport: async ({ job, promptSnapshot, routeSnapshot, signal }) => {
            const response = await streamChatPrompt({ prompt: promptSnapshot.messages, profileId: routeSnapshot.profileId, signal });
            recordApiTranscript('response', {
                mode: 'loom', purpose: 'background-archive', text: typeof response === 'string' ? response : String(response?.text || ''),
                reasoning: typeof response === 'object' ? String(response?.reasoning || '') : '',
                streamed: typeof response === 'object' ? Boolean(response?.streamed) : false,
            }, { type: 'api.response.loom', correlationId: job.jobId, summary: 'Background Loom Archive response received' });
            return response;
        },
        commit: commitArchiveOperations,
        onStateChange: (state) => {
            for (const listener of listeners) {
                try { listener(state); } catch { /* one view cannot break another */ }
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

function buildArchiveCapabilityGuide(lifecycleProjection = {}) {
    const guide = getCapabilityDictionary()
        .filter((capability) => ARCHIVE_CAPABILITY_SET.has(capability.name))
        .map((capability) => {
            const required = (capability.requiredArguments || []).map((argument) => `${argument.key}: ${argument.hint}`).join('; ');
            return `- ${capability.name}: ${capability.description}${required ? `\n  arguments: ${required}` : ''}`;
        }).join('\n');
    const lifecycleGuide = buildTimelineLifecyclePromptGuide(lifecycleProjection);
    return [`[ARCHIVE OPERATIONS — always enabled]\n${guide}`, lifecycleGuide].filter(Boolean).join('\n\n');
}

/**
 * Does this recipe place a given Loom source itself? Read from the recipe's own
 * enabled blocks rather than from a compiled result, because the question is
 * what the owner arranged, not what happened to render.
 */
function recipeUsesSource(recipe, sourceKey) {
    const macro = LOOM_SOURCE_MACROS[sourceKey];
    if (!macro) return false;
    return (recipe?.blocks || []).some((block) => block?.enabled !== false
        && String(block?.content || '').includes(`{{${macro}}}`));
}

function ensureMessage(messages, content, role, prepend = false) {
    const text = String(content || '').trim();
    if (!text || messages.some((message) => String(message?.content || '').includes(text))) return;
    const entry = { role, content: text };
    if (prepend) messages.unshift(entry);
    else messages.push(entry);
}

export const backgroundArchiveIngestion = createArchiveIngestion(legacyArchiveIngestionAdapter);
