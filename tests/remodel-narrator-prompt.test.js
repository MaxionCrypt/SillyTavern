import {
    createPromptRecipe,
    NARRATOR_POLICY_DEFAULT,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { buildEmptyResponseNudge } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
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

// THE DEFECT: the empty-response path re-sent a byte-identical request body.
// Captured on the wire — attempts 2 and 3 of one turn compared equal character
// for character, 72 seconds apart — so the retry budget was spent asking the
// identical question that had just failed.
test('a first attempt is never altered', () => {
    expect(buildEmptyResponseNudge(1, { reasoningLength: 5000 })).toBe('');
    expect(buildEmptyResponseNudge(0)).toBe('');
    expect(buildEmptyResponseNudge(null)).toBe('');
    expect(buildEmptyResponseNudge(undefined)).toBe('');
});

test('a retry carries an instruction, so the request differs from the one that failed', () => {
    const nudge = buildEmptyResponseNudge(2, { reasoningLength: 0 });
    expect(nudge).not.toBe('');
    expect(nudge).toMatch(/visible text/i);
});

// The observed failure is specific — thousands of characters of reasoning
// against an empty message — so the nudge names that rather than being generic.
test('the nudge names reasoning-only output when that is what happened', () => {
    const reasoned = buildEmptyResponseNudge(2, { reasoningLength: 7732 });
    expect(reasoned).toMatch(/private reasoning/i);
    const silent = buildEmptyResponseNudge(2, { reasoningLength: 0 });
    expect(silent).toMatch(/empty response/i);
    expect(silent).not.toMatch(/private reasoning/i);
});

test('later attempts keep nudging', () => {
    expect(buildEmptyResponseNudge(3, { reasoningLength: 100 })).not.toBe('');
    expect(buildEmptyResponseNudge(4)).not.toBe('');
});

test('a malformed-output retry explicitly forbids reasoning and prompt echo', () => {
    const reasoningLeak = buildEmptyResponseNudge(2, { failureCause: 'reasoning-in-content' });
    expect(reasoningLeak).toMatch(/private planning/i);
    expect(reasoningLeak).toMatch(/only the scene prose/i);

    const echoed = buildEmptyResponseNudge(2, { failureCause: 'instruction-echo' });
    expect(echoed).toMatch(/copied prompt instructions/i);
    expect(echoed).toMatch(/repeat any instruction/i);
});
