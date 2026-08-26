import { executeMechanicsRequest, getCapabilityDictionary, MECHANICS_PROTOCOL, undoMechanicsTransaction } from './mechanics-capabilities.js';
import { buildNarratorArchivistSections } from './narrator-prompt.js';
import {
    compilePromptRecipe,
    getPromptStudioRecipe,
    getStoryArchivePromptStudioRecipe,
    recordSentPromptTranscript,
} from './prompt-studio.js';
import { describeLoomReply, parseLoomReply } from './loom-reconciliation.js';
import { streamChatPrompt } from './story-stream.js';
import {
    getStoryArchiveCapture,
    getStoryDoc,
    listStoryArchiveCaptures,
    supersedeStoryArchiveCapturesForBeat,
    updateStoryArchiveCapture,
} from './story-doc.js';
import { listMechanicsTransactions } from './variables-store.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';
import { STORY_ARCHIVE_CONTRACT, STORY_ARCHIVE_POLICY } from './story-loom-contract.js';

export const STORY_ARCHIVE_CAPABILITIES = Object.freeze([
    'scene.set', 'scene.clear', 'event.record',
    'char_state.set', 'char_state.clear', 'beat.set',
    'secret.set', 'secret.clear',
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

export function buildStoryArchivePrompt({ passage, archiveState, recipe = getStoryArchivePromptStudioRecipe() } = {}) {
    const sources = {
        archiveState: String(archiveState || '').trim()
            ? `Current Timeline Loom Archive for this Scene:\n${String(archiveState).trim()}`
            : 'Current Timeline Loom Archive for this Scene: empty.',
        mechanicsBoard: buildArchiveCapabilityGuide(),
        livingLore: '',
        narratorDraft: `Accepted Story manuscript passage (evidence only; never reproduce it):\n${String(passage || '').trim()}`,
        narratorReasoning: '',
    };
    const messages = [...compilePromptRecipe(recipe, sources).messages];
    ensurePromptContent(messages, STORY_ARCHIVE_POLICY, 'system', { prepend: true });
    ensurePromptContent(messages, sources.archiveState, 'system');
    ensurePromptContent(messages, sources.mechanicsBoard, 'system');
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
    const pending = listStoryArchiveCaptures(docId, { statuses: ['pending', 'processing'] });
    return pending.reduce(
        (chain, capture) => chain.then(() => queueStoryArchiveCapture({ scene, docId, captureId: capture.id, onStateChange })),
        Promise.resolve(),
    );
}

export async function waitForStoryArchive(sceneId) {
    const pending = queues.get(String(sceneId || ''));
    if (pending) await pending.catch(() => {});
}

export async function supersedeStoryBeatArchive({ scene, docId, beatId, onStateChange = null } = {}) {
    if (!scene?.id || !docId || !beatId) return [];
    const captures = supersedeStoryArchiveCapturesForBeat(docId, beatId);
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
        return updateCapture(docId, capture.id, { status: 'applied', transactionId: recovered.id, error: '', appliedAt: new Date().toISOString() }, onStateChange);
    }

    await undoSupersededBeatCaptures(docId, capture);
    capture = updateCapture(docId, capture.id, {
        status: 'processing',
        attempts: capture.attempts + 1,
        error: '',
    }, onStateChange);

    const archiveState = buildNarratorArchivistSections(scene.timelineId, scene.id);
    const selectedRecipe = getPromptStudioRecipe(scene.promptRecipeIds?.loom);
    const recipe = selectedRecipe?.mode === 'loom' && selectedRecipe?.apiType === 'chat'
        ? selectedRecipe
        : getStoryArchivePromptStudioRecipe();
    const prompt = buildStoryArchivePrompt({ passage: capture.text, archiveState, recipe });
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
        const parsed = parseLoomReply(raw);
        const requests = parsed.requests.filter((request) => STORY_ARCHIVE_CAPABILITY_SET.has(request?.capability));
        if (!replyShape.fenceParsed) {
            throw new Error('The Story Loom returned no readable state fence for this accepted passage.');
        }
        if (parsed.requests.length && !requests.length) {
            throw new Error('The Story Loom returned only operations disabled for Story Archive capture.');
        }
        if (!requests.length) {
            const applied = updateCapture(docId, capture.id, {
                status: 'applied',
                transactionId: null,
                error: '',
                appliedAt: new Date().toISOString(),
            }, onStateChange);
            recordDebugEvent('story-archive', 'capture.noop', captureReceipt(scene, docId, applied), {
                correlationId,
                summary: 'Story passage required no changes to the shared Loom Archive',
            });
            return applied;
        }
        const result = executeMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests }, {
            timelineId: scene.timelineId,
            sceneId: scene.id,
            turnId: capture.generationId || capture.id,
            directionId: correlationId,
            checkpointId: capture.id,
            variableRefs: new Map(),
            goalRefs: new Map(),
        });
        if (!result.ok) throw new Error((result.errors || []).join(' ') || 'The Archive transaction was rejected.');
        const applied = updateCapture(docId, capture.id, {
            status: 'applied',
            transactionId: result.transaction?.id || null,
            error: '',
            appliedAt: new Date().toISOString(),
        }, onStateChange);
        recordDebugEvent('story-archive', 'capture.applied', {
            ...captureReceipt(scene, docId, applied),
            requestCount: requests.length,
            transactionId: result.transaction?.id || null,
        }, { correlationId, summary: `Story passage added ${requests.length} operation(s) to the shared Loom Archive` });
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
    return `[ARCHIVE OPERATIONS â€” the only capabilities enabled in this pass]\n${guide}`;
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
        docId: String(docId || ''),
        captureId: capture?.id || null,
        origin: capture?.origin || null,
        bodyRevision: capture?.bodyRevision ?? null,
        sourceSpan: capture ? { start: capture.start, end: capture.end } : null,
        contentHash: capture?.contentHash || null,
        status: capture?.status || null,
        attempts: capture?.attempts || 0,
    };
}
