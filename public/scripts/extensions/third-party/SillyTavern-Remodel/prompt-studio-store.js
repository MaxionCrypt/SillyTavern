import { getContext } from '../../../st-context.js';
import { PROTOCOL_TEMPLATE } from './direction-sources.js';

const SETTINGS_NAMESPACE = 'remodel';
const SETTINGS_KEY = 'promptStudioV1';
const STORE_VERSION = 9;

export const PROMPT_MODES = ['story', 'roleplay', 'director'];
export const PROMPT_API_TYPES = ['chat', 'text'];
export const PROMPT_ROLES = ['system', 'instruction', 'user', 'assistant'];

export const PROMPT_SOURCE_DEFINITIONS = Object.freeze({
    story: Object.freeze([
        { key: 'characterCard', label: 'Character Card', role: 'system' },
        { key: 'persona', label: 'Persona', role: 'system' },
        { key: 'worldInfoBefore', label: 'World Info (before)', role: 'system' },
        { key: 'worldInfoAfter', label: 'World Info (after)', role: 'system' },
        { key: 'worldInfoExamples', label: 'World Info Examples', role: 'system' },
        { key: 'worldInfoDepth', label: 'World Info at Depth', role: 'system', structured: true },
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
        { key: 'storyGoals', label: 'Story Goals', role: 'system', nativeIdentifier: 'remodel_story_goals', settings: { injectionDepth: { type: 'number', label: 'Messages from the end', min: 0, max: 20, default: 1 } } },
        // Rendered by Remodel (live-direction.js's buildDirectorNotesSource),
        // same as storyGoals above — not resolved from a card or lorebook.
        // `nativeIdentifier` is required, not decorative: a roleplay recipe is
        // mirrored into SillyTavern's native Prompt Manager (applyRoleplayChatRecipe),
        // and that mirroring is the only thing that gets this block's content
        // into the real Narrator generation. A source with no native identifier
        // renders in the editor, accepts a depth setting, and reaches nothing —
        // this is the storyGoals precedent, followed exactly.
        { key: 'directorNotes', label: 'Director’s Notes', role: 'system', nativeIdentifier: 'remodel_director_notes', settings: { depth: { type: 'number', label: 'Turns to include', min: 1, max: 20, default: 3 }, injectionDepth: { type: 'number', label: 'Messages from the end', min: 0, max: 20, default: 1 } } },
        { key: 'chatHistory', label: 'Chat History', role: 'user', nativeIdentifier: 'chatHistory' },
        // Native Chat Completion keeps the latest input inside chatHistory;
        // exposing it as an alias preserves that real marker boundary.
        { key: 'currentInput', label: 'Current Input (via history)', role: 'user', nativeIdentifier: 'chatHistory' },
        { key: 'generationNudge', label: 'Generation Nudge', role: 'instruction', nativeIdentifier: 'quietPrompt' },
        { key: 'nativeContext', label: 'Native Roleplay Context', role: 'system', textOnly: true, locked: true },
    ]),
    // Without this entry getSourceDefinitions returned [] for every director
    // recipe, which disabled "Add context" permanently, made directorCard and
    // mechanicsSkill deletable with no way to put them back, showed raw
    // camelCase keys as labels, and fell sourceDescription through to
    // "Resolved by SillyTavern's native Roleplay prompt manager" — false for
    // a Director block, and precisely the confusion this rework exists to end.
    // Director recipes are Chat Completion only, so no textOnly entries.
    director: Object.freeze([
        { key: 'directionProtocol', label: 'Direction Protocol', role: 'system' },
        { key: 'directorCard', label: 'Director Card', role: 'system' },
        { key: 'mechanicsSkill', label: 'Goals & Variables', role: 'system' },
        // The same four World Info fields the Roleplay recipe exposes, from
        // the same scan. They were one LORE section inside the Scene Snapshot,
        // which is locked — so the Director alone could not reorder its world
        // information, turn a part of it off, or place it against the notebook.
        // No `nativeIdentifier`: a director recipe is never mirrored into
        // SillyTavern's Prompt Manager (isNativeApplicableMode refuses it), so
        // the compile is the delivery route, exactly as for directorNotebook.
        { key: 'worldInfoBefore', label: 'World Info (before)', role: 'system' },
        { key: 'worldInfoAfter', label: 'World Info (after)', role: 'system' },
        { key: 'worldInfoExamples', label: 'World Info Examples', role: 'system' },
        { key: 'worldInfoDepth', label: 'World Info at Depth', role: 'system' },
        // The Director reading its own notebook back. Without this the
        // notebook was write-only from its author's side: a `[secret]`
        // reached the Narrator never (by design) and the Director never
        // (because nothing carried it), so a hidden twist could not survive
        // one turn. Secrets ARE included — the Director owns them; only the
        // Narrator is excluded, and that exclusion lives at a different
        // funnel entirely (readNarratorEntries).
        //
        // No `nativeIdentifier`, unlike the roleplay sources: a director
        // recipe is never mirrored into SillyTavern's native Prompt Manager
        // (isNativeApplicableMode refuses it). It is compiled by Remodel and
        // streamed on its own, so the compile IS the delivery route.
        {
            key: 'directorNotebook',
            label: 'Your Notebook',
            role: 'system',
            description: 'The Director\'s own entries from earlier turns of this Scene, secrets included — the memory a hidden twist has to survive in. Never reaches the performer.',
            settings: { depth: { type: 'number', label: 'Turns to include', min: 1, max: 20, default: 3 } },
        },
        // `history` governs how many of the most recent chat messages
        // buildDirectionSnapshot (live-direction.js) slices into this
        // block's STORY SO FAR section. Defaulted lower than the old
        // hardcoded 40: the notebook above is now the Director's own
        // running record of what happened (`[result]` entries), so 40
        // messages of raw prose on top of it was mostly redundant — 40
        // messages, not turns, is why this range and the notebook's above
        // don't share a unit. `min: 0` is a real, supported value (zero
        // messages, not "unset" — see live-direction.js's
        // resolveDirectorSnapshotHistoryDepth and toTurnNumber's docstring
        // for the `Number(null) === 0` coercion trap this codebase keeps
        // re-discovering), which is why it is declared explicitly rather
        // than left to default to 1 like every other numeric setting here.
        { key: 'directorSnapshot', label: 'Scene Snapshot', role: 'user', settings: { history: { type: 'number', label: 'Recent messages', min: 0, max: 40, default: 12 } } },
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
    remodel_story_goals: 'storyGoals',
    remodel_director_notes: 'directorNotes',
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
    const safeApiType = safeMode === 'director' ? 'chat' : requestedApiType;
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

export function createPromptBlock({ kind = 'message', role = 'instruction', content = '', sourceKey = '', enabled = true, locked = false, nativeIdentifier = '', settings = undefined, mode = null } = {}) {
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
    }, mode);
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
 * existed lacks `remodel_director_notes` and `remodel_story_goals` in its
 * prompt order. Without this, loading such a preset silently strips both
 * blocks out of an already-migrated recipe — and since the Director's notebook
 * is now the ONLY route its direction takes to the Narrator, that leaves a
 * scene generating prose against no direction at all.
 *
 * Both helpers are no-ops when the block is already present, so applying this
 * to blocks that already carry them changes nothing.
 */
export function withRemodelSources(blocks) {
    return withDirectorNotesSource(withStoryGoalsSource(blocks));
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
            blocks: withDirectorNotesSource(withStoryGoalsSource(blocksFromNativeChat(seed.chatPrompts || [], seed.chatPromptOrder || []))),
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
        // No persona block: in a Story the user is the author, not a character
        // in the fiction, so "who the user is playing" is not part of the
        // prompt. Roleplay recipes still carry one.
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoBefore' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoAfter' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoExamples' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoDepth', locked: true }),
        createPromptBlock({ kind: 'source', role: 'instruction', sourceKey: 'authorGuidance' }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'priorText' }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'manuscript' }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'sceneBeat' }),
    ];
}

/**
 * The seeded style block — the only Director-facing authorial text that ships.
 *
 * It says nothing about openings or rhythm any more, because neither exists:
 * `openings` is gone from the schema, the envelope and the reveal loop, and
 * pacing is derived from the finished prose by deriveBeats (design section 4
 * — the Narrator is told nothing about pacing). What remains is the two flow
 * decisions the Director genuinely still makes: whether the scene continues
 * on its own, and whether it must stop. Nothing was invented to replace the
 * deleted instructions — authorial policy belongs to the user's recipe now,
 * which is the point of the rework.
 */
const DIRECTOR_STYLE_DEFAULT = 'The world may move without waiting for the user, and only ask the scene to stop when the fiction is explicitly waiting on them.';

/**
 * The text seeded before the rework deleted the mechanisms it describes.
 *
 * Matched exactly and replaced once, at the version bump below, so a user who
 * edited their own style block keeps it and a user who never touched it stops
 * reading instructions about openings and rhythm.
 */
const DIRECTOR_STYLE_LEGACY = 'The world may move without waiting for the user. Keep openings optional — the user may intervene anywhere. Responses may be long; give the performer useful guidance on rhythm, and only ask the scene to stop when the fiction is explicitly waiting on the user.';

/**
 * The Director's default prompt.
 *
 * Only the protocol and the snapshot are locked: remove either and the reply
 * stops being parseable. Everything else — including the autonomy policy that
 * used to be compiled into directionHandbook — is an ordinary editable block.
 */
function defaultDirectorBlocks() {
    return [
        createPromptBlock({ kind: 'message', role: 'system', enabled: true, locked: false, content: PROTOCOL_TEMPLATE }),
        // World Info brackets the Director's own material the same way it
        // brackets the character's in a Roleplay recipe: `before` ahead of the
        // card, the other three behind the mechanics block and ahead of the
        // notebook. The names mean nothing unless the default order honours
        // them, which is why they are not simply parked together.
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoBefore', enabled: true, locked: false }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorCard', enabled: true, locked: false }),
        createPromptBlock({ kind: 'message', role: 'system', enabled: true, locked: false, content: DIRECTOR_STYLE_DEFAULT }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'mechanicsSkill', enabled: true, locked: false }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoAfter', enabled: true, locked: false }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoExamples', enabled: true, locked: false }),
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoDepth', enabled: true, locked: false }),
        // The only block in this list that declares settings, so the only one
        // whose `mode` could matter: `normalizeBlock` derives settings from
        // its mode's source definitions, and without a mode this would be
        // `settings: {}` and a source that renders nothing.
        //
        // REDUNDANT WITH the recipe-level `normalizeRecipe` every path runs
        // these blocks through, and stated so on purpose: a mutation showed
        // removing either one alone leaves the suite green. Both are kept
        // because this plan has twice shipped a settings-bearing block that
        // reached production with `settings: {}`, and the covering test
        // (remodel-director-recipe.test.js) is verified against removing BOTH.
        createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorNotebook', enabled: true, locked: false, mode: 'director' }),
        createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'directorSnapshot', enabled: true, locked: true }),
    ];
}

/** Same shape as ensureDirectorNotesSource, for the Director's own side of the
 *  notebook. Inserted immediately before the Scene Snapshot, so the memory is
 *  read before the moment it is being asked about — and after the mechanics
 *  block, whose names its entries refer to. */
function ensureDirectorNotebookSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.kind === 'source' && block.sourceKey === 'directorNotebook')) return false;
    const source = createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorNotebook', mode: 'director' });
    const snapshotIndex = blocks.findIndex((block) => block.kind === 'source' && block.sourceKey === 'directorSnapshot');
    blocks.splice(snapshotIndex >= 0 ? snapshotIndex : blocks.length, 0, source);
    return true;
}

/** One-shot: retire the style block that instructs about deleted machinery. */
function migrateDirectorStyleBlock(recipe) {
    let changed = false;
    for (const block of recipe.blocks || []) {
        if (block.kind !== 'message' || String(block.content || '').trim() !== DIRECTOR_STYLE_LEGACY) continue;
        block.content = DIRECTOR_STYLE_DEFAULT;
        changed = true;
    }
    if (changed) recipe.updatedAt = now();
    return changed;
}

function defaultBlocksFor(mode, apiType) {
    if (mode === 'story') return defaultStoryBlocks();
    if (mode === 'director') return defaultDirectorBlocks();
    if (apiType === 'text') {
        return [createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'nativeContext', enabled: true, locked: true })];
    }
    // roleplay/chat. Remodel's own sources are seeded here rather than only by
    // the version migrations, which are version-gated and so never run again:
    // a recipe CREATED after the upgrade would otherwise start life without the
    // Director's Notes block, and the Narrator would read no direction at all
    // while the notebook filled normally behind it.
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
    const previousVersion = Number(store.version) || 1;
    let changed = previousVersion < STORE_VERSION;
    store.version = STORE_VERSION;
    store.recipes = store.recipes && typeof store.recipes === 'object' ? store.recipes : {};
    store.recipeIds = Array.isArray(store.recipeIds) ? store.recipeIds.filter((id) => store.recipes[id]) : [];
    for (const [id, recipe] of Object.entries(store.recipes)) {
        if (recipe?.purpose === 'goalDirector') {
            delete store.recipes[id];
            store.recipeIds = store.recipeIds.filter((recipeId) => recipeId !== id);
            changed = true;
        }
    }
    if (store.active?.goalDirector) {
        delete store.active.goalDirector;
        changed = true;
    }
    for (const id of [...store.recipeIds]) {
        const recipe = normalizeRecipe(store.recipes[id]);
        if (!recipe) {
            delete store.recipes[id];
            store.recipeIds = store.recipeIds.filter((value) => value !== id);
            continue;
        }
        store.recipes[id] = recipe;
        // migrateStoryWorldInfoSources splices new blocks straight into this
        // already-normalized recipe's blocks array, with no normalizeBlocks
        // pass of its own — so a settings-bearing source it ever migrates in
        // would land with settings: {} instead of its declared defaults.
        // Re-normalize afterward to close that gap, same as below.
        if (previousVersion < 2 && recipe.mode === 'story' && migrateStoryWorldInfoSources(recipe)) {
            recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
            changed = true;
        }
    }
    store.active ??= {};
    for (const mode of PROMPT_MODES) {
        store.active[mode] ??= {};
        // Director recipes are Chat Completion only (Live Direction has no
        // Text Completion path), so never seed — or even probe for — a
        // director/text active slot. Doing so would call defaultBlocksFor
        // with apiType 'text' but mode 'director', and defaultBlocksFor
        // ignores apiType for director; normalizeRecipe below then forces
        // the created recipe back to 'chat', so on every subsequent load the
        // active[mode].text slot would mismatch its own recipe's apiType and
        // a fresh orphan recipe would be created and persisted forever.
        const apiTypesForMode = mode === 'director' ? ['chat'] : PROMPT_API_TYPES;
        for (const apiType of apiTypesForMode) {
            const current = store.recipes[store.active[mode][apiType]];
            if (!current || current.mode !== mode || current.apiType !== apiType) {
                const fallback = store.recipeIds.map((id) => store.recipes[id]).find((recipe) => recipe?.mode === mode && recipe.apiType === apiType);
                if (fallback) {
                    store.active[mode][apiType] = fallback.id;
                    changed = true;
                } else {
                    const created = createPromptRecipeWithoutSave(store, {
                        name: `Current ${capitalize(mode)} · ${capitalize(apiType)}`,
                        mode,
                        apiType,
                        blocks: defaultBlocksFor(mode, apiType),
                        transport: apiType === 'text' ? clone(seed.textTransport || {}) : null,
                    });
                    store.active[mode][apiType] = created.id;
                    changed = true;
                }
            }
        }
    }
    if (previousVersion < 3) {
        for (const recipe of Object.values(store.recipes)) {
            // Same gap as migrateStoryWorldInfoSources above: this splices
            // into an already-normalized recipe.blocks with no re-derivation
            // of settings for the spliced-in block.
            if (recipe?.mode === 'roleplay' && recipe.apiType === 'chat' && ensureStoryGoalsSource(recipe.blocks)) {
                recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
                changed = true;
            }
        }
    }
    // Runs after the active-slot loop above, so a director recipe seeded on
    // this very load already carries the new text and matches nothing here.
    if (previousVersion < 5) {
        for (const recipe of Object.values(store.recipes)) {
            if (recipe?.mode === 'director') changed = migrateDirectorStyleBlock(recipe) || changed;
        }
    }
    // Same shape as the previousVersion < 3 migration above, and for the same
    // reason: ensureDirectorNotesSource splices a freshly-built block into an
    // already-normalized recipe.blocks with no settings-defaulting pass of its
    // own, so the re-normalize afterward is required, not optional — without
    // it a pre-existing user's migrated block would carry settings: {} instead
    // of the declared { depth: 3 } default, and the Narrator would read a
    // depth-undefined notes source that resolves to nothing.
    if (previousVersion < 6) {
        for (const recipe of Object.values(store.recipes)) {
            if (recipe?.mode === 'roleplay' && recipe.apiType === 'chat' && ensureDirectorNotesSource(recipe.blocks)) {
                recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
                changed = true;
            }
        }
    }
    // The Director's own side of the notebook. Same shape and the same
    // re-normalize as the migration above, and for the same reason: the
    // spliced block declares `settings`, and without the re-normalize it
    // would carry `settings: {}` instead of the declared depth — a source
    // that appears in the editor and renders nothing.
    //
    // Runs after the active-slot loop, so a director recipe seeded on this
    // very load already has the block and matches nothing here.
    if (previousVersion < 7) {
        for (const recipe of Object.values(store.recipes)) {
            if (recipe?.mode === 'director' && ensureDirectorNotebookSource(recipe.blocks)) {
                recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
                changed = true;
            }
        }
    }
    // World Info stopped being rendered inside the locked Scene Snapshot and
    // became four blocks. An existing director recipe has neither, so without
    // this migration the Director would simply STOP receiving world
    // information — the failure mode of a source that moves is silence, not
    // an error, which is why this runs for every director recipe rather than
    // only ones that look default.
    if (previousVersion < 8) {
        for (const recipe of Object.values(store.recipes)) {
            if (recipe?.mode === 'director' && ensureDirectorWorldInfoSources(recipe.blocks)) {
                recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
                changed = true;
            }
        }
    }
    // The protocol stopped being a locked source and became an ordinary
    // editable message, seeded with the text that source produced. Nothing
    // about the compiled prompt changes on the day of the migration — the
    // seed expands, through {{director::…}}, to exactly what was there before
    // — but from here the owner can rewrite every sentence of it while the
    // tags, the state fence and the capability list keep coming from the code.
    if (previousVersion < 9) {
        for (const recipe of Object.values(store.recipes)) {
            if (recipe?.mode !== 'director' || !Array.isArray(recipe.blocks)) continue;
            const index = recipe.blocks.findIndex((block) => block.kind === 'source' && block.sourceKey === 'directionProtocol');
            if (index < 0) continue;
            const previous = recipe.blocks[index];
            recipe.blocks[index] = createPromptBlock({
                kind: 'message',
                role: previous.role || 'system',
                // Position, enabled state and role are carried over; `locked`
                // deliberately is not. Being unlockable is the whole feature.
                enabled: previous.enabled !== false,
                locked: false,
                content: PROTOCOL_TEMPLATE,
            });
            recipe.blocks = normalizeBlocks(recipe.blocks, recipe.mode, recipe.apiType);
            changed = true;
        }
    }
    return changed;
}

/**
 * Add whichever of the four World Info blocks a director recipe is missing.
 *
 * `before` goes ahead of the Director Card and the rest immediately before the
 * notebook (or the Scene Snapshot, whichever comes first), so a migrated
 * recipe lands in the same reading order a fresh one is built with. Each key
 * is checked on its own: a user who already added one by hand must not have it
 * duplicated, and must still receive the other three.
 */
function ensureDirectorWorldInfoSources(blocks) {
    if (!Array.isArray(blocks)) return false;
    const present = new Set(blocks.filter((block) => block.kind === 'source').map((block) => block.sourceKey));
    let added = false;

    if (!present.has('worldInfoBefore')) {
        const cardIndex = blocks.findIndex((block) => block.kind === 'source' && block.sourceKey === 'directorCard');
        blocks.splice(cardIndex >= 0 ? cardIndex : 0, 0, createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'worldInfoBefore' }));
        added = true;
    }

    const trailing = ['worldInfoAfter', 'worldInfoExamples', 'worldInfoDepth']
        .filter((key) => !present.has(key))
        .map((key) => createPromptBlock({ kind: 'source', role: 'system', sourceKey: key }));
    if (trailing.length) {
        const anchor = blocks.findIndex((block) => block.kind === 'source' && ['directorNotebook', 'directorSnapshot'].includes(block.sourceKey));
        blocks.splice(anchor >= 0 ? anchor : blocks.length, 0, ...trailing);
        added = true;
    }
    return added;
}

function ensureStoryGoalsSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.kind === 'source' && block.sourceKey === 'storyGoals')) return false;
    const source = createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'storyGoals', nativeIdentifier: 'remodel_story_goals' });
    const historyIndex = blocks.findIndex((block) => block.kind === 'source' && ['chatHistory', 'currentInput'].includes(block.sourceKey));
    blocks.splice(historyIndex >= 0 ? historyIndex : blocks.length, 0, source);
    return true;
}

function withStoryGoalsSource(blocks) {
    ensureStoryGoalsSource(blocks);
    return blocks;
}

/** Same shape as ensureStoryGoalsSource, for the same reason: directorNotes is
 *  a second Remodel-owned native source, mirrored into the native Prompt
 *  Manager under 'remodel_director_notes' the same way storyGoals is under
 *  'remodel_story_goals'. Inserted right before chatHistory/currentInput —
 *  after storyGoals lands there first, so the declared source order
 *  (storyGoals, then directorNotes, then chatHistory) holds even when both
 *  helpers run back to back. */
function ensureDirectorNotesSource(blocks) {
    if (!Array.isArray(blocks) || blocks.some((block) => block.kind === 'source' && block.sourceKey === 'directorNotes')) return false;
    const source = createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorNotes', nativeIdentifier: 'remodel_director_notes' });
    const historyIndex = blocks.findIndex((block) => block.kind === 'source' && ['chatHistory', 'currentInput'].includes(block.sourceKey));
    blocks.splice(historyIndex >= 0 ? historyIndex : blocks.length, 0, source);
    return true;
}

function withDirectorNotesSource(blocks) {
    ensureDirectorNotesSource(blocks);
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
    // normalizeStore active-slot loop skipping 'text' for director: this is
    // the one funnel every recipe passes through (fresh creation *and*
    // recipes loaded back out of persisted settings), so it is the place a
    // stray or hand-edited director/text recipe gets coerced back to chat
    // rather than silently surviving a reload.
    const apiType = mode === 'director' ? 'chat' : (PROMPT_API_TYPES.includes(value.apiType) ? value.apiType : 'chat');
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
    let blocks = Array.isArray(value) ? value.map((block) => normalizeBlock(block, mode)).filter(Boolean) : [];
    if (mode === 'roleplay') {
        blocks = blocks.map((block) => block.kind === 'source' && block.sourceKey === 'quietPrompt'
            ? { ...block, sourceKey: 'generationNudge', nativeIdentifier: 'quietPrompt' }
            : block);
    }
    if (mode === 'roleplay' && apiType === 'text' && !blocks.some((block) => block.kind === 'source' && block.sourceKey === 'nativeContext')) {
        blocks.push(createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'nativeContext', enabled: true, locked: true, mode }));
    }
    return blocks;
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
