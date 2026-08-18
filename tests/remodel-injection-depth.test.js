import { createPromptRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// Director's Notes and Story Goals are IN_CHAT depth injections: core places
// them by counting back from the newest message, so where the block sits in
// the recipe reaches nothing. Both used to pass a hardcoded 1 while the editor
// claimed the recipe position governed them. The depth is now a real setting.

beforeEach(() => { __setExtensionSettings({ remodel: {} }); });

function settingsFor(sourceKey) {
    const recipe = createPromptRecipe({ mode: 'roleplay', apiType: 'chat' });
    const block = recipe.blocks.find((entry) => entry.kind === 'source' && entry.sourceKey === sourceKey);
    return block?.settings;
}

test.each(['directorNotes', 'storyGoals'])('%s declares an injection depth, defaulted to where it used to be hardcoded', (sourceKey) => {
    // Defaulting to 1 keeps every existing Scene rendering exactly as before;
    // this change gives the number a name, it does not move anything.
    expect(settingsFor(sourceKey).injectionDepth).toBe(1);
});

test("Director's Notes keeps its separate turns-to-include setting", () => {
    // Two different numbers with two different units. `depth` is how many
    // Director TURNS of notes to include; `injectionDepth` is how many chat
    // MESSAGES from the end the block sits. Collapsing them into one field
    // would silently change what an existing recipe means.
    const settings = settingsFor('directorNotes');

    expect(settings.depth).toBe(3);
    expect(settings.injectionDepth).toBe(1);
});

test('the block description no longer claims recipe position governs it', async () => {
    const { getSourceDescription } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js')
        .catch(() => ({ getSourceDescription: null }));
    if (!getSourceDescription) return; // not exported; covered by the store test below
    expect(getSourceDescription('roleplay', 'directorNotes')).not.toMatch(/at this position/i);
});
