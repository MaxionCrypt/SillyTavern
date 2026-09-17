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
    getCurrentPromptStudioRecipe,
    withPromptStudioRuntimeRecipe,
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

test('a universal state macro (prev.events) resolves into its recipe-owned native prompt', () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    const recipe = createPromptRecipe({ name: 'Narrator', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    applyPromptStudioRuntimeRecipe();

    expect(setRemodelNativePromptContent('prevEvents', '## Earlier Scene recall\n- the gate was locked')).toBe(true);
    expect(oai_settings.prompts.find((prompt) => prompt.identifier === 'remodel_prev_events')).toMatchObject({
        name: 'Previous Scene Events',
        marker: false,
        role: 'system',
        content: '## Earlier Scene recall\n- the gate was locked',
    });
    expect(oai_settings.prompts.some((prompt) => ['remodel_loom_context', 'remodel_director_notes'].includes(prompt.identifier))).toBe(false);
});

test('Narrator Note resolves when its macro shares an owner-authored recipe block', () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    const recipe = createPromptRecipe({
        name: 'Narrator Note route',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ kind: 'message', role: 'system', content: '{{character.description}}\n\n{{narrator.note}}' }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    applyPromptStudioRuntimeRecipe();

    expect(setRemodelNativePromptContent('narratorNote', 'Let dialogue carry this exchange.')).toBe(true);
    expect(oai_settings.prompts.find((prompt) => prompt.identifier === 'remodel_narrator_note')).toMatchObject({
        name: 'Narrator Note',
        role: 'system',
        content: 'Let dialogue carry this exchange.',
    });
});

test('Next Action is a recipe-owned user prompt', () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    const recipe = createPromptRecipe({
        name: 'Separate action',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ kind: 'message', role: 'user', content: '{{next.action}}' }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    applyPromptStudioRuntimeRecipe();

    expect(setRemodelNativePromptContent('nextAction', 'I pull the door open.')).toBe(true);
    expect(oai_settings.prompts.find((prompt) => prompt.identifier === 'remodel_next_action')).toMatchObject({
        name: 'Next Action',
        marker: false,
        role: 'user',
        content: 'I pull the door open.',
    });
});

test('applying a roleplay recipe discards deleted generated blocks and replaces profile labels', () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    oai_settings.prompts.push({
        identifier: 'remodel-block-stale',
        name: 'CROWN PROMPT ROLEPLAY',
        marker: false,
        role: 'system',
        content: 'This deleted instruction must not survive.',
    });
    oai_settings.prompts.push({
        identifier: 'main',
        name: 'FF Adapted Narrator Core',
        marker: false,
        role: 'system',
        content: 'Old profile prompt',
    });
    oai_settings.prompt_order.push({
        character_id: 100001,
        order: [
            { identifier: 'main', enabled: true },
            { identifier: 'remodel-block-stale', enabled: true },
        ],
    });
    const recipe = createPromptRecipe({
        name: 'CROWN PROMPT ROLEPLAY',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ id: 'core', kind: 'message', role: 'system', nativeIdentifier: 'main', content: 'Current recipe core' }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);

    applyPromptStudioRuntimeRecipe();

    expect(oai_settings.prompts.some((prompt) => prompt.identifier === 'remodel-block-stale')).toBe(false);
    expect(oai_settings.prompts.find((prompt) => prompt.identifier === 'main')).toMatchObject({
        name: 'CROWN PROMPT ROLEPLAY · Block 1',
        content: 'Current recipe core',
    });
    expect(oai_settings.prompt_order.find((entry) => entry.character_id === 100001)?.order).toEqual([
        { identifier: 'main', enabled: true },
    ]);
});

test('a bounded runtime recipe restores the normal Narrator recipe afterward', async () => {
    initPromptStudio({ getRuntimeMode: () => 'roleplay', getRuntimeRecipeId: () => null });
    const narrator = createPromptRecipe({ name: 'Normal Narrator', mode: 'roleplay', apiType: 'chat' });
    const continueRecipe = createPromptRecipe({ name: 'Continue only', mode: 'roleplay', apiType: 'chat' });
    setActivePromptRecipe('roleplay', 'chat', narrator.id);
    applyPromptStudioRuntimeRecipe();

    expect(getCurrentPromptStudioRecipe('roleplay', 'chat')?.id).toBe(narrator.id);
    await withPromptStudioRuntimeRecipe(continueRecipe.id, async () => {
        expect(getCurrentPromptStudioRecipe('roleplay', 'chat')?.id).toBe(continueRecipe.id);
    });
    expect(getCurrentPromptStudioRecipe('roleplay', 'chat')?.id).toBe(narrator.id);
});
