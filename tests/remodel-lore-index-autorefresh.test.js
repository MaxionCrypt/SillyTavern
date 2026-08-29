import {
    requestWorldSenseIndexRefresh,
    timelinesForLoreBook,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-embeddings.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const withTimelines = (timelines) => {
    __setExtensionSettings({
        remodel: {
            timelineV1: {
                version: 1,
                timelineIds: timelines.map((timeline) => timeline.id),
                timelines: Object.fromEntries(timelines.map((timeline) => [timeline.id, timeline])),
                arcs: {},
                scenes: {},
                activeTimelineId: timelines[0]?.id || null,
            },
        },
    });
};

test('a book resolves to every Timeline that reads from it', () => {
    withTimelines([
        { id: 't1', name: 'One', lorebookName: 'Shared Book' },
        { id: 't2', name: 'Two', lorebookName: 'Shared Book' },
        { id: 't3', name: 'Three', lorebookName: 'Other Book' },
    ]);
    expect(timelinesForLoreBook('Shared Book').sort()).toEqual(['t1', 't2']);
    expect(timelinesForLoreBook('Other Book')).toEqual(['t3']);
});

test('a book nothing reads from resolves to nothing', () => {
    withTimelines([{ id: 't1', name: 'One', lorebookName: 'Shared Book' }]);
    expect(timelinesForLoreBook('Unused Book')).toEqual([]);
});

test('an unnamed or blank book never matches a Timeline', () => {
    withTimelines([{ id: 't1', name: 'One', lorebookName: null }]);
    expect(timelinesForLoreBook('')).toEqual([]);
    expect(timelinesForLoreBook('   ')).toEqual([]);
    expect(timelinesForLoreBook(undefined)).toEqual([]);
});

test('book names are compared trimmed, not loosely', () => {
    withTimelines([{ id: 't1', name: 'One', lorebookName: '  Shared Book  ' }]);
    expect(timelinesForLoreBook('Shared Book')).toEqual(['t1']);
    expect(timelinesForLoreBook('shared book')).toEqual([]);
});

test('a refresh request reports which Timelines it scheduled', () => {
    withTimelines([
        { id: 't1', name: 'One', lorebookName: 'Shared Book' },
        { id: 't2', name: 'Two', lorebookName: 'Shared Book' },
    ]);
    expect(requestWorldSenseIndexRefresh('Shared Book').sort()).toEqual(['t1', 't2']);
    expect(requestWorldSenseIndexRefresh('Nothing')).toEqual([]);
});
