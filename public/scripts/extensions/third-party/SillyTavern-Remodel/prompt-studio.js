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
    PROMPT_SOURCE_DEFINITIONS,
    captureTextTransport,
    clonePromptRecipe,
    createBlocksFromNativeChat,
    createPromptBlock,
    createPromptRecipe,
    deletePromptRecipe,
    getActivePromptRecipe,
    getPromptRecipe,
    getPromptRecipes,
    initializePromptStudioStore,
    isPromptRecipeActive,
    setActivePromptRecipe,
    updatePromptRecipe,
} from './prompt-studio-store.js';

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
 * Director recipes must never be: they are compiled by Remodel for the hidden
 * directing call. Applying one to native would make the performing character
 * generate while reading directing instructions.
 */
export function isNativeApplicableMode(mode) {
    return mode === 'roleplay' || mode === 'story';
}

/** The active Director recipe, or null when none is configured. */
export function resolveDirectorRecipe() {
    const recipe = getActivePromptRecipe('director', 'chat');
    return recipe && recipe.mode === 'director' ? recipe : null;
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
 * paragraph is gone. The default Director recipe's five blocks arrive as two
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
 * tests/remodel-director-preview-trace.test.js and again, end to end, by
 * tests/remodel-director-preview-parity.test.js (the preview side asks for a
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
            parts.push(appendMessage(block.role, block.content || ''));
        } else {
            const provided = sources[block.sourceKey];
            // A source may resolve lazily from the block's own settings (e.g.
            // directorNotes' `depth`) instead of a flat value the caller
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
    return {
        blockId: block.id || null,
        kind: block.kind,
        sourceKey: block.kind === 'source' ? block.sourceKey || null : null,
        label: block.kind === 'source' ? getSourceLabel(recipe, block.sourceKey) : 'Authored message',
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

/** Attaches the trace only when the caller asked for it; never touches `messages`. */
function withPromptTrace(compiled, traceEntries, wanted) {
    return wanted ? { ...compiled, trace: traceEntries } : compiled;
}

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
                    <button type="button" class="remodel-prompt-icon-button" data-remodel-prompt-create title="New prompt" aria-label="New prompt">
                        <i class="fa-solid fa-plus" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="remodel-prompt-matrix" aria-label="Prompt category">
                    ${renderFilterGroup('mode', PROMPT_MODES, state.mode, 'Mode')}
                    ${renderFilterGroup('api', PROMPT_API_TYPES, state.apiType, 'Transport', state.mode === 'director'
                        ? { text: 'Director recipes are Chat Completion only' }
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
    const availableSources = getAvailableSources(recipe);
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
                <p>Messages are sent from top to bottom. Linked sources resolve when a request is assembled.</p>
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
                    <span>Linked context</span>
                    <select data-remodel-prompt-add-source>
                        ${availableSources.map((source) => `<option value="${escapeAttribute(source.key)}">${escapeHtml(source.label)}</option>`).join('')}
                    </select>
                </label>
                <button type="button" data-remodel-prompt-add-context ${availableSources.length ? '' : 'disabled'}><i class="fa-solid fa-link"></i> Add context</button>
            </div>
            ${recipe.apiType === 'text' ? renderTransportEditor(recipe) : ''}
        </div>
    `;
}

function renderPromptBlock(recipe, block, index) {
    const source = block.kind === 'source' ? getSourceDefinition(recipe, block.sourceKey) : null;
    const bindingNote = sourceBindingNote(recipe, block);
    const movable = canMoveBlock(recipe, block);
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
                    <span class="remodel-prompt-block-kind">${block.kind === 'source' ? '<i class="fa-solid fa-link"></i> Live source' : '<i class="fa-regular fa-message"></i> Authored message'}</span>
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
                    : `<textarea data-remodel-prompt-block-content placeholder="Write the ${escapeAttribute(roleLabels[block.role].toLowerCase())} message…">${escapeHtml(block.content)}</textarea>`}
            </div>
        </article>
    `;
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
                // Director recipes are Chat Completion only (enforced in the
                // data model — see normalizeRecipe in prompt-studio-store.js).
                // Switching into director mode while the Transport filter is
                // still on 'text' would leave it pointing at a filter
                // combination with no matching recipes, so pull it back to
                // 'chat' the same way the data model would.
                if (state.mode === 'director' && state.apiType === 'text') state.apiType = 'chat';
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
        if (target.closest('[data-remodel-prompt-add-context]')) {
            const sourceKey = studio.querySelector('[data-remodel-prompt-add-source]')?.value;
            const source = getSourceDefinition(recipe, sourceKey);
            if (source) patchRecipeBlocks(recipe, [...recipe.blocks, createPromptBlock({ kind: 'source', role: source.role, sourceKey, locked: source.locked })]);
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
        if (!card || !recipe || !target.matches('[data-remodel-prompt-block-role]')) return;
        const block = recipe.blocks.find((item) => item.id === card.dataset.remodelPromptBlock);
        if (!block || !PROMPT_ROLES.includes(target.value)) return;
        block.role = target.value;
        patchRecipeBlocks(recipe, recipe.blocks);
    }, true);

    document.addEventListener('dragstart', (event) => {
        const card = event.target instanceof Element ? event.target.closest('[data-remodel-prompt-block]') : null;
        if (!card || card.getAttribute('draggable') !== 'true') return;
        state.dragBlockId = card.dataset.remodelPromptBlock;
        card.classList.add('is-dragging');
    });
    document.addEventListener('dragover', (event) => {
        if (!state.dragBlockId || !(event.target instanceof Element) || !event.target.closest('.remodel-prompt-studio')) return;
        if (event.target.closest('[data-remodel-prompt-block]')) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
        const targetCard = event.target instanceof Element ? event.target.closest('[data-remodel-prompt-block]') : null;
        const recipe = getPromptRecipe(state.selectedRecipeId);
        if (!targetCard || !recipe || !state.dragBlockId) return;
        event.preventDefault();
        const from = recipe.blocks.findIndex((block) => block.id === state.dragBlockId);
        const to = recipe.blocks.findIndex((block) => block.id === targetCard.dataset.remodelPromptBlock);
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
    updatePromptRecipe(recipe.id, { blocks });
    onRecipeChanged(recipe);
    state.requestRender();
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
    // so this is where the director/native split holds even for a call site
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

function applyRoleplayChatRecipe(recipe) {
    oai_settings.prompts ??= [];
    oai_settings.prompt_order ??= [];
    const promptMap = new Map(oai_settings.prompts.filter(Boolean).map((prompt) => [prompt.identifier, prompt]));
    const order = [];
    for (const block of recipe.blocks || []) {
        const source = block.kind === 'source' ? getSourceDefinition({ mode: 'roleplay' }, block.sourceKey) : null;
        const identifier = block.nativeIdentifier || source?.nativeIdentifier || `remodel-${block.id}`;
        block.nativeIdentifier = identifier;
        let prompt = promptMap.get(identifier);
        if (!prompt) {
            prompt = { identifier };
            oai_settings.prompts.push(prompt);
            promptMap.set(identifier, prompt);
        }
        if (block.kind === 'source') {
            prompt.name = source?.label || block.sourceKey;
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
    }
    let globalOrder = oai_settings.prompt_order.find((entry) => String(entry.character_id) === String(CHAT_PROMPT_ORDER_ID));
    if (!globalOrder) {
        globalOrder = { character_id: CHAT_PROMPT_ORDER_ID, order: [] };
        oai_settings.prompt_order.push(globalOrder);
    }
    globalOrder.order = order;
    promptManager?.render?.(false);
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
        updatePromptRecipe(recipe.id, { blocks: createBlocksFromNativeChat(oai_settings.prompts || [], oai_settings.prompt_order || []) });
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
        if (block.kind === 'source' && block.sourceKey === 'nativeContext') {
            parts.push(nativeContext);
            continue;
        }
        if (block.kind !== 'message' || !block.content.trim()) continue;
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

function getAvailableSources(recipe) {
    const existing = new Set((recipe.blocks || []).filter((block) => block.kind === 'source').map((block) => block.sourceKey));
    const existingNativeIdentifiers = new Set((recipe.blocks || [])
        .filter((block) => block.kind === 'source')
        .map((block) => block.nativeIdentifier || getSourceDefinition(recipe, block.sourceKey)?.nativeIdentifier)
        .filter(Boolean));
    return getSourceDefinitions(recipe)
        .filter((source) => !source.textOnly || recipe.apiType === 'text')
        .filter((source) => recipe.apiType !== 'text' || recipe.mode !== 'roleplay' || source.key === 'nativeContext')
        .filter((source) => !existing.has(source.key))
        .filter((source) => !source.nativeIdentifier || !existingNativeIdentifiers.has(source.nativeIdentifier));
}

function getSourceDefinitions(recipe) {
    return PROMPT_SOURCE_DEFINITIONS[recipe?.mode] || [];
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
    // which is how the director-mode fix below (and directorNotes, which
    // declares one) each had to happen in the first place.
    const declaredDescription = getSourceDefinition(recipe, key)?.description;
    if (declaredDescription) return declaredDescription;
    // A Director recipe never touches the native prompt manager — it is
    // compiled to an explicit message array and sent on its own. Falling
    // through to the roleplay default below told the user the exact opposite.
    if (mode === 'director') {
        const director = {
            directionProtocol: 'The reply contract the hidden Director must satisfy. Locked: without it the reply cannot be parsed and Remodel falls back to a built-in prompt.',
            directorCard: 'The character card bound as this Scene’s Director, read as judgment, priorities and genre sense — never spoken as dialogue.',
            mechanicsSkill: 'The Goals and Variables addressable this turn, by name, with the capabilities that may be requested against them. Remove this and the Director stops seeing any persistent state.',
            directorSnapshot: 'The Scene, cast, persona, accepted history, activated World Info and recent mechanical receipts assembled for this pass.',
        };
        return director[key] || 'Assembled by Remodel and sent directly to the Director, without the native prompt manager.';
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
        storyGoals: 'The active Scene’s public goals plus private NPC instructions and the latest resolved Goal events.',
        directorNotes: 'The hidden Director’s recent notes for this Scene, rendered by Remodel and mirrored into the native Roleplay prompt at this position. Never includes a secret entry.',
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
