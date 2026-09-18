// The prior-Scene keyword macro (spec §8): a Scene sees the deduped union of the
// keyword groups earlier Scenes of its timeline queried, so the Loom can replay
// what they established. Ordering is the timeline's play order (arcs then scenes,
// as the store arrays sequence them); the current Scene and later Scenes are
// excluded, and each distinct group (order-insensitive) appears once.
import { test, expect, beforeEach } from '@jest/globals';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { createTimeline, createArc, createScene } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';
import { recordKeywordGroups, orderedTimelineSceneIds, listPriorSceneKeywordGroups } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { formatPriorSceneKeywords, renderPriorSceneKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js';

let timelineId = '';
let scenes = [];

/** Three Scenes in one timeline: s0, s1 in arc A; s2 in arc B — play order s0,s1,s2. */
beforeEach(() => {
    __setExtensionSettings({});
    timelineId = createTimeline('T').id;
    const arcA = createArc(timelineId, 'A').id;
    const arcB = createArc(timelineId, 'B').id;
    scenes = [
        createScene(arcA, 'roleplay', 'S0'),
        createScene(arcA, 'roleplay', 'S1'),
        createScene(arcB, 'roleplay', 'S2'),
    ];
});

test('orderedTimelineSceneIds walks arcs in order, then scenes in each arc', () => {
    expect(orderedTimelineSceneIds(timelineId)).toEqual(scenes.map((scene) => scene.id));
    expect(orderedTimelineSceneIds('no-such-timeline')).toEqual([]);
    expect(orderedTimelineSceneIds('')).toEqual([]);
});

test('a Scene sees only the groups queried in strictly earlier Scenes', () => {
    recordKeywordGroups(scenes[0].id, [['Rayse']]);
    recordKeywordGroups(scenes[1].id, [['Silvia']]);
    recordKeywordGroups(scenes[2].id, [['Teo']]);

    expect(listPriorSceneKeywordGroups({ sceneId: scenes[0].id, timelineId })).toEqual([]);         // first Scene: nothing prior
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[1].id, timelineId })).toEqual([['Rayse']]); // s0 only
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[2].id, timelineId })).toEqual([['Rayse'], ['Silvia']]); // s0 + s1, not its own Teo
});

test('the current Scene never contributes its own groups', () => {
    recordKeywordGroups(scenes[1].id, [['SelfOnly']]);
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[1].id, timelineId })).toEqual([]);
});

test('a group two prior Scenes both queried appears once', () => {
    recordKeywordGroups(scenes[0].id, [['event', 'Rayse']]);
    recordKeywordGroups(scenes[1].id, [['event', 'Rayse']]); // same group, earlier Scene
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[2].id, timelineId })).toEqual([['Rayse', 'event']]);
});

test('canonical equivalence: order-different groups are the same group', () => {
    recordKeywordGroups(scenes[0].id, [['Rayse', 'Silvia']]);
    recordKeywordGroups(scenes[1].id, [['Silvia', 'Rayse']]); // same set, reversed
    // recorded canonically (sorted) at write time, so both stored as ['Rayse','Silvia']; deduped to one.
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[2].id, timelineId })).toEqual([['Rayse', 'Silvia']]);
});

test('timelineId is derived from the Scene when omitted', () => {
    recordKeywordGroups(scenes[0].id, [['Rayse']]);
    expect(listPriorSceneKeywordGroups({ sceneId: scenes[1].id })).toEqual([['Rayse']]);
});

test('a Scene absent from the timeline ordering yields nothing', () => {
    recordKeywordGroups(scenes[0].id, [['Rayse']]);
    expect(listPriorSceneKeywordGroups({ sceneId: 'unplaced-scene', timelineId })).toEqual([]);
    expect(listPriorSceneKeywordGroups({ sceneId: '', timelineId })).toEqual([]);
});

test('formatPriorSceneKeywords renders one row per group, or empty for none', () => {
    expect(formatPriorSceneKeywords([])).toBe('');
    expect(formatPriorSceneKeywords(null)).toBe('');
    expect(formatPriorSceneKeywords([[]])).toBe(''); // an all-blank group drops out, leaving nothing
    const text = formatPriorSceneKeywords([['Rayse'], ['event', 'Marissa']]);
    expect(text).toContain('loreKeywords');
    expect(text).toContain('- Rayse');
    expect(text).toContain('- event, Marissa');
    expect(text.split('\n- ')).toHaveLength(3); // header + 2 rows
});

test('renderPriorSceneKeywords queries and renders in one step', () => {
    recordKeywordGroups(scenes[0].id, [['Rayse']]);
    recordKeywordGroups(scenes[1].id, [['Silvia']]);
    const text = renderPriorSceneKeywords({ sceneId: scenes[2].id, timelineId });
    expect(text).toContain('- Rayse');
    expect(text).toContain('- Silvia');
    // The first Scene has no predecessors, so its render is empty.
    expect(renderPriorSceneKeywords({ sceneId: scenes[0].id, timelineId })).toBe('');
});
