import { getContext } from '../../../st-context.js';
import { isSupersededLoomPatchPolicy, LOOM_POLICY_DEFAULT_PRIOR, LOOM_OUTPUT_CONTRACT_PATCH, LOOM_POLICY_PATCH, LOOM_OUTPUT_CONTRACT_DEFAULT, LOOM_POLICY_DEFAULT, LOOM_POLICY_V12 } from './loom-reconciliation.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'promptStudioV1';
const STORE_VERSION = 19;

export const NARRATOR_POLICY_DEFAULT = 'Continue the scene forward from the most recent message. Everything listed under "What has happened" is already written on the page — never restate, rewrite, summarise, or replay it. Advance the story: write only what happens next. Output only the story prose itself: never restate, repeat, quote, or acknowledge these notes, your instructions, or your role — begin directly with the narration.';
const NARRATOR_POLICY_WARNING = 'This policy prevents instruction echo and old-prose rewrites. Changing or disabling it can make the Narrator repeat its prompt or replay prior events.';
const NARRATOR_GROUNDING_WARNING = 'This macro supplies the Narrator-visible Loom Archive. Removing or disabling it makes the Narrator rely on chat history alone.';
const CURATED_NARRATOR_RECIPE_NAME = 'Narrator · Archive-Grounded';

export const PROMPT_MODES = ['story', 'roleplay', 'loom'];
export const PROMPT_API_TYPES = ['chat', 'text'];
export const PROMPT_ROLES = ['system', 'instruction', 'user', 'assistant'];

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
        template('storyGoals', 'Story Goals', 'system', 'story.goals', { nativeIdentifier: 'remodel_story_goals', description: 'Active Goals framed as consequential pressures, never protected outcomes.' }),
        // Rendered by Remodel as the Narrator's dynamic Archive grounding,
        // same as storyGoals above — not resolved from a card or lorebook.
        // `nativeIdentifier` is required, not decorative: a roleplay recipe is
        // mirrored into SillyTavern's native Prompt Manager (applyRoleplayChatRecipe),
        // and that mirroring is the only thing that gets this block's content
        // into the real Narrator generation. A source with no native identifier
        // renders in the editor, accepts a depth setting, and reaches nothing —
        // this is the storyGoals precedent, followed exactly.
        template('narratorGrounding', 'Narrator Grounding', 'system', 'narrator.grounding', {
            nativeIdentifier: 'remodel_narrator_grounding',
            description: 'The current Narrator-visible Loom Archive and provisional open thread, resolved when the request is assembled.',
            advancedWarning: NARRATOR_GROUNDING_WARNING,
        }),
        template('chatHistory', 'Chat History', 'user', 'chat.history', { nativeIdentifier: 'chatHistory', structured: true }),
        // Native Chat Completion keeps the latest input inside chatHistory;
        // exposing it as an alias preserves that real marker boundary.
        template('currentInput', 'Current Input (via history)', 'user', 'chat.input', { nativeIdentifier: 'chatHistory', structured: true }),
        template('generationNudge', 'Generation Nudge', 'instruction', 'generation.nudge', { nativeIdentifier: 'quietPrompt' }),
        template('nativeContext', 'Native Roleplay Context', 'system', 'roleplay.native', { textOnly: true, locked: true }),
    ]),
    loom: Object.freeze([
        template('archiveState', 'Archive, Goals & Open Thread', 'system', 'loom.archive', { description: 'The Loom-readable scene facts, character state, recorded events, provisional open thread, and active Goals.' }),
        template('mechanicsBoard', 'Archive Operations & Mechanics', 'system', 'loom.mechanics', { description: 'The Archive operations always available to the Loom, plus the current Goals and Variables board when mechanics are enabled.' }),
        template('livingLore', 'Selected Living Lore', 'system', 'loom.lore', { description: 'The bounded, revisioned Timeline lore entries selected by World Sense, plus the typed proposal contract. Proposals do not write directly.' }),
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
    remodel_story_goals: 'storyGoals',
    remodel_narrator_grounding: 'narratorGrounding',
    // Read-only migration aliases. New recipes always use the canonical name.
    remodel_loom_context: 'narratorGrounding',
    remodel_director_notes: 'narratorGrounding',
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
    const definition = PROMPT_TEMPLATE_DEFINITIONS[mode]?.find((item) => item.key === templateKey);
    if (!definition) return null;
    return createPromptBlock({
        kind: 'message',
        role: definition.role,
        content: definition.content,
        enabled: true,
        locked: Boolean(definition.locked),
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
 * existed lacks Remodel's continuity and Story Goal markers in its
 * prompt order. Without this, loading such a preset silently strips both
 * blocks out of an already-migrated recipe. Without the continuity bridge, a
 * scene can generate prose without the Archive grounding it depends on.
 *
 * Both helpers are no-ops when the block is already present, so applying this
 * to blocks that already carry them changes nothing.
 */
export function withRemodelSources(blocks) {
    return withNarratorRecipeSources(withStoryGoalsSource(blocks));
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
            description: 'A clean native Narrator stack with editable anti-echo policy and recipe-owned Loom Archive grounding.',
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
            blocks: defaultLoomBlocks(),
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
        createPromptBlockFromTemplate('loom', 'archiveState'),
        createPromptBlockFromTemplate('loom', 'mechanicsBoard'),
        createPromptBlockFromTemplate('loom', 'livingLore'),
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

/** The default editable recipe for the post-draft Loom request. */
function defaultLoomBlocks() {
    return [
        createPromptBlock({ kind: 'message', role: 'system', content: LOOM_POLICY_DEFAULT }),
        createPromptBlockFromTemplate('loom', 'archiveState'),
        createPromptBlockFromTemplate('loom', 'mechanicsBoard'),
        createPromptBlockFromTemplate('loom', 'livingLore'),
        createPromptBlockFromTemplate('loom', 'narratorDraft'),
        createPromptBlockFromTemplate('loom', 'narratorReasoning'),
        createPromptBlock({
            kind: 'message',
            role: 'system',
            content: LOOM_OUTPUT_CONTRACT_DEFAULT,
            advancedWarning: 'Changing the state fence or request schema can prevent the Loom reply from being parsed or applied.',
        }),
    ];
}

function defaultBlocksFor(mode, apiType) {
    if (mode === 'story') return defaultStoryBlocks();
    if (mode === 'loom') return defaultLoomBlocks();
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
        if (prompt.marker || sourceKey) {
            const definition = PROMPT_TEMPLATE_DEFINITIONS.roleplay.find((item) => item.key === (sourceKey || ''));
            return createPromptBlock({
                kind: 'message',
                role: prompt.role || sourceRole('roleplay', sourceKey) || 'system',
                content: definition?.content || `{{native.prompt id="${entry.identifier}"}}`,
                enabled: entry.enabled !== false,
                locked: Boolean(prompt.system_prompt),
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
            if (previousVersion < 3 && ensureStoryGoalsSource(recipe.blocks)) changed = true;
        }
        if (previousVersion < 11) {
            recipe.blocks = recipe.blocks.map((block) => sourceBlockToMacroMessage(recipe.mode, block));
            changed = true;
        }
        // Version 12 makes the Loom's response—not the private Narrator draft—
        // the streamed and stored fiction. Migrate only the two recognizable
        // seeded defaults; owner-authored contracts remain owner-authored.
        if (previousVersion < 12 && recipe.mode === 'loom') {
            for (const block of recipe.blocks) {
                if (String(block.content || '').startsWith('You are the Loom: a mechanical referee and continuity keeper, not a writer.')) {
                    block.content = LOOM_POLICY_DEFAULT;
                    changed = true;
                }
                if (String(block.content || '').startsWith('Write no narration and no commentary. Output only this state fence')) {
                    block.content = LOOM_OUTPUT_CONTRACT_DEFAULT;
                    changed = true;
                }
            }
        }
        // Version 13 makes Archive upkeep explicit and duplicate-safe. Only
        // replace the untouched v12 policy; an owner-edited Loom remains
        // exactly as authored.
        if (previousVersion < 13 && recipe.mode === 'loom') {
            for (const block of recipe.blocks) {
                if (block.content === LOOM_POLICY_V12) {
                    block.content = LOOM_POLICY_DEFAULT;
                    changed = true;
                }
            }
        }
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
            if (ensureNarratorGroundingSource(recipe.blocks)) changed = true;
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
                if (block.content === LOOM_POLICY_DEFAULT_PRIOR) {
                    block.content = LOOM_POLICY_DEFAULT;
                    changed = true;
                    continue;
                }
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
            store.active = store.active && typeof store.active === 'object' ? store.active : {};
            store.active.loom ??= {};
            store.active.loom.chat = patchRecipe.id;
        }
        changed = true;
    }

    if (previousVersion < 14 && !store.recipeIds.some((id) => store.recipes[id]?.name === CURATED_NARRATOR_RECIPE_NAME)) {
        createPromptRecipeWithoutSave(store, {
            name: CURATED_NARRATOR_RECIPE_NAME,
            description: 'A clean native Narrator stack with editable anti-echo policy and recipe-owned Loom Archive grounding.',
            mode: 'roleplay',
            apiType: 'chat',
            blocks: defaultBlocksFor('roleplay', 'chat'),
            transport: null,
        });
        changed = true;
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
    return changed;
}

function ensureStoryGoalsSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.content?.includes('{{story.goals}}'))) return false;
    const source = createPromptBlockFromTemplate('roleplay', 'storyGoals');
    const historyIndex = blocks.findIndex((block) => /{{chat\.(history|input)\b/i.test(block.content || ''));
    blocks.splice(historyIndex >= 0 ? historyIndex : blocks.length, 0, source);
    return true;
}

function ensureLivingLoreSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => /\{\{\s*loom\.lore\b/i.test(block.content || ''))) return false;
    const source = createPromptBlockFromTemplate('loom', 'livingLore');
    const draftIndex = blocks.findIndex((block) => /\{\{\s*narrator\.draft\b/i.test(block.content || ''));
    blocks.splice(draftIndex >= 0 ? draftIndex : blocks.length, 0, source);
    return true;
}

function withStoryGoalsSource(blocks) {
    ensureStoryGoalsSource(blocks);
    return blocks;
}

/** The dynamic Archive macro belongs immediately before native chat history. */
function ensureNarratorGroundingSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => /\{\{\s*narrator\.grounding\b/i.test(block.content || ''))) return false;
    const source = createPromptBlockFromTemplate('roleplay', 'narratorGrounding');
    const historyIndex = blocks.findIndex((block) => /{{chat\.(history|input)\b/i.test(block.content || ''));
    blocks.splice(historyIndex >= 0 ? historyIndex : blocks.length, 0, source);
    return true;
}

/** Seed one editable anti-echo/append-only policy before the Archive macro. */
function ensureNarratorPolicy(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.content === NARRATOR_POLICY_DEFAULT)) return false;
    const groundingIndex = blocks.findIndex((block) => /\{\{\s*narrator\.grounding\b/i.test(block.content || ''));
    blocks.splice(groundingIndex >= 0 ? groundingIndex : blocks.length, 0, createPromptBlock({
        kind: 'message',
        role: 'instruction',
        content: NARRATOR_POLICY_DEFAULT,
        advancedWarning: NARRATOR_POLICY_WARNING,
    }));
    return true;
}

function withNarratorRecipeSources(blocks) {
    ensureNarratorGroundingSource(blocks);
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

function sourceBlockToMacroMessage(mode, value) {
    if (!value || value.kind !== 'source') return value;
    const legacyGrounding = ['directorNotes', 'loomContext'].includes(value.sourceKey);
    const migratedKey = legacyGrounding ? 'narratorGrounding' : value.sourceKey;
    const definition = PROMPT_TEMPLATE_DEFINITIONS[mode]?.find((item) => item.key === migratedKey);
    if (!definition) return { ...value, kind: 'message', content: `{{source key="${String(value.sourceKey || '')}"}}` };
    const args = Object.entries(value.settings || {})
        .map(([key, item]) => `${key}=${JSON.stringify(item)}`)
        .join(' ');
    return {
        ...value,
        kind: 'message',
        content: `{{${definition.macro}${args ? ` ${args}` : ''}}}`,
        sourceKey: '',
        nativeIdentifier: legacyGrounding ? definition.nativeIdentifier : (value.nativeIdentifier || definition.nativeIdentifier || ''),
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
        locked: Boolean(value.locked || value.sourceKey === 'nativeContext'),
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
