import {
    getSceneContinuitySettings,
    listTimelineArchiveScenes,
} from './archivist-store.js';
import { getTimelineStore } from './timeline-state.js';

const STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'been', 'before', 'being', 'between', 'could', 'does', 'from', 'have',
    'into', 'just', 'more', 'most', 'only', 'other', 'over', 'said', 'should', 'some', 'than', 'that', 'their',
    'them', 'then', 'there', 'these', 'they', 'this', 'through', 'under', 'very', 'what', 'when', 'where',
    'which', 'while', 'with', 'would', 'your',
]);

/**
 * Build detached, provenance-rich Archive records for the Timeline's existing
 * World Sense vector collection. Secrets are deliberately absent: both the
 * Narrator and Loom receive recalled continuity through the Narrator-visible
 * Archive projection, so indexing a secret here would create a leak path.
 */
export function buildTimelineContinuityDocuments(timelineId) {
    const id = String(timelineId || '');
    const store = getTimelineStore();
    const timeline = store.timelines[id];
    if (!timeline) return { hash: hash64(''), records: [], documents: [] };
    const archiveScenes = listTimelineArchiveScenes(id);
    const archiveByScene = new Map(archiveScenes.map((scene) => [String(scene.sceneId), scene]));
    const records = [];
    let orderIndex = 0;
    for (let arcIndex = 0; arcIndex < (timeline.arcIds || []).length; arcIndex += 1) {
        const arc = store.arcs[timeline.arcIds[arcIndex]];
        if (!arc) continue;
        for (const sceneId of arc.sceneIds || []) {
            const scene = store.scenes[sceneId];
            if (!scene || scene.mode !== 'roleplay') continue;
            const archive = archiveByScene.get(String(scene.id));
            if (archive) records.push(...recordsForScene(archive, scene, arc, { arcIndex, orderIndex }));
            orderIndex += 1;
        }
    }
    const documents = records.map(documentFor);
    const controls = archiveScenes.map((scene) => `${scene.sceneId}:${JSON.stringify(scene.continuity)}`).sort().join('|');
    const hash = hash64(`${documents.map((item) => `${item.hash}:${item.metadata.key}`).join('|')}\n${controls}`);
    return { hash, records, documents };
}

/** Score eligible previous-Scene Archive records using the same query packet
 * that ranks lore. The shared selector in world-sense-retrieval.js applies the
 * final prompt budget across both candidate kinds. */
export function scoreTimelineContinuityCandidates({
    timelineId = '', sceneId = '', packet = null, records = [], semanticMatches = [], semanticThreshold = 0.30,
} = {}) {
    const targetId = String(sceneId || '');
    const target = records.find((record) => record.sceneId === targetId);
    const targetOrder = target?.orderIndex ?? sceneOrder(timelineId, targetId);
    if (targetOrder < 0) return [];
    const settings = getSceneContinuitySettings(timelineId, targetId);
    const excluded = new Set(settings.excludedSceneIds || []);
    const pinKeys = new Set((settings.pins || []).map(pinKey));
    const semanticByKey = new Map((semanticMatches || []).filter((item) => item?.kind === 'archive').map((item, index) => [
        String(item.key || archiveKey(item)),
        { ...item, rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : index },
    ]));
    const queryTokens = tokenize(packet?.text || '');
    const candidates = [];

    for (const record of records) {
        if (record.sceneId === targetId || record.orderIndex >= targetOrder) continue;
        const sourceSettings = getSceneContinuitySettings(timelineId, record.sceneId);
        const pinned = pinKeys.has(pinKey({ sourceSceneId: record.sceneId, recordType: record.recordType, recordId: record.recordId }));
        if (!sourceSettings.shareForward || excluded.has(record.sceneId)) continue;
        if (!settings.readPrevious && !pinned) continue;

        const candidate = {
            kind: 'continuity', key: record.key, record, score: 0, reasons: [], forced: false,
            tokenCost: Math.max(1, Math.ceil(`${record.arcTitle} ${record.sceneTitle} ${record.text}`.length / 4)),
        };
        if (pinned) add(candidate, 140, 'continuity.pin');
        candidate.forced = pinned;

        const semantic = semanticByKey.get(record.key);
        if (semantic) {
            const similarity = Number(semantic.score);
            if (!Number.isFinite(similarity) || similarity >= Number(semanticThreshold)) {
                const points = Number.isFinite(similarity) ? Math.max(12, Math.round(20 + similarity * 60)) : Math.max(12, 52 - semantic.rank * 3);
                add(candidate, points, 'continuity.semantic', { rank: semantic.rank, ...(Number.isFinite(similarity) ? { similarity } : {}) });
            }
        }
        const overlap = [...tokenize(record.text)].filter((word) => queryTokens.has(word));
        if (overlap.length) add(candidate, Math.min(45, 9 + (overlap.length - 1) * 6), 'continuity.keyword', { terms: overlap.slice(0, 8) });
        if (candidate.score > 0 && record.arcId === target?.arcId) add(candidate, 6, 'continuity.same-arc');
        if (candidate.score > 0 && record.orderIndex === targetOrder - 1) add(candidate, 8, 'continuity.previous-scene');
        if (candidate.score > 0 || candidate.forced) candidates.push(candidate);
    }
    return candidates;
}

function recordsForScene(archive, scene, arc, position) {
    const common = {
        sceneId: String(scene.id), sceneTitle: String(scene.title || 'Untitled Scene'), arcId: String(arc.id),
        arcTitle: String(arc.title || 'Untitled Arc'), ...position,
    };
    const events = (archive.events || []).filter((item) => String(item.summary || '').trim()).map((item) => record(common, 'event', item.id, item.summary));
    const facts = Object.values(archive.facts || {}).filter((item) => String(item.value ?? '').trim()).map((item) => record(common, 'fact', item.key, `${item.key}: ${item.value}`));
    const characters = Object.values(archive.charStates || {}).map((item) => {
        const facets = Object.entries(item.facets || {}).map(([key, value]) => `${key}: ${value}`).join(', ');
        return facets ? record(common, 'character', item.charId, `${item.charId} — ${facets}`) : null;
    }).filter(Boolean);
    return [...events, ...facts, ...characters];
}

function record(common, recordType, recordId, text) {
    const value = { ...common, recordType, recordId: String(recordId), text: String(text || '').trim() };
    return { ...value, key: archiveKey(value) };
}

function documentFor(recordValue) {
    const text = `ARC: ${recordValue.arcTitle}\nSCENE: ${recordValue.sceneTitle}\n${recordValue.recordType.toUpperCase()}: ${recordValue.text}`;
    const hash = hash32(`${recordValue.key}\n${text}`);
    return { hash, text, metadata: { hash, kind: 'archive', ...recordValue } };
}

function sceneOrder(timelineId, sceneId) {
    const store = getTimelineStore();
    const timeline = store.timelines[String(timelineId || '')];
    let order = 0;
    for (const arcId of timeline?.arcIds || []) {
        for (const id of store.arcs[arcId]?.sceneIds || []) {
            const scene = store.scenes[id];
            if (!scene || scene.mode !== 'roleplay') continue;
            if (String(id) === String(sceneId)) return order;
            order += 1;
        }
    }
    return -1;
}

function archiveKey(value) { return `archive:${value.sceneId}:${value.recordType}:${value.recordId}`; }
function pinKey(value) { return `${value.sourceSceneId}:${value.recordType}:${value.recordId}`; }
function add(candidate, points, channel, detail = {}) { candidate.score += points; candidate.reasons.push({ channel, points, ...detail }); }
function tokenize(value) { return new Set(String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, ' ').split(/\s+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word))); }
function hash32(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value || '')) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 0x01000193); }
    return hash >>> 0;
}
function hash64(value) {
    let hash = 0xcbf29ce484222325n;
    for (const character of String(value || '')) { hash ^= BigInt(character.codePointAt(0)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
    return hash.toString(16).padStart(16, '0');
}
