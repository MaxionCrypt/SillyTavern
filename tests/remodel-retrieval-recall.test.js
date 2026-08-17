import {
    MAX_RECALL_TURNS,
    clearRetrievalRecall,
    readRecallCounts,
    recordRetrievalRecall,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/retrieval-recall.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const TIMELINE = 'timeline-recall';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

test('counts turns an item appeared in, not appearances within a turn', () => {
    recordRetrievalRecall(TIMELINE, ['a', 'a', 'a']);
    expect(readRecallCounts(TIMELINE, 10).get('a')).toBe(1);

    recordRetrievalRecall(TIMELINE, ['a']);
    expect(readRecallCounts(TIMELINE, 10).get('a')).toBe(2);
});

test('the window is a view, not a truncation: history outside it is kept and readable again', () => {
    recordRetrievalRecall(TIMELINE, ['old']);
    for (let turn = 0; turn < 5; turn++) recordRetrievalRecall(TIMELINE, ['new']);

    // Six turns stored, three read.
    expect(readRecallCounts(TIMELINE, 3).get('old')).toBeUndefined();
    expect(readRecallCounts(TIMELINE, 3).get('new')).toBe(3);
    // Widening the window recovers it, because lowering the setting must not
    // have destroyed anything raising it back could not return.
    expect(readRecallCounts(TIMELINE, 10).get('old')).toBe(1);
});

test('an item pulled long ago and not since carries nothing inside the window', () => {
    recordRetrievalRecall(TIMELINE, ['forgotten']);
    for (let turn = 0; turn < 12; turn++) recordRetrievalRecall(TIMELINE, ['current']);

    expect(readRecallCounts(TIMELINE, 10).get('forgotten')).toBeUndefined();
});

test('an empty pass still consumes a turn, so a quiet stretch decays the window', () => {
    recordRetrievalRecall(TIMELINE, ['a']);
    for (let turn = 0; turn < 3; turn++) recordRetrievalRecall(TIMELINE, []);

    // Dropping empty passes would leave `a` sitting at the top of a
    // three-turn window forever — the ossification the window exists to stop.
    expect(readRecallCounts(TIMELINE, 3).get('a')).toBeUndefined();
});

test('the buffer is bounded', () => {
    for (let turn = 0; turn < MAX_RECALL_TURNS + 20; turn++) recordRetrievalRecall(TIMELINE, [`item-${turn}`]);

    const held = readRecallCounts(TIMELINE, MAX_RECALL_TURNS);
    expect(held.size).toBe(MAX_RECALL_TURNS);
    expect(held.get('item-0')).toBeUndefined();
});

test('a window wider than the buffer reads the buffer, not an error', () => {
    recordRetrievalRecall(TIMELINE, ['a']);
    expect(readRecallCounts(TIMELINE, 500).get('a')).toBe(1);
    expect(readRecallCounts(TIMELINE, 0).get('a')).toBe(1);
    expect(readRecallCounts(TIMELINE, null).get('a')).toBe(1);
});

test('Timelines do not read each other, and deletion cascades', () => {
    recordRetrievalRecall(TIMELINE, ['a']);
    recordRetrievalRecall('other-timeline', ['a']);

    expect(readRecallCounts(TIMELINE, 10).get('a')).toBe(1);
    expect(clearRetrievalRecall(TIMELINE)).toBe(true);
    expect(readRecallCounts(TIMELINE, 10).size).toBe(0);
    expect(readRecallCounts('other-timeline', 10).get('a')).toBe(1);
    expect(clearRetrievalRecall(TIMELINE)).toBe(false);
});

test('a missing Timeline id is refused rather than written under an empty key', () => {
    expect(recordRetrievalRecall('', ['a'])).toBe(0);
    expect(readRecallCounts('', 10).size).toBe(0);
});

test('a corrupt stored value is replaced rather than thrown on', () => {
    __setExtensionSettings({ remodel: { retrievalRecallV1: { version: 1, timelines: [] } } });
    expect(() => readRecallCounts(TIMELINE, 10)).not.toThrow();
    recordRetrievalRecall(TIMELINE, ['a']);
    expect(readRecallCounts(TIMELINE, 10).get('a')).toBe(1);
});
