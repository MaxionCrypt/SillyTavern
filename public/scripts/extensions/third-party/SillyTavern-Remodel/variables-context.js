import { listLoreEntries, entryKey } from './variables-lore.js';
import { assignVariableRefs, retrieveRelevantState, scoreGoalRelevance, serializeRetrievedVariables } from './variables-relevance.js';
import { listVariableEvents, listVariableValues, getMechanicsProfile, onVariablesChanged } from './variables-store.js';
import { queryVariableVectors } from './variables-vector.js';
import { readRecallCounts, recordRetrievalRecall } from './retrieval-recall.js';
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
 * The most recent retrieval per Timeline, for the State drawer to render.
 *
 * Deliberately not read back out of the debug journal: recording can be paused,
 * filtered or cleared, and a drawer that empties because diagnostics were
 * switched off would be a bad surface. The journal stays the historical record;
 * this is the live one. In memory only — it describes one session's last pass
 * and is worthless persisted.
 */
const lastByTimeline = new Map();

/**
 * A retrieval snapshot is only true until the Variables under it move.
 *
 * It holds whole Variable records — `listed[].variable`, with its value, its
 * bounds and its modifiers — so it goes stale on a value edit as surely as on a
 * delete. Nothing used to drop it: the owner deleted a Variable, the store
 * updated, and the State drawer kept rendering a pass from twenty-seven minutes
 * earlier that still listed the deleted record. Refusing to answer is the only
 * honest response to "what did the Loom last see" once that is no longer
 * knowable; a fresh pass, or the drawer's own Preview button, records a new one.
 *
 * Registered at module scope because the cache is module scope: there is one
 * cache for the session and it wants exactly one subscription, not one per
 * retrieval. Deliberately does no work beyond dropping the entry — the notice
 * can arrive mid-mutation (see onVariablesChanged).
 */
onVariablesChanged((timelineId) => {
    if (timelineId) lastByTimeline.delete(timelineId);
    else lastByTimeline.clear();
});

/**
 * The last retrieval for a Timeline, or null when none has run since that
 * Timeline's Variables last changed.
 */
export function getLastVariableContext(timelineId) {
    return lastByTimeline.get(String(timelineId || '')) || null;
}

/**
 * Resolve the small, temporary Variable address book for one request.
 * Persistent IDs stay in refToId and are never serialized for the model.
 *
 * @param {string} correlationId ties these records to the direction pass that
 *   asked for them, so one response reads as a single thread in the journal.
 */
export async function resolveVariableContext({
    timelineId, action = '', history = [], cast = [], activatedEntries = [], goals = [],
    notebookText = '', pinnedGoalIds = [], limit = 0, correlationId = null, recordRecall = true,
} = {}) {
    const id = String(timelineId || '');
    // Deliberately no early return, for either a missing Timeline or a Timeline
    // with no Variables. Goals come through this same pass now, and a Timeline
    // can easily have Goals and no Variables — a bail that used to cost nothing
    // would now silently drop every Goal the Loom has. Everything below
    // degrades to empty on its own when there is nothing to read.
    const variables = id ? listVariableValues({ timelineId: id }) : [];

    const profile = getMechanicsProfile();
    const windowSize = profile.retrievalWindow || 12;
    const budget = limit || profile.retrievalLimit || 8;
    const lore = await listLoreEntries();
    const entries = new Map(lore.map((entry) => [entryKey(entry), entry]));
    const activatedKeys = new Set([...activatedEntries].map(entryKey).filter(Boolean));
    const historyText = history.map((item) => String(item?.content ?? item?.mes ?? item ?? '')).filter(Boolean);
    const subjects = cast.flatMap((item) => [item?.label, item?.name, item?.ref?.label]).filter(Boolean);
    const recentVariableIds = id ? listVariableEvents({ timelineId: id }).slice(-30).map((event) => event.variableId).filter(Boolean) : [];
    const messages = historyText.slice(-windowSize);
    const recallCounts = readRecallCounts(id, windowSize);

    // Goals are scored first because their scores are an input to everything
    // after: the query is seeded from the Goals that scored, and their
    // descriptions are a query source for the Variables themselves.
    const scoredGoals = scoreGoalRelevance({
        goals, explicitText: action, messages, notebookText,
        recallCounts, recallWindow: windowSize, pinnedGoalIds,
    });
    const queryGoals = scoredGoals.filter((item) => item.score > 0).map((item) => item.goal);
    const query = buildVariableQuery({ action, historyText, subjects, activatedKeys, entries, goals: queryGoals, windowSize });

    journal('retrieval.begin', {
        timelineId: id, variableCount: variables.length, queryChars: query.length, windowSize, budget,
        castCount: subjects.length, activatedCount: activatedKeys.size, goalCount: goals.length,
        scoringGoalCount: queryGoals.length, notebookChars: notebookText.length,
        recentCount: recentVariableIds.length, recallCount: recallCounts.size,
    }, { correlationId, summary: `Retrieving from ${variables.length} Variables and ${goals.length} Goals` });

    // One query per distinct threshold in play — see queryVariableVectors. With
    // no Variables there is nothing to match, so the embedding call is skipped
    // rather than issued against an empty index.
    const thresholds = [...new Set(variables.map((variable) => variable.retrieval.semanticThreshold))];
    const vectors = query.trim() && thresholds.length
        ? await queryVariableVectors(id, query, { thresholds, topK: 20 })
        : { ok: !thresholds.length, degraded: Boolean(thresholds.length), error: thresholds.length ? 'No semantic query to embed.' : '', matches: [] };
    const ranked = retrieveRelevantState({
        variables,
        entries,
        messages,
        vectorMatches: vectors.matches,
        activatedKeys,
        presentSubjects: subjects,
        explicitText: action,
        recentVariableIds,
        notebookText,
        scoredGoals,
        recallCounts,
        recallWindow: windowSize,
        limit: budget,
    });
    const { listed, refToId } = assignVariableRefs(ranked.selected.filter((item) => item.kind === 'variable'));
    const selectedGoals = ranked.selected.filter((item) => item.kind === 'goal').map((item) => item.goal);
    const serialized = serializeRetrievedVariables(listed);
    const refByName = new Map(listed.map((item) => [item.variable.name, item.ref]));

    // Every candidate of both kinds, included or not. The excluded ones carry
    // why, because "it did not surface" is the question this journal exists to
    // answer — and without it the owner cannot tell a Goal that scored badly
    // from one that was never eligible.
    const diagnostics = ranked.diagnostics.map((item) => ({
        kind: item.kind,
        ref: item.kind === 'variable' ? refByName.get(item.variable.name) || '' : '',
        name: item.name,
        included: item.included && !item.exclusionReason,
        score: item.score,
        semantic: Boolean(item.semantic),
        semanticThreshold: item.semanticThreshold || 0,
        channels: item.channels,
        evidence: item.evidence,
        why: item.reasons.join(' '),
        excluded: item.exclusionReason,
    }));

    // Recorded before the journal write and after the cut, and only for a pass
    // that will actually reach a Loom. A preview retrieves for the owner to
    // look at; letting it write recall would let opening the drawer twice
    // reweight the next real turn.
    if (recordRecall) {
        recordRetrievalRecall(id, [
            ...listed.map((item) => item.variable.id),
            ...selectedGoals.map((goal) => goal.id),
        ]);
    }

    journal('retrieval.resolved', {
        timelineId: id, candidateCount: diagnostics.length, selectedCount: listed.length,
        goalCandidateCount: scoredGoals.length, goalSelectedCount: selectedGoals.length,
        serializedChars: serialized.length, degraded: !vectors.ok, degradeCause: vectors.error || '',
        vectorMatchCount: vectors.matches.length, candidates: diagnostics,
    }, {
        severity: vectors.ok ? 'info' : 'warn',
        correlationId,
        summary: `${listed.length}/${diagnostics.length} Variables and ${selectedGoals.length}/${scoredGoals.length} Goals retrieved${vectors.ok ? '' : ' (deterministic fallback)'}`,
    });

    const result = {
        listed, refToId, serialized, diagnostics, goals: selectedGoals,
        // Why a list is empty, not merely that it is. "This Timeline has none
        // yet" and "none of them matched this turn" are different things to
        // tell a Loom, and only this function knows which one is true.
        emptyCode: !id ? 'no-timeline' : (variables.length ? 'none-matched' : 'none-authored'),
        goalsEmptyCode: !id ? 'no-timeline' : (goals.length ? 'none-matched' : 'none-authored'),
        degraded: !vectors.ok, vectorError: vectors.error || '', query,
        at: new Date().toISOString(), action: String(action || ''),
    };
    if (id) lastByTimeline.set(id, result);
    return result;
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
