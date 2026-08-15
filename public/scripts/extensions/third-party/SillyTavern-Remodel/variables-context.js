import { listLoreEntries, entryKey } from './variables-lore.js';
import { assignVariableRefs, retrieveRelevantVariables, serializeRetrievedVariables } from './variables-relevance.js';
import { listVariableEvents, listVariableValues, getMechanicsProfile } from './variables-store.js';
import { queryVariableVectors } from './variables-vector.js';

/**
 * Resolve the small, temporary Variable address book for one request.
 * Persistent IDs stay in refToId and are never serialized for the model.
 */
export async function resolveVariableContext({
    timelineId, action = '', history = [], cast = [], activatedEntries = [], goals = [], limit = 0,
} = {}) {
    const id = String(timelineId || '');
    if (!id) return emptyContext('No Timeline is active.');
    const variables = listVariableValues({ timelineId: id });
    if (!variables.length) return emptyContext('This Timeline has no Variables.');

    const lore = await listLoreEntries();
    const entries = new Map(lore.map((entry) => [entryKey(entry), entry]));
    const activatedKeys = new Set([...activatedEntries].map((entry) => entryKey({
        book: entry?.book ?? entry?.world,
        uid: entry?.uid,
    })).filter(Boolean));
    const historyText = history.map((item) => String(item?.content ?? item?.mes ?? item ?? '')).filter(Boolean);
    const subjects = cast.flatMap((item) => [item?.label, item?.name, item?.ref?.label]).filter(Boolean);
    const goalVariableIds = goals.flatMap((goal) => [
        goal?.resolution?.variableId,
        goal?.resolution?.variableInstanceId,
    ]).filter(Boolean);
    const recentVariableIds = listVariableEvents({ timelineId: id }).slice(-30).map((event) => event.variableId).filter(Boolean);
    const query = buildVariableQuery({ action, historyText, subjects, activatedKeys, entries, goals });
    const vectors = query.trim() ? await queryVariableVectors(id, query, 20) : { ok: false, degraded: true, error: 'No semantic query text.', matches: [] };
    const profile = getMechanicsProfile();
    const ranked = retrieveRelevantVariables({
        variables,
        entries,
        messages: historyText.slice(-12),
        vectorMatches: vectors.matches,
        activatedKeys,
        presentSubjects: subjects,
        goalVariableIds,
        explicitText: action,
        recentVariableIds,
        limit: limit || profile.retrievalLimit || profile.sweepLimit || 6,
    });
    const { listed, refToId } = assignVariableRefs(ranked.selected);
    return {
        listed,
        refToId,
        serialized: serializeRetrievedVariables(listed),
        diagnostics: ranked.diagnostics.map((item) => ({
            name: item.variable.name,
            included: item.included,
            score: item.score,
            semanticScore: item.semanticScore,
            evidence: item.evidence,
            reason: item.reasons.join(' '),
            exclusionReason: item.exclusionReason,
        })),
        degraded: !vectors.ok,
        vectorError: vectors.error || '',
        query,
    };
}

export function buildVariableQuery({ action = '', historyText = [], subjects = [], activatedKeys = [], entries = new Map(), goals = [] } = {}) {
    const activeLore = [...activatedKeys].map((key) => entries.get(key)).filter(Boolean)
        .map((entry) => `${entry.name}: ${entry.content}`).join('\n');
    const activeGoals = goals.map((goal) => `${goal.title}: ${goal.description || ''}`).join('\n');
    return [
        `CURRENT ACTION\n${String(action || '')}`,
        `RECENT ACCEPTED FICTION\n${historyText.slice(-6).join('\n')}`,
        `CURRENT SUBJECTS\n${subjects.join(', ')}`,
        activeLore ? `ACTIVATED LORE\n${activeLore}` : '',
        activeGoals ? `ACTIVE GOALS\n${activeGoals}` : '',
    ].filter(Boolean).join('\n\n');
}

function emptyContext(reason) {
    return { listed: [], refToId: new Map(), serialized: 'No relevant Variables were retrieved.', diagnostics: [], degraded: false, vectorError: '', query: '', reason };
}
