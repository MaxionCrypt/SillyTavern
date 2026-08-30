// Mentions connect, the vector chooses.
//
// The original arrangement had semantic search picking entries and everything
// else restraining it — a similarity floor, a cap on how many entries could
// ride on similarity alone, a blend of competing channels. All of that is
// compensation for asking an embedding model to make a judgement it cannot
// make. It measures whether words are near each other in meaning; it has no
// idea whether a fact matters to this scene.
//
// So mentions decide what is connected. A textual mention is high-precision
// evidence: the entry literally names the thing. The vector is secondary — it
// orders what the mentions already found, and matters only when there is more
// connected lore than the budget can carry. It never refuses an entry on its
// own, because "these words are not very close in meaning" is not a reason to
// withhold something the world explicitly linked to what is in play.
//
// One way in: an entry is reached when something already in play NAMES it.
// Its content matches that entry's key, which is what vanilla recursion
// follows and what the mention graph was built to describe.
//
// Two other routes were tried and retired, in this order:
//
//  - REVERSE. Following a naming backwards inverted retrieval: asking about a
//    subject returned every entry that had ever mentioned it, so a name dropped
//    once in a minor entry dragged that entry back whenever its subject came
//    up.
//  - CO-MENTION. Two entries named by the same third were linked to each
//    other directly. That is a shortcut across a shared parent, and the parent
//    already does the work: when it is in play it names both, and both arrive
//    by ordinary recursion. What the shortcut added was reaching one from the
//    other while the parent was absent -- a connection nothing had written.
//
// So an entry with no outgoing mentions reaches nothing, and that is a true
// answer rather than a gap: if its content names nothing, there is nothing to
// follow, and the fix is in the entry.
//
// Seeds are what the scene named directly. They are admitted unconditionally
// and ranked by how they matched the scene, never reordered by the hierarchy.
//
// Tiers order the walk: among entries reached at the same distance, general
// before specific, so the broad frame lands before the detail. A tier is worth
// less than a step of distance, so a broad entry never overtakes a closer one.

export const DEFAULT_MAX_DEPTH = 2;

export const TRAVERSAL_REJECTIONS = Object.freeze([
    'depth-exhausted', 'entry-budget', 'token-budget', 'unknown-entry',
]);

export const TRAVERSAL_RELATIONS = Object.freeze(['names']);

/**
 * @param {object} options
 * @param {string[]} options.seeds ids that matched the scene directly
 * @param {{edges: Array<{from: string, to: string, key: string}>}} options.graph mention graph
 * @param {Record<string, number>|Map} options.similarity id → 0..1 against the current context
 * @param {Record<string, number>|Map} options.tiers id → 0..n, 0 being the most general
 */
export function gateLoreTraversal({
    seeds = [],
    graph = { edges: [] },
    similarity = {},
    tiers = {},
    known = null,
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
    // Unknown entries sort last: with no hierarchy for them we must not promote
    // them ahead of entries the graph actually placed.
    const tierOf = (id) => {
        const value = tiers instanceof Map ? tiers.get(id) : tiers?.[id];
        return Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
    };
    const byTierThenSimilarity = (a, b) => a.tier - b.tier || b.similarity - a.similarity;

    const neighbours = buildMesh(graph);

    const admitted = [];
    const rejected = [];
    const seen = new Set();
    let spentTokens = 0;

    const admit = (id, depth, via, similarityScore) => {
        const tokens = Math.max(0, Number(tokensFor(id)) || 0);
        const tier = tierOf(id);
        if (admitted.length >= maxEntries) {
            rejected.push({ id, depth, via, similarity: similarityScore, tier, reason: 'entry-budget' });
            return false;
        }
        if (spentTokens + tokens > maxTokens) {
            rejected.push({ id, depth, via, similarity: similarityScore, tier, reason: 'token-budget' });
            return false;
        }
        spentTokens += tokens;
        admitted.push({ id, depth, via, similarity: similarityScore, tier, tokens });
        return true;
    };

    // Depth 0: the scene named these itself. Admitted unconditionally and in
    // the order given — the hierarchy governs the walk outward, never the
    // entries the scene named directly. Those are ranked by how they matched
    // the scene, which the caller has already decided.
    for (const id of unique(seeds)) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (!exists(id)) {
            rejected.push({ id, depth: 0, via: null, similarity: 0, tier: tierOf(id), reason: 'unknown-entry' });
            continue;
        }
        admit(id, 0, null, score(id));
    }

    // Then outward through the mesh, one ring at a time, so a closer connection
    // always gets first claim on the budget.
    let frontier = admitted.map((item) => item.id);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
        const proposals = [];
        for (const source of frontier) {
            for (const link of neighbours.get(source) || []) {
                if (seen.has(link.to)) continue;
                proposals.push({ id: link.to, via: { from: source, key: link.key, relation: link.relation } });
            }
        }

        // General first, then closest in meaning within a tier: when the budget
        // cannot carry everything connected, the vector decides which of the
        // connected entries earn the remaining room.
        const ranked = dedupe(proposals)
            .map((item) => ({ ...item, similarity: score(item.id), tier: tierOf(item.id) }))
            .sort(byTierThenSimilarity);

        const next = [];
        for (const proposal of ranked) {
            seen.add(proposal.id);
            if (!exists(proposal.id)) {
                rejected.push({ ...proposal, depth, reason: 'unknown-entry' });
                continue;
            }
            if (admit(proposal.id, depth, proposal.via, proposal.similarity)) next.push(proposal.id);
        }
        frontier = next;
        if (!frontier.length) break;
    }

    // Anything still reachable past the depth limit is reported, not silently
    // dropped: "we stopped looking" and "we ran out of room" are different
    // answers and a receipt that conflates them cannot be debugged.
    for (const source of frontier) {
        for (const link of neighbours.get(source) || []) {
            if (seen.has(link.to)) continue;
            seen.add(link.to);
            rejected.push({
                id: link.to, depth: maxDepth + 1, similarity: score(link.to), tier: tierOf(link.to),
                via: { from: source, key: link.key, relation: link.relation }, reason: 'depth-exhausted',
            });
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
            broadest: admitted.reduce((broad, item) => Math.min(broad, item.tier), Number.MAX_SAFE_INTEGER),
            tokens: spentTokens,
            maxDepth,
        }),
    });
}

/**
 * Adjacency in the direction the naming runs: from the entry whose content
 * matched a key, to the entry that owns it.
 */
export function buildMesh(graph = { edges: [] }) {
    const neighbours = new Map();
    // The two native recursion flags, honoured on every link rather than only
    // on the edge it was derived from.
    //
    //  - "Prevent further recursion" means the entry must not trigger anything,
    //    so nothing may lead OUT of it. In a mesh that makes it a dead end: it
    //    can be reached, and the walk stops there.
    //  - "Non-recursable" means recursion must never activate the entry, so
    //    nothing may lead INTO it. It can still be a seed, because the scene
    //    naming it directly is not recursion.
    //
    // This is how an author stops a hub dragging its neighbourhood in behind
    // it -- including an always-on constant entry.
    const flags = graph?.flags instanceof Map ? graph.flags : new Map();
    const canLeave = (id) => !flags.get(id)?.preventRecursion;
    const canEnter = (id) => !flags.get(id)?.excludeRecursion;
    const link = (from, to, key, relation) => {
        if (!from || !to || from === to) return;
        if (!canLeave(from) || !canEnter(to)) return;
        if (!neighbours.has(from)) neighbours.set(from, []);
        const list = neighbours.get(from);
        // One link per pair: an entry naming another twice, by two different
        // keys, is still one connection.
        if (list.some((item) => item.to === to)) return;
        list.push({ to, key, relation });
    };

    for (const edge of graph?.edges || []) link(edge.from, edge.to, edge.key, 'names');

    return neighbours;
}

function unique(values) {
    return [...new Set((values || []).map((value) => String(value)).filter(Boolean))];
}

function dedupe(proposals) {
    const byId = new Map();
    for (const proposal of proposals) if (!byId.has(proposal.id)) byId.set(proposal.id, proposal);
    return [...byId.values()];
}
