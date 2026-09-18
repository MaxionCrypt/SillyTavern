import { __setExtensionSettings } from './util/st-context-stub.js';
import { getSceneLivingLore, unseenGroups, recordKeywordGroups, addEntryRefs, listSceneEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('a fresh Scene has empty refs and groups', () => {
    expect(getSceneLivingLore('s1')).toMatchObject({ sceneId: 's1', entryRefs: {}, keywordGroups: [] });
});

test('recordKeywordGroups dedups order-insensitively', () => {
    recordKeywordGroups('s1', [['a', 'b'], ['b', 'a'], ['c']]);
    expect(getSceneLivingLore('s1').keywordGroups).toHaveLength(2);
});

test('unseenGroups returns only groups not yet recorded (canonicalised)', () => {
    recordKeywordGroups('s1', [['a', 'b']]);
    expect(unseenGroups('s1', [['b', 'a'], ['c']])).toEqual([['c']]);
});

test('addEntryRefs unions and dedups by book.uid; is Scene-isolated', () => {
    addEntryRefs('s1', [{ book: 'TL', uid: '1' }, { book: 'TL', uid: '1' }, { book: 'TL', uid: '2' }]);
    expect(listSceneEntryRefs('s1')).toHaveLength(2);
    expect(listSceneEntryRefs('s2')).toEqual([]);
});
