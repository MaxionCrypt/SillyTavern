import {
    PROMPT_MODES,
    createPromptRecipe,
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
