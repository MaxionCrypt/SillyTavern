import {
    clearStandingDirection,
    clearStandingDirectionsForTimeline,
    readStandingDirection,
    saveStandingDirection,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/standing-direction-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// A direction produced and never spoken, kept across reloads.
//
// The expensive part of a pass is the Director call, but the part that has to
// be RIGHT is the address book travelling with it: the closed set of names the
// model may write to. Every test below is about refusing a record this store
// cannot vouch for, not about loading one successfully.

const SCENE = 'scene-standing';
const PROTOCOL = 'remodel-direction/1';

function record(overrides = {}) {
    return {
        protocol: PROTOCOL,
        sceneId: SCENE,
        timelineId: 'timeline-standing',
        turn: 4,
        performerRef: { kind: 'narrator', id: 'Narrator.png', label: 'The Narrator' },
        envelope: { protocol: PROTOCOL, notebookTurn: 4 },
        variableRefs: { v1: 'var-1' },
        goalRefs: { g1: 'goal-1' },
        addressBook: { entries: [{ name: 'Faction Heat', id: 'var-1' }], duplicates: [] },
        authorizedGoalIds: ['goal-1'],
        autonomousSequence: 0,
        chatLength: 6,
        ...overrides,
    };
}

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

test('a saved direction comes back with its address book intact', () => {
    saveStandingDirection(record());
    const saved = readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 6 });

    expect(saved.turn).toBe(4);
    // The authorization, not just the prose. Without these the direction would
    // come back resolving no names and every surviving request would be
    // rejected as never advertised — fail-safe, and still wrong.
    expect(saved.variableRefs).toEqual({ v1: 'var-1' });
    expect(saved.addressBook.entries).toHaveLength(1);
    expect(saved.authorizedGoalIds).toEqual(['goal-1']);
});

test('a record from another protocol is refused, not adapted', () => {
    saveStandingDirection(record({ protocol: 'remodel-direction/0' }));

    // It describes an envelope shape this build no longer reads. Speaking it
    // would mean guessing at the meaning of fields that have moved.
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 6 })).toBeNull();
});

test('a direction is refused once the chat has moved past it', () => {
    saveStandingDirection(record({ chatLength: 6 }));

    // Something was said after this direction was made, so it is answering a
    // question the scene has already moved past.
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 7 })).toBeNull();
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 6 })).not.toBeNull();
});

test('a shorter chat still speaks: deletion does not invalidate the moment at the end', () => {
    saveStandingDirection(record({ chatLength: 6 }));

    // Strictly greater, not merely different. Deleting messages from under a
    // direction leaves the moment it was about still at the end of the scene.
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 4 })).not.toBeNull();
});

test('Scenes do not read each other', () => {
    saveStandingDirection(record());

    expect(readStandingDirection('some-other-scene', { protocol: PROTOCOL, chatLength: 6 })).toBeNull();
});

test('at most one per Scene: a second direction replaces the first', () => {
    saveStandingDirection(record({ turn: 4 }));
    saveStandingDirection(record({ turn: 5 }));

    // Two would be two unspoken takes competing for the same moment, and
    // nothing in the loop could say which one Continue meant.
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 6 }).turn).toBe(5);
});

test('clearing one Scene leaves the others alone', () => {
    saveStandingDirection(record());
    saveStandingDirection(record({ sceneId: 'scene-other', timelineId: 'timeline-other' }));

    expect(clearStandingDirection(SCENE)).toBe(true);
    expect(readStandingDirection(SCENE, {})).toBeNull();
    expect(readStandingDirection('scene-other', {})).not.toBeNull();
    // A second clear had nothing to do and must say so.
    expect(clearStandingDirection(SCENE)).toBe(false);
});

test('the Timeline cascade takes its own Scenes and no others', () => {
    // Both records present when the cascade runs, in different Timelines.
    // Clearing one first would let a cascade that ignores `timelineId`
    // pass — with one record left, "its own" and "all of them" agree.
    saveStandingDirection(record({ sceneId: 'scene-a', timelineId: 'timeline-doomed' }));
    saveStandingDirection(record({ sceneId: 'scene-b', timelineId: 'timeline-doomed' }));
    saveStandingDirection(record({ sceneId: 'scene-c', timelineId: 'timeline-kept' }));

    expect(clearStandingDirectionsForTimeline('timeline-doomed')).toBe(2);
    expect(readStandingDirection('scene-a', {})).toBeNull();
    expect(readStandingDirection('scene-b', {})).toBeNull();
    expect(readStandingDirection('scene-c', {})).not.toBeNull();
});

test('a missing Scene id is refused rather than written under an empty key', () => {
    expect(saveStandingDirection(record({ sceneId: '' }))).toBeNull();
    expect(readStandingDirection('', {})).toBeNull();
});

test('a corrupt stored value is replaced rather than thrown on', () => {
    __setExtensionSettings({ remodel: { standingDirectionV1: { version: 1, scenes: [] } } });

    expect(() => readStandingDirection(SCENE, {})).not.toThrow();
    saveStandingDirection(record());
    expect(readStandingDirection(SCENE, { protocol: PROTOCOL, chatLength: 6 })).not.toBeNull();
});
