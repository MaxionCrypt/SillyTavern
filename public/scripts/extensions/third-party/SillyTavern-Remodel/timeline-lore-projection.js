import { getContext } from '../../../st-context.js';
import { registerArchiveConsequenceSubscriber, setArchiveConsequenceSubscriberEnabled } from './archive-consequences.js';
import { recordApiTranscript, recordDebugEvent } from './debug-console.js';
import { queueLivingLoreProposals } from './living-lore-mutations.js';
import { formatLivingLorePacket } from './living-lore-proposals.js';
import { buildLoomRecipeSources, describeLoomReply, parseLoomReply } from './loom-reconciliation.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe, getPromptStudioRecipe, getStoryArchivePromptStudioRecipe, recordSentPromptTranscript } from './prompt-studio.js';
import { streamChatPrompt } from './story-stream.js';
import { promotionEvidence } from './world-sense-promotion.js';
import { resolveWorldSense } from './world-sense-runtime.js';
import { getWorldSenseProfile, saveWorldSensePromotionDecisionReceipt, saveWorldSenseProposalRejections } from './world-sense-store.js';

export const TIMELINE_LORE_PROJECTION_PROTOCOL = 'remodel/timeline-lore-projection/1';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'timelineLoreProjectionV1';
const PROJECTION_TIMEOUT_MS = 60_000;
const LORE_POLICY = `You are the Loom's downstream Living Lore curator. The Archive transaction has already committed and the accepted prose is canonical. Judge only whether that evidence warrants a durable lore proposal or typed lore link against the supplied World Sense packet.

Do not narrate, rewrite prose, repeat Archive operations, create Goals or Variables, roll, or directly mutate lore. Most turns correctly produce no proposal. Every proposal remains review-only in this pipeline.`;
const LORE_CONTRACT = `Output NOTHING except one state fence:
\`\`\`state
{"requests":[],"loreProposals":[],"lorePromotionDecisions":[]}
\`\`\`

Use only the proposal operations, targets, revisions, evidence, and promotion candidate ids advertised in Selected Living Lore. Keep requests empty.`;

export function createTimelineLoreProjector({
    resolve = resolveWorldSense,
    transport = productionTransport,
    queue = queueLivingLoreProposals,
    schedule = (task) => setTimeout(task, 0),
    profile = getWorldSenseProfile,
} = {}) {
    const jobs = new Map();

    function enqueue(event) {
        const jobId = `lore-projection:${String(event?.eventId || '')}`;
        const existing = jobs.get(jobId);
        if (existing) return publicReceipt(existing);
        let finish;
        const completion = new Promise((resolveCompletion) => { finish = resolveCompletion; });
        const job = { jobId, eventId: String(event?.eventId || ''), status: 'queued', result: null, error: '', promise: null, completion, finish };
        jobs.set(jobId, job);
        schedule(() => {
            if (job.promise) return;
            job.status = 'running';
            job.promise = project(event)
                .then((result) => { job.status = result.status === 'failed-open' ? 'degraded' : 'succeeded'; job.result = result; return result; })
                .catch((error) => {
                    job.status = 'failed';
                    job.error = String(error?.message || error);
                    return { protocol: TIMELINE_LORE_PROJECTION_PROTOCOL, status: 'failed', error: job.error };
                })
                .finally(() => job.finish());
        });
        return publicReceipt(job);
    }

    async function project(event) {
        const scene = { id: event.sceneId, timelineId: event.timelineId, mode: event.mode };
        let worldSense = null;
        try {
            worldSense = await resolve(scene, { action: event.evidence?.acceptedProse || '' });
        } catch (error) {
            return projectionResult(event, { status: 'failed-open', degraded: true, error: String(error?.message || error) });
        }
        const packet = worldSense?.loomPacket || null;
        const worldProfile = profile() || {};
        if (!packet?.book || ['off', 'observe'].includes(worldProfile.mode)) {
            return projectionResult(event, {
                status: 'no-op', worldSenseReceiptId: worldSense?.receipt?.id || null,
                degraded: Boolean(worldSense?.degraded), error: worldSense?.error || '',
            });
        }
        const hasSelectedLore = Array.isArray(packet.entries) && packet.entries.length > 0;
        const hasPromotions = Array.isArray(packet.promotion?.candidates) && packet.promotion.candidates.length > 0;
        if (!hasSelectedLore && !hasPromotions) {
            return projectionResult(event, {
                status: 'no-op', worldSenseReceiptId: worldSense?.receipt?.id || null,
                degraded: Boolean(worldSense?.degraded), error: worldSense?.error || '',
            });
        }

        const prompt = compileTimelineLorePrompt(event, packet);
        recordSentPromptTranscript('loom', {
            recipeName: `${prompt.recipeName} · Living Lore`, messages: prompt.messages,
            request: { prompt: prompt.messages, transport: 'chat', purpose: 'timeline-lore-projection' }, transport: 'chat',
        });
        const response = await transport({ event, messages: prompt.messages, routeSnapshot: event.projection?.routeSnapshot || {} });
        const raw = typeof response === 'string' ? response : String(response?.text || '');
        recordApiTranscript('response', {
            mode: 'loom', purpose: 'timeline-lore-projection', text: raw,
            reasoning: typeof response === 'object' ? String(response?.reasoning || '') : '',
            streamed: typeof response === 'object' ? Boolean(response?.streamed) : false,
        }, { type: 'api.response.loom', correlationId: event.eventId, summary: 'Living Lore projection response received' });
        const reply = describeLoomReply(raw);
        if (!reply.fenceParsed) throw new Error('Living Lore projection returned no readable state fence.');
        const parsed = parseLoomReply(raw, { livingLorePacket: packet });
        if (packet.promotion?.candidates?.length) {
            saveWorldSensePromotionDecisionReceipt(worldSense?.receipt?.id, {
                decisions: parsed.lorePromotionDecisions || [], rejections: parsed.lorePromotionDecisionRejections || [],
            });
        }
        const queued = await queue({
            timelineId: event.timelineId,
            packet,
            proposals: parsed.loreProposals || [],
            acceptedProse: event.evidence?.acceptedProse || '',
            archiveFacts: event.evidence?.archiveFacts || [],
            promotionFacts: promotionEvidence(packet.promotion),
            automationModeOverride: 'suggest',
            source: {
                authority: 'accepted-fiction', stage: 'archive-settlement',
                directionId: event.eventId, sceneId: event.sceneId,
                messageId: event.provenance?.messageId, archiveJobId: event.jobId,
                archiveTransactionId: event.baseArchive?.transactionId || null,
                worldSenseReceiptId: worldSense?.receipt?.id || null,
            },
        });
        const rejections = [...(parsed.loreProposalRejections || []), ...(queued.rejected || [])];
        if (rejections.length) saveWorldSenseProposalRejections({
            timelineId: event.timelineId, sceneId: event.sceneId, directionId: event.eventId,
            phase: 'archive-settlement', rejected: rejections,
        });
        return projectionResult(event, {
            status: 'succeeded', worldSenseReceiptId: worldSense?.receipt?.id || null,
            degraded: Boolean(worldSense?.degraded), error: worldSense?.error || '',
            proposed: parsed.loreProposals?.length || 0,
            queued: queued.queued?.map((record) => record.id) || [],
            rejected: rejections.map((item) => ({ index: item.index, code: item.code })),
            promotionDecisions: parsed.lorePromotionDecisions?.length || 0,
            typedLinks: (parsed.loreProposals || []).filter((proposal) => proposal.operation === 'entry.link').length,
            automation: 'review-only',
        });
    }

    function status(eventId) {
        const job = jobs.get(`lore-projection:${String(eventId || '')}`);
        return job ? publicReceipt(job) : null;
    }

    async function wait(eventId) {
        const job = jobs.get(`lore-projection:${String(eventId || '')}`);
        if (!job) return null;
        await job.completion;
        return publicReceipt(job);
    }

    return Object.freeze({ enqueue, project, status, wait });
}

export function getTimelineLoreProjectionEnabled() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    const stored = context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY];
    if (!stored || typeof stored !== 'object') context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = { enabled: true };
    return context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY].enabled !== false;
}

export function setTimelineLoreProjectionEnabled(value) {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    context.extensionSettings[SETTINGS_NAMESPACE][SETTINGS_KEY] = { enabled: value === true };
    setArchiveConsequenceSubscriberEnabled('lore', value === true);
    context.saveSettingsDebounced?.();
    return value === true;
}

let registered = false;
export function ensureTimelineLoreProjectionRegistered() {
    if (registered) return;
    registered = true;
    const projector = createTimelineLoreProjector();
    registerArchiveConsequenceSubscriber('lore', (event) => {
        const receipt = projector.enqueue(event);
        recordDebugEvent('living-lore', 'projection.queued', receipt, {
            correlationId: event.eventId, summary: 'Committed Archive evidence queued for World Sense and Living Lore',
        });
        projector.wait(event.eventId).then((settled) => {
            recordDebugEvent('living-lore', 'projection.settled', settled, {
                correlationId: event.eventId,
                severity: ['failed', 'degraded'].includes(settled?.status) ? 'warn' : 'info',
                summary: settled?.status === 'succeeded' ? 'Living Lore projection settled' : `Living Lore projection ${settled?.status || 'finished'}`,
            });
        }).catch(() => {});
        return receipt;
    }, { enabled: getTimelineLoreProjectionEnabled() });
}

export function compileTimelineLorePrompt(event, packet) {
    const recipe = getPromptStudioRecipe(event.projection?.recipeId)
        || (event.mode === 'story' ? getStoryArchivePromptStudioRecipe() : getCurrentPromptStudioRecipe('loom', 'chat'));
    const lore = formatLivingLorePacket(packet);
    const sources = buildLoomRecipeSources({
        draft: event.evidence?.acceptedProse || '', playerAction: '',
        narrativeState: (event.evidence?.archiveFacts || []).join('\n'), mechanicsSkill: '', livingLore: lore,
    });
    sources.narratorDraft = `Accepted canonical prose (evidence only):\n${String(event.evidence?.acceptedProse || '').trim()}`;
    sources.livingLore = lore;
    const messages = [...compilePromptRecipe(recipe, sources).messages];
    ensureMessage(messages, LORE_POLICY, 'system', true);
    ensureMessage(messages, lore, 'system');
    ensureMessage(messages, sources.narratorDraft, 'user');
    ensureMessage(messages, LORE_CONTRACT, 'system');
    return { recipeId: String(recipe?.id || ''), recipeName: String(recipe?.name || 'Loom'), messages };
}

async function productionTransport({ messages, routeSnapshot }) {
    const profileId = String(routeSnapshot?.profileId || '').trim();
    if (!profileId) throw new Error('Living Lore projection has no frozen Loom connection profile.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeline-lore-projection-timeout'), PROJECTION_TIMEOUT_MS);
    try {
        return await streamChatPrompt({ prompt: messages, profileId, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function projectionResult(event, patch = {}) {
    return {
        protocol: TIMELINE_LORE_PROJECTION_PROTOCOL,
        eventId: String(event?.eventId || ''), timelineId: String(event?.timelineId || ''), sceneId: String(event?.sceneId || ''),
        status: 'no-op', worldSenseReceiptId: null, degraded: false, error: '', proposed: 0, queued: [], rejected: [],
        promotionDecisions: 0, typedLinks: 0, automation: 'review-only', ...patch,
    };
}

function publicReceipt(job) {
    return {
        protocol: TIMELINE_LORE_PROJECTION_PROTOCOL,
        jobId: job.jobId, eventId: job.eventId, status: job.status,
        ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
    };
}

function ensureMessage(messages, content, role, prepend = false) {
    const text = String(content || '').trim();
    if (!text || messages.some((message) => String(message?.content || '').includes(text))) return;
    const entry = { role, content: text };
    if (prepend) messages.unshift(entry);
    else messages.push(entry);
}
