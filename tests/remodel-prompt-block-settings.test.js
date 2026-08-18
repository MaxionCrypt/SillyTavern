// Review I2: design §5's per-block settings editor was never built.
//
// §5 chose a per-block settings bag over a Mechanics-profile setting on one
// argument — "the control belongs next to the thing it controls, where a user
// editing their Narrator recipe will actually find it", against a profile
// setting that "would have been cheaper and effectively undiscoverable". The
// bag shipped, `directorNotes` declared `label`/`min`/`max`,
// `normalizeBlockSettings` and `coerceSettingValue` clamped — and no control
// existed anywhere, so `depth` was permanently 3 for every user forever and
// the declared bounds were decoration. Neither discoverable NOR editable:
// strictly worse than the alternative the design rejected, at higher cost.
//
// The clamping tests that already existed were exercising machinery no
// production input could reach. These cover the two halves that make them
// mean something: the control renders for a block whose source declares
// settings and for no other block, and an edit made through it survives
// normalization and reaches what the Narrator actually reads.
import { test, expect, beforeEach } from '@jest/globals';
import {
    applyPromptBlockSetting,
    renderPromptBlockSettings,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { formatDirectorNotesPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import {
    createPromptRecipe,
    getPromptRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { appendDirectorEntries } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => {
    __setExtensionSettings({});
});

/** A roleplay recipe with the settings-bearing block and one that is not. */
function recipeWithNotesBlock() {
    return createPromptRecipe({
        name: 'RP settings', mode: 'roleplay', apiType: 'chat',
        blocks: [
            { kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true },
            { kind: 'source', sourceKey: 'charDescription', role: 'system', enabled: true },
            { kind: 'message', role: 'instruction', content: 'Write well.' },
        ],
    });
}

function blockFor(recipe, predicate) {
    return recipe.blocks.find(predicate);
}

// ------------------------------------------------------------- rendering

test('a block whose source declares settings renders a control carrying the declared label and bounds', () => {
    const recipe = recipeWithNotesBlock();
    const block = blockFor(recipe, (entry) => entry.sourceKey === 'directorNotes');
    const html = renderPromptBlockSettings(recipe, block);

    expect(html).toContain('data-remodel-prompt-block-setting="depth"');
    // The declared label, not the raw key — the source definition is the
    // single place a setting is described.
    expect(html).toContain('Turns to include');
    // The declared bounds reach the control rather than staying decoration.
    expect(html).toContain('min="1"');
    expect(html).toContain('max="20"');
    // And it is seeded with the value the block actually holds.
    expect(html).toContain('value="3"');
});

test('the control shows the block\'s own saved value, not the declared default', () => {
    const recipe = createPromptRecipe({
        name: 'RP deep', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 9 } }],
    });
    const html = renderPromptBlockSettings(recipe, recipe.blocks[0]);
    expect(html).toContain('value="9"');
    expect(html).not.toContain('value="3"');
});

test('a source block that declares no settings renders nothing at all', () => {
    // The other half of §5's sentence, and the half that keeps the editor from
    // growing an empty strip under every block.
    const recipe = recipeWithNotesBlock();
    expect(renderPromptBlockSettings(recipe, blockFor(recipe, (entry) => entry.sourceKey === 'charDescription'))).toBe('');
});

test('an authored message block renders nothing, since a message has no source to declare settings', () => {
    const recipe = recipeWithNotesBlock();
    expect(renderPromptBlockSettings(recipe, blockFor(recipe, (entry) => entry.kind === 'message'))).toBe('');
});

// --------------------------------------------------------------- writing

test('an edit through the control is stored, and the store clamps it rather than trusting the field', () => {
    const recipe = recipeWithNotesBlock();
    const block = blockFor(recipe, (entry) => entry.sourceKey === 'directorNotes');

    expect(applyPromptBlockSetting(recipe.id, block.id, 'depth', '7').settings.depth).toBe(7);
    expect(getPromptRecipe(recipe.id).blocks.find((entry) => entry.id === block.id).settings.depth).toBe(7);

    // The browser's min/max is a hint; the clamp is the store's, and this is
    // what a pasted or scripted value hits.
    expect(applyPromptBlockSetting(recipe.id, block.id, 'depth', '99').settings.depth).toBe(20);
    expect(applyPromptBlockSetting(recipe.id, block.id, 'depth', '-4').settings.depth).toBe(1);
});

test('clearing the field falls back to the declared default rather than to zero', () => {
    // `Number('')` is 0 and finite, which is the trap this codebase has now
    // hit three times. coerceSettingValue tests presence before coercing;
    // this is the production input that finally reaches that check.
    const recipe = recipeWithNotesBlock();
    const block = blockFor(recipe, (entry) => entry.sourceKey === 'directorNotes');
    applyPromptBlockSetting(recipe.id, block.id, 'depth', '11');
    expect(applyPromptBlockSetting(recipe.id, block.id, 'depth', '').settings.depth).toBe(3);
});

test('a key the source definition does not declare is refused rather than saved and silently dropped later', () => {
    const recipe = recipeWithNotesBlock();
    const block = blockFor(recipe, (entry) => entry.sourceKey === 'directorNotes');
    expect(applyPromptBlockSetting(recipe.id, block.id, 'notADeclaredSetting', '5')).toBeNull();
    const saved = getPromptRecipe(recipe.id).blocks.find((entry) => entry.id === block.id).settings;
    // The undeclared key is absent, and every DECLARED key survives. Checked
    // this way round on purpose: whole-object equality would fail whenever the
    // source gains a setting, which says nothing about whether an undeclared
    // one was refused.
    expect(saved).not.toHaveProperty('notADeclaredSetting');
    expect(saved.depth).toBe(3);
});

test('a block whose source declares nothing cannot be written to', () => {
    const recipe = recipeWithNotesBlock();
    const plain = blockFor(recipe, (entry) => entry.sourceKey === 'charDescription');
    expect(applyPromptBlockSetting(recipe.id, plain.id, 'depth', '7')).toBeNull();
    expect(getPromptRecipe(recipe.id).blocks.find((entry) => entry.id === plain.id).settings).toEqual({});
});

test('an unknown recipe or block is refused rather than throwing out of a UI handler', () => {
    const recipe = recipeWithNotesBlock();
    expect(applyPromptBlockSetting('no-such-recipe', 'no-such-block', 'depth', '7')).toBeNull();
    expect(applyPromptBlockSetting(recipe.id, 'no-such-block', 'depth', '7')).toBeNull();
});

// ------------------------------------------------- the point of the control
//
// The assertions above are about the editor. This one is about the reason it
// exists: a depth the user set has to change what the Narrator reads. Without
// it the whole feature could be "correct" and still govern nothing, which is
// exactly the state the review found it in.

test('a depth set through the control changes how many turns reach the Narrator', () => {
    const recipe = recipeWithNotesBlock();
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    const block = blockFor(recipe, (entry) => entry.sourceKey === 'directorNotes');

    appendDirectorEntries('tl-setting', { sceneId: 'sc', turn: 1, entries: [{ type: 'note', text: 'oldest turn' }] });
    appendDirectorEntries('tl-setting', { sceneId: 'sc', turn: 2, entries: [{ type: 'note', text: 'middle turn' }] });
    appendDirectorEntries('tl-setting', { sceneId: 'sc', turn: 3, entries: [{ type: 'note', text: 'newest turn' }] });

    const scene = { id: 'sc', timelineId: 'tl-setting' };

    // The shipped default: three turns, so all three are in view.
    expect(formatDirectorNotesPrompt(scene)).toContain('oldest turn');

    applyPromptBlockSetting(recipe.id, block.id, 'depth', '1');
    const narrowed = formatDirectorNotesPrompt(scene);
    expect(narrowed).toContain('newest turn');
    expect(narrowed).not.toContain('middle turn');
    expect(narrowed).not.toContain('oldest turn');

    applyPromptBlockSetting(recipe.id, block.id, 'depth', '2');
    const widened = formatDirectorNotesPrompt(scene);
    expect(widened).toContain('newest turn');
    expect(widened).toContain('middle turn');
    expect(widened).not.toContain('oldest turn');
});
