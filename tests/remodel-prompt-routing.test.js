import {
    createPromptRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import {
    applyPromptStudioRuntimeRecipe,
    initPromptStudio,
    isNativeApplicableMode,
    resolveLoomRecipe,
    setRemodelNativePromptContent,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { oai_settings } from './util/openai-stub.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

globalThis.document ??= {
    addEventListener() {},
    getElementById() { return null; },
};

beforeEach(() => {
    __setExtensionSettings({});
    oai_settings.prompts.length = 0;
    oai_settings.prompt_order.length = 0;
});

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

test('Narrator grounding resolves into the recipe-owned native prompt', () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    const recipe = createPromptRecipe({ name: 'Narrator', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    applyPromptStudioRuntimeRecipe();

    expect(setRemodelNativePromptContent('narratorGrounding', '## Scene\n- location: courtyard')).toBe(true);
    expect(oai_settings.prompts.find((prompt) => prompt.identifier === 'remodel_narrator_grounding')).toMatchObject({
        name: 'Narrator Grounding',
        marker: false,
        role: 'system',
        content: '## Scene\n- location: courtyard',
    });
    expect(oai_settings.prompts.some((prompt) => ['remodel_loom_context', 'remodel_director_notes'].includes(prompt.identifier))).toBe(false);
});
