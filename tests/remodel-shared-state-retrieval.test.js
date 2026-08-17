import {
    coverage,
    distinctiveTokens,
    recallShare,
    retrieveRelevantState,
    scoreGoalRelevance,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-relevance.js';

// The shared scorer: Goals and Variables ranked together under one budget,
// admitted apart. Everything here is pure — no store, no vectors, no context —
// so a failure names the rule that broke rather than the wiring around it.

function variable(name, overrides = {}) {
    const { mode = 'any', ...rest } = overrides;
    return {
        id: `var-${name.toLowerCase().replace(/\W+/g, '-')}`,
        name,
        loreLinks: [],
        subvalues: [],
        value: 1,
        description: '',
        ...rest,
        retrieval: { mode, semanticThreshold: 0.7, continuity: true, ...(overrides.retrieval || {}) },
    };
}

function goal(title, overrides = {}) {
    return {
        id: `goal-${title.toLowerCase().replace(/\W+/g, '-')}`,
        title,
        description: '',
        holderRefs: [],
        targetRefs: [],
        successRate: 30,
        status: 'active',
        visibility: 'public',
        ...overrides,
    };
}

function names(items) {
    return items.map((item) => item.name);
}

// ------------------------------------------------------------- the new channels

test('a Variable the Director wrote about in its notebook is retrieved on that evidence alone', () => {
    const morale = variable('Morale');
    const bare = retrieveRelevantState({ variables: [morale] });
    const noted = retrieveRelevantState({ variables: [morale], notebookText: 'Morale is fraying and she has not noticed.' });

    expect(names(bare.selected)).toEqual([]);
    expect(names(noted.selected)).toEqual(['Morale']);
    expect(noted.selected[0].channels).toContain('notebook');
});

test('a notebook mention ranks below the action naming the same Variable outright', () => {
    const result = retrieveRelevantState({
        variables: [variable('Morale'), variable('Faction Heat')],
        explicitText: 'She checks the faction heat before she moves.',
        notebookText: 'Morale is fraying.',
    });

    expect(names(result.selected)).toEqual(['Faction Heat', 'Morale']);
});

test('a Goal description naming a Variable outright pulls it in, and outranks one merely near it semantically', () => {
    const rae = goal('Find Rae', { description: 'Wren is looking for her sister, and Faction Heat is what decides whether the house helps.' });
    const scoredGoals = scoreGoalRelevance({ goals: [rae], explicitText: 'Wren goes to find Rae.' });
    expect(scoredGoals[0].score).toBeGreaterThan(0);

    const result = retrieveRelevantState({
        variables: [variable('Faction Heat'), variable('Curfew')],
        scoredGoals,
        // Curfew has a genuine semantic hit; Faction Heat has none. Naming
        // still wins, which is the point of the strong half of the pull.
        vectorMatches: [{ variableId: 'var-curfew', passedAt: 0.8, rank: 0, channel: 'self' }],
    });

    // The Goal itself travels too — it is what pulled the Variable in.
    expect(names(result.selected)).toEqual(['Faction Heat', 'Find Rae', 'Curfew']);
    expect(result.selected[0].channels).toContain('goaltext');
});

test('the Goal pull is one-directional: a Variable named by the action does not drag its Goal along', () => {
    const unrelated = goal('Reach the roof before dawn');
    const scoredGoals = scoreGoalRelevance({ goals: [unrelated], explicitText: 'She watches the faction heat climb.' });

    // The Variable is named outright and retrieved; the Goal shares no text
    // with it and stays at zero. Variables carry no description that could
    // describe a Goal, so the reverse direction would be an invented signal.
    expect(scoredGoals[0].score).toBe(0);
    expect(scoredGoals[0].channels).toEqual([]);

    const result = retrieveRelevantState({
        variables: [variable('Faction Heat')],
        explicitText: 'She watches the faction heat climb.',
        scoredGoals,
    });
    expect(result.selected[0].name).toBe('Faction Heat');
});

test('only a Goal that scored lends its description to the pull', () => {
    const ignored = goal('Something nobody mentioned', { description: 'Faction Heat matters here.' });
    const scoredGoals = scoreGoalRelevance({ goals: [ignored], explicitText: 'He pours a drink.' });
    expect(scoredGoals[0].score).toBe(0);

    // The Goal itself is still eligible — Goals always are. What must not
    // happen is its description dragging a Variable in behind it.
    const result = retrieveRelevantState({ variables: [variable('Faction Heat')], scoredGoals });
    expect(names(result.selected)).not.toContain('Faction Heat');
});

test('recall is windowed: an item pulled twenty turns ago and not since carries nothing', () => {
    expect(recallShare(new Map(), 'var-morale', 10)).toBe(0);
    expect(recallShare(new Map([['var-morale', 5]]), 'var-morale', 10)).toBe(0.5);
    // A count that somehow exceeds the window is still a full share, never more.
    expect(recallShare(new Map([['var-morale', 40]]), 'var-morale', 10)).toBe(1);
});

test('recall breaks a tie without being able to create one', () => {
    const recallCounts = new Map([['goal-hold-the-line', 8]]);
    const scored = scoreGoalRelevance({
        goals: [goal('Hold the line'), goal('Cross the river')],
        recallCounts, recallWindow: 10,
    });
    const byName = new Map(scored.map((item) => [item.name, item]));

    expect(byName.get('Hold the line').score).toBeGreaterThan(byName.get('Cross the river').score);
    // And it is the weakest channel: still nowhere near a single real mention.
    const mentioned = scoreGoalRelevance({ goals: [goal('Cross the river')], explicitText: 'She crosses the river.' })[0];
    expect(mentioned.score).toBeGreaterThan(byName.get('Hold the line').score);
});

test('recall cannot satisfy a retrieval gate, only reorder items that already passed one', () => {
    const morale = variable('Morale', { mode: 'any' });
    const result = retrieveRelevantState({
        variables: [morale],
        recallCounts: new Map([[morale.id, 10]]),
        recallWindow: 10,
    });

    // Retrieved because retrieved is a loop. One lucky turn must not be able to
    // keep re-qualifying a Variable forever on the strength of having qualified.
    expect(names(result.selected)).toEqual([]);
});

// ------------------------------------------------------------------ eligibility

test('recall cannot corroborate: the weakest signal must not promote a Variable the owner gated', () => {
    // Two links so the single-link shortcut does not apply, one of them
    // activated, so exactly one distinct link of real evidence is present.
    // `corroborated` wants two. Recall is the only other channel available,
    // and it is circular — an item is recalled because it was retrieved — so
    // counting it here would let one lucky turn re-qualify this Variable
    // forever on the strength of having qualified.
    const gated = variable('Faction Heat', {
        mode: 'corroborated',
        loreLinks: [{ book: 'Halloway', uid: 7 }, { book: 'Halloway', uid: 9 }],
    });
    const args = { variables: [gated], activatedKeys: new Set(['Halloway.7']) };

    expect(names(retrieveRelevantState(args).selected)).toEqual([]);

    const withRecall = retrieveRelevantState({ ...args, recallCounts: new Map([[gated.id, 9]]), recallWindow: 10 });
    expect(withRecall.diagnostics[0].channels).toContain('recall');
    expect(names(withRecall.selected)).toEqual([]);
});

test('an independent authored mention CAN corroborate, which is what separates it from recall', () => {
    const gated = variable('Faction Heat', {
        mode: 'corroborated',
        loreLinks: [{ book: 'Halloway', uid: 7 }, { book: 'Halloway', uid: 9 }],
    });

    // Same shape as above, with a Director note naming it instead of recall.
    // The note is a statement someone wrote about this Variable; recall is the
    // system agreeing with itself.
    const noted = retrieveRelevantState({
        variables: [gated],
        activatedKeys: new Set(['Halloway.7']),
        notebookText: 'Faction Heat is the thing that decides this.',
    });
    expect(names(noted.selected)).toEqual(['Faction Heat']);
});

test('a Variable that fails its retrieval.mode gate stays out however well it scores', () => {
    const locked = variable('Faction Heat', {
        mode: 'all',
        loreLinks: [{ book: 'Halloway', uid: 7 }, { book: 'Halloway', uid: 9 }],
    });
    const result = retrieveRelevantState({
        variables: [locked],
        explicitText: 'The faction heat is unbearable.',
        notebookText: 'Faction Heat decides this scene.',
        // Only one of the two links is established, so `all` is not satisfied.
        activatedKeys: new Set(['Halloway.7']),
    });

    const [item] = result.diagnostics;
    expect(item.score).toBeGreaterThan(3);
    expect(item.included).toBe(false);
    expect(result.selected).toEqual([]);
});

test('a Goal needs no gate: with nothing said about it, it is still eligible', () => {
    const result = retrieveRelevantState({ scoredGoals: scoreGoalRelevance({ goals: [goal('Hold the line')] }) });

    expect(names(result.selected)).toEqual(['Hold the line']);
    expect(result.selected[0].score).toBe(0);
});

test('an `always` Variable outranks a Goal nobody has mentioned, so the shared budget cannot break its promise', () => {
    const result = retrieveRelevantState({
        variables: [variable('Curfew', { mode: 'always' })],
        scoredGoals: scoreGoalRelevance({ goals: [goal('Aardvark')] }),
        limit: 1,
    });

    expect(names(result.selected)).toEqual(['Curfew']);
});

test('a Goal the user is attempting this turn is never the one the budget drops', () => {
    const attempted = goal('Talk Rae down');
    const result = retrieveRelevantState({
        variables: [variable('Faction Heat'), variable('Morale')],
        explicitText: 'She raises the faction heat and morale together.',
        scoredGoals: scoreGoalRelevance({ goals: [attempted], pinnedGoalIds: [attempted.id] }),
        limit: 1,
    });

    expect(names(result.selected)).toEqual(['Talk Rae down']);
    expect(result.selected[0].channels).toContain('attempted');
});

// ---------------------------------------------------------------- shared budget

test('Goals and Variables compete for one budget, and the overflow says it was outranked, not ineligible', () => {
    const result = retrieveRelevantState({
        variables: [variable('Faction Heat')],
        explicitText: 'Faction heat climbs while she talks Rae down.',
        scoredGoals: scoreGoalRelevance({ goals: [goal('Talk Rae down'), goal('Reach the roof')], explicitText: 'Faction heat climbs while she talks Rae down.' }),
        limit: 2,
    });

    expect(result.selected).toHaveLength(2);
    expect(names(result.selected)).toContain('Faction Heat');
    expect(names(result.selected)).toContain('Talk Rae down');

    const dropped = result.diagnostics.find((item) => item.name === 'Reach the roof');
    expect(dropped.included).toBe(true);
    expect(dropped.exclusionReason).toMatch(/ranked below/i);
});

test('a Goal-poor turn spends the whole budget on Variables', () => {
    const result = retrieveRelevantState({
        variables: [variable('A', { mode: 'always' }), variable('B', { mode: 'always' }), variable('C', { mode: 'always' })],
        scoredGoals: [],
        limit: 3,
    });

    expect(names(result.selected)).toEqual(['A', 'B', 'C']);
});

// ------------------------------------------------------------------- matching

test('a Goal titled as a sentence still matches on its distinctive words', () => {
    const scored = scoreGoalRelevance({
        goals: [goal('Find Rae before the party ends')],
        messages: ['Rae was last seen near the kitchen, and the party is winding down.'],
    });

    expect(scored[0].channels).toContain('keyword');
});

test('the most recent mention of a Goal beats six older ones', () => {
    const older = scoreGoalRelevance({
        goals: [goal('Find Rae')],
        messages: ['Rae. Rae. Rae.', 'He pours a drink.', 'He pours another.'],
    })[0];
    const recent = scoreGoalRelevance({
        goals: [goal('Find Rae')],
        messages: ['He pours a drink.', 'He pours another.', 'Rae is here.'],
    })[0];

    expect(recent.score).toBeGreaterThan(older.score);
});

test('an unnamed Variable is not "directly named" by every action ever written', () => {
    // `''.includes('')` is true, so an empty needle matches every haystack.
    const result = retrieveRelevantState({
        variables: [variable('', { id: 'var-blank' })],
        explicitText: 'She opens the door.',
        notebookText: 'Something happened.',
    });

    expect(result.diagnostics[0].channels).not.toContain('direct');
    expect(result.diagnostics[0].channels).not.toContain('notebook');
    expect(names(result.selected)).toEqual([]);
});

test('coverage and tokenisation ignore the words every sentence contains', () => {
    expect(distinctiveTokens('Find Rae before the party ends')).toEqual(['find', 'rae', 'party', 'ends']);
    expect(coverage('rae is at the party', ['party', 'ends'])).toBe(0.5);
    // No tokens is no coverage, never a free pass.
    expect(coverage('anything at all', [])).toBe(0);
});
