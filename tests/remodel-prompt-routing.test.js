import {
    createPromptRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { isNativeApplicableMode, resolveLoomRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

test('a Loom recipe is never eligible for native application', () => {
    expect(isNativeApplicableMode('loom')).toBe(false);
    expect(isNativeApplicableMode('roleplay')).toBe(true);
    expect(isNativeApplicableMode('story')).toBe(true);
});

test('resolveLoomRecipe returns the active Loom recipe', () => {
    const recipe = createPromptRecipe({ name: 'L', mode: 'loom', apiType: 'chat' });
    setActivePromptRecipe('loom', 'chat', recipe.id);
    expect(resolveLoomRecipe()?.id).toBe(recipe.id);
});

// The store always seeds and keeps an active Loom/chat recipe (see the
// task-4 report's "unreachable states" note), so a roleplay recipe being
// active is the only reachable way to exercise the mode filter: it must not
// make resolveLoomRecipe() start returning the roleplay recipe instead
// of the still-active Loom default.
test('a roleplay recipe active for roleplay/chat does not leak into resolveLoomRecipe()', () => {
    const roleplay = createPromptRecipe({ name: 'R', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', roleplay.id);
    const recipe = resolveLoomRecipe();
    expect(recipe?.id).not.toBe(roleplay.id);
    expect(recipe?.mode).toBe('loom');
});
