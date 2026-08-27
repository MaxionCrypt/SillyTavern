import { executeMechanicsRequest, getCapabilityDictionary, MECHANICS_PROTOCOL, undoMechanicsTransaction } from './mechanics-capabilities.js';
import { buildNarratorArchivistSections } from './narrator-prompt.js';
import {
    compilePromptRecipe,
    getPromptStudioRecipe,
    getStoryArchivePromptStudioRecipe,
    recordSentPromptTranscript,
} from './prompt-studio.js';
import { describeLoomReply, parseLoomReply } from './loom-reconciliation.js';
import { formatLivingLorePacket } from './living-lore-proposals.js';
import { promotionEvidence } from './world-sense-promotion.js';
import { invalidateLivingLoreProposals, queueLivingLoreProposals } from './living-lore-mutations.js';
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
import { STORY_ARCHIVE_CONTRACT, STORY_ARCHIVE_POLICY } from './story-loom-contract.js';
import { splitStoryArchiveAddition, STORY_ARCHIVE_PASSAGE_MAX_CHARS } from './story-archive-provenance.js';
import { buildStoryWorldSenseOptions, formatStoryWorldSenseContinuity } from './story-world-sense.js';
import { resolveWorldSense } from './world-sense-runtime.js';
import { saveWorldSensePromotionDecisionReceipt } from './world-sense-store.js';
import {
    buildStoryTimelineWebPacket,
    createStoryWebReceipt,
    formatStoryTimelineWebPacket,
    storyTimelineWebAddressing,
} from './story-timeline-web.js';

export const STORY_ARCHIVE_CAPABILITIES = Object.freeze([
    'scene.set', 'scene.clear', 'event.record',
    'char_state.set', 'char_state.clear', 'beat.set',
    'secret.set', 'secret.clear',
    'goal.create', 'goal.edit', 'goal.delete', 'goal.relate',
    'goal.lore.attach', 'goal.lore.detach',
    'variable.create', 'variable.set', 'variable.adjust', 'variable.transition', 'variable.subvalue.set',
    'variable.lore.attach', 'variable.lore.detach',
    'modifier.add', 'modifier.remove',
]);

const STORY_ARCHIVE_CAPABILITY_SET = new Set(STORY_ARCHIVE_CAPABILITIES);
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
        narratorReasoning: '',
    };
    const messages = [...compilePromptRecipe(recipe, sources).messages];
    ensurePromptContent(messages, STORY_ARCHIVE_POLICY, 'system', { prepend: true });
    ensurePromptContent(messages, sources.archiveState, 'system');
    ensurePromptContent(messages, sources.mechanicsBoard, 'system');
    ensurePromptContent(messages, sources.livingLore, 'system');
    ensurePromptContent(messages, sources.narratorDraft, 'user');
    ensurePromptContent(messages, STORY_ARCHIVE_CONTRACT, 'system');
    return messages;
}

export function queueStoryArchiveCapture({ scene, docId, captureId, onStateChange = null } = {}) {
    const key = String(scene?.id || '');
    if (!key || !docId || !captureId) return Promise.resolve(null);
    const prior = queues.get(key) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => processStoryArchiveCapture({ scene, docId, captureId, onStateChange }));
    queues.set(key, task);
    task.finally(() => {
        if (queues.get(key) === task) queues.delete(key);
    });
    return task;
}

export function resumeStoryArchiveCaptures({ scene, docId, onStateChange = null } = {}) {
    // A failed background pass must not strand accepted prose forever. Retry
    // it when the Scene is reopened, but cap automatic attempts so a broken
    // provider/recipe cannot silently spend requests on every visit.
    const pending = listStoryArchiveCaptures(docId, { statuses: ['pending', 'processing', 'failed'] })
        .filter((capture) => capture.status !== 'failed' || capture.attempts < 3);
    const bounded = pending.flatMap((capture) => boundOversizedManualCapture(docId, capture));
    return bounded.reduce(
        (chain, capture) => chain.then(() => queueStoryArchiveCapture({ scene, docId, captureId: capture.id, onStateChange })),
        Promise.resolve(),
    );
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
            invalidateStoryCaptureLore(scene.timelineId, change.supersedesCaptureIds, 'story-source-edited');
        }
    }
    const queuedIds = new Set(captures.map((capture) => capture.id));
    const failed = listStoryArchiveCaptures(docId, { statuses: ['failed'] })
        .filter((capture) => preview.retryCaptureIds.includes(capture.id) && capture.attempts < 3);
    for (const prior of failed) {
        for (const capture of boundOversizedManualCapture(docId, prior)) {
            if (queuedIds.has(capture.id)) continue;
            captures.push(capture);
            queuedIds.add(capture.id);
        }
    }
    const completion = captures.reduce(
        (chain, capture) => chain.then(async (results) => {
            results.push(await queueStoryArchiveCapture({ scene, docId, captureId: capture.id, onStateChange }));
            return results;
        }),
        Promise.resolve([]),
    );
    return { ok: true, stale: false, preview, captures, completion };
}

export async function waitForStoryArchive(sceneId) {
    const pending = queues.get(String(sceneId || ''));
    if (pending) await pending.catch(() => {});
}

export async function supersedeStoryBeatArchive({ scene, docId, beatId, onStateChange = null } = {}) {
    if (!scene?.id || !docId || !beatId) return [];
    const captures = supersedeStoryArchiveCapturesForBeat(docId, beatId);
    invalidateStoryCaptureLore(scene.timelineId, captures.map((capture) => capture.id), 'story-generation-superseded');
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
    });
    recordDebugEvent('story-archive', 'capture.started', captureReceipt(scene, docId, capture), {
        correlationId,
        summary: 'Story passage sent to the shared Loom Archive',
    });

    try {
        const response = testAdapter
            ? await testAdapter({ scene, doc: getStoryDoc(docId), capture, prompt })
            : await streamChatPrompt({ prompt, profileId: scene.generationProfileIds?.loom || undefined });
        const raw = typeof response === 'string' ? response : String(response?.text || '');
        recordApiTranscript('response', {
            mode: 'loom', purpose: 'story-archive', text: raw,
            reasoning: typeof response === 'object' ? String(response?.reasoning || '') : '',
            streamed: typeof response === 'object' ? Boolean(response?.streamed) : false,
        }, { type: 'api.response.loom', correlationId, summary: 'Story Archive Loom response received' });

        const replyShape = describeLoomReply(raw);
        const parsed = parseLoomReply(raw, { livingLorePacket: worldSense?.loomPacket || null });
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
        const requests = parsed.requests.filter((request) => STORY_ARCHIVE_CAPABILITY_SET.has(request?.capability));
        const disabledRequests = parsed.requests.filter((request) => !STORY_ARCHIVE_CAPABILITY_SET.has(request?.capability));
        const archiveFacts = storyArchiveEvidence(requests);
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
    const result = await queueLivingLoreProposals({
        timelineId: scene.timelineId,
        packet,
        proposals,
        acceptedProse: formatStoryCaptureEvidence(capture),
        archiveFacts: capture.archiveFacts || [],
        promotionFacts: promotionEvidence(packet.promotion),
        source: {
            mode: 'story',
            directionId: `story-archive:${capture.id}`,
            sceneId: String(scene.id),
            docId: String(docId),
            captureId: capture.id,
            bodyRevision: capture.bodyRevision,
            sourceSpan: { start: capture.start, end: capture.end },
            contentHash: capture.contentHash,
            origin: capture.origin,
        },
    });
    recordDebugEvent('story-archive', 'capture.lore-proposals', {
        ...captureReceipt(scene, docId, capture),
        proposed: proposals.length,
        queued: result.queued?.length || 0,
        rejected: result.rejected?.length || 0,
    }, {
        correlationId: `story-archive:${capture.id}`,
        severity: result.rejected?.length ? 'warn' : 'info',
        summary: `Story evidence queued ${result.queued?.length || 0}/${proposals.length} Living Lore proposal(s)`,
    });
    return { ok: result.ok, queued: result.queued || [], rejected: result.rejected || [] };
}

function invalidateStoryCaptureLore(timelineId, captureIds, reason) {
    const ids = (captureIds || []).map((id) => `story-archive:${String(id || '')}`).filter((id) => !id.endsWith(':'));
    if (ids.length) invalidateLivingLoreProposals({ timelineId, directionIds: ids, reason });
}

function storyArchiveEvidence(requests) {
    const values = [];
    for (const request of requests || []) {
        const args = request?.arguments || {};
        switch (request?.capability) {
            case 'event.record': values.push(args.summary); break;
            case 'scene.set': values.push(`${args.key}: ${args.value}`); break;
            case 'scene.clear': values.push(`${args.key}: cleared`); break;
            case 'char_state.set': values.push(`${args.charId} ${args.facet}: ${args.value}`); break;
            case 'char_state.clear': values.push(`${args.charId} ${args.facet}: cleared`); break;
            case 'beat.set': values.push(args.directive); break;
            default: break;
        }
    }
    return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
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

function boundOversizedManualCapture(docId, capture) {
    if (capture.origin !== 'user' || capture.changeType !== 'addition'
        || capture.text.length <= STORY_ARCHIVE_PASSAGE_MAX_CHARS
        || !['pending', 'failed'].includes(capture.status)) return [capture];
    const change = {
        id: `oversized:${capture.id}`,
        type: 'addition',
        start: capture.start,
        end: capture.end,
        beforeText: '',
        afterText: capture.text,
        supersedesCaptureIds: [capture.id],
        origin: 'user',
    };
    const parts = splitStoryArchiveAddition(change)
        .map((part) => createStoryArchiveCapture(docId, {
            origin: 'user',
            text: part.afterText,
            changeType: 'addition',
            start: part.start,
            end: part.end,
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

function ensurePromptContent(messages, content, role, { prepend = false } = {}) {
    const text = String(content || '').trim();
    if (!text || messages.some((message) => String(message?.content || '').includes(text))) return;
    const entry = { role, content: text };
    if (prepend) messages.unshift(entry);
    else messages.push(entry);
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
