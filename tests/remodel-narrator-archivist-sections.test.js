import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, recordEvent, setCharStateFacet, setBeat, setSecret,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { buildGoalObjectives, buildNarratorArchivistSections } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal, linkGoalToScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';

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
    // the beat must be framed as what happens next
    expect(text.toLowerCase()).toContain('next');
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
