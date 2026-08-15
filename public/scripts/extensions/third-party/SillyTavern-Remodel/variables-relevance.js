import { entryKey } from './variables-lore-key.js';

export const DEFAULT_WINDOW = 12;
export const DEFAULT_LIMIT = 6;
export const HARD_LIMIT = 12;
export const STRONG_SEMANTIC_SCORE = 0.82;

export function retrieveRelevantVariables({
    variables = [], entries = new Map(), messages = [], vectorMatches = [], activatedKeys = new Set(),
    presentSubjects = [], goalVariableIds = [], explicitText = '', recentVariableIds = [], limit = DEFAULT_LIMIT,
} = {}) {
    const getEntry = lookup(entries);
    const subjects = new Set(presentSubjects.map((item) => String(item || '').toLowerCase()).filter(Boolean));
    const goalIds = new Set(goalVariableIds.map(String));
    const recentIds = new Set(recentVariableIds.map(String));
    const explicit = String(explicitText || '').toLowerCase();
    const vectorByVariable = groupVectors(vectorMatches);

    const ranked = variables.map((variable) => {
        const channels = new Set();
        const reasons = [];
        const evidence = [];
        const links = variable.loreLinks || [];
        const vectors = vectorByVariable.get(variable.id) || [];
        const bestVector = vectors.reduce((best, item) => Math.max(best, normalizeScore(item.score)), 0);
        for (const item of vectors) {
            if (normalizeScore(item.score) >= variable.retrieval.semanticThreshold) {
                channels.add(item.channel === 'link' ? `semantic:${item.loreKey}` : 'semantic:self');
                evidence.push({ type: 'semantic', score: normalizeScore(item.score), loreKey: item.loreKey || '' });
            }
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

        const direct = goalIds.has(variable.id) || explicit.includes(variable.name.toLowerCase());
        if (direct) { channels.add('direct'); reasons.push('Directly referenced by the action or a Goal.'); }
        if (recentIds.has(variable.id) && variable.retrieval.continuity) { channels.add('continuity'); evidence.push({ type: 'continuity' }); }
        const distinctLinks = new Set([...channels].map((channel) => channel.includes(':') ? channel.split(':').slice(1).join(':') : channel));
        const semanticLinks = new Set(vectors.filter((item) => item.channel === 'link' && normalizeScore(item.score) >= variable.retrieval.semanticThreshold).map((item) => item.loreKey));
        const corroborated = direct || bestVector >= STRONG_SEMANTIC_SCORE
            || subjectEstablished && (semanticLinks.size > 0 || activatedCount > 1 || evidence.some((item) => item.type === 'keyword'))
            || links.length === 1 && (activatedCount > 0 || bestVector >= variable.retrieval.semanticThreshold)
            || distinctLinks.size >= 2;
        const all = links.length > 0 && links.every((link) => {
            const key = entryKey(link);
            return activatedKeys.has(key) || semanticLinks.has(key) || evidence.some((item) => item.loreKey === key && item.type === 'keyword');
        });
        const any = direct || activatedCount > 0 || bestVector >= variable.retrieval.semanticThreshold || evidence.some((item) => item.type === 'keyword');
        const included = variable.retrieval.mode === 'always' || variable.retrieval.mode === 'all' && all
            || variable.retrieval.mode === 'any' && any || variable.retrieval.mode === 'corroborated' && corroborated;
        if (!reasons.length && included) {
            if (subjectEstablished) reasons.push('A linked subject is present in the scene.');
            if (activatedCount) reasons.push(`${activatedCount} linked Lorebook entr${activatedCount === 1 ? 'y is' : 'ies are'} active.`);
            if (bestVector) reasons.push(`Semantic relevance ${bestVector.toFixed(2)}.`);
            if (recentIds.has(variable.id)) reasons.push('Recently relevant state remains continuous.');
            if (variable.retrieval.mode === 'always') reasons.push('Configured as always available.');
        }
        const score = (direct ? 2 : 0) + (subjectEstablished ? 0.5 : 0) + activatedCount * 0.35 + bestVector + (recentIds.has(variable.id) ? 0.1 : 0);
        return { variable, included, score, semanticScore: bestVector, reasons, evidence, exclusionReason: included ? '' : exclusion(variable, { bestVector, activatedCount, subjectEstablished, channels }) };
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

export function serializeRetrievedVariables(listed) {
    if (!listed.length) return 'No relevant Variables were retrieved.';
    return listed.map(({ ref, variable, reasons }) => {
        const subvalues = variable.subvalues.map((item) => `${item.label}: ${String(item.value)}`);
        return [`[${ref}] ${variable.name}: ${String(variable.value)}`, ...subvalues, variable.description ? `Meaning: ${variable.description}` : '', reasons.length ? `Reason: ${reasons.join(' ')}` : ''].filter(Boolean).join('\n');
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
function normalizeScore(value) { const score = Number(value); if (!Number.isFinite(score)) return 0; return Math.max(0, Math.min(1, score)); }
function exclusion(variable, detail) { if (variable.retrieval.mode === 'all') return 'Not every linked entry was established.'; if (variable.retrieval.mode === 'corroborated') return `Insufficient corroboration (semantic ${detail.bestVector.toFixed(2)}, ${detail.activatedCount} active links).`; return 'No linked evidence reached the retrieval threshold.'; }
function lookup(source) { return source instanceof Map ? (key) => source.get(key) : (key) => source?.[key]; }

