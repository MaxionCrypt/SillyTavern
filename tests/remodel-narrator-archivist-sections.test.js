import { __setExtensionSettings } from './util/st-context-stub.js';
import { buildGoalObjectives } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal, linkGoalToScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { formatStoryGoalsForNarrator } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-prompt.js';

const T = 'tl-n';
const S = 'sc-n';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('Narrator Objectives identify who holds each Goal without exposing its odds', () => {
    const goal = createTimelineGoal(T, {
        title: 'Leave the library before six',
        description: 'On track while the stacks can be cleared by 5:40.',
        holderRefs: [{ kind: 'character', id: 'marissa', label: 'Marissa' }],
        successRate: 30,
    }, { sceneId: S, actor: 'mechanics' });
    linkGoalToScene(S, goal.id);

    const text = buildGoalObjectives(S);
    expect(text).toContain('Marissa — Leave the library before six');
    expect(text).toContain('On track while the stacks can be cleared by 5:40.');
    expect(text).not.toMatch(/\b30%?\b/);
});

test('Narrator Story Goals are framed as pressures that actions may defeat', () => {
    const text = formatStoryGoalsForNarrator([{
        title: 'Keep the study break undisturbed',
        description: 'Marissa wants to finish her chapter.',
        holderRefs: [{ kind: 'character', id: 'marissa', label: 'Marissa' }],
        successRate: 30,
        visibility: 'public',
    }]);
    expect(text).toContain('pressures, not guarantees');
    expect(text).toContain('never protected outcomes');
    expect(text).toContain('help, obstruct, redirect, or defeat');
    expect(text.match(/Keep the study break undisturbed/g)).toHaveLength(1);
});

test('Narrator Objectives keep multiple holders explicit', () => {
    const goal = createTimelineGoal(T, {
        title: 'Keep the society hidden',
        holderRefs: [
            { kind: 'character', id: 'marissa', label: 'Marissa' },
            { kind: 'character', id: 'teo', label: 'Teo' },
        ],
    }, { sceneId: S, actor: 'mechanics' });
    linkGoalToScene(S, goal.id);

    expect(buildGoalObjectives(S)).toContain('Marissa, Teo — Keep the society hidden');
});

test('Goal archive arguments keep only the newest requested Goals', () => {
    createTimelineGoal(T, { title: 'Older goal', holderRefs: [{ kind: 'character', id: 'a', label: 'A' }] }, { sceneId: S });
    createTimelineGoal(T, { title: 'Newest goal', holderRefs: [{ kind: 'character', id: 'b', label: 'B' }] }, { sceneId: S });
    const bounded = buildGoalObjectives(S, { limit: 1 });
    expect(bounded).not.toContain('Older goal');
    expect(bounded).toContain('Newest goal');
    expect(buildGoalObjectives(S, { limit: 0 })).toBe('');
});
