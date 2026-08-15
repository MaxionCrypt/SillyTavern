import {
    PROMPT_MODES,
    PROMPT_SOURCE_DEFINITIONS,
    createPromptRecipe,
    getPromptStudioStore,
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

test('the editable style block carries the flow defaults as text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const style = recipe.blocks.find((block) => block.kind === 'message');
    expect(style.content).toMatch(/without waiting/i);
    expect(style.content.length).toBeGreaterThan(40);
});

test('the seeded style block does not instruct about machinery this rework deleted', () => {
    const style = createPromptRecipe({ mode: 'director', apiType: 'chat' })
        .blocks.find((block) => block.kind === 'message');
    // `openings` is gone from the schema, the envelope and the reveal loop;
    // rhythm is derived by deriveBeats and the Narrator is told nothing about
    // pacing (design section 4). This is the default every user reads first.
    expect(style.content).not.toMatch(/opening/i);
    expect(style.content).not.toMatch(/rhythm/i);
    // The two flow decisions the Director genuinely still makes survive.
    expect(style.content).toMatch(/without waiting/i);
    expect(style.content).toMatch(/stop/i);
});

test('an existing store still carrying the retired style text is migrated once', () => {
    const settings = __setExtensionSettings({});
    // A store as a pre-existing user has it: version 4, with the untouched
    // default text that describes openings and rhythm.
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const director = Object.values(store.recipes).find((recipe) => recipe.mode === 'director');
    const legacy = 'The world may move without waiting for the user. Keep openings optional — the user may intervene anywhere. Responses may be long; give the performer useful guidance on rhythm, and only ask the scene to stop when the fiction is explicitly waiting on the user.';
    director.blocks.find((block) => block.kind === 'message').content = legacy;
    store.version = 4;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    expect(migrated.blocks.find((block) => block.kind === 'message').content).not.toMatch(/opening/i);
});

test('a style block the user edited themselves survives the migration', () => {
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const director = Object.values(store.recipes).find((recipe) => recipe.mode === 'director');
    director.blocks.find((block) => block.kind === 'message').content = 'Keep openings optional, I like them.';
    store.version = 4;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    expect(migrated.blocks.find((block) => block.kind === 'message').content).toBe('Keep openings optional, I like them.');
});

// Regression: PROMPT_SOURCE_DEFINITIONS had no `director` key, so
// getSourceDefinitions returned [] for every director recipe — "Add context"
// was permanently disabled, deleting directorCard or mechanicsSkill was
// irreversible, blocks displayed raw camelCase keys, and every block was
// described as "Resolved by SillyTavern's native Roleplay prompt manager".
test('every source a seeded director recipe uses is a defined, labelled director source', () => {
    const definitions = PROMPT_SOURCE_DEFINITIONS.director;
    expect(definitions.length).toBeGreaterThan(0);
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    for (const block of recipe.blocks.filter((item) => item.kind === 'source')) {
        const definition = definitions.find((source) => source.key === block.sourceKey);
        expect(definition).toBeDefined();
        // A label, not the key echoed back at the user.
        expect(definition.label).not.toBe(definition.key);
    }
    // No textOnly entries: a director recipe is never Text Completion, so a
    // textOnly source could never be added and would sit in the picker dead.
    expect(definitions.some((source) => source.textOnly)).toBe(false);
});

test('a deleted director source can be added back', () => {
    const definitions = PROMPT_SOURCE_DEFINITIONS.director;
    // mechanicsSkill is seeded unlocked, so the delete button is live for it —
    // and deleting it silently blinds the Director to every Variable and Goal
    // without tripping the protocol-keyed fallback. It is only survivable
    // because the picker can offer it again.
    expect(definitions.some((source) => source.key === 'mechanicsSkill')).toBe(true);
    expect(definitions.some((source) => source.key === 'directorCard')).toBe(true);
});

test('a director recipe is always chat, never text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'text' });
    expect(recipe.apiType).toBe('chat');
});

// Regression: a plain store initialisation (no explicit createPromptRecipe
// call) used to walk PROMPT_MODES x PROMPT_API_TYPES to seed each mode's
// active recipes, and nothing stopped it from seeding a director/text slot —
// the constraint "director recipes are Chat Completion only" was only
// enforced on the createPromptRecipe path, not here. Assert the requirement
// directly against a freshly initialised store, not against today's output.
test('initialising the store never creates a director recipe outside chat, and never an active text slot', () => {
    const store = getPromptStudioStore();
    const directorRecipes = Object.values(store.recipes).filter((recipe) => recipe.mode === 'director');
    // Sanity check this test actually exercises the seeding path.
    expect(directorRecipes.length).toBeGreaterThan(0);
    expect(directorRecipes.every((recipe) => recipe.apiType === 'chat')).toBe(true);
    expect('text' in (store.active.director || {})).toBe(false);
});
