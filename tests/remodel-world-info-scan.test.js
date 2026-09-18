import { matchEntry } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-info-scan.js';

// matchEntry returns inactive unless a positive scanDepth is supplied (it slices
// corpus.slice(0, depth)); callers pass a real scanDepth. Native selectiveLogic:
// 0 = AND_ANY, 1 = NOT_ALL, 2 = NOT_ANY, 3 = AND_ALL.
const OPTS = { recursionText: [], scanDepth: 100, recursion: false, globalScanData: {}, macroOptions: {} };
const entry = (over) => ({ key: ['Rayse'], keysecondary: [], selective: false, selectiveLogic: 0, content: 'x', disable: false, ...over });

test('primary key matches when present in corpus', () => {
    expect(matchEntry(entry({}), { ...OPTS, corpus: ['rayse walked in'] }).active).toBe(true);
});

test('primary key absent -> not active', () => {
    expect(matchEntry(entry({ key: ['Silvia'] }), { ...OPTS, corpus: ['rayse walked in'] }).active).toBe(false);
});

test('AND_ALL selective needs both keys in the same corpus (selectiveLogic 3)', () => {
    const sel = entry({ key: ['event'], keysecondary: ['Rayse'], selective: true, selectiveLogic: 3 });
    expect(matchEntry(sel, { ...OPTS, corpus: ['an event with Rayse'] }).active).toBe(true);
    expect(matchEntry(sel, { ...OPTS, corpus: ['an event with Silvia'] }).active).toBe(false);
});

test('a zero scanDepth deactivates (guards the retrieval caller against passing 0)', () => {
    expect(matchEntry(entry({}), { ...OPTS, scanDepth: 0, corpus: ['rayse walked in'] }).active).toBe(false);
});
