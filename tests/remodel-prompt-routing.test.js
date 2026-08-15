import {
    createPromptRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { isNativeApplicableMode, resolveDirectorRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

test('a director recipe is never eligible for native application', () => {
    expect(isNativeApplicableMode('director')).toBe(false);
    expect(isNativeApplicableMode('roleplay')).toBe(true);
    expect(isNativeApplicableMode('story')).toBe(true);
});

test('resolveDirectorRecipe returns the active director recipe', () => {
    const recipe = createPromptRecipe({ name: 'D', mode: 'director', apiType: 'chat' });
    setActivePromptRecipe('director', 'chat', recipe.id);
    expect(resolveDirectorRecipe()?.id).toBe(recipe.id);
});

// The store always seeds and keeps an active director/chat recipe (see the
// task-4 report's "unreachable states" note), so a roleplay recipe being
// active is the only reachable way to exercise the mode filter: it must not
// make resolveDirectorRecipe() start returning the roleplay recipe instead
// of the still-active director default.
test('a roleplay recipe active for roleplay/chat does not leak into resolveDirectorRecipe()', () => {
    const roleplay = createPromptRecipe({ name: 'R', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', roleplay.id);
    const recipe = resolveDirectorRecipe();
    expect(recipe?.id).not.toBe(roleplay.id);
    expect(recipe?.mode).toBe('director');
});
