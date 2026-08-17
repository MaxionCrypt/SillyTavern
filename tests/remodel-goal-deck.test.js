import { renderGoalEditFormMarkup, renderGoalRelationsMarkup } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-markup.js';
import { STORY_GOAL_STATUSES, STORY_GOAL_VISIBILITIES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-model.js';

// The deck could create a Goal and then never touch it again: edit, delete,
// link, unlink and relate were all exported by the store and called by nothing.
// These cover the markup halves; the handlers need the running app.

const goal = {
    id: 'goal-1',
    title: 'Hold the gate',
    description: 'Until the column arrives',
    successRate: 40,
    status: 'active',
    visibility: 'public',
    holderRefs: [{ kind: 'character', id: 'char-wren', label: 'Wren' }],
};

test('the edit form carries every attribute the record holds', () => {
    const markup = renderGoalEditFormMarkup(goal);
    for (const field of ['title', 'description', 'holder', 'successRate', 'status', 'visibility']) {
        expect(markup).toContain(`name="${field}"`);
    }
});

test('the form opens on the Goal\'s current values, not on defaults', () => {
    const markup = renderGoalEditFormMarkup({ ...goal, successRate: 73, status: 'abandoned', visibility: 'secret' });
    expect(markup).toContain('value="73"');
    expect(markup).toContain('<option value="abandoned" selected>');
    expect(markup).toContain('<option value="secret" selected>');
});

test('status and visibility options are derived, not enumerated', () => {
    // A status added to the model must appear here without anyone remembering
    // to edit this file. This codebase has repeatedly broken because a rule
    // listed its cases and the new one was the case it did not know about.
    const markup = renderGoalEditFormMarkup(goal);
    for (const status of STORY_GOAL_STATUSES) expect(markup).toContain(`value="${status}"`);
    for (const visibility of STORY_GOAL_VISIBILITIES) expect(markup).toContain(`value="${visibility}"`);
});

test('the title is escaped rather than injected', () => {
    const markup = renderGoalEditFormMarkup({ ...goal, title: '"><script>alert(1)</script>' });
    expect(markup).not.toContain('<script>');
});

test('existing relationships are shown by title, and other Goals are offered', () => {
    const other = { ...goal, id: 'goal-2', title: 'Find the ledger' };
    const relations = [{ id: 'rel-1', fromGoalId: 'goal-1', toGoalId: 'goal-2', type: 'antagonistic' }];
    const markup = renderGoalRelationsMarkup(goal, [goal, other], relations);

    expect(markup).toContain('Hold the gate');
    expect(markup).toContain('Find the ledger');
    expect(markup).toContain('data-remodel-goal-relate-form="goal-1"');
});

test('a lone Goal is offered no way to relate to itself', () => {
    const markup = renderGoalRelationsMarkup(goal, [goal], []);
    expect(markup).not.toContain('remodel-goal-relate-form');
});
