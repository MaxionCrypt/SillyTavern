import { getContext } from '../../../st-context.js';
import { LOOM_OUTPUT_CONTRACT_DEFAULT, LOOM_POLICY_DEFAULT } from './loom-reconciliation.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'promptStudioV1';
const STORE_VERSION = 12;

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
        template('storyGoals', 'Story Goals', 'system', 'story.goals', { nativeIdentifier: 'remodel_story_goals' }),
        // Rendered by Remodel as the Narrator's Loom Context bridge,
        // same as storyGoals above — not resolved from a card or lorebook.
        // `nativeIdentifier` is required, not decorative: a roleplay recipe is
        // mirrored into SillyTavern's native Prompt Manager (applyRoleplayChatRecipe),
        // and that mirroring is the only thing that gets this block's content
        // into the real Narrator generation. A source with no native identifier
        // renders in the editor, accepts a depth setting, and reaches nothing —
        // this is the storyGoals precedent, followed exactly.
        template('loomContext', 'Loom Context', 'system', 'loom.context', { nativeIdentifier: 'remodel_loom_context' }),
        template('chatHistory', 'Chat History', 'user', 'chat.history', { nativeIdentifier: 'chatHistory', structured: true }),
        // Native Chat Completion keeps the latest input inside chatHistory;
        // exposing it as an alias preserves that real marker boundary.
        template('currentInput', 'Current Input (via history)', 'user', 'chat.input', { nativeIdentifier: 'chatHistory', structured: true }),
        template('generationNudge', 'Generation Nudge', 'instruction', 'generation.nudge', { nativeIdentifier: 'quietPrompt' }),
        template('nativeContext', 'Native Roleplay Context', 'system', 'roleplay.native', { textOnly: true, locked: true }),
    ]),
    loom: Object.freeze([
        template('archiveState', 'Archive & Objectives', 'system', 'loom.archive', { description: 'The Loom-readable scene facts, character state, recorded events, next beat, and active objectives.' }),
        template('mechanicsBoard', 'Goals & Variables', 'system', 'loom.mechanics', { description: 'The current mechanical board and the capabilities the Loom may request.' }),
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
    remodel_loom_context: 'loomContext',
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
    return withLoomContextSource(withStoryGoalsSource(blocks));
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
            name: 'Current Roleplay · Chat',
            description: 'Imported from the native Chat Completion prompt manager.',
            mode: 'roleplay',
            apiType: 'chat',
            blocks: withLoomContextSource(withStoryGoalsSource(blocksFromNativeChat(seed.chatPrompts || [], seed.chatPromptOrder || []))),
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

/** The default editable recipe for the post-draft Loom request. */
function defaultLoomBlocks() {
    return [
        createPromptBlock({ kind: 'message', role: 'system', content: LOOM_POLICY_DEFAULT }),
        createPromptBlockFromTemplate('loom', 'archiveState'),
        createPromptBlockFromTemplate('loom', 'mechanicsBoard'),
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
    // roleplay/chat. Remodel's own sources are seeded here rather than only by
    // the version migrations, which are version-gated and so never run again:
    // a recipe created after the upgrade would otherwise start without the
    // Loom Context bridge the native Narrator uses for continuity grounding.
    return withRemodelSources([createPromptBlock({ kind: 'message', role: 'instruction', content: '' })]);
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
                nativeIdentifier: entry.identifier,
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
                if (block.kind !== 'source' || block.sourceKey !== 'directorNotes') continue;
                block.sourceKey = 'loomContext';
                block.nativeIdentifier = 'remodel_loom_context';
                block.settings = {};
                changed = true;
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
        if (previousVersion < 2 && recipe.mode === 'story' && migrateStoryWorldInfoSources(recipe)) changed = true;
        recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
        store.recipes[id] = recipe;
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

function withStoryGoalsSource(blocks) {
    ensureStoryGoalsSource(blocks);
    return blocks;
}

/** Same shape as ensureStoryGoalsSource: Loom Context is a second
 *  Remodel-owned native source mirrored into the native Prompt Manager.
 *  It is inserted before chatHistory/currentInput and after Story Goals. */
function ensureLoomContextSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.content?.includes('{{loom.context}}'))) return false;
    const source = createPromptBlockFromTemplate('roleplay', 'loomContext');
    const historyIndex = blocks.findIndex((block) => /{{chat\.(history|input)\b/i.test(block.content || ''));
    blocks.splice(historyIndex >= 0 ? historyIndex : blocks.length, 0, source);
    return true;
}

function withLoomContextSource(blocks) {
    ensureLoomContextSource(blocks);
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
    const migratedKey = value.sourceKey === 'directorNotes' ? 'loomContext' : value.sourceKey;
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
