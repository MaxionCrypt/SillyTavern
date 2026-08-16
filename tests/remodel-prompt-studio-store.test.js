import { normalizeRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';

// normalizeRecipe is the one funnel every recipe passes through — fresh
// creation and recipes loaded back out of persisted settings — so it is the
// only place block-settings defaulting belongs, and the only thing worth
// testing here. There is no separate test-only helper: the function under
// test is the one that actually runs.

test('a saved recipe with no settings still normalizes', () => {
    const recipe = normalizeRecipe({ id: 'r1', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'chatHistory', role: 'user', enabled: true }] });
    expect(recipe.blocks[0].settings).toEqual({});
});

test('a declared setting is defaulted when absent', () => {
    const recipe = normalizeRecipe({ id: 'r2', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true }] });
    expect(recipe.blocks[0].settings.depth).toBe(3);
});

test('an undeclared setting key is dropped', () => {
    const recipe = normalizeRecipe({ id: 'r3', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 5, nonsense: true } }] });
    expect(recipe.blocks[0].settings).toEqual({ depth: 5 });
});

test('a setting outside its declared range is clamped, not rejected', () => {
    const recipe = normalizeRecipe({ id: 'r4', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 9999 } }] });
    expect(recipe.blocks[0].settings.depth).toBe(20);
});

// Number(null), Number('') and Number([]) are all 0 — a finite number — so a
// coercion path that only checks isFinite() reads "no value was ever saved"
// as "the value zero" and clamps it up to min (1) instead of falling back to
// default (3). This is the same trap that once bit clampNumber in
// variables-store.js. Each of these must land on the declared default, not
// on min.
test.each([
    ['a null', null],
    ['an empty-string', ''],
    ['an empty-array', []],
])('%s setting value falls back to default, not min', (_label, value) => {
    const recipe = normalizeRecipe({ id: 'r5', mode: 'roleplay', apiType: 'chat', blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: value } }] });
    expect(recipe.blocks[0].settings.depth).toBe(3);
});
