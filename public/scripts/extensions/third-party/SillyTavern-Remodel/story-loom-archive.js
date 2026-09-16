import { executeMechanicsRequest, getCapabilityDictionary, MECHANICS_PROTOCOL, undoMechanicsTransaction } from './mechanics-capabilities.js';
import { getContext } from '../../../st-context.js';
import { buildNarratorArchivistSections } from './narrator-prompt.js';
import {
    compilePromptRecipe,
    getPromptStudioRecipe,
    getStoryArchivePromptStudioRecipe,
    recordSentPromptTranscript,
} from './prompt-studio.js';
import { describeLoomReply, parseLoomReply } from './loom-reconciliation.js';
import { formatLivingLorePacket } from './living-lore-proposals.js';
import { withdrawLivingLoreWrites } from './living-lore-withdrawal.js';
import { applyLoomLoreReports } from './living-lore-intake-runtime.js';
import { streamChatPrompt } from './story-stream.js';
import {
    createStoryArchiveCapture,
    getStoryArchiveCapture,
    getStoryDoc,
    listStoryArchiveCaptures,
    previewStoryArchiveCatchUp,
    supersedeStoryArchiveCaptures,
    supersedeStoryArchiveCapturesForBeat,
    updateStoryArchiveCapture,
} from './story-doc.js';
import { listMechanicsTransactions } from './variables-store.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';
import { countStoryArchiveWords, splitStoryArchiveAddition, STORY_ARCHIVE_PASSAGE_MAX_WORDS } from './story-archive-provenance.js';
import { buildStoryWorldSenseOptions, formatStoryWorldSenseContinuity } from './story-world-sense.js';
import { resolveWorldSense, retrieveWorldSenseByKeywords } from './world-sense-runtime.js';
import { saveWorldSensePromotionDecisionReceipt, saveWorldSenseProposalRejections } from './world-sense-store.js';
import {
    buildStoryTimelineWebPacket,
    createStoryWebReceipt,
    formatStoryTimelineWebPacket,
    storyTimelineWebAddressing,
} from './story-timeline-web.js';
import { resolveGenerationRoute } from './generation-route.js';
import {
    createArchiveIngestion,
    isArchiveCapability,
    STORY_ARCHIVE_CAPABILITIES,
} from './archive-ingestion.js';

// Re-exported for the existing importers of this module; it now lives beside
// the Archive-only set it extends.
export { STORY_ARCHIVE_CAPABILITIES };
import {
    legacyArchiveIngestionAdapter,
    storyArchiveIngestionInput,
} from './legacy-archive-ingestion-adapter.js';
import {
    enqueueBackgroundArchive,
    getBackgroundArchiveJob,
    prepareBackgroundArchiveJob,
    retryBackgroundArchive,
    supersedeBackgroundArchive,
    takeBackgroundArchiveReply,
    waitForBackgroundArchive,
} from './background-archive-runtime.js';

const STORY_ARCHIVE_CAPABILITY_SET = new Set(STORY_ARCHIVE_CAPABILITIES);
const legacyArchiveIngestion = createArchiveIngestion(legacyArchiveIngestionAdapter);
const queues = new Map();
let testAdapter = null;

export function setStoryLoomArchiveTestAdapter(adapter = null) {
    testAdapter = typeof adapter === 'function' ? adapter : null;
}

export function describeStoryArchiveCaptureState(docId) {
    const captures = listStoryArchiveCaptures(docId);
    if (captures.some((capture) => capture.status === 'processing')) return { status: 'processing', label: 'Archive syncingâ€¦' };
    if (captures.some((capture) => capture.status === 'pending')) return { status: 'pending', label: 'Archive queued' };
    const latest = [...captures].reverse().find((capture) => capture.status !== 'superseded');
    if (latest?.status === 'failed') return { status: 'failed', label: 'Archive needs attention', error: latest.error };
    const doc = getStoryDoc(docId);
    const archivedRevision = captures
        .filter((capture) => capture.status === 'applied' && capture.sourceStatus !== 'obsolete')
        .reduce((highest, capture) => Math.max(highest, Number(capture.bodyRevision) || 0), 0);
    if (Number(doc?.bodyRevision || 0) > archivedRevision) {
        return {
            status: 'catch-up',
            label: 'Archive catch-up available',
        };
    }
    if (latest?.status === 'applied') return { status: 'applied', label: 'Saved Â· Archived' };
    return { status: 'idle', label: 'Saved' };
}

export function buildStoryArchivePrompt({ passage, archiveState, worldSense = null, webPacket = null, recipe = getStoryArchivePromptStudioRecipe() } = {}) {
    const continuity = formatStoryWorldSenseContinuity(worldSense);
    const currentArchive = String(archiveState || '').trim()
        ? `Current Timeline Loom Archive for this Scene:\n${String(archiveState).trim()}`
        : 'Current Timeline Loom Archive for this Scene: empty.';
    const sources = {
        archiveState: [currentArchive, continuity, formatStoryTimelineWebPacket(webPacket)].filter(Boolean).join('\n\n'),
        mechanicsBoard: buildArchiveCapabilityGuide(),
        livingLore: formatLivingLorePacket(worldSense?.loomPacket),
        narratorDraft: `Accepted Story manuscript passage (evidence only; never reproduce it):\n${String(passage || '').trim()}`,
        // Kept separate from narratorDraft so the Story Archive recipe says
        // exactly what it consumes. narratorDraft remains as a compatibility
        // alias for owner-authored older recipes.
        storyArchiveCapture: `Accepted Story manuscript passage (evidence only; never reproduce it):\n${String(passage || '').trim()}`,
        narratorReasoning: '',
    };
    // This direct path is used by the Story Archive test adapter. It must have
    // the same ownership rule as the background path: recipe blocks are the
    // complete model-facing prompt, while parsing still validates the reply.
    return [...compilePromptRecipe(recipe, sources).messages];
}

export function queueStoryArchiveCapture({ scene, docId, captureId, onStateChange = null } = {}) {
    const key = String(scene?.id || '');
    if (!key || !docId || !captureId) return Promise.resolve(null);
    const prior = queues.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => testAdapter
        ? processStoryArchiveCapture({ scene, docId, captureId, onStateChange })
        : processStoryBackgroundArchiveCapture({ scene, docId, captureId, onStateChange }));
    queues.set(key, task);
    task.finally(() => {
        if (queues.get(key) === task) queues.delete(key);
    });
    return task;
}

/** Queue an ordered batch of accepted manuscript blocks, oldest first. */
export function queueStoryArchiveCaptures({ scene, docId, captureIds = [], onStateChange = null } = {}) {
    const ids = [...new Set((captureIds || []).map(String).filter(Boolean))];
    return ids.reduce(
        (chain, captureId) => chain.then(async (results) => {
            results.push(await queueStoryArchiveCapture({ scene, docId, captureId, onStateChange }));
            return results;
        }),
        Promise.resolve([]),
    );
}

async function processStoryBackgroundArchiveCapture({ scene, docId, captureId, onStateChange = null } = {}) {
    let capture = getStoryArchiveCapture(docId, captureId);
    if (!scene?.timelineId || !scene?.id || !capture || capture.status === 'applied' || capture.status === 'superseded') return capture;
    capture = updateCapture(docId, capture.id, {
        status: 'processing',
        attempts: Number(capture.attempts || 0) + 1,
        error: '',
    }, onStateChange);
    try {
        const passage = formatStoryCaptureEvidence(capture);
        const selectedRecipe = getPromptStudioRecipe(scene.promptRecipeIds?.loom);
        const recipe = selectedRecipe?.mode === 'loom' && selectedRecipe?.apiType === 'chat'
            ? selectedRecipe
            : getStoryArchivePromptStudioRecipe();
        // The Story pass is the only Loom pass a manuscript gets, so it has to
        // carry Living Lore itself: the packet in, the reports out. Roleplay
        // does this in its live reconciliation and leaves the background
        // Archive lore-blind; Story has no live pass to leave it to.
        let worldSense = null;
        try {
            worldSense = await resolveWorldSense(scene, buildStoryWorldSenseOptions({ doc: getStoryDoc(docId), passage }));
        } catch (error) {
            recordDebugEvent('world-sense', 'story.retrieval.failed-open', {
                timelineId: scene.timelineId,
                sceneId: scene.id,
                captureId: capture.id,
                error: String(error?.message || error),
            }, { correlationId: `story-archive:${capture.id}`, severity: 'warn', summary: 'Story World Sense failed open; Archive capture continued' });
        }
        const livingLorePacket = worldSense?.loomPacket || null;
        const prepared = prepareBackgroundArchiveJob({
            scene,
            mode: 'story',
            acceptedProse: passage,
            recipe,
            livingLore: formatLivingLorePacket(livingLorePacket),
            livingLorePacket,
            recall: formatStoryWorldSenseContinuity(worldSense),
            provenance: {
                kind: 'story-passage',
                sourceId: capture.generationId || capture.id,
                documentId: docId,
                checkpointId: capture.id,
                supersedesJobIds: (capture.supersedesCaptureIds || []).map((id) => `story-archive:${id}`),
            },
        });
        capture = updateCapture(docId, capture.id, {
            worldSenseReceiptId: worldSense?.receipt?.id || null,
            livingLorePacket,
        }, onStateChange);
        const job = enqueueBackgroundArchive({ ...prepared, jobId: `story-archive:${capture.id}` });
        if (job.status === 'failed-repairable') retryBackgroundArchive(job.jobId);
        await waitForBackgroundArchive(scene.timelineId);
        const stored = getBackgroundArchiveJob(job.jobId);
        if (stored?.status !== 'succeeded') {
            throw new Error(stored?.error?.message || 'The Loom Archive background job did not complete.');
        }
        capture = updateCapture(docId, capture.id, {
            transactionId: stored.result?.commitReceipt?.transactionId || null,
            archiveFacts: stored.result?.archiveFacts || [],
        }, onStateChange);

        // Lore is filed only after the Archive has committed: a failed Archive
        // retries the whole reply, and filing lore from a reply that is about
        // to be asked for again would file it twice.
        const reply = takeBackgroundArchiveReply(job.jobId);
        if (reply && livingLorePacket?.promotion?.candidates?.length) {
            saveWorldSensePromotionDecisionReceipt(worldSense?.receipt?.id, {
                decisions: reply.lorePromotionDecisions,
                rejections: reply.lorePromotionDecisionRejections,
            });
        }
        capture = updateCapture(docId, capture.id, {
            loreProposals: reply?.loreProposals || [],
            loreProposalRejections: reply?.loreProposalRejections || [],
            loreKeywords: reply?.loreKeywords || [],
            lorePromotionDecisions: reply?.lorePromotionDecisions || [],
            lorePromotionDecisionRejections: reply?.lorePromotionDecisionRejections || [],
        }, onStateChange);
        const lore = await queueStoryCaptureLore({ scene, docId, capture, packet: livingLorePacket });
        let keywordReceiptId = null;
        const loreKeywords = Array.isArray(reply?.loreKeywords) ? reply.loreKeywords : [];
        // The Story capture is already committed. A keyword request therefore
        // only changes the context selected for a later passage, never this
        // accepted manuscript text.
        if (loreKeywords.length) {
            try {
                const retrieved = await retrieveWorldSenseByKeywords(scene, loreKeywords);
                keywordReceiptId = retrieved?.receipt?.id || null;
                const count = retrieved?.selected?.length || 0;
                recordDebugEvent('world-sense', 'keyword-request', {
                    source: 'background-archive', jobId: job.jobId, captureId: capture.id,
                    keywords: loreKeywords,
                    selected: (retrieved?.selected || []).map((item) => item.name).filter(Boolean),
                    degraded: Boolean(retrieved?.degraded),
                }, {
                    correlationId: `story-archive:${capture.id}`,
                    severity: retrieved?.degraded ? 'warn' : 'info',
                    summary: `Background Loom replaced the working lore with ${count} entr${count === 1 ? 'y' : 'ies'} for ${loreKeywords.join(', ')}`,
                });
            } catch (error) {
                recordDebugEvent('world-sense', 'keyword-request.failed', {
                    source: 'background-archive', jobId: job.jobId, captureId: capture.id,
                    keywords: loreKeywords, error: String(error?.message || error),
                }, { correlationId: `story-archive:${capture.id}`, severity: 'warn' });
            }
        }
        return updateCapture(docId, capture.id, {
            status: 'applied',
            loreProposalIds: lore.queued.map((item) => item.id),
            loreProposalRejections: [...(reply?.loreProposalRejections || []), ...(lore.rejected || [])],
            worldSenseKeywordReceiptId: keywordReceiptId,
            error: '',
            appliedAt: new Date().toISOString(),
        }, onStateChange);
    } catch (error) {
        return updateCapture(docId, capture.id, {
            status: 'failed',
            error: String(error?.message || error),
        }, onStateChange);
    }
}

export function resumeStoryArchiveCaptures({ scene, docId, onStateChange = null } = {}) {
    // A failed background pass must not strand accepted prose forever. Retry
    // it when the Scene is reopened, but cap automatic attempts so a broken
    // provider/recipe cannot silently spend requests on every visit.
    const pending = listStoryArchiveCaptures(docId, { statuses: ['pending', 'processing', 'failed'] })
        .filter((capture) => capture.status !== 'failed' || capture.attempts < 3);
    const bounded = pending.flatMap((capture) => boundOversizedStoryCapture(docId, capture));
    return queueStoryArchiveCaptures({ scene, docId, captureIds: bounded.map((capture) => capture.id), onStateChange });
}

/** Turn one owner-approved, revision-fenced preview into queued captures. */
export function captureStoryArchiveCatchUp({ scene, docId, previewToken, onStateChange = null } = {}) {
    const preview = previewStoryArchiveCatchUp(docId);
    if (!scene?.id || !docId || !preview || preview.token !== String(previewToken || '')) {
        return { ok: false, stale: true, preview, captures: [], completion: Promise.resolve([]) };
    }
    const captures = [];
    for (const change of preview.changes) {
        const parts = splitStoryArchiveAddition(change);
        const partCaptures = [];
        for (const part of parts) {
            const capture = createManualCatchUpCapture(docId, preview, part);
            if (!capture) continue;
            captures.push(capture);
            partCaptures.push(capture);
        }
        if (change.supersedesCaptureIds.length && partCaptures.length) {
            supersedeStoryArchiveCaptures(docId, change.supersedesCaptureIds, partCaptures[0].id);
            for (const captureId of change.supersedesCaptureIds) {
                supersedeBackgroundArchive(`story-archive:${captureId}`, `story-archive:${partCaptures[0].id}`);
            }
            invalidateStoryCaptureLore(scene.timelineId, change.supersedesCaptureIds, 'story-source-edited')
                .catch(() => { /* withdrawal failure is reported through the ledger, not by failing the capture */ });
        }
    }
    const queuedIds = new Set(captures.map((capture) => capture.id));
    const failed = listStoryArchiveCaptures(docId, { statuses: ['failed'] })
        .filter((capture) => preview.retryCaptureIds.includes(capture.id) && capture.attempts < 3);
    for (const prior of failed) {
        for (const capture of boundOversizedStoryCapture(docId, prior)) {
            if (queuedIds.has(capture.id)) continue;
            captures.push(capture);
            queuedIds.add(capture.id);
        }
    }
    const completion = queueStoryArchiveCaptures({ scene, docId, captureIds: captures.map((capture) => capture.id), onStateChange });
    return { ok: true, stale: false, preview, captures, completion };
}

export async function waitForStoryArchive(sceneId) {
    const pending = queues.get(String(sceneId || ''));
    if (pending) await pending.catch(() => {});
}

export async function supersedeStoryBeatArchive({ scene, docId, beatId, onStateChange = null } = {}) {
    if (!scene?.id || !docId || !beatId) return [];
    const captures = supersedeStoryArchiveCapturesForBeat(docId, beatId);
    for (const capture of captures) supersedeBackgroundArchive(`story-archive:${capture.id}`);
    await invalidateStoryCaptureLore(scene.timelineId, captures.map((capture) => capture.id), 'story-generation-superseded');
    for (const capture of captures) {
        if (!capture.transactionId) continue;
        const transaction = listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id })
            .find((item) => item.id === capture.transactionId);
        if (transaction) undoMechanicsTransaction(transaction);
        updateStoryArchiveCapture(docId, capture.id, { transactionId: null });
    }
    try { onStateChange?.(describeStoryArchiveCaptureState(docId)); } catch { /* UI feedback cannot break supersession */ }
    return captures;
}

export async function processStoryArchiveCapture({ scene, docId, captureId, onStateChange = null } = {}) {
    let capture = getStoryArchiveCapture(docId, captureId);
    if (!scene?.timelineId || !scene?.id || !capture || capture.status === 'applied' || capture.status === 'superseded') return capture;

    const recovered = listMechanicsTransactions({ timelineId: scene.timelineId, sceneId: scene.id })
        .find((transaction) => transaction.checkpointId === capture.id && transaction.status === 'applied');
    if (recovered) {
        const lore = await queueStoryCaptureLore({ scene, docId, capture, packet: capture.livingLorePacket });
        const webReceipt = capture.webReceipt || createStoryWebReceipt({ scene, docId, capture, transaction: recovered, lore });
        return updateCapture(docId, capture.id, {
            status: 'applied',
            transactionId: recovered.id,
            webReceipt,
            loreProposalIds: lore.queued.map((item) => item.id),
            loreProposalRejections: [...(capture.loreProposalRejections || []), ...(lore.rejected || [])],
            error: '',
            appliedAt: new Date().toISOString(),
        }, onStateChange);
    }

    await undoSupersededBeatCaptures(docId, capture);
    capture = updateCapture(docId, capture.id, {
        status: 'processing',
        attempts: capture.attempts + 1,
        error: '',
    }, onStateChange);

    const doc = getStoryDoc(docId);
    const passage = formatStoryCaptureEvidence(capture);
    let worldSense = null;
    try {
        worldSense = await resolveWorldSense(scene, buildStoryWorldSenseOptions({ doc, passage }));
    } catch (error) {
        recordDebugEvent('world-sense', 'story.retrieval.failed-open', {
            timelineId: scene.timelineId,
            sceneId: scene.id,
            captureId: capture.id,
            error: String(error?.message || error),
        }, { correlationId: `story-archive:${capture.id}`, severity: 'warn', summary: 'Story World Sense failed open; Archive capture continued' });
    }
    const archiveState = buildNarratorArchivistSections(scene.timelineId, scene.id);
    const webPacket = buildStoryTimelineWebPacket({ scene, worldSense });
    const selectedRecipe = getPromptStudioRecipe(scene.promptRecipeIds?.loom);
    const recipe = selectedRecipe?.mode === 'loom' && selectedRecipe?.apiType === 'chat'
        ? selectedRecipe
        : getStoryArchivePromptStudioRecipe();
    const prompt = buildStoryArchivePrompt({ passage, archiveState, worldSense, webPacket, recipe });
    const correlationId = `story-archive:${capture.id}`;
    recordSentPromptTranscript('loom', {
        recipeName: `${recipe?.name || 'Loom'} Â· Story Archive`,
        messages: prompt,
        request: { prompt, transport: 'chat', purpose: 'story-archive' },
        transport: 'chat',
    }, { correlationId });
    recordDebugEvent('story-archive', 'capture.started', captureReceipt(scene, docId, capture), {
        correlationId,
        summary: 'Story passage sent to the shared Loom Archive',
    });

    try {
        const loomRoute = testAdapter ? null : resolveGenerationRoute({
            scene,
            role: 'loom',
            profiles: getContext().extensionSettings?.connectionManager?.profiles || [],
        });
        const response = testAdapter
            ? await testAdapter({ scene, doc: getStoryDoc(docId), capture, prompt })
            : await streamChatPrompt({ prompt, profileId: loomRoute.profileId });
        const raw = typeof response === 'string' ? response : String(response?.text || '');
        recordApiTranscript('response', {
            mode: 'loom', purpose: 'story-archive', text: raw,
            reasoning: typeof response === 'object' ? String(response?.reasoning || '') : '',
            streamed: typeof response === 'object' ? Boolean(response?.streamed) : false,
        }, { type: 'api.response.loom', correlationId, summary: 'Story Archive Loom response received' });

        const replyShape = describeLoomReply(raw);
        const parsed = parseLoomReply(raw, { livingLorePacket: worldSense?.loomPacket || null });
        const archiveIngestion = await legacyArchiveIngestion.ingest(storyArchiveIngestionInput({
            scene,
            docId,
            capture,
            acceptedProse: passage,
            candidateReply: raw,
            archiveState,
        }));
        if (worldSense?.loomPacket?.promotion?.candidates?.length) {
            saveWorldSensePromotionDecisionReceipt(worldSense?.receipt?.id, {
                decisions: parsed.lorePromotionDecisions || [],
                rejections: parsed.lorePromotionDecisionRejections || [],
            });
            recordDebugEvent('world-sense', 'promotion.decisions', {
                timelineId: scene.timelineId, sceneId: scene.id, captureId: capture.id,
                candidates: worldSense.loomPacket.promotion.candidates,
                decisions: parsed.lorePromotionDecisions || [],
                rejections: parsed.lorePromotionDecisionRejections || [],
            }, {
                correlationId: `story-archive:${capture.id}`,
                severity: parsed.lorePromotionDecisionRejections?.length ? 'warn' : 'info',
                summary: `Story Loom judged ${parsed.lorePromotionDecisions?.length || 0}/${worldSense.loomPacket.promotion.candidates.length} World Sense promotion candidate(s)`,
            });
        }
        const approvedArchiveOperations = [...archiveIngestion.operations];
        const requests = parsed.requests.flatMap((request) => {
            if (!STORY_ARCHIVE_CAPABILITY_SET.has(request?.capability)) return [];
            if (!isArchiveCapability(request?.capability)) return [request];
            const approved = approvedArchiveOperations.shift();
            return approved ? [approved] : [];
        });
        const disabledRequests = parsed.requests.filter((request) => !STORY_ARCHIVE_CAPABILITY_SET.has(request?.capability));
        const archiveFacts = archiveIngestion.archiveFacts;
        if (!replyShape.fenceParsed) {
            throw new Error('The Story Loom returned no readable state fence for this accepted passage.');
        }
        if (parsed.requests.length && !requests.length) {
            throw new Error('The Story Loom returned only operations disabled for Story Archive capture.');
        }
        capture = updateCapture(docId, capture.id, {
            worldSenseReceiptId: worldSense?.receipt?.id || null,
            livingLorePacket: worldSense?.loomPacket || null,
            timelineWebPacket: webPacket,
            loreProposals: parsed.loreProposals,
            loreProposalRejections: parsed.loreProposalRejections,
            lorePromotionDecisions: parsed.lorePromotionDecisions || [],
            lorePromotionDecisionRejections: parsed.lorePromotionDecisionRejections || [],
            archiveFacts,
        }, onStateChange);
        if (!requests.length && !parsed.loreProposals.length) {
            const webReceipt = createStoryWebReceipt({ scene, docId, capture, worldSense, webPacket, lore: { queued: [], rejected: disabledRequests.map((request) => ({ code: 'story-capability-disabled', capability: request.capability })) } });
            const applied = updateCapture(docId, capture.id, {
                status: 'applied',
                transactionId: null,
                webReceipt,
                error: '',
                appliedAt: new Date().toISOString(),
            }, onStateChange);
            recordDebugEvent('story-archive', 'capture.noop', captureReceipt(scene, docId, applied), {
                correlationId,
                summary: 'Story passage required no changes to the shared Loom Archive',
            });
            return applied;
        }
        let transactionId = null;
        let transaction = null;
        if (requests.length) {
            const addressing = storyTimelineWebAddressing(webPacket);
            const result = executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests }, {
                timelineId: scene.timelineId,
                sceneId: scene.id,
                turnId: capture.generationId || capture.id,
                directionId: correlationId,
                checkpointId: capture.id,
                variableRefs: addressing.variableRefs,
                goalRefs: addressing.goalRefs,
                loreRefs: addressing.loreRefs,
                source: captureReceipt(scene, docId, capture),
            });
            if (!result.ok) throw new Error((result.errors || []).join(' ') || 'The Archive transaction was rejected.');
            transaction = result.transaction || null;
            transactionId = result.transaction?.id || null;
        }
        const lore = await queueStoryCaptureLore({ scene, docId, capture, packet: worldSense?.loomPacket || null });
        const loreRejections = [
            ...(parsed.loreProposalRejections || []),
            ...(lore.rejected || []),
            ...disabledRequests.map((request) => ({ code: 'story-capability-disabled', capability: request.capability, requestId: request.id })),
        ];
        const webReceipt = createStoryWebReceipt({ scene, docId, capture, worldSense, webPacket, transaction, lore: { ...lore, rejected: loreRejections } });
        const applied = updateCapture(docId, capture.id, {
            status: 'applied',
            transactionId,
            webReceipt,
            loreProposalIds: lore.queued.map((item) => item.id),
            loreProposalRejections: loreRejections,
            error: '',
            appliedAt: new Date().toISOString(),
        }, onStateChange);
        recordDebugEvent('story-archive', 'capture.applied', {
            ...captureReceipt(scene, docId, applied),
            requestCount: requests.length,
            transactionId,
            webReceipt: summarizeWebReceipt(webReceipt),
            loreOutcome: {
                proposed: parsed.loreProposals.length,
                queued: lore.queued.length,
                queuedIds: lore.queued.map((item) => String(item.id)),
                rejected: applied.loreProposalRejections.length,
            },
        }, { correlationId, summary: `Story passage added ${requests.length} Archive operation(s) and ${lore.queued.length} Living Lore proposal(s)` });
        return applied;
    } catch (error) {
        const failed = updateCapture(docId, capture.id, {
            status: 'failed',
            error: String(error?.message || error),
        }, onStateChange);
        recordDebugEvent('story-archive', 'capture.failed', {
            ...captureReceipt(scene, docId, failed),
            error: failed.error,
        }, { correlationId, severity: 'warn', summary: 'Story passage could not update the Loom Archive' });
        return failed;
    }
}

async function queueStoryCaptureLore({ scene, docId, capture, packet }) {
    const proposals = Array.isArray(capture?.loreProposals) ? capture.loreProposals : [];
    if (!packet?.book || !proposals.length) return { ok: true, queued: [], rejected: [] };
    // Same intake as roleplay: the Loom reports, Living Lore places. A Story
    // capture already carries when it was recorded, which is what placement
    // scores the temporal signal against.
    const result = await applyLoomLoreReports({
        timelineId: scene.timelineId,
        book: packet.book,
        records: proposals,
        recordedAt: capture.recordedAt || capture.at || capture.createdAt || new Date().toISOString(),
        acceptedProse: formatStoryCaptureEvidence(capture),
        archiveFacts: capture.archiveFacts || [],
        source: { directionId: `story-archive:${capture.id}`, sceneId: String(scene.id) },
    });
    if (result.rejected?.length) {
        saveWorldSenseProposalRejections({
            timelineId: scene.timelineId,
            sceneId: scene.id,
            directionId: `story-archive:${capture.id}`,
            phase: 'story-archive',
            rejected: result.rejected,
        });
    }
    recordDebugEvent('story-archive', 'capture.lore-proposals', {
        ...captureReceipt(scene, docId, capture),
        reported: proposals.length,
        appended: result.appended || 0,
        created: result.created || 0,
        rejected: result.rejected?.length || 0,
    }, {
        correlationId: `story-archive:${capture.id}`,
        severity: result.rejected?.length ? 'warn' : 'info',
        summary: `Story evidence filed ${result.applied?.length || 0}/${proposals.length} Living Lore report(s): ${result.appended || 0} appended, ${result.created || 0} created`,
    });
    // Intake reports what it APPLIED; there is no queue any more. This read
    // `result.queued` for a while after the queue was retired, so every
    // capture recorded zero filed proposals no matter how many were written.
    // The id is the ledger write, the same handle withdrawal removes by.
    const queued = (result.applied || []).map((item) => ({
        ...item,
        id: String(item.writeId || `${item.book}.${item.uid}`),
    }));
    return { ok: result.ok, queued, rejected: result.rejected || [] };
}

async function invalidateStoryCaptureLore(timelineId, captureIds, reason) {
    const ids = (captureIds || []).map((id) => `story-archive:${String(id || '')}`).filter((id) => !id.endsWith(':'));
    if (ids.length) await withdrawLivingLoreWrites({ timelineId, directionIds: ids, reason });
}

function createManualCatchUpCapture(docId, preview, change) {
    return createStoryArchiveCapture(docId, {
        origin: 'user',
        text: change.afterText,
        beforeText: change.beforeText,
        changeType: change.type,
        start: change.start,
        end: change.end,
        supersedesCaptureIds: change.supersedesCaptureIds,
        stableKey: `manual:${preview.token}:${change.id}`,
    });
}

function boundOversizedStoryCapture(docId, capture) {
    if (capture.changeType !== 'addition'
        || countStoryArchiveWords(capture.text) <= STORY_ARCHIVE_PASSAGE_MAX_WORDS
        || !['pending', 'failed'].includes(capture.status)) return [capture];
    const change = {
        id: `oversized:${capture.id}`,
        type: 'addition',
        start: capture.start,
        end: capture.end,
        beforeText: '',
        afterText: capture.text,
        supersedesCaptureIds: [capture.id],
        origin: capture.origin,
    };
    const parts = splitStoryArchiveAddition(change)
        .map((part) => createStoryArchiveCapture(docId, {
            origin: capture.origin,
            text: part.afterText,
            changeType: 'addition',
            start: part.start,
            end: part.end,
            generationId: capture.generationId,
            beatId: capture.beatId,
            supersedesCaptureIds: [capture.id],
            stableKey: `${capture.stableKey}:part:${part.part}-of-${part.totalParts}`,
        })).filter(Boolean);
    if (parts.length) supersedeStoryArchiveCaptures(docId, [capture.id], parts[0].id);
    return parts.length ? parts : [capture];
}

function formatStoryCaptureEvidence(capture) {
    if (capture.changeType === 'edit') {
        return `Author-approved manuscript edit.\nBEFORE:\n${capture.beforeText}\n\nAFTER:\n${capture.text}`;
    }
    if (capture.changeType === 'deletion') {
        return `Author-approved manuscript deletion.\nBEFORE:\n${capture.beforeText}\n\nAFTER:\n[deleted]`;
    }
    const label = capture.origin === 'user' ? 'Author-approved manuscript addition' : 'Accepted Story Narrator passage';
    return `${label}:\n${capture.text}`;
}

async function undoSupersededBeatCaptures(docId, current) {
    if (!current.beatId) return;
    for (const capture of listStoryArchiveCaptures(docId)) {
        if (capture.id === current.id || capture.beatId !== current.beatId || capture.status !== 'superseded' || !capture.transactionId) continue;
        const transaction = listMechanicsTransactions().find((item) => item.id === capture.transactionId);
        if (transaction) undoMechanicsTransaction(transaction);
        updateStoryArchiveCapture(docId, capture.id, { transactionId: null });
    }
}

function updateCapture(docId, captureId, patch, onStateChange) {
    const capture = updateStoryArchiveCapture(docId, captureId, patch);
    try { onStateChange?.(describeStoryArchiveCaptureState(docId), capture); } catch { /* UI feedback cannot break ingestion */ }
    return capture;
}

function buildArchiveCapabilityGuide() {
    const guide = getCapabilityDictionary()
        .filter((capability) => STORY_ARCHIVE_CAPABILITY_SET.has(capability.name))
        .map((capability) => {
            const required = (capability.requiredArguments || []).map((argument) => `${argument.key} â€” ${argument.hint}`).join('; ');
            return `- ${capability.name}: ${capability.description}${required ? `\n    arguments: ${required}` : ''}`;
        }).join('\n');
    return `[TIMELINE WEB OPERATIONS — the only capabilities enabled in this pass]\n${guide}`;
}

function captureReceipt(scene, docId, capture) {
    return {
        timelineId: String(scene?.timelineId || ''),
        sceneId: String(scene?.id || ''),
        sceneMode: String(scene?.mode || 'story'),
        docId: String(docId || ''),
        captureId: capture?.id || null,
        origin: capture?.origin || null,
        bodyRevision: capture?.bodyRevision ?? null,
        sourceSpan: capture ? { start: capture.start, end: capture.end } : null,
        contentHash: capture?.contentHash || null,
        status: capture?.status || null,
        attempts: capture?.attempts || 0,
        worldSenseReceiptId: capture?.worldSenseReceiptId || null,
        webReceiptId: capture?.webReceipt?.id || null,
    };
}

function summarizeWebReceipt(receipt) {
    if (!receipt) return null;
    return {
        id: receipt.id,
        sourceSceneId: receipt.sceneId,
        documentRevision: receipt.bodyRevision,
        sourceSpan: receipt.sourceSpan,
        contentHash: receipt.contentHash,
        worldSenseReceiptId: receipt.worldSenseReceiptId,
        mechanics: receipt.mechanics,
        loreProposalIds: receipt.loreProposalIds,
        loreProposalRejections: receipt.loreProposalRejections,
    };
}
