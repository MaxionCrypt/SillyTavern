import { listLoreEntries, entryKey } from './variables-lore.js';
import { assignVariableRefs, retrieveRelevantVariables, serializeRetrievedVariables } from './variables-relevance.js';
import { listVariableEvents, listVariableValues, getMechanicsProfile } from './variables-store.js';
import { queryVariableVectors } from './variables-vector.js';
import { recordDebugEvent } from './debug-console.js';

/**
 * Diagnostics for one retrieval pass.
 *
 * `recordDebugEvent` redacts on KEY NAME before it looks at the value, so a key
 * merely containing `text`, `content`, `history`, `description` or `token` is
 * blanked even when it holds a count. Everything here is therefore named to
 * clear that filter, and carries lengths, counts and verdicts — never prose.
 * The query itself is never logged; only how big it was.
 */
function journal(type, detail = {}, { severity = 'info', correlationId = null, summary = '' } = {}) {
    try {
        recordDebugEvent('variables', type, detail, { severity, correlationId, summary: summary || type });
    } catch {
        // Diagnostics must never be able to break a generation.
    }
}

/**
 * Resolve the small, temporary Variable address book for one request.
 * Persistent IDs stay in refToId and are never serialized for the model.
 *
 * @param {string} correlationId ties these records to the direction pass that
 *   asked for them, so one response reads as a single thread in the journal.
 */
export async function resolveVariableContext({
    timelineId, action = '', history = [], cast = [], activatedEntries = [], goals = [], limit = 0, correlationId = null,
} = {}) {
    const id = String(timelineId || '');
    if (!id) return emptyContext('No Timeline is active.', correlationId);
    const variables = listVariableValues({ timelineId: id });
    if (!variables.length) return emptyContext('This Timeline has no Variables.', correlationId);

    const profile = getMechanicsProfile();
    const windowSize = profile.retrievalWindow || 12;
    const lore = await listLoreEntries();
    const entries = new Map(lore.map((entry) => [entryKey(entry), entry]));
    const activatedKeys = new Set([...activatedEntries].map(entryKey).filter(Boolean));
    const historyText = history.map((item) => String(item?.content ?? item?.mes ?? item ?? '')).filter(Boolean);
    const subjects = cast.flatMap((item) => [item?.label, item?.name, item?.ref?.label]).filter(Boolean);
    const goalVariableIds = goals.flatMap((goal) => [
        goal?.resolution?.variableId,
        goal?.resolution?.variableInstanceId,
    ]).filter(Boolean);
    const recentVariableIds = listVariableEvents({ timelineId: id }).slice(-30).map((event) => event.variableId).filter(Boolean);
    const query = buildVariableQuery({ action, historyText, subjects, activatedKeys, entries, goals, windowSize });

    journal('retrieval.begin', {
        timelineId: id, variableCount: variables.length, queryChars: query.length, windowSize,
        castCount: subjects.length, activatedCount: activatedKeys.size, goalCount: goals.length,
        goalLinkedCount: goalVariableIds.length, recentCount: recentVariableIds.length,
    }, { correlationId, summary: `Retrieving from ${variables.length} Variables` });

    // One query per distinct threshold in play — see queryVariableVectors.
    const thresholds = [...new Set(variables.map((variable) => variable.retrieval.semanticThreshold))];
    const vectors = query.trim()
        ? await queryVariableVectors(id, query, { thresholds, topK: 20 })
        : { ok: false, degraded: true, error: 'No semantic query to embed.', matches: [] };
    const ranked = retrieveRelevantVariables({
        variables,
        entries,
        messages: historyText.slice(-windowSize),
        vectorMatches: vectors.matches,
        activatedKeys,
        presentSubjects: subjects,
        goalVariableIds,
        explicitText: action,
        recentVariableIds,
        limit: limit || profile.retrievalLimit || 6,
    });
    const { listed, refToId } = assignVariableRefs(ranked.selected);
    const serialized = serializeRetrievedVariables(listed);
    const refByName = new Map(listed.map((item) => [item.variable.name, item.ref]));

    // Every candidate, included or not. The excluded ones carry why, because
    // "it did not surface" is the question this journal exists to answer.
    const diagnostics = ranked.diagnostics.map((item) => ({
        ref: refByName.get(item.variable.name) || '',
        variableName: item.variable.name,
        included: item.included,
        score: item.score,
        semantic: item.semantic,
        semanticThreshold: item.semanticThreshold,
        channels: item.channels,
        evidence: item.evidence,
        why: item.reasons.join(' '),
        excluded: item.exclusionReason,
    }));

    journal('retrieval.resolved', {
        timelineId: id, candidateCount: diagnostics.length, selectedCount: listed.length,
        serializedChars: serialized.length, degraded: !vectors.ok, degradeCause: vectors.error || '',
        vectorMatchCount: vectors.matches.length, candidates: diagnostics,
    }, {
        severity: vectors.ok ? 'info' : 'warn',
        correlationId,
        summary: `${listed.length}/${diagnostics.length} Variables retrieved${vectors.ok ? '' : ' (deterministic fallback)'}`,
    });

    return { listed, refToId, serialized, diagnostics, degraded: !vectors.ok, vectorError: vectors.error || '', query };
}

export function buildVariableQuery({ action = '', historyText = [], subjects = [], activatedKeys = [], entries = new Map(), goals = [], windowSize = 6 } = {}) {
    const activeLore = [...activatedKeys].map((key) => entries.get(key)).filter(Boolean)
        .map((entry) => `${entry.name}: ${entry.content}`).join('\n');
    const activeGoals = goals.map((goal) => `${goal.title}: ${goal.description || ''}`).join('\n');
    return [
        `CURRENT ACTION\n${String(action || '')}`,
        `RECENT ACCEPTED FICTION\n${historyText.slice(-Math.max(1, Math.round(windowSize / 2))).join('\n')}`,
        `CURRENT SUBJECTS\n${subjects.join(', ')}`,
        activeLore ? `ACTIVATED LORE\n${activeLore}` : '',
        activeGoals ? `ACTIVE GOALS\n${activeGoals}` : '',
    ].filter(Boolean).join('\n\n');
}

function emptyContext(reason, correlationId = null) {
    journal('retrieval.skipped', { reason }, { correlationId, summary: reason });
    return { listed: [], refToId: new Map(), serialized: 'No relevant Variables were retrieved.', diagnostics: [], degraded: false, vectorError: '', query: '', reason };
}
