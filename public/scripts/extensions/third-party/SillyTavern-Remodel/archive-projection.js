import { getBeat, listCharStates, listEvents, listSceneFacts } from './archivist-store.js';

const DEFAULT_BUDGET = 24;
const DEFAULT_RECENT = 10;
const DEFAULT_RELEVANT = 6;
const SUMMARY_GROUP_SIZE = 12;
const STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'been', 'before', 'being', 'between', 'could', 'does', 'from', 'have',
    'into', 'just', 'more', 'most', 'only', 'other', 'over', 'said', 'should', 'some', 'than', 'that', 'their',
    'them', 'then', 'there', 'these', 'they', 'this', 'through', 'under', 'very', 'what', 'when', 'where',
    'which', 'while', 'with', 'would', 'your',
]);

/** Deterministic prompt projection over accepted raw Archive events. */
export function projectArchiveEvents(events = [], { query = [], maxEntries = DEFAULT_BUDGET } = {}) {
    const budget = clampBudget(maxEntries);
    const ordered = (Array.isArray(events) ? events : []).filter((event) => event && String(event.summary || '').trim())
        .slice().sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
    const { unique, duplicateIds } = dedupeEvents(ordered);
    const queryTokens = tokenize(Array.isArray(query) ? query.join('\n') : query);
    if (!budget || !unique.length) return emptyProjection(ordered.length, duplicateIds, budget, [...queryTokens]);

    const recent = unique.slice(-Math.min(DEFAULT_RECENT, budget, unique.length));
    const recentIds = new Set(recent.map((event) => event.id));
    const older = unique.filter((event) => !recentIds.has(event.id));
    const relevantCapacity = Math.min(DEFAULT_RELEVANT, Math.max(0, budget - recent.length));
    const relevant = older.map((event) => ({ event, score: relevanceScore(event, queryTokens) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || Number(right.event.seq || 0) - Number(left.event.seq || 0))
        .slice(0, relevantCapacity).map((item) => ({ ...item.event, relevanceScore: item.score }));
    const selectedIds = new Set([...recent, ...relevant].map((event) => event.id));
    const compactable = older.filter((event) => !selectedIds.has(event.id));
    const summaries = compactEvents(compactable, Math.max(0, budget - recent.length - relevant.length));
    const entries = [
        ...relevant.map((event) => eventEntry(event, 'relevant')),
        ...recent.map((event) => eventEntry(event, 'recent')),
        ...summaries,
    ].sort(compareProjectionEntries);
    const representedIds = new Set(entries.flatMap((entry) => entry.sourceEventIds || []));
    return {
        version: 1,
        queryTerms: [...queryTokens].slice(0, 96),
        entries,
        receipt: {
            storedCount: ordered.length, uniqueCount: unique.length, budget,
            recentIds: recent.map((event) => event.id),
            retrievedIds: relevant.map((event) => event.id),
            summaryIds: summaries.map((summary) => summary.id),
            summarizedEventIds: summaries.flatMap((summary) => summary.sourceEventIds),
            duplicateIds,
            omittedIds: unique.filter((event) => !representedIds.has(event.id)).map((event) => event.id),
            projectedCount: entries.length,
        },
    };
}

/** Add stable scene state to the turn query without exposing Archive secrets. */
export function buildSceneArchiveProjection(timelineId, sceneId, { query = [], maxEntries = DEFAULT_BUDGET } = {}) {
    const facts = listSceneFacts(timelineId, sceneId);
    const characters = listCharStates(timelineId, sceneId);
    const beat = getBeat(timelineId, sceneId);
    return projectArchiveEvents(listEvents(timelineId, sceneId), {
        maxEntries,
        query: [
            ...(Array.isArray(query) ? query : [query]),
            ...facts.map((fact) => `${fact.key}: ${fact.value}`),
            ...characters.flatMap((character) => [character.charId, ...Object.values(character.facets || {})]),
            beat?.directive || '', beat?.tone || '',
        ],
    });
}

export function renderArchiveProjection(projection) {
    return (projection?.entries || []).map((entry) => entry.kind === 'summary'
        ? `- Earlier (${entry.sourceLabel}): ${entry.summary}`
        : `- ${entry.summary}`).join('\n');
}

function compactEvents(events, capacity) {
    if (!capacity || !events.length) return [];
    const groups = [];
    const groupSize = Math.max(SUMMARY_GROUP_SIZE, Math.ceil(events.length / capacity));
    for (let index = 0; index < events.length && groups.length < capacity; index += groupSize) {
        const group = events.slice(index, index + groupSize);
        const first = concise(group[0].summary);
        const last = concise(group[group.length - 1].summary);
        const firstSeq = Number(group[0].seq || 0);
        const lastSeq = Number(group[group.length - 1].seq || firstSeq);
        groups.push({
            kind: 'summary', id: `archive-summary-${firstSeq}-${lastSeq}`,
            summary: first === last ? first : `${first}; later, ${lowerFirst(last)}`,
            sourceLabel: firstSeq === lastSeq ? `event ${firstSeq}` : `events ${firstSeq}-${lastSeq}`,
            sourceEventIds: group.map((event) => event.id), firstSeq, lastSeq,
        });
    }
    return groups;
}

function eventEntry(event, selection) {
    const seq = Number(event.seq || 0);
    return { kind: 'event', id: event.id, summary: String(event.summary || '').trim(), selection, sourceEventIds: [event.id], firstSeq: seq, lastSeq: seq };
}

function dedupeEvents(events) {
    const signatures = new Set();
    const uniqueReversed = [];
    const duplicateIds = [];
    for (const event of events.slice().reverse()) {
        const signature = normalize(event.summary);
        if (signatures.has(signature)) duplicateIds.push(event.id);
        else { signatures.add(signature); uniqueReversed.push(event); }
    }
    return { unique: uniqueReversed.reverse(), duplicateIds: duplicateIds.reverse() };
}

function relevanceScore(event, queryTokens) {
    if (!queryTokens.size) return 0;
    let score = 0;
    for (const token of tokenize(event.summary)) if (queryTokens.has(token)) score += token.length >= 7 ? 3 : 2;
    return score;
}

// Three-letter tokens are intentional: roleplay casts commonly contain short
// names such as Eli and Teo, and those are strong continuity identifiers.
function tokenize(value) { return new Set(normalize(value).split(' ').filter((token) => token.length >= 3 && !STOP_WORDS.has(token))); }
function normalize(value) { return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
function concise(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= 120) return text.replace(/[.;:,]+$/, '');
    return `${text.slice(0, 117).replace(/\s+\S*$/, '').replace(/[.;:,]+$/, '')}...`;
}
function lowerFirst(value) { return value ? `${value[0].toLocaleLowerCase()}${value.slice(1)}` : ''; }
function compareProjectionEntries(left, right) { return left.firstSeq - right.firstSeq || left.lastSeq - right.lastSeq; }
function clampBudget(value) {
    if (value === null || value === undefined || value === '') return DEFAULT_BUDGET;
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : DEFAULT_BUDGET;
}
function emptyProjection(storedCount, duplicateIds, budget, queryTerms = []) {
    return { version: 1, queryTerms: queryTerms.slice(0, 96), entries: [], receipt: { storedCount, uniqueCount: Math.max(0, storedCount - duplicateIds.length), budget, recentIds: [], retrievedIds: [], summaryIds: [], summarizedEventIds: [], duplicateIds, omittedIds: [], projectedCount: 0 } };
}
