import { beforeEach, expect, test } from '@jest/globals';
import {
    clearWorldSenseContext,
    getWorldSenseContext,
    saveWorldSenseContext,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('a scene with no retrieval yet has an empty working set', () => {
    expect(getWorldSenseContext('scene-1')).toMatchObject({ entries: [], keywords: [] });
});

test('a retrieval is remembered so the next turn does not have to run one', () => {
    saveWorldSenseContext('scene-1', {
        entries: [{ book: 'B', uid: '1' }, { book: 'B', uid: '2' }],
        keywords: ['Teo'], receiptId: 'r1',
    });
    expect(getWorldSenseContext('scene-1')).toMatchObject({
        entries: [{ book: 'B', uid: '1' }, { book: 'B', uid: '2' }],
        keywords: ['Teo'], receiptId: 'r1',
    });
});

test('saving replaces the whole set rather than merging with the last one', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '1' }], keywords: ['Teo'] });
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '9' }], keywords: ['Marissa'] });
    expect(getWorldSenseContext('scene-1')).toMatchObject({
        entries: [{ book: 'B', uid: '9' }], keywords: ['Marissa'],
    });
});

test('scenes keep their own working sets', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '1' }] });
    saveWorldSenseContext('scene-2', { entries: [{ book: 'B', uid: '2' }] });
    expect(getWorldSenseContext('scene-1').entries).toEqual([{ book: 'B', uid: '1' }]);
    expect(getWorldSenseContext('scene-2').entries).toEqual([{ book: 'B', uid: '2' }]);
});

test('only entry references are kept, never a copy of the lore', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '1', content: 'a whole entry', name: 'Thing' }] });
    expect(getWorldSenseContext('scene-1').entries).toEqual([{ book: 'B', uid: '1' }]);
});

test('malformed references are dropped rather than stored', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: '', uid: '1' }, { book: 'B' }, null, { book: 'B', uid: '3' }] });
    expect(getWorldSenseContext('scene-1').entries).toEqual([{ book: 'B', uid: '3' }]);
});

test('a working set can be cleared', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '1' }] });
    clearWorldSenseContext('scene-1');
    expect(getWorldSenseContext('scene-1').entries).toEqual([]);
});

test('a returned set cannot be mutated behind the store’s back', () => {
    saveWorldSenseContext('scene-1', { entries: [{ book: 'B', uid: '1' }] });
    getWorldSenseContext('scene-1').entries.push({ book: 'B', uid: 'X' });
    expect(getWorldSenseContext('scene-1').entries).toHaveLength(1);
});
