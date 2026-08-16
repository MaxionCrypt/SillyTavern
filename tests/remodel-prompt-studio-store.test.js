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
