export const TIMELINE_LIFECYCLE_PROTOCOL = 'remodel/timeline-lifecycle/1';

export const GOAL_LIFECYCLE_CAPABILITIES = Object.freeze([
    'goal.create',
    'goal.edit',
    'goal.relate',
]);

export const VARIABLE_LIFECYCLE_CAPABILITIES = Object.freeze([
    'variable.create',
]);

export const TIMELINE_LIFECYCLE_CAPABILITIES = Object.freeze([
    ...GOAL_LIFECYCLE_CAPABILITIES,
    ...VARIABLE_LIFECYCLE_CAPABILITIES,
]);

const CAPABILITY_SET = new Set(TIMELINE_LIFECYCLE_CAPABILITIES);
const TERMINAL_GOAL_STATUSES = new Set(['achieved', 'abandoned', 'impossible']);
const ALLOWED_ARGUMENTS = Object.freeze({
    'goal.create': new Set(['alias', 'title', 'description', 'visibility', 'holderRefs', 'targetRefs']),
    'goal.edit': new Set(['goalRef', 'goalId', 'title', 'description', 'visibility', 'status']),
    'goal.relate': new Set(['fromGoalRef', 'fromGoalId', 'toGoalRef', 'toGoalId', 'type']),
    'variable.create': new Set(['alias', 'name', 'description', 'valueType', 'value', 'enumValues', 'minimum', 'maximum']),
});

export function isTimelineLifecycleCapability(name) {
    return CAPABILITY_SET.has(String(name || ''));
}

export function selectTimelineLifecycleProposals(requests) {
    return (Array.isArray(requests) ? requests : [])
        .filter((request) => isTimelineLifecycleCapability(request?.capability))
        .map((request) => clone(request));
}

/** Fail closed before a proposal reaches the existing mechanics validators. */
export function validateTimelineLifecycleProposal(candidate, channel) {
    const request = clone(candidate);
    const capability = String(request?.capability || '');
    const expected = channel === 'goals' ? GOAL_LIFECYCLE_CAPABILITIES : channel === 'variables' ? VARIABLE_LIFECYCLE_CAPABILITIES : [];
    if (!expected.includes(capability)) return rejected('wrong-channel', `The ${capability || 'missing'} proposal does not belong to ${channel}.`);
    if (!String(request?.id || '').trim()) return rejected('missing-id', 'A lifecycle proposal requires an id.');
    if (!String(request?.reason || '').trim()) return rejected('missing-reason', 'A lifecycle proposal requires a fictional reason.');
    if (!request?.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) return rejected('invalid-arguments', 'Lifecycle arguments must be an object.');
    const unsupported = Object.keys(request.arguments).filter((key) => !ALLOWED_ARGUMENTS[capability].has(key));
    if (unsupported.length) return rejected(
        unsupported.some((key) => ['successRate', 'impact', 'delta', 'nextState'].includes(key)) ? 'unsupported-numeric-change' : 'unsupported-argument',
        `${capability} cannot change ${unsupported.join(', ')} in the background lifecycle projection.`,
    );
    if (capability === 'goal.edit' && request.arguments.status !== undefined && !TERMINAL_GOAL_STATUSES.has(request.arguments.status)) {
        return rejected('unsupported-goal-transition', 'The background Loom may close a Goal, but may not reopen it.');
    }
    if (capability === 'goal.edit' && !['title', 'description', 'visibility', 'status'].some((key) => request.arguments[key] !== undefined)) {
        return rejected('empty-annotation', 'A Goal lifecycle edit must close or annotate the Goal.');
    }
    return { ok: true, request };
}

export function buildTimelineLifecyclePromptGuide({ goals = false, variables = false } = {}) {
    const lines = [];
    if (goals) {
        lines.push(
            '- goal.create: create a new unresolved world or character Goal. arguments: title; description; holderRefs (at least one typed owner, shaped like [{"kind":"character","id":"<cast name>","label":"<cast name>"}]); optional alias, targetRefs in the same typed-owner shape, and visibility. Give same-batch Goals aliases before relating them. Do not set odds.',
            '- goal.edit: close or annotate an existing Goal. arguments: goalRef plus status (achieved, abandoned, or impossible), title, description, and/or visibility. Never change successRate.',
            '- goal.relate: relate two existing or same-batch Goals. arguments: fromGoalRef; toGoalRef; type (antagonistic or sympathetic).',
        );
    }
    if (variables) {
        lines.push('- variable.create: create a durable world-state Variable when accepted prose establishes a genuinely reusable measure or state. arguments: name; description; valueType; value; optional enumValues/minimum/maximum. Later value changes belong to Narrator mechanics, not this pass.');
    }
    if (!lines.length) return '';
    return `[TIMELINE LIFECYCLE PROPOSALS — validated after Archive settlement]\n${lines.join('\n')}\nEvery proposal is grounded by this turn's accepted prose. Do not roll, adjust Goal odds, set/adjust/transition existing Variables, rewrite prose, or treat a proposed outcome as guaranteed.`;
}

function rejected(code, message) {
    return { ok: false, code, message };
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}
