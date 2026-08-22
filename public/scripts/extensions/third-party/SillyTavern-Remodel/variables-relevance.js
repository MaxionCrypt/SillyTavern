import { entryKey } from './variables-lore-key.js';

export const DEFAULT_WINDOW = 12;
// One budget covering Goals and Variables together, which is why it rose from
// the Variables-only 6/12 it replaced. See the shared-state-retrieval design.
export const DEFAULT_LIMIT = 8;
export const HARD_LIMIT = 16;
export const DEFAULT_RECALL_WINDOW = 10;

const DIRECT_WEIGHT = 2;
// Above passive evidence and below the action naming it: the Loom writing
// "Morale is fraying" is a deliberate statement that Morale matters, but the
// user acting on it right now matters more.
const NOTEBOOK_WEIGHT = 1.5;
const KEYWORD_WEIGHT = 0.8;
// Deliberately the weakest channel. An all-time counter would make whatever
// surfaced first keep surfacing; a window decays by construction.
const RECALL_WEIGHT = 0.3;
// `always` is a promise to the owner that this Variable is sent every turn.
// A shared budget could otherwise let a Goal nobody has mentioned outrank it
// on a tie at zero, so it carries just enough to sit above evidence-free items.
const ALWAYS_FLOOR = 0.05;
// A Goal the user is attempting this turn is not competing for a slot: the
// prompt names it under ATTEMPTED THIS TURN and the capability layer will
// accept a roll against it, so it cannot be the one retrieval drops.
const PINNED_BONUS = 1000;

// Coverage matching needs to ignore the words every sentence contains.
//
// The floor is three characters, not four, and the stopword list carries the
// cost of that. Four would be tidier but it deletes short proper nouns — Rae,
// Kai, Ana, Ren — and a Goal titled "Find Rae before the party ends" would then
// match on "find", "party" and "ends" while the one word that identifies it
// went unread.
const TOKEN_PATTERN = /[a-z0-9']{3,}/g;
const STOPWORDS = new Set([
    'the', 'and', 'for', 'but', 'not', 'are', 'was', 'has', 'had', 'her', 'his', 'its', 'out',
    'off', 'own', 'too', 'any', 'all', 'one', 'two', 'who', 'why', 'how', 'now', 'let', 'get',
    'got', 'put', 'use', 'may', 'can', 'did', 'she', 'him', 'you', 'they', 'them', 'their',
    'with', 'from', 'into', 'that', 'this', 'there', 'been', 'being', 'have', 'will', 'would',
    'must', 'when', 'then', 'than', 'what', 'which', 'while', 'your', 'yours', 'about', 'after',
    'before', 'again', 'still', 'just', 'more', 'most', 'over', 'under', 'some', 'each', 'every',
    'make', 'makes', 'made', 'take', 'takes', 'keep', 'keeps', 'without', 'something', 'anything',
    'someone', 'anyone', 'trying',
]);

// Channels that move an item up the ranking and are deliberately invisible to
// the `retrieval.mode` gate.
//
// Only `recall` is here, and only because it is circular: an item is recalled
// because it was retrieved, so letting it satisfy a gate would mean one lucky
// turn could keep re-qualifying a Variable forever on the strength of having
// qualified. `notebook` and `goaltext` are not circular — each is an
// independent authored statement naming this Variable — so they count as
// evidence like any other channel.
const SCORE_ONLY_CHANNELS = new Set(['recall']);

// There is deliberately no STRONG_SEMANTIC_SCORE here. The spec allowed one
// very strong semantic match (>= 0.82) to corroborate a Variable on its own,
// but SillyTavern's vector endpoint filters by similarity and then discards it,
// so no similarity value ever reaches this code. The previous implementation
// synthesised one from result rank across [0.70, 0.84], which meant the
// top-ranked document always cleared 0.82 and every request corroborated its
// first hit unconditionally. A match now means "the server confirmed this
// cleared the threshold we asked for" — a boolean — so corroboration needs a
// second, independent channel.

/**
 * One scorer over both kinds of state, ranked into one budget.
 *
 * Eligibility differs and must stay differing. A Variable is gated by its
 * `retrieval.mode` before score matters — that gate is the Variable system's
 * contract with the owner. A Goal has no such field and is always eligible;
 * score alone decides whether it survives the cut. They are ranked together
 * and admitted apart, and collapsing that into one rule would silently
 * repeal one half of it.
 *
 * `scoredGoals` arrives already ranked (see scoreGoalRelevance) because the
 * caller needs those scores before this call: the ones that scored are what
 * seeds the vector query, and their descriptions are a query source here.
 */
export function retrieveRelevantState({
    variables = [], entries = new Map(), messages = [], vectorMatches = [], activatedKeys = new Set(),
    presentSubjects = [], explicitText = '', recentVariableIds = [], notebookText = '',
    scoredGoals = [], recallCounts = new Map(), recallWindow = DEFAULT_RECALL_WINDOW,
    limit = DEFAULT_LIMIT,
} = {}) {
    const getEntry = lookup(entries);
    const subjects = new Set(presentSubjects.map((item) => String(item || '').toLowerCase()).filter(Boolean));
    const recentIds = new Set(recentVariableIds.map(String));
    const explicit = String(explicitText || '').toLowerCase();
    const notebook = String(notebookText || '').toLowerCase();
    const vectorByVariable = groupVectors(vectorMatches);
    // Directional, and deliberately not symmetric: a Goal that scored lends its
    // description as a query source for Variables. A Variable is a bare name and
    // a number — it carries no text that could describe a Goal, so the reverse
    // direction would be inventing a signal rather than reading one.
    const goalText = scoredGoals.filter((item) => item.score > 0)
        .map((item) => String(item.goal?.description || '')).join('\n').toLowerCase();

    const variableItems = variables.map((variable) => {
        const channels = new Set();
        const reasons = [];
        const evidence = [];
        const links = variable.loreLinks || [];
        const vectors = vectorByVariable.get(variable.id) || [];
        // `passedAt` is the highest threshold the server confirmed this document
        // survived, so a Variable only accepts matches that cleared ITS bar.
        const semanticHits = vectors.filter((item) => Number(item.passedAt) >= variable.retrieval.semanticThreshold);
        const semantic = semanticHits.length > 0;
        const bestThreshold = semanticHits.reduce((best, item) => Math.max(best, Number(item.passedAt) || 0), 0);
        for (const item of semanticHits) {
            channels.add(item.channel === 'link' ? `semantic:${item.loreKey}` : 'semantic:self');
            evidence.push({ type: 'semantic', passedAt: Number(item.passedAt), rank: Number(item.rank), loreKey: item.loreKey || '' });
        }

        let activatedCount = 0;
        let subjectEstablished = false;
        for (const link of links) {
            const key = entryKey(link);
            const entry = getEntry(key);
            if (activatedKeys.has(key)) {
                activatedCount++;
                channels.add(`activated:${key}`);
                evidence.push({ type: 'activated', loreKey: key, label: entry?.name || key });
            }
            const entryWords = [entry?.name, ...(entry?.keys || [])].map((item) => String(item || '').toLowerCase()).filter(Boolean);
            if (link.hint === 'subject' && entryWords.some((word) => subjects.has(word) || explicit.includes(word))) {
                subjectEstablished = true;
                channels.add(`subject:${key}`);
                evidence.push({ type: 'subject', loreKey: key, label: entry?.name || key });
            }
            const keyword = scoreEntryKeywords(entry, messages);
            if (keyword.score > 0) {
                channels.add(`keyword:${key}`);
                evidence.push({ type: 'keyword', loreKey: key, score: keyword.score, keys: keyword.keys });
            }
        }

        // Guarded on a non-empty name: `''.includes` of an empty needle is true,
        // so an unnamed Variable would otherwise be "directly named" by every
        // action, every note and every Goal description ever written.
        const needle = String(variable.name || '').toLowerCase();
        const direct = Boolean(needle) && explicit.includes(needle);
        if (direct) { channels.add('direct'); reasons.push('Directly named by the action.'); }
        const noted = Boolean(needle) && notebook.includes(needle);
        if (noted) { channels.add('notebook'); evidence.push({ type: 'notebook' }); }
        // The strong half of the Goal pull: a description naming a Variable
        // outright. The weak half — a description merely reading close to a
        // Variable's lore — is already carried by the semantic channel, since
        // the same descriptions seed the vector query.
        const namedByGoal = Boolean(needle) && goalText.includes(needle);
        if (namedByGoal) { channels.add('goaltext'); evidence.push({ type: 'goaltext' }); }
        const recall = recallShare(recallCounts, variable.id, recallWindow);
        if (recall > 0) { channels.add('recall'); evidence.push({ type: 'recall', share: recall }); }
        if (recentIds.has(variable.id) && variable.retrieval.continuity) { channels.add('continuity'); evidence.push({ type: 'continuity' }); }
        // `recall` is filtered out here — see SCORE_ONLY_CHANNELS. Left in, it
        // plus one activated link would reach two distinct links and
        // corroborate, which is the weakest and most circular signal in the
        // system quietly promoting a Variable the owner set to `corroborated`.
        const distinctLinks = new Set([...channels]
            .filter((channel) => !SCORE_ONLY_CHANNELS.has(channel))
            .map((channel) => channel.includes(':') ? channel.split(':').slice(1).join(':') : channel));
        const semanticLinks = new Set(semanticHits.filter((item) => item.channel === 'link').map((item) => item.loreKey));
        const corroborated = direct
            || subjectEstablished && (semanticLinks.size > 0 || activatedCount > 1 || evidence.some((item) => item.type === 'keyword'))
            || links.length === 1 && (activatedCount > 0 || semantic)
            || distinctLinks.size >= 2;
        const all = links.length > 0 && links.every((link) => {
            const key = entryKey(link);
            return activatedKeys.has(key) || semanticLinks.has(key) || evidence.some((item) => item.loreKey === key && item.type === 'keyword');
        });
        const any = direct || noted || namedByGoal || activatedCount > 0 || semantic || evidence.some((item) => item.type === 'keyword');
        const included = variable.retrieval.mode === 'always' || variable.retrieval.mode === 'all' && all
            || variable.retrieval.mode === 'any' && any || variable.retrieval.mode === 'corroborated' && corroborated;
        if (!reasons.length && included) {
            if (subjectEstablished) reasons.push('A linked subject is present in the scene.');
            if (activatedCount) reasons.push(`${activatedCount} linked Lorebook entr${activatedCount === 1 ? 'y is' : 'ies are'} active.`);
            if (semantic) reasons.push(`Semantically relevant at ${bestThreshold.toFixed(2)}.`);
            if (recentIds.has(variable.id)) reasons.push('Recently relevant state remains continuous.');
            if (noted) reasons.push('Named in a recent Loom note.');
            if (namedByGoal) reasons.push('Named in an active Goal.');
            if (variable.retrieval.mode === 'always') reasons.push('Configured as always available.');
        }
        // Rank orders candidates; it is not evidence. A semantic hit contributes a
        // flat amount because "it cleared the threshold" is all we actually know.
        const score = (direct ? DIRECT_WEIGHT : 0) + (subjectEstablished ? 0.5 : 0) + activatedCount * 0.35
            + (semantic ? 1 : 0) + (recentIds.has(variable.id) ? 0.1 : 0)
            + (noted ? NOTEBOOK_WEIGHT : 0) + (namedByGoal ? DIRECT_WEIGHT : 0) + recall * RECALL_WEIGHT
            + (variable.retrieval.mode === 'always' ? ALWAYS_FLOOR : 0);
        return {
            kind: 'variable', variable, id: String(variable.id), name: String(variable.name || ''),
            included, score, semantic, semanticThreshold: bestThreshold,
            channels: [...channels], reasons, evidence,
            exclusionReason: included ? '' : exclusion(variable, { semantic, activatedCount, subjectEstablished, channels }),
        };
    });

    const cap = Math.min(HARD_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    const ranked = [...variableItems, ...scoredGoals]
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    const selected = ranked.filter((item) => item.included).slice(0, cap);
    const chosen = new Set(selected);
    // An item that passed its gate and still did not travel was cut by the
    // budget, and the Retrieval view has to be able to say so — "it did not
    // surface" is the question those diagnostics exist to answer, and
    // "eligible, outranked" is a different answer from "ineligible".
    const diagnostics = ranked.map((item) => (item.included && !chosen.has(item)
        ? { ...item, exclusionReason: 'Eligible, but ranked below this turn’s retrieval budget.' }
        : item));
    return { selected, diagnostics };
}

/**
 * Score Goals against the action, the recent fiction, the Loom's notebook
 * and windowed recall. No vector channel: Goals have no lore links and no
 * indexed documents, and indexing them would add an embedding cost on every
 * Goal edit. Their text is short and distinctive, so name and keyword matching
 * is enough.
 *
 * Separate from retrieveRelevantState, and called before it, because these
 * scores are an input to the vector query the Variables need — the Goals that
 * scored are the ones whose descriptions seed it.
 */
export function scoreGoalRelevance({
    goals = [], explicitText = '', messages = [], notebookText = '',
    recallCounts = new Map(), recallWindow = DEFAULT_RECALL_WINDOW, pinnedGoalIds = [],
} = {}) {
    const explicit = String(explicitText || '').toLowerCase();
    const notebook = String(notebookText || '').toLowerCase();
    const pinned = new Set((pinnedGoalIds || []).map(String));
    return (goals || []).map((goal) => {
        const title = String(goal?.title || '');
        const needle = title.toLowerCase();
        const labels = [...(goal?.holderRefs || []), ...(goal?.targetRefs || [])]
            .map((ref) => String(ref?.label || '').toLowerCase()).filter(Boolean);
        const tokens = [...new Set([...distinctiveTokens(title), ...labels])];
        const channels = [];
        const reasons = [];
        let score = 0;

        // Full title first, token coverage second. A Goal is usually titled as a
        // sentence ("Find Rae before the party ends"), which almost never appears
        // verbatim in the fiction, so matching only the whole string would leave
        // this channel permanently dark.
        const inAction = needle && explicit.includes(needle) ? 1 : coverage(explicit, tokens);
        if (inAction >= 0.5) { channels.push('direct'); reasons.push('Named by the action.'); score += DIRECT_WEIGHT * inAction; }
        const inNotebook = needle && notebook.includes(needle) ? 1 : coverage(notebook, tokens);
        if (inNotebook >= 0.5) { channels.push('notebook'); reasons.push('Written about in a recent Loom note.'); score += NOTEBOOK_WEIGHT * inNotebook; }

        // The strongest single mention, not the sum of all of them: a Goal named
        // in six older messages should not outrank one named in the last.
        let strongest = 0;
        (messages || []).forEach((message, index) => {
            const share = coverage(message, tokens) * recencyWeight(index, messages.length);
            if (share > strongest) strongest = share;
        });
        if (strongest >= 0.5) { channels.push('keyword'); reasons.push('Present in the recent fiction.'); score += KEYWORD_WEIGHT * strongest; }

        const recall = recallShare(recallCounts, goal?.id, recallWindow);
        if (recall > 0) { channels.push('recall'); reasons.push('Retrieved on recent turns.'); score += RECALL_WEIGHT * recall; }

        const isPinned = pinned.has(String(goal?.id ?? ''));
        if (isPinned) { channels.push('attempted'); reasons.push('Attempted this turn.'); }
        if (!reasons.length) reasons.push('Carried as an open Goal.');

        return {
            kind: 'goal', goal, id: String(goal?.id ?? ''), name: title,
            // Always eligible. A Goal has no `retrieval.mode` to fail, so the
            // budget is the only thing that can keep it out.
            included: true, pinned: isPinned,
            score: score + (isPinned ? PINNED_BONUS : 0),
            channels, reasons, evidence: [], exclusionReason: '',
        };
    });
}

/**
 * How much of the recall window this item appeared in, as 0..1. Windowed on
 * purpose: an all-time counter would make whatever surfaced first keep
 * surfacing and the retrieved set would ossify around it. Stop pulling
 * something and its weight is gone.
 */
export function recallShare(recallCounts, id, window = DEFAULT_RECALL_WINDOW) {
    const size = Math.max(1, Math.floor(Number(window)) || DEFAULT_RECALL_WINDOW);
    const key = String(id ?? '');
    if (!key) return 0;
    const raw = recallCounts instanceof Map ? recallCounts.get(key) : recallCounts?.[key];
    const count = Math.max(0, Math.floor(Number(raw)) || 0);
    return Math.min(1, count / size);
}

/** Words worth matching on: long enough to be distinctive, minus the stopwords that survive that. */
export function distinctiveTokens(text) {
    const words = String(text || '').toLowerCase().match(TOKEN_PATTERN) || [];
    return [...new Set(words)].filter((word) => !STOPWORDS.has(word));
}

/** The share of `tokens` present in `text`, 0..1. Zero tokens means zero coverage, never a free pass. */
export function coverage(text, tokens) {
    const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
    if (!list.length) return 0;
    const haystack = String(text || '').toLowerCase();
    return list.filter((token) => haystack.includes(token)).length / list.length;
}

export function assignVariableRefs(selected) {
    const refToId = new Map();
    const listed = selected.map((item, index) => {
        const ref = `v${index + 1}`;
        refToId.set(ref, item.variable.id);
        return { ...item, ref };
    });
    return { listed, refToId };
}

/**
 * The Variable lines the Loom reads.
 *
 * Deliberately NO `[vN]` prefix. The refs assignVariableRefs hands out are an
 * internal bookkeeping key for the retrieval diagnostics and the State drawer;
 * printing them here put them directly beneath the prompt's own "Address each
 * one by the exact name below" instruction, which invited the model to reply
 * with a positional ref that bypassed name validation entirely. Design §3
 * specifies this exact shape — name, value, meaning — and nothing else the
 * model could mistake for an identifier.
 */
export function serializeRetrievedVariables(listed) {
    // Empty is empty, not a sentence. The prompt renderer decides what an empty
    // list MEANS — "this Timeline has none yet" and "none matched this turn" are
    // different things to tell a Loom, and only it knows which applies.
    if (!listed.length) return '';
    return listed.map(({ variable, reasons }) => {
        const subvalues = variable.subvalues.map((item) => `${item.label}: ${String(item.value)}`);
        return [`${variable.name}: ${String(variable.value)}`, ...subvalues, variable.description ? `Meaning: ${variable.description}` : '', reasons.length ? `Reason: ${reasons.join(' ')}` : ''].filter(Boolean).join('\n');
    }).join('\n\n');
}

export function recencyWeight(index, total) { return total <= 1 ? 1 : 0.25 + 0.75 * (Math.max(0, Math.min(total - 1, index)) / (total - 1)); }
export function countHits(text, keyword, { caseSensitive = false, matchWholeWords = false } = {}) {
    const needle = String(keyword || '').trim(); const haystack = String(text || '');
    if (!needle || !haystack) return 0;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = matchWholeWords ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped;
    return (haystack.match(new RegExp(pattern, caseSensitive ? 'g' : 'gi')) || []).length;
}

function scoreEntryKeywords(entry, messages) {
    if (!entry || entry.disabled) return { score: 0, keys: [] };
    let score = 0; const keys = [];
    messages.forEach((message, index) => {
        for (const keyword of [...(entry.keys || []), ...(entry.secondaryKeys || [])]) {
            const hits = countHits(message, keyword, entry);
            if (!hits) continue;
            score += hits * recencyWeight(index, messages.length); keys.push(keyword);
        }
    });
    return { score, keys: [...new Set(keys)] };
}
function groupVectors(matches) { const map = new Map(); for (const item of matches || []) { if (!map.has(item.variableId)) map.set(item.variableId, []); map.get(item.variableId).push(item); } return map; }
function exclusion(variable, detail) {
    if (variable.retrieval.mode === 'all') return 'Not every linked entry was established.';
    if (variable.retrieval.mode === 'corroborated') {
        return `Insufficient corroboration: ${detail.semantic ? 'a semantic match' : 'no semantic match'}, ${detail.activatedCount} active link${detail.activatedCount === 1 ? '' : 's'}${detail.subjectEstablished ? ', subject present' : ', subject absent'}. Corroborated retrieval needs two independent entries, a subject plus a concept, or a direct reference.`;
    }
    return 'No linked evidence reached the retrieval threshold.';
}
function lookup(source) { return source instanceof Map ? (key) => source.get(key) : (key) => source?.[key]; }

