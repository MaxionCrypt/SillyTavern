import { getRequestHeaders } from '../../../../script.js';
import { loadTimelineLore } from './world-sense-lore.js';
import { getWorldSenseIndexState, getWorldSenseProfile, saveWorldSenseBenchmark, updateWorldSenseIndexState } from './world-sense-store.js';

const indexingByCollection = new Map();

export async function ensureWorldSenseIndex(timelineId, { force = false } = {}) {
    const packet = await loadTimelineLore(timelineId);
    const profile = getWorldSenseProfile();
    const state = getWorldSenseIndexState(timelineId);
    if (!packet.book) return unavailable(timelineId, 'This Timeline has no Living Lore book assigned.');
    const collectionId = collectionName(timelineId, profile.modelId);
    if (!force && state.status === 'ready' && state.bookHash === packet.hash && state.modelId === profile.modelId) return { ok: true, state };
    if (!force && indexingByCollection.has(collectionId)) return indexingByCollection.get(collectionId);
    const indexing = buildWorldSenseIndex(timelineId, packet, profile, collectionId);
    indexingByCollection.set(collectionId, indexing);
    try {
        return await indexing;
    } finally {
        if (indexingByCollection.get(collectionId) === indexing) indexingByCollection.delete(collectionId);
    }
}

async function buildWorldSenseIndex(timelineId, packet, profile, collectionId) {
    updateWorldSenseIndexState(timelineId, { status: 'indexing', error: '', collectionId, modelId: profile.modelId });
    try {
        const documents = packet.entries.filter((entry) => !entry.native.disable).map(documentFor);
        const desired = Object.fromEntries(documents.map((document) => [String(document.hash), document.metadata]));
        const saved = await vectorRequest('/api/vector/list', { collectionId }, profile.modelId);
        const savedHashes = new Set((Array.isArray(saved) ? saved : []).map(String));
        const desiredHashes = new Set(Object.keys(desired));
        const remove = [...savedHashes].filter((hash) => !desiredHashes.has(hash)).map(Number);
        const insert = documents.filter((document) => !savedHashes.has(String(document.hash))).map(({ hash, text }) => ({ hash, text }));
        if (remove.length) await vectorRequest('/api/vector/delete', { collectionId, hashes: remove }, profile.modelId);
        if (insert.length) await vectorRequest('/api/vector/insert', { collectionId, items: insert }, profile.modelId);
        const ready = updateWorldSenseIndexState(timelineId, {
            status: 'ready', error: '', book: packet.book, bookHash: packet.hash, hashes: desired,
            inserted: insert.length, removed: remove.length, indexedAt: new Date().toISOString(),
        });
        return { ok: true, state: ready, inserted: insert.length, removed: remove.length };
    } catch (error) {
        return unavailable(timelineId, String(error?.message || error));
    }
}

export async function queryWorldSense(timelineId, searchText, { topK = 12, threshold = 0.25 } = {}) {
    const indexed = await ensureWorldSenseIndex(timelineId);
    if (!indexed.ok) return { ok: false, degraded: true, status: 'unavailable', error: indexed.state.error, matches: [] };
    const state = getWorldSenseIndexState(timelineId);
    try {
        const result = await vectorRequest('/api/vector/query', {
            collectionId: state.collectionId, searchText: String(searchText || ''),
            topK: Math.max(1, Math.min(50, Number(topK) || 12)), threshold: Number(threshold) || 0,
        }, state.modelId);
        const matches = (Array.isArray(result?.metadata) ? result.metadata : [])
            .map((item, rank) => ({ ...state.hashes[String(item?.hash)], rank }))
            .filter((item) => item.book && item.uid);
        return { ok: true, degraded: false, status: 'ready', matches };
    } catch (error) {
        const degraded = unavailable(timelineId, String(error?.message || error));
        return { ok: false, degraded: true, status: 'unavailable', error: degraded.state.error, matches: [] };
    }
}

export async function benchmarkWorldSense(timelineId) {
    const packet = await loadTimelineLore(timelineId);
    const profile = getWorldSenseProfile();
    if (!packet.book || !packet.entries.length) return saveWorldSenseBenchmark({ ok: false, at: new Date().toISOString(), modelId: profile.modelId, error: 'Assign a non-empty Timeline lorebook before benchmarking.' });
    const entries = packet.entries.filter((entry) => !entry.native.disable).slice(0, profile.supportedBookSize);
    const body = { source: 'transformers', model: profile.modelId, texts: entries.map((entry) => documentFor(entry).text), queries: representativeQueries(entries) };
    try {
        const response = await fetch('/api/vector/benchmark', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Benchmark request failed (${response.status}).`);
        const measured = await response.json();
        return saveWorldSenseBenchmark({ ...measured, ok: true, at: new Date().toISOString(), book: packet.book, entryCount: entries.length, targetMs: profile.warmQueryTargetMs, accepted: measured.warmQueryP95Ms <= profile.warmQueryTargetMs });
    } catch (error) {
        return saveWorldSenseBenchmark({ ok: false, at: new Date().toISOString(), modelId: profile.modelId, error: String(error?.message || error) });
    }
}

function documentFor(entry) {
    const text = `ENTRY: ${entry.name}\nKEYS: ${[...entry.keys, ...entry.secondaryKeys].join(', ')}\nLORE: ${entry.content}`;
    const hash = Number.parseInt(entry.hash.slice(-8), 16) >>> 0;
    return { hash, text, metadata: { hash, book: entry.book, uid: entry.uid, entryHash: entry.hash } };
}

function representativeQueries(entries) {
    const samples = entries.slice(0, 5).map((entry) => [entry.name, ...entry.keys].filter(Boolean).join(' '));
    return samples.length ? samples : ['current location', 'active character', 'unresolved situation'];
}

async function vectorRequest(path, input, model) {
    const response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ...input, source: 'transformers', model }) });
    if (!response.ok) throw new Error(`Local embedding request failed (${response.status}) at ${path}.`);
    if (response.status === 204) return null;
    return response.json();
}

function collectionName(timelineId, model) {
    const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `remodel-world-sense-${safe(timelineId)}-${safe(model)}`;
}

function unavailable(timelineId, error) {
    return { ok: false, state: updateWorldSenseIndexState(timelineId, { status: 'unavailable', error }) };
}
