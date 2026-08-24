import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, recordEvent, setCharStateFacet, setBeat, setSecret,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { buildGoalObjectives, buildNarratorArchivistSections } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal, linkGoalToScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { formatStoryGoalsForNarrator } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-prompt.js';

const T = 'tl-n';
const S = 'sc-n';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('renders scene, characters, events, and beat as labelled sections', () => {
    setSceneFact(T, S, 'location', 'rain-soaked rooftop');
    setCharStateFacet(T, S, 'marcus', 'mood', 'desperate');
    recordEvent(T, S, 'Marcus drew his knife');
    setBeat(T, S, 'Marcus lunges', 'tense');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).toContain('location: rain-soaked rooftop');
    expect(text).toContain('marcus');
    expect(text).toContain('mood: desperate');
    expect(text).toContain('Marcus drew his knife');
    expect(text).toContain('Marcus lunges');
    // the event log must be framed as already-written
    expect(text.toLowerCase()).toContain('already');
    // The beat is momentum, never a railroad over the latest player action.
    expect(text).toContain('Open thread — provisional');
    expect(text).toContain('never overrides the latest accepted action');
});

test('secrets never appear in the Narrator sections (fail-closed)', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSecret(T, S, 'betrayer', 'Marcus works for the guild');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).not.toContain('betrayer');
    expect(text).not.toContain('guild');
});

test('an empty scene renders as an empty string', () => {
    expect(buildNarratorArchivistSections(T, S)).toBe('');
});

test('Archive event arguments keep only the newest requested records', () => {
    recordEvent(T, S, 'First event');
    recordEvent(T, S, 'Second event');
    recordEvent(T, S, 'Third event');
    const bounded = buildNarratorArchivistSections(T, S, { events: 2 });
    expect(bounded).not.toContain('First event');
    expect(bounded).toContain('Second event');
    expect(bounded).toContain('Third event');
    expect(buildNarratorArchivistSections(T, S, { events: 0 })).not.toContain('What has happened');
});

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
