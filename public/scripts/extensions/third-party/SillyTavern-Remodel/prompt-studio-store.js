import { getContext } from '../../../st-context.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'promptStudioV1';
const STORE_VERSION = 1;

export const PROMPT_MODES = ['story', 'roleplay'];
export const PROMPT_API_TYPES = ['chat', 'text'];
export const PROMPT_ROLES = ['system', 'instruction', 'user', 'assistant'];

export const PROMPT_SOURCE_DEFINITIONS = Object.freeze({
    story: Object.freeze([
        { key: 'characterCard', label: 'Character Card', role: 'system' },
        { key: 'persona', label: 'Persona', role: 'system' },
        { key: 'worldInfoBefore', label: 'World Info (before)', role: 'system' },
        { key: 'worldInfoAfter', label: 'World Info (after)', role: 'system' },
        { key: 'authorGuidance', label: 'Author Guidance', role: 'instruction' },
        { key: 'priorText', label: 'Prior Scene', role: 'system' },
        { key: 'manuscript', label: 'Manuscript', role: 'user' },
        { key: 'sceneBeat', label: 'Scene Beat / Continue Request', role: 'user' },
    ]),
    roleplay: Object.freeze([
        { key: 'worldInfoBefore', label: 'World Info (before)', role: 'system', nativeIdentifier: 'worldInfoBefore' },
        { key: 'personaDescription', label: 'Persona Description', role: 'system', nativeIdentifier: 'personaDescription' },
        { key: 'charDescription', label: 'Character Description', role: 'system', nativeIdentifier: 'charDescription' },
        { key: 'charPersonality', label: 'Character Personality', role: 'system', nativeIdentifier: 'charPersonality' },
        { key: 'scenario', label: 'Scenario', role: 'system', nativeIdentifier: 'scenario' },
        { key: 'worldInfoAfter', label: 'World Info (after)', role: 'system', nativeIdentifier: 'worldInfoAfter' },
        { key: 'dialogueExamples', label: 'Dialogue Examples', role: 'user', nativeIdentifier: 'dialogueExamples' },
        { key: 'chatHistory', label: 'Chat History', role: 'user', nativeIdentifier: 'chatHistory' },
        // Native Chat Completion keeps the latest input inside chatHistory;
        // exposing it as an alias preserves that real marker boundary.
        { key: 'currentInput', label: 'Current Input (via history)', role: 'user', nativeIdentifier: 'chatHistory' },
        { key: 'generationNudge', label: 'Generation Nudge', role: 'instruction', nativeIdentifier: 'quietPrompt' },
        { key: 'nativeContext', label: 'Native Roleplay Context', role: 'system', textOnly: true, locked: true },
    ]),
});

const nativeMarkerToSource = Object.freeze({
    worldInfoBefore: 'worldInfoBefore',
    personaDescription: 'personaDescription',
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    worldInfoAfter: 'worldInfoAfter',
    dialogueExamples: 'dialogueExamples',
    chatHistory: 'chatHistory',
    quietPrompt: 'generationNudge',
});

export function initializePromptStudioStore(seed = {}) {
    const namespace = getNamespace();
    if (!isStore(namespace[SETTINGS_KEY])) {
        namespace[SETTINGS_KEY] = createSeededStore(seed);
        savePromptStudioStore();
    }
    normalizeStore(namespace[SETTINGS_KEY], seed);
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
    const safeApiType = PROMPT_API_TYPES.includes(apiType) ? apiType : 'chat';
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

export function createPromptBlock({ kind = 'message', role = 'instruction', content = '', sourceKey = '', enabled = true, locked = false, nativeIdentifier = '' } = {}) {
    return normalizeBlock({
        id: createId('block'),
        kind,
        role,
        content,
        sourceKey,
        enabled,
        locked,
        nativeIdentifier,
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
            blocks: blocksFromNativeChat(seed.chatPrompts || [], seed.chatPromptOrder || []),
            transport: null,
        },
        {
            id: createId('prompt'),
            name: 'Current Roleplay · Text',
            description: 'Uses SillyTavern’s token-budgeted native roleplay context.',
            mode: 'roleplay',
            apiType: 'text',
            blocks: [createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'nativeContext', enabled: true, locked: true })],
            transport,
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
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'characterCard' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'persona' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoBefore' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoAfter' }),
        createPromptBlock({ kind: 'source', role: 'instruction', sourceKey: 'authorGuidance' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'priorText' }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'manuscript' }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'sceneBeat' }),
    ];
}

function defaultBlocksFor(mode, apiType) {
    if (mode === 'story') return defaultStoryBlocks();
    if (apiType === 'text') {
        return [createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'nativeContext', enabled: true, locked: true })];
    }
    return [createPromptBlock({ kind: 'message', role: 'instruction', content: '' })];
}

function blocksFromNativeChat(prompts, promptOrder) {
    const promptMap = new Map(prompts.filter(Boolean).map((prompt) => [prompt.identifier, prompt]));
    const order = findGlobalPromptOrder(promptOrder);
    if (!order.length) return defaultBlocksFor('roleplay', 'chat');
    return order.map((entry) => {
        const prompt = promptMap.get(entry.identifier) || {};
        const sourceKey = nativeMarkerToSource[entry.identifier];
        if (prompt.marker || sourceKey) {
            return createPromptBlock({
                kind: 'source',
                role: prompt.role || sourceRole('roleplay', sourceKey) || 'system',
                sourceKey: sourceKey || entry.identifier,
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
    store.version = STORE_VERSION;
    store.recipes = store.recipes && typeof store.recipes === 'object' ? store.recipes : {};
    store.recipeIds = Array.isArray(store.recipeIds) ? store.recipeIds.filter((id) => store.recipes[id]) : [];
    for (const id of [...store.recipeIds]) {
        const recipe = normalizeRecipe(store.recipes[id]);
        if (!recipe) {
            delete store.recipes[id];
            store.recipeIds = store.recipeIds.filter((value) => value !== id);
            continue;
        }
        store.recipes[id] = recipe;
    }
    store.active ??= {};
    for (const mode of PROMPT_MODES) {
        store.active[mode] ??= {};
        for (const apiType of PROMPT_API_TYPES) {
            const current = store.recipes[store.active[mode][apiType]];
            if (!current || current.mode !== mode || current.apiType !== apiType) {
                const fallback = store.recipeIds.map((id) => store.recipes[id]).find((recipe) => recipe?.mode === mode && recipe.apiType === apiType);
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
            }
        }
    }
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

function normalizeRecipe(value) {
    if (!value || typeof value !== 'object' || !value.id) return null;
    const mode = PROMPT_MODES.includes(value.mode) ? value.mode : 'story';
    const apiType = PROMPT_API_TYPES.includes(value.apiType) ? value.apiType : 'chat';
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
    let blocks = Array.isArray(value) ? value.map(normalizeBlock).filter(Boolean) : [];
    if (mode === 'roleplay') {
        blocks = blocks.map((block) => block.kind === 'source' && block.sourceKey === 'quietPrompt'
            ? { ...block, sourceKey: 'generationNudge', nativeIdentifier: 'quietPrompt' }
            : block);
    }
    if (mode === 'roleplay' && apiType === 'text' && !blocks.some((block) => block.kind === 'source' && block.sourceKey === 'nativeContext')) {
        blocks.push(createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'nativeContext', enabled: true, locked: true }));
    }
    return blocks;
}

function normalizeBlock(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'source' ? 'source' : 'message';
    const role = PROMPT_ROLES.includes(value.role) ? value.role : 'instruction';
    return {
        id: String(value.id || createId('block')),
        kind,
        role,
        content: kind === 'message' ? String(value.content || '') : '',
        sourceKey: kind === 'source' ? String(value.sourceKey || '') : '',
        enabled: value.enabled !== false,
        locked: Boolean(value.locked || value.sourceKey === 'nativeContext'),
        nativeIdentifier: String(value.nativeIdentifier || ''),
    };
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
