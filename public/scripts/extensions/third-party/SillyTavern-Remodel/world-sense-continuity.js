import {
    getSceneContinuitySettings,
    listTimelineArchiveScenes,
} from './archivist-store.js';
import { getTimelineStore } from './timeline-state.js';

// Words that never count as overlap between a passage and an earlier record.
//
// The list used to start at four letters and skip the most common words in
// the language, so "the" scored. Recall ranks by shared words, and nearly every
// record contains "the": the four recall slots went to whichever earlier
// records happened to be most recent, and a genuinely relevant older fact could
// be crowded out by three that merely shared an article. Function words only —
// articles, conjunctions, prepositions, pronouns, auxiliaries, and the
// contractions the tokenizer keeps whole. Three-letter nouns and verbs (key,
// gate, oil, door, run) are content and stay scorable.
const STOP_WORDS = new Set([
    // articles, conjunctions
    'the', 'and', 'but', 'nor', 'yet', 'either', 'neither', 'whether', 'because', 'although', 'though', 'unless',
    // prepositions
    'about', 'above', 'across', 'after', 'against', 'along', 'among', 'around', 'before', 'behind', 'below',
    'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'for', 'from', 'inside', 'into', 'near', 'off',
    'onto', 'out', 'over', 'past', 'per', 'since', 'than', 'through', 'toward', 'towards', 'under', 'until',
    'upon', 'via', 'with', 'within', 'without',
    // pronouns and determiners
    'you', 'your', 'yours', 'she', 'her', 'hers', 'him', 'his', 'its', 'our', 'ours', 'they', 'them', 'their',
    'theirs', 'who', 'whom', 'whose', 'which', 'what', 'that', 'this', 'these', 'those', 'all', 'any', 'both',
    'each', 'few', 'many', 'much', 'none', 'other', 'others', 'same', 'some', 'such', 'own', 'myself', 'yourself',
    'herself', 'himself', 'itself', 'ourselves', 'yourselves', 'themselves', 'someone', 'anyone', 'everyone',
    'something', 'anything', 'everything', 'nothing',
    // auxiliaries and their contractions
    'are', 'was', 'were', 'been', 'being', 'has', 'had', 'have', 'having', 'does', 'did', 'done', 'doing',
    'will', 'shall', 'would', 'should', 'could', 'might', 'must', 'can', 'cannot',
    'isn\'t', 'aren\'t', 'wasn\'t', 'weren\'t', 'hasn\'t', 'haven\'t', 'hadn\'t', 'doesn\'t', 'don\'t', 'didn\'t',
    'won\'t', 'wouldn\'t', 'shouldn\'t', 'couldn\'t', 'can\'t', 'mustn\'t', 'i\'m', 'i\'ve', 'i\'d', 'i\'ll', 'you\'re',
    'you\'ve', 'you\'d', 'you\'ll', 'she\'s', 'she\'d', 'she\'ll', 'he\'s', 'he\'d', 'he\'ll', 'it\'s', 'we\'re', 'we\'ve',
    'we\'d', 'we\'ll', 'they\'re', 'they\'ve', 'they\'d', 'they\'ll', 'that\'s', 'there\'s', 'here\'s', 'what\'s', 'who\'s',
    // adverbs and filler that carry no subject
    'not', 'too', 'now', 'here', 'there', 'then', 'when', 'where', 'why', 'how', 'also', 'again', 'just', 'only',
    'very', 'more', 'most', 'less', 'least', 'ever', 'never', 'always', 'often', 'still', 'even', 'once', 'yes',
    'said', 'while', 'well', 'quite', 'rather', 'really', 'almost', 'already', 'perhaps', 'maybe',
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
            if (!isContinuityScene(scene)) continue;
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

        // A new Scene must not begin amnesiac simply because its first action
        // happens to share no keyword with the previous Scene. When both
        // continuity switches permit it, carry the direct predecessor's
        // accepted Archive as a bounded baseline; semantic ranking still
        // governs every older Scene and any extra recall from this one.
        if (record.orderIndex === targetOrder - 1) {
            add(candidate, 120, 'continuity.previous-scene-baseline');
            candidate.forced = true;
        }

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
        sceneId: String(scene.id), sceneTitle: String(scene.title || 'Untitled Scene'), sceneMode: String(scene.mode || 'roleplay'), arcId: String(arc.id),
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
            if (!isContinuityScene(scene)) continue;
            if (String(id) === String(sceneId)) return order;
            order += 1;
        }
    }
    return -1;
}

function archiveKey(value) { return `archive:${value.sceneId}:${value.recordType}:${value.recordId}`; }
function pinKey(value) { return `${value.sourceSceneId}:${value.recordType}:${value.recordId}`; }
function isContinuityScene(scene) { return scene?.mode === 'roleplay' || scene?.mode === 'story'; }
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
