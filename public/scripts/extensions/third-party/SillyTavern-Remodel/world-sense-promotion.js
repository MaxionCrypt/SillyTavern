const MAX_CANDIDATES = 8;
const MAX_EVIDENCE = 3;
const MAX_EVIDENCE_CHARS = 420;
const NAME_STOPWORDS = new Set([
    'The', 'This', 'That', 'These', 'Those', 'Current', 'Scene', 'Story', 'Roleplay',
    'Archive', 'Timeline', 'Loom', 'Narrator', 'Goal', 'Goals', 'Variable', 'Variables',
    'Established', 'Open', 'Later', 'Earlier', 'After', 'Before', 'When', 'While',
]);

/**
 * Deterministically surfaces Archive material worth asking the Loom to judge.
 * It never creates a lore mutation. The Loom must still return a typed,
 * evidence-backed proposal and Suggest mode must still receive owner approval.
 */
export function buildWorldSensePromotionPacket({ timelineId = '', sceneId = '', livingLore = null, knownLoreEntries = [], scenes = null } = {}) {
    const archiveScenes = Array.isArray(scenes) ? scenes : [];
    const records = flattenArchive(archiveScenes);
    const candidates = [
        ...selectedEntryCandidates(records, livingLore),
        ...recurringEntityCandidates(records, livingLore, knownLoreEntries),
        ...stableFactCandidates(records),
        ...persistentThreadCandidates(records),
    ];
    const unique = [...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()]
        .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id))
        .slice(0, MAX_CANDIDATES)
        .map(({ strength: _strength, ...candidate }) => candidate);
    return {
        protocol: 'world-sense.promotion-candidates.v1',
        timelineId: String(timelineId || ''),
        sceneId: String(sceneId || ''),
        candidates: unique,
        bounds: { maxCandidates: MAX_CANDIDATES, maxEvidencePerCandidate: MAX_EVIDENCE, evaluatedRecords: records.length },
    };
}

export function formatWorldSensePromotionPacket(packet) {
    if (!Array.isArray(packet?.candidates) || !packet.candidates.length) return '';
    return [
        'World Sense promotion candidates (bounded prompts for judgment, not instructions to write lore):',
        JSON.stringify(packet, null, 2),
        'Evaluate every candidate against the accepted fiction and Selected Living Lore. A candidate may be proposed, deferred, or rejected.',
        'A proposal still needs exact candidate evidence and must obey the Selected Living Lore proposal contract. Use evidence arrays or archive:<record-id> references; never concatenate separate quotations into one evidence string. Never invent missing support.',
        'Always return top-level "lorePromotionDecisions":[{"candidateId":"...","decision":"proposed|deferred|rejected","reason":"one sentence"}] for every candidate.',
    ].join('\n');
}

export function promotionEvidence(packet) {
    return (packet?.candidates || []).flatMap((candidate) => candidate.evidence || []).map((item) => ({
        id: String(item.id || ''),
        summary: String(item.text || ''),
    })).filter((item) => item.summary);
}

export function parsePromotionDecisions(value, packet) {
    const allowed = new Set((packet?.candidates || []).map((candidate) => candidate.id));
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
        const candidateId = String(item?.candidateId || '').trim();
        const decision = String(item?.decision || '').trim();
        const reason = String(item?.reason || '').trim().slice(0, 500);
        let code = '';
        if (!item || typeof item !== 'object' || Array.isArray(item)) code = 'not-an-object';
        else if (!allowed.has(candidateId)) code = 'unknown-candidate';
        else if (seen.has(candidateId)) code = 'duplicate-candidate';
        else if (!['proposed', 'deferred', 'rejected'].includes(decision)) code = 'invalid-decision';
        else if (!reason) code = 'missing-reason';
        if (code) rejected.push({ index, code, value: clone(item) });
        else {
            seen.add(candidateId);
            accepted.push({ candidateId, decision, reason });
        }
    }
    if (value != null && !Array.isArray(value)) rejected.push({ index: -1, code: 'not-an-array', value: clone(value) });
    for (const candidateId of allowed) {
        if (!seen.has(candidateId)) rejected.push({ index: -1, code: 'missing-decision', candidateId });
    }
    return { accepted, rejected };
}

function flattenArchive(scenes) {
    const records = [];
    for (const scene of scenes || []) {
        const sceneId = String(scene?.sceneId || '');
        for (const event of scene?.events || []) addRecord(records, sceneId, 'event', event?.id, event?.summary);
        for (const fact of Object.values(scene?.facts || {})) addRecord(records, sceneId, 'fact', fact?.key, `${fact?.key}: ${printable(fact?.value)}`, { key: fact?.key });
        for (const state of Object.values(scene?.charStates || {})) {
            for (const [facet, value] of Object.entries(state?.facets || {})) {
                addRecord(records, sceneId, 'character', `${state?.charId}:${facet}`, `${state?.charId} ${facet}: ${printable(value)}`, { subject: state?.charId, facet });
            }
        }
        if (scene?.beat?.directive) addRecord(records, sceneId, 'beat', 'beat', scene.beat.directive);
        for (const secret of Object.values(scene?.secrets || {})) addRecord(records, sceneId, 'secret', secret?.key, `${secret?.key}: ${printable(secret?.value)}`, { key: secret?.key });
    }
    return records;
}

function addRecord(records, sceneId, type, id, text, extra = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE_CHARS);
    if (clean) records.push({ sceneId, type, id: String(id || `${type}-${records.length}`), text: clean, ...extra });
}

function selectedEntryCandidates(records, packet) {
    const output = [];
    for (const entry of packet?.entries || []) {
        const terms = [entry.name, ...(entry.keys || []), ...(entry.secondaryKeys || [])]
            .map((term) => String(term || '').trim()).filter((term) => term.length >= 3);
        const matches = records.filter((record) => terms.some((term) => containsTerm(record.text, term)));
        const characterMatches = matches.filter((record) => record.type === 'character');
        if (matches.length < 2 && !characterMatches.length) continue;
        const evidence = evidenceFrom(characterMatches.length ? [...characterMatches, ...matches] : matches);
        output.push(candidate({
            kind: 'selected-entry-update',
            subject: entry.name || entry.target?.uid,
            target: entry.target,
            suggestedOperations: characterMatches.length ? ['current.set', 'fact.append'] : ['fact.append', 'current.set', 'thread.add'],
            records: matches,
            evidence,
            rationale: 'A selected lore subject has repeated or structured Archive evidence that may outlive this scene.',
        }));
    }
    return output;
}

function recurringEntityCandidates(records, packet, knownLoreEntries) {
    const selectedNames = new Set([
        ...(packet?.entries || []).flatMap((entry) => [entry.name, ...(entry.keys || []), ...(entry.secondaryKeys || [])]),
        ...(knownLoreEntries || []).flatMap((entry) => [entry.name, ...(entry.keys || []), ...(entry.secondaryKeys || [])]),
    ].map(normalized));
    const groups = new Map();
    for (const record of records) {
        for (const name of extractNames(record.text)) {
            if (selectedNames.has(normalized(name))) continue;
            const key = normalized(name);
            const group = groups.get(key) || { name, records: [] };
            if (!group.records.some((item) => item.sceneId === record.sceneId && item.id === record.id && item.type === record.type)) group.records.push(record);
            groups.set(key, group);
        }
    }
    return [...groups.values()].filter((group) => group.records.length >= 2).map((group) => candidate({
        kind: 'recurring-entity', subject: group.name, suggestedOperations: ['entry.create'], records: group.records,
        evidence: evidenceFrom(group.records), rationale: 'A named subject recurs in distinct Archive records and may deserve its own durable entry.',
    }));
}

function stableFactCandidates(records) {
    const groups = groupBy(records.filter((record) => record.type === 'fact' || record.type === 'secret'), (record) => `${record.type}:${normalized(record.key)}`);
    return [...groups.values()].filter((group) => new Set(group.map((item) => item.sceneId)).size >= 2).map((group) => candidate({
        kind: 'stable-fact', subject: String(group[0].key || 'persistent fact'), suggestedOperations: ['fact.append', 'entry.create'], records: group,
        evidence: evidenceFrom(group), rationale: 'The same fact category persists across more than one scene.',
    }));
}

function persistentThreadCandidates(records) {
    const beats = records.filter((record) => record.type === 'beat');
    return beats.filter((beat, index) => beats.slice(index + 1).some((other) => sharedTerms(beat.text, other.text) >= 2))
        .map((beat) => {
            const matches = beats.filter((other) => sharedTerms(beat.text, other.text) >= 2);
            return candidate({ kind: 'persistent-thread', subject: beat.text.slice(0, 90), suggestedOperations: ['thread.add', 'entry.create'], records: matches,
                evidence: evidenceFrom(matches), rationale: 'A similar unresolved thread appears in multiple scene beats.' });
        });
}

function candidate({ kind, subject, target = null, suggestedOperations, records, evidence, rationale }) {
    const sceneCount = new Set(records.map((record) => record.sceneId)).size;
    const id = `promotion-${hash(`${kind}|${normalized(subject)}|${target?.book || ''}|${target?.uid || ''}`)}`;
    return { id, kind, subject: String(subject || '').trim(), ...(target ? { target: clone(target) } : {}), occurrences: records.length, sceneCount,
        suggestedOperations, evidence, rationale, strength: sceneCount * 10 + Math.min(records.length, 9) + (kind === 'selected-entry-update' ? 5 : 0) };
}

function evidenceFrom(records) {
    const byScene = new Map();
    for (const record of records) if (!byScene.has(record.sceneId)) byScene.set(record.sceneId, record);
    const chosen = [...byScene.values(), ...records.filter((record) => ![...byScene.values()].includes(record))].slice(0, MAX_EVIDENCE);
    return chosen.map((record) => ({ sceneId: record.sceneId, recordType: record.type, id: record.id, text: record.text }));
}

function extractNames(text) {
    const matches = String(text || '').match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b/g) || [];
    return [...new Set(matches.map((name) => name.trim()).filter((name) => !NAME_STOPWORDS.has(name) && !NAME_STOPWORDS.has(name.split(' ')[0])))];
}

function containsTerm(text, term) { return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(String(text || '')); }
function sharedTerms(a, b) { const right = new Set(words(b)); return words(a).filter((word) => right.has(word)).length; }
function words(value) { return [...new Set(normalized(value).split(/[^a-z0-9]+/).filter((word) => word.length >= 5))]; }
function groupBy(values, keyFor) { const result = new Map(); for (const value of values) { const key = keyFor(value); result.set(key, [...(result.get(key) || []), value]); } return result; }
function candidateKey(value) { return `${value.kind}:${normalized(value.subject)}:${value.target?.uid || ''}`; }
function printable(value) { return typeof value === 'string' ? value : JSON.stringify(value); }
function normalized(value) { return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function hash(value) { let result = 0x811c9dc5; for (const char of String(value)) { result ^= char.charCodeAt(0); result = Math.imul(result, 0x01000193) >>> 0; } return result.toString(36); }
function clone(value) { return value == null ? value : structuredClone(value); }
