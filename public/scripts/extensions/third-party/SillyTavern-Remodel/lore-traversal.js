// Mentions propose, the vector disposes.
//
// The old arrangement had it backwards: semantic search picked entries and
// everything else existed to restrain it — a similarity floor, a cap on how
// many entries could ride on similarity alone, a blend of competing channels.
// All of that is compensation for asking an embedding model to make a judgement
// it cannot make. It measures whether words are near each other in meaning; it
// has no idea whether a fact matters to this scene.
//
// Here each mechanism does only what it is good at. A textual mention is
// high-precision evidence that something is connected — the entry literally
// names it — so mentions decide what is even considered. The vector then
// answers the one question it can answer well: of the things connected to what
// is already in play, which are close enough to what is happening right now?
//
// Seeds are never gated. They matched a key in the actual scene text, which is
// stronger evidence than any similarity score, and second-guessing that with a
// weaker signal is how relevant lore goes missing.

export const DEFAULT_TRAVERSAL_GATE = 0.35;
export const DEFAULT_DEPTH_PENALTY = 0.1;
export const DEFAULT_MAX_DEPTH = 3;

export const TRAVERSAL_REJECTIONS = Object.freeze([
    'below-gate', 'depth-exhausted', 'entry-budget', 'token-budget', 'unknown-entry',
]);

/**
 * @param {object} options
 * @param {string[]} options.seeds ids that matched the scene directly
 * @param {{edges: Array<{from: string, to: string, key: string}>}} options.graph mention graph
 * @param {Record<string, number>|Map} options.similarity id → 0..1 against the current context
 */
export function gateLoreTraversal({
    seeds = [],
    graph = { edges: [] },
    similarity = {},
    known = null,
    gate = DEFAULT_TRAVERSAL_GATE,
    depthPenalty = DEFAULT_DEPTH_PENALTY,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxEntries = 12,
    maxTokens = Infinity,
    tokensFor = () => 0,
} = {}) {
    const score = (id) => {
        const value = similarity instanceof Map ? similarity.get(id) : similarity?.[id];
        return Number.isFinite(Number(value)) ? Number(value) : 0;
    };
    const exists = (id) => (known ? known.has(id) : true);

    // Who each entry mentions. Traversal follows the mention outward, which is
    // the same direction the native scanner recurses.
    const mentions = new Map();
    for (const edge of graph?.edges || []) {
        if (!mentions.has(edge.from)) mentions.set(edge.from, []);
        mentions.get(edge.from).push(edge);
    }

    const admitted = [];
    const rejected = [];
    const seen = new Set();
    let spentTokens = 0;

    const admit = (id, depth, via, similarityScore) => {
        const tokens = Math.max(0, Number(tokensFor(id)) || 0);
        if (admitted.length >= maxEntries) {
            rejected.push({ id, depth, via, similarity: similarityScore, reason: 'entry-budget' });
            return false;
        }
        if (spentTokens + tokens > maxTokens) {
            rejected.push({ id, depth, via, similarity: similarityScore, reason: 'token-budget' });
            return false;
        }
        spentTokens += tokens;
        admitted.push({ id, depth, via, similarity: similarityScore, tokens });
        return true;
    };

    // Depth 0: the scene named these itself. Admitted unconditionally.
    for (const id of unique(seeds)) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!exists(id)) {
            rejected.push({ id, depth: 0, via: null, similarity: 0, reason: 'unknown-entry' });
            continue;
        }
        admit(id, 0, null, score(id));
    }

    // Then outward, one depth at a time, so a closer connection always gets
    // first claim on the budget.
    let frontier = admitted.map((item) => item.id);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
        // The bar rises with distance: something three mentions away has to be
        // markedly more relevant to earn the same place as a direct connection.
        const bar = gate + depthPenalty * (depth - 1);
        const proposals = [];
        for (const source of frontier) {
            for (const edge of mentions.get(source) || []) {
                if (seen.has(edge.to)) continue;
                proposals.push({ id: edge.to, via: { from: source, key: edge.key } });
            }
        }

        // Best first, so the budget buys the most relevant proposals rather than
        // whichever happened to be mentioned earliest.
        const ranked = dedupe(proposals)
            .map((item) => ({ ...item, similarity: score(item.id) }))
            .sort((a, b) => b.similarity - a.similarity);

        const next = [];
        for (const proposal of ranked) {
            seen.add(proposal.id);
            if (!exists(proposal.id)) {
                rejected.push({ ...proposal, depth, reason: 'unknown-entry' });
                continue;
            }
            if (proposal.similarity < bar) {
                rejected.push({ ...proposal, depth, bar: round(bar), reason: 'below-gate' });
                continue;
            }
            if (admit(proposal.id, depth, proposal.via, proposal.similarity)) next.push(proposal.id);
        }
        frontier = next;
        if (!frontier.length) break;
    }

    // Anything still reachable past the depth limit is reported, not silently
    // dropped: "we stopped looking" and "we looked and said no" are different
    // answers and a receipt that conflates them cannot be debugged.
    for (const source of frontier) {
        for (const edge of mentions.get(source) || []) {
            if (seen.has(edge.to)) continue;
            seen.add(edge.to);
            rejected.push({ id: edge.to, depth: maxDepth + 1, via: { from: source, key: edge.key }, similarity: score(edge.to), reason: 'depth-exhausted' });
        }
    }

    return Object.freeze({
        admitted: Object.freeze(admitted),
        rejected: Object.freeze(rejected),
        receipt: Object.freeze({
            seeds: unique(seeds).length,
            admittedCount: admitted.length,
            rejectedCount: rejected.length,
            deepest: admitted.reduce((deep, item) => Math.max(deep, item.depth), 0),
            tokens: spentTokens,
            gate,
            depthPenalty,
            maxDepth,
        }),
    });
}

function unique(values) {
    return [...new Set((values || []).map((value) => String(value)).filter(Boolean))];
}

function dedupe(proposals) {
    const byId = new Map();
    for (const proposal of proposals) if (!byId.has(proposal.id)) byId.set(proposal.id, proposal);
    return [...byId.values()];
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}
