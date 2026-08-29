import { expect, test } from '@jest/globals';
import { isLinkedGroupChatLoaded } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/scene-open-state.js';

test('the native group loader is skipped only for the exact selected group chat', () => {
    expect(isLinkedGroupChatLoaded({ selectedGroupId: 7, groupId: '7', currentChatId: 12, targetChatId: '12' })).toBe(true);
    expect(isLinkedGroupChatLoaded({ selectedGroupId: 7, groupId: 8, currentChatId: 12, targetChatId: 12 })).toBe(false);
    expect(isLinkedGroupChatLoaded({ selectedGroupId: 7, groupId: 7, currentChatId: 11, targetChatId: 12 })).toBe(false);
    expect(isLinkedGroupChatLoaded({ selectedGroupId: null, groupId: 7, currentChatId: 12, targetChatId: 12 })).toBe(false);
});
