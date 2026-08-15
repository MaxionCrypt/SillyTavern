import { getRequestHeaders } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getStringHash } from '../../../utils.js';
import { WebLlmVectorProvider } from '../../vectors/webllm.js';
import { listLoreEntries } from './variables-lore.js';
import { getVariableValue, getVectorIndexState, listVariableValues, updateVectorIndexState } from './variables-store.js';

const webllm = new WebLlmVectorProvider();
const SUPPORTED_SOURCES = new Set([
    'transformers', 'extras', 'openai', 'openrouter', 'electronhub', 'togetherai', 'cohere',
    'mistral', 'nomicai', 'palm', 'vertexai', 'chutes', 'nanogpt', 'siliconflow', 'workers_ai', 'webllm',
]);

export async function ensureVariableVectorIndex(timelineId, { force = false } = {}) {
    const state = getVectorIndexState(timelineId);
    if (!force && !state.dirty && !state.deleted) return { ok: !state.degraded, state };
    const source = vectorSettings().source || 'transformers';
    if (!SUPPORTED_SOURCES.has(source)) return degrade(timelineId, `Vector source “${source}” is not available to Remodel; deterministic retrieval is active.`);
    try {
        if (state.deleted) {
            await vectorRequest('/api/vector/purge', { collectionId: state.collectionId }, source);
            updateVectorIndexState(timelineId, { deleted: false, dirty: false, degraded: false, hashes: {}, error: '' });
            return { ok: true, state: getVectorIndexState(timelineId) };
        }
        const documents = await buildVariableDocuments(timelineId);
        const desired = Object.fromEntries(documents.map((document) => [String(document.hash), document.metadata]));
        const saved = await vectorRequest('/api/vector/list', { collectionId: state.collectionId }, source);
        const savedHashes = new Set((Array.isArray(saved) ? saved : []).map(String));
        const desiredHashes = new Set(Object.keys(desired));
        const remove = [...savedHashes].filter((hash) => !desiredHashes.has(hash)).map(Number);
        const insert = documents.filter((document) => !savedHashes.has(String(document.hash))).map(({ hash, text }) => ({ hash, text }));
        if (remove.length) await vectorRequest('/api/vector/delete', { collectionId: state.collectionId, hashes: remove }, source);
        if (insert.length) await vectorRequest('/api/vector/insert', { collectionId: state.collectionId, items: insert }, source, insert.map((item) => item.text));
        updateVectorIndexState(timelineId, { dirty: false, deleted: false, degraded: false, error: '', source, hashes: desired, indexedAt: new Date().toISOString() });
        return { ok: true, state: getVectorIndexState(timelineId), inserted: insert.length, removed: remove.length };
    } catch (error) {
        return degrade(timelineId, String(error?.message || error));
    }
}

export async function queryVariableVectors(timelineId, searchText, topK = 20) {
    const indexed = await ensureVariableVectorIndex(timelineId);
    if (!indexed.ok) return { ok: false, degraded: true, error: indexed.state.error || 'Vector retrieval unavailable.', matches: [] };
    const state = getVectorIndexState(timelineId);
    const source = vectorSettings().source || 'transformers';
    try {
        const result = await vectorRequest('/api/vector/query', {
            collectionId: state.collectionId,
            searchText: String(searchText || ''), topK: Math.max(1, Math.min(50, Number(topK) || 20)), threshold: 0,
        }, source, [String(searchText || '')]);
        const hashes = Array.isArray(result?.hashes) ? result.hashes : [];
        const metadata = Array.isArray(result?.metadata) ? result.metadata : [];
        const matches = hashes.map((hash, index) => ({
            hash: Number(hash), ...(state.hashes?.[String(hash)] || {}),
            score: vectorScore(metadata[index], index, hashes.length), rawMetadata: metadata[index] || null,
        })).filter((item) => item.variableId && getVariableValue(item.variableId, timelineId));
        return { ok: true, degraded: false, matches };
    } catch (error) {
        const degraded = degrade(timelineId, String(error?.message || error));
        return { ok: false, degraded: true, error: degraded.state.error, matches: [] };
    }
}

export async function purgeVariableVectorIndex(timelineId) {
    const state = getVectorIndexState(timelineId);
    const source = vectorSettings().source || 'transformers';
    try {
        await vectorRequest('/api/vector/purge', { collectionId: state.collectionId }, source);
        updateVectorIndexState(timelineId, { hashes: {}, dirty: false, deleted: false, degraded: false, error: '' });
        return true;
    } catch {
        updateVectorIndexState(timelineId, { hashes: {}, dirty: true, deleted: true });
        return false;
    }
}

export async function buildVariableDocuments(timelineId) {
    const lore = await listLoreEntries();
    const byKey = new Map(lore.map((entry) => [`${entry.book}.${entry.uid}`, entry]));
    const documents = [];
    for (const variable of listVariableValues({ timelineId })) {
        documents.push(documentFor(variable, 'self', '', `VARIABLE: ${variable.name}\nMEANING: ${variable.description}`));
        for (const link of variable.loreLinks) {
            const key = `${link.book}.${link.uid}`;
            const entry = byKey.get(key);
            const entryText = entry
                ? `ENTRY: ${entry.name}\nKEYS: ${[...entry.keys, ...entry.secondaryKeys].join(', ')}\nLORE: ${entry.content}`
                : `UNRESOLVED ENTRY: ${link.book} #${link.uid}`;
            documents.push(documentFor(variable, 'link', key, `VARIABLE: ${variable.name}\nMEANING: ${variable.description}\nLINK: ${link.hint}\n${entryText}`));
        }
    }
    return documents;
}

function documentFor(variable, channel, loreKey, text) {
    const stable = `${variable.id}\n${channel}\n${loreKey}\n${text}`;
    return { hash: getStringHash(stable), text, metadata: { variableId: variable.id, channel, loreKey } };
}

async function vectorRequest(path, input, source, texts = []) {
    const settings = vectorSettings();
    const additional = {};
    if (source === 'webllm') {
        const model = settings.webllm_model;
        if (!model) throw new Error('WebLLM embedding model is not configured.');
        const vectors = texts.length ? await webllm.embedTexts(texts, model) : [];
        additional.model = model;
        additional.embeddings = Object.fromEntries(texts.map((text, index) => [text, vectors[index]]));
    }
    const body = { ...providerOptions(source, settings), ...additional, ...input, source };
    const response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Vector request failed (${response.status}) at ${path}.`);
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    return contentType.includes('application/json') ? response.json() : response.text();
}

function providerOptions(source, settings) {
    const modelKey = `${source}_model`;
    const options = {};
    if (settings[modelKey]) options.model = settings[modelKey];
    if (source === 'extras') {
        const root = extension_settings;
        options.extrasUrl = root.apiUrl;
        options.extrasKey = root.apiKey;
    }
    return options;
}

function vectorSettings() { return extension_settings.vectors || {}; }
// SillyTavern's vector endpoint currently returns ranked hashes but omits the
// backend similarity score from metadata. Prefer a score when a provider adds
// one; otherwise use a conservative rank proxy so vectors remain candidate
// recall while native activation/corroboration stays authoritative.
function vectorScore(metadata, index, total) {
    const score = Number(metadata?.score ?? metadata?.similarity);
    if (Number.isFinite(score)) return score;
    if (!total) return 0;
    return Math.max(0.7, 0.84 - (index / Math.max(1, total - 1)) * 0.14);
}
function degrade(timelineId, error) { updateVectorIndexState(timelineId, { degraded: true, error, dirty: true }); return { ok: false, state: getVectorIndexState(timelineId) }; }
