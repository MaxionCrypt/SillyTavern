import { readFileSync } from 'node:fs';
import {
    buildDirectorNotesSource,
    clearLiveDirectionFailure,
    formatDirectorNotesPrompt,
    getLiveDirectionRun,
    initLiveDirection,
    requestNextDirection,
    setLiveDirectionTestAdapters,
    stopLiveDirection,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { appendDirectorEntries, readNarratorEntries } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import {
    capturePromptStudioRuntimeSettings,
    compilePromptRecipe,
    getCurrentPromptStudioRecipe,
    initPromptStudio,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { oai_settings } from './util/openai-stub.js';
import {
    PROMPT_SOURCE_DEFINITIONS,
    createBlocksFromNativeChat,
    createPromptRecipe,
    getPromptStudioStore,
    normalizeRecipe,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __emit, __getChat, __setExtensionSettings } from './util/st-context-stub.js';
import { __clearExtensionPromptCalls, __setOnlineStatus } from './util/script-stub.js';

// generateDirectedPerformer (reached only by the lifecycle test near the
// bottom of this file) clears SillyTavern's native composer before handing
// generation to core, touching the DOM once. Jest's environment is `node`;
// these are the two bindings it reaches for. Same stubs as
// remodel-direction-lifecycle.test.js, which exercises the same function.
globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

beforeEach(() => {
    __setExtensionSettings({});
    __clearExtensionPromptCalls();
    nativePromptCapture.clear();
});

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
    // The declared settings are normalized onto the block, so this object also
    // carries injectionDepth's default. Asserted by field rather than by whole
    // -object equality: this test is about `depth` reaching the resolver, and
    // it should not fail every time the source declares an unrelated setting.
    expect(receivedSettings.depth).toBe(7);
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

// --- Fix round 1, Critical 1: the migration is version-gated, so it is not on
// its own enough. Two further paths produced a roleplay/chat recipe with no
// Director's Notes block AFTER the upgrade — and since the depth-0 direction
// injection was removed, such a recipe leaves the Narrator with no direction
// at all while the notebook fills and the prose generates normally.

test('a roleplay/chat recipe created after the upgrade carries the notes block', () => {
    // The migration only ever runs once per store version, so a recipe created
    // later gets nothing from it. Defaults have to carry the block themselves.
    const created = createPromptRecipe({ name: 'Made later', mode: 'roleplay', apiType: 'chat' });
    const block = created.blocks.find((entry) => entry.kind === 'source' && entry.sourceKey === 'directorNotes');
    expect(block).toBeDefined();
    expect(block.nativeIdentifier).toBe('remodel_director_notes');
    expect(block.settings.depth).toBe(3);
});

test('a native re-sync keeps the notes block that the loaded preset does not know about', () => {
    // The worst of the three paths: an EXISTING user, already migrated, loads
    // any Chat Completion preset authored before Remodel. captureNativeSettingsFor
    // replaces the recipe's blocks wholesale from oai_settings, and the preset's
    // prompt order has no remodel_director_notes in it.
    //
    // Driven through the real exported entry point rather than through
    // withRemodelSources directly — the defect was that the call site did not
    // apply it, so a test of the helper alone would have stayed green.
    //
    // ORDER MATTERS, and getting it wrong is why the first version of this
    // test passed against the unfixed code: captureNativeSettingsFor returns
    // immediately when the native signature is unchanged. Studio has to be
    // running FIRST, against the settings it was initialised with, and the
    // preset has to arrive after — which is also the real sequence.
    globalThis.document.addEventListener ??= () => {};
    initPromptStudio({ getRuntimeMode: () => 'roleplay' });
    const before = getCurrentPromptStudioRecipe('roleplay', 'chat');
    expect(before.blocks.some((block) => block.sourceKey === 'directorNotes')).toBe(true);

    // The user loads a Chat Completion preset authored before Remodel existed.
    oai_settings.prompts = [
        { identifier: 'main', name: 'Main Prompt', content: 'You are a narrator.', system_prompt: true },
        { identifier: 'chatHistory', name: 'Chat History', marker: true },
    ];
    oai_settings.prompt_order = [{
        character_id: 100001,
        order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }],
    }];

    // A preset change fires this. It is the same call the SETTINGS_UPDATED /
    // OAI_PRESET_CHANGED_AFTER / PRESET_CHANGED listeners make.
    capturePromptStudioRuntimeSettings();

    const after = getCurrentPromptStudioRecipe('roleplay', 'chat');
    const block = after.blocks.find((entry) => entry.kind === 'source' && entry.sourceKey === 'directorNotes');
    expect(block).toBeDefined();
    expect(block.settings.depth).toBe(3);
    // The preset's own blocks are still what the re-sync captured — this
    // restores Remodel's sources, it does not ignore the preset.
    expect(after.blocks.some((entry) => entry.sourceKey === 'chatHistory')).toBe(true);
});

test('the same re-sync also keeps Story Goals, the other Remodel-owned source', () => {
    // withRemodelSources restores both, because the re-sync stripped both for
    // the same reason — a pre-Remodel preset's prompt order names neither
    // identifier. Closing only the directorNotes half would have left the
    // identical defect open next to the fix for it, so the story-goals half is
    // deliberate and gets its own assertion.
    globalThis.document.addEventListener ??= () => {};
    initPromptStudio({ getRuntimeMode: () => 'roleplay' });
    expect(getCurrentPromptStudioRecipe('roleplay', 'chat').blocks.some((block) => block.sourceKey === 'storyGoals')).toBe(true);

    // A different preset again, so the native signature genuinely changes and
    // captureNativeSettingsFor does not return early (see the note above).
    oai_settings.prompts = [{ identifier: 'main', name: 'Main Prompt', content: 'A different preset.', system_prompt: true }];
    oai_settings.prompt_order = [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }];
    capturePromptStudioRuntimeSettings();

    const after = getCurrentPromptStudioRecipe('roleplay', 'chat');
    expect(after.blocks.some((block) => block.sourceKey === 'storyGoals')).toBe(true);
    expect(after.blocks.some((block) => block.sourceKey === 'directorNotes')).toBe(true);
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

// Fix round 1, Important #1: the block-enabled toggle is visible in Prompt
// Studio (the per-block eye icon) and must not be the one control on this
// source that silently does nothing.
test('formatDirectorNotesPrompt renders nothing when the directorNotes block is disabled, not just when it is deleted', () => {
    const recipe = createPromptRecipe({
        name: 'RP disabled notes', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: false, settings: { depth: 5 } }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    appendDirectorEntries('tl-notes-5', { sceneId: 's5', turn: 1, entries: [{ type: 'note', text: 'should be off' }] });
    expect(formatDirectorNotesPrompt({ id: 's5', timelineId: 'tl-notes-5' })).toBe('');
});

// --- Fix round 1: the delivery call and the reverse mapping, both covered --

// Important #2: deleting the setExtensionPrompt registration in
// timeline-spine.js (the line that is Finding 1's actual fix) left the suite
// at 136/136 green. timeline-spine.js is not import-testable (it touches the
// DOM at module scope through its many downstream imports), so this reads it
// as text: every Remodel-owned native source must be registered as a real
// setExtensionPrompt(...) call in the idle-state mirror (renderRoleplayScene).
// Generic over PROMPT_SOURCE_DEFINITIONS.roleplay rather than hardcoding
// 'remodel_director_notes', so the next Remodel-owned source is covered by
// construction, not by remembering to extend this test. Checked against
// timeline-spine.js ALONE — not merged with live-direction.js's text — so
// deleting either file's registration is individually caught: the fix-round
// review's mutation (MR-B) deleted only the timeline-spine.js line, and a
// combined-text check would have missed that because live-direction.js's own
// generation-seam registration (Critical 1's fix, added this round) would
// still have matched.
test('every Remodel-owned native source is registered in the idle-state mirror (timeline-spine.js)', () => {
    const timelineSpineSource = readFileSync(
        new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-spine.js', import.meta.url),
        'utf8',
    );
    const remodelSources = PROMPT_SOURCE_DEFINITIONS.roleplay.filter((source) => String(source.nativeIdentifier || '').startsWith('remodel_'));
    expect(remodelSources.length).toBeGreaterThan(0);
    for (const source of remodelSources) {
        expect(timelineSpineSource).toMatch(new RegExp(`setRemodelNativePromptContent\\(\\s*['"\`]${source.key}['"\`]`));
    }
});

// Critical 1's fix specifically: the generation-seam registration in
// live-direction.js (added this round, alongside the idle mirror above) must
// also exist as literal source text, independent of the behavioural lifecycle
// test further down — a textual regression here should fail fast without
// needing the full lifecycle harness to diagnose it.
test('directorNotes is also registered at the generation seam (live-direction.js), not only the idle mirror', () => {
    const liveDirectionSource = readFileSync(
        new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js', import.meta.url),
        'utf8',
    );
    // Delivery moved off setExtensionPrompt: these are native prompt CONTENT now,
    // placed by the recipe's own ordering rather than injected at a chat depth.
    // The property is unchanged - the generation seam must still refresh the
    // notes, or the Narrator reads last turn's notebook.
    expect(liveDirectionSource).toMatch(/setNativePromptContent\(\s*['"`]directorNotes['"`]/);
});

// Important #3: deleting the reverse mapping (nativeMarkerToSource's
// remodel_director_notes -> directorNotes entry) also left the suite at
// 136/136 green, and its failure mode is silent: a recipe re-imported from
// native settings would key the block by the raw identifier instead of the
// source key, and formatDirectorNotesPrompt's sourceKey === 'directorNotes'
// lookup would miss it with no error. Asserts the actual round trip through
// the exported entry point, not the internal map.
test('a recipe re-imported from native settings resolves remodel_director_notes back to the directorNotes source key', () => {
    const blocks = createBlocksFromNativeChat(
        [{ identifier: 'remodel_director_notes', marker: true, system_prompt: true }],
        [{ character_id: '100001', order: [{ identifier: 'remodel_director_notes', enabled: true }] }],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sourceKey).toBe('directorNotes');
});

// --- Fix round 1, Critical: the notes must arrive the SAME turn they were
// written, not the render before it ------------------------------------------
//
// renderRoleplayScene's mirror (timeline-spine.js) only runs on UI and
// post-generation events — nothing calls it between the Director's entries
// landing in the store and the Narrator's context.generate(). This drives
// the real directed-turn lifecycle (the same harness
// remodel-direction-lifecycle.test.js uses) with a stubbed Director call that
// appends a fresh entry — standing in for Task 6's eventual
// parseDirectorReply -> appendDirectorEntries wiring.
//
// Fix round 2: the original version of this test read the mock's
// *last-recorded* value for 'remodel_director_notes' after the whole run had
// settled. That cannot distinguish "mirrored before generation" from
// "mirrored after" — either ordering ends with the same final recorded
// value, since setExtensionPrompt only ever gets called once per turn either
// way. When the reviewer moved the real mirror call to fire after
// generation, this test still passed at 16/16 green: a test named for an
// ordering property that survives the ordering being inverted. Fixed by
// capturing the value INSIDE the generatePerformer test adapter itself — the
// exact stand-in for context.generate(), so this is the value visible at the
// moment generation actually began, not whatever the recorder holds once
// everything is done.

const lifecycleScene = {
    id: 'scene-notes-lifecycle',
    timelineId: 'timeline-notes-lifecycle',
    title: 'Notes Lifecycle Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};
const lifecycleCast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];

/**
 * The Director's reply, in the free-form notebook shape it now streams back.
 *
 * Task 4 wrote these two tests against a stand-in: the adapter returned an
 * envelope AND called appendDirectorEntries by hand, because Task 6's real
 * parse-and-store wiring did not exist yet. It does now, so the stand-in is
 * gone — the entry these tests look for is the one live-direction.js itself
 * parsed out of this reply and stored.
 */
function lifecycleDirectorReply() {
    return '[ruling] Teo finally answers Eli.';
}

async function speakInLifecycle() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: 'Wren answers.', extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

/**
 * A map that `setNativePromptContent` hooks write into so lifecycle tests can
 * read what the hook last delivered, keyed by sourceKey.
 */
const nativePromptCapture = new Map();

/**
 * Wraps `speakInLifecycle` (the `generatePerformer` test adapter, the exact
 * stand-in for `context.generate()`) so the FIRST thing it does — before
 * anything else runs — is read what `directorNotes` currently holds in the
 * hook capture, and store it on `capture.value`. This is what "the Narrator
 * generates" means operationally in this harness: whatever the hook last
 * wrote is what a real generation would have read.
 */
function capturingPerformer(capture) {
    return async (...args) => {
        capture.value = nativePromptCapture.get('directorNotes');
        return speakInLifecycle(...args);
    };
}

/** Poll rather than sleep: the reveal loop chains through its own timers (see remodel-direction-lifecycle.test.js's identical helper). */
async function untilLifecycle(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

test('an entry appended during the Director call reaches the mirror the SAME turn, before the Narrator generates', async () => {
    const recipe = createPromptRecipe({
        name: 'RP lifecycle', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 5 } }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    __setOnlineStatus('connected');

    initLiveDirection({
        getActiveScene: () => lifecycleScene,
        getCast: () => lifecycleCast,
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => '',
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
        setNativePromptContent: (key, content) => { nativePromptCapture.set(key, content); },
    });
    const capture = { value: undefined };
    setLiveDirectionTestAdapters({
        requestDirection: async () => lifecycleDirectorReply(),
        generatePerformer: capturingPerformer(capture),
    });

    await requestNextDirection(lifecycleScene);
    expect(await untilLifecycle(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    expect(capture.value).toContain('Teo finally answers Eli.');
});

// The generation-seam call passes `formatDirectorNotesPrompt(scene)` where
// `scene` is the one the direction was initiated for — not whatever the
// active scene happens to be by the time the hook fires. This means notes
// are always scoped to the originating scene: even if the user switches
// scenes between the Director's reply and generation, the content delivered
// through the hook belongs to the right notebook.
test('the generation-seam hook delivers notes scoped to the originating scene, not the currently active one', async () => {
    const recipe = createPromptRecipe({
        name: 'RP lifecycle filter', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'directorNotes', role: 'system', enabled: true, settings: { depth: 5 } }],
    });
    setActivePromptRecipe('roleplay', 'chat', recipe.id);
    __setOnlineStatus('connected');

    let activeSceneOverride = lifecycleScene;
    initLiveDirection({
        getActiveScene: () => activeSceneOverride,
        getCast: () => lifecycleCast,
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => '',
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
        setNativePromptContent: (key, content) => { nativePromptCapture.set(key, content); },
    });
    const capture = { value: undefined };
    setLiveDirectionTestAdapters({
        requestDirection: async () => {
            // Switch the active scene while the Director is replying —
            // simulating the user navigating away mid-generation.
            activeSceneOverride = { ...lifecycleScene, id: 'scene-elsewhere' };
            return lifecycleDirectorReply();
        },
        generatePerformer: capturingPerformer(capture),
    });

    await requestNextDirection(lifecycleScene);
    expect(await untilLifecycle(() => getLiveDirectionRun()?.state === 'Waiting for you')).toBe(true);

    // The hook was called with the originating scene's notes, not the new
    // active scene's (which has no notebook entries at all).
    expect(capture.value).toContain('Teo finally answers Eli.');
});
