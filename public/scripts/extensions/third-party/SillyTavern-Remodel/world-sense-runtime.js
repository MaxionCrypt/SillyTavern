import { listCharStates, listEvents, listSceneFacts, getBeat } from './archivist-store.js';
import { listLivingLoreMetadata } from './living-lore-store.js';
import { getSceneGoals } from './story-goals-store.js';
import { getTimelineStore } from './timeline-state.js';
import { listVariableValues } from './variables-store.js';
import { recordDebugEvent } from './debug-console.js';
import { queryWorldSense } from './world-sense-embeddings.js';
import { loadTimelineLore } from './world-sense-lore.js';
import { buildWorldSenseQueryPacket, canReuseWorldSensePrefetch, rankLivingLore } from './world-sense-retrieval.js';
import {
    getWorldSenseContinuity,
    getWorldSenseIndexState,
    getWorldSenseProfile,
    saveWorldSenseReceipt,
} from './world-sense-store.js';

const prefetches = new Map();
const prefetchTimers = new Map();
const PREFETCH_DELAY_MS = 350;
const PREFETCH_TTL_MS = 120000;

export function scheduleWorldSensePrefetch(scene, options = {}) {
    const sceneId = String(scene?.id || '');
    clearTimeout(prefetchTimers.get(sceneId));
    prefetchTimers.delete(sceneId);
    if (!sceneId || !String(options.action || '').trim()) return;
    const timer = setTimeout(() => {
        prefetchTimers.delete(sceneId);
        prefetchWorldSense(scene, options).catch(() => {});
    }, PREFETCH_DELAY_MS);
    prefetchTimers.set(sceneId, timer);
}

export async function prefetchWorldSense(scene, options = {}) {
    const prepared = prepareQuery(scene, options);
    if (!prepared) return null;
    const existing = prefetches.get(prepared.sceneId);
    if (canReuseWorldSensePrefetch(existing, prepared.packet.hash, Date.now(), PREFETCH_TTL_MS)) return existing.promise;
    const promise = executeRetrieval(scene, prepared, { phase: 'prefetch' });
    prefetches.set(prepared.sceneId, { queryHash: prepared.packet.hash, createdAt: Date.now(), promise });
    const result = await promise;
    const current = prefetches.get(prepared.sceneId);
    if (current?.promise === promise) current.result = result;
    return result;
}

export async function resolveWorldSense(scene, options = {}) {
    const prepared = prepareQuery(scene, options);
    if (!prepared) return null;
    const cached = prefetches.get(prepared.sceneId);
    let result = null;
    let reusedPrefetch = false;
    let prefetchTimedOut = false;
    if (canReuseWorldSensePrefetch(cached, prepared.packet.hash, Date.now(), PREFETCH_TTL_MS)) {
        try {
            const waitMs = Math.max(250, getWorldSenseProfile().warmQueryTargetMs * 2);
            result = cached.result || await withTimeout(cached.promise, waitMs, 'Composer prefetch was still warming the local model.');
            const currentLore = await loadTimelineLore(scene.timelineId);
            reusedPrefetch = Boolean(result && result.bookHash === currentLore.hash);
            if (!reusedPrefetch) result = null;
        } catch {
            prefetchTimedOut = true;
        }
    }
    if (!result) result = await executeRetrieval(scene, prepared, { phase: 'turn', skipSemantic: prefetchTimedOut });
    const receipt = saveReceipt(scene, result, { reusedPrefetch });
    prefetches.delete(prepared.sceneId);
    return { ...result, receipt };
}

function prepareQuery(scene, options) {
    if (!scene?.id || !scene?.timelineId) return null;
    const timeline = getTimelineStore().timelines[String(scene.timelineId)] || {};
    const goals = getSceneGoals(scene.id, { includeResolved: false, states: ['active', 'background'] });
    const facts = listSceneFacts(scene.timelineId, scene.id);
    const charStates = listCharStates(scene.timelineId, scene.id);
    const events = listEvents(scene.timelineId, scene.id).slice(-8);
    const beat = getBeat(scene.timelineId, scene.id);
    const archive = [
        ...facts,
        ...charStates,
        ...events.map((event) => ({ label: 'Event', summary: event.summary })),
    ];
    const location = facts.find((fact) => /location|place|where/i.test(fact.key))?.value || scene.location || '';
    const pins = Array.isArray(options.pins) ? options.pins : [];
    const packet = buildWorldSenseQueryPacket({
        action: options.action,
        openThread: beat?.directive || '',
        goals,
        history: options.history || [],
        archive,
        cast: [options.persona, ...(options.cast || [])].filter(Boolean),
        location,
        premise: timeline.premise || timeline.summary || scene.summary || '',
        searchTerms: options.searchTerms || [],
        pins,
    });
    return { sceneId: String(scene.id), goals, pins, packet };
}

async function executeRetrieval(scene, prepared, { phase, skipSemantic = false }) {
    const startedAt = performance.now();
    const lore = await loadTimelineLore(scene.timelineId);
    const profile = getWorldSenseProfile();
    let semantic = { ok: true, degraded: false, matches: [] };
    if (prepared.packet.text && !skipSemantic) {
        const timeoutMs = phase === 'prefetch' ? 20000 : Math.max(250, profile.warmQueryTargetMs * 2);
        try {
            semantic = await withTimeout(
                queryWorldSense(scene.timelineId, prepared.packet.text, { topK: Math.min(50, profile.maxEntries * 3), threshold: profile.semanticThreshold }),
                timeoutMs,
                'Local semantic retrieval exceeded the turn budget.',
            );
        } catch (error) {
            semantic = { ok: false, degraded: true, matches: [], error: String(error?.message || error) };
        }
    } else if (skipSemantic) {
        semantic = { ok: false, degraded: true, matches: [], error: 'Composer prefetch exceeded the turn budget; deterministic ranking continued immediately.' };
    }
    const metadata = listLivingLoreMetadata({ timelineId: scene.timelineId, book: lore.book || '' });
    const variables = listVariableValues({ timelineId: scene.timelineId });
    const ranking = rankLivingLore({
        packet: prepared.packet,
        entries: lore.entries,
        semanticMatches: semantic.matches || [],
        metadata,
        goals: prepared.goals,
        variables,
        pins: prepared.pins,
        continuity: getWorldSenseContinuity(scene.id),
        budget: { maxEntries: profile.maxEntries, maxTokens: profile.maxTokens },
        semanticThreshold: profile.semanticThreshold,
        semanticOnlyLimit: profile.semanticOnlyLimit,
    });
    return {
        phase,
        sceneId: String(scene.id),
        timelineId: String(scene.timelineId),
        book: lore.book,
        bookHash: lore.hash,
        queryHash: prepared.packet.hash,
        queryLength: prepared.packet.length,
        modelId: profile.modelId,
        indexRevision: getWorldSenseIndexState(scene.timelineId)?.bookHash || '',
        degraded: Boolean(semantic.degraded),
        error: semantic.error || '',
        elapsedMs: Math.round(performance.now() - startedAt),
        ...ranking,
    };
}

function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
}

function saveReceipt(scene, result, { reusedPrefetch }) {
    const receipt = saveWorldSenseReceipt({
        id: `world-sense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        sceneId: String(scene.id),
        timelineId: String(scene.timelineId),
        book: result.book,
        bookHash: result.bookHash,
        queryHash: result.queryHash,
        queryLength: result.queryLength,
        modelId: result.modelId,
        indexRevision: result.indexRevision,
        elapsedMs: result.elapsedMs,
        reusedPrefetch,
        degraded: result.degraded,
        error: result.error,
        budget: result.budget,
        semanticPolicy: {
            threshold: getWorldSenseProfile().semanticThreshold,
            semanticOnlyLimit: getWorldSenseProfile().semanticOnlyLimit,
        },
        propagation: result.propagation,
        selected: result.selected,
        rejected: result.rejected,
    });
    try {
        recordDebugEvent('world-sense', 'retrieval.receipt', receipt, {
            severity: receipt.degraded ? 'warn' : 'info',
            correlationId: receipt.id,
            summary: `World Sense selected ${receipt.selected.length} of ${receipt.selected.length + receipt.rejected.length} lore entries${reusedPrefetch ? ' from composer prefetch' : ''}`,
        });
    } catch {
        // Retrieval is useful without Debug; diagnostics cannot break a turn.
    }
    return receipt;
}
