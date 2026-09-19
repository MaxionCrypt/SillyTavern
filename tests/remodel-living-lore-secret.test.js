// A secret Living Lore entry is Loom-visible but Narrator-hidden: it carries the
// reserved `secret` keyword and is natively disabled. Native activation skips it
// (so the Narrator never sees it); the Loom's own retrieval and packet still show
// it, flagged secret.
import { test, expect, beforeEach } from '@jest/globals';
import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import { __setWorldInfoState } from './util/world-info-stub.js';
import {
    SECRET_KEYWORD, GOAL_KEYWORD, VARIABLE_KEYWORD, RESERVED_LIVING_LORE_KEYWORDS,
    isReservedLivingLoreKeyword, isSecretEntry, isGoalEntry, isVariableEntry,
    addSecretKeyword, removeSecretKeyword,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-secret.js';
import { activateKeywordGroups } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-retrieval.js';
import { addEntryRefs } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-store.js';
import { buildSceneLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-cache-packet.js';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
    __setWorldInfoState({ selected_world_info: ['TL'] });
});

test('isSecretEntry reads the reserved keyword, case-insensitively and robustly', () => {
    expect(SECRET_KEYWORD).toBe('secret');
    expect(isSecretEntry({ key: ['Rayse', 'SECRET'] })).toBe(true);
    expect(isSecretEntry({ key: [' Secret '] })).toBe(true);
    expect(isSecretEntry({ key: ['Rayse'] })).toBe(false);
    expect(isSecretEntry({ key: [] })).toBe(false);
    expect(isSecretEntry({})).toBe(false);
    expect(isSecretEntry(null)).toBe(false);
});

test('addSecretKeyword adds once; removeSecretKeyword strips every casing', () => {
    expect(addSecretKeyword(['Rayse'])).toEqual(['Rayse', 'secret']);
    expect(addSecretKeyword(['Rayse', 'secret'])).toEqual(['Rayse', 'secret']); // idempotent
    expect(removeSecretKeyword(['Rayse', 'SECRET', 'secret'])).toEqual(['Rayse']);
    expect(removeSecretKeyword(['Rayse'])).toEqual(['Rayse']);
});

test('goal and variable are reserved markers recognised like secret, no behaviour of their own', () => {
    // The dissolution leaves Goals and Variables as ordinary Living Lore entries
    // wearing a reserved marker keyword.
    expect(GOAL_KEYWORD).toBe('goal');
    expect(VARIABLE_KEYWORD).toBe('variable');
    expect([...RESERVED_LIVING_LORE_KEYWORDS].sort()).toEqual(['goal', 'secret', 'variable']);

    expect(isGoalEntry({ key: ['Escape the compound', 'GOAL'] })).toBe(true);
    expect(isGoalEntry({ key: [' goal '] })).toBe(true);
    expect(isGoalEntry({ key: ['Escape the compound'] })).toBe(false);
    expect(isGoalEntry(null)).toBe(false);

    expect(isVariableEntry({ key: ["Aiden's Nerve", 'Variable'] })).toBe(true);
    expect(isVariableEntry({ key: ["Aiden's Nerve"] })).toBe(false);
    expect(isVariableEntry({})).toBe(false);

    // The markers are distinct: a goal entry is not a variable entry or secret.
    const goal = { key: ['Escape the compound', 'goal'] };
    expect(isVariableEntry(goal)).toBe(false);
    expect(isSecretEntry(goal)).toBe(false);
});

test('isReservedLivingLoreKeyword recognises every reserved marker, case-insensitively', () => {
    for (const reserved of ['secret', 'GOAL', ' Variable ']) {
        expect(isReservedLivingLoreKeyword(reserved)).toBe(true);
    }
    expect(isReservedLivingLoreKeyword('Rayse')).toBe(false);
    expect(isReservedLivingLoreKeyword('')).toBe(false);
    expect(isReservedLivingLoreKeyword(null)).toBe(false);
});

test('retrieval pulls a disabled SECRET entry but not a plainly disabled one', async () => {
    __setContextOverrides({
        async getWorldInfoEntriesForBook(book) {
            return book === 'TL' ? [
                { uid: 1, key: ['Rayse', 'secret'], keysecondary: [], content: 'The hidden pact.', comment: 'Rayse', disable: true },
                { uid: 2, key: ['Rayse'], keysecondary: [], content: 'Turned off by the user.', comment: 'Bran', disable: true },
                { uid: 3, key: ['Rayse'], keysecondary: [], content: 'Ordinary.', comment: 'Open', disable: false },
            ] : [];
        },
    });
    const refs = await activateKeywordGroups([['Rayse']], { sceneId: 's1', timelineId: 't1' });
    const uids = refs.map((ref) => ref.uid).sort();
    expect(uids).toEqual(['1', '3']);          // secret-disabled + enabled; the plainly-disabled #2 stays out
});

test('the Scene packet flags which entries are secret', async () => {
    __setContextOverrides({
        async getWorldInfoEntriesForBook(book) {
            return book === 'TL' ? [
                { uid: 1, key: ['Rayse', 'secret'], keysecondary: [], content: 'The hidden pact.', comment: 'Rayse', disable: true },
                { uid: 4, key: ['Silvia'], keysecondary: [], content: 'A court mage.', comment: 'Silvia', disable: false },
            ] : [];
        },
    });
    addEntryRefs('s1', [{ book: 'TL', uid: '1' }, { book: 'TL', uid: '4' }]);
    const packet = await buildSceneLivingLorePacket({ sceneId: 's1', timelineId: 't1' });
    const byUid = Object.fromEntries(packet.entries.map((entry) => [entry.target.uid, entry.secret]));
    expect(byUid).toEqual({ 1: true, 4: false });
});
