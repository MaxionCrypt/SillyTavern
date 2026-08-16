import { buildDirectorNotesSource, formatDirectorNotesPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { appendDirectorEntries, readNarratorEntries } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { compilePromptRecipe, getCurrentPromptStudioRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import {
    PROMPT_SOURCE_DEFINITIONS,
    createPromptRecipe,
    getPromptStudioStore,
    normalizeRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => { __setExtensionSettings({}); });

// --- buildDirectorNotesSource: the brief's own fixtures, verbatim -----------

test('the notes source renders recent non-secret entries and honours depth', () => {
    const text = buildDirectorNotesSource([
        { turn: 4, type: 'note', text: 'Teo stalls.' },
        { turn: 5, type: 'ruling', text: 'If Eli sits, Teo talks.' },
    ]);
    expect(text).toContain('Teo stalls.');
    expect(text).toContain('If Eli sits, Teo talks.');
    expect(text).not.toMatch(/\[secret\]/i);
});

test('no entries renders nothing rather than an empty heading', () => {
    expect(buildDirectorNotesSource([]).trim()).toBe('');
});

// --- secrets end to end: through the real store, not just the formatter ----
//
// buildDirectorNotesSource trusts its input is already Narrator-safe (see its
// own docstring) — it does not re-check `type`. The boundary this design
// exists for is enforced at readNarratorEntries, so that is what has to be
// exercised to prove a secret never reaches the rendered prose.

test('a secret entry survives appendDirectorEntries but never reaches the rendered notes', () => {
    appendDirectorEntries('tl-notes-1', {
        sceneId: 's1', turn: 1, entries: [
            { type: 'note', text: 'Teo stalls.' },
            { type: 'secret', text: 'He saw the janitor.' },
        ],
    });
    const entries = readNarratorEntries('tl-notes-1', { sceneId: 's1', depth: 10 });
    const text = buildDirectorNotesSource(entries);
    expect(text).toContain('Teo stalls.');
    expect(text).not.toContain('janitor');
});

// --- depth plumbing ----------------------------------------------------------

test('depth limits which turns reach the rendered notes', () => {
    appendDirectorEntries('tl-notes-2', { sceneId: 's2', turn: 1, entries: [{ type: 'note', text: 'old news' }] });
    appendDirectorEntries('tl-notes-2', { sceneId: 's2', turn: 2, entries: [{ type: 'note', text: 'fresh news' }] });
    const recent = buildDirectorNotesSource(readNarratorEntries('tl-notes-2', { sceneId: 's2', depth: 1 }));
    expect(recent).toContain('fresh news');
    expect(recent).not.toContain('old news');
    const both = buildDirectorNotesSource(readNarratorEntries('tl-notes-2', { sceneId: 's2', depth: 2 }));
    expect(both).toContain('old news');
    expect(both).toContain('fresh news');
});

// --- compilePromptRecipe: settings feed the compile, but never leak --------

test('settings never leak into the compiled prompt', () => {
    const recipe = normalizeRecipe({
        id: 'r-notes', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true }],
    });
    const compiled = compilePromptRecipe(recipe, { directorNotes: 'Teo stalls.' });
    expect(JSON.stringify(compiled.messages)).not.toContain('depth');
    expect(JSON.stringify(compiled.messages)).toContain('Teo stalls.');
});

test('a function-form source receives the block settings, and only its return value reaches the compiled text', () => {
    const recipe = normalizeRecipe({
        id: 'r-notes-fn', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 7 } }],
    });
    let receivedSettings = null;
    const compiled = compilePromptRecipe(recipe, {
        directorNotes: (settings) => { receivedSettings = settings; return 'Teo stalls.'; },
    });
    expect(receivedSettings).toEqual({ depth: 7 });
    expect(compiled.messages[0].content).toBe('Teo stalls.');
    expect(JSON.stringify(compiled.messages)).not.toContain('depth');
});

// --- the native route: nativeIdentifier, seeding, migration -----------------
//
// A roleplay recipe is mirrored into SillyTavern's native Prompt Manager, and
// that mirroring is the only thing that gets a source's content into a real
// Narrator generation (see prompt-studio-store.js's directorNotes comment).
// A source with no nativeIdentifier renders in the editor and reaches nothing.

test('directorNotes declares the native identifier that routes it into the Narrator prompt', () => {
    const definition = PROMPT_SOURCE_DEFINITIONS.roleplay.find((source) => source.key === 'directorNotes');
    expect(definition.nativeIdentifier).toBe('remodel_director_notes');
});

test('a freshly seeded store carries a directorNotes block already defaulted to depth 3', () => {
    const store = getPromptStudioStore();
    const chatRecipe = Object.values(store.recipes).find((recipe) => recipe.mode === 'roleplay' && recipe.apiType === 'chat');
    const block = chatRecipe.blocks.find((entry) => entry.kind === 'source' && entry.sourceKey === 'directorNotes');
    expect(block).toBeDefined();
    expect(block.nativeIdentifier).toBe('remodel_director_notes');
    expect(block.settings.depth).toBe(3);
});

test('a pre-existing store (no directorNotes block yet) is migrated to carry one, defaulted to depth 3', () => {
    const settings = __setExtensionSettings({});
    // Establish a store the normal way, then roll it back to a pre-Task-4
    // shape: strip the directorNotes block that seeding just added, and set
    // the version back to what a real pre-existing user would have stored.
    getPromptStudioStore();
    const store = settings.remodel.promptStudioV1;
    const chatRecipe = Object.values(store.recipes).find((recipe) => recipe.mode === 'roleplay' && recipe.apiType === 'chat');
    chatRecipe.blocks = chatRecipe.blocks.filter((block) => block.sourceKey !== 'directorNotes');
    store.version = 5;

    const migrated = Object.values(getPromptStudioStore().recipes).find((recipe) => recipe.mode === 'roleplay' && recipe.apiType === 'chat');
    const block = migrated.blocks.find((entry) => entry.kind === 'source' && entry.sourceKey === 'directorNotes');
    expect(block).toBeDefined();
    expect(block.settings.depth).toBe(3);
});

// --- formatDirectorNotesPrompt: the glue timeline-spine.js calls -----------

test('formatDirectorNotesPrompt reads depth off the active recipe and renders the real notebook', () => {
    const recipe = createPromptRecipe({
        name: 'RP', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 1 } }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    expect(getCurrentPromptStudioRecipe('roleplay', 'chat').id).toBe(recipe.id);

    appendDirectorEntries('tl-notes-3', { sceneId: 's3', turn: 1, entries: [{ type: 'note', text: 'buried turn' }] });
    appendDirectorEntries('tl-notes-3', {
        sceneId: 's3', turn: 2, entries: [
            { type: 'note', text: 'surfaced turn' },
            { type: 'secret', text: 'never surfaces' },
        ],
    });

    const prompt = formatDirectorNotesPrompt({ id: 's3', timelineId: 'tl-notes-3' });
    expect(prompt).toContain('surfaced turn');
    expect(prompt).not.toContain('buried turn');
    expect(prompt).not.toContain('never surfaces');
});

test('formatDirectorNotesPrompt renders nothing when the active recipe carries no directorNotes block', () => {
    const recipe = createPromptRecipe({ name: 'RP no notes', mode: 'roleplay', apiType: 'chat', blocks: [] });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    appendDirectorEntries('tl-notes-4', { sceneId: 's4', turn: 1, entries: [{ type: 'note', text: 'would render if enabled' }] });
    expect(formatDirectorNotesPrompt({ id: 's4', timelineId: 'tl-notes-4' })).toBe('');
});
