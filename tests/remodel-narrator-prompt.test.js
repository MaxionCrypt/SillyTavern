import {
    createPromptRecipe,
    NARRATOR_POLICY_DEFAULT,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => __setExtensionSettings({}));

test('the default Narrator policy is editable recipe text, not engine code', () => {
    const recipe = createPromptRecipe({ mode: 'roleplay', apiType: 'chat' });
    const policy = recipe.blocks.find((block) => block.content === NARRATOR_POLICY_DEFAULT);

    expect(policy).toBeTruthy();
    expect(policy.locked).toBe(false);
    expect(policy.advancedWarning).toMatch(/repeat|replay/i);
    expect(policy.content).toMatch(/never (restate|repeat|quote|acknowledge)[^.]*instruction/i);
});

test('the default recipe places editable policy before dynamic Narrator grounding', () => {
    const recipe = createPromptRecipe({ mode: 'roleplay', apiType: 'chat' });
    const policyIndex = recipe.blocks.findIndex((block) => block.content === NARRATOR_POLICY_DEFAULT);
    const groundingIndex = recipe.blocks.findIndex((block) => block.content === '{{narrator.grounding}}');

    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(groundingIndex).toBeGreaterThan(policyIndex);
    expect(recipe.blocks[groundingIndex]).toMatchObject({
        nativeIdentifier: 'remodel_narrator_grounding',
        role: 'system',
        enabled: true,
    });
});
