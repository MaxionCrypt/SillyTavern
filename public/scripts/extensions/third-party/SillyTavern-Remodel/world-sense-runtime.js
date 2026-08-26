import { listCharStates, listEvents, listSceneFacts, getBeat } from './archivist-store.js';
import { listLivingLoreMetadata } from './living-lore-store.js';
import { getTimelineGoals } from './story-goals-store.js';
import { getTimelineStore } from './timeline-state.js';
import { listVariableValues } from './variables-store.js';
import { recordDebugEvent } from './debug-console.js';
import { buildLivingLorePacket } from './living-lore-proposals.js';
import { queryWorldSense } from './world-sense-embeddings.js';
import { loadTimelineLore } from './world-sense-lore.js';
import {
    buildWorldSenseQueryPacket,
    canReuseWorldSensePrefetch,
    scoreLivingLoreCandidates,
    selectWorldSenseCandidates,
} from './world-sense-retrieval.js';
import { buildTimelineContinuityDocuments, scoreTimelineContinuityCandidates } from './world-sense-continuity.js';
import {
    getWorldSenseContinuity,
    getWorldSenseIndexState,
    getWorldSenseProfile,
    saveWorldSenseReceipt,
} from './world-sense-store.js';

const prefetches = new Map();
const prefetchTimers = new Map();
const turnOverrides = new Map();
const PREFETCH_DELAY_MS = 350;
const PREFETCH_TTL_MS = 120000;

export function setWorldSenseTurnOverride(sceneId, ref, disposition = '') {
    const id = String(sceneId || '').trim();
    const key = loreKey(ref);
    if (!id || !key) return false;
    const current = turnOverrides.get(id) || { pins: new Map(), excludes: new Map() };
    current.pins.delete(key);
    current.excludes.delete(key);
    if (disposition === 'pin') current.pins.set(key, { book: String(ref.book), uid: String(ref.uid), name: String(ref.name || '') });
    if (disposition === 'exclude') current.excludes.set(key, { book: String(ref.book), uid: String(ref.uid), name: String(ref.name || '') });
    if (current.pins.size || current.excludes.size) turnOverrides.set(id, current);
    else turnOverrides.delete(id);
    prefetches.delete(id);
    return true;
}

export function getWorldSenseTurnOverrides(sceneId) {
    const current = turnOverrides.get(String(sceneId || ''));
    return {
        pins: [...(current?.pins?.values() || [])].map((item) => ({ ...item })),
        excludes: [...(current?.excludes?.values() || [])].map((item) => ({ ...item })),
    };
}

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
    return resolveWorldSenseForPhase(scene, options, { persist: true, consumePrefetch: true });
}

/** Preview shares the exact resolver and composer cache, but cannot create a
 * receipt, advance continuity, or consume the prefetched result Send may use. */
export async function previewWorldSense(scene, options = {}) {
    return resolveWorldSenseForPhase(scene, options, { persist: false, consumePrefetch: false });
}

async function resolveWorldSenseForPhase(scene, options, { persist, consumePrefetch }) {
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
            const currentContinuity = buildTimelineContinuityDocuments(scene.timelineId);
            reusedPrefetch = Boolean(result && result.bookHash === currentLore.hash && result.archiveHash === currentContinuity.hash);
            if (!reusedPrefetch) result = null;
        } catch {
            prefetchTimedOut = true;
        }
    }
    if (!result) result = await executeRetrieval(scene, prepared, { phase: 'turn', skipSemantic: prefetchTimedOut });
    const receipt = persist ? saveReceipt(scene, result, { reusedPrefetch }) : null;
    if (consumePrefetch) {
        prefetches.delete(prepared.sceneId);
        turnOverrides.delete(prepared.sceneId);
    }
    return { ...result, receipt, reusedPrefetch };
}

function prepareQuery(scene, options) {
    if (!scene?.id || !scene?.timelineId) return null;
    const timeline = getTimelineStore().timelines[String(scene.timelineId)] || {};
    // Goals are Timeline Web records. Scene links influence presentation, but
    // cannot be the retrieval boundary: a Goal established in Story must be
    // able to follow its linked lore into a later Roleplay Scene without being
    // copied into that Scene first.
    const goals = getTimelineGoals(scene.timelineId, { includeResolved: false });
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
    const overrides = getWorldSenseTurnOverrides(scene.id);
    const pins = [...(Array.isArray(options.pins) ? options.pins : []), ...overrides.pins];
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
    return { sceneId: String(scene.id), goals, pins, excludes: overrides.excludes, packet };
}

async function executeRetrieval(scene, prepared, { phase, skipSemantic = false }) {
    const startedAt = performance.now();
    const lore = await loadTimelineLore(scene.timelineId);
    const profile = getWorldSenseProfile();
    if (profile.mode === 'off') {
        const metadata = listLivingLoreMetadata({ timelineId: scene.timelineId, book: lore.book || '' });
        return {
            phase,
            sceneId: String(scene.id),
            timelineId: String(scene.timelineId),
            book: lore.book,
            bookHash: lore.hash,
            archiveHash: buildTimelineContinuityDocuments(scene.timelineId).hash,
            queryHash: prepared.packet.hash,
            queryLength: prepared.packet.length,
            querySources: summarizeQuerySources(prepared.packet),
            modelId: profile.modelId,
            indexRevision: [getWorldSenseIndexState(scene.timelineId)?.bookHash, getWorldSenseIndexState(scene.timelineId)?.archiveHash].filter(Boolean).join(':'),
            degraded: false,
            error: '',
            elapsedMs: Math.round(performance.now() - startedAt),
            loomPacket: buildLivingLorePacket({ timelineId: scene.timelineId, book: lore.book, bookHash: lore.hash, entries: lore.entries, selected: [], metadata, limits: { maxEntries: 0 } }),
            selected: [],
            rejected: [],
            propagation: { goalIds: [], variableIds: [] },
            budget: { maxEntries: 0, maxTokens: 0, usedEntries: 0, usedTokens: 0, overflow: false },
        };
    }
    let semantic = { ok: true, degraded: false, matches: [], continuityMatches: [] };
    if (prepared.packet.text && !skipSemantic) {
        const timeoutMs = phase === 'prefetch' ? 20000 : Math.max(250, profile.warmQueryTargetMs * 2);
        try {
            semantic = await withTimeout(
                queryWorldSense(scene.timelineId, prepared.packet.text, { topK: Math.min(50, profile.maxEntries * 3), threshold: profile.semanticThreshold }),
                timeoutMs,
                'Local semantic retrieval exceeded the turn budget.',
            );
        } catch (error) {
            semantic = { ok: false, degraded: true, matches: [], continuityMatches: [], error: String(error?.message || error) };
        }
    } else if (skipSemantic) {
        semantic = { ok: false, degraded: true, matches: [], continuityMatches: [], error: 'Composer prefetch exceeded the turn budget; deterministic ranking continued immediately.' };
    }
    const metadata = listLivingLoreMetadata({ timelineId: scene.timelineId, book: lore.book || '' });
    const variables = listVariableValues({ timelineId: scene.timelineId });
    const loreCandidates = scoreLivingLoreCandidates({
        packet: prepared.packet,
        entries: lore.entries.filter((entry) => !prepared.excludes.some((excluded) => loreKey(excluded) === loreKey(entry))),
        semanticMatches: semantic.matches || [],
        metadata,
        goals: prepared.goals,
        variables,
        pins: prepared.pins,
        continuity: getWorldSenseContinuity(scene.id),
        semanticThreshold: profile.semanticThreshold,
    });
    const continuitySource = buildTimelineContinuityDocuments(scene.timelineId);
    const continuityCandidates = scoreTimelineContinuityCandidates({
        timelineId: scene.timelineId,
        sceneId: scene.id,
        packet: prepared.packet,
        records: continuitySource.records,
        semanticMatches: semantic.continuityMatches || [],
        semanticThreshold: profile.semanticThreshold,
    });
    const ranking = selectWorldSenseCandidates([...loreCandidates, ...continuityCandidates], {
        budget: { maxEntries: profile.maxEntries, maxTokens: profile.maxTokens },
        semanticOnlyLimit: profile.semanticOnlyLimit,
        continuityLimit: 4,
    });
    const selectedLore = ranking.selected.filter((item) => item.kind !== 'continuity');
    const selectedContinuity = ranking.selected.filter((item) => item.kind === 'continuity');
    const selectedLoreKeys = new Set(selectedLore.map(loreKey));
    const propagation = {
        goalIds: linkedIds(prepared.goals, selectedLoreKeys),
        variableIds: linkedIds(variables, selectedLoreKeys),
    };
    const loomPacket = buildLivingLorePacket({
        timelineId: scene.timelineId,
        book: lore.book,
        bookHash: lore.hash,
        entries: lore.entries,
        selected: selectedLore,
        metadata,
        limits: { maxEntries: profile.maxEntries },
    });
    return {
        phase,
        sceneId: String(scene.id),
        sceneMode: String(scene.mode || 'roleplay'),
        timelineId: String(scene.timelineId),
        book: lore.book,
        bookHash: lore.hash,
        archiveHash: continuitySource.hash,
        queryHash: prepared.packet.hash,
        queryLength: prepared.packet.length,
        querySources: summarizeQuerySources(prepared.packet),
        modelId: profile.modelId,
        indexRevision: [getWorldSenseIndexState(scene.timelineId)?.bookHash, getWorldSenseIndexState(scene.timelineId)?.archiveHash].filter(Boolean).join(':'),
        degraded: Boolean(semantic.degraded),
        error: semantic.error || '',
        elapsedMs: Math.round(performance.now() - startedAt),
        loomPacket,
        continuity: selectedContinuity,
        propagation,
        ...ranking,
    };
}

function linkedIds(records, selectedKeys) {
    return (records || []).filter((record) => (record.loreLinks || []).some((link) => selectedKeys.has(loreKey(link))))
        .map((record) => String(record.id || '')).filter(Boolean);
}

function loreKey(value) {
    const book = String(value?.book || '').trim();
    const uid = String(value?.uid ?? '').trim();
    return book && uid ? `${book}.${uid}` : '';
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
        sceneMode: String(scene.mode || 'roleplay'),
        timelineId: String(scene.timelineId),
        book: result.book,
        bookHash: result.bookHash,
        archiveHash: result.archiveHash,
        queryHash: result.queryHash,
        queryLength: result.queryLength,
        querySources: result.querySources || [],
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
        continuity: result.continuity || [],
        promptInclusion: describePromptInclusion(result.selected),
        selected: result.selected,
        rejected: result.rejected,
    });
    try {
        recordDebugEvent('world-sense', 'retrieval.receipt', receipt, {
            severity: receipt.degraded ? 'warn' : 'info',
            correlationId: receipt.id,
            summary: `World Sense selected ${receipt.selected.length} of ${receipt.selected.length + receipt.rejected.length} lore and continuity candidates${reusedPrefetch ? ' from composer prefetch' : ''}`,
        });
    } catch {
        // Retrieval is useful without Debug; diagnostics cannot break a turn.
    }
    return receipt;
}

function summarizeQuerySources(packet) {
    return (packet?.sources || []).map((source) => ({
        kind: String(source.kind || ''),
        label: String(source.label || ''),
        characters: String(source.text || '').length,
    }));
}

function describePromptInclusion(selected) {
    return (selected || []).map((item) => item?.kind === 'continuity'
        ? {
            kind: 'continuity', included: true,
            sourceSceneId: String(item.sceneId || ''),
            sourceSceneMode: String(item.sceneMode || ''),
            recordType: String(item.recordType || ''),
            recordId: String(item.recordId || ''),
            rankingReasons: (item.reasons || []).map((reason) => String(reason.channel || '')).filter(Boolean),
        }
        : {
            kind: 'lore', included: true,
            book: String(item?.book || ''), uid: String(item?.uid ?? ''), name: String(item?.name || ''),
            rankingReasons: (item?.reasons || []).map((reason) => String(reason.channel || '')).filter(Boolean),
        });
}
