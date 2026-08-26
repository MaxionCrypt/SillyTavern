const DEFAULT_LIMITS = Object.freeze({ sourceChars: 1600, totalChars: 8000 });
const DEFAULT_BUDGET = Object.freeze({ maxEntries: 12, maxTokens: 1800 });

/** Build the same bounded, labelled query for composer prefetch and Send. */
export function buildWorldSenseQueryPacket(input = {}, limits = {}) {
    const bounded = { ...DEFAULT_LIMITS, ...limits };
    const sources = [
        source('action', 'Current action', input.action),
        source('thread', 'Open thread', input.openThread),
        source('goals', 'Goal pressures', lines(input.goals, describeGoal)),
        source('history', 'Accepted recent prose', lines(input.history, describeHistory)),
        source('archive', 'Archive state', lines(input.archive, describeArchive)),
        source('cast', 'Present cast', lines(input.cast, describeCast)),
        source('location', 'Current location', input.location),
        source('premise', 'Timeline premise', input.premise),
        source('search', 'Explicit search', input.searchTerms),
        source('pins', 'One-turn pins', lines(input.pins, describePin)),
    ].filter((item) => item.text);
    let remaining = Math.max(200, Number(bounded.totalChars) || DEFAULT_LIMITS.totalChars);
    const clipped = [];
    for (const item of sources) {
        if (remaining <= 0) break;
        const text = item.text.slice(0, Math.min(remaining, Math.max(80, Number(bounded.sourceChars) || DEFAULT_LIMITS.sourceChars))).trim();
        if (!text) continue;
        clipped.push({ ...item, text });
        remaining -= text.length;
    }
    const text = clipped.map((item) => `[${item.label}]\n${item.text}`).join('\n\n');
    return { hash: hashString(text), text, sources: clipped, length: text.length };
}

export function canReuseWorldSensePrefetch(cached, queryHash, now = Date.now(), ttlMs = 120000) {
    return Boolean(
        cached
        && cached.queryHash === String(queryHash || '')
        && Number(now) - Number(cached.createdAt) >= 0
        && Number(now) - Number(cached.createdAt) < Number(ttlMs),
    );
}

/** Pure hybrid ranker. It never activates or writes a native lore entry. */
export function rankLivingLore({
    packet, entries = [], semanticMatches = [], metadata = [], goals = [], variables = [], pins = [], continuity = [], budget = {},
    semanticThreshold = 0.30, semanticOnlyLimit = 3,
} = {}) {
    const candidates = scoreLivingLoreCandidates({ packet, entries, semanticMatches, metadata, goals, variables, pins, continuity, semanticThreshold });
    const ranking = selectWorldSenseCandidates(candidates, { budget, semanticOnlyLimit });
    const selectedKeys = new Set(ranking.selected.filter((item) => item.kind !== 'continuity').map(entryKey));
    return {
        ...ranking,
        propagation: {
            goalIds: linkedRecordIds(goals, selectedKeys),
            variableIds: linkedRecordIds(variables, selectedKeys),
        },
    };
}

/** Score lore without spending the shared World Sense prompt budget yet. */
export function scoreLivingLoreCandidates({
    packet, entries = [], semanticMatches = [], metadata = [], goals = [], variables = [], pins = [], continuity = [],
    semanticThreshold = 0.30,
} = {}) {
    const candidates = new Map();
    const metadataByKey = new Map(metadata.map((item) => [entryKey(item), item]));
    const semanticByKey = new Map(semanticMatches.map((item, index) => [entryKey(item), { ...item, rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : index }]));
    const pinKeys = new Set(pins.map(entryKey).filter(Boolean));
    const continuityKeys = new Set(continuity.map(entryKey).filter(Boolean));
    const goalLinks = linkEvidence(goals, 'goal');
    const variableLinks = linkEvidence(variables, 'variable');

    for (const entry of entries) {
        const key = entryKey(entry);
        if (!key) continue;
        const sidecar = metadataByKey.get(key);
        if (entry.native?.disable || sidecar?.worldSense?.excluded) continue;
        const candidate = { kind: 'lore', key, entry, score: 0, reasons: [], forced: false, tokenCost: estimateEntryTokens(entry) };
        if (entry.native?.constant) add(candidate, 120, 'native.constant');
        if (pinKeys.has(key) || sidecar?.worldSense?.pinned) add(candidate, 140, 'pin');
        candidate.forced = candidate.reasons.some((reason) => reason.channel === 'native.constant' || reason.channel === 'pin');

        const semantic = semanticByKey.get(key);
        if (semantic) {
            const similarity = Number(semantic.score);
            if (!Number.isFinite(similarity) || similarity >= Number(semanticThreshold)) {
                const points = Number.isFinite(similarity)
                    ? Math.max(12, Math.round(20 + similarity * 60))
                    : Math.max(12, 52 - semantic.rank * 3);
                add(candidate, points, 'semantic', {
                    rank: semantic.rank,
                    ...(Number.isFinite(similarity) ? { similarity } : {}),
                });
            }
        }
        for (const evidence of goalLinks.get(key) || []) add(candidate, 34, 'goal.link', evidence);
        for (const evidence of variableLinks.get(key) || []) add(candidate, 26, 'variable.link', evidence);
        scoreKeywords(candidate, packet?.sources || []);
        // Continuity stabilizes an entry that is relevant again; it is not
        // independent evidence. Otherwise one noisy semantic selection would
        // perpetuate itself forever after its similarity fell below the floor.
        if (continuityKeys.has(key) && candidate.score > 0) add(candidate, 14, 'continuity');
        candidates.set(key, candidate);
    }

    // A relevant entry lends a smaller amount of relevance to entries it links.
    // This is one bounded hop: relationships inform retrieval without turning
    // a dense lore graph into an always-on prompt.
    for (const candidate of [...candidates.values()]) {
        if (candidate.score <= 0) continue;
        for (const link of metadataByKey.get(candidate.key)?.links || []) {
            const target = candidates.get(entryKey(link?.target));
            if (target) add(target, 12, 'lore.link', { from: candidate.key, relation: link.relation || 'related' });
        }
    }

    return [...candidates.values()];
}

/** Apply one entry/token budget across lore and recalled continuity. */
export function selectWorldSenseCandidates(candidates = [], { budget = {}, semanticOnlyLimit = 3, continuityLimit = 4, continuityHardLimit = 8 } = {}) {
    const limits = { ...DEFAULT_BUDGET, ...budget };
    const ranked = [...candidates].sort(compareCandidates);
    const selected = [];
    const rejected = [];
    let tokens = 0;
    let semanticOnlyUsed = 0;
    let continuityUsed = 0;
    for (const candidate of ranked) {
        if (!candidate.forced && candidate.score <= 0) {
            rejected.push(receiptCandidate(candidate, 'no-evidence'));
            continue;
        }
        if (candidate.kind === 'continuity' && continuityUsed >= positive(continuityHardLimit, 8)) {
            rejected.push(receiptCandidate(candidate, 'continuity-hard-limit'));
            continue;
        }
        const semanticOnly = candidate.kind === 'lore' && candidate.reasons.length > 0 && candidate.reasons.every((reason) => reason.channel === 'semantic');
        if (!candidate.forced && semanticOnly && semanticOnlyUsed >= positive(semanticOnlyLimit, 3)) {
            rejected.push(receiptCandidate(candidate, 'semantic-only-limit'));
            continue;
        }
        if (!candidate.forced && candidate.kind === 'continuity' && continuityUsed >= positive(continuityLimit, 4)) {
            rejected.push(receiptCandidate(candidate, 'continuity-limit'));
            continue;
        }
        const entryLimit = selected.length >= positive(limits.maxEntries, DEFAULT_BUDGET.maxEntries);
        const tokenLimit = tokens + candidate.tokenCost > positive(limits.maxTokens, DEFAULT_BUDGET.maxTokens);
        if (!candidate.forced && (entryLimit || tokenLimit)) {
            rejected.push(receiptCandidate(candidate, entryLimit ? 'entry-budget' : 'token-budget'));
            continue;
        }
        selected.push(receiptCandidate(candidate, candidate.forced && (entryLimit || tokenLimit) ? 'forced-over-budget' : 'selected'));
        if (semanticOnly) semanticOnlyUsed += 1;
        if (candidate.kind === 'continuity') continuityUsed += 1;
        tokens += candidate.tokenCost;
    }
    return {
        selected,
        rejected,
        budget: {
            maxEntries: positive(limits.maxEntries, DEFAULT_BUDGET.maxEntries),
            maxTokens: positive(limits.maxTokens, DEFAULT_BUDGET.maxTokens),
            usedEntries: selected.length,
            usedTokens: tokens,
            overflow: selected.some((item) => item.decision === 'forced-over-budget'),
        },
    };
}

function linkedRecordIds(records, selectedKeys) {
    return (records || []).filter((record) => (record.loreLinks || []).some((link) => selectedKeys.has(entryKey(link))))
        .map((record) => String(record.id || '')).filter(Boolean);
}

function scoreKeywords(candidate, sources) {
    const primary = candidate.entry.keys || [];
    const secondary = candidate.entry.secondaryKeys || [];
    for (const item of sources) {
        const haystack = normalize(item.text);
        const primaryHits = primary.filter((key) => phraseMatch(haystack, key));
        const secondaryHits = secondary.filter((key) => phraseMatch(haystack, key));
        if (primaryHits.length) add(candidate, 58 + Math.min(18, (primaryHits.length - 1) * 6), `${item.kind}.primary`, { keys: primaryHits });
        if (secondaryHits.length && (primaryHits.length || !candidate.entry.native?.selective)) {
            add(candidate, 18 + Math.min(8, (secondaryHits.length - 1) * 4), `${item.kind}.secondary`, { keys: secondaryHits });
        }
    }
}

function linkEvidence(records, kind) {
    const map = new Map();
    for (const record of records || []) {
        for (const link of record?.loreLinks || []) {
            const key = entryKey(link);
            if (!key) continue;
            const bucket = map.get(key) || [];
            bucket.push({ id: String(record.id || ''), label: String(record.title || record.name || ''), type: link.type || kind });
            map.set(key, bucket);
        }
    }
    return map;
}

function add(candidate, points, channel, detail = {}) {
    candidate.score += points;
    candidate.reasons.push({ channel, points, ...detail });
}

function receiptCandidate(candidate, decision) {
    if (candidate.kind === 'continuity') {
        return {
            kind: 'continuity', key: candidate.key,
            sceneId: candidate.record.sceneId, sceneTitle: candidate.record.sceneTitle, sceneMode: candidate.record.sceneMode,
            arcId: candidate.record.arcId, arcTitle: candidate.record.arcTitle,
            recordType: candidate.record.recordType, recordId: candidate.record.recordId, text: candidate.record.text,
            score: candidate.score, tokenCost: candidate.tokenCost, forced: candidate.forced, decision, reasons: candidate.reasons,
        };
    }
    return {
        book: candidate.entry.book,
        uid: candidate.entry.uid,
        name: candidate.entry.name,
        score: candidate.score,
        tokenCost: candidate.tokenCost,
        forced: candidate.forced,
        decision,
        reasons: candidate.reasons,
    };
}

function compareCandidates(left, right) {
    if (left.forced !== right.forced) return left.forced ? -1 : 1;
    if (left.score !== right.score) return right.score - left.score;
    return left.key.localeCompare(right.key);
}

function source(kind, label, value) {
    const text = String(value ?? '').trim();
    return { kind, label, text };
}

function lines(value, formatter) {
    return (Array.isArray(value) ? value : []).map(formatter).filter(Boolean).join('\n');
}

function describeGoal(goal) { return `${goal.title || goal.name || ''}: ${goal.description || ''}`.trim(); }
function describeHistory(item) { return `${item.name || item.role || ''}: ${item.content || item.mes || item.text || ''}`.trim(); }
function describeArchive(item) { return `${item.label || item.key || item.charId || ''}: ${item.value ?? item.summary ?? item.text ?? describeFacets(item.facets)}`.trim(); }
function describeCast(item) { return `${item.label || item.name || ''}: ${item.description || item.personality || ''}`.trim(); }
function describePin(item) { return `${item.name || ''} ${item.book || ''} ${item.uid ?? ''}`.trim(); }
function describeFacets(facets) { return Object.entries(facets || {}).map(([key, value]) => `${key}=${value}`).join(', '); }
function estimateEntryTokens(entry) { return Math.max(1, Math.ceil(`${entry.name || ''}\n${entry.content || ''}`.length / 4)); }
function normalize(value) { return ` ${String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}_'-]+/gu, ' ').replace(/\s+/g, ' ').trim()} `; }
function phraseMatch(haystack, needle) { const phrase = normalize(needle).trim(); return Boolean(phrase) && haystack.includes(` ${phrase} `); }
function entryKey(value) { const book = String(value?.book ?? value?.world ?? '').trim(); const uid = String(value?.uid ?? '').trim(); return book && uid ? `${book}.${uid}` : ''; }
function positive(value, fallback) { const number = Math.floor(Number(value)); return Number.isFinite(number) && number > 0 ? number : fallback; }

function hashString(value) {
    let hash = 0xcbf29ce484222325n;
    for (const character of String(value || '')) {
        hash ^= BigInt(character.codePointAt(0));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}
