import {
    PROMPT_MODES,
    createPromptRecipe,
    getPromptStudioStore,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

test('director is a prompt mode', () => {
    expect(PROMPT_MODES).toContain('director');
});

test('a new director recipe carries the expected blocks in order', () => {
    const recipe = createPromptRecipe({ name: 'Test Director', mode: 'director', apiType: 'chat' });
    expect(recipe.mode).toBe('director');
    expect(recipe.blocks.map((block) => block.sourceKey || block.kind)).toEqual([
        'directionProtocol',
        'directorCard',
        'message',
        'mechanicsSkill',
        'directorSnapshot',
    ]);
});

test('the protocol and snapshot blocks are locked, the style block is not', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const locked = Object.fromEntries(recipe.blocks.map((block) => [block.sourceKey || 'style', block.locked]));
    expect(locked.directionProtocol).toBe(true);
    expect(locked.directorSnapshot).toBe(true);
    expect(locked.style).toBe(false);
    expect(locked.directorCard).toBe(false);
});

test('the editable style block carries the pacing defaults as text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const style = recipe.blocks.find((block) => block.kind === 'message');
    expect(style.content).toMatch(/without waiting/i);
    expect(style.content.length).toBeGreaterThan(40);
});

test('a director recipe is always chat, never text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'text' });
    expect(recipe.apiType).toBe('chat');
});

// Regression: a plain store initialisation (no explicit createPromptRecipe
// call) used to walk PROMPT_MODES x PROMPT_API_TYPES to seed each mode's
// active recipes, and nothing stopped it from seeding a director/text slot —
// the constraint "director recipes are Chat Completion only" was only
// enforced on the createPromptRecipe path, not here. Assert the requirement
// directly against a freshly initialised store, not against today's output.
test('initialising the store never creates a director recipe outside chat, and never an active text slot', () => {
    const store = getPromptStudioStore();
    const directorRecipes = Object.values(store.recipes).filter((recipe) => recipe.mode === 'director');
    // Sanity check this test actually exercises the seeding path.
    expect(directorRecipes.length).toBeGreaterThan(0);
    expect(directorRecipes.every((recipe) => recipe.apiType === 'chat')).toBe(true);
    expect('text' in (store.active.director || {})).toBe(false);
});
