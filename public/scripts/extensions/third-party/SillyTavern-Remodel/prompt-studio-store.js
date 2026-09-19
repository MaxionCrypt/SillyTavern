import { getContext } from '../../../st-context.js';
import { isSupersededLoomPatchContract, isSupersededLoomPatchPolicy, LOOM_OUTPUT_CONTRACT_PATCH, LOOM_POLICY_PATCH } from './loom-reconciliation.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'promptStudioV1';
const STORE_VERSION = 35;

export const NARRATOR_POLICY_DEFAULT = 'Continue the scene forward from the most recent message. Everything listed under "What has happened" is already written on the page — never restate, rewrite, summarise, or replay it. Advance the story: write only what happens next. Output only the story prose itself: never restate, repeat, quote, or acknowledge these notes, your instructions, or your role — begin directly with the narration.';
const NARRATOR_POLICY_WARNING = 'This policy prevents instruction echo and old-prose rewrites. Changing or disabling it can make the Narrator repeat its prompt or replay prior events.';
const NARRATOR_RECALL_WARNING = 'This macro supplies only eligible earlier-Scene Archive recall. The current Scene stays in Chat History and is never duplicated here.';
const CURATED_NARRATOR_RECIPE_NAME = 'Narrator · Grounded';
const ROLEPLAY_LOOM_LIVING_LORE_POLICY = [
    '## Living Lore — enabled',
    'Inspect Selected Living Lore when it is present. When accepted fiction changes one of those entries, rewrite it with a `lore.edit` op in the state fence `loreOps` array, naming its book and uid. When accepted fiction establishes a durable, reusable new subject no entry covers, add it with a `lore.create` op. Do not write lore directly in the prose and do not record fleeting detail.',
    'You may only edit an entry that is in the Selected Living Lore. To reach one that is not, name its key in `loreKeywords` to bring it into scope for a later turn. A non-empty `loreKeywords` REPLACES the whole working set with exactly those groups, so include everything the coming turns need; leave it empty to keep the current set.',
    'Leave `loreOps` empty when no durable lore change is warranted.',
].join('\n');

// Goals and Variables are dissolved into Living Lore (reserved-keyword entries),
// so the operations manual and the "pressures, not guarantees" framing block are
// gone. What the Loom needs to know about durable canon now rides on the Living
// Lore policy (ROLEPLAY_LOOM_LIVING_LORE_POLICY) and the loreOps contract.

export const PROMPT_MODES = ['story', 'roleplay', 'loom'];
export const PROMPT_API_TYPES = ['chat', 'text'];
export const PROMPT_ROLES = ['system', 'instruction', 'user', 'assistant'];

// Split, single-purpose state macros, available in EVERY recipe (getSourceDefinitions
// appends this set to whatever mode is being edited). The Loom Archive is
// dissolved and Goals/Variables folded into Living Lore, so only the current
// player action remains as a universal live-state slice. Its native identifier
// lets it mirror into a roleplay recipe's native prompt.
export const UNIVERSAL_STATE_MACROS = Object.freeze([
    template('loomAction', 'Player Action', 'user', 'loom.action', { nativeIdentifier: 'remodel_loom_action', description: 'The current player-authored speech or attempted action. It is authoritative over conflicting inference in the Narrator draft.' }),
]);

export const PROMPT_TEMPLATE_DEFINITIONS = Object.freeze({
    story: Object.freeze([
        template('characterCard', 'Character Card', 'system', 'character.card'),
        template('persona', 'Persona', 'system', 'user.persona'),
        template('worldInfoBefore', 'World Info (before)', 'system', 'world.info.before'),
        template('worldInfoAfter', 'World Info (after)', 'system', 'world.info.after'),
        template('worldInfoExamples', 'World Info Examples', 'system', 'world.info.examples'),
        template('worldInfoDepth', 'World Info at Depth', 'system', 'world.info.depth', { structured: true }),
        template('authorGuidance', 'Author Guidance', 'instruction', 'author.guidance'),
        template('priorText', 'Prior Scene', 'system', 'scene.prior'),
        template('manuscript', 'Manuscript', 'user', 'story.manuscript'),
        template('sceneBeat', 'Scene Beat / Continue Request', 'user', 'scene.beat'),
    ]),
    roleplay: Object.freeze([
        template('worldInfoBefore', 'World Info (before)', 'system', 'world.info.before', { nativeIdentifier: 'worldInfoBefore' }),
        template('personaDescription', 'Persona Description', 'system', 'user.persona', { nativeIdentifier: 'personaDescription' }),
        template('charDescription', 'Character Description', 'system', 'character.description', { nativeIdentifier: 'charDescription' }),
        template('charPersonality', 'Character Personality', 'system', 'character.personality', { nativeIdentifier: 'charPersonality' }),
        template('scenario', 'Scenario', 'system', 'scene.scenario', { nativeIdentifier: 'scenario' }),
        template('worldInfoAfter', 'World Info (after)', 'system', 'world.info.after', { nativeIdentifier: 'worldInfoAfter' }),
        template('dialogueExamples', 'Dialogue Examples', 'user', 'character.examples', { nativeIdentifier: 'dialogueExamples' }),
        // story.goals / narrator.grounding / narrator.recall are retired, and
        // Goals/Variables are dissolved into Living Lore. The Narrator now uses
        // only the surviving universal macro (loom.action); scene facts, character
        // states and events went with the dissolved Loom Archive. See
        // migrateRoleplayStateMacros.
        template('narratorNote', 'Narrator Note', 'system', 'narrator.note', {
            nativeIdentifier: 'remodel_narrator_note',
            description: 'Your per-scene Narrator Note. It is empty until you write one in the roleplay rail.',
            arguments: 'This macro has no arguments. Remove it from a recipe to keep that recipe unaware of the note.',
        }),
        template('chatHistory', 'Chat History', 'user', 'chat.history', { nativeIdentifier: 'chatHistory', structured: true, arguments: 'messages=N keeps the newest N native chat messages.' }),
        template('nextAction', 'Next Action', 'user', 'next.action', {
            nativeIdentifier: 'remodel_next_action',
            description: 'The newest player-authored action for this turn only. It is removed from Chat History and placed exactly where this macro sits.',
            arguments: 'This macro has no arguments. Remove it to keep the newest action inside Chat History instead.',
        }),
        // Native Chat Completion keeps the latest input inside chatHistory;
        // exposing it as an alias preserves that real marker boundary.
        template('currentInput', 'Current Input (via history)', 'user', 'chat.input', { nativeIdentifier: 'chatHistory', structured: true }),
        template('generationNudge', 'Generation Nudge', 'instruction', 'generation.nudge', { nativeIdentifier: 'quietPrompt' }),
        template('nativeContext', 'Native Roleplay Context', 'system', 'roleplay.native', { textOnly: true }),
    ]),
    loom: Object.freeze([
        // The split state macros (loom.scene/goals/…) live in UNIVERSAL_STATE_MACROS
        // and are appended to every mode by getSourceDefinitions.
        template('livingLore', 'Selected Living Lore', 'system', 'loom.lore', { description: 'The Timeline lore entries in scope for this scene, plus the loreOps/loreKeywords contract the Loom edits and pulls lore through.' }),
        template('priorLore', 'Prior-Scene Keywords', 'system', 'loom.priorlore', {
            description: 'The deduped keyword groups earlier Scenes of this timeline pulled lore with, so the Loom can replay what they established. Empty on the first Scene.',
            arguments: 'scenes=N looks back only N Scenes (the nearest N before this one). Omit it to draw on every prior Scene.',
        }),
        template('narratorDraft', 'Narrator Draft', 'user', 'narrator.draft', { description: 'The held Narrator prose being reconciled before it becomes visible.' }),
        template('narratorReasoning', 'Narrator Reasoning', 'user', 'narrator.reasoning', { description: 'The Narrator model\'s private reasoning for this draft, when the provider supplies it.' }),
    ]),
});

// Compatibility export for callers outside Remodel. Recipes themselves no
// longer persist source blocks; this catalog now describes insertion templates.
export const PROMPT_SOURCE_DEFINITIONS = PROMPT_TEMPLATE_DEFINITIONS;

function template(key, label, role, macro, extra = {}) {
    return Object.freeze({ key, label, role, macro, content: `{{${macro}}}`, ...extra });
}

const nativeMarkerToSource = Object.freeze({
    worldInfoBefore: 'worldInfoBefore',
    personaDescription: 'personaDescription',
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    worldInfoAfter: 'worldInfoAfter',
    dialogueExamples: 'dialogueExamples',
    chatHistory: 'chatHistory',
    remodel_next_action: 'nextAction',
    remodel_narrator_note: 'narratorNote',
    remodel_loom_action: 'loomAction',
    quietPrompt: 'generationNudge',
});

export function initializePromptStudioStore(seed = {}) {
    const namespace = getNamespace();
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = createSeededStore(seed);
        savePromptStudioStore();
    }
    if (normalizeStore(namespace[SETTINGS_KEY], seed)) savePromptStudioStore();
    return namespace[SETTINGS_KEY];
}

export function getPromptStudioStore() {
    return initializePromptStudioStore();
}

export function savePromptStudioStore() {
    getContext().saveSettingsDebounced();
}

export function getPromptRecipe(recipeId) {
    if (!recipeId) return null;
    return getPromptStudioStore().recipes[recipeId] || null;
}

export function getPromptRecipes({ mode = null, apiType = null } = {}) {
    const store = getPromptStudioStore();
    return store.recipeIds
        .map((id) => store.recipes[id])
        .filter(Boolean)
        .filter((recipe) => !mode || recipe.mode === mode)
        .filter((recipe) => !apiType || recipe.apiType === apiType);
}

export function getActivePromptRecipe(mode, apiType) {
    const store = getPromptStudioStore();
    const recipeId = store.active?.[mode]?.[apiType];
    return recipeId ? store.recipes[recipeId] || null : null;
}

export function setActivePromptRecipe(mode, apiType, recipeId) {
    const store = getPromptStudioStore();
    const recipe = store.recipes[recipeId];
    if (!recipe || recipe.mode !== mode || recipe.apiType !== apiType) return null;
    store.active[mode][apiType] = recipeId;
    savePromptStudioStore();
    return recipe;
}

export function createPromptRecipe({ name = 'Untitled Prompt', description = '', mode = 'story', apiType = 'chat', blocks = null, transport = null } = {}) {
    const store = getPromptStudioStore();
    const safeMode = PROMPT_MODES.includes(mode) ? mode : 'story';
    const requestedApiType = PROMPT_API_TYPES.includes(apiType) ? apiType : 'chat';
    const safeApiType = safeMode === 'loom' ? 'chat' : requestedApiType;
    const timestamp = now();
    const recipe = normalizeRecipe({
        id: createId('prompt'),
        name,
        description,
        mode: safeMode,
        apiType: safeApiType,
        blocks: Array.isArray(blocks) ? blocks : defaultBlocksFor(safeMode, safeApiType),
        transport: safeApiType === 'text' ? clone(transport || {}) : null,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
    store.recipes[recipe.id] = recipe;
    store.recipeIds.push(recipe.id);
    savePromptStudioStore();
    return recipe;
}

export function clonePromptRecipe(recipeId) {
    const source = getPromptRecipe(recipeId);
    if (!source) return null;
    return createPromptRecipe({
        name: `${source.name} Copy`,
        description: source.description,
        mode: source.mode,
        apiType: source.apiType,
        blocks: source.blocks.map((block) => ({ ...clone(block), id: createId('block'), nativeIdentifier: block.kind === 'message' ? '' : block.nativeIdentifier })),
        transport: clone(source.transport),
    });
}

export function updatePromptRecipe(recipeId, patch = {}) {
    const store = getPromptStudioStore();
    const recipe = store.recipes[recipeId];
    if (!recipe) return null;
    if (typeof patch.name === 'string') recipe.name = normalizeText(patch.name, recipe.name);
    if (typeof patch.description === 'string') recipe.description = patch.description;
    if (Array.isArray(patch.blocks)) recipe.blocks = normalizeBlocks(patch.blocks, recipe.mode, recipe.apiType);
    if (patch.transport && recipe.apiType === 'text') recipe.transport = clone(patch.transport);
    recipe.updatedAt = now();
    savePromptStudioStore();
    return recipe;
}

export function deletePromptRecipe(recipeId) {
    const store = getPromptStudioStore();
    if (!store.recipes[recipeId] || isRecipeActive(recipeId, store)) return false;
    delete store.recipes[recipeId];
    store.recipeIds = store.recipeIds.filter((id) => id !== recipeId);
    savePromptStudioStore();
    return true;
}

export function isPromptRecipeActive(recipeId) {
    return isRecipeActive(recipeId, getPromptStudioStore());
}

export function createPromptBlock({ kind = 'message', role = 'instruction', content = '', sourceKey = '', enabled = true, locked = false, nativeIdentifier = '', settings = undefined, advancedWarning = '', mode = null } = {}) {
    return normalizeBlock({
        id: createId('block'),
        kind,
        role,
        content,
        sourceKey,
        enabled,
        locked,
        nativeIdentifier,
        settings,
        advancedWarning,
    }, mode);
}

/** Insert an editable ordinary message from the mode's template catalog. */
export function createPromptBlockFromTemplate(mode, templateKey) {
    const definition = PROMPT_TEMPLATE_DEFINITIONS[mode]?.find((item) => item.key === templateKey)
        || UNIVERSAL_STATE_MACROS.find((item) => item.key === templateKey);
    if (!definition) return null;
    return createPromptBlock({
        kind: 'message',
        role: definition.role,
        content: definition.content,
        enabled: true,
        locked: false,
        nativeIdentifier: definition.nativeIdentifier || '',
        advancedWarning: definition.advancedWarning || '',
        mode,
    });
}

export function captureTextTransport(powerUser = {}) {
    return clone({
        sysprompt: powerUser.sysprompt || {},
        context: powerUser.context || {},
        instruct: powerUser.instruct || {},
    });
}

export function createBlocksFromNativeChat(prompts, promptOrder) {
    return blocksFromNativeChat(prompts, promptOrder);
}

/**
 * Add back the sources Remodel owns but the native prompt manager may not
 * carry — the same composition `createSeededStore` applies when it first
 * derives a roleplay/chat recipe from native settings.
 *
 * WHY THIS IS EXPORTED: a native re-sync (prompt-studio.js's
 * captureNativeSettingsFor) replaces a roleplay/chat recipe's blocks wholesale
 * from `oai_settings`, and every Chat Completion preset authored before Remodel
 * existed lacks Remodel's anti-echo policy in its prompt order. Without this,
 * loading such a preset silently strips that block out of an already-migrated
 * recipe.
 *
 * The helper is a no-op when the block is already present, so applying this to
 * blocks that already carry it changes nothing.
 */
export function withRemodelSources(blocks) {
    return withNarratorRecipeSources(blocks);
}

function getNamespace() {
    const context = getContext();
    context.extensionSettings[SETTINGS_NAMESPACE] ??= {};
    return context.extensionSettings[SETTINGS_NAMESPACE];
}

function createSeededStore(seed) {
    const store = {
        version: STORE_VERSION,
        recipeIds: [],
        recipes: {},
        active: {
            story: { chat: null, text: null },
            roleplay: { chat: null, text: null },
            loom: { chat: null },
        },
    };
    const timestamp = now();
    const transport = clone(seed.textTransport || {});
    const seeds = [
        {
            id: createId('prompt'),
            name: 'Current Story · Chat',
            description: 'The Story manuscript prompt active when Prompt Studio was created.',
            mode: 'story',
            apiType: 'chat',
            blocks: defaultStoryBlocks(),
            transport: null,
        },
        {
            id: createId('prompt'),
            name: 'Current Story · Text',
            description: 'The Story manuscript prompt compiled for Text Completion.',
            mode: 'story',
            apiType: 'text',
            blocks: defaultStoryBlocks(),
            transport: {
                ...transport,
                instruct: { ...(transport.instruct || {}), enabled: false },
            },
        },
        {
            id: createId('prompt'),
            name: CURATED_NARRATOR_RECIPE_NAME,
            description: 'A clean native Narrator stack with editable anti-echo policy and recipe-owned grounding.',
            mode: 'roleplay',
            apiType: 'chat',
            blocks: defaultBlocksFor('roleplay', 'chat'),
            transport: null,
        },
        {
            id: createId('prompt'),
            name: 'Current Roleplay · Chat',
            description: 'Imported from the native Chat Completion prompt manager.',
            mode: 'roleplay',
            apiType: 'chat',
            blocks: withRemodelSources(blocksFromNativeChat(seed.chatPrompts || [], seed.chatPromptOrder || [])),
            transport: null,
        },
        {
            id: createId('prompt'),
            name: 'Current Roleplay · Text',
            description: 'Uses SillyTavern’s token-budgeted native roleplay context.',
            mode: 'roleplay',
            apiType: 'text',
            blocks: [createPromptBlockFromTemplate('roleplay', 'nativeContext')],
            transport,
        },
        {
            id: createId('prompt'),
            name: 'Current Loom · Chat',
            description: 'Reconciles the Narrator draft with scene state and mechanics before it becomes visible.',
            mode: 'loom',
            apiType: 'chat',
            blocks: patchLoomBlocks(),
            transport: null,
        },
    ];
    for (const seedRecipe of seeds) {
        const recipe = normalizeRecipe({ ...seedRecipe, createdAt: timestamp, updatedAt: timestamp });
        store.recipes[recipe.id] = recipe;
        store.recipeIds.push(recipe.id);
        store.active[recipe.mode][recipe.apiType] = recipe.id;
    }
    return store;
}

function defaultStoryBlocks() {
    return [
        createPromptBlock({
            kind: 'message',
            role: 'instruction',
            content: 'You are the prose engine inside a fiction manuscript editor. Write only the requested story prose. Continue naturally from the manuscript, preserve continuity and point of view, and do not explain your work.',
            enabled: true,
        }),
        createPromptBlockFromTemplate('story', 'characterCard'),
        // No persona block: in a Story the user is the author, not a character
        // in the fiction, so "who the user is playing" is not part of the
        // prompt. Roleplay recipes still carry one.
        createPromptBlockFromTemplate('story', 'worldInfoBefore'),
        createPromptBlockFromTemplate('story', 'worldInfoAfter'),
        createPromptBlockFromTemplate('story', 'worldInfoExamples'),
        createPromptBlockFromTemplate('story', 'worldInfoDepth'),
        createPromptBlockFromTemplate('story', 'authorGuidance'),
        createPromptBlockFromTemplate('story', 'priorText'),
        createPromptBlockFromTemplate('story', 'manuscript'),
        createPromptBlockFromTemplate('story', 'sceneBeat'),
    ];
}

const PATCH_LOOM_RECIPE_NAME = 'Loom · Patch (fast)';

/**
 * The Loom blocks for the PATCH contract.
 *
 * Identical to the default set except for the policy and the output contract:
 * the Loom names only the spans a ruling changes instead of re-emitting the
 * whole turn. applySwaps() applies them in code, and a reply with no swaps
 * leaves the draft untouched — which is most turns.
 *
 * WHY: measured on a live session, the default contract cost 17-94 seconds per
 * turn re-typing prose that already existed, against 28-47 for the Narrator
 * that wrote it.
 */
function patchLoomBlocks() {
    return [
        createPromptBlock({ kind: 'message', role: 'system', content: LOOM_POLICY_PATCH }),
        createPromptBlockFromTemplate('loom', 'loomAction'),
        createPromptBlockFromTemplate('loom', 'livingLore'),
        createPromptBlockFromTemplate('loom', 'priorLore'),
        createPromptBlockFromTemplate('loom', 'narratorDraft'),
        createPromptBlockFromTemplate('loom', 'narratorReasoning'),
        createPromptBlock({
            kind: 'message',
            role: 'system',
            content: LOOM_OUTPUT_CONTRACT_PATCH,
            advancedWarning: 'Changing the state fence or swap schema can prevent the Loom reply from being parsed or applied.',
        }),
    ];
}

function defaultBlocksFor(mode, apiType) {
    if (mode === 'story') return defaultStoryBlocks();
    if (mode === 'loom') return patchLoomBlocks();
    if (apiType === 'text') {
        return [createPromptBlockFromTemplate('roleplay', 'nativeContext')];
    }
    // A clean native Narrator stack for recipes created inside Prompt Studio.
    // The imported "Current Roleplay" recipe still mirrors the owner's actual
    // native preset; this default is the efficient, macro-first starting point.
    return withRemodelSources([
        createPromptBlockFromTemplate('roleplay', 'worldInfoBefore'),
        createPromptBlockFromTemplate('roleplay', 'personaDescription'),
        createPromptBlockFromTemplate('roleplay', 'charDescription'),
        createPromptBlockFromTemplate('roleplay', 'charPersonality'),
        createPromptBlockFromTemplate('roleplay', 'scenario'),
        createPromptBlockFromTemplate('roleplay', 'worldInfoAfter'),
        createPromptBlockFromTemplate('roleplay', 'dialogueExamples'),
        createPromptBlockFromTemplate('roleplay', 'chatHistory'),
        createPromptBlockFromTemplate('roleplay', 'nextAction'),
        createPromptBlockFromTemplate('roleplay', 'generationNudge'),
    ]);
}

function blocksFromNativeChat(prompts, promptOrder) {
    const promptMap = new Map(prompts.filter(Boolean).map((prompt) => [prompt.identifier, prompt]));
    const order = findGlobalPromptOrder(promptOrder);
    if (!order.length) return defaultBlocksFor('roleplay', 'chat');
    return order.map((entry) => {
        const prompt = promptMap.get(entry.identifier) || {};
        const sourceKey = nativeMarkerToSource[entry.identifier];
        if (RETIRED_SOURCE_MACROS[sourceKey]) {
            // A native prompt-order still carrying a retired Remodel marker maps
            // to the split macros, not a dead {{native.prompt}} block.
            return createPromptBlock({
                kind: 'message',
                role: prompt.role || sourceRole('roleplay', sourceKey) || 'system',
                content: RETIRED_SOURCE_MACROS[sourceKey],
                enabled: entry.enabled !== false,
                nativeIdentifier: '',
            });
        }
        if (prompt.marker || sourceKey) {
            const definition = PROMPT_TEMPLATE_DEFINITIONS.roleplay.find((item) => item.key === (sourceKey || ''))
                || UNIVERSAL_STATE_MACROS.find((item) => item.key === (sourceKey || ''));
            return createPromptBlock({
                kind: 'message',
                role: prompt.role || sourceRole('roleplay', sourceKey) || 'system',
                content: definition?.content || `{{native.prompt id="${entry.identifier}"}}`,
                enabled: entry.enabled !== false,
                locked: false,
                nativeIdentifier: definition?.nativeIdentifier || entry.identifier,
                advancedWarning: definition?.advancedWarning || '',
            });
        }
        return createPromptBlock({
            kind: 'message',
            role: prompt.role === 'user' || prompt.role === 'assistant' ? prompt.role : 'system',
            content: prompt.content || '',
            enabled: entry.enabled !== false,
            locked: false,
            nativeIdentifier: entry.identifier,
        });
    });
}

function findGlobalPromptOrder(promptOrder) {
    const orders = Array.isArray(promptOrder) ? promptOrder : [];
    return orders.find((entry) => String(entry?.character_id) === '100001')?.order
        || orders.find((entry) => String(entry?.character_id) === '100000')?.order
        || [];
}

function normalizeStore(store, seed) {
    const previousVersion = Number(store.version) || 1;
    let changed = previousVersion < STORE_VERSION;
    store.version = STORE_VERSION;
    store.recipes = store.recipes && typeof store.recipes === 'object' ? store.recipes : {};
    store.recipeIds = Array.isArray(store.recipeIds) ? store.recipeIds.filter((id) => store.recipes[id]) : [];

    // Hard cleanup: obsolete hidden-pass recipes represented a different request
    // and are deliberately not converted into Loom recipes.
    for (const [id, value] of Object.entries(store.recipes)) {
        if (value?.mode === 'director' || value?.purpose === 'goalDirector') {
            delete store.recipes[id];
            store.recipeIds = store.recipeIds.filter((recipeId) => recipeId !== id);
            changed = true;
            continue;
        }
        const recipe = normalizeRecipe(value);
        if (!recipe) {
            delete store.recipes[id];
            store.recipeIds = store.recipeIds.filter((recipeId) => recipeId !== id);
            changed = true;
            continue;
        }
        if (recipe.mode === 'roleplay' && recipe.apiType === 'chat') {
            for (const block of recipe.blocks) {
                if (block.kind === 'source' && ['directorNotes', 'loomContext'].includes(block.sourceKey)) {
                    block.sourceKey = 'narratorGrounding';
                    block.nativeIdentifier = 'remodel_narrator_grounding';
                    block.settings = {};
                    changed = true;
                }
            }
            if (previousVersion < 30 && ensureNextActionSource(recipe.blocks)) changed = true;
        }
        if (previousVersion < 11) {
            recipe.blocks = recipe.blocks.map((block) => sourceBlockToMacroMessage(recipe.mode, block));
            changed = true;
        }
        // Versions 12 and 13 converted the Loom between successive "rewrite the
        // whole turn" policies. That whole contract is retired (see
        // loom-reconciliation.js), so those steps no longer run: a store old
        // enough to need them carries an owner-authored rewrite recipe, which
        // parseLoomReply still reads unchanged. Nothing here reintroduces it.
        // Version 14 makes the Narrator recipe authoritative. The old Loom
        // Context block was visually editable but its content was cleared and
        // replaced by a hidden extension-prompt injection. Migrate that macro
        // in place, add the editable default policy once, and keep every
        // scene-specific recipe id intact.
        if (previousVersion < 14 && recipe.mode === 'roleplay' && recipe.apiType === 'chat') {
            for (const block of recipe.blocks) {
                const migrated = String(block.content || '')
                    .replace(/\{\{\s*loom\.context\b/gi, '{{narrator.grounding')
                    .replace(/\{\{\s*director\.notes\b/gi, '{{narrator.grounding');
                if (migrated !== block.content) {
                    block.content = migrated;
                    changed = true;
                }
                if (['remodel_loom_context', 'remodel_director_notes'].includes(block.nativeIdentifier)) {
                    block.nativeIdentifier = 'remodel_narrator_grounding';
                    changed = true;
                }
            }
            if (migrateNarratorRecallSource(recipe.blocks)) changed = true;
            if (ensureNarratorPolicy(recipe.blocks)) changed = true;
        }
        if (previousVersion < 2 && recipe.mode === 'story' && migrateStoryWorldInfoSources(recipe)) changed = true;
        recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
        store.recipes[id] = recipe;
    }

    // v15: the Loom stops re-typing the turn it was given.
    //
    // The user's existing Loom recipe is NOT modified and stays selectable — it
    // may carry their own edits. A new patch-contract recipe is seeded and made
    // active, so the change is one dropdown away from being undone.
    // v16: the Loom was offered goal.create from the start and never used it,
    // because STEP 2 only asked it to record CHANGES to goals that already
    // existed. Nothing asked it to give anyone an objective, so goalCount was 0
    // on every turn and the Narrator's ## Objectives section never appeared.
    //
    // Replaces the policy ONLY where it is still the untouched v15 text — the
    // same rule the v13 migration used. An owner-edited Loom is left alone.
    // v18: Goals are consequential outcomes, not protected narration and not a
    // mandatory per-character inventory. Their rates move whenever accepted
    // fiction materially helps or obstructs the holder's position.
    //
    // Replaces the policy ONLY where it still matches a superseded version
    // verbatim — an owner-edited Loom is left exactly as authored.
    if (previousVersion < 18) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (!recipe || recipe.mode !== 'loom') continue;
            for (const block of recipe.blocks || []) {
                if (isSupersededLoomPatchPolicy(block.content)) {
                    block.content = LOOM_POLICY_PATCH;
                    changed = true;
                }
            }
        }
    }

    // v19 exposes the bounded World Sense selection to every Loom recipe as
    // an ordinary, removable macro block. Existing authored policy and output
    // text remain untouched; only the new dynamic source is inserted.
    if (previousVersion < 19) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode === 'loom' && ensureLivingLoreSource(recipe.blocks)) changed = true;
        }
    }

    if (previousVersion < 15 && !store.recipeIds.some((id) => store.recipes[id]?.name === PATCH_LOOM_RECIPE_NAME)) {
        const patchRecipe = createPromptRecipeWithoutSave(store, {
            name: PATCH_LOOM_RECIPE_NAME,
            description: 'The Loom names only the spans a ruling changes; code patches the draft. Much faster than re-emitting the whole turn.',
            mode: 'loom',
            apiType: 'chat',
            blocks: patchLoomBlocks(),
            transport: null,
        });
        if (patchRecipe?.id) {
            store.active.loom ??= {};
            store.active.loom.chat = patchRecipe.id;
        }
        changed = true;
    }

    if (previousVersion < 14 && !store.recipeIds.some((id) => store.recipes[id]?.name === CURATED_NARRATOR_RECIPE_NAME)) {
        createPromptRecipeWithoutSave(store, {
            name: CURATED_NARRATOR_RECIPE_NAME,
            description: 'A clean native Narrator stack with editable anti-echo policy and recipe-owned grounding.',
            mode: 'roleplay',
            apiType: 'chat',
            blocks: defaultBlocksFor('roleplay', 'chat'),
            transport: null,
        });
        changed = true;
    }

    // v22 makes Living Lore cultivation an explicit Patch Loom responsibility.
    // Earlier stores exposed {{loom.lore}}, but the policy never asked the
    // model to inspect durable canon and the oldest seeded output contract did
    // not advertise loreProposals at all. Replace only exact, recognized seeded
    // texts; owner-authored policy and contracts remain untouched.
    if (previousVersion < 22) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (!recipe || recipe.mode !== 'loom') continue;
            for (const block of recipe.blocks || []) {
                if (isSupersededLoomPatchPolicy(block.content)) {
                    block.content = LOOM_POLICY_PATCH;
                    changed = true;
                    continue;
                }
                if (isSupersededLoomPatchContract(block.content)) {
                    block.content = LOOM_OUTPUT_CONTRACT_PATCH;
                    changed = true;
                }
            }
        }
    }

    // v23 makes the current player-authored turn a first-class Loom source.
    // It was used for retrieval but disappeared when the post-Narrator Loom
    // snapshot was rebuilt, forcing the model to infer the action from prose.
    if (previousVersion < 23) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode === 'loom' && ensurePlayerActionSource(recipe.blocks)) changed = true;
        }
    }

    // v24 restores the promotion receipt to seeded Patch Loom text. Durable
    // lore cultivation (v22) and the World Sense promotion receipt shipped in
    // separate commits, so a store seeded between them advertises loreProposals
    // but never lorePromotionDecisions: the Loom is handed promotion candidates
    // it has no contracted way to answer and silently judges none of them. The
    // v22 block cannot repair this, because it only runs for stores below 22.
    // Owner-authored policy and contracts remain untouched, as they did in v22.
    if (previousVersion < 24) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (!recipe || recipe.mode !== 'loom') continue;
            for (const block of recipe.blocks || []) {
                if (isSupersededLoomPatchPolicy(block.content)) {
                    block.content = LOOM_POLICY_PATCH;
                    changed = true;
                    continue;
                }
                if (isSupersededLoomPatchContract(block.content)) {
                    block.content = LOOM_OUTPUT_CONTRACT_PATCH;
                    changed = true;
                }
            }
        }
    }

    // v28 replaces duplicate current-Scene grounding with earlier-Scene
    // recall. Living Lore remains recipe-owned and is never disabled here.
    if (previousVersion < 28) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode === 'roleplay' && recipe.apiType === 'chat') {
                if (migrateNarratorRecallSource(recipe.blocks)) changed = true;
            }
        }
    }

    // v29 removes the short-lived fictional-time macro from every Roleplay
    // recipe, including owner-authored recipes that opted into it.
    if (previousVersion < 29) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode === 'roleplay' && recipe.apiType === 'chat' && retireNarratorTimeSource(recipe.blocks)) changed = true;
        }
    }

    // v31 restores the owner-requested Living Lore channel to the Crown
    // Roleplay Loom recipe. The temporary v28 migration removed its macro and
    // state-fence guidance, leaving the model unable to propose lore even
    // though the runtime packet remained available.
    if (previousVersion < 31) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode !== 'loom' || String(recipe.name || '').trim().toLowerCase() !== 'crown prompt loom - roleplay') continue;
            if (ensureLivingLoreSource(recipe.blocks)) changed = true;
            if (restoreRoleplayLivingLoreInstructions(recipe.blocks)) changed = true;
        }
    }

    // The old seeded Continue sentence was visible in every empty-composer
    // request even though it was not owner-authored. Remove only that exact
    // retired default from saved recipes; any other blocks remain untouched.
    for (const id of store.recipeIds) {
        const recipe = store.recipes[id];
        if (recipe?.mode === 'roleplay' && retireDefaultContinueDirective(recipe.blocks)) changed = true;
    }

    store.active = store.active && typeof store.active === 'object' ? store.active : {};
    if (store.active.director) { delete store.active.director; changed = true; }
    if (store.active.goalDirector) { delete store.active.goalDirector; changed = true; }
    for (const mode of PROMPT_MODES) {
        store.active[mode] ??= {};
        const apiTypesForMode = mode === 'loom' ? ['chat'] : PROMPT_API_TYPES;
        for (const apiType of apiTypesForMode) {
            const current = store.recipes[store.active[mode][apiType]];
            if (current?.mode === mode && current.apiType === apiType) continue;
            const fallback = store.recipeIds.map((id) => store.recipes[id])
                .find((recipe) => recipe?.mode === mode && recipe.apiType === apiType);
            if (fallback) {
                store.active[mode][apiType] = fallback.id;
            } else {
                const created = createPromptRecipeWithoutSave(store, {
                    name: `Current ${capitalize(mode)} · ${capitalize(apiType)}`,
                    mode,
                    apiType,
                    blocks: defaultBlocksFor(mode, apiType),
                    transport: apiType === 'text' ? clone(seed.textTransport || {}) : null,
                });
                store.active[mode][apiType] = created.id;
            }
            changed = true;
        }
    }

    // v32/v33: retire the bundled boards and the Narrator-specific state macros
    // for the universal split macros. Runs last so it catches sources added by
    // an earlier gate (player.action, story.goals, narrator.recall, …).
    if (previousVersion < 33) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (recipe?.mode === 'loom' && migrateLoomStateBoards(recipe)) changed = true;
            if (recipe?.mode === 'roleplay' && migrateRoleplayStateMacros(recipe)) changed = true;
        }
    }

    // v34: the Loom Archive is dissolved. Strip the split archive macros that
    // v32/v33 produced -- they no longer resolve, so a persisted block would emit
    // the literal token. The player action survives.
    if (previousVersion < 34) {
        for (const id of store.recipeIds) {
            if (stripDeadArchiveMacros(store.recipes[id])) changed = true;
        }
    }

    // v35: Goals and Variables are dissolved into Living Lore (reserved-keyword
    // entries). Strip their macros, the Narrator mechanics tool block, and the
    // seeded operations-manual and "pressures" framing blocks from every recipe;
    // they no longer resolve or apply. Re-seed a Loom recipe still on the
    // pre-dissolution policy/contract (which described goal mechanics and a
    // `requests` fence the schema now rejects) to the current text; authored
    // policy is left untouched. loom.action and loom.lore survive.
    if (previousVersion < 35) {
        for (const id of store.recipeIds) {
            const recipe = store.recipes[id];
            if (!recipe) continue;
            if (stripDissolvedMechanicsBlocks(recipe)) changed = true;
            if (recipe.mode !== 'loom') continue;
            for (const block of recipe.blocks || []) {
                if (isSupersededLoomPatchPolicy(block.content)) { block.content = LOOM_POLICY_PATCH; changed = true; continue; }
                if (isSupersededLoomPatchContract(block.content)) { block.content = LOOM_OUTPUT_CONTRACT_PATCH; changed = true; }
            }
        }
    }
    return changed;
}

function ensureLivingLoreSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => /\{\{\s*loom\.lore\b/i.test(block.content || ''))) return false;
    const source = createPromptBlockFromTemplate('loom', 'livingLore');
    const draftIndex = blocks.findIndex((block) => /\{\{\s*narrator\.draft\b/i.test(block.content || ''));
    blocks.splice(draftIndex >= 0 ? draftIndex : blocks.length, 0, source);
    return true;
}

function retireDefaultContinueDirective(blocks) {
    if (!Array.isArray(blocks)) return false;
    const retained = blocks.filter((block) => !/Continue the scene autonomously from the accepted history\.\s*Return only the next new passage of scene prose\.\s*Do not repeat, summarize, or explain existing prose, and do not wait for player input\./i.test(String(block?.content || '')));
    if (retained.length === blocks.length) return false;
    blocks.splice(0, blocks.length, ...retained);
    return true;
}

function ensurePlayerActionSource(blocks) {
    // Now seeds loom.action; idempotent against the legacy player.action too.
    if (!Array.isArray(blocks) || blocks.some((block) => /\{\{\s*(player\.action|loom\.action)\b/i.test(block.content || ''))) return false;
    const source = createPromptBlockFromTemplate('loom', 'loomAction');
    const draftIndex = blocks.findIndex((block) => /\{\{\s*narrator\.draft\b/i.test(block.content || ''));
    blocks.splice(draftIndex >= 0 ? draftIndex : blocks.length, 0, source);
    return true;
}

/** Keep this turn's action independently placeable from the prior transcript. */
function ensureNextActionSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => /\{\{\s*next\.action\b/i.test(block.content || ''))) return false;
    const historyIndex = blocks.findIndex((block) => /\{\{\s*chat\.history\b/i.test(block.content || ''));
    if (historyIndex < 0) return false;
    blocks.splice(historyIndex + 1, 0, createPromptBlockFromTemplate('roleplay', 'nextAction'));
    return true;
}

/** Remove the retired clock macro from persisted Roleplay recipes. */
function retireNarratorTimeSource(blocks) {
    if (!Array.isArray(blocks)) return false;
    const kept = blocks.filter((block) => !(/\{\{\s*narrator\.time\b/i.test(block.content || '') || block.nativeIdentifier === 'remodel_narrator_time'));
    if (kept.length === blocks.length) return false;
    blocks.splice(0, blocks.length, ...kept);
    return true;
}

/** The macro of a block that is EXACTLY one macro ("{{loom.archive events=3}}"
 *  → "loom.archive"); '' when the block holds anything else. */
function soleBlockMacro(content) {
    const match = String(content || '').trim().match(/^\{\{\s*([a-z][\w.-]*)(?:\s+[^{}]*?)?\s*\}\}$/i);
    return match ? match[1].toLowerCase() : '';
}

/** Inline-rewrite the dead board macros to the split ones, preserving anything
 *  else in the same block (an authored block with other macros or prose). */
function rewriteLoomBoardTokens(content) {
    return String(content || '')
        .replace(/\{\{\s*player\.action\b[^{}]*\}\}/gi, '{{loom.action}}')
        .replace(/\{\{\s*loom\.archive\b[^{}]*\}\}/gi, '')
        .replace(/\{\{\s*loom\.mechanics\b[^{}]*\}\}/gi, '')
        .replace(/\{\{\s*loom\.lifecycle\b[^{}]*\}\}/gi, '');
}

/**
 * v32: retire a Loom recipe's bundled boards for the split state macros.
 *   player.action   → loom.action
 *   loom.archive    → dropped (the Loom Archive is dissolved)
 *   loom.mechanics  → dropped (Goals/Variables folded into Living Lore)
 *   loom.lifecycle  → dropped
 * A block that is exactly player.action is expanded into a loom.action template
 * block (nicer to edit); the dissolved boards are dropped. A block that merely
 * CONTAINS one — an authored block with surrounding text or other macros — is
 * rewritten token-by-token so nothing around it is lost. Every other block and
 * the ordering are untouched.
 */
function migrateLoomStateBoards(recipe) {
    if (recipe?.mode !== 'loom' || !Array.isArray(recipe.blocks)) return false;
    const EXPANSIONS = {
        'player.action': ['loomAction'],
        'loom.archive': [],
        'loom.mechanics': [],
        'loom.lifecycle': [],
    };
    let changed = false;
    const next = [];
    for (const block of recipe.blocks) {
        const macro = soleBlockMacro(block.content);
        if (macro && Object.prototype.hasOwnProperty.call(EXPANSIONS, macro)) {
            changed = true;
            for (const key of EXPANSIONS[macro]) {
                const created = createPromptBlockFromTemplate('loom', key);
                if (!created) continue;
                created.enabled = block.enabled !== false;
                next.push(created);
            }
            continue;
        }
        const rewritten = rewriteLoomBoardTokens(block.content);
        if (rewritten !== String(block.content || '')) {
            block.content = rewritten.replace(/\n{3,}/g, '\n\n').trim();
            changed = true;
        }
        next.push(block);
    }
    if (changed) recipe.blocks = next;
    return changed;
}

/**
 * v33: retire the Narrator-specific state macros. The Loom Archive is dissolved
 * and Goals/Variables are folded into Living Lore, so narrator.grounding,
 * narrator.recall and story.goals are all dropped outright. A whole-macro block
 * is removed; the same macro inside an authored block is stripped in place so the
 * surrounding text survives.
 */
function migrateRoleplayStateMacros(recipe) {
    if (recipe?.mode !== 'roleplay' || !Array.isArray(recipe.blocks)) return false;
    let changed = false;
    const next = [];
    for (const block of recipe.blocks) {
        const macro = soleBlockMacro(block.content);
        if (macro === 'narrator.grounding' || macro === 'narrator.recall' || macro === 'story.goals') {
            changed = true;
            continue;
        }
        // Mixed authored block: strip the dissolved macros in place.
        const rewritten = String(block.content || '')
            .replace(/\{\{\s*narrator\.grounding\b[^{}]*\}\}/gi, '')
            .replace(/\{\{\s*story\.goals\b[^{}]*\}\}/gi, '')
            .replace(/\{\{\s*narrator\.recall\b[^{}]*\}\}/gi, '');
        if (rewritten !== String(block.content || '')) {
            block.content = rewritten.replace(/\n{3,}/g, '\n\n').trim();
            if (['remodel_narrator_grounding', 'remodel_narrator_recall', 'remodel_story_goals'].includes(block.nativeIdentifier)) {
                block.nativeIdentifier = '';
            }
            changed = true;
        }
        next.push(block);
    }
    if (changed) recipe.blocks = next;
    return changed;
}

/**
 * v34: strip the split archive macros the dissolved Loom Archive left behind.
 * A block that is exactly one dead macro is dropped; a macro inside an authored
 * block is removed in place. loom.action / loom.goals / loom.variables survive.
 */
function stripDeadArchiveMacros(recipe) {
    if (!recipe || !Array.isArray(recipe.blocks)) return false;
    const dead = ['loom.scene', 'loom.characters', 'loom.events', 'loom.secrets', 'prev.events', 'narrator.grounding', 'narrator.recall'];
    let changed = false;
    const next = [];
    for (const block of recipe.blocks) {
        if (dead.includes(soleBlockMacro(block.content))) { changed = true; continue; }
        const content = String(block.content || '');
        const rewritten = content.replace(/\{\{\s*(loom\.scene|loom\.characters|loom\.events|loom\.secrets|prev\.events|narrator\.grounding|narrator\.recall)\b[^{}]*\}\}/gi, '');
        if (rewritten !== content) {
            block.content = rewritten.replace(/\n{3,}/g, '\n\n').trim();
            if (/^remodel_(loom_scene|loom_characters|loom_events|loom_secrets|prev_events|narrator_grounding|narrator_recall)$/.test(block.nativeIdentifier || '')) block.nativeIdentifier = '';
            changed = true;
        }
        next.push(block);
    }
    if (changed) recipe.blocks = next;
    return changed;
}

/**
 * v35: Goals and Variables are dissolved into Living Lore. Strip their macros
 * (loom.goals, loom.variables, story.goals), the Narrator mechanics tool block
 * (narrator.mechanics), and the two seeded prose blocks — the operations manual
 * and the "pressures, not guarantees" goals framing. A block that is exactly one
 * dead macro, or is one of those seeded prose blocks (matched by a distinctive
 * line so an owner-edited copy is still caught), is dropped; a dead macro inside
 * an authored block is removed in place. loom.action and loom.lore survive.
 */
function stripDissolvedMechanicsBlocks(recipe) {
    if (!recipe || !Array.isArray(recipe.blocks)) return false;
    const dead = ['loom.goals', 'loom.variables', 'story.goals', 'narrator.mechanics'];
    let changed = false;
    const next = [];
    for (const block of recipe.blocks) {
        const content = String(block.content || '');
        if (dead.includes(soleBlockMacro(content))) { changed = true; continue; }
        if (/^##\s*Operations — what you may change/.test(content.trim())
            || /pressures on the scene, never protected outcomes/.test(content)) {
            changed = true;
            continue;
        }
        const rewritten = content.replace(/\{\{\s*(loom\.goals|loom\.variables|story\.goals|narrator\.mechanics)\b[^{}]*\}\}/gi, '');
        if (rewritten !== content) {
            block.content = rewritten.replace(/\n{3,}/g, '\n\n').trim();
            if (/^remodel_(loom_goals|loom_variables|story_goals|narrator_mechanics)$/.test(block.nativeIdentifier || '')) block.nativeIdentifier = '';
            changed = true;
        }
        next.push(block);
    }
    if (changed) recipe.blocks = next;
    return changed;
}

function migrateNarratorRecallSource(blocks) {
    let changed = false;
    for (const block of Array.isArray(blocks) ? blocks : []) {
        if (/\{\{\s*narrator\.grounding\b/i.test(block.content || '')) {
            block.content = '{{narrator.recall scenes=3}}';
            block.nativeIdentifier = 'remodel_narrator_recall';
            block.advancedWarning = NARRATOR_RECALL_WARNING;
            changed = true;
        }
    }
    return changed;
}

function restoreRoleplayLivingLoreInstructions(blocks) {
    let changed = false;
    if (!Array.isArray(blocks) || blocks.some((block) => String(block.content || '') === ROLEPLAY_LOOM_LIVING_LORE_POLICY)) return changed;
    const contractIndex = blocks.findIndex((block) => /```state|"requests"\s*:/i.test(String(block.content || '')));
    blocks.splice(contractIndex >= 0 ? contractIndex : blocks.length, 0, createPromptBlock({
        kind: 'message', role: 'system', content: ROLEPLAY_LOOM_LIVING_LORE_POLICY,
    }));
    return true;
}

/** Seed one editable anti-echo/append-only policy before the Archive macro. */
function ensureNarratorPolicy(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.content === NARRATOR_POLICY_DEFAULT)) return false;
    const recallIndex = blocks.findIndex((block) => /\{\{\s*(narrator\.recall|prev\.events)\b/i.test(block.content || ''));
    blocks.splice(recallIndex >= 0 ? recallIndex : blocks.length, 0, createPromptBlock({
        kind: 'message',
        role: 'instruction',
        content: NARRATOR_POLICY_DEFAULT,
        advancedWarning: NARRATOR_POLICY_WARNING,
    }));
    return true;
}

function withNarratorRecipeSources(blocks) {
    ensureNarratorPolicy(blocks);
    return blocks;
}

function migrateStoryWorldInfoSources(recipe) {
    const blocks = recipe.blocks || [];
    const sourceKeys = new Set(blocks.filter((block) => block.kind === 'source').map((block) => block.sourceKey));
    const usesWorldInfo = sourceKeys.has('worldInfoBefore') || sourceKeys.has('worldInfoAfter');
    if (!usesWorldInfo) return false;
    const additions = [];
    if (!sourceKeys.has('worldInfoExamples')) additions.push(createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoExamples' }));
    if (!sourceKeys.has('worldInfoDepth')) additions.push(createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoDepth', locked: true }));
    if (!additions.length) return false;
    const manuscriptIndex = blocks.findIndex((block) => block.kind === 'source' && block.sourceKey === 'manuscript');
    blocks.splice(manuscriptIndex >= 0 ? manuscriptIndex : blocks.length, 0, ...additions);
    recipe.updatedAt = now();
    return true;
}

function createPromptRecipeWithoutSave(store, input) {
    const timestamp = now();
    const recipe = normalizeRecipe({
        id: createId('prompt'),
        description: '',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...input,
    });
    store.recipes[recipe.id] = recipe;
    store.recipeIds.push(recipe.id);
    return recipe;
}

export function normalizeRecipe(value) {
    if (!value || typeof value !== 'object' || !value.id) return null;
    const mode = PROMPT_MODES.includes(value.mode) ? value.mode : 'story';
    // Belt-and-suspenders alongside createPromptRecipe's own forcing and the
    // Loom is a hidden Chat Completion request; it has no Text Completion
    // transport. Normalize hand-edited data back to that supported boundary.
    const apiType = mode === 'loom' ? 'chat' : (PROMPT_API_TYPES.includes(value.apiType) ? value.apiType : 'chat');
    return {
        id: String(value.id),
        name: normalizeText(value.name, 'Untitled Prompt'),
        description: String(value.description || ''),
        mode,
        apiType,
        blocks: normalizeBlocks(value.blocks, mode, apiType),
        transport: apiType === 'text' ? clone(value.transport || {}) : null,
        createdAt: value.createdAt || now(),
        updatedAt: value.updatedAt || now(),
    };
}

function normalizeBlocks(value, mode, apiType) {
    let blocks = Array.isArray(value) ? value.map((block) => normalizeBlock(sourceBlockToMacroMessage(mode, block), mode)).filter(Boolean) : [];
    if (mode === 'roleplay') {
        blocks = blocks.map((block) => block.kind === 'source' && block.sourceKey === 'quietPrompt'
            ? { ...block, sourceKey: 'generationNudge', nativeIdentifier: 'quietPrompt' }
            : block);
    }
    if (mode === 'roleplay' && apiType === 'text' && !blocks.some((block) => block.content?.includes('{{roleplay.native}}'))) {
        blocks.push(createPromptBlockFromTemplate('roleplay', 'nativeContext'));
    }
    return blocks;
}

// Retired source keys. The Loom Archive is dissolved and Goals/Variables are
// folded into Living Lore, so every one of these old sources drops to nothing.
const RETIRED_SOURCE_MACROS = Object.freeze({
    directorNotes: '',
    loomContext: '',
    narratorGrounding: '',
    narratorRecall: '',
    storyGoals: '',
});

function sourceBlockToMacroMessage(mode, value) {
    if (!value || value.kind !== 'source') return value;
    if (Object.prototype.hasOwnProperty.call(RETIRED_SOURCE_MACROS, value.sourceKey)) {
        return { ...value, kind: 'message', content: RETIRED_SOURCE_MACROS[value.sourceKey], sourceKey: '', nativeIdentifier: '', advancedWarning: value.advancedWarning || '' };
    }
    const definition = PROMPT_TEMPLATE_DEFINITIONS[mode]?.find((item) => item.key === value.sourceKey)
        || UNIVERSAL_STATE_MACROS.find((item) => item.key === value.sourceKey);
    if (!definition) return { ...value, kind: 'message', content: `{{source key="${String(value.sourceKey || '')}"}}` };
    const args = Object.entries(value.settings || {})
        .map(([key, item]) => `${key}=${JSON.stringify(item)}`)
        .join(' ');
    return {
        ...value,
        kind: 'message',
        content: `{{${definition.macro}${args ? ` ${args}` : ''}}}`,
        sourceKey: '',
        nativeIdentifier: value.nativeIdentifier || definition.nativeIdentifier || '',
        advancedWarning: value.advancedWarning || '',
    };
}

function normalizeBlock(value, mode) {
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'source' ? 'source' : 'message';
    const role = PROMPT_ROLES.includes(value.role) ? value.role : 'instruction';
    const sourceKey = kind === 'source' ? String(value.sourceKey || '') : '';
    return {
        id: String(value.id || createId('block')),
        kind,
        role,
        content: kind === 'message' ? String(value.content || '') : '',
        sourceKey,
        enabled: value.enabled !== false,
        // Retained for backwards-compatible recipe shape only. It is never an
        // editing permission: every prompt block belongs to the user.
        locked: false,
        nativeIdentifier: String(value.nativeIdentifier || ''),
        settings: normalizeBlockSettings(value.settings, mode, sourceKey),
        advancedWarning: kind === 'message' ? String(value.advancedWarning || '') : '',
    };
}

/**
 * Fills a block's settings from its source definition, dropping anything the
 * definition doesn't declare. A block whose source declares no settings (or
 * a message block, whose sourceKey is always '') always gets `{}` — never
 * `undefined` — so old recipes saved before this mechanism existed, which
 * have no `settings` key at all, normalize identically to a block that
 * explicitly saved `settings: {}`.
 */
function normalizeBlockSettings(rawSettings, mode, sourceKey) {
    const declared = PROMPT_SOURCE_DEFINITIONS[mode]?.find((source) => source.key === sourceKey)?.settings;
    if (!declared || typeof declared !== 'object') return {};
    const saved = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const result = {};
    for (const [key, spec] of Object.entries(declared)) {
        result[key] = coerceSettingValue(saved[key], spec);
    }
    return result;
}

/** Only `type: 'number'` is declared by any source today; coerce, clamp, default. */
function coerceSettingValue(rawValue, spec) {
    if (spec.type === 'number') {
        // Decide whether there IS a usable value before coercing, rather than
        // coercing first and checking whether the result happens to be
        // finite: Number(null), Number('') and Number([]) are all 0, a
        // finite number, so a finite-only check reads "nothing was saved" as
        // "the value zero" and clamps it up to `min` instead of falling back
        // to `default`. This exact bug already bit `clampNumber` in
        // variables-store.js; fixed there the same way — test presence, then
        // coerce.
        let num = hasUsableNumber(rawValue) ? Number(rawValue) : Number(spec.default);
        if (typeof spec.min === 'number') num = Math.max(spec.min, num);
        if (typeof spec.max === 'number') num = Math.min(spec.max, num);
        return num;
    }
    return rawValue !== undefined ? rawValue : spec.default;
}

/** A saved value only counts as present if it coerces to an actual, finite number. */
function hasUsableNumber(value) {
    if (value === null || value === undefined || value === '' || Array.isArray(value)) return false;
    return Number.isFinite(Number(value));
}

function sourceRole(mode, sourceKey) {
    return PROMPT_SOURCE_DEFINITIONS[mode]?.find((source) => source.key === sourceKey)?.role;
}

function isStore(value) {
    return Boolean(value && typeof value === 'object' && Array.isArray(value.recipeIds) && value.recipes);
}

function isRecipeActive(recipeId, store) {
    return PROMPT_MODES.some((mode) => PROMPT_API_TYPES.some((apiType) => store.active?.[mode]?.[apiType] === recipeId));
}

function normalizeText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function createId(prefix) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${id}`;
}

function now() {
    return new Date().toISOString();
}

function capitalize(value) {
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}
