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
        // The protocol is a MESSAGE now, not a locked source: its prose is the
        // owner's to rewrite, and the parts the parser depends on reach it
        // through {{director::…}} macros that expand at compile time.
        'message',
        // World Info brackets the Director's own material the way it brackets
        // the character's in a Roleplay recipe. These were one LORE section
        // inside the locked Scene Snapshot, so the Director was the only
        // prompt that could not reorder or disable part of its world info.
        'worldInfoBefore',
        'directorCard',
        'message',
        'mechanicsSkill',
        'worldInfoAfter',
        'worldInfoExamples',
        'worldInfoDepth',
        // The Director's own notebook, read back before the Scene Snapshot:
        // the memory is read before the moment it is being asked about, and
        // after the mechanics block whose names its entries refer to.
        'directorNotebook',
        'directorSnapshot',
    ]);
});

test('the seeded notebook block carries its declared depth, so the source is not wired-and-inert', () => {
    const recipe = createPromptRecipe({ name: 'Test Director', mode: 'director', apiType: 'chat' });
    const notebook = recipe.blocks.find((block) => block.sourceKey === 'directorNotebook');
    expect(notebook.settings.depth).toBe(3);
});

test('an existing Director recipe is migrated to carry the notebook block, defaulted to depth 3', () => {
    // THE path the guarantee actually lives on, and the one this plan has been
    // bitten by twice: `ensureDirectorNotebookSource` splices a fresh block
    // into an ALREADY-NORMALIZED blocks array, so without the re-normalize
    // beside it the migrated block keeps `settings: {}`, the source renders
    // nothing, and every other symptom looks healthy — the feature wired and
    // inert.
    //
    // Rolled back to a real pre-upgrade shape rather than hand-built: strip
    // the block seeding just added and set the version back to what a
    // pre-existing user would have stored.
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const director = Object.values(store.recipes).find((recipe) => recipe.mode === 'director');
    director.blocks = director.blocks.filter((block) => block.sourceKey !== 'directorNotebook');
    store.version = 6;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    const notebook = migrated.blocks.find((block) => block.sourceKey === 'directorNotebook');
    expect(notebook).toBeDefined();
    expect(notebook.settings.depth).toBe(3);
    // Placed before the Scene Snapshot, not appended after it — the memory is
    // read before the moment it is being asked about.
    const keys = migrated.blocks.map((block) => block.sourceKey);
    expect(keys.indexOf('directorNotebook')).toBeLessThan(keys.indexOf('directorSnapshot'));
});

test('a Director recipe that already has the notebook block is not given a second one', () => {
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    settings.remodel.promptStudioV1.version = 6;
    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    expect(migrated.blocks.filter((block) => block.sourceKey === 'directorNotebook')).toHaveLength(1);
});

test('an existing Director recipe is migrated to carry the four World Info blocks', () => {
    // World Info stopped being a LORE section inside the locked Scene Snapshot
    // and became four blocks. An existing recipe has neither, and the failure
    // mode of a source that MOVES is silence: no error, no empty heading, the
    // Director simply stops being told anything about the world. This is the
    // path that guarantee lives on.
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const director = Object.values(store.recipes).find((recipe) => recipe.mode === 'director');
    const worldInfoKeys = ['worldInfoBefore', 'worldInfoAfter', 'worldInfoExamples', 'worldInfoDepth'];
    director.blocks = director.blocks.filter((block) => !worldInfoKeys.includes(block.sourceKey));
    store.version = 7;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    const keys = migrated.blocks.map((block) => block.sourceKey);
    for (const key of worldInfoKeys) expect(keys).toContain(key);

    // Placed in reading order, not appended: `before` ahead of the card, the
    // rest ahead of the notebook. The names mean nothing unless the order does.
    expect(keys.indexOf('worldInfoBefore')).toBeLessThan(keys.indexOf('directorCard'));
    expect(keys.indexOf('worldInfoAfter')).toBeLessThan(keys.indexOf('directorNotebook'));
    expect(keys.indexOf('worldInfoDepth')).toBeLessThan(keys.indexOf('directorSnapshot'));
});

test('a Director recipe that already has some World Info blocks gains only the rest', () => {
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const director = Object.values(store.recipes).find((recipe) => recipe.mode === 'director');
    // Strip one from each half of the migration — `before` is placed on its
    // own, the other three as a group — so both halves are exercised with a
    // sibling already present. Keeping all three of the group absent would let
    // a migration that ignores what is already there pass unnoticed: with
    // nothing to duplicate, filtering and not filtering agree.
    director.blocks = director.blocks.filter((block) => !['worldInfoBefore', 'worldInfoDepth'].includes(block.sourceKey));
    store.version = 7;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    const keys = migrated.blocks.map((block) => block.sourceKey);
    // Every one present exactly once: the two restored, and the two that
    // survived and must not have been added a second time.
    for (const key of ['worldInfoBefore', 'worldInfoAfter', 'worldInfoExamples', 'worldInfoDepth']) {
        expect(keys.filter((item) => item === key)).toHaveLength(1);
    }
});

test('migration is idempotent: a current-version Director recipe gains nothing', () => {
    const settings = __setExtensionSettings({});
    getPromptStudioStore();
    settings.remodel.promptStudioV1.version = 7;
    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'director');
    expect(migrated.blocks.filter((block) => block.sourceKey === 'worldInfoBefore')).toHaveLength(1);
});

test("only the snapshot is locked now — the protocol became the owner's to write", () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const locked = Object.fromEntries(recipe.blocks.filter((block) => block.sourceKey).map((block) => [block.sourceKey, block.locked]));

    expect(locked.directorSnapshot).toBe(true);
    expect(locked.directorCard).toBe(false);
    for (const block of recipe.blocks.filter((item) => item.kind === 'message')) {
        expect(block.locked).toBe(false);
    }
});

test('the seeded protocol carries the machinery as macros, not as frozen text', () => {
    const protocol = createPromptRecipe({ mode: 'director', apiType: 'chat' })
        .blocks.find((block) => block.kind === 'message' && block.content.includes('{{director::'));

    // The macros are the whole point: a pasted copy of the tags would be a
    // snapshot of what the parser wanted the day it was pasted.
    expect(protocol.content).toContain('{{director::notebook.tags}}');
    expect(protocol.content).toContain('{{director::state.fence}}');
    // And the literal tags must NOT be frozen into the seed.
    expect(protocol.content).not.toContain('[ruling]');
});

test('the editable style block carries the flow defaults as text', () => {
    const recipe = createPromptRecipe({ mode: 'director', apiType: 'chat' });
    const style = recipe.blocks.find((block) => block.kind === 'message' && !block.content.includes('{{director::'));
    expect(style.content).toMatch(/without waiting/i);
    expect(style.content.length).toBeGreaterThan(40);
});

test('the seeded style block does not instruct about machinery this rework deleted', () => {
    const style = createPromptRecipe({ mode: 'director', apiType: 'chat' })
        .blocks.find((block) => block.kind === 'message' && !block.content.includes('{{director::'));
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
    director.blocks.filter((block) => block.kind === 'message').at(-1).content = legacy;
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
