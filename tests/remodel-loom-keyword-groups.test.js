import { readLoreKeywords, MAX_LORE_KEYWORD_GROUPS, MAX_LORE_KEYWORDS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';

test('readLoreKeywords parses groups (array of arrays), trims, dedups within a group, drops empties', () => {
    expect(readLoreKeywords([['event', 'Rayse'], ['Rayse', ' Rayse ', ''], [], ['Silvia']]))
        .toEqual([['event', 'Rayse'], ['Rayse'], ['Silvia']]);
});

test('readLoreKeywords rejects a flat string array and non-arrays (groups only)', () => {
    expect(readLoreKeywords('x')).toEqual([]);
    expect(readLoreKeywords(['flat', 'strings'])).toEqual([]);
    expect(readLoreKeywords(null)).toEqual([]);
});

test('readLoreKeywords caps group count and per-group keyword count', () => {
    const manyGroups = Array.from({ length: MAX_LORE_KEYWORD_GROUPS + 3 }, (_, i) => [`g${i}`]);
    expect(readLoreKeywords(manyGroups)).toHaveLength(MAX_LORE_KEYWORD_GROUPS);
    const bigGroup = [Array.from({ length: MAX_LORE_KEYWORDS + 3 }, (_, i) => `k${i}`)];
    expect(readLoreKeywords(bigGroup)[0]).toHaveLength(MAX_LORE_KEYWORDS);
});
