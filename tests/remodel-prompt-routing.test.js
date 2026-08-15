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

test('resolveDirectorRecipe returns null when none is configured', () => {
    expect(resolveDirectorRecipe()).toBeNull();
});

test('resolveDirectorRecipe never returns a roleplay recipe', () => {
    const roleplay = createPromptRecipe({ name: 'R', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', roleplay.id);
    expect(resolveDirectorRecipe()).toBeNull();
});
