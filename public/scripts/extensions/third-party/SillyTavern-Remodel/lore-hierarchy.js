// The generality signal for Living Lore.
//
// Cosine similarity is symmetric: it can say two entries are related but never
// which one is the broader idea. A hierarchy needs a direction, so it comes
// from the mention graph instead — who is referred to, and how many ways an
// entry can be reached.
//
// An edge runs FROM the entry whose content mentions a key TO the entry that
// owns that key. Being mentioned by many entries is what "general" means here:
// a faction named across twelve scenes sits above the one incident that named
// it. That is the same relation vanilla recursion walks, so a hierarchy built
// from it describes traversal that will actually happen rather than an
// arrangement invented beside it.
//
// Pure functions over plain entry objects. No store, no network, no model.

/**
 * Mirror SillyTavern's own key matching (world-info.js `#transformString` and
 * the `matchWholeWords` branch) so this graph reflects what the native scanner
 * would really activate. Divergence here would produce a hierarchy describing
 * traversal that never occurs.
 */
export function loreKeyMatches(haystack, key, { caseSensitive = false, matchWholeWords = true } = {}) {
    const needle = String(key ?? '').trim();
    if (!needle) return false;
    const text = String(haystack ?? '');

    // A /regex/ key is used verbatim by core; honour it rather than matching its
    // literal slashes.
    const asRegex = needle.match(/^\/(.+)\/([gimsuy]*)$/);
    if (asRegex) {
        try {
            return new RegExp(asRegex[1], asRegex[2].replace('g', '')).test(text);
        } catch {
            return false;
        }
    }

    const subject = caseSensitive ? text : text.toLowerCase();
    const term = caseSensitive ? needle : needle.toLowerCase();

    // Core only applies word boundaries to single-word keys; a multi-word key
    // falls back to a plain substring test.
    if (matchWholeWords && !/\s/.test(term)) {
        return new RegExp(`(?:^|\\W)(${escapeRegex(term)})(?:$|\\W)`).test(subject);
    }
    return subject.includes(term);
}

/** How many distinct ways an entry can be reached. Breadth of address, not size
 * of content: an entry answering to eight names is reachable from more contexts
 * than one answering to a single proper noun. */
export function measureKeyBreadth(entry) {
    const keys = [...(entry?.keys || []), ...(entry?.secondaryKeys || [])]
        .map((key) => String(key ?? '').trim().toLowerCase())
        .filter(Boolean);
    return new Set(keys).size;
}

/**
 * Build the directed mention graph. Recursion flags are honoured so the graph
 * cannot claim a traversal the native scanner would refuse:
 *  - `preventRecursion` on a source: its content never triggers anything, so it
 *    emits no edges.
 *  - `excludeRecursion` on a target: recursion may not activate it, so it
 *    receives none.
 */
export function buildLoreMentionGraph(entries = []) {
    const live = entries.filter((entry) => entry && !entry.native?.disable);
    const edges = [];
    const inDegree = new Map(live.map((entry) => [entryId(entry), 0]));
    const outDegree = new Map(live.map((entry) => [entryId(entry), 0]));

    for (const source of live) {
        if (source.native?.preventRecursion) continue;
        const content = String(source.content || '');
        if (!content.trim()) continue;

        for (const target of live) {
            if (target === source) continue;
            if (target.native?.excludeRecursion) continue;
            const options = {
                caseSensitive: Boolean(target.native?.caseSensitive),
                matchWholeWords: target.native?.matchWholeWords !== false,
            };
            const hit = [...(target.keys || []), ...(target.secondaryKeys || [])]
                .find((key) => loreKeyMatches(content, key, options));
            if (!hit) continue;
            edges.push({ from: entryId(source), to: entryId(target), key: String(hit) });
            inDegree.set(entryId(target), (inDegree.get(entryId(target)) || 0) + 1);
            outDegree.set(entryId(source), (outDegree.get(entryId(source)) || 0) + 1);
        }
    }

    // Carried so the mesh can enforce them on every link it derives. Applying
    // them only while building edges is not enough: a reversed or co-mention
    // link is a new traversal the original edge never authorised.
    const flags = new Map(live.map((entry) => [entryId(entry), {
        preventRecursion: Boolean(entry.native?.preventRecursion),
        excludeRecursion: Boolean(entry.native?.excludeRecursion),
    }]));

    return { edges, inDegree, outDegree, flags };
}

/**
 * Score every entry from 0 (most specific) to 1 (most general), blending how
 * often it is mentioned with how many ways it can be addressed. Both are
 * normalised against the book's own maximum, because "many mentions" only means
 * anything relative to the rest of this Timeline.
 */
// Mentions outweigh breadth on purpose. In-degree is evidence the corpus
// produced — other entries genuinely refer to this one — while key breadth is
// only authorial intent, how many aliases someone happened to type. Evidence
// should decide; breadth is the tie-breaker that separates entries the
// mention graph rates equally. At even weights a single extra alias could
// outvote being referenced twice as often, which inverts the signal the
// hierarchy is built on.
export function scoreLoreGenerality(entries = [], { mentionWeight = 0.7, breadthWeight = 0.3, graph = null } = {}) {
    const live = entries.filter((entry) => entry && !entry.native?.disable);
    // Building the graph is O(entries squared) in key matching. Retrieval has
    // already built one for traversal, so let it hand the same graph over
    // rather than paying for an identical second pass every turn.
    const { inDegree, outDegree } = graph?.inDegree ? graph : buildLoreMentionGraph(live);
    const breadthById = new Map(live.map((entry) => [entryId(entry), measureKeyBreadth(entry)]));

    const mentionRange = range([...inDegree.values()]);
    const breadthRange = range([...breadthById.values()]);
    const weightTotal = mentionWeight + breadthWeight || 1;

    return live.map((entry) => {
        const id = entryId(entry);
        const mentions = inDegree.get(id) || 0;
        const breadth = breadthById.get(id) || 0;
        const generality = (
            mentionWeight * ratio(mentions, mentionRange)
            + breadthWeight * ratio(breadth, breadthRange)
        ) / weightTotal;
        return Object.freeze({
            id,
            book: entry.book,
            uid: entry.uid,
            name: entry.name,
            mentions,
            keyBreadth: breadth,
            mentionsOthers: outDegree.get(id) || 0,
            generality: round(generality),
        });
    }).sort((a, b) => b.generality - a.generality || String(a.name).localeCompare(String(b.name)));
}

/**
 * Band scored entries into tiers, 0 being the most general. Banded by VALUE,
 * not by position, so entries scoring identically always land in the same tier
 * — ranking by index would split ties arbitrarily and make the hierarchy
 * unstable across reindexes.
 */
export const DEFAULT_LORE_TIERS = 3;

export function assignLoreTiers(scored = [], { tiers = DEFAULT_LORE_TIERS } = {}) {
    const bands = Math.max(1, Math.floor(tiers));
    return scored.map((item) => Object.freeze({
        ...item,
        tier: Math.min(bands - 1, Math.floor((1 - item.generality) * bands)),
    }));
}

function entryId(entry) {
    return `${entry?.book || ''}::${entry?.uid || ''}`;
}

/** Min-max, not value-over-max. A measure every entry shares carries no
 * information — a book where each entry has exactly one key should not treat
 * every entry as maximally broad — so a flat spread scores zero for everyone
 * and the other signal decides. */
function range(values) {
    if (!values.length) return { min: 0, max: 0 };
    return { min: Math.min(...values), max: Math.max(...values) };
}

function ratio(value, { min, max }) {
    return max > min ? (value - min) / (max - min) : 0;
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
