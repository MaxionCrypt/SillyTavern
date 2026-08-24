import {
    createRawPrompt,
    eventSource,
    event_types,
    main_api,
    name1,
    name2,
    saveSettingsDebounced,
    substituteParams,
} from '../../../../script.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { power_user } from '../../../power-user.js';
import { formatInstructModeChat } from '../../../instruct-mode.js';
import {
    PROMPT_API_TYPES,
    PROMPT_MODES,
    PROMPT_ROLES,
    PROMPT_TEMPLATE_DEFINITIONS,
    captureTextTransport,
    clonePromptRecipe,
    createBlocksFromNativeChat,
    createPromptBlock,
    createPromptBlockFromTemplate,
    createPromptRecipe,
    deletePromptRecipe,
    getActivePromptRecipe,
    getPromptRecipe,
    getPromptRecipes,
    initializePromptStudioStore,
    isPromptRecipeActive,
    setActivePromptRecipe,
    updatePromptRecipe,
    withRemodelSources,
} from './prompt-studio-store.js';
import { recordApiTranscript } from './debug-console.js';
import { chatHistoryBoundary } from './prompt-history-limit.js';

const CHAT_PROMPT_ORDER_ID = 100001;
const roleLabels = Object.freeze({
    system: 'System',
    instruction: 'Instruction',
    user: 'User',
    assistant: 'Assistant',
});

const state = {
    initialized: false,
    mode: 'story',
    apiType: 'chat',
    search: '',
    selectedRecipeId: null,
    requestRender: () => {},
    getRuntimeMode: () => 'roleplay',
    getRuntimeRecipeId: () => null,
    isRecipeInUse: () => false,
    previewRecipe: null,
    openSource: null,
    nativeSyncGuard: false,
    nativeSignature: '',
    roleplayTextPending: false,
    roleplayTextPendingTimer: null,
    dragBlockId: null,
    boundMode: null,
    boundApiType: null,
    boundRecipeId: null,
    advancedUnlockedBlocks: new Set(),
};

let saveLabelTimer = null;
let transportFeedbackTimer = null;

export function initPromptStudio({
    requestRender = null,
    getRuntimeMode = null,
    getRuntimeRecipeId = null,
    isRecipeInUse = null,
    previewRecipe = null,
    openSource = null,
} = {}) {
    if (typeof requestRender === 'function') state.requestRender = requestRender;
    if (typeof getRuntimeMode === 'function') state.getRuntimeMode = getRuntimeMode;
    if (typeof getRuntimeRecipeId === 'function') state.getRuntimeRecipeId = getRuntimeRecipeId;
    if (typeof isRecipeInUse === 'function') state.isRecipeInUse = isRecipeInUse;
    if (typeof previewRecipe === 'function') state.previewRecipe = previewRecipe;
    if (typeof openSource === 'function') state.openSource = openSource;
    if (state.initialized) return;

    initializePromptStudioStore({
        chatPrompts: oai_settings.prompts,
        chatPromptOrder: oai_settings.prompt_order,
        textTransport: captureTextTransport(power_user),
    });
    const initial = getPromptRecipes({ mode: state.mode, apiType: state.apiType })[0];
    state.selectedRecipeId = initial?.id || null;
    state.nativeSignature = getNativeSignature(state.getRuntimeMode(), getPromptApiType());
    state.boundMode = normalizeMode(state.getRuntimeMode());
    state.boundApiType = getPromptApiType();
    state.boundRecipeId = getCurrentPromptStudioRecipe(state.boundMode, state.boundApiType)?.id || null;

    bindPromptStudioEvents();
    eventSource.on(event_types.SETTINGS_UPDATED, captureNativeSettingsIfChanged);
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, captureNativeSettingsIfChanged);
    eventSource.on(event_types.PRESET_CHANGED, captureNativeSettingsIfChanged);
    eventSource.on(event_types.MAIN_API_CHANGED, () => syncPromptStudioForCurrentMode({ apply: true }));
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => syncPromptStudioForCurrentMode({ apply: true }));
    eventSource.on(event_types.GENERATE_AFTER_DATA, (generateData, dryRun) => {
        if (dryRun || !generateData) return;
        const runtimeMode = normalizeMode(state.getRuntimeMode());
        const mode = runtimeMode === 'roleplay' ? 'narrator' : 'chat';
        const recipe = getCurrentPromptStudioRecipe(runtimeMode, getPromptApiType());
        recordSentPromptTranscript(mode, {
            recipeName: recipe?.name || capitalize(runtimeMode),
            messages: Array.isArray(generateData.prompt) ? generateData.prompt : [],
            text: typeof generateData.prompt === 'string' ? generateData.prompt : '',
            request: generateData,
            transport: getPromptApiType(),
        });
    });
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
        if (state.getRuntimeMode() === 'roleplay' && getPromptApiType() === 'text') {
            state.roleplayTextPending = true;
            clearTimeout(state.roleplayTextPendingTimer);
            // BEFORE and AFTER are part of the same generation turn. Clear a
            // stranded flag if core aborts between those two events.
            state.roleplayTextPendingTimer = setTimeout(() => {
                state.roleplayTextPending = false;
            }, 0);
        }
    });
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (eventData) => {
        if (!state.roleplayTextPending) return;
        state.roleplayTextPending = false;
        clearTimeout(state.roleplayTextPendingTimer);
        if (state.getRuntimeMode() !== 'roleplay' || getPromptApiType() !== 'text' || typeof eventData?.prompt !== 'string') return;
        const recipe = getCurrentPromptStudioRecipe('roleplay', 'text');
        if (!recipe) return;
        eventData.prompt = compileRoleplayTextRecipe(recipe, eventData.prompt);
    });
    state.initialized = true;
}

export function getPromptApiType(api = main_api) {
    return api === 'openai' ? 'chat' : 'text';
}

export function getCurrentPromptStudioRecipe(mode = state.getRuntimeMode(), apiType = getPromptApiType()) {
    mode = PROMPT_MODES.includes(mode) ? mode : 'roleplay';
    apiType = PROMPT_API_TYPES.includes(apiType) ? apiType : 'text';
    const override = getPromptRecipe(state.getRuntimeRecipeId(mode, apiType));
    if (override?.mode === mode && override?.apiType === apiType) return override;
    return getActivePromptRecipe(mode, apiType);
}

/**
 * Which prompt modes may be mirrored into SillyTavern's native Prompt Manager.
 *
 * Loom recipes must never be: they are compiled by Remodel for the hidden
 * directing call. Applying one to native would make the performing character
 * generate while reading directing instructions.
 */
export function isNativeApplicableMode(mode) {
    return mode === 'roleplay' || mode === 'story';
}

/** The active Loom recipe, or null when none is configured. */
export function resolveLoomRecipe() {
    const recipe = getActivePromptRecipe('loom', 'chat');
    return recipe && recipe.mode === 'loom' ? recipe : null;
}

export function getPromptStudioRecipes(mode, apiType) {
    return getPromptRecipes({ mode, apiType });
}

export function getPromptStudioRecipe(recipeId) {
    return getPromptRecipe(recipeId);
}

export function getDefaultPromptStudioRecipe(mode, apiType) {
    return getActivePromptRecipe(mode, apiType);
}

export function capturePromptStudioRuntimeSettings() {
    if (!state.initialized) return;
    captureNativeSettingsFor(normalizeMode(state.getRuntimeMode()), getPromptApiType());
}

export function applyPromptStudioRuntimeRecipe() {
    if (!state.initialized) return;
    const mode = normalizeMode(state.getRuntimeMode());
    const apiType = getPromptApiType();
    const recipe = getCurrentPromptStudioRecipe(mode, apiType);
    // The guard wraps only the native application. Returning early also
    // skipped the binding bookkeeping below, which would leave state.bound*
    // describing a recipe that is no longer current. Unreachable today (a
    // recipe is always seeded), and applyRecipeToNative's own guard makes the
    // invariant unconditional either way.
    if (isNativeApplicableMode(recipe?.mode)) applyRecipeToNative(recipe);
    state.boundMode = mode;
    state.boundApiType = apiType;
    state.boundRecipeId = recipe?.id || null;
}

export function syncPromptStudioForCurrentMode({ apply = false } = {}) {
    if (!state.initialized) return;
    const mode = normalizeMode(state.getRuntimeMode());
    const apiType = getPromptApiType();
    const recipe = getCurrentPromptStudioRecipe(mode, apiType);
    const changed = mode !== state.boundMode || apiType !== state.boundApiType || recipe?.id !== state.boundRecipeId;
    if (apply && changed) {
        captureNativeSettingsFor(state.boundMode, state.boundApiType, state.boundRecipeId);
        // As above: the early return also skipped ensureSelectedRecipe() and
        // requestRender() below, so switching to a mode with no native-
        // applicable recipe would have left the editor showing the old one.
        if (isNativeApplicableMode(recipe?.mode)) applyRecipeToNative(recipe);
    }
    state.boundMode = mode;
    state.boundApiType = apiType;
    state.boundRecipeId = recipe?.id || null;
    if (mode === state.mode && apiType === state.apiType) {
        ensureSelectedRecipe();
        state.requestRender();
    }
}

/**
 * Compiles a recipe into the message array a request actually sends.
 *
 * Adjacent blocks that share a role are merged into one message (see
 * appendMessage below), and `messages` records only `{role, content}` — so by
 * the time any caller sees the result, which authored block produced which
 * paragraph is gone. The default Loom recipe's blocks arrive as two
 * messages this way. `trace: true` asks for that accounting back: one record
 * per enabled block, naming its source key, its human label, its role, its own
 * resolved text before merging, and the index of the message it landed in.
 *
 * The trace is built unconditionally and only *returned* under the flag. The
 * flag gates the return shape and nothing else, so there is no second compile
 * path that could produce different `messages`. That property is load-bearing:
 * the Prompt Studio preview and the real request compile through this same
 * function and must agree byte for byte, which is the only reason the preview
 * can be trusted. It is asserted directly in
 * tests/remodel-loom-preview-trace.test.js and again, end to end, by
 * tests/remodel-loom-preview-parity.test.js (the preview side asks for a
 * trace, the real side does not, and the two message arrays must still match).
 */
export function compilePromptRecipe(recipe, sources = {}, { includeUnresolved = false, macroOptions = {}, outlets = {}, trace = false } = {}) {
    if (!recipe) return withPromptTrace({ apiType: 'chat', messages: [], text: '' }, [], trace);
    const messages = [];
    const traceEntries = [];
    // Returns where this content landed, or null when it contributed nothing.
    // The return value is bookkeeping only — every mutation of `messages` below
    // is exactly what it always was.
    const appendMessage = (role, rawContent) => {
        let content = resolvePromptOutlets(String(rawContent || ''), outlets);
        content = substituteParams(content, macroOptions).trim();
        if (!content) return null;
        role = role === 'instruction' ? 'system' : role;
        const previous = messages[messages.length - 1];
        if (previous && previous.role === role) {
            previous.content += `\n\n${content}`;
            return { role, content, messageIndex: messages.length - 1, merged: true };
        }
        messages.push({ role, content });
        return { role, content, messageIndex: messages.length - 1, merged: false };
    };
    for (const block of recipe.blocks || []) {
        if (!block.enabled) continue;
        const parts = [];
        if (block.kind === 'message') {
            const expanded = expandRecipeMessage(recipe, block.content || '', sources, includeUnresolved);
            if (expanded?.messages) {
                for (const message of expanded.messages) {
                    parts.push(appendMessage(message?.role || block.role, message?.content || ''));
                }
            } else {
                parts.push(appendMessage(block.role, expanded?.content ?? block.content ?? ''));
            }
        } else {
            const provided = sources[block.sourceKey];
            // A source may resolve lazily from the block's own settings (e.g.
            // loomNotes' `depth`) instead of a flat value the caller
            // already computed. This is the only way settings reach the
            // compile: the resolver function receives block.settings as its
            // argument and returns ordinary content, so whatever it computes
            // from a setting still has to go through the same appendMessage
            // path as everything else. The settings object itself is never
            // written into `messages`.
            const resolved = typeof provided === 'function' ? provided(block.settings) : provided;
            if (resolved && typeof resolved === 'object' && Array.isArray(resolved.messages)) {
                for (const message of resolved.messages) {
                    parts.push(appendMessage(message?.role || block.role, message?.content || ''));
                }
            } else {
                const content = resolved == null && includeUnresolved
                    ? `[Source: ${getSourceLabel(recipe, block.sourceKey)}]`
                    : String(resolved || '');
                parts.push(appendMessage(block.role, content));
            }
        }
        traceEntries.push(describeTracedBlock(recipe, block, parts.filter(Boolean)));
    }

    if (recipe.apiType === 'chat') {
        return withPromptTrace({ apiType: 'chat', messages, text: '' }, traceEntries, trace);
    }

    let text = '';
    const nativeTransport = captureTextTransport(power_user);
    try {
        // createRawPrompt is the authoritative SillyTavern serializer, but it
        // reads transport settings from power_user. Swap in this recipe's
        // snapshot only for this synchronous compile so inactive previews are
        // honest without activating or saving the recipe.
        replaceObject(power_user.sysprompt, recipe.transport?.sysprompt || nativeTransport.sysprompt);
        replaceObject(power_user.context, recipe.transport?.context || nativeTransport.context);
        replaceObject(power_user.instruct, recipe.transport?.instruct || nativeTransport.instruct);
        const api = main_api === 'openai' ? 'textgenerationwebui' : main_api;
        text = String(createRawPrompt(structuredClone(messages), api, false, false, '', '') || '');
    } catch {
        text = messages.map((message) => `${message.role.toUpperCase()}\n${message.content}`).join('\n\n');
    } finally {
        replaceObject(power_user.sysprompt, nativeTransport.sysprompt);
        replaceObject(power_user.context, nativeTransport.context);
        replaceObject(power_user.instruct, nativeTransport.instruct);
    }
    return withPromptTrace({ apiType: 'text', messages, text }, traceEntries, trace);
}

/**
 * The provenance record for one enabled block.
 *
 * `parts` are the contributions this block actually made — a source that
 * resolves to a message array can make several, and a block whose text
 * resolved empty makes none (messageIndex -1, and the panel shows it as
 * having contributed nothing rather than dropping it silently).
 */
function describeTracedBlock(recipe, block, parts) {
    const macros = block.kind === 'message' ? findRecipeMacros(recipe, block.content || '') : [];
    return {
        blockId: block.id || null,
        kind: block.kind,
        sourceKey: block.kind === 'source' ? block.sourceKey || null : null,
        label: block.kind === 'source' ? getSourceLabel(recipe, block.sourceKey) : (macros.length ? macros.map((item) => item.label).join(' + ') : 'Authored message'),
        role: parts[0]?.role || (block.role === 'instruction' ? 'system' : block.role),
        // The block's own resolved text, before it was concatenated into a
        // shared message — the thing the raw dump can no longer show.
        text: parts.map((part) => part.content).join('\n\n'),
        messageIndex: parts.length ? parts[0].messageIndex : -1,
        messageIndices: [...new Set(parts.map((part) => part.messageIndex))],
        merged: Boolean(parts[0]?.merged),
        // Every individual contribution, in the order it was appended. A block
        // whose source resolved to several messages can straddle more than one
        // of them, so `messageIndex` alone cannot account for the whole block;
        // walking `parts` in block-then-part order reproduces exactly how the
        // merged messages were assembled.
        parts,
    };
}

const RECIPE_MACRO_PATTERN = /{{\s*([a-z][\w.-]*)(?:\s+([^{}]*?))?\s*}}/gi;

/** Expand Remodel recipe macros without interfering with SillyTavern macros. */
function expandRecipeMessage(recipe, content, sources, includeUnresolved) {
    const raw = String(content || '');
    const whole = parseWholeRecipeMacro(recipe, raw);
    if (whole) {
        const resolved = resolveRecipeMacro(whole, sources, includeUnresolved);
        if (resolved && typeof resolved === 'object' && Array.isArray(resolved.messages)) return resolved;
    }
    return {
        content: raw.replace(RECIPE_MACRO_PATTERN, (token, name, rawArgs) => {
            const invocation = getRecipeMacroDefinition(recipe, name, rawArgs);
            if (!invocation) return token;
            const resolved = resolveRecipeMacro(invocation, sources, includeUnresolved);
            if (resolved && typeof resolved === 'object' && Array.isArray(resolved.messages)) {
                return resolved.messages.map((message) => String(message?.content || '')).filter(Boolean).join('\n\n');
            }
            return String(resolved || '');
        }),
    };
}

function findRecipeMacros(recipe, content) {
    const found = [];
    String(content || '').replace(RECIPE_MACRO_PATTERN, (_token, name, rawArgs) => {
        const invocation = getRecipeMacroDefinition(recipe, name, rawArgs);
        if (invocation) found.push(invocation);
        return _token;
    });
    return found;
}

function parseWholeRecipeMacro(recipe, content) {
    const match = String(content || '').trim().match(/^{{\s*([a-z][\w.-]*)(?:\s+([^{}]*?))?\s*}}$/i);
    return match ? getRecipeMacroDefinition(recipe, match[1], match[2]) : null;
}

function getRecipeMacroDefinition(recipe, name, rawArgs = '') {
    const definition = getSourceDefinitions(recipe).find((item) => item.macro.toLowerCase() === String(name).toLowerCase());
    return definition ? { ...definition, args: parseMacroArguments(rawArgs) } : null;
}

/** Named arguments support numbers, booleans, quoted strings, and bare words. */
export function parseMacroArguments(raw = '') {
    const args = {};
    const pattern = /([\w.-]+)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/g;
    let match;
    while ((match = pattern.exec(String(raw || '')))) {
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1).replace(/\\([\\"'])/g, '$1');
        } else if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
        else if (/^(true|false)$/i.test(value)) value = value.toLowerCase() === 'true';
        args[match[1]] = value;
    }
    if (args.messages !== undefined && args.depth === undefined) args.depth = args.messages;
    return args;
}

function resolveRecipeMacro(invocation, sources, includeUnresolved) {
    const provided = sources?.[invocation.key];
    if (provided == null) return includeUnresolved ? `[Macro: {{${invocation.macro}}}]` : '';
    return typeof provided === 'function' ? provided(invocation.args) : provided;
}

/** Attaches the trace only when the caller asked for it; never touches `messages`. */
function withPromptTrace(compiled, traceEntries, wanted) {
    return wanted ? { ...compiled, trace: traceEntries } : compiled;
}

/**
 * Expand a named `{{outlet::name}}` supplied by the active compiler.
 *
 * Two spellings, one mechanism, because they are the same idea reached from
 * two directions. Story recipes fill outlets from World Info; a Loom
 * recipe fills them with the parts of its contract that the PARSER depends on
 * — the notebook tags, the state fence, the capability list.
 *
 * Those parts have to expand at compile time rather than being pasted into a
 * recipe once. A pasted copy is a snapshot of what the code required on the
 * day it was pasted, and the moment a capability gains a required argument
 * that copy is silently wrong — which is precisely the defect this codebase
 * just spent three sessions on, where `validateArguments` demanded `valueType`
 * and the prompt had never heard of it. A macro cannot drift from the code
 * that renders it.
 */
function resolvePromptOutlets(content, outlets) {
    return String(content || '').replace(/{{outlet::(.+?)}}/gi, (_, name) => {
        const value = outlets?.[String(name).trim()];
        return Array.isArray(value) ? value.join('\n') : String(value || '');
    });
}

export function formatPromptStudioPreview(compiled) {
    if (!compiled) return '(No prompt could be compiled.)';
    if (compiled.apiType === 'text') return compiled.text || '(Empty Text Completion prompt.)';
    return (compiled.messages || [])
        .map((message) => `=== ${String(message.role || 'unknown').toUpperCase()} ===\n${message.content || ''}`)
        .join('\n\n') || '(Empty Chat Completion prompt.)';
}

export function renderPromptStudioWorkspace() {
    ensureSelectedRecipe();
    const recipes = getFilteredRecipes();
    const selected = getPromptRecipe(state.selectedRecipeId) || recipes[0] || null;
    if (selected && selected.id !== state.selectedRecipeId) state.selectedRecipeId = selected.id;

    return `
        <section class="remodel-prompt-studio" aria-label="Prompt Studio">
            <aside class="remodel-prompt-library">
                <div class="remodel-prompt-library-head">
                    <div>
                        <span class="remodel-prompt-kicker">Prompt Studio</span>
                        <h2>Recipes</h2>
                    </div>
                    <div class="remodel-prompt-library-actions">
                        <button type="button" class="remodel-prompt-icon-button" data-remodel-prompt-create title="New prompt" aria-label="New prompt">
                            <i class="fa-solid fa-plus" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <div class="remodel-prompt-matrix" aria-label="Prompt category">
                    ${renderFilterGroup('mode', PROMPT_MODES, state.mode, 'Mode')}
                    ${renderFilterGroup('api', PROMPT_API_TYPES, state.apiType, 'Transport', state.mode === 'loom'
                        ? { text: 'Loom recipes are Chat Completion only' }
                        : null)}
                </div>
                <label class="remodel-prompt-search">
                    <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                    <input type="search" data-remodel-prompt-search value="${escapeAttribute(state.search)}" placeholder="Search recipes">
                </label>
                <div class="remodel-prompt-recipe-list" role="list">
                    ${recipes.length ? recipes.map(renderRecipeRow).join('') : '<p class="remodel-prompt-empty">No recipes match this filter.</p>'}
                </div>
            </aside>
            <div class="remodel-prompt-editor">
                ${selected ? renderRecipeEditor(selected) : renderEmptyEditor()}
            </div>
        </section>
    `;
}

function renderFilterGroup(kind, values, active, groupLabel, disabledValues) {
    const labelId = `remodel-prompt-filter-${kind}-label`;
    return `<div class="remodel-prompt-filter-block">
        <span class="remodel-prompt-filter-label" id="${labelId}">${escapeHtml(groupLabel)}</span>
        <div class="remodel-prompt-filter-group" role="group" aria-labelledby="${labelId}">${values.map((value) => {
            const isActive = active === value;
            const disabledReason = disabledValues?.[value];
            return `
        <button type="button" class="${isActive ? 'is-active' : ''}" data-remodel-prompt-filter="${kind}" data-value="${escapeAttribute(value)}" aria-pressed="${isActive ? 'true' : 'false'}"${disabledReason ? ` disabled title="${escapeAttribute(disabledReason)}"` : ''}>
            ${escapeHtml(value === 'chat' ? 'Chat Completion' : value === 'text' ? 'Text Completion' : capitalize(value))}
        </button>`;
        }).join('')}</div>
    </div>`;
}

function renderRecipeRow(recipe) {
    const active = isPromptRecipeActive(recipe.id);
    return `
        <button type="button" role="listitem" class="remodel-prompt-recipe-row ${recipe.id === state.selectedRecipeId ? 'is-selected' : ''}" data-remodel-prompt-select="${escapeAttribute(recipe.id)}">
            <span class="remodel-prompt-recipe-glyph"><i class="fa-solid ${recipe.apiType === 'chat' ? 'fa-comments' : 'fa-align-left'}"></i></span>
            <span class="remodel-prompt-recipe-copy">
                <strong>${escapeHtml(recipe.name)}</strong>
                <small>${escapeHtml(capitalize(recipe.mode))} · ${escapeHtml(capitalize(recipe.apiType))}</small>
            </span>
            ${active ? '<span class="remodel-prompt-active-dot" title="Active default"></span>' : ''}
        </button>
    `;
}

function renderRecipeEditor(recipe) {
    const active = isPromptRecipeActive(recipe.id);
    const usedByScene = state.isRecipeInUse(recipe.id);
    const availableTemplates = getAvailableTemplates(recipe);
    return `
        <header class="remodel-prompt-editor-head">
            <div class="remodel-prompt-editor-title">
                <span class="remodel-prompt-kicker">${escapeHtml(capitalize(recipe.mode))} · ${recipe.apiType === 'chat' ? 'Chat Completion' : 'Text Completion'}</span>
                <input type="text" data-remodel-prompt-field="name" value="${escapeAttribute(recipe.name)}" aria-label="Prompt name">
                <textarea data-remodel-prompt-field="description" placeholder="What does this prompt do?">${escapeHtml(recipe.description)}</textarea>
            </div>
            <div class="remodel-prompt-editor-actions">
                <span class="remodel-prompt-save-state" data-remodel-prompt-save-state>Saved</span>
                <button type="button" data-remodel-prompt-preview><i class="fa-solid fa-eye"></i> Preview</button>
                <button type="button" data-remodel-prompt-clone title="Clone prompt"><i class="fa-regular fa-copy"></i></button>
                <button type="button" data-remodel-prompt-delete title="${usedByScene ? 'This recipe is selected by a Scene' : 'Delete prompt'}" ${active || usedByScene ? 'disabled' : ''}><i class="fa-regular fa-trash-can"></i></button>
                <button type="button" class="remodel-prompt-activate ${active ? 'is-active' : ''}" data-remodel-prompt-activate ${active ? 'disabled' : ''}>
                    <i class="fa-solid fa-bolt"></i> ${active ? 'Active default' : 'Set active'}
                </button>
            </div>
        </header>
        <div class="remodel-prompt-editor-scroll">
            <div class="remodel-prompt-stack-head">
                <div>
                    <span class="remodel-prompt-kicker">Instructions</span>
                    <h3>Message stack</h3>
                </div>
                <p>Messages are sent from top to bottom. Macros resolve from the active scene when the request is assembled.</p>
            </div>
            <div class="remodel-prompt-blocks" data-remodel-prompt-blocks>
                ${(recipe.blocks || []).map((block, index) => renderPromptBlock(recipe, block, index)).join('')}
            </div>
            <div class="remodel-prompt-add-row">
                <label>
                    <span>Message role</span>
                    <select data-remodel-prompt-add-role>
                        ${PROMPT_ROLES.map((role) => `<option value="${role}" ${role === 'instruction' ? 'selected' : ''}>${roleLabels[role]}</option>`).join('')}
                    </select>
                </label>
                <button type="button" data-remodel-prompt-add-message><i class="fa-solid fa-plus"></i> Add message</button>
                <label>
                    <span>Template</span>
                    <select data-remodel-prompt-add-template>
                        ${availableTemplates.map((template) => `<option value="${escapeAttribute(template.key)}">${escapeHtml(template.label)}</option>`).join('')}
                    </select>
                </label>
                <button type="button" data-remodel-prompt-insert-template ${availableTemplates.length ? '' : 'disabled'}><i class="fa-solid fa-file-circle-plus"></i> Add template</button>
            </div>
            ${renderMacroReference(recipe)}
            ${recipe.apiType === 'text' ? renderTransportEditor(recipe) : ''}
        </div>
    `;
}

function renderPromptBlock(recipe, block, index) {
    const source = block.kind === 'source' ? getSourceDefinition(recipe, block.sourceKey) : null;
    const macros = findRecipeMacros(recipe, block.content || '');
    const bindingNote = sourceBindingNote(recipe, block);
    const movable = canMoveBlock(recipe, block);
    const advancedLocked = Boolean(block.advancedWarning) && !state.advancedUnlockedBlocks.has(block.id);
    const railTitle = movable
        ? (block.locked ? 'Drag to reorder — this source stays linked and cannot be deleted' : 'Drag to reorder')
        : bindingNote;
    return `
        <article class="remodel-prompt-block role-${escapeAttribute(block.role)} ${block.kind === 'source' ? 'is-source' : ''} ${block.enabled ? '' : 'is-disabled'}" draggable="${movable ? 'true' : 'false'}" data-remodel-prompt-block="${escapeAttribute(block.id)}">
            <div class="remodel-prompt-block-rail">
                <i class="fa-solid ${movable ? 'fa-grip-vertical' : 'fa-lock'}" title="${escapeAttribute(railTitle)}" aria-hidden="true"></i>
                <span>${String(index + 1).padStart(2, '0')}</span>
            </div>
            <div class="remodel-prompt-block-main">
                <div class="remodel-prompt-block-head">
                    <select data-remodel-prompt-block-role aria-label="Message role">
                        ${PROMPT_ROLES.map((role) => `<option value="${role}" ${block.role === role ? 'selected' : ''}>${roleLabels[role]}</option>`).join('')}
                    </select>
                    <span class="remodel-prompt-block-kind">${block.kind === 'source' ? '<i class="fa-solid fa-link"></i> Legacy source' : macros.length ? '<i class="fa-solid fa-braces"></i> Macro message' : '<i class="fa-regular fa-message"></i> Authored message'}</span>
                    <div class="remodel-prompt-block-actions">
                        <button type="button" data-remodel-prompt-block-toggle title="${block.enabled ? 'Disable' : 'Enable'}"><i class="fa-solid ${block.enabled ? 'fa-eye' : 'fa-eye-slash'}"></i></button>
                        <button type="button" data-remodel-prompt-block-up title="Move up" ${index === 0 || !movable ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                        <button type="button" data-remodel-prompt-block-down title="Move down" ${index === recipe.blocks.length - 1 || !movable ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                        <button type="button" data-remodel-prompt-block-copy title="Copy"><i class="fa-regular fa-copy"></i></button>
                        <button type="button" data-remodel-prompt-block-delete title="Delete" ${block.locked ? 'disabled' : ''}><i class="fa-regular fa-trash-can"></i></button>
                    </div>
                </div>
                ${block.kind === 'source'
                    ? `<div class="remodel-prompt-source-card"><strong>${escapeHtml(source?.label || block.sourceKey)}</strong><p>${escapeHtml(sourceDescription(recipe, block.sourceKey))}</p>${bindingNote ? `<span>${escapeHtml(bindingNote)}</span>` : ''}${canOpenSource(block.sourceKey) ? '<button type="button" data-remodel-prompt-source-open><i class="fa-solid fa-arrow-up-right-from-square"></i> Open source</button>' : ''}</div>`
                    : `${block.advancedWarning ? `<div class="remodel-prompt-advanced-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(block.advancedWarning)}</span>${advancedLocked ? '<button type="button" data-remodel-prompt-advanced-unlock>Unlock contract editing</button>' : '<strong>Contract editing unlocked for this session</strong>'}</div>` : ''}<textarea data-remodel-prompt-block-content placeholder="Write the ${escapeAttribute(roleLabels[block.role].toLowerCase())} message…" ${advancedLocked ? 'disabled aria-disabled="true"' : ''}>${escapeHtml(block.content)}</textarea>`}
                ${macros.length ? `<div class="remodel-prompt-macro-chips">${macros.map((item) => `<span title="${escapeAttribute(item.description || item.label)}">{{${escapeHtml(item.macro)}}}</span>`).join('')}</div>` : ''}
                ${renderPromptBlockSettings(recipe, block)}
            </div>
        </article>
    `;
}

function renderMacroReference(recipe) {
    const definitions = getSourceDefinitions(recipe).filter((item) => !item.textOnly || recipe.apiType === 'text');
    if (!definitions.length) return '';
    return `<details class="remodel-prompt-macro-reference">
        <summary><i class="fa-solid fa-braces" aria-hidden="true"></i> Available macros <small>Named arguments supported</small></summary>
        <div>${definitions.map((item) => `<span><code>{{${escapeHtml(item.macro)}}}</code><small>${escapeHtml(item.label)}${item.arguments ? ` · ${escapeHtml(item.arguments)}` : ''}</small></span>`).join('')}</div>
        <p>Arguments use <code>name=value</code>, for example <code>{{world.info.depth messages=3}}</code>. Structural macros such as chat history should remain alone in their message so their original roles and ordering are preserved.</p>
    </details>`;
}

/**
 * The editor for a block that carries settings — design §5's second
 * consequence, which nothing implemented until now.
 *
 * WHY THIS EXISTS AT ALL, since the omission was invisible per-task: §5 chose
 * a per-block setting over a Mechanics-profile setting on exactly one
 * argument — "the control belongs next to the thing it controls, where a user
 * editing their Narrator recipe will actually find it", against a profile
 * setting that "would have been cheaper and effectively undiscoverable". With
 * the bag built, the source declaring `label`/`min`/`max`, the normaliser
 * clamping, and no control anywhere, what shipped was neither discoverable NOR
 * editable: `loomNotes` had `depth` permanently 3 for every user forever,
 * and the declared bounds were decoration. That is strictly worse than the
 * alternative the design rejected, at higher cost.
 *
 * Rendered from the SOURCE DEFINITION, not from the block's saved bag, so a
 * block whose source declares nothing renders nothing (the other half of §5's
 * sentence) and a source that declares a setting cannot ship without a control
 * by omission. Every declared spec produces a field: a number spec gets a
 * number input carrying its own min/max, and anything else falls back to a
 * text input rather than silently rendering nothing — which is the failure
 * mode this function exists to end, and it should not be able to recur for
 * the next setting type someone declares.
 *
 * Values are NOT trusted from this control. `applyPromptBlockSetting` puts
 * every edit back through `normalizeRecipe`, so the min/max here are a hint to
 * the browser and the clamp is still the store's.
 */
export function renderPromptBlockSettings(recipe, block) {
    if (block?.kind !== 'source') return '';
    const declared = getSourceDefinition(recipe, block.sourceKey)?.settings;
    if (!declared || typeof declared !== 'object') return '';
    const fields = Object.entries(declared)
        .map(([key, spec]) => renderPromptBlockSettingField(block, key, spec))
        .join('');
    if (!fields) return '';
    return `<div class="remodel-prompt-block-settings">${fields}</div>`;
}

function renderPromptBlockSettingField(block, key, spec) {
    const saved = block.settings?.[key];
    const value = saved === undefined ? spec?.default : saved;
    const attributes = spec?.type === 'number'
        ? `type="number" inputmode="numeric" step="1"${typeof spec.min === 'number' ? ` min="${escapeAttribute(String(spec.min))}"` : ''}${typeof spec.max === 'number' ? ` max="${escapeAttribute(String(spec.max))}"` : ''}`
        : 'type="text"';
    const range = spec?.type === 'number' && typeof spec.min === 'number' && typeof spec.max === 'number'
        ? ` title="${escapeAttribute(`${spec.min}–${spec.max}`)}"`
        : '';
    return `<label class="remodel-prompt-block-setting">
                    <span>${escapeHtml(spec?.label || key)}</span>
                    <input ${attributes}${range} data-remodel-prompt-block-setting="${escapeAttribute(key)}" value="${escapeAttribute(String(value ?? ''))}">
                </label>`;
}

/**
 * Write one setting back, through the same funnel every other recipe edit
 * takes.
 *
 * `updatePromptRecipe` re-runs `normalizeBlocks`, so the value the store keeps
 * is the coerced, clamped, default-filled one — a user typing 99 into a
 * `max: 20` field stores 20, and an emptied field stores the declared default
 * rather than 0 (`coerceSettingValue`'s `hasUsableNumber` check). Returning
 * the normalized block is what lets a caller show what was actually kept
 * instead of what was typed.
 *
 * Refuses a key the source definition does not declare. Without that, a
 * hand-crafted `data-remodel-prompt-block-setting` attribute would write a
 * key that `normalizeBlockSettings` then drops on the next load — a setting
 * that appears to save and silently does not.
 */
export function applyPromptBlockSetting(recipeId, blockId, key, rawValue) {
    const recipe = getPromptRecipe(recipeId);
    const block = (recipe?.blocks || []).find((entry) => entry.id === blockId);
    if (!block || block.kind !== 'source') return null;
    const declared = getSourceDefinition(recipe, block.sourceKey)?.settings;
    if (!declared || !Object.prototype.hasOwnProperty.call(declared, key)) return null;
    block.settings = { ...(block.settings || {}), [key]: rawValue };
    const updated = updatePromptRecipe(recipe.id, { blocks: recipe.blocks });
    return (updated?.blocks || []).find((entry) => entry.id === blockId) || null;
}

function renderTransportEditor(recipe) {
    const transport = recipe.transport || {};
    const sysprompt = transport.sysprompt || {};
    const context = transport.context || {};
    const instruct = transport.instruct || {};
    return `
        <details class="remodel-prompt-transport">
            <summary><span><i class="fa-solid fa-sliders"></i> Transport formatting</span><small data-remodel-prompt-transport-state>System, context and instruct serialization</small></summary>
            <p class="remodel-prompt-transport-intro">Controls how the ordered message blocks are serialized for Text Completion. Changes to the recipe used by the current Scene are applied to SillyTavern immediately.</p>
            <div class="remodel-prompt-transport-grid">
                ${renderTransportCheckbox('sysprompt.enabled', 'System prompt enabled', sysprompt.enabled)}
                ${renderTransportTextarea('sysprompt.content', 'System prompt', sysprompt.content)}
                ${renderTransportTextarea('context.story_string', 'Story string', context.story_string)}
                ${renderTransportTextarea('context.chat_start', 'Chat start', context.chat_start)}
                ${renderTransportTextarea('context.example_separator', 'Example separator', context.example_separator)}
                ${renderTransportCheckbox('instruct.enabled', 'Instruct mode enabled', instruct.enabled)}
                ${renderTransportCheckbox('instruct.wrap', 'Wrap sequences', instruct.wrap)}
                ${renderTransportCheckbox('instruct.system_same_as_user', 'System uses user sequence', instruct.system_same_as_user)}
                ${renderTransportInput('instruct.names_behavior', 'Names behavior', instruct.names_behavior)}
                ${renderTransportTextarea('instruct.system_sequence', 'System prefix', instruct.system_sequence)}
                ${renderTransportTextarea('instruct.system_suffix', 'System suffix', instruct.system_suffix)}
                ${renderTransportTextarea('instruct.input_sequence', 'User prefix', instruct.input_sequence)}
                ${renderTransportTextarea('instruct.input_suffix', 'User suffix', instruct.input_suffix)}
                ${renderTransportTextarea('instruct.output_sequence', 'Assistant prefix', instruct.output_sequence)}
                ${renderTransportTextarea('instruct.output_suffix', 'Assistant suffix', instruct.output_suffix)}
                ${renderTransportTextarea('instruct.stop_sequence', 'Stop sequence', instruct.stop_sequence)}
            </div>
        </details>
    `;
}

function renderTransportCheckbox(path, label, checked) {
    return `<label class="remodel-prompt-transport-check"><input type="checkbox" data-remodel-prompt-transport="${path}" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

function renderTransportInput(path, label, value) {
    return `<label><span>${escapeHtml(label)}</span><input type="text" data-remodel-prompt-transport="${path}" value="${escapeAttribute(value || '')}"></label>`;
}

function renderTransportTextarea(path, label, value) {
    return `<label class="is-wide"><span>${escapeHtml(label)}</span><textarea data-remodel-prompt-transport="${path}">${escapeHtml(value || '')}</textarea></label>`;
}

function renderEmptyEditor() {
    return `<div class="remodel-prompt-editor-empty"><i class="fa-solid fa-wand-magic-sparkles"></i><h2>Select a prompt recipe</h2><p>Create a recipe or choose one from the library to edit its message stack.</p></div>`;
}

function bindPromptStudioEvents() {
    // Tavern's adopted drawer surfaces may stop a bubbled click before it
    // reaches document. Capture here so Studio controls remain native-feeling
    // regardless of which workspace was open immediately before Prompts.
    document.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const studio = target?.closest('.remodel-prompt-studio');
        if (!studio) return;

        const filter = target.closest('[data-remodel-prompt-filter]');
        if (filter) {
            // Belt-and-suspenders alongside the `disabled` attribute rendered
            // by renderFilterGroup: a disabled chip should never register a
            // filter change even if something re-enables the pointer.
            if (filter.disabled) return;
            const value = filter.dataset.value;
            if (filter.dataset.remodelPromptFilter === 'mode' && PROMPT_MODES.includes(value)) {
                state.mode = value;
                // Loom recipes are Chat Completion only (enforced in the
                // data model — see normalizeRecipe in prompt-studio-store.js).
                // Switching into loom mode while the Transport filter is
                // still on 'text' would leave it pointing at a filter
                // combination with no matching recipes, so pull it back to
                // 'chat' the same way the data model would.
                if (state.mode === 'loom' && state.apiType === 'text') state.apiType = 'chat';
            }
            if (filter.dataset.remodelPromptFilter === 'api' && PROMPT_API_TYPES.includes(value)) state.apiType = value;
            ensureSelectedRecipe(true);
            state.requestRender();
            return;
        }
        const select = target.closest('[data-remodel-prompt-select]');
        if (select) {
            state.selectedRecipeId = select.dataset.remodelPromptSelect;
            state.requestRender();
            return;
        }
        const recipe = getPromptRecipe(state.selectedRecipeId);
        const unlock = target.closest('[data-remodel-prompt-advanced-unlock]');
        if (unlock && recipe) {
            const card = unlock.closest('[data-remodel-prompt-block]');
            const block = card ? recipe.blocks.find((item) => item.id === card.dataset.remodelPromptBlock) : null;
            if (block?.advancedWarning && window.confirm(`${block.advancedWarning}\n\nUnlock this contract for editing during this session?`)) {
                state.advancedUnlockedBlocks.add(block.id);
                state.requestRender();
            }
            return;
        }
        if (target.closest('[data-remodel-prompt-create]')) {
            const created = createPromptRecipe({ mode: state.mode, apiType: state.apiType, transport: state.apiType === 'text' ? captureTextTransport(power_user) : null });
            state.selectedRecipeId = created.id;
            state.requestRender();
            return;
        }
        if (!recipe) return;
        if (target.closest('[data-remodel-prompt-clone]')) {
            const cloned = clonePromptRecipe(recipe.id);
            if (cloned) {
                state.mode = cloned.mode;
                state.apiType = cloned.apiType;
                state.selectedRecipeId = cloned.id;
                state.requestRender();
            }
            return;
        }
        if (target.closest('[data-remodel-prompt-delete]')) {
            if (isPromptRecipeActive(recipe.id) || state.isRecipeInUse(recipe.id)) return;
            if (window.confirm(`Delete “${recipe.name}”?`)) {
                deletePromptRecipe(recipe.id);
                ensureSelectedRecipe(true);
                state.requestRender();
            }
            return;
        }
        if (target.closest('[data-remodel-prompt-activate]')) {
            setActivePromptRecipe(recipe.mode, recipe.apiType, recipe.id);
            if (getCurrentPromptStudioRecipe(recipe.mode, recipe.apiType)?.id === recipe.id) {
                applyPromptStudioRuntimeRecipe();
            }
            state.requestRender();
            return;
        }
        if (target.closest('[data-remodel-prompt-preview]')) {
            await state.previewRecipe?.(recipe);
            return;
        }
        if (target.closest('[data-remodel-prompt-add-message]')) {
            const role = studio.querySelector('[data-remodel-prompt-add-role]')?.value || 'instruction';
            patchRecipeBlocks(recipe, [...recipe.blocks, createPromptBlock({ kind: 'message', role })]);
            return;
        }
        if (target.closest('[data-remodel-prompt-insert-template]')) {
            const templateKey = studio.querySelector('[data-remodel-prompt-add-template]')?.value;
            const block = createPromptBlockFromTemplate(recipe.mode, templateKey);
            if (block) patchRecipeBlocks(recipe, [...recipe.blocks, block]);
            return;
        }

        const card = target.closest('[data-remodel-prompt-block]');
        const block = card ? recipe.blocks.find((item) => item.id === card.dataset.remodelPromptBlock) : null;
        if (!block) return;
        if (target.closest('[data-remodel-prompt-source-open]')) {
            await state.openSource?.(recipe, block.sourceKey);
            return;
        }
        if (target.closest('[data-remodel-prompt-block-toggle]')) {
            block.enabled = !block.enabled;
            patchRecipeBlocks(recipe, recipe.blocks);
        } else if (target.closest('[data-remodel-prompt-block-up]')) {
            moveBlock(recipe, block.id, -1);
        } else if (target.closest('[data-remodel-prompt-block-down]')) {
            moveBlock(recipe, block.id, 1);
        } else if (target.closest('[data-remodel-prompt-block-copy]')) {
            const index = recipe.blocks.findIndex((item) => item.id === block.id);
            const copy = createPromptBlock({ ...block, id: undefined, locked: false, nativeIdentifier: '' });
            const blocks = [...recipe.blocks];
            blocks.splice(index + 1, 0, copy);
            patchRecipeBlocks(recipe, blocks);
        } else if (target.closest('[data-remodel-prompt-block-delete]') && !block.locked) {
            patchRecipeBlocks(recipe, recipe.blocks.filter((item) => item.id !== block.id));
        }
    }, true);

    document.addEventListener('input', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('.remodel-prompt-studio')) return;
        if (target.matches('[data-remodel-prompt-search]')) {
            state.search = target.value || '';
            state.requestRender();
            requestAnimationFrame(() => {
                const field = document.querySelector('[data-remodel-prompt-search]');
                field?.focus();
                field?.setSelectionRange?.(field.value.length, field.value.length);
            });
            return;
        }
        const recipe = getPromptRecipe(state.selectedRecipeId);
        if (!recipe) return;
        const field = target.closest('[data-remodel-prompt-field]');
        if (field) {
            updatePromptRecipe(recipe.id, { [field.dataset.remodelPromptField]: field.value });
            onRecipeChanged(recipe);
            return;
        }
        const card = target.closest('[data-remodel-prompt-block]');
        const block = card ? recipe.blocks.find((item) => item.id === card.dataset.remodelPromptBlock) : null;
        if (block && target.matches('[data-remodel-prompt-block-content]')) {
            block.content = target.value;
            updatePromptRecipe(recipe.id, { blocks: recipe.blocks });
            onRecipeChanged(recipe);
            return;
        }
        if (block && target.matches('[data-remodel-prompt-block-setting]')) {
            // Saved on every keystroke, like the message textarea beside it,
            // and deliberately WITHOUT a re-render: re-rendering mid-edit
            // would replace the field the caret is in. The committed value is
            // reconciled by the `change` handler below, which fires on blur.
            applyPromptBlockSetting(recipe.id, block.id, target.dataset.remodelPromptBlockSetting, target.value);
            onRecipeChanged(recipe);
            return;
        }
        const transportField = target.closest('[data-remodel-prompt-transport]');
        if (transportField) {
            const value = transportField.type === 'checkbox' ? transportField.checked : transportField.value;
            const transport = structuredClone(recipe.transport || {});
            setPath(transport, transportField.dataset.remodelPromptTransport, value);
            updatePromptRecipe(recipe.id, { transport });
            onRecipeChanged(recipe);
            showTransportFeedback(transportField);
        }
    }, true);

    document.addEventListener('change', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const card = target?.closest('[data-remodel-prompt-block]');
        const recipe = getPromptRecipe(state.selectedRecipeId);
        if (!card || !recipe) return;
        const block = recipe.blocks.find((item) => item.id === card.dataset.remodelPromptBlock);
        if (!block) return;
        if (target.matches('[data-remodel-prompt-block-role]')) {
            if (!PROMPT_ROLES.includes(target.value)) return;
            block.role = target.value;
            patchRecipeBlocks(recipe, recipe.blocks);
            return;
        }
        if (target.matches('[data-remodel-prompt-block-setting]')) {
            // `change` fires on commit (blur or Enter), which is the one
            // moment a re-render is welcome: it repaints the field with the
            // value the store actually kept, so a user who typed 99 into a
            // max-20 setting sees 20 rather than believing 99 was saved.
            applyPromptBlockSetting(recipe.id, block.id, target.dataset.remodelPromptBlockSetting, target.value);
            onRecipeChanged(recipe);
            state.requestRender();
        }
    }, true);

    document.addEventListener('dragstart', (event) => {
        const card = event.target instanceof Element ? event.target.closest('[data-remodel-prompt-block]') : null;
        if (!card || card.getAttribute('draggable') !== 'true') return;
        state.dragBlockId = card.dataset.remodelPromptBlock;
        event.dataTransfer.setData('text/plain', state.dragBlockId);
        event.dataTransfer.effectAllowed = 'move';
        card.classList.add('is-dragging');
    });
    document.addEventListener('dragover', (event) => {
        if (!state.dragBlockId || !(event.target instanceof Element) || !event.target.closest('.remodel-prompt-studio')) return;
        if (event.target.closest('[data-remodel-prompt-block]') || event.target.closest('[data-remodel-prompt-blocks]')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        }
    });
    document.addEventListener('drop', (event) => {
        const recipe = getPromptRecipe(state.selectedRecipeId);
        if (!recipe || !state.dragBlockId) return;
        const targetCard = event.target instanceof Element ? event.target.closest('[data-remodel-prompt-block]') : null;
        const container = event.target instanceof Element ? event.target.closest('[data-remodel-prompt-blocks]') : null;
        if (!targetCard && !container) return;
        event.preventDefault();
        const from = recipe.blocks.findIndex((block) => block.id === state.dragBlockId);
        let to = targetCard ? recipe.blocks.findIndex((block) => block.id === targetCard.dataset.remodelPromptBlock) : recipe.blocks.length - 1;
        if (from !== -1 && to !== -1 && from !== to && canMoveBlock(recipe, recipe.blocks[from])) {
            const blocks = [...recipe.blocks];
            const [moved] = blocks.splice(from, 1);
            blocks.splice(to, 0, moved);
            patchRecipeBlocks(recipe, blocks);
        }
        state.dragBlockId = null;
    });
    document.addEventListener('dragend', () => {
        state.dragBlockId = null;
        document.querySelectorAll('.remodel-prompt-block.is-dragging').forEach((card) => card.classList.remove('is-dragging'));
    });
}

function patchRecipeBlocks(recipe, blocks) {
    const scrollContainer = document.querySelector('.remodel-prompt-editor-scroll');
    const savedScroll = scrollContainer ? scrollContainer.scrollTop : 0;
    updatePromptRecipe(recipe.id, { blocks });
    onRecipeChanged(recipe);
    state.requestRender();
    requestAnimationFrame(() => {
        const container = document.querySelector('.remodel-prompt-editor-scroll');
        if (container) container.scrollTop = savedScroll;
    });
}

// Reordering and deleting are different permissions, and conflating them is
// what made every core marker immovable. SillyTavern's own Prompt Manager
// makes EVERY prompt draggable (markers included) and reorders by rewriting
// oai_settings.prompt_order — which is exactly what applyRoleplayChatRecipe
// already does with the block order. So position is free; what stays locked
// is deleting a marker or editing its content, since those genuinely have no
// native equivalent.
function canMoveBlock(recipe, block) {
    if (!block?.locked) return true;
    return recipe.mode === 'roleplay' && recipe.apiType === 'chat' && Boolean(block.nativeIdentifier);
}

function moveBlock(recipe, blockId, offset) {
    const index = recipe.blocks.findIndex((block) => block.id === blockId);
    const destination = index + offset;
    if (index < 0 || destination < 0 || destination >= recipe.blocks.length || !canMoveBlock(recipe, recipe.blocks[index])) return;
    const blocks = [...recipe.blocks];
    const [block] = blocks.splice(index, 1);
    blocks.splice(destination, 0, block);
    patchRecipeBlocks(recipe, blocks);
}

function onRecipeChanged(recipe) {
    setSaveState('Saving…');
    if (getCurrentPromptStudioRecipe(recipe.mode, recipe.apiType)?.id === recipe.id) applyRecipeToNative(recipe);
    clearTimeout(saveLabelTimer);
    saveLabelTimer = setTimeout(() => setSaveState('Saved'), 650);
}

function setSaveState(label) {
    const element = document.querySelector('[data-remodel-prompt-save-state]');
    if (element) element.textContent = label;
}

function showTransportFeedback(field) {
    const drawer = field.closest('.remodel-prompt-transport');
    const status = drawer?.querySelector('[data-remodel-prompt-transport-state]');
    if (!drawer || !status) return;
    drawer.classList.remove('is-updated');
    void drawer.offsetWidth;
    drawer.classList.add('is-updated');
    status.textContent = field.type === 'checkbox'
        ? (field.checked ? 'Enabled · applied' : 'Disabled · applied')
        : 'Change applied';
    clearTimeout(transportFeedbackTimer);
    transportFeedbackTimer = setTimeout(() => {
        drawer.classList.remove('is-updated');
        status.textContent = 'Saved to this recipe';
    }, 900);
}

function applyRecipeToNative(recipe) {
    if (!recipe) return;
    // Defense in depth: every native path funnels through this one function,
    // so this is where the loom/native split holds even for a call site
    // that forgets to check isNativeApplicableMode() itself (see onRecipeChanged).
    if (!isNativeApplicableMode(recipe.mode)) return;
    state.nativeSyncGuard = true;
    try {
        if (recipe.mode === 'roleplay' && recipe.apiType === 'chat') applyRoleplayChatRecipe(recipe);
        if (recipe.apiType === 'text') applyTextTransport(recipe.transport || {});
        state.nativeSignature = getNativeSignature(recipe.mode, recipe.apiType);
        saveSettingsDebounced();
    } finally {
        setTimeout(() => {
            state.nativeSyncGuard = false;
            state.nativeSignature = getNativeSignature(state.getRuntimeMode(), getPromptApiType());
        }, 0);
    }
}

/**
 * Roleplay sources whose text REMODEL produces, rather than core resolving it.
 *
 * These are the two that must not be markers. Everything else in a roleplay
 * recipe names something core already knows how to fill.
 */
const REMODEL_RENDERED_SOURCES = new Set(['narratorGrounding', 'storyGoals']);

/**
 * Put fresh text into one of our own native prompts, at whatever position the
 * recipe gave it.
 *
 * Replaces a `setExtensionPrompt(…, IN_CHAT, depth)` call. The extension-prompt
 * route delivered the text but chose its own position — inside the chat, so
 * many messages back from the end — and no recipe arrangement could move it.
 * Writing the content onto the prompt object leaves placement entirely to
 * prompt_order, which is what the recipe list already edits.
 *
 * Returns false when the recipe has no enabled block for that source, which is
 * the "the user switched it off" case and must stay distinguishable from
 * "there was nothing to say".
 */
export function setRemodelNativePromptContent(sourceKey, content) {
    const recipe = getCurrentPromptStudioRecipe('roleplay', 'chat');
    const block = (recipe?.blocks || [])
        .filter((entry) => parseWholeRecipeMacro(recipe, entry.content || '')?.key === sourceKey)
        .find((entry) => entry.enabled !== false);
    if (!block) return false;
    const identifier = getSourceDefinition({ mode: 'roleplay' }, sourceKey)?.nativeIdentifier || block.nativeIdentifier;
    if (!identifier) return false;
    oai_settings.prompts ??= [];
    const prompt = oai_settings.prompts.find((entry) => entry?.identifier === identifier);
    if (!prompt) return false;
    // Kept non-marker on every write, not only when the recipe is applied: a
    // preset change can rewrite these objects between generations, and a
    // marker here means the text silently reaches nothing.
    prompt.marker = false;
    prompt.role = 'system';
    const invocation = parseWholeRecipeMacro(recipe, block.content || '');
    const resolved = typeof content === 'function' ? content(invocation?.args || {}) : content;
    prompt.content = String(resolved || '');
    return true;
}

export function recordLoomPromptTranscript(recipeName, traceBlocks) {
    if (!Array.isArray(traceBlocks)) return;
    const looksCompiled = traceBlocks.every((entry) => entry && typeof entry.role === 'string' && Object.prototype.hasOwnProperty.call(entry, 'content'));
    const messages = looksCompiled
        ? traceBlocks
        : traceBlocks.flatMap((entry) => Array.isArray(entry.parts)
            ? entry.parts.map((part) => ({ role: part.role, content: part.content }))
            : [{ role: entry.role || 'system', content: entry.text || '' }]);
    recordSentPromptTranscript('loom', {
        recipeName: recipeName || 'Loom',
        messages,
        request: { prompt: messages, transport: 'chat', purpose: 'loom-reconciliation' },
        transport: 'chat',
    });
}

/**
 * Record the Narrator's actual compiled prompt in the Debug transcript.
 *
 * The custom Narrator path can bypass core prompt assembly, so this accepts the
 * final message array rather than reconstructing one from recipe state.
 *
 * @param {{label?: string, role?: string, content?: string}[]} blocks
 */
export function recordNarratorPromptTranscript(blocks) {
    if (!Array.isArray(blocks)) return;
    recordSentPromptTranscript('narrator', {
        recipeName: 'Narrator (custom stream)',
        messages: blocks,
        request: { prompt: blocks, transport: 'chat', purpose: 'narrator' },
        transport: 'chat',
    });
}

export function recordSentPromptTranscript(mode, { recipeName = '', messages = [], text = '', request = null, transport = '' } = {}) {
    if (!['loom', 'narrator', 'chat'].includes(mode)) return;
    const normalizedMessages = Array.isArray(messages) ? messages.map((entry, index) => ({
        label: entry?.name || `Message ${index + 1}`,
        role: entry?.role || 'system',
        kind: 'message',
        sourceKey: null,
        marker: false,
        content: String(entry?.content ?? entry?.mes ?? ''),
    })) : [];
    if (text) normalizedMessages.push({ label: 'Serialized prompt', role: 'system', kind: 'message', sourceKey: null, marker: false, content: String(text) });
    const entry = {
        mode,
        recipeName: recipeName || capitalize(mode),
        timestamp: Date.now(),
        transport,
        blocks: normalizedMessages,
        request: redactPromptSecrets(request),
    };
    recordApiTranscript('prompt', {
        mode,
        recipeName: entry.recipeName,
        transport,
        messages: normalizedMessages.map(({ label, role, content }) => ({ label, role, content })),
        request: entry.request,
    }, {
        type: `api.prompt.${mode}`,
        summary: `${capitalize(mode)} prompt sent via ${entry.recipeName}`,
    });
}

function redactPromptSecrets(value, seen = new WeakSet()) {
    if (value == null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redactPromptSecrets(item, seen));
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
        copy[key] = /^(api[_-]?key|authorization|cookie|password|secret)$/i.test(key)
            ? '[redacted]'
            : redactPromptSecrets(item, seen);
    }
    return copy;
}

function applyRoleplayChatRecipe(recipe) {
    oai_settings.prompts ??= [];
    oai_settings.prompt_order ??= [];
    // Hard cleanup of the two superseded hidden-injection prompt objects. They
    // are not part of the v14 recipe and keeping them around makes native
    // preset capture resurrect obsolete names and identifiers.
    oai_settings.prompts = oai_settings.prompts.filter((prompt) =>
        !['remodel_loom_context', 'remodel_director_notes'].includes(prompt?.identifier)
        && !String(prompt?.identifier || '').startsWith('remodel-chat-history-'));
    const promptMap = new Map(oai_settings.prompts.filter(Boolean).map((prompt) => [prompt.identifier, prompt]));
    const order = [];
    const appendHistoryBoundary = (identifier, content) => {
        const prompt = {
            identifier,
            name: 'Remodel chat history boundary',
            marker: false,
            system_prompt: false,
            role: 'system',
            content,
        };
        oai_settings.prompts.push(prompt);
        promptMap.set(identifier, prompt);
        order.push({ identifier, enabled: true });
    };
    for (const recipeBlock of recipe.blocks || []) {
        for (const block of expandRoleplayNativeBlock(recipe, recipeBlock)) {
        const source = parseWholeRecipeMacro(recipe, block.content || '');
        const historyMessages = source?.key === 'chatHistory' && source.args?.messages !== undefined && block.enabled !== false
            ? Math.max(0, Math.floor(Number(source.args.messages) || 0))
            : null;
        const historyBoundary = historyMessages === null ? null : chatHistoryBoundary(historyMessages);
        if (historyBoundary) appendHistoryBoundary(`remodel-chat-history-start-${block.id}`, historyBoundary.start);
        const identifier = source?.nativeIdentifier || block.nativeIdentifier || `remodel-${block.id}`;
        block.nativeIdentifier = identifier;
        let prompt = promptMap.get(identifier);
        if (!prompt) {
            prompt = { identifier };
            oai_settings.prompts.push(prompt);
            promptMap.set(identifier, prompt);
        }
        if (source && REMODEL_RENDERED_SOURCES.has(source.key)) {
            // OURS TO RENDER, so not a marker.
            //
            // A marker tells core "resolve this identifier yourself", which
            // works for charDescription and every other native source. Core has
            // never heard of remodel_loom_notes, so the marker resolved to
            // NOTHING and the real text had to arrive separately, as an IN_CHAT
            // depth injection — which is why the block sat in the recipe, could
            // be dragged, and ignored where it was dragged to.
            //
            // As a content prompt it is placed by prompt_order like any authored
            // message, so the recipe position finally governs it. That this
            // works is not a guess: an authored block is exactly this shape, and
            // one of the owner's landed after the chat history precisely where
            // their recipe put it.
            prompt.name = source.label;
            prompt.marker = false;
            prompt.system_prompt = false;
            prompt.role = 'system';
            prompt.content = prompt.content || '';
        } else if (source?.nativeIdentifier) {
            prompt.name = source.label;
            prompt.marker = true;
            prompt.system_prompt = true;
            delete prompt.content;
        } else {
            prompt.name = prompt.name || recipe.name;
            prompt.role = block.role === 'instruction' ? 'system' : block.role;
            prompt.content = block.content || '';
            prompt.marker = false;
            prompt.system_prompt = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'].includes(identifier);
        }
        order.push({ identifier, enabled: block.enabled !== false });
        if (historyBoundary) appendHistoryBoundary(`remodel-chat-history-end-${block.id}`, historyBoundary.end);
        }
    }
    let globalOrder = oai_settings.prompt_order.find((entry) => String(entry.character_id) === String(CHAT_PROMPT_ORDER_ID));
    if (!globalOrder) {
        globalOrder = { character_id: CHAT_PROMPT_ORDER_ID, order: [] };
        oai_settings.prompt_order.push(globalOrder);
    }
    globalOrder.order = order;
    promptManager?.render?.(false);
}

/**
 * Native Prompt Manager markers are structural. When a user embeds one of
 * those macros inside prose, split the ordinary recipe block into ordered
 * text/marker/text pieces so the macro still resolves at generation time.
 */
function expandRoleplayNativeBlock(recipe, block) {
    const content = String(block.content || '');
    const pattern = new RegExp(RECIPE_MACRO_PATTERN.source, 'gi');
    const parts = [];
    let cursor = 0;
    let match;
    while ((match = pattern.exec(content))) {
        const invocation = getRecipeMacroDefinition(recipe, match[1], match[2]);
        if (!invocation?.nativeIdentifier) continue;
        if (match.index > cursor) parts.push({ type: 'text', content: content.slice(cursor, match.index) });
        parts.push({ type: 'macro', invocation, content: match[0] });
        cursor = match.index + match[0].length;
    }
    if (!parts.length) return [block];
    if (cursor < content.length) parts.push({ type: 'text', content: content.slice(cursor) });
    if (parts.length === 1 && parts[0].type === 'macro' && content.trim() === parts[0].content.trim()) return [block];
    return parts
        .filter((part) => part.type === 'macro' || part.content.trim())
        .map((part, index) => part.type === 'macro'
            ? {
                ...block,
                id: `${block.id}-macro-${index}`,
                content: part.content,
                nativeIdentifier: part.invocation.nativeIdentifier,
                locked: true,
            }
            : {
                ...block,
                id: `${block.id}-text-${index}`,
                content: part.content,
                nativeIdentifier: `${block.nativeIdentifier || `remodel-${block.id}`}-text-${index}`,
                locked: false,
            });
}

function applyTextTransport(transport) {
    replaceObject(power_user.sysprompt, transport.sysprompt || {});
    replaceObject(power_user.context, transport.context || {});
    replaceObject(power_user.instruct, transport.instruct || {});
    reflectTextTransportInNativeControls();
}

function reflectTextTransportInNativeControls() {
    setNativeControl('sysprompt_enabled', power_user.sysprompt.enabled, true);
    setNativeControl('sysprompt_select', power_user.sysprompt.name || power_user.sysprompt.preset);
    setNativeControl('sysprompt_content', power_user.sysprompt.content);
    for (const [key, value] of Object.entries(power_user.context || {})) {
        setNativeControl(key === 'preset' ? 'context_presets' : `context_${key}`, value, typeof value === 'boolean');
    }
    for (const [key, value] of Object.entries(power_user.instruct || {})) {
        setNativeControl(key === 'preset' ? 'instruct_presets' : `instruct_${key}`, value, typeof value === 'boolean');
    }
}

function setNativeControl(id, value, checkbox = false) {
    const element = document.getElementById(id);
    if (!element) return;
    if (checkbox && 'checked' in element) element.checked = Boolean(value);
    else if ('value' in element) element.value = value == null ? '' : String(value);
}

function captureNativeSettingsIfChanged() {
    if (!state.initialized || state.nativeSyncGuard) return;
    captureNativeSettingsFor(normalizeMode(state.getRuntimeMode()), getPromptApiType());
}

function captureNativeSettingsFor(mode, apiType, recipeId = null) {
    if (!mode || !apiType || state.nativeSyncGuard) return;
    const signature = getNativeSignature(mode, apiType);
    if (signature === state.nativeSignature) return;
    const recipe = recipeId ? getPromptRecipe(recipeId) : getCurrentPromptStudioRecipe(mode, apiType);
    if (!recipe) return;
    if (mode === 'roleplay' && apiType === 'chat') {
        // withRemodelSources, for the same reason createSeededStore applies it:
        // this replaces the recipe's blocks wholesale from native settings, and
        // a Chat Completion preset authored before Remodel has no
        // remodel_loom_notes / remodel_story_goals in its prompt order. It
        // used to strip both out of an already-migrated recipe on any preset
        // change — and the Loom's notebook is now the only route its
        // direction takes to the Narrator.
        updatePromptRecipe(recipe.id, { blocks: withRemodelSources(createBlocksFromNativeChat(oai_settings.prompts || [], oai_settings.prompt_order || [])) });
    }
    if (apiType === 'text') {
        updatePromptRecipe(recipe.id, { transport: captureTextTransport(power_user) });
    }
    state.nativeSignature = signature;
    if (recipe.id === state.selectedRecipeId) state.requestRender();
}

function getNativeSignature(mode, apiType) {
    if (mode === 'roleplay' && apiType === 'chat') {
        return stableStringify({ prompts: oai_settings.prompts || [], order: oai_settings.prompt_order || [] });
    }
    if (apiType === 'text') return stableStringify(captureTextTransport(power_user));
    return `${mode}:${apiType}`;
}

function compileRoleplayTextRecipe(recipe, nativeContext) {
    const parts = [];
    for (const block of recipe.blocks || []) {
        if (!block.enabled) continue;
        if (parseWholeRecipeMacro(recipe, block.content || '')?.key === 'nativeContext') {
            parts.push(nativeContext);
            continue;
        }
        if (!block.content.trim()) continue;
        const content = substituteParams(block.content);
        parts.push(formatTextMessage(block.role, content));
    }
    return parts.join('');
}

function formatTextMessage(role, content) {
    if (!power_user.instruct?.enabled) {
        const label = role === 'assistant' ? name2 : role === 'user' ? name1 : 'System';
        return `\n${label}: ${content}\n`;
    }
    const isUser = role === 'user';
    const isNarrator = role === 'system' || role === 'instruction';
    const name = isUser ? name1 : role === 'assistant' ? name2 : '';
    return formatInstructModeChat(name, content, isUser, isNarrator, '', name1, name2, false);
}

function getFilteredRecipes() {
    const query = state.search.trim().toLowerCase();
    return getPromptRecipes({ mode: state.mode, apiType: state.apiType })
        .filter((recipe) => !query || `${recipe.name} ${recipe.description}`.toLowerCase().includes(query));
}

function ensureSelectedRecipe(force = false) {
    const selected = getPromptRecipe(state.selectedRecipeId);
    if (!force && selected?.mode === state.mode && selected?.apiType === state.apiType) return;
    state.selectedRecipeId = getActivePromptRecipe(state.mode, state.apiType)?.id
        || getPromptRecipes({ mode: state.mode, apiType: state.apiType })[0]?.id
        || null;
}

function getAvailableTemplates(recipe) {
    return getSourceDefinitions(recipe)
        .filter((source) => !source.textOnly || recipe.apiType === 'text')
        .filter((source) => recipe.apiType !== 'text' || recipe.mode !== 'roleplay' || source.key === 'nativeContext');
}

function getSourceDefinitions(recipe) {
    return PROMPT_TEMPLATE_DEFINITIONS[recipe?.mode] || [];
}

function getSourceDefinition(recipe, key) {
    return getSourceDefinitions(recipe).find((source) => source.key === key) || null;
}

function getSourceLabel(recipe, key) {
    return getSourceDefinition(recipe, key)?.label || key;
}

function sourceDescription(recipe, key) {
    const mode = recipe?.mode;
    if (key === 'nativeContext') return 'SillyTavern’s complete token-budgeted Roleplay prompt, including character, World Info, examples, history, and current turn.';
    // A source definition may declare its own description; that always wins
    // over the per-mode fallback maps below. Without this, a new source key
    // silently inherits whatever the current mode's default text claims —
    // which is how the loom-mode fix below (and loomNotes, which
    // declares one) each had to happen in the first place.
    const declaredDescription = getSourceDefinition(recipe, key)?.description;
    if (declaredDescription) return declaredDescription;
    // A Loom recipe never touches the native prompt manager — it is
    // compiled to an explicit message array and sent on its own. Falling
    // through to the roleplay default below told the user the exact opposite.
    if (mode === 'loom') {
        return 'Resolved by Remodel from the active Roleplay turn and sent directly to the Loom.';
    }
    if (mode === 'story') {
        if (key === 'worldInfoExamples') return 'Lorebook entries using Example placement, resolved by the active Story document immediately before generation.';
        if (key === 'worldInfoDepth') return 'Lorebook depth injections with their configured Chat Completion roles, resolved by the active Story document.';
        return 'Resolved from the active Story document and its bound SillyTavern context immediately before generation.';
    }
    const descriptions = {
        worldInfoBefore: 'World Info entries activated before the character and scenario portions of the active Roleplay prompt.',
        worldInfoAfter: 'World Info entries activated after the character and scenario portions of the active Roleplay prompt.',
        personaDescription: 'The description of the persona currently speaking as the user.',
        charDescription: 'The Description field from the character card bound to the active Roleplay scene.',
        charPersonality: 'The Personality field from the character card bound to the active Roleplay scene.',
        scenario: 'The Scenario field from the character card bound to the active Roleplay scene.',
        dialogueExamples: 'Example Dialogue from the bound character card, formatted by SillyTavern at generation time.',
        storyGoals: 'The active Scene’s public and private Goals, framed as pressures that the latest action may help, obstruct, or defeat.',
        narratorGrounding: 'The current Narrator-visible Loom Archive and provisional open thread, resolved when the native Narrator request is assembled.',
        chatHistory: 'The token-budgeted messages from the active Roleplay conversation, including the newest user turn.',
        currentInput: 'The newest user message, carried through SillyTavern’s native Chat History marker.',
        generationNudge: 'The generation-specific quiet prompt or nudge supplied by SillyTavern for the current request.',
    };
    return descriptions[key] || 'Resolved by SillyTavern’s native Roleplay prompt manager immediately before generation.';
}

function canOpenSource(key) {
    return [
        'characterCard',
        'charDescription',
        'charPersonality',
        'scenario',
        'persona',
        'personaDescription',
        'worldInfoBefore',
        'worldInfoAfter',
        'worldInfoExamples',
        'worldInfoDepth',
        'dialogueExamples',
        'chatHistory',
        'currentInput',
        'storyGoals',
        'authorGuidance',
        'priorText',
        'manuscript',
    ].includes(key);
}

function sourceBindingNote(recipe, block) {
    if (block.sourceKey === 'nativeContext') {
        return 'Required assembly point · preserves SillyTavern’s token-budgeted Text Completion context';
    }
    if (recipe.mode === 'roleplay' && recipe.apiType === 'chat' && block.nativeIdentifier && block.locked) {
        return 'Core marker · reorder freely; it cannot be deleted because SillyTavern’s Chat Completion assembly resolves it by name';
    }
    if (block.locked) return 'Protected linked source';
    return '';
}

function replaceObject(target, source) {
    if (!target || typeof target !== 'object') return;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(source || {}));
}

function setPath(target, path, value) {
    const keys = String(path).split('.');
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]] ??= {};
    cursor[keys[keys.length - 1]] = value;
}

function stableStringify(value) {
    return JSON.stringify(sortObject(value));
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = sortObject(value[key]);
        return result;
    }, {});
}

function normalizeMode(mode) {
    return mode === 'story' ? 'story' : 'roleplay';
}

function capitalize(value) {
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}
