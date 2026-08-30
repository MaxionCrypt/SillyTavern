// Where new information goes.
//
// The Loom does not choose. It reports what happened and Living Lore decides
// whether that belongs inside an entry that already exists, or is its own
// subject. Three signals answer that, scored together rather than as separate
// gates, so one strong signal can carry a weak one:
//
//  - SEMANTIC: how close the new text is in meaning to the entry.
//  - RECURSIVE: how much of what the new text NAMES lives in the entry's part
//    of the mesh. This is the same key matching traversal uses, so a placement
//    decision and a retrieval decision are made on the same evidence.
//  - TEMPORAL: how close the new information was recorded to when the entry
//    first appeared.
//
// Above the threshold the header is dropped — the name and keys the Loom
// suggested are discarded — and only the content is appended to the end of the
// winning entry. Below it, the information becomes an entry of its own and
// joins the mesh like any other.
//
// Time is measured against createdAt, never updatedAt. Appending moves
// updatedAt, so scoring against it would make every append make the next
// append likelier, and a long scene would collapse into one hub entry.
//
// Pure. No store, no network, no model — callers supply the similarity scores.

import { buildLoreMentionGraph, loreKeyMatches } from './lore-hierarchy.js';
import { buildMesh } from './lore-traversal.js';

/** Mentions outweigh meaning, and time is circumstantial. Same order of trust
 * as retrieval: what the text explicitly names is stronger evidence than what
 * an embedding thinks it resembles, and when something happened to be written
 * down is the weakest reason to file it somewhere. */
export const DEFAULT_INTAKE_WEIGHTS = Object.freeze({ recursive: 0.5, semantic: 0.3, temporal: 0.2 });

/** Below this the information is its own subject. */
export const DEFAULT_INTAKE_THRESHOLD = 0.5;

/** Temporal closeness halves every day. Information recorded during the same
 * sitting as an entry was created scores near 1; a week later, near zero. */
export const DEFAULT_TEMPORAL_HALF_LIFE_HOURS = 24;

const HOUR_MS = 3600000;

/**
 * @param {object} options
 * @param {string} options.content the new information, as written
 * @param {number|string} options.recordedAt when the archive recorded it
 * @param {Array} options.entries live lore entries
 * @param {Array} options.metadata sidecars carrying createdAt
 * @param {Array<{book: string, uid: string, score: number}>} options.semanticMatches
 */
export function placeLivingLoreInformation({
    content = '',
    recordedAt = 0,
    entries = [],
    metadata = [],
    semanticMatches = [],
    weights = DEFAULT_INTAKE_WEIGHTS,
    threshold = DEFAULT_INTAKE_THRESHOLD,
    halfLifeHours = DEFAULT_TEMPORAL_HALF_LIFE_HOURS,
} = {}) {
    const text = String(content || '').trim();
    const live = entries.filter((entry) => entry && !entry.native?.disable);
    if (!text || !live.length) return placement({ decision: 'create', reason: text ? 'empty-book' : 'empty-content' });

    const graph = buildLoreMentionGraph(live);
    const mesh = buildMesh(graph);
    const createdAtById = new Map(metadata.map((item) => [graphId(item), timestamp(item?.createdAt)]));

    // What the new information talks about: the same key matching the mention
    // graph is built from, so this is its provisional place in the mesh.
    const names = new Set(live
        .filter((entry) => keysOf(entry).some((key) => loreKeyMatches(text, key, matchOptions(entry))))
        .map(graphId));

    const semanticById = new Map(semanticMatches
        .filter((item) => Number.isFinite(Number(item?.score)))
        .map((item) => [graphId(item), Number(item.score)]));

    const recordedMs = timestamp(recordedAt);
    const weight = normalizeWeights(weights);

    const scored = live.map((entry) => {
        const id = graphId(entry);
        const signals = {
            semantic: clamp01(semanticById.get(id) ?? 0),
            recursive: recursiveCloseness(id, names, mesh),
            temporal: temporalCloseness(recordedMs, createdAtById.get(id), halfLifeHours),
        };
        const score = round(
            weight.semantic * signals.semantic
            + weight.recursive * signals.recursive
            + weight.temporal * signals.temporal,
        );
        return { id, book: entry.book, uid: entry.uid, name: entry.name, score, signals };
    }).sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name)));

    const best = scored[0] || null;
    const bar = Number.isFinite(Number(threshold)) ? Number(threshold) : DEFAULT_INTAKE_THRESHOLD;
    if (!best || best.score < bar) {
        return placement({ decision: 'create', reason: 'below-threshold', candidates: scored, threshold: bar });
    }
    return placement({
        decision: 'append',
        target: { book: best.book, uid: best.uid, name: best.name },
        score: best.score,
        signals: best.signals,
        candidates: scored,
        threshold: bar,
    });
}

/**
 * How much of what the new information names sits in this entry's part of the
 * mesh. Directional on purpose: the question is whether this content is ABOUT
 * the entry's neighbourhood, so it is measured against what the content names,
 * not against the size of the neighbourhood. Otherwise a well-connected entry
 * would be punished for having neighbours, and a lone entry would win every
 * placement by having almost none.
 */
function recursiveCloseness(id, names, mesh) {
    if (!names.size) return 0;
    const place = new Set([id, ...(mesh.get(id) || []).map((link) => link.to)]);
    let hits = 0;
    for (const named of names) if (place.has(named)) hits += 1;
    return round(hits / names.size);
}

/** Halves every `halfLifeHours`. Unknown timestamps score zero rather than
 * "now": an entry with no recorded creation time has not earned closeness. */
function temporalCloseness(recordedMs, createdMs, halfLifeHours) {
    if (!recordedMs || !createdMs) return 0;
    const halfLife = Math.max(0.001, Number(halfLifeHours) || DEFAULT_TEMPORAL_HALF_LIFE_HOURS);
    const hours = Math.abs(recordedMs - createdMs) / HOUR_MS;
    return round(2 ** (-hours / halfLife));
}

function placement({ decision, target = null, score = 0, signals = null, candidates = [], threshold = DEFAULT_INTAKE_THRESHOLD, reason = '' }) {
    return Object.freeze({
        decision,
        target,
        score,
        signals,
        reason,
        threshold,
        // Every candidate it weighed, best first, so a placement can be argued
        // with rather than only observed.
        candidates: Object.freeze(candidates.slice(0, 12)),
    });
}

function normalizeWeights(weights) {
    const recursive = positive(weights?.recursive, DEFAULT_INTAKE_WEIGHTS.recursive);
    const semantic = positive(weights?.semantic, DEFAULT_INTAKE_WEIGHTS.semantic);
    const temporal = positive(weights?.temporal, DEFAULT_INTAKE_WEIGHTS.temporal);
    const total = recursive + semantic + temporal;
    if (!total) return DEFAULT_INTAKE_WEIGHTS;
    return { recursive: recursive / total, semantic: semantic / total, temporal: temporal / total };
}

function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function keysOf(entry) {
    return [...(entry?.keys || []), ...(entry?.secondaryKeys || [])];
}

function matchOptions(entry) {
    return {
        caseSensitive: Boolean(entry?.native?.caseSensitive),
        matchWholeWords: entry?.native?.matchWholeWords !== false,
    };
}

function graphId(item) {
    return `${item?.book || ''}::${item?.uid || ''}`;
}

/** Accepts epoch millis or an ISO string; anything unreadable is 0, which the
 * temporal signal treats as "no evidence" rather than as the epoch. */
function timestamp(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}
