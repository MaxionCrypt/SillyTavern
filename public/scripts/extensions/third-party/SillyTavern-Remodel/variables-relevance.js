import { entryKey } from './variables-lore-key.js';

export const DEFAULT_WINDOW = 12;
export const DEFAULT_LIMIT = 6;
export const HARD_LIMIT = 12;

// There is deliberately no STRONG_SEMANTIC_SCORE here. The spec allowed one
// very strong semantic match (>= 0.82) to corroborate a Variable on its own,
// but SillyTavern's vector endpoint filters by similarity and then discards it,
// so no similarity value ever reaches this code. The previous implementation
// synthesised one from result rank across [0.70, 0.84], which meant the
// top-ranked document always cleared 0.82 and every request corroborated its
// first hit unconditionally. A match now means "the server confirmed this
// cleared the threshold we asked for" — a boolean — so corroboration needs a
// second, independent channel.

export function retrieveRelevantVariables({
    variables = [], entries = new Map(), messages = [], vectorMatches = [], activatedKeys = new Set(),
    presentSubjects = [], explicitText = '', recentVariableIds = [], limit = DEFAULT_LIMIT,
} = {}) {
    const getEntry = lookup(entries);
    const subjects = new Set(presentSubjects.map((item) => String(item || '').toLowerCase()).filter(Boolean));
    const recentIds = new Set(recentVariableIds.map(String));
    const explicit = String(explicitText || '').toLowerCase();
    const vectorByVariable = groupVectors(vectorMatches);

    const ranked = variables.map((variable) => {
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

        const direct = explicit.includes(variable.name.toLowerCase());
        if (direct) { channels.add('direct'); reasons.push('Directly named by the action.'); }
        if (recentIds.has(variable.id) && variable.retrieval.continuity) { channels.add('continuity'); evidence.push({ type: 'continuity' }); }
        const distinctLinks = new Set([...channels].map((channel) => channel.includes(':') ? channel.split(':').slice(1).join(':') : channel));
        const semanticLinks = new Set(semanticHits.filter((item) => item.channel === 'link').map((item) => item.loreKey));
        const corroborated = direct
            || subjectEstablished && (semanticLinks.size > 0 || activatedCount > 1 || evidence.some((item) => item.type === 'keyword'))
            || links.length === 1 && (activatedCount > 0 || semantic)
            || distinctLinks.size >= 2;
        const all = links.length > 0 && links.every((link) => {
            const key = entryKey(link);
            return activatedKeys.has(key) || semanticLinks.has(key) || evidence.some((item) => item.loreKey === key && item.type === 'keyword');
        });
        const any = direct || activatedCount > 0 || semantic || evidence.some((item) => item.type === 'keyword');
        const included = variable.retrieval.mode === 'always' || variable.retrieval.mode === 'all' && all
            || variable.retrieval.mode === 'any' && any || variable.retrieval.mode === 'corroborated' && corroborated;
        if (!reasons.length && included) {
            if (subjectEstablished) reasons.push('A linked subject is present in the scene.');
            if (activatedCount) reasons.push(`${activatedCount} linked Lorebook entr${activatedCount === 1 ? 'y is' : 'ies are'} active.`);
            if (semantic) reasons.push(`Semantically relevant at ${bestThreshold.toFixed(2)}.`);
            if (recentIds.has(variable.id)) reasons.push('Recently relevant state remains continuous.');
            if (variable.retrieval.mode === 'always') reasons.push('Configured as always available.');
        }
        // Rank orders candidates; it is not evidence. A semantic hit contributes a
        // flat amount because "it cleared the threshold" is all we actually know.
        const score = (direct ? 2 : 0) + (subjectEstablished ? 0.5 : 0) + activatedCount * 0.35
            + (semantic ? 1 : 0) + (recentIds.has(variable.id) ? 0.1 : 0);
        return {
            variable, included, score, semantic, semanticThreshold: bestThreshold,
            channels: [...channels], reasons, evidence,
            exclusionReason: included ? '' : exclusion(variable, { semantic, activatedCount, subjectEstablished, channels }),
        };
    }).sort((left, right) => right.score - left.score || left.variable.name.localeCompare(right.variable.name));

    const cap = Math.min(HARD_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
    return { selected: ranked.filter((item) => item.included).slice(0, cap), diagnostics: ranked };
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
 * The Variable lines the Director reads.
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
    if (!listed.length) return 'No relevant Variables were retrieved.';
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

