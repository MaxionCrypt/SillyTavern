import { getContext } from '../../../st-context.js';
import {
    doNavbarIconClick,
    doNewChat,
    getPastCharacterChats,
    select_selected_character as selectCharacterForEditingOnly,
    setCharacterId,
} from '../../../../script.js';
import { openGroupById } from '../../../group-chats.js';
import { setUserAvatar } from '../../../personas.js';
import { MacroRegistry, MacroCategory, MacroValueType } from '../../../macros/engine/MacroRegistry.js';
import {
    CHAT_METADATA_KEY,
    createArc,
    createScene,
    createTimeline,
    deleteArc,
    deleteInsertedTextSlot,
    deleteScene,
    deleteTimeline,
    getScene,
    getSceneFromMetadata,
    getTimelineStore,
    setActiveScene,
    setActiveTimeline,
    setInsertedTextSlot,
    updateArc,
    updateScene,
    updateTimeline,
} from './timeline-state.js';
import {
    createStoryDoc,
    getStoryDoc,
    updateStoryDoc,
} from './story-doc.js';
import {
    applyPromptStudioRuntimeRecipe,
    capturePromptStudioRuntimeSettings,
    compilePromptRecipe,
    formatPromptStudioPreview,
    getCurrentPromptStudioRecipe,
    getDefaultPromptStudioRecipe,
    getPromptApiType,
    getPromptStudioRecipe,
    getPromptStudioRecipes,
    initPromptStudio,
    renderPromptStudioWorkspace,
    syncPromptStudioForCurrentMode,
} from './prompt-studio.js';
import {
    advanceWizardToPersonaStep,
    armGenerationWatchdog,
    armSceneSummarySaveDebounce,
    beginOwnedGenerationRun,
    beginWizard,
    clearGenerationWatchdog,
    clearSceneSummarySaveDebounce,
    consumeWizardFlow,
    endOwnedGenerationRun,
    getGenerationState,
    getOriginalPanelHomes,
    getPanelsState,
    getSessionState,
    getWizardState,
    isGenerationRunOurs,
    isPastChatsBridgeActive,
    noteViewingCharacterForPastChats,
    resetAllChatScopedState,
    resetWizardState,
    restorePastChatsBridge,
    setActiveTavernTab,
    setAdoptedPanel,
    setAutoContinueStatus,
    setAutoContinueTurnIsFirst,
    setCharacterSearchQuery,
    setCharacterSortMode,
    setCreateModalDraft,
    setCreateModalOpen,
    setCurrentWindow,
    setFocusedTimelineId,
    setGenerating,
    setInitialized,
    setPromptPreviewInFlight,
    setRenamingSceneId,
    setRenderQueued,
    setSuppressDrawerObserver,
    setTavernPanelObserver,
} from './session-state.js';

const DRAWER_ID = 'remodel-timeline-drawer';
const PANEL_ID = 'remodel-timeline-panel';
const CONTENT_ID = 'remodel-timeline-content';
const LEGACY_OUTLET_ID = 'remodel-tavern-legacy-outlet';
const TAVERN_TABS = [
    {
        id: 'timeline',
        label: 'Timelines',
        icon: 'fa-diagram-project',
    },
    {
        id: 'characters',
        label: 'Characters',
        icon: 'fa-address-card',
    },
    {
        id: 'prompts',
        label: 'Prompts',
        icon: 'fa-wand-magic-sparkles',
    },
    {
        id: 'personas',
        label: 'Personas',
        icon: 'fa-face-smile',
        panelId: 'PersonaManagement',
    },
    {
        id: 'lorebooks',
        label: 'Lorebooks',
        icon: 'fa-book-atlas',
        panelId: 'WorldInfo',
    },
];

// Session / UI-navigation state (initialized, renderQueued, activeTavernTab,
// focusedTimelineId, createModalOpen/Draft, characterSearchQuery/SortMode,
// renamingSceneId, adoptedPanel, tavernPanelObserver, originalPanelHomes,
// currentWindow, suppressDrawerObserver) now lives in session-state.js's
// session domain — see getSessionState()/getOriginalPanelHomes() and the
// action functions imported above. currentWindow: { kind: 'native' } (plain
// ST chat, Tavern drawer closed) or { kind: 'tavern', tab } (Tavern open,
// showing Tab `tab`) — only transitionToWindow() may call setCurrentWindow().

// Guided Story-Scene creation wizard state now lives in session-state.js's
// wizard domain — see getWizardState()/beginWizard()/advanceWizardToPersonaStep()/
// consumeWizardFlow() imported above.

// Character-viewing / past-chats bridge state now lives in session-state.js's
// pastChatsBridge domain — see getPastChatsBridgeState()/isPastChatsBridgeActive()/
// noteViewingCharacterForPastChats()/restorePastChatsBridge() imported above.

// Story auto-continue loop state and story-generation tracking (isGenerating,
// runIsOurs, watchdog, autoContinue, autoContinueTurnIsFirst) now live in
// session-state.js's generation domain — see getGenerationState() and the
// action functions imported above.

export function initTimelineSpine({ onDrawerReady } = {}) {
    if (getSessionState().initialized) {
        return;
    }

    const drawer = ensureTimelineDrawer();
    bindDrawerToggle(drawer);
    bindTimelineEvents(drawer);
    bindSillyTavernEvents();
    bindStoryLockInterceptor();
    observeTavernPanelState();
    bindExternalSidebarWindowSwitch();
    bindStoryEditorEvents();
    bindRoleplayComposerEvents();
    bindRoleplayGenerationFeedback();
    bindRoleplayCastPickerEvents();
    bindRoleplayCastDragEvents();
    registerSceneMacros();
    registerCharacterFieldMacro();
    registerAllInsertedTextSlotMacros();
    ensureCharacterEditorCancelButton();
    initPromptStudio({
        requestRender: queueRender,
        getRuntimeMode: () => isRealStoryDocSceneActive() ? 'story' : 'roleplay',
        getRuntimeRecipeId: (mode, apiType) => {
            const scene = getActiveScene();
            return scene?.mode === mode ? scene.promptRecipeIds?.[apiType] || null : null;
        },
        isRecipeInUse: (recipeId) => Object.values(getTimelineStore().scenes)
            .some((scene) => Object.values(scene.promptRecipeIds || {}).includes(recipeId)),
        previewRecipe: previewPromptStudioRecipe,
        openSource: openPromptStudioSource,
    });
    setInitialized(true);

    // Belt-and-suspenders: Remodel's own init isn't guaranteed to run before
    // core's one-shot APP_READY event fires, so establish the correct state
    // synchronously here too rather than relying solely on the next event.
    syncNoChatComposerVisibility();

    onDrawerReady?.(drawer);
    renderTimelinePanel();
}

function ensureTimelineDrawer() {
    const existingDrawer = document.getElementById(DRAWER_ID);

    if (existingDrawer) {
        return existingDrawer;
    }

    const drawer = document.createElement('div');
    drawer.id = DRAWER_ID;
    drawer.className = 'drawer';
    drawer.innerHTML = `
        <div class="drawer-toggle" tabindex="0" role="button" aria-label="Open Tavern">
            <div class="drawer-icon fa-solid fa-beer-mug-empty fa-fw closedIcon drawerPinnedOpen" title="Tavern"></div>
        </div>
        <div id="${PANEL_ID}" class="drawer-content closedDrawer pinnedOpen remodel-timeline-drawer-content">
            <div id="${CONTENT_ID}" class="remodel-timeline-content"></div>
        </div>
    `;

    const holder = document.getElementById('top-settings-holder');
    const firstDrawer = holder?.querySelector(':scope > .drawer');

    if (firstDrawer) {
        firstDrawer.before(drawer);
    } else {
        holder?.append(drawer);
    }

    return drawer;
}

function bindDrawerToggle(drawer) {
    const toggle = drawer.querySelector(':scope > .drawer-toggle');

    const handleToggle = async (event) => {
        event.preventDefault();
        await transitionToWindow(getSessionState().currentWindow.kind === 'native' ? { kind: 'tavern' } : { kind: 'native' });
    };

    toggle?.addEventListener('click', handleToggle);

    toggle?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        await handleToggle(event);
    });
}

// The only function allowed to change currentWindow. Owns native-drawer
// convergence, body-state classes, and adopted-DOM teardown for whichever
// Window is being left, so every entry point (drawer toggle, Tab clicks,
// Scene open/close) goes through one place instead of each hand-rolling it.
async function transitionToWindow(next) {
    if (next.kind === 'tavern' && !next.tab) {
        next = { ...next, tab: getSessionState().activeTavernTab }; // omitted tab = keep whatever was active
    }

    if (next.kind !== 'tavern') {
        restoreAdoptedPanel(); // no-ops if nothing is adopted
    }

    // Commit before the possibly-awaited drawer call below, so a caller that
    // doesn't await us (renderTimelinePanel's self-heal) sees consistent
    // state immediately rather than mid-transition.
    document.body.classList.toggle('remodel-tavern-active', next.kind !== 'native');

    if (next.kind === 'tavern') {
        setActiveTavernTab(next.tab);
    }

    setCurrentWindow(next);
    queueRender();

    const desiredDrawerOpen = next.kind !== 'native';
    const panel = document.getElementById(PANEL_ID);
    const isDrawerOpen = panel?.classList.contains('openDrawer') ?? false;

    if (desiredDrawerOpen !== isDrawerOpen) {
        const toggle = document.querySelector(`#${DRAWER_ID} > .drawer-toggle`);

        if (toggle) {
            setSuppressDrawerObserver(true);

            try {
                await doNavbarIconClick.call(toggle);
            } finally {
                setSuppressDrawerObserver(false);
            }
        }
    }

    // Core closes every other .drawer-content while opening Tavern. If the
    // render happened before that sweep, the adopted native workspace is one
    // of those descendants; restore its visible state after the sweep without
    // replacing the native node or any of its listeners.
    if (next.kind === 'tavern') {
        const { adoptedPanel } = getSessionState();
        adoptedPanel?.classList.add('openDrawer');
        adoptedPanel?.classList.remove('closedDrawer');
    }
}

// SillyTavern's own doNavbarIconClick closes every other unpinned open drawer
// whenever a *different* drawer opens — clicking any other native sidebar
// icon while Tavern/Story is open closes ours natively, with no involvement
// from our own code. This reconciles currentWindow when that happens.
function reconcileExternalDrawerClose() {
    if (getSessionState().suppressDrawerObserver) {
        return; // this mutation is ours — transitionToWindow is mid-flight
    }

    const panel = document.getElementById(PANEL_ID);
    const isOpen = panel?.classList.contains('openDrawer') ?? false;

    if (!isOpen && getSessionState().currentWindow.kind !== 'native') {
        transitionToWindow({ kind: 'native' });
    }
}

function observeTavernPanelState() {
    if (getSessionState().tavernPanelObserver) {
        return;
    }

    const panel = document.getElementById(PANEL_ID);

    if (!panel) {
        return;
    }

    const observer = new MutationObserver(reconcileExternalDrawerClose);
    observer.observe(panel, {
        attributes: true,
        attributeFilter: ['class'],
    });
    setTavernPanelObserver(observer);
    reconcileExternalDrawerClose();
}

// Tavern is intentionally pinned, so core does not include it in the normal
// "close other unpinned drawers" sweep. Treat every other native sidebar
// drawer toggle as a window switch: close Tavern synchronously before core's
// own handler opens the requested drawer.
function bindExternalSidebarWindowSwitch() {
    document.addEventListener('click', (event) => {
        if (getSessionState().currentWindow.kind !== 'tavern') return;
        const toggle = event.target instanceof Element
            ? event.target.closest('#top-settings-holder > .drawer > .drawer-toggle')
            : null;
        if (!toggle || toggle.closest(`#${DRAWER_ID}`)) return;
        transitionToWindow({ kind: 'native' });
    }, true);
}

function bindTimelineEvents(drawer) {
    drawer.addEventListener('click', async (event) => {
        const tavernTab = event.target instanceof Element
            ? event.target.closest('[data-remodel-tavern-tab]')
            : null;

        if (tavernTab) {
            event.preventDefault();
            event.stopPropagation();
            await transitionToWindow({ kind: 'tavern', tab: tavernTab.dataset.remodelTavernTab || 'timeline' });
            return;
        }

        const lorebooksPanelToggle = event.target instanceof Element
            ? event.target.closest('[data-remodel-lorebooks-panel]')
            : null;

        if (lorebooksPanelToggle) {
            event.preventDefault();
            event.stopPropagation();
            toggleLorebooksUtilityPanel(lorebooksPanelToggle.dataset.remodelLorebooksPanel);
            return;
        }

        const characterActionElement = event.target instanceof Element
            ? event.target.closest('[data-remodel-character-action]')
            : null;

        if (characterActionElement) {
            event.preventDefault();
            event.stopPropagation();
            await handleCharacterAction(characterActionElement);
            return;
        }

        const actionElement = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-action]')
            : null;

        if (!actionElement) {
            return;
        }

        const clickedInsideModalCard = event.target instanceof Element
            ? event.target.closest('[data-remodel-modal-stop]')
            : null;

        if (actionElement.classList.contains('remodel-modal-scrim') && clickedInsideModalCard) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        await handleAction(actionElement);
    }, true);

    drawer.addEventListener('input', (event) => {
        const field = event.target instanceof Element
            ? event.target.closest('[data-remodel-character-field]')
            : null;

        if (!field || field.dataset.remodelCharacterField !== 'search') {
            return;
        }

        setCharacterSearchQuery(field.value || '');
        queueRender();
    });

    drawer.addEventListener('change', async (event) => {
        const photoInput = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-photo-input]')
            : null;

        if (photoInput) {
            await handlePhotoChange(photoInput);
            return;
        }

        const characterField = event.target instanceof Element
            ? event.target.closest('[data-remodel-character-field]')
            : null;

        if (characterField) {
            handleCharacterFieldChange(characterField);
            return;
        }

        const field = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-field]')
            : null;

        if (!field) {
            return;
        }

        await handleFieldChange(field);
    });

    drawer.addEventListener('focusout', (event) => {
        const input = event.target instanceof Element
            ? event.target.closest('.remodel-scene-rename-input')
            : null;

        if (!input) {
            return;
        }

        const sceneId = input.dataset.sceneId;

        if (getSessionState().renamingSceneId !== sceneId) {
            return;
        }

        const value = input.value.trim();

        if (value) {
            updateScene(sceneId, { title: value });
        }

        setRenamingSceneId(null);
        queueRender();
    });

    drawer.addEventListener('keydown', (event) => {
        if (event.target instanceof Element && event.target.classList.contains('remodel-scene-rename-input')) {
            if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault();
                event.target.blur();
            }
            return;
        }

        if (event.key === 'Escape' && getSessionState().createModalOpen) {
            setCreateModalOpen(false);
            queueRender();
            return;
        }

        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        const actionable = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-action][role="button"]')
            : null;

        if (!actionable) {
            return;
        }

        event.preventDefault();
        actionable.click();
    });
}

function bindSillyTavernEvents() {
    const context = getContext();

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, syncActiveSceneFromChatMetadata);
    context.eventSource.on(context.eventTypes.CHAT_LOADED, syncActiveSceneFromChatMetadata);
    context.eventSource.on(context.eventTypes.PERSONA_CHANGED, handlePersonaChangedDuringCreation);
    context.eventSource.on(context.eventTypes.USER_MESSAGE_RENDERED, handleStoryUserMessageRendered);
    // Confirmed as a real bug via live testing: an AI-authored message
    // arriving (addOneMessage, the same low-level insertion core's own
    // generate() pipeline ultimately uses) never triggered a manuscript
    // overlay rebuild — only USER_MESSAGE_RENDERED did. The overlay would
    // silently never show newly-generated prose at all without this.
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, handleStoryAiMessageReceived);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, syncNoChatComposerVisibility);
    context.eventSource.on(context.eventTypes.CHAT_LOADED, syncNoChatComposerVisibility);
    context.eventSource.on(context.eventTypes.APP_READY, syncNoChatComposerVisibility);
    context.eventSource.on(context.eventTypes.MAIN_API_CHANGED, refreshScenePromptChoice);
}

function refreshScenePromptChoice() {
    if (isRealStoryDocSceneActive()) {
        renderStoryEditor();
        return;
    }
    if (isRealRoleplayWorkspaceActive()) {
        const root = getRealRoleplayRoot();
        if (root) renderRoleplayComposer(root);
    }
}

// Core's own #form_sheld (composer bar, including the #options_button
// hamburger) is supposed to stay hidden whenever no chat is loaded — normally
// via a CSS rule keyed on core's .welcomePanel already existing inside #chat.
// But core's openWelcomeScreen() (welcome-screen.js) is async and awaits a
// network/storage fetch BEFORE inserting .welcomePanel, so during that gap
// the CSS rule doesn't match yet and the composer (hamburger included) briefly
// renders, squeezed toward the top of the fixed #sheld panel since #chat is
// still empty/collapsed. context.chatId is derived synchronously the same
// way core's own getCurrentChatId() is, with no dependency on that awaited
// fetch or on .welcomePanel's DOM insertion — sidesteps the race entirely
// rather than trying to win it.
function syncNoChatComposerVisibility() {
    const hasChat = Boolean(getContext().chatId);
    document.body.classList.toggle('remodel-no-chat-active', !hasChat);
}

// --- Story Scene locking -----------------------------------------------

// Single accessor for "which Scene is the currently loaded chat bound to" —
// every call site reads live (no caching), so this is a pure dedup of what
// was 9 independent copies of the same expression, not a behavior change.
function getActiveScene() {
    return getSceneFromMetadata(getContext().chatMetadata?.[CHAT_METADATA_KEY]);
}

function isActiveChatLockedStoryScene() {
    const scene = getActiveScene();
    return Boolean(scene && scene.mode === 'story' && scene.linkedChat);
}

// Single capturing-phase click listener, consolidated for maintainability:
// neutralizes native character/persona switching while a Story Scene is
// locked, and drives the repurposed Play/Pause/Stop auto-continue controls
// while the story workspace is active. Capture always runs before bubbling
// delegated handlers (a DOM-spec guarantee), so stopImmediatePropagation()
// here reliably prevents the native .character_select / persona-avatar click
// handlers from ever running — no monkey-patching of core code needed.
function bindStoryLockInterceptor() {
    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;

        if (target?.closest('#remodel-character-editor-cancel')) {
            event.preventDefault();
            // Primary teardown for the viewing-only bridge (session-state.js):
            // restores this_chid to whatever it held before browsing started
            // (a real active character, or nothing), rather than just
            // clearing it. Note: core's native "Manage chat files" popup
            // (#option_select_chat/#select_chat_cross) no longer needs its
            // own hooks here — the bridge is eager now, so this_chid is
            // already correctly set to the viewed character for the whole
            // time the editor is open, well before that popup could ever be
            // clicked. Closing that popup must NOT tear the bridge down
            // either, since the editor itself (not the popup) owns its
            // lifetime and is very likely still open behind it.
            restorePastChatsBridge(setCharacterId);
            clickVanillaControl('rm_button_characters');
            return;
        }

        if (target?.closest('[data-remodel-guided-cancel]')) {
            event.preventDefault();
            cancelStoryGuidedCreation();
            return;
        }

        // handlePersonaChangedDuringCreation (below) advances the wizard by
        // listening for the native PERSONA_CHANGED event — but that event
        // only fires when the persona actually CHANGES. Clicking the persona
        // that's already active is a no-op as far as core is concerned (no
        // event fires), so the wizard would otherwise never advance —
        // confirmed as a real reported bug. Detected directly here (the
        // avatar already carries core's own 'selected' class,
        // personas.js:1463) since we can't rely on any event for this case.
        if (getWizardState().sceneCreationFlow?.step === 'choose-persona') {
            const clickedAvatar = target?.closest('#user_avatar_block .avatar-container');
            if (clickedAvatar?.classList.contains('selected')) {
                event.preventDefault();
                finishStoryGuidedCreation();
                return;
            }
        }

        if (target && isRealStoryWorkspaceActive()) {
            const continueButton = target.closest('#stscript_continue');
            if (continueButton) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!isStoryButtonDisabled(continueButton)) {
                    startStoryAutoContinue();
                }
                return;
            }

            const pauseButton = target.closest('#stscript_pause');
            if (pauseButton) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!isStoryButtonDisabled(pauseButton)) {
                    pauseStoryAutoContinue();
                }
                return;
            }

            const stopButton = target.closest('#stscript_stop');
            if (stopButton) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!isStoryButtonDisabled(stopButton)) {
                    stopStoryAutoContinue();
                }
                return;
            }

            const addUserMessageButton = target.closest('#remodel-add-user-message');
            if (addUserMessageButton) {
                event.preventDefault();
                if (!isStoryButtonDisabled(addUserMessageButton)) {
                    openStoryComposer();
                }
                return;
            }

            const cancelMessageButton = target.closest('#remodel-cancel-user-message');
            if (cancelMessageButton) {
                event.preventDefault();
                closeStoryComposer({ clearDraft: true });
                return;
            }

            const summaryToggle = target.closest('[data-remodel-summary-toggle]');
            if (summaryToggle) {
                event.preventDefault();
                toggleSceneSummaryPanel();
                return;
            }

            const summaryGenerateButton = target.closest('[data-remodel-summary-generate]');
            if (summaryGenerateButton) {
                event.preventDefault();
                handleSummarizeSceneClick();
                return;
            }

            const priorTextToggle = target.closest('[data-remodel-priortext-toggle]');
            if (priorTextToggle) {
                event.preventDefault();
                togglePriorTextPanel();
                return;
            }

            const priorTextLoadPreviewButton = target.closest('[data-remodel-priortext-loadpreview]');
            if (priorTextLoadPreviewButton) {
                event.preventDefault();
                handlePriorTextLoadPreview();
                return;
            }

            const priorTextSaveButton = target.closest('[data-remodel-priortext-save]');
            if (priorTextSaveButton) {
                event.preventDefault();
                handlePriorTextSaveSlot();
                return;
            }

            const priorTextSlotReloadButton = target.closest('[data-remodel-priortext-slot-reload]');
            if (priorTextSlotReloadButton) {
                event.preventDefault();
                handlePriorTextSlotReload(priorTextSlotReloadButton.dataset.remodelPriortextSlotReload);
                return;
            }

            const priorTextSlotDeleteButton = target.closest('[data-remodel-priortext-slot-delete]');
            if (priorTextSlotDeleteButton) {
                event.preventDefault();
                handlePriorTextSlotDelete(priorTextSlotDeleteButton.dataset.remodelPriortextSlotDelete);
                return;
            }

            const promptPreviewToggle = target.closest('[data-remodel-promptpreview-toggle]');
            if (promptPreviewToggle) {
                event.preventDefault();
                togglePromptPreviewPanel();
                return;
            }

            const promptPreviewRefreshButton = target.closest('[data-remodel-promptpreview-refresh]');
            if (promptPreviewRefreshButton) {
                event.preventDefault();
                handlePromptPreviewRefreshClick();
                return;
            }

        }

        // Personas have no "view only" mode the way select_selected_character()
        // gives characters (setUserAvatar() always switches the active persona)
        // — but the Personas tab itself must stay freely browsable/editable
        // outside of any chat, so persona clicks are only ever blocked when a
        // Story Scene is actively locked (this chat's character+persona were
        // already fixed at creation time) or mid-wizard for a DIFFERENT scene
        // than the one being chosen for. The guided wizard's own choose-persona
        // step is handled separately via the PERSONA_CHANGED listener
        // (handlePersonaChangedDuringCreation) further below, not here.
        const isNativePersonaAvatar = target?.closest('#user_avatar_block .avatar-container');

        // isActiveChatLockedStoryScene() reads whatever chat is CURRENTLY
        // loaded — which, for the wizard's entire duration, is still whatever
        // chat was open before the user clicked "New Story" (the wizard only
        // switches to the new Scene's own chat at the very end, in
        // finishStoryGuidedCreation). Without this guard, starting a new
        // Scene while a PREVIOUS locked Story Scene's chat is still active in
        // the background falsely reports "this scene's cast is locked" for
        // the brand-new Scene being created — confirmed as a real reported
        // bug. The wizard's own explicit state takes priority over stale
        // leftover chat metadata from whatever was open before it started.
        if (getWizardState().sceneCreationFlow) {
            return;
        }

        if (!isActiveChatLockedStoryScene()) {
            return;
        }

        const isNativeCharacterSelect = target?.closest('.character_select');

        if (!isNativeCharacterSelect && !isNativePersonaAvatar) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        showGuidedPrompt('locked-notice');
    }, true);
}

// Sending an EMPTY "Add User Message" box extends the cut-off AI response
// instead of starting a new Scene Beat — mirrors native ST's own
// continue_on_send convention, but doesn't depend on that (off-by-default,
// global) user setting: this only applies inside the story workspace, driven
// entirely by whether the box is empty at send time. Typing anything and
// sending still starts a new Scene Beat exactly as before.
function bindStoryComposerContinueOnEmptySend() {
    document.addEventListener('keydown', (event) => {
        if (!isRealStoryWorkspaceActive()) {
            return;
        }

        if (event.target !== document.getElementById('send_textarea')) {
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) {
            return; // let Shift/Ctrl/Alt+Enter and IME composition fall through to native handling
        }

        const textarea = /** @type {HTMLTextAreaElement} */ (event.target);
        if (textarea.value !== '') {
            return; // has content — a real new Scene Beat, native send handles it
        }

        const continueButton = document.getElementById('option_continue');
        if (!continueButton || isStoryButtonDisabled(document.getElementById('remodel-add-user-message'))) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        continueButton.click();
        closeStoryComposer();
    }, true);
}

// --- Guided Story Scene creation -----------------------------------------

async function beginStoryGuidedCreation(sceneId) {
    beginWizard(sceneId);
    await transitionToWindow({ kind: 'tavern', tab: 'characters' });
    showGuidedPrompt('choose-character');
}

// Fires on every native persona switch; only acts during the wizard's
// choose-persona step, since setUserAvatar() isn't exposed via getContext()
// and can't be called/gated directly — we let the native click apply the
// persona for real, then react to it here.
function handlePersonaChangedDuringCreation() {
    if (getWizardState().sceneCreationFlow?.step === 'choose-persona') {
        finishStoryGuidedCreation();
    }
}

async function finishStoryGuidedCreation() {
    const { sceneId, chosenCharacterId } = consumeWizardFlow();
    hideGuidedPrompt();

    await getContext().selectCharacterById(chosenCharacterId, { switchMenu: false });
    await createNewChatForScene(sceneId);
    await enterSceneViewport();
}

function cancelStoryGuidedCreation() {
    resetWizardState();
    hideGuidedPrompt();
    transitionToWindow({ kind: 'native' });
}

function showGuidedPrompt(step) {
    hideGuidedPrompt();

    const config = {
        'choose-character': { text: 'Choose who the AI plays', hint: 'Click a character below to cast them in this Story Scene.' },
        'choose-persona': { text: 'Choose who you are', hint: 'Click a persona to play them in this Story Scene.' },
        'locked-notice': { text: 'This Scene’s cast is locked', hint: 'Character and persona can’t change once a Story Scene has started.' },
    }[step];

    if (!config) {
        return;
    }

    const el = document.createElement('div');
    el.id = 'remodel-guided-prompt';
    el.className = 'remodel-guided-prompt';
    el.innerHTML = `
        <div class="remodel-guided-prompt-fleuron" aria-hidden="true"></div>
        <div class="remodel-guided-prompt-text">${escapeHtml(config.text)}</div>
        <div class="remodel-guided-prompt-hint">${escapeHtml(config.hint)}</div>
        ${step !== 'locked-notice' ? '<button type="button" class="remodel-guided-prompt-cancel" data-remodel-guided-cancel>Cancel</button>' : ''}
    `;
    document.body.append(el);

    if (step === 'locked-notice') {
        setTimeout(hideGuidedPrompt, 2200);
    }
}

function hideGuidedPrompt() {
    document.getElementById('remodel-guided-prompt')?.remove();
}

// --- Story auto-continue loop --------------------------------------------

function startStoryAutoContinue() {
    if (getGenerationState().autoContinue.status === 'playing') {
        return;
    }

    setAutoContinueStatus('playing');
    // The FIRST turn of a Play run is a genuinely new AI turn (responding to
    // whatever the user just added) and uses 'normal'. Every turn after that,
    // within the same uninterrupted run, extends that same message via
    // 'continue' instead of starting a new one — so a Play run reads as one
    // continuously-growing block of prose rather than being chopped into a
    // new .mes every time the model hits its token limit mid-sentence.
    setAutoContinueTurnIsFirst(true);
    updateStoryActionBarState();
    triggerNextAutoContinueTurn();
}

function pauseStoryAutoContinue() {
    if (getGenerationState().autoContinue.status !== 'playing') {
        return;
    }

    setAutoContinueStatus('paused'); // in-flight generation finishes naturally
    updateStoryActionBarState();
}

function stopStoryAutoContinue() {
    setAutoContinueStatus('idle');
    setAutoContinueTurnIsFirst(true); // Stop ends the run — the next Play starts a fresh block
    updateStoryActionBarState();
    getContext().stopGeneration(); // aborts an in-flight generation immediately
}

async function triggerNextAutoContinueTurn() {
    if (getGenerationState().autoContinue.status !== 'playing') {
        return;
    }

    if (!isRealStoryWorkspaceActive()) {
        setAutoContinueStatus('idle'); // safety: never loop outside the story workspace
        return;
    }

    // Don't rely solely on GENERATION_STARTED/ENDED to track this — SillyTavern's
    // Generate() isn't guaranteed to emit GENERATION_ENDED on every error path
    // (an exception thrown during prompt/world-info setup, before the request
    // even starts, skips it entirely). A try/finally here guarantees the flag
    // — and the loop itself — can't get stuck if a request fails.
    setGenerating(true);
    updateStoryActionBarState();

    // Only the first turn of a run starts a new message; every later turn in
    // the same run extends it via 'continue' (see startStoryAutoContinue).
    const generateType = getGenerationState().autoContinueTurnIsFirst ? 'normal' : 'continue';
    setAutoContinueTurnIsFirst(false);

    try {
        await getContext().generate(generateType);
    } catch (error) {
        console.error('Remodel UI: story auto-continue turn failed', error);
        setAutoContinueStatus('idle'); // don't keep looping against a failing request
        setAutoContinueTurnIsFirst(true); // a failed run shouldn't poison the next Play's first turn
    } finally {
        setGenerating(false);
        updateStoryActionBarState();
    }
}

function bindStoryAutoContinueEvents() {
    const context = getContext();

    context.eventSource.on(context.eventTypes.GENERATION_ENDED, () => {
        if (getGenerationState().autoContinue.status === 'playing') {
            triggerNextAutoContinueTurn();
        }
    });

    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, () => {
        if (getGenerationState().autoContinue.status !== 'idle') {
            setAutoContinueStatus('idle');
        }
    });
}

// --- Regenerate (explicit only — editing a message is now a plain, harmless
// in-place edit with no side effects; only this button discards + regenerates) ---

async function truncateStoryChatAfter(editedIndex) {
    const context = getContext();
    const lastIndex = document.querySelectorAll('#chat > .mes').length - 1;

    for (let i = lastIndex; i > editedIndex; i--) {
        await context.deleteMessage(i);
    }
}

async function handleStoryRegenerateClick(button) {
    if (isStoryButtonDisabled(button)) {
        return;
    }

    const mesId = resolveBeatMesId(button);

    if (!Number.isFinite(mesId)) {
        return;
    }

    // Same reasoning as triggerNextAutoContinueTurn: don't trust
    // GENERATION_ENDED alone to clear the busy flag, since a failed request
    // can skip it entirely and leave every story-workspace control disabled.
    setGenerating(true);
    updateStoryActionBarState();

    try {
        await truncateStoryChatAfter(mesId);
        await getContext().generate('normal');
    } catch (error) {
        console.error('Remodel UI: story regenerate failed', error);
    } finally {
        setGenerating(false);
        updateStoryActionBarState();
    }
}

// --- Scene Beat decoration (header/hide toggle + Regenerate button) -------

function handleStoryUserMessageRendered() {
    refreshStoryMessageDecorations();
    renderRoleplayScene(); // no-ops unless the current scene is a roleplay scene
    closeStoryComposer();
    // A new user Scene Beat means the next AI turn (whether typed, Regenerated,
    // or the first turn of a subsequent Play run) is responding to genuinely
    // new input — it should start its own message, not extend a prior one.
    setAutoContinueTurnIsFirst(true);
}

// Unlike handleStoryUserMessageRendered, an AI message arriving needs none
// of that user-turn bookkeeping — just the same decoration/overlay refresh
// every other render trigger point already does.
function handleStoryAiMessageReceived() {
    refreshStoryMessageDecorations();
    renderRoleplayScene(); // no-ops unless the current scene is a roleplay scene
}

// Re-applies Scene Beat headers + the Regenerate button placement to
// whatever's currently in #chat. Called both when a single new message is
// rendered (USER_MESSAGE_RENDERED) AND whenever the chat is (re)loaded
// wholesale (CHAT_CHANGED/CHAT_LOADED, see syncActiveSceneFromChatMetadata)
// — reopening a Scene reprints every message from disk without firing
// USER_MESSAGE_RENDERED per message, which previously left reloaded chats
// with no decorations and no Regenerate button at all.
function refreshStoryMessageDecorations() {
    // Stage 8: Story scenes no longer decorate chat rows. Kept as a no-op
    // event sink until the remaining generic chat event wiring is simplified.
}

function ensurePanelGroupContainer() {
    if (!isRealStoryWorkspaceActive()) {
        return null;
    }

    let container = document.getElementById('remodel-panelgroup');

    if (!container) {
        // Each panel (Scene Summary, Prior Scene Text, Prompt Preview,
        // Manuscript Toolbar) already toggles its own -open class
        // independently (toggleSceneSummaryPanel/togglePriorTextPanel/
        // togglePromptPreviewPanel/toggleManuscriptToolbarPanel) — this used
        // to sit behind one shared hamburger trigger that revealed the
        // whole group of collapsed bars before any single one could be
        // opened. Replaced with a fixed vertical column of square icon
        // buttons floating to the right of the sidebar, one per panel,
        // each independently clickable — no group-level gate anymore. The
        // panels themselves are UNCHANGED: they still dock above the
        // manuscript and still expand inline exactly as before, only their
        // own inline strip-header (icon + label + chevron) is replaced by
        // its column icon as the click target.
        container = document.createElement('div');
        container.id = 'remodel-panelgroup';
        container.className = 'remodel-panelgroup';
        container.innerHTML = `
            <button type="button" class="remodel-panelgroup-icon" data-remodel-summary-toggle title="Scene Summary" aria-label="Scene Summary">
                <i class="fa-solid fa-scroll" aria-hidden="true"></i>
            </button>
            <button type="button" class="remodel-panelgroup-icon" data-remodel-priortext-toggle title="Prior Scene Text" aria-label="Prior Scene Text">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
            </button>
            <button type="button" class="remodel-panelgroup-icon" data-remodel-promptpreview-toggle title="Prompt Preview" aria-label="Prompt Preview">
                <i class="fa-solid fa-eye" aria-hidden="true"></i>
            </button>
            <button type="button" class="remodel-panelgroup-icon" data-remodel-manuscript-toolbar-toggle title="Manuscript Toolbar" aria-label="Manuscript Toolbar">
                <i class="fa-solid fa-font" aria-hidden="true"></i>
            </button>
        `;
        document.getElementById('sheld')?.prepend(container);
    }

    return container;
}

function ensurePanelBodyContainer() {
    if (!isRealStoryWorkspaceActive()) {
        return null;
    }

    let container = document.getElementById('remodel-panelbodies');

    if (!container) {
        container = document.createElement('div');
        container.id = 'remodel-panelbodies';
        container.className = 'remodel-panelbodies';
        document.getElementById('sheld')?.prepend(container);
    }

    return container;
}

// --- Scene Summary panel ----------------------------------------------------
//
// Feeds the {{scene_summary}}/{{arc_summary}}/{{prior_scene_summaries}} macros
// (see registerSceneMacros) — user-placed context, not automatic injection.
// Summaries are user-written, optionally AI-drafted via "Summarize with AI",
// and never sent anywhere unless the user types the macro into a prompt
// surface themselves (system prompt, Author's Note, etc.).

// sceneSummarySaveDebounce now lives in session-state.js's panels domain —
// see armSceneSummarySaveDebounce()/clearSceneSummarySaveDebounce() imported above.

function ensureSceneSummaryPanel() {
    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    let panel = document.getElementById('remodel-scene-summary-panel');

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-scene-summary-panel';
        panel.className = 'remodel-scene-summary-panel';
        // No inline toggle header anymore — the panelgroup's floating
        // fa-scroll icon (ensurePanelGroupContainer) is now the click
        // target that opens/closes this panel via the same
        // toggleSceneSummaryPanel()/.remodel-summary-open class toggle.
        panel.innerHTML = `
            <div class="remodel-scene-summary-body">
                <textarea
                    class="remodel-scene-summary-textarea"
                    data-remodel-summary-textarea
                    placeholder="What happened in this scene? Reference it in prompts with {{scene_summary}}."
                ></textarea>
                <div class="remodel-scene-summary-actions">
                    <button type="button" class="remodel-scene-summary-generate" data-remodel-summary-generate>
                        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Summarize with AI
                    </button>
                    <span class="remodel-scene-summary-status" data-remodel-summary-status></span>
                </div>
            </div>
        `;
        ensurePanelBodyContainer()?.append(panel);
    }

    refreshSceneSummaryPanel();
}

function refreshSceneSummaryPanel() {
    const panel = document.getElementById('remodel-scene-summary-panel');

    if (!panel) {
        return;
    }

    const scene = getActiveScene();
    const textarea = panel.querySelector('[data-remodel-summary-textarea]');

    // Don't clobber what the user is actively typing if a reload/resync fires mid-edit.
    if (textarea && document.activeElement !== textarea) {
        textarea.value = scene?.summary ?? '';
    }

    panel.style.display = scene ? '' : 'none';
}

function toggleSceneSummaryPanel() {
    document.getElementById('remodel-scene-summary-panel')?.classList.toggle('remodel-summary-open');
}

function bindSceneSummaryEvents() {
    document.addEventListener('input', (event) => {
        const textarea = event.target instanceof Element ? event.target.closest('[data-remodel-summary-textarea]') : null;

        if (!textarea) {
            return;
        }

        armSceneSummarySaveDebounce(() => saveActiveSceneSummary(textarea.value), 600);
    });
}

function saveActiveSceneSummary(value) {
    const scene = getActiveScene();

    if (!scene) {
        return;
    }

    updateScene(scene.id, { summary: value, summaryUpdatedAt: new Date().toISOString() });
}

// Uses generateRaw rather than generateQuietPrompt: generateRaw takes a
// manually-built prompt string decoupled from whatever the active chat looks
// like internally, with zero side effects on the visible chat/DOM/saved file
// — same pattern the first-party Summarize extension uses for its own raw
// prompt-builder mode.
async function handleSummarizeSceneClick() {
    const panel = document.getElementById('remodel-scene-summary-panel');
    const statusEl = panel?.querySelector('[data-remodel-summary-status]');
    const textarea = panel?.querySelector('[data-remodel-summary-textarea]');

    if (!textarea) {
        return;
    }

    const messages = Array.from(document.querySelectorAll('#chat > .mes'))
        .map((mesEl) => ({
            name: mesEl.querySelector('.name_text')?.textContent?.trim() || '',
            mes: mesEl.querySelector('.mes_text')?.textContent?.trim() || '',
        }))
        .filter((message) => message.mes);

    if (!messages.length) {
        return;
    }

    const rawPrompt = messages.map((message) => `${message.name}:\n${message.mes}`).join('\n\n');

    if (statusEl) {
        statusEl.textContent = 'Summarizing…';
    }

    try {
        const summary = await getContext().generateRaw({
            prompt: rawPrompt,
            systemPrompt: 'Summarize the scene above in 2-4 concise sentences, focusing on plot-relevant events and outcomes. Do not include meta-commentary.',
        });

        textarea.value = summary.trim();
        saveActiveSceneSummary(textarea.value);

        if (statusEl) {
            statusEl.textContent = 'Draft ready — edit and it saves automatically.';
        }
    } catch (error) {
        console.error('Remodel UI: scene summarization failed', error);

        if (statusEl) {
            statusEl.textContent = 'Summarization failed — try again.';
        }
    } finally {
        setTimeout(() => {
            if (statusEl) {
                statusEl.textContent = '';
            }
        }, 4000);
    }
}

// Registers {{scene_summary}}, {{arc_summary}}, {{prior_scene_summaries}} —
// user-placed macros (system prompt, Author's Note, presets, anywhere
// {{macros}} already resolve), NOT automatic per-generation injection. Each
// resolver reads live state at call time, same pattern as core's own
// {{authorsNote}}/{{summary}} macros — resolves to '' (not an error) when the
// active chat isn't bound to any Scene, so leaving these in a reusable
// prompt is always safe.
function registerSceneMacros() {
    const context = getContext();

    context.registerMacro('scene_summary', () => {
        const scene = getActiveScene();
        return scene?.summary?.trim() || '';
    }, 'The current Scene\'s own summary (Remodel UI).');

    context.registerMacro('arc_summary', () => {
        const scene = getActiveScene();

        if (!scene) {
            return '';
        }

        const store = getTimelineStore();
        return store.arcs[scene.arcId]?.summary?.trim() || '';
    }, 'The current Scene\'s parent Arc summary (Remodel UI).');

    context.registerMacro('prior_scene_summaries', () => {
        const scene = getActiveScene();

        if (!scene) {
            return '';
        }

        const store = getTimelineStore();
        const timeline = store.timelines[scene.timelineId];

        if (!timeline) {
            return '';
        }

        const priorSummaries = [];

        outer: for (const arcId of timeline.arcIds) {
            const arc = store.arcs[arcId];

            if (!arc) {
                continue;
            }

            for (const sceneId of arc.sceneIds) {
                if (sceneId === scene.id) {
                    break outer;
                }

                const priorScene = store.scenes[sceneId];

                if (priorScene?.summary?.trim()) {
                    priorSummaries.push(`${priorScene.title}: ${priorScene.summary.trim()}`);
                }
            }
        }

        return priorSummaries.join('\n');
    }, 'All prior Scene summaries in this Timeline, in order, up to (not including) the current Scene (Remodel UI).');
}

// {{char_field::Name::field}} — pulls a card field from ANY character by
// name, not just the one currently active in the chat. For reference-only
// context (e.g. keeping a second character's personality/description in
// scope without them actually speaking or joining as a group member) —
// confirmed via research that core's own {{char}}/{{description}}/etc.
// macros only ever resolve the active character, and no built-in macro
// accepts a character-name argument. getContext().getCharacterCardFields
// (public/script.js:3417, exposed at st-context.js:231) already supports
// fetching any character's fields by chid — this just adds the name lookup
// and macro plumbing on top.
//
// Requires MacroRegistry directly (registerMacro on context is the LEGACY
// engine, which explicitly does not support arguments — confirmed at
// macros.js:94-95, "Legacy MacrosParser macros never took arguments").
// MacroRegistry-registered macros only actually resolve in real prompts when
// power_user.experimental_macro_engine is on (confirmed at script.js:2938,
// substituteParams falls back to the legacy path otherwise) — this install
// has that setting on, so this works, but it would silently stop resolving
// if that setting were ever turned off.
const CHARACTER_FIELD_NAMES = ['description', 'personality', 'scenario', 'system', 'mesExamples', 'persona', 'jailbreak', 'firstMessage'];

function registerCharacterFieldMacro() {
    MacroRegistry.registerMacro('char_field', {
        category: MacroCategory.CHARACTER,
        unnamedArgs: [
            {
                name: 'name',
                type: MacroValueType.STRING,
                description: 'The character\'s name to look up (not necessarily the active character).',
            },
            {
                name: 'field',
                type: MacroValueType.STRING,
                description: `Which card field to return. One of: ${CHARACTER_FIELD_NAMES.join(', ')}.`,
            },
        ],
        description: 'Returns a card field (description, personality, scenario, etc.) from ANY character by name — not just the one currently active in the chat. Useful for keeping a second character\'s info in scope for reference, without them actually speaking or joining as a group member (Remodel UI).',
        returns: 'string',
        exampleUsage: ['{{char_field::Jude::description}}', '{{char_field::Jude::personality}}'],
        handler: ({ unnamedArgs: [name, field] }) => {
            const context = getContext();
            const targetName = String(name || '').trim().toLowerCase();

            if (!targetName) {
                return '';
            }

            const chid = context.characters.findIndex((c) => c.name?.trim().toLowerCase() === targetName);

            if (chid === -1) {
                return '';
            }

            const normalizedField = String(field || '').trim();

            // getCharacterCardFields resolves ALL lazy fields eagerly (not
            // just the one requested), so a single malformed field elsewhere
            // on this character's card (e.g. a non-string system_prompt —
            // confirmed to happen on a real card in this install, a data
            // problem on that character, not something this macro can fix)
            // would otherwise throw and silently fail the ENTIRE lookup, even
            // for an unrelated field that's perfectly fine. Catch and degrade
            // to '' rather than let one bad card poison every {{char_field}}
            // call for it.
            let fields;

            try {
                fields = context.getCharacterCardFields({ chid });
            } catch (error) {
                console.error(`Remodel UI: {{char_field}} failed to read card fields for "${name}" — likely malformed data on that character's card`, error);
                return '';
            }

            const value = fields[normalizedField];

            if (Array.isArray(value)) {
                return value.join('\n');
            }

            return value ?? '';
        },
    });
}

// --- Prior Text drawer -------------------------------------------------------
//
// Complements the summary macros with actual prose from an earlier Scene.
// A {{prior_scene_full_text}}-style macro can't fetch on demand — macros in
// this codebase resolve synchronously (confirmed: MacrosParser rejects
// Promise return values, and the registry never awaits a resolver), but
// reading another Scene's chat file requires an async network call, since
// that Scene isn't the active/loaded chat. So fetching is a real,
// user-triggered action here (browse -> pick a Scene -> pick how much text
// -> preview -> save under a name), and the RESULT — a plain saved string —
// is what the macro exposes. That keeps the macro itself trivially
// synchronous: it just reads a value someone already fetched on purpose.

// Mirrors core's own getChatsFromFiles (public/script.js) but targets one
// specific Scene's linkedChat rather than a batch list.
async function fetchSceneMessages(scene) {
    if (!scene?.linkedChat) {
        return null;
    }

    const context = getContext();
    const linkedChat = scene.linkedChat;
    const isGroup = linkedChat.type === 'group';
    const endpoint = isGroup ? '/api/chats/group/get' : '/api/chats/get';
    // characterId is stored as a string but is really just the numeric index
    // into context.characters (see getCurrentLinkedChat: String(context.characterId),
    // where context.characterId is core's own this_chid numeric index).
    const character = isGroup ? null : context.characters[Number(linkedChat.characterId)];
    const body = isGroup
        ? { id: linkedChat.chatId }
        : { ch_name: character?.name, file_name: linkedChat.fileName.replace('.jsonl', ''), avatar_url: character?.avatar };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        return null;
    }

    const data = await response.json();

    // Defensive header-strip for both paths — core's own two call sites are
    // inconsistent here (getChatsFromFiles unconditionally shifts for
    // character chats and never checks groups; group-chats.js's
    // getGroupChat guards with this exact check instead). Checking for
    // chat_metadata's presence directly is correct either way.
    if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) {
        data.shift();
    }

    return Array.isArray(data) ? data : null;
}

// Scene Beats (is_user) aren't the only non-narrative message type — system
// and narrator-injected messages are also is_user:false but aren't "the
// story's prose" either. Mirrors the same triple-check core itself uses
// (e.g. script.js's saveReply/messageEditDone call sites).
function isNarrativeProseMessage(mes) {
    return Boolean(mes) && !mes.is_user && !mes.is_system && mes.extra?.type !== 'narrator';
}

// Resolves a message to a { key, label } speaker identity used for the
// per-speaker include/exclude filter. Keys are stable strings (not array
// indices) so a checkbox selection survives a re-fetch and matches messages
// back reliably:
//   - narrator/system  -> key "narrator"
//   - user/persona     -> key "user" (all personas collapse to one — the
//                         "You" side of the scene), label = persona name
//   - character/AI      -> key "char:<name>", label = the character name
function messageSpeaker(mes) {
    const isNarrator = Boolean(mes?.is_system) || mes?.extra?.type === 'narrator';
    if (isNarrator) {
        return { key: 'narrator', label: 'Narrator' };
    }
    if (mes?.is_user) {
        return { key: 'user', label: mes.name || 'You' };
    }
    return { key: `char:${mes?.name || 'Unknown'}`, label: mes?.name || 'Unknown' };
}

// Distinct speakers in a scene, in first-appearance order — drives the
// per-speaker checkbox list. Works for story scenes too (usually just the AI
// voice + "You" from Scene Beats + maybe a narrator).
function collectSceneSpeakers(messages) {
    const seen = new Map();
    for (const mes of (messages || [])) {
        if (!mes || !mes.mes) {
            continue;
        }
        const { key, label } = messageSpeaker(mes);
        if (!seen.has(key)) {
            seen.set(key, { key, label });
        }
    }
    return [...seen.values()];
}

// Generalized prose extraction. Back-compatible: called with no options it
// reproduces the old story behavior (narrative-only, unlabeled). With a
// speaker set / labeling it supports multi-character roleplay sources.
//   - includeSpeakers: Set/array of speaker keys to keep. null/undefined =>
//     the legacy narrative-only filter (isNarrativeProseMessage).
//   - labelSpeakers: prefix each kept message with "Speaker: " (roleplay);
//     false => bare message text (story).
//   - wordLimit: tail-slice the assembled text to the last N words.
function extractSceneProse(messages, { wordLimit = null, includeSpeakers = null, labelSpeakers = false } = {}) {
    const includeSet = includeSpeakers == null
        ? null
        : (includeSpeakers instanceof Set ? includeSpeakers : new Set(includeSpeakers));

    const parts = [];
    for (const mes of (messages || [])) {
        if (!mes || !mes.mes) {
            continue;
        }

        if (includeSet === null) {
            // Legacy path: narrative prose only, no speaker labels.
            if (isNarrativeProseMessage(mes)) {
                parts.push(mes.mes);
            }
            continue;
        }

        const speaker = messageSpeaker(mes);
        if (!includeSet.has(speaker.key)) {
            continue;
        }
        parts.push(labelSpeakers ? `${speaker.label}: ${mes.mes}` : mes.mes);
    }

    const proseText = parts.join('\n\n');

    if (!wordLimit) {
        return proseText;
    }

    const words = proseText.split(/\s+/).filter(Boolean);
    return words.slice(-wordLimit).join(' ');
}

function sanitizeSlotName(rawName) {
    return String(rawName || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '').slice(0, 60);
}

// The single live Prior Text panel body (Story or Roleplay — only one is in
// the DOM at a time, relocated per workspace). All handlers query through
// this so they work regardless of which rail currently hosts it.
function getPriorTextPanelEl() {
    const select = document.querySelector('[data-remodel-priortext-select]');
    return select?.closest('.remodel-priortext-body') || select?.parentElement || null;
}

// Small in-panel cache so the Preview click doesn't re-fetch the messages the
// speaker-list population already loaded for the same scene.
let priorTextMessageCache = { sceneId: null, messages: null };

// Fetches the chosen source scene's messages, lists its distinct speakers as
// checkboxes (all checked by default), and reveals the container. A story
// source usually resolves to 1–2 boxes; a roleplay group to one per cast
// member + You + narrator.
async function populatePriorTextSpeakers() {
    const select = document.querySelector('[data-remodel-priortext-select]');
    const container = document.querySelector('[data-remodel-priortext-speakers]');
    if (!select || !container) {
        return;
    }

    const sceneId = select.value;
    if (!sceneId) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }

    const store = getTimelineStore();
    const sourceScene = store.scenes[sceneId];
    if (!sourceScene) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    container.innerHTML = '<div class="remodel-priortext-speakers-loading">Loading speakers…</div>';

    let messages = null;
    if (priorTextMessageCache.sceneId === sceneId && priorTextMessageCache.messages) {
        messages = priorTextMessageCache.messages;
    } else {
        messages = await fetchSceneMessages(sourceScene);
        priorTextMessageCache = { sceneId, messages };
    }

    // The select may have changed again while we awaited — bail if stale.
    if (select.value !== sceneId) {
        return;
    }

    if (!messages) {
        container.innerHTML = '<div class="remodel-priortext-speakers-loading">Could not load this scene.</div>';
        return;
    }

    const speakers = collectSceneSpeakers(messages);
    if (speakers.length === 0) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="remodel-priortext-speakers-label">Include speakers</div>
        <div class="remodel-priortext-speakers-list">
            ${speakers.map((s) => `
                <label class="remodel-priortext-speaker">
                    <input type="checkbox" data-remodel-priortext-speaker="${escapeAttribute(s.key)}" checked>
                    ${escapeHtml(s.label)}
                </label>
            `).join('')}
        </div>
    `;
}

// Reads the checked speaker keys from the panel. Returns null when the
// speaker UI isn't shown (story scene loaded the legacy way, or nothing
// picked yet) so extraction falls back to the narrative-only default.
function getSelectedPriorTextSpeakers() {
    const boxes = [...document.querySelectorAll('[data-remodel-priortext-speaker]')];
    if (boxes.length === 0) {
        return null;
    }
    return boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-remodel-priortext-speaker'));
}

function getActiveTimelineForPriorText() {
    const scene = getActiveScene();
    if (!scene) {
        return null;
    }

    const store = getTimelineStore();
    return store.timelines[scene.timelineId] || null;
}

function ensurePriorTextPanel() {
    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    let panel = document.getElementById('remodel-priortext-panel');

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-priortext-panel';
        panel.className = 'remodel-priortext-panel';
        // No inline toggle header anymore — the panelgroup's floating
        // fa-book-open icon (ensurePanelGroupContainer) is now the click
        // target, same as Scene Summary above.
        panel.innerHTML = buildPriorTextBodyMarkup();
        ensurePanelBodyContainer()?.append(panel);
    }

    refreshPriorTextPanel();
}

// Shared inner markup for the Prior Text panel body — used by both the Story
// rail panel (#remodel-priortext-panel) and the roleplay rail panel, so the
// data-* hooks and handlers are identical for both. The single instance is
// relocated between workspaces (see ensureRoleplayPriorTextPanel), so these
// data-attributes/ids live in the DOM exactly once at a time.
function buildPriorTextBodyMarkup() {
    return `
        <div class="remodel-priortext-body">
            <label class="remodel-priortext-label">Source Scene</label>
            <select class="remodel-priortext-select" data-remodel-priortext-select></select>

            <div class="remodel-priortext-speakers" data-remodel-priortext-speakers hidden></div>

            <div class="remodel-priortext-wordrow">
                <label class="remodel-priortext-checkbox-label">
                    <input type="checkbox" data-remodel-priortext-fulltext>
                    Full text
                </label>
                <label class="remodel-priortext-label">Last
                    <input type="number" class="remodel-priortext-wordcount" data-remodel-priortext-wordcount value="500" min="1">
                    words
                </label>
            </div>

            <button type="button" class="remodel-priortext-loadpreview" data-remodel-priortext-loadpreview>
                Load Preview
            </button>
            <span class="remodel-priortext-status" data-remodel-priortext-status></span>

            <textarea class="remodel-priortext-preview" data-remodel-priortext-preview readonly placeholder="Preview will appear here."></textarea>
            <span class="remodel-priortext-wordcount-display" data-remodel-priortext-wordcount-display></span>

            <div class="remodel-priortext-saverow">
                <input type="text" class="remodel-priortext-slotname" data-remodel-priortext-slotname placeholder="Slot name, e.g. chapter1recap">
                <button type="button" class="remodel-priortext-save" data-remodel-priortext-save>Save Slot</button>
            </div>

            <div class="remodel-priortext-slotlist" data-remodel-priortext-slotlist></div>
        </div>
    `;
}

function refreshPriorTextPanel() {
    // Work off the shared body element (it may be relocated into the roleplay
    // rail), not the story panel host specifically.
    const body = getPriorTextPanelEl();

    if (!body) {
        return;
    }

    const scene = getActiveScene();

    // Only the STORY host controls its own display via this style toggle; when
    // the body is relocated into the roleplay rail, its visibility is driven
    // by the roleplay panel's -open class instead, so don't fight that here.
    const storyHost = document.getElementById('remodel-priortext-panel');
    if (storyHost && storyHost.contains(body)) {
        storyHost.style.display = scene ? '' : 'none';
    }

    if (!scene) {
        return;
    }

    const store = getTimelineStore();
    const timeline = store.timelines[scene.timelineId];
    const select = body.querySelector('[data-remodel-priortext-select]');

    if (select && timeline) {
        const previousValue = select.value;
        const options = [];

        for (const arcId of timeline.arcIds) {
            const arc = store.arcs[arcId];

            if (!arc) {
                continue;
            }

            for (const sceneId of arc.sceneIds) {
                const rowScene = store.scenes[sceneId];

                if (!rowScene) {
                    continue;
                }

                // Any bound scene — story OR roleplay — is a valid prior-text
                // source now; the pipeline (fetchSceneMessages, extraction,
                // slot macro) is mode-agnostic. "(unavailable)" now means only
                // "no chat bound to this scene yet."
                const usable = Boolean(rowScene.linkedChat);
                options.push(`
                    <option value="${escapeAttribute(sceneId)}" ${usable ? '' : 'disabled'}>
                        ${escapeHtml(arc.title)} — ${escapeHtml(rowScene.title)}${usable ? '' : ' (unavailable)'}
                    </option>
                `);
            }
        }

        select.innerHTML = options.join('');

        if ([...select.options].some((option) => option.value === previousValue)) {
            select.value = previousValue;
        }
    }

    refreshPriorTextSlotList(timeline);
}

function refreshPriorTextSlotList(timeline) {
    const listEl = getPriorTextPanelEl()?.querySelector('[data-remodel-priortext-slotlist]');

    if (!listEl) {
        return;
    }

    const slots = timeline?.insertedTextSlots || {};
    const entries = Object.entries(slots);

    if (!entries.length) {
        listEl.innerHTML = '<div class="remodel-priortext-slotlist-empty">No saved slots yet.</div>';
        return;
    }

    listEl.innerHTML = entries.map(([slotName, slot]) => `
        <div class="remodel-priortext-slot-item">
            <span class="remodel-priortext-slot-name">{{inserted_text_${escapeHtml(slotName)}}}</span>
            <span class="remodel-priortext-slot-meta">${escapeHtml(slot.sourceSceneTitle || '')} · ${slot.text ? slot.text.split(/\s+/).filter(Boolean).length : 0} words</span>
            <button type="button" class="remodel-icon-button" title="Reload" data-remodel-priortext-slot-reload="${escapeAttribute(slotName)}">↻</button>
            <button type="button" class="remodel-icon-button" title="Delete" data-remodel-priortext-slot-delete="${escapeAttribute(slotName)}">×</button>
        </div>
    `).join('');
}

async function handlePriorTextLoadPreview() {
    const panel = getPriorTextPanelEl();
    const select = panel?.querySelector('[data-remodel-priortext-select]');
    const fullTextCheckbox = panel?.querySelector('[data-remodel-priortext-fulltext]');
    const wordCountInput = panel?.querySelector('[data-remodel-priortext-wordcount]');
    const preview = panel?.querySelector('[data-remodel-priortext-preview]');
    const statusEl = panel?.querySelector('[data-remodel-priortext-status]');
    const wordCountDisplay = panel?.querySelector('[data-remodel-priortext-wordcount-display]');

    if (!select?.value || !preview) {
        return;
    }

    const store = getTimelineStore();
    const sourceScene = store.scenes[select.value];

    if (!sourceScene) {
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Loading…';
    }

    try {
        // Reuse the messages the speaker-list already fetched for this scene.
        let messages = null;
        if (priorTextMessageCache.sceneId === sourceScene.id && priorTextMessageCache.messages) {
            messages = priorTextMessageCache.messages;
        } else {
            messages = await fetchSceneMessages(sourceScene);
            priorTextMessageCache = { sceneId: sourceScene.id, messages };
        }

        if (!messages) {
            if (statusEl) {
                statusEl.textContent = 'Could not load that Scene\'s chat.';
            }
            return;
        }

        const useFullText = Boolean(fullTextCheckbox?.checked);
        const wordLimit = useFullText ? null : Math.max(1, Number(wordCountInput?.value) || 500);

        const labelSpeakers = sourceScene.mode === 'roleplay';

        // Speaker filter. If the checkboxes haven't been rendered yet (user
        // hit Preview before the list populated), fall back to "all speakers
        // in this scene" for a roleplay source so it's still filtered/labeled,
        // and kick off population so the boxes appear for next time. A story
        // source with no boxes uses the legacy narrative-only path (null).
        let includeSpeakers = getSelectedPriorTextSpeakers();
        if (includeSpeakers === null && labelSpeakers) {
            includeSpeakers = collectSceneSpeakers(messages).map((s) => s.key);
            populatePriorTextSpeakers();
        }
        const proseText = extractSceneProse(messages, { wordLimit, includeSpeakers, labelSpeakers });

        preview.value = proseText;
        preview.dataset.remodelPriortextSourceSceneId = sourceScene.id;
        preview.dataset.remodelPriortextSourceSceneTitle = sourceScene.title;
        preview.dataset.remodelPriortextWordMode = useFullText ? 'full' : 'last';
        preview.dataset.remodelPriortextWordCount = wordLimit ?? '';
        preview.dataset.remodelPriortextSpeakers = includeSpeakers ? JSON.stringify(includeSpeakers) : '';
        preview.dataset.remodelPriortextLabelSpeakers = labelSpeakers ? '1' : '';

        if (wordCountDisplay) {
            wordCountDisplay.textContent = `${proseText.split(/\s+/).filter(Boolean).length} words`;
        }

        if (statusEl) {
            statusEl.textContent = 'Preview ready.';
        }
    } catch (error) {
        console.error('Remodel UI: prior scene text load failed', error);

        if (statusEl) {
            statusEl.textContent = 'Load failed — try again.';
        }
    } finally {
        setTimeout(() => {
            if (statusEl) {
                statusEl.textContent = '';
            }
        }, 4000);
    }
}

function handlePriorTextSaveSlot() {
    const panel = getPriorTextPanelEl();
    const preview = panel?.querySelector('[data-remodel-priortext-preview]');
    const slotNameInput = panel?.querySelector('[data-remodel-priortext-slotname]');
    const statusEl = panel?.querySelector('[data-remodel-priortext-status]');

    const slotName = sanitizeSlotName(slotNameInput?.value);

    if (!slotName || !preview?.value) {
        if (statusEl) {
            statusEl.textContent = 'Load a preview and name the slot first.';
            setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
        }
        return;
    }

    const timeline = getActiveTimelineForPriorText();

    if (!timeline) {
        return;
    }

    let includeSpeakers = null;
    if (preview.dataset.remodelPriortextSpeakers) {
        try {
            includeSpeakers = JSON.parse(preview.dataset.remodelPriortextSpeakers);
        } catch {
            includeSpeakers = null;
        }
    }

    setInsertedTextSlot(timeline.id, slotName, {
        text: preview.value,
        sourceSceneId: preview.dataset.remodelPriortextSourceSceneId || null,
        sourceSceneTitle: preview.dataset.remodelPriortextSourceSceneTitle || '',
        wordMode: preview.dataset.remodelPriortextWordMode || 'full',
        wordCount: preview.dataset.remodelPriortextWordCount ? Number(preview.dataset.remodelPriortextWordCount) : null,
        // Absent on legacy story slots (= all narrative prose, no labels).
        includeSpeakers,
        labelSpeakers: preview.dataset.remodelPriortextLabelSpeakers === '1',
    });

    registerInsertedTextSlotMacros(getTimelineStore().timelines[timeline.id]);
    refreshPriorTextSlotList(getTimelineStore().timelines[timeline.id]);

    if (slotNameInput) {
        slotNameInput.value = '';
    }

    if (statusEl) {
        statusEl.textContent = `Saved — use {{inserted_text_${slotName}}} in any prompt.`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    }
}

async function handlePriorTextSlotReload(slotName) {
    const timeline = getActiveTimelineForPriorText();
    const slot = timeline?.insertedTextSlots?.[slotName];

    if (!timeline || !slot?.sourceSceneId) {
        return;
    }

    const store = getTimelineStore();
    const sourceScene = store.scenes[slot.sourceSceneId];

    if (!sourceScene) {
        return;
    }

    const messages = await fetchSceneMessages(sourceScene);

    if (!messages) {
        return;
    }

    const wordLimit = slot.wordMode === 'full' ? null : slot.wordCount;
    const proseText = extractSceneProse(messages, {
        wordLimit,
        includeSpeakers: slot.includeSpeakers ?? null,
        labelSpeakers: Boolean(slot.labelSpeakers),
    });

    setInsertedTextSlot(timeline.id, slotName, {
        text: proseText,
        sourceSceneId: sourceScene.id,
        sourceSceneTitle: sourceScene.title,
        wordMode: slot.wordMode,
        wordCount: slot.wordCount,
        includeSpeakers: slot.includeSpeakers ?? null,
        labelSpeakers: Boolean(slot.labelSpeakers),
    });

    registerInsertedTextSlotMacros(getTimelineStore().timelines[timeline.id]);
    refreshPriorTextSlotList(getTimelineStore().timelines[timeline.id]);
}

function handlePriorTextSlotDelete(slotName) {
    const timeline = getActiveTimelineForPriorText();

    if (!timeline) {
        return;
    }

    deleteInsertedTextSlot(timeline.id, slotName);
    // The macro itself isn't unregistered (MacrosParser has no public
    // unregister in the legacy path this extension bridges through) — but
    // re-pointing it to resolve '' is enough to make a deleted slot inert.
    getContext().registerMacro(`inserted_text_${slotName}`, () => '', 'Deleted prior-scene text slot (Remodel UI).');
    refreshPriorTextSlotList(getTimelineStore().timelines[timeline.id]);
}

function togglePriorTextPanel() {
    document.getElementById('remodel-priortext-panel')?.classList.toggle('remodel-priortext-open');
}

function bindPriorTextPanelEvents() {
    document.addEventListener('change', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        // Full-text checkbox disables the word-count input.
        const fullTextCheckbox = target.closest('[data-remodel-priortext-fulltext]');
        if (fullTextCheckbox) {
            const wordCountInput = getPriorTextPanelEl()?.querySelector('[data-remodel-priortext-wordcount]');
            if (wordCountInput) {
                wordCountInput.disabled = fullTextCheckbox.checked;
            }
            return;
        }

        // Source-scene selection change repopulates the speaker checkboxes.
        const select = target.closest('[data-remodel-priortext-select]');
        if (select) {
            populatePriorTextSpeakers();
        }
    });
}

// Registered/re-registered dynamically per saved slot (unlike the three
// fixed-name macros above) — called again immediately after every slot save,
// so a newly created slot's macro is usable in the same session without a
// reload.
function registerInsertedTextSlotMacros(timeline) {
    if (!timeline?.insertedTextSlots) {
        return;
    }

    const context = getContext();

    for (const [slotName, slot] of Object.entries(timeline.insertedTextSlots)) {
        context.registerMacro(`inserted_text_${slotName}`, () => slot.text || '',
            `Saved prior-scene text slot "${slotName}" (Remodel UI, from "${slot.sourceSceneTitle}").`);
    }
}

// Slots are meant to be usable from ANY Scene/prompt, not just the one
// active when the page happens to load — so at startup, register macros for
// every Timeline in the store, not just whichever one (if any) the
// currently-loaded chat is bound to. Without this, a slot saved in a
// previous session would silently stop resolving after a real page reload
// whenever the reload's active chat isn't a Story Scene at the moment
// initTimelineSpine() runs (confirmed via live testing: the persisted slot
// data survives fine, but its macro is never (re-)registered).
function registerAllInsertedTextSlotMacros() {
    const store = getTimelineStore();

    for (const timeline of Object.values(store.timelines)) {
        registerInsertedTextSlotMacros(timeline);
    }
}

// --- Prompt Preview drawer --------------------------------------------------
//
// Replaces the old per-message "View Prompt" button (removed: it surfaced
// core's native itemized-prompt inspector, which went stale/wrong after a
// Scene Beat merge — see mergeAdjacentAiMessages — since core's
// itemizedPrompts array isn't reachable via getContext() to correct it, and
// showed a PAST prompt rather than letting the user check BEFORE sending).
//
// This is a genuine pre-flight inspector: a dry run (Generate(type, {}, true))
// assembles the exact prompt core would send — system prompt, character
// fields, World Info, Author's Note, chat history — without ever contacting
// the API or mutating chat/settings state (confirmed via reading script.js:
// the dry-run path skips chat_metadata.tainted, server pings, and swipe
// changes, all gated behind `if (!dryRun)`). GENERATE_AFTER_DATA fires with
// the fully-built generate_data synchronously before the dry run's early
// return, so capturing it via a one-shot listener and awaiting
// context.generate(...) directly is race-free.

// promptPreviewInFlight now lives in session-state.js's panels domain — see
// getPanelsState()/setPromptPreviewInFlight() imported above.

async function runPromptPreviewDryRun(generationType) {
    const context = getContext();

    // Splice a synthetic, temporary user message reflecting whatever's
    // currently TYPED but not yet sent, so the preview matches what would
    // actually go out if the user hit send right now. Only applies to a
    // 'normal' turn — Continue extends the last AI message and takes no new
    // user input, so there's nothing to splice for it.
    const textarea = document.getElementById('send_textarea');
    const composerText = textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : '';
    let splicedMessage = null;

    if (composerText && generationType === 'normal') {
        splicedMessage = {
            name: context.name1,
            is_user: true,
            is_system: false,
            send_date: Date.now(),
            mes: composerText,
            extra: {},
        };
        context.chat.push(splicedMessage);
    }

    let capturedPrompt = null;
    const captureListener = (generateData) => {
        capturedPrompt = generateData;
    };

    context.eventSource.once(context.eventTypes.GENERATE_AFTER_DATA, captureListener);

    // Core's prompt assembly (prepareOpenAIMessages in openai.js) catches
    // its own token-budget/character-name errors internally and reports them
    // ONLY via a toastr.error(...) call + an unexposed promptManager.error
    // field — it never re-throws, and GENERATE_AFTER_DATA still fires
    // (confirmed via live testing) with whatever partial prompt made it in
    // before the failure. Without this, a dry run that hit e.g. "Mandatory
    // prompts exceed the context size" would silently show incomplete/wrong
    // content in the drawer as if it were a normal, complete preview. toastr
    // isn't exposed via getContext(), but it's a plain global — temporarily
    // wrapping .error() here is the only way to surface that failure back
    // into the drawer's own status line instead of relying on the user
    // having noticed a toast that appeared for an unrelated-looking reason.
    const toastrErrors = [];
    const originalToastrError = window.toastr?.error;

    if (typeof window.toastr?.error === 'function') {
        window.toastr.error = function (message, ...rest) {
            toastrErrors.push(String(message));
            return originalToastrError.apply(this, [message, ...rest]);
        };
    }

    try {
        await context.generate(generationType, {}, true);
    } finally {
        context.eventSource.removeListener(context.eventTypes.GENERATE_AFTER_DATA, captureListener);

        if (originalToastrError) {
            window.toastr.error = originalToastrError;
        }

        // Always remove the synthetic message regardless of success/failure
        // — it must never survive to be rendered, saved, or read by anything
        // else that touches context.chat.
        if (splicedMessage) {
            const index = context.chat.indexOf(splicedMessage);
            if (index !== -1) {
                context.chat.splice(index, 1);
            }
        }
    }

    return { generateData: capturedPrompt, warnings: toastrErrors };
}

function formatPromptPreview(generateData) {
    if (!generateData) {
        return '(No prompt was assembled — check that a character is selected and an API connection is configured.)';
    }

    const prompt = generateData.prompt;

    if (typeof prompt === 'string') {
        return prompt;
    }

    if (Array.isArray(prompt)) {
        return prompt
            .map((entry) => `=== ${String(entry.role || 'unknown').toUpperCase()} ===\n${entry.content ?? ''}`)
            .join('\n\n');
    }

    return '(Unrecognized prompt format — nothing to show.)';
}

function ensurePromptPreviewPanel() {
    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    let panel = document.getElementById('remodel-promptpreview-panel');

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-promptpreview-panel';
        panel.className = 'remodel-promptpreview-panel';
        // No inline toggle header anymore — the panelgroup's floating
        // fa-eye icon (ensurePanelGroupContainer) is now the click target,
        // same as Scene Summary/Prior Scene Text above.
        panel.innerHTML = `
            <div class="remodel-promptpreview-body">
                <div class="remodel-promptpreview-typerow">
                    <label class="remodel-promptpreview-radio-label">
                        <input type="radio" name="remodel-promptpreview-type" value="normal" data-remodel-promptpreview-type checked>
                        Normal
                    </label>
                    <label class="remodel-promptpreview-radio-label">
                        <input type="radio" name="remodel-promptpreview-type" value="continue" data-remodel-promptpreview-type>
                        Continue
                    </label>
                </div>

                <button type="button" class="remodel-promptpreview-refresh" data-remodel-promptpreview-refresh>
                    Refresh Preview
                </button>
                <span class="remodel-promptpreview-status" data-remodel-promptpreview-status></span>

                <textarea class="remodel-promptpreview-output" data-remodel-promptpreview-output readonly
                    placeholder="Click Refresh Preview to see the fully assembled prompt."></textarea>
            </div>
        `;
        ensurePanelBodyContainer()?.append(panel);
    }

    refreshPromptPreviewPanel();
}

function refreshPromptPreviewPanel() {
    const panel = document.getElementById('remodel-promptpreview-panel');

    if (!panel) {
        return;
    }

    const scene = getActiveScene();
    panel.style.display = scene ? '' : 'none';
}

function togglePromptPreviewPanel() {
    document.getElementById('remodel-promptpreview-panel')?.classList.toggle('remodel-promptpreview-open');
}

// Manuscript Toolbar — formatting stays markdown, not true rich text.
// chat[].mes IS markdown (confirmed: messageFormatting() is a one-way
// markdown->HTML pipeline with no reverse mapping anywhere in the
// codebase), and the commit path (openEditCloseWith) pastes raw text into
// core's real edit textarea exactly like typing markdown by hand — so
// "Bold" here means wrapping the selection in ** the same way a user
// would type it themselves, not toggling a live rendered-bold state. Font
// picker is purely cosmetic/local: it sets --remodel-manuscript-font on
// body, which only the overlay's CSS reads (public/style.css) — no
// chat[]/session-state persistence, matches "font" being a display
// preference, not story content.
const MANUSCRIPT_FONT_OPTIONS = [
    { label: 'Georgia (default)', value: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif" },
    { label: 'Garamond', value: "'EB Garamond', Garamond, 'Times New Roman', serif" },
    { label: 'Courier (typewriter)', value: "'Courier New', Courier, monospace" },
    { label: 'Grotesque (sans)', value: "'Segoe UI', Helvetica, Arial, sans-serif" },
];

function applyManuscriptFont(fontValue) {
    document.body.style.setProperty('--remodel-manuscript-font', fontValue);
}

function saveManuscriptFontPreference(fontValue) {
    try {
        localStorage.setItem(MANUSCRIPT_FONT_STORAGE_KEY, fontValue);
    } catch (err) {
        console.error('Remodel manuscript toolbar: failed to save font preference', err);
    }
}

function restoreManuscriptFontPreference() {
    let stored;
    try {
        stored = localStorage.getItem(MANUSCRIPT_FONT_STORAGE_KEY);
    } catch (err) {
        return;
    }
    if (!stored) {
        return;
    }
    applyManuscriptFont(stored);
    const select = document.querySelector('[data-remodel-manuscript-font-select]');
    if (select) {
        select.value = stored;
    }
}

function handleManuscriptFontChange(selectEl) {
    applyManuscriptFont(selectEl.value);
    saveManuscriptFontPreference(selectEl.value);
}

// Wraps the current selection (if it's inside a manuscript block) in the
// given markdown delimiter pair — e.g. bold -> **text**. A collapsed
// selection (no highlighted text) just inserts an empty pair with the
// caret placed between them, same as most markdown editors' toolbar
// buttons. Deliberately reuses plain Range/textContent splicing (not
// execCommand) for the same reason insertPlainText does inside
// bindManuscriptBoundaryProtection: predictable single-text-node output,
// no browser-specific rich-formatting side effects.
async function handlePromptPreviewRefreshClick() {
    if (getPanelsState().promptPreviewInFlight) {
        return;
    }

    const panel = document.getElementById('remodel-promptpreview-panel');
    const refreshButton = panel?.querySelector('[data-remodel-promptpreview-refresh]');
    const statusEl = panel?.querySelector('[data-remodel-promptpreview-status]');
    const outputEl = panel?.querySelector('[data-remodel-promptpreview-output]');
    const selectedType = panel?.querySelector('[data-remodel-promptpreview-type]:checked')?.value || 'normal';

    if (!outputEl) {
        return;
    }

    setPromptPreviewInFlight(true);
    refreshButton?.classList.add('remodel-story-disabled');

    if (statusEl) {
        statusEl.textContent = 'Assembling…';
    }

    // Warnings (e.g. a swallowed token-budget error) need to stay visible
    // until the user acts, unlike the normal "Preview ready." status — only
    // auto-clear the status when there's nothing the user needs to read.
    let shouldAutoClearStatus = true;

    try {
        const { generateData, warnings } = await runPromptPreviewDryRun(selectedType);
        outputEl.value = formatPromptPreview(generateData);

        if (statusEl) {
            // Surface core's own swallowed error (e.g. "Mandatory prompts
            // exceed the context size") instead of claiming the preview is
            // complete — this content may be partial/incomplete when a
            // warning fired, since core's prompt assembly still returns
            // whatever it managed to fit before the failure.
            if (warnings.length) {
                statusEl.textContent = `Preview incomplete — ${warnings.join(' ')}`;
                shouldAutoClearStatus = false;
            } else {
                statusEl.textContent = 'Preview ready.';
            }
        }
    } catch (error) {
        console.error('Remodel UI: prompt preview dry run failed', error);
        outputEl.value = '';

        if (statusEl) {
            statusEl.textContent = 'Preview failed — check the console for details.';
        }
        shouldAutoClearStatus = false;
    } finally {
        setPromptPreviewInFlight(false);
        refreshButton?.classList.remove('remodel-story-disabled');

        if (shouldAutoClearStatus) {
            setTimeout(() => {
                if (statusEl) {
                    statusEl.textContent = '';
                }
            }, 4000);
        }
    }
}

// --- Add User Message toggle -----------------------------------------------

function ensureStoryComposerExtras() {
    const rightSendForm = document.getElementById('rightSendForm');

    if (!rightSendForm || document.getElementById('remodel-add-user-message')) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'remodel-add-user-message';
    button.className = 'interactable';
    button.title = 'Add a message';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.innerHTML = '<i class="fa-solid fa-feather" aria-hidden="true"></i><span>Add User Message</span>';
    rightSendForm.prepend(button);

    const spinner = document.createElement('div');
    spinner.id = 'remodel-story-spinner';
    spinner.className = 'remodel-story-spinner';
    spinner.title = 'Generating…';
    spinner.setAttribute('aria-hidden', 'true');
    rightSendForm.prepend(spinner);

    // Cancel button: sits with the hamburger + wand in #leftSendForm and is
    // only shown (via CSS, keyed on body.remodel-story-input-open) while the
    // message box is open — gives a way to back out of a drafted message
    // without sending it.
    const leftSendForm = document.getElementById('leftSendForm');
    if (leftSendForm && !document.getElementById('remodel-cancel-user-message')) {
        const cancel = document.createElement('div');
        cancel.id = 'remodel-cancel-user-message';
        cancel.className = 'interactable fa-solid fa-xmark';
        cancel.title = 'Cancel message';
        cancel.setAttribute('role', 'button');
        cancel.setAttribute('tabindex', '0');
        leftSendForm.append(cancel);
    }
}

function openStoryComposer() {
    document.body.classList.add('remodel-story-input-open');

    const textarea = document.getElementById('send_textarea');
    if (textarea instanceof HTMLTextAreaElement) {
        // Only hint at the empty-send-continues behavior when there's
        // actually something to continue — an AI message already on the
        // page. A brand-new scene has nothing to extend yet.
        const hasAiMessage = document.querySelector('#chat > .mes[is_user="false"]') !== null;
        textarea.placeholder = hasAiMessage
            ? 'Write the next beat… or leave blank and send to continue the last response.'
            : 'Write the next beat…';
    }

    textarea?.focus();
}

function closeStoryComposer({ clearDraft = false } = {}) {
    document.body.classList.remove('remodel-story-input-open');

    // When the user explicitly cancels (vs. a send/chat-switch teardown),
    // discard the drafted text so reopening starts clean — dispatching input
    // so core's own send-button/token-count state resyncs to the empty value.
    if (clearDraft) {
        const textarea = document.getElementById('send_textarea');
        if (textarea instanceof HTMLTextAreaElement && textarea.value !== '') {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

// --- Generation state (drives disabled buttons + the loading spinner) ------
//
// State itself (isGenerating/runIsOurs/watchdog) now lives in session-state.js's
// generation domain — see getGenerationState() and the action functions
// imported above. STORY_GENERATION_TYPES stays here since it's a static
// filter table, not mutable state.

// GENERATION_STARTED/ENDED/STOPPED fire for EVERY generation on the page,
// not just user-facing story turns — core's Generate() (script.js) emits
// them for 'quiet' background calls too (e.g. this very extension's own
// Scene Summary generation, generateRaw() below, or any other extension's
// silent LLM call). Without filtering, a background summary generating
// would flip on the story spinner and disable the composer with no visible
// prompt sent — confirmed as the cause of a real reported bug where the
// buttons looked stuck/generating despite no message being sent. Only
// GENERATION_STARTED carries the type argument (ENDED/STOPPED don't), so we
// gate on start and remember whether THIS run is one we care about.
const STORY_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', undefined]);

// SillyTavern's Generate() isn't guaranteed to emit GENERATION_ENDED on every
// error path (an exception thrown before the request even starts skips it
// entirely) — a request that fails that way would otherwise leave
// isGenerating stuck true forever, permanently disabling every
// story-workspace control. This watchdog is the safety net for generations
// we didn't trigger ourselves (typing + Enter); ones we DO trigger
// (Regenerate, auto-continue) also guard themselves directly with try/finally.
function bindStoryGenerationStateEvents() {
    const context = getContext();

    context.eventSource.on(context.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (!STORY_GENERATION_TYPES.has(type)) {
            return; // quiet/impersonate/etc — not a story turn, ignore
        }

        if (dryRun) {
            // A dry run only assembles the prompt (e.g. token-count/context-fit
            // checks core runs internally, such as during selectCharacterById/
            // newchat) — no request is actually sent, so there's no real "in
            // flight" state to represent. Confirmed via live testing: dry runs
            // fire GENERATION_STARTED with type:'normal' like a real turn, and
            // without this check they'd flip on the spinner and disable the
            // composer with nothing actually generating — reproduced exactly
            // this way independent of the quiet-type case above.
            return;
        }

        beginOwnedGenerationRun();
        updateStoryActionBarState();

        // The story workspace's OWN generation-triggering controls are
        // already disabled while manuscript-editing is active
        // (updateStoryActionBarState), but a generation can still start
        // through a path this extension doesn't gate — the native composer's
        // Enter key, a slash command, another extension. GENERATION_STARTED
        // fires synchronously right as streaming is about to begin, too late
        // to block this specific run, so this can't PREVENT the race — but
        // force-settling here still salvages whatever's currently in the
        // open blocks before streaming's own innerHTML replacement
        // (StreamingProcessor.onProgressStreaming, script.js) can silently
        // discard it out from under an open edit.
        armGenerationWatchdog(() => {
            if (getGenerationState().isGenerating) {
                console.warn('Remodel UI: generation state watchdog fired — no GENERATION_ENDED/STOPPED arrived, resetting.');
                // Matches original behavior exactly: only clears the isGenerating
                // flag, NOT run ownership (setGenerating, not endOwnedGenerationRun) —
                // preserved as-is rather than changed as part of this refactor.
                setGenerating(false);
                updateStoryActionBarState();
            }
        }, 90000);
    });

    context.eventSource.on(context.eventTypes.GENERATION_ENDED, () => {
        if (!isGenerationRunOurs()) {
            return; // a quiet/background generation elsewhere on the page ended — not ours
        }

        clearGenerationWatchdog();
        endOwnedGenerationRun();
        updateStoryActionBarState();
    });

    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, () => {
        if (!isGenerationRunOurs()) {
            return;
        }

        clearGenerationWatchdog();
        endOwnedGenerationRun();
        updateStoryActionBarState();
    });
}

function updateStoryActionBarState() {
    const { isGenerating, autoContinue } = getGenerationState();
    document.body.classList.toggle('remodel-story-generating', isGenerating);

    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    const playing = autoContinue.status === 'playing';
    // remodel-manuscript-editing is no longer a brief, click-triggered
    // window — the manuscript overlay is continuously live (see
    // renderManuscriptOverlay), so that class is essentially always set
    // while the story workspace is active. Gating Regenerate/Continue/Add
    // User Message on it would permanently disable them. The race this
    // guard originally protected against (a new generation's streaming
    // overwriting unsaved manuscript typing) is already covered elsewhere:
    // bindStoryGenerationStateEvents force-settles any open manuscript edit
    // the instant GENERATION_STARTED fires, before streaming can touch
    // anything. So these controls now only need to reflect a REAL
    // generation actually being in flight, same as any other chat control.

    setStoryButtonDisabled('stscript_continue', isGenerating || playing);
    setStoryButtonDisabled('stscript_pause', !playing);
    setStoryButtonDisabled('stscript_stop', !isGenerating && autoContinue.status === 'idle');
    setStoryButtonDisabled('remodel-add-user-message', isGenerating);

    document.querySelectorAll('.remodel-beat-regenerate').forEach((button) => {
        button.classList.toggle('remodel-story-disabled', isGenerating);
    });
}

function setStoryButtonDisabled(id, disabled) {
    document.getElementById(id)?.classList.toggle('remodel-story-disabled', disabled);
}

function isStoryButtonDisabled(element) {
    return Boolean(element?.classList.contains('remodel-story-disabled'));
}

async function handleAction(element) {
    const action = element.dataset.remodelTimelineAction;
    const { createModalDraft, focusedTimelineId } = getSessionState();

    switch (action) {
        case 'open-create-timeline':
            setCreateModalDraft({ title: '', description: '', thumbnail: null });
            setCreateModalOpen(true);
            break;
        case 'cancel-create-timeline':
            setCreateModalOpen(false);
            break;
        case 'submit-create-timeline': {
            const created = createTimeline(createModalDraft.title.trim() || 'New Timeline');
            updateTimeline(created.id, {
                description: createModalDraft.description,
                thumbnail: createModalDraft.thumbnail,
            });
            setCreateModalOpen(false);
            setFocusedTimelineId(created.id);
            break;
        }
        case 'select-timeline':
            setActiveTimeline(element.dataset.timelineId);
            break;
        case 'open-timeline':
            setActiveTimeline(element.dataset.timelineId);
            setFocusedTimelineId(element.dataset.timelineId);
            break;
        case 'close-timeline':
            setFocusedTimelineId(null);
            break;
        case 'delete-timeline':
            if (confirm('Delete this Timeline and all of its Arcs and Scenes?')) {
                if (focusedTimelineId === element.dataset.timelineId) {
                    setFocusedTimelineId(null);
                }
                deleteTimeline(element.dataset.timelineId);
            }
            break;
        case 'create-arc': {
            const title = askForTitle('Arc title?', 'New Arc');
            if (title) {
                createArc(element.dataset.timelineId, title);
            }
            break;
        }
        case 'delete-arc':
            if (confirm('Delete this Arc and all of its Scenes?')) {
                deleteArc(element.dataset.arcId);
            }
            break;
        case 'create-scene': {
            const fallback = element.dataset.mode === 'story' ? 'New Story Scene' : 'New Roleplay Scene';
            const created = createScene(element.dataset.arcId, element.dataset.mode, fallback);
            if (created) {
                setRenamingSceneId(created.id);
            }
            break;
        }
        case 'select-scene':
            setActiveScene(element.dataset.sceneId);
            break;
        case 'delete-scene':
            if (confirm('Delete this Scene? The underlying SillyTavern chat will not be deleted.')) {
                deleteScene(element.dataset.sceneId);
            }
            break;
        case 'bind-current':
            bindCurrentChatToScene(element.dataset.sceneId);
            break;
        case 'open-scene':
            await openScene(element.dataset.sceneId);
            break;
        default:
            break;
    }

    queueRender();
}

async function handleCharacterAction(element) {
    const action = element.dataset.remodelCharacterAction;

    switch (action) {
        case 'select-character': {
            const characterId = Number(element.dataset.characterId);

            if (!Number.isFinite(characterId)) {
                break;
            }

            if (getWizardState().sceneCreationFlow?.step === 'choose-character') {
                advanceWizardToPersonaStep(characterId);
                await transitionToWindow({ kind: 'tavern', tab: 'personas' });
                showGuidedPrompt('choose-persona');
                break;
            }

            if (isActiveChatLockedStoryScene()) {
                showGuidedPrompt('locked-notice');
                break;
            }

            // Outside the guided wizard, a card click only opens the character
            // sheet for viewing/editing — it must never ACTIVATE a chat.
            // selectCharacterById() (used above during the wizard's own flow)
            // calls getChat() internally and silently switches/opens a real
            // chat with that character; select_selected_character() populates
            // the same editor panel without ever calling getChat(). It also
            // never touches this_chid itself — noteViewingCharacterForPastChats
            // (session-state.js) is what eagerly keeps this_chid in sync with
            // whichever character's editor is shown (so native buttons like
            // Delete/Duplicate/Rename work), while still never loading a real
            // chat. Entering a chat is reserved for the Timeline tab's own
            // "Open Scene" button — there must be no other path in. Read the
            // current this_chid BEFORE selectCharacterForEditingOnly runs (it
            // doesn't touch this_chid, so ordering isn't strictly load-bearing
            // here, but this is the more obviously-correct order to preserve).
            const currentChid = getContext().characterId;
            selectCharacterForEditingOnly(characterId);
            noteViewingCharacterForPastChats(characterId, currentChid, setCharacterId);
            break;
        }
        case 'create-character':
            clickVanillaControl('rm_button_create');
            break;
        case 'import-character':
            clickVanillaControl('character_import_button');
            break;
        case 'external-import':
            clickVanillaControl('external_import_button');
            break;
        case 'create-group':
            clickVanillaControl('rm_button_group_chats');
            break;
        case 'toggle-search':
            clickVanillaControl('rm_button_search');
            break;
        case 'toggle-grid':
            clickVanillaControl('charListGridToggle');
            break;
        case 'bulk-edit':
            clickVanillaControl('bulkEditButton');
            break;
        default:
            break;
    }

    queueRender();
}

function handleCharacterFieldChange(field) {
    switch (field.dataset.remodelCharacterField) {
        case 'search':
            setCharacterSearchQuery(field.value || '');
            break;
        case 'sort':
            setCharacterSortMode(field.value || 'name-asc');
            break;
        default:
            break;
    }

    queueRender();
}

function clickVanillaControl(id) {
    const control = document.getElementById(id);

    if (!control) {
        return;
    }

    control.click();
}

// #right-nav-panel is restyled (style.css) into a full-screen centered modal
// whenever the native Create/Edit Character form (#rm_ch_create_block) is
// showing — including when a character is selected from our deck, since
// selectCharacterById() flips that same block into edit mode natively. In
// native ST's own inline layout this was never a modal (the panel just sat
// beside the always-visible character list), so there was never a close
// affordance built into the form itself — no cancel/close button exists in
// index.html at all. Clicking rm_button_characters (native "Select/Create
// Characters" control) resets the panel back to the list view, which our
// CSS's :has() reveal rule then hides again — that's the actual "close".
function ensureCharacterEditorCancelButton() {
    const header = document.getElementById('rm_PinAndTabs');

    if (!header || document.getElementById('remodel-character-editor-cancel')) {
        return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'remodel-character-editor-cancel';
    button.className = 'remodel-character-editor-cancel';
    button.title = 'Close';
    button.setAttribute('aria-label', 'Close character editor');
    button.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    header.append(button);
}

function askForTitle(message, fallback) {
    const title = prompt(message, fallback);

    if (title === null) {
        return null;
    }

    return title.trim() || fallback;
}

async function handleFieldChange(field) {
    const fieldName = field.dataset.remodelTimelineField;
    const value = field.value;

    switch (fieldName) {
        case 'draft-title':
            setCreateModalDraft({ ...getSessionState().createModalDraft, title: value });
            break;
        case 'draft-description':
            setCreateModalDraft({ ...getSessionState().createModalDraft, description: value });
            break;
        case 'timeline-title':
            updateTimeline(field.dataset.timelineId, { title: value });
            break;
        case 'timeline-description':
            updateTimeline(field.dataset.timelineId, { description: value });
            break;
        case 'arc-title':
            updateArc(field.dataset.arcId, { title: value });
            break;
        case 'arc-summary':
            updateArc(field.dataset.arcId, { summary: value });
            break;
        default:
            break;
    }

    queueRender();
}

async function handlePhotoChange(input) {
    const file = input.files?.[0];

    if (!file) {
        return;
    }

    const dataUrl = await readFileAsDataUrl(file);

    if (input.dataset.remodelPhotoTarget === 'draft') {
        setCreateModalDraft({ ...getSessionState().createModalDraft, thumbnail: dataUrl });
    } else if (input.dataset.timelineId) {
        updateTimeline(input.dataset.timelineId, { thumbnail: dataUrl });
    }

    queueRender();
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function renderTimelinePanel() {
    const content = document.getElementById(CONTENT_ID);

    if (!content) {
        return;
    }

    const store = getTimelineStore();

    const viewport = ensureViewportShell(content);

    ensureFocusedTimelineIsValid(store);

    const { activeTavernTab, focusedTimelineId, renamingSceneId } = getSessionState();

    const isTimelineFocused = activeTavernTab === 'timeline' && Boolean(focusedTimelineId);
    const isHeaderCollapsed = isTimelineFocused
        || activeTavernTab === 'characters'
        || activeTavernTab === 'prompts'
        || Boolean(TAVERN_TABS.find((tab) => tab.id === activeTavernTab)?.panelId);
    viewport.classList.toggle('is-header-collapsed', isHeaderCollapsed);
    viewport.classList.toggle('is-personas-workspace', activeTavernTab === 'personas');
    viewport.classList.toggle('is-lorebooks-workspace', activeTavernTab === 'lorebooks');

    // Header and tabs are persistent so their collapse/slide animates; only their
    // active state and the body content are re-rendered on each pass.
    const tabsNav = viewport.querySelector('.remodel-tavern-tabs');
    tabsNav.innerHTML = renderTavernTabs();

    const body = viewport.querySelector('.remodel-tavern-body');
    body.innerHTML = renderActiveWorkspace(store);

    if (activeTavernTab === 'timeline' || activeTavernTab === 'characters' || activeTavernTab === 'prompts') {
        restoreAdoptedPanel();
    } else {
        adoptLegacyPanel(activeTavernTab);
    }

    if (renamingSceneId) {
        const input = body.querySelector('.remodel-scene-rename-input');

        if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
        }
    }
}

function ensureViewportShell(content) {
    let viewport = content.querySelector('.remodel-tavern-viewport');

    if (viewport) {
        return viewport;
    }

    content.innerHTML = `
        <div class="remodel-tavern-viewport">
            <header class="remodel-tavern-header">
                <h1>Silly Tavern</h1>
            </header>
            <nav class="remodel-tavern-tabs" aria-label="Tavern sections"></nav>
            <div class="remodel-tavern-body"></div>
        </div>
    `;

    return content.querySelector('.remodel-tavern-viewport');
}

function renderTavernTabs() {
    const { activeTavernTab } = getSessionState();

    return TAVERN_TABS.map((tab) => `
        <button
            type="button"
            class="remodel-tavern-tab ${activeTavernTab === tab.id ? 'is-active' : ''}"
            data-remodel-tavern-tab="${escapeAttribute(tab.id)}"
        >
            <i class="fa-solid ${escapeAttribute(tab.icon)}" aria-hidden="true"></i>
            <span>${escapeHtml(tab.label)}</span>
        </button>
    `).join('');
}

function renderActiveWorkspace(store) {
    const { activeTavernTab } = getSessionState();

    if (activeTavernTab === 'timeline') {
        return renderTimelineWorkspace(store);
    }

    if (activeTavernTab === 'characters') {
        return renderCharactersWorkspace();
    }

    if (activeTavernTab === 'prompts') {
        return renderPromptStudioWorkspace();
    }

    if (activeTavernTab === 'personas') {
        return renderPersonasWorkspace();
    }

    if (activeTavernTab === 'lorebooks') {
        return renderLorebooksWorkspace();
    }

    return renderLegacyWorkspace();
}

function ensureFocusedTimelineIsValid(store) {
    const { focusedTimelineId } = getSessionState();

    if (focusedTimelineId && !store.timelines[focusedTimelineId]) {
        setFocusedTimelineId(null);
    }
}

function renderTimelineWorkspace(store) {
    ensureFocusedTimelineIsValid(store);

    const { focusedTimelineId } = getSessionState();

    if (focusedTimelineId) {
        return renderTimelineFocus(store.timelines[focusedTimelineId], store);
    }

    return renderTimelineDeck(store);
}

function renderTimelineDeck(store) {
    const { createModalOpen } = getSessionState();

    return `
        <section class="remodel-tavern-section remodel-tavern-timeline-section">
            <div class="remodel-timeline-deck" role="list" aria-label="Timelines">
                ${store.timelineIds.map((timelineId, index) => renderTimelineCard(store.timelines[timelineId], store, index + 1)).join('')}
                ${renderAddTimelineCard()}
            </div>
        </section>
        ${createModalOpen ? renderCreateTimelineModal() : ''}
    `;
}

function renderCardFlourishes() {
    return `
        <span class="remodel-card-corner remodel-card-corner-tl" aria-hidden="true"></span>
        <span class="remodel-card-corner remodel-card-corner-tr" aria-hidden="true"></span>
        <span class="remodel-card-corner remodel-card-corner-bl" aria-hidden="true"></span>
        <span class="remodel-card-corner remodel-card-corner-br" aria-hidden="true"></span>
        <span class="remodel-card-sparkle remodel-card-sparkle-1" aria-hidden="true"></span>
        <span class="remodel-card-sparkle remodel-card-sparkle-2" aria-hidden="true"></span>
        <span class="remodel-card-sparkle remodel-card-sparkle-3" aria-hidden="true"></span>
    `;
}

function renderTimelineCard(timeline, store, order) {
    if (!timeline) {
        return '';
    }

    const arcCount = timeline.arcIds.length;
    const sceneCount = timeline.arcIds.reduce((total, arcId) => total + (store.arcs[arcId]?.sceneIds.length || 0), 0);
    const hasImage = Boolean(timeline.thumbnail);
    const rootStyle = `--card-hue: ${hashHue(timeline.id)};${hasImage ? ` --card-image: url('${escapeAttribute(timeline.thumbnail)}');` : ''}`;

    return `
        <div
            class="remodel-timeline-card"
            role="button"
            tabindex="0"
            aria-label="Open Timeline ${escapeAttribute(timeline.title)}"
            style="${rootStyle}"
            data-remodel-timeline-action="open-timeline"
            data-timeline-id="${escapeAttribute(timeline.id)}"
        >
            <div class="remodel-timeline-card-frame">
                <div class="remodel-timeline-card-art ${hasImage ? 'has-image' : ''}"></div>
                <div class="remodel-timeline-card-numeral">${toRoman(order)}</div>
                ${renderCardFlourishes()}
                <div class="remodel-timeline-card-plate">
                    <div class="remodel-timeline-card-title">${escapeHtml(timeline.title)}</div>
                    <div class="remodel-timeline-card-meta">${arcCount} Arc${arcCount === 1 ? '' : 's'} · ${sceneCount} Scene${sceneCount === 1 ? '' : 's'}</div>
                </div>
            </div>
        </div>
    `;
}

function renderAddTimelineCard() {
    return `
        <div
            class="remodel-timeline-card remodel-timeline-card-add"
            role="button"
            tabindex="0"
            aria-label="Create new Timeline"
            data-remodel-timeline-action="open-create-timeline"
        >
            <div class="remodel-timeline-card-frame">
                ${renderCardFlourishes()}
                <div class="remodel-timeline-card-add-motif" aria-hidden="true">
                    <span class="remodel-timeline-card-add-plus">+</span>
                </div>
                <div class="remodel-timeline-card-plate">
                    <div class="remodel-timeline-card-title">New</div>
                </div>
            </div>
        </div>
    `;
}

function renderCreateTimelineModal() {
    const { createModalDraft } = getSessionState();

    return `
        <div class="remodel-modal-scrim" data-remodel-timeline-action="cancel-create-timeline">
            <div class="remodel-floating-card is-modal" data-remodel-modal-stop>
                ${renderFloatingCardFields({
        mode: 'draft',
        name: createModalDraft.title,
        description: createModalDraft.description,
        thumbnail: createModalDraft.thumbnail,
    })}
                <div class="remodel-floating-card-actions">
                    <button type="button" class="remodel-text-button" data-remodel-timeline-action="cancel-create-timeline">Cancel</button>
                    <button type="button" class="menu_button" data-remodel-timeline-action="submit-create-timeline">Create</button>
                </div>
            </div>
        </div>
    `;
}

function renderCharactersWorkspace() {
    const { characterSearchQuery } = getSessionState();
    const context = getContext();
    const characters = getSortedCharacters(context.characters || []);
    const favorites = getFavoriteCharacters(context.characters || []);

    return `
        <section class="remodel-tavern-section remodel-characters-workspace ${favorites.length ? 'has-favorites' : ''}" aria-label="Characters">
            <div class="remodel-characters-toolbar" aria-label="Character controls">
                <button type="button" class="remodel-icon-button" title="Create Character" aria-label="Create Character" data-remodel-character-action="create-character">
                    <i class="fa-solid fa-user-plus" aria-hidden="true"></i>
                </button>
                <button type="button" class="remodel-icon-button" title="Import Character" aria-label="Import Character" data-remodel-character-action="import-character">
                    <i class="fa-solid fa-file-import" aria-hidden="true"></i>
                </button>
                <button type="button" class="remodel-icon-button" title="Import from URL" aria-label="Import from URL" data-remodel-character-action="external-import">
                    <i class="fa-solid fa-cloud-arrow-down" aria-hidden="true"></i>
                </button>
                <button type="button" class="remodel-icon-button" title="Create Group" aria-label="Create Group" data-remodel-character-action="create-group">
                    <i class="fa-solid fa-users-gear" aria-hidden="true"></i>
                </button>
                <label class="remodel-characters-search">
                    <span>Search</span>
                    <input type="search" value="${escapeAttribute(characterSearchQuery)}" data-remodel-character-field="search" autocomplete="off">
                </label>
                <label class="remodel-characters-sort">
                    <span>Sort</span>
                    <select data-remodel-character-field="sort">
                        ${renderCharacterSortOption('name-asc', 'A-Z')}
                        ${renderCharacterSortOption('name-desc', 'Z-A')}
                        ${renderCharacterSortOption('recent-desc', 'Recent')}
                        ${renderCharacterSortOption('tokens-desc', 'Most Tokens')}
                        ${renderCharacterSortOption('tokens-asc', 'Least Tokens')}
                    </select>
                </label>
                <button type="button" class="remodel-icon-button" title="Bulk Edit" aria-label="Bulk Edit" data-remodel-character-action="bulk-edit">
                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                </button>
            </div>
            ${renderFavoritesStrip(favorites, context)}
            <div class="remodel-character-deck" role="list" aria-label="Character deck">
                ${characters.length ? characters.map((entry) => renderCharacterColumn(entry, context)).join('') : renderCharactersEmpty()}
            </div>
        </section>
    `;
}

function getFavoriteCharacters(characters) {
    return characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => character && (character.fav === true || character.fav === 'true'));
}

function renderFavoritesStrip(favorites, context) {
    if (!favorites.length) {
        return '';
    }

    return `
        <div class="remodel-characters-favorites" aria-label="Favorite characters">
            <span class="remodel-characters-favorites-label">Favorites</span>
            <div class="remodel-characters-favorites-row" role="list">
                ${favorites.map(({ character, index }) => renderFavoriteAvatar(character, index, context)).join('')}
            </div>
        </div>
    `;
}

function renderFavoriteAvatar(character, index, context) {
    // Suppressed while the viewing-only bridge owns this_chid — otherwise a
    // character merely being browsed (not really active) would incorrectly
    // light up as "the active chat" here.
    const isActive = String(context.characterId) === String(index) && !isPastChatsBridgeActive();
    const hasAvatar = Boolean(character?.avatar) && character.avatar !== 'none';
    const avatarStyle = hasAvatar ? `background-image: url('${escapeAttribute(context.getThumbnailUrl('avatar', character.avatar))}')` : '';

    return `
        <button
            type="button"
            class="remodel-favorite-avatar ${isActive ? 'is-active' : ''}"
            role="listitem"
            title="${escapeAttribute(character?.name || 'Unnamed')}"
            style="${avatarStyle}"
            data-remodel-character-action="select-character"
            data-character-id="${escapeAttribute(index)}"
        ></button>
    `;
}

function renderCharacterSortOption(value, label) {
    const { characterSortMode } = getSessionState();
    return `<option value="${escapeAttribute(value)}" ${characterSortMode === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function getSortedCharacters(characters) {
    const query = getSessionState().characterSearchQuery.trim().toLowerCase();
    const entries = characters
        .map((character, index) => ({ character, index }))
        .filter(({ character }) => {
            if (!character) {
                return false;
            }

            if (!query) {
                return true;
            }

            return [
                character.name,
                character.avatar,
                character.description,
                character.creator,
                character.tags?.join?.(' '),
            ].some((value) => String(value || '').toLowerCase().includes(query));
        });

    entries.sort((left, right) => compareCharacterEntries(left, right));
    return entries;
}

function compareCharacterEntries(left, right) {
    const leftName = String(left.character?.name || '').toLocaleLowerCase();
    const rightName = String(right.character?.name || '').toLocaleLowerCase();

    switch (getSessionState().characterSortMode) {
        case 'name-desc':
            return rightName.localeCompare(leftName);
        case 'recent-desc':
            return getCharacterDateValue(right.character?.date_last_chat) - getCharacterDateValue(left.character?.date_last_chat);
        case 'tokens-desc':
            return Number(right.character?.data_size || 0) - Number(left.character?.data_size || 0);
        case 'tokens-asc':
            return Number(left.character?.data_size || 0) - Number(right.character?.data_size || 0);
        case 'name-asc':
        default:
            return leftName.localeCompare(rightName);
    }
}

function getCharacterDateValue(value) {
    const numericValue = Number(value || 0);

    if (Number.isFinite(numericValue) && numericValue > 0) {
        return numericValue;
    }

    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderCharacterColumn({ character, index }, context) {
    // Same reasoning as renderFavoriteAvatar above.
    const isActive = String(context.characterId) === String(index) && !isPastChatsBridgeActive();
    const name = character?.name || 'Unnamed';
    const hasAvatar = Boolean(character?.avatar) && character.avatar !== 'none';
    const bgStyle = hasAvatar ? `--character-bg: url('${escapeAttribute(context.getThumbnailUrl('avatar', character.avatar))}')` : '';
    const subtitle = getCharacterSubtitle(character);
    const meta = getCharacterMeta(character);

    return `
        <button
            type="button"
            class="remodel-character-column ${isActive ? 'is-active' : ''} ${hasAvatar ? 'has-image' : ''}"
            role="listitem"
            style="${bgStyle}"
            data-remodel-character-action="select-character"
            data-character-id="${escapeAttribute(index)}"
        >
            <span class="remodel-character-bg" aria-hidden="true"></span>
            <span class="remodel-character-content">
                <span class="remodel-character-name">${escapeHtml(name)}</span>
                <span class="remodel-character-subtitle">${escapeHtml(subtitle)}</span>
                <span class="remodel-character-meta">${escapeHtml(meta)}</span>
            </span>
        </button>
    `;
}

function getCharacterSubtitle(character) {
    const source = character?.creator_notes || character?.description || character?.personality || '';
    const clean = String(source).replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 86) : 'No character notes yet';
}

function getCharacterMeta(character) {
    const tokens = Number(character?.data_size || 0);
    const chats = Number(character?.chat_size || 0);
    const parts = [];

    if (tokens) {
        parts.push(`${tokens.toLocaleString()} tokens`);
    }

    if (chats) {
        parts.push(`${chats.toLocaleString()} chats`);
    }

    return parts.join(' · ') || 'Ready';
}

function renderCharactersEmpty() {
    return `
        <div class="remodel-characters-empty">
            <span>No characters match this search.</span>
        </div>
    `;
}

function renderFloatingCardFields({ mode, name, description, thumbnail, timelineId }) {
    const nameField = mode === 'draft' ? 'draft-title' : 'timeline-title';
    const descriptionField = mode === 'draft' ? 'draft-description' : 'timeline-description';
    const idAttr = timelineId ? `data-timeline-id="${escapeAttribute(timelineId)}"` : '';
    const photoTargetAttr = mode === 'draft' ? 'data-remodel-photo-target="draft"' : idAttr;
    const thumbStyle = thumbnail ? `background-image: url('${escapeAttribute(thumbnail)}')` : '';

    return `
        <label class="remodel-floating-card-photo" style="${thumbStyle}">
            <input type="file" accept="image/*" data-remodel-timeline-photo-input ${photoTargetAttr} hidden>
            ${thumbnail ? '' : '<span class="remodel-floating-card-photo-hint">Add Photo</span>'}
        </label>
        <input
            type="text"
            class="remodel-floating-card-name"
            placeholder="Timeline name"
            value="${escapeAttribute(name)}"
            data-remodel-timeline-field="${nameField}"
            ${idAttr}
            aria-label="Timeline name"
        >
        <textarea
            class="remodel-floating-card-description"
            rows="3"
            placeholder="Describe this Timeline…"
            data-remodel-timeline-field="${descriptionField}"
            ${idAttr}
        >${escapeHtml(description || '')}</textarea>
    `;
}

function renderFloatingField({ value, label, fieldName, dataAttr = '', multiline = false, rows = 2, inputClass = '' }) {
    const control = multiline
        ? `<textarea class="remodel-field-input ${inputClass}" rows="${rows}" placeholder=" " data-remodel-timeline-field="${escapeAttribute(fieldName)}" ${dataAttr}>${escapeHtml(value || '')}</textarea>`
        : `<input type="text" class="remodel-field-input ${inputClass}" value="${escapeAttribute(value || '')}" placeholder=" " data-remodel-timeline-field="${escapeAttribute(fieldName)}" ${dataAttr}>`;

    return `
        <label class="remodel-field ${multiline ? 'is-multiline' : ''}">
            ${control}
            <span class="remodel-field-label">${escapeHtml(label)}</span>
        </label>
    `;
}

function renderTimelineFocus(timeline, store) {
    const hasImage = Boolean(timeline.thumbnail);
    const rootStyle = `--card-hue: ${hashHue(timeline.id)};${hasImage ? ` --card-image: url('${escapeAttribute(timeline.thumbnail)}');` : ''}`;

    return `
        <div class="remodel-timeline-focus ${hasImage ? 'has-image' : ''}" style="${rootStyle}">
            <div class="remodel-focus-backdrop" aria-hidden="true"></div>
            <article class="remodel-bigcard">
                <span class="remodel-card-corner remodel-card-corner-tl" aria-hidden="true"></span>
                <span class="remodel-card-corner remodel-card-corner-tr" aria-hidden="true"></span>
                <span class="remodel-card-corner remodel-card-corner-bl" aria-hidden="true"></span>
                <span class="remodel-card-corner remodel-card-corner-br" aria-hidden="true"></span>
                <div class="remodel-bigcard-toolbar">
                    <button type="button" class="remodel-icon-button" title="Back to Timelines" aria-label="Back to Timelines" data-remodel-timeline-action="close-timeline">
                        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="remodel-bigcard-toolbar-right">
                        <label class="remodel-icon-button remodel-bigcard-photo" title="Change photo">
                            <input type="file" accept="image/*" data-remodel-timeline-photo-input data-timeline-id="${escapeAttribute(timeline.id)}" hidden>
                            <i class="fa-solid fa-image" aria-hidden="true"></i>
                        </label>
                        <button type="button" class="remodel-icon-button danger" title="Delete Timeline" aria-label="Delete Timeline" data-remodel-timeline-action="delete-timeline" data-timeline-id="${escapeAttribute(timeline.id)}">
                            <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <div class="remodel-bigcard-body">
                    <header class="remodel-bigcard-head">
                        ${renderFloatingField({
        value: timeline.title,
        label: 'Timeline Name',
        fieldName: 'timeline-title',
        dataAttr: `data-timeline-id="${escapeAttribute(timeline.id)}"`,
        inputClass: 'remodel-bigcard-title',
    })}
                        ${renderFloatingField({
        value: timeline.description,
        label: 'Description',
        fieldName: 'timeline-description',
        dataAttr: `data-timeline-id="${escapeAttribute(timeline.id)}"`,
        multiline: true,
        rows: 2,
        inputClass: 'remodel-bigcard-description',
    })}
                    </header>
                    <div class="remodel-bigcard-divider" aria-hidden="true"></div>
                    <div class="remodel-bigcard-arcs">
                        ${timeline.arcIds.map((arcId) => renderArcCol(store.arcs[arcId], store, timeline)).join('')}
                        ${renderAddArcCol(timeline)}
                    </div>
                </div>
            </article>
        </div>
    `;
}

function renderArcCol(arc, store, timeline) {
    if (!arc) {
        return '';
    }

    return `
        <section class="remodel-arc-col ${timeline.activeArcId === arc.id ? 'is-active' : ''}">
            <button type="button" class="remodel-icon-button remodel-arc-del" title="Delete Arc" aria-label="Delete Arc" data-remodel-timeline-action="delete-arc" data-arc-id="${escapeAttribute(arc.id)}">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
            ${renderFloatingField({
        value: arc.title,
        label: 'Arc',
        fieldName: 'arc-title',
        dataAttr: `data-arc-id="${escapeAttribute(arc.id)}"`,
        inputClass: 'remodel-arc-col-title',
    })}
            <div class="remodel-scene-list">
                ${arc.sceneIds.map((sceneId) => renderSceneRow(store.scenes[sceneId], timeline)).join('')}
            </div>
            <div class="remodel-arc-col-actions">
                <button type="button" class="remodel-text-button" data-remodel-timeline-action="create-scene" data-mode="roleplay" data-arc-id="${escapeAttribute(arc.id)}">+ Roleplay</button>
                <button type="button" class="remodel-text-button" data-remodel-timeline-action="create-scene" data-mode="story" data-arc-id="${escapeAttribute(arc.id)}">+ Story</button>
            </div>
        </section>
    `;
}

function renderAddArcCol(timeline) {
    return `
        <button
            type="button"
            class="remodel-arc-col remodel-arc-col-add"
            aria-label="Add Arc"
            data-remodel-timeline-action="create-arc"
            data-timeline-id="${escapeAttribute(timeline.id)}"
        >
            <span class="remodel-arc-col-add-icon"><i class="fa-solid fa-plus" aria-hidden="true"></i></span>
            <span class="remodel-arc-col-add-label">Add Arc</span>
        </button>
    `;
}

function renderLegacyWorkspace() {
    const tab = TAVERN_TABS.find((item) => item.id === getSessionState().activeTavernTab);

    return `
        <section class="remodel-tavern-section remodel-tavern-legacy-section">
            <div class="remodel-timeline-header">
                <div>
                    <div class="remodel-timeline-kicker">Workspace</div>
                    <h3>${escapeHtml(tab?.label || 'Tavern')}</h3>
                </div>
            </div>
            <div id="${LEGACY_OUTLET_ID}" class="remodel-tavern-legacy-outlet"></div>
        </section>
    `;
}

function renderPersonasWorkspace() {
    return `
        <section class="remodel-personas-workspace" aria-label="Personas workspace">
            <div id="${LEGACY_OUTLET_ID}" class="remodel-tavern-legacy-outlet remodel-personas-outlet"></div>
        </section>
    `;
}

function renderLorebooksWorkspace() {
    return `
        <section class="remodel-lorebooks-workspace" aria-label="Lorebooks workspace">
            <div class="remodel-lorebooks-current" aria-live="polite">
                <span>Editing</span>
                <strong data-remodel-lorebooks-current>No lorebook selected</strong>
            </div>
            <nav class="remodel-lorebooks-dock" aria-label="Lorebook utilities">
                <button type="button" data-remodel-lorebooks-panel="library" aria-expanded="false" title="Lorebook library and file actions">
                    <i class="fa-solid fa-book-bookmark" aria-hidden="true"></i>
                    <span>Library</span>
                </button>
                <button type="button" data-remodel-lorebooks-panel="settings" aria-expanded="false" title="Global World Info settings">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                    <span>World settings</span>
                </button>
            </nav>
            <div id="${LEGACY_OUTLET_ID}" class="remodel-tavern-legacy-outlet remodel-lorebooks-outlet"></div>
        </section>
    `;
}

function toggleLorebooksUtilityPanel(panelName) {
    const workspace = document.querySelector('.remodel-lorebooks-workspace');

    if (!workspace || !['library', 'settings'].includes(panelName)) {
        return;
    }

    const activeClass = panelName === 'library' ? 'is-library-open' : 'is-settings-open';
    const shouldOpen = !workspace.classList.contains(activeClass);
    workspace.classList.remove('is-library-open', 'is-settings-open');

    if (shouldOpen) {
        workspace.classList.add(activeClass);
    }

    workspace.querySelectorAll('[data-remodel-lorebooks-panel]').forEach((button) => {
        const buttonClass = button.dataset.remodelLorebooksPanel === 'library' ? 'is-library-open' : 'is-settings-open';
        button.setAttribute('aria-expanded', String(workspace.classList.contains(buttonClass)));
    });
}

function syncLorebooksWorkspaceMeta(panel) {
    const label = document.querySelector('[data-remodel-lorebooks-current]');
    const select = panel?.querySelector('#world_editor_select');

    if (!label || !(select instanceof HTMLSelectElement)) {
        return;
    }

    const selected = select.selectedOptions?.[0];
    const hasSelection = Boolean(selected?.value);
    label.textContent = hasSelection ? selected.textContent?.trim() || 'Untitled lorebook' : 'No lorebook selected';
}

function attachLorebooksWorkspaceAdapter(panel) {
    syncLorebooksWorkspaceMeta(panel);

    if (panel.dataset.remodelLorebooksAdapterBound === 'true') {
        return;
    }

    const select = panel.querySelector('#world_editor_select');
    if (select) {
        $(select).off('change.remodelLorebooks').on('change.remodelLorebooks', () => syncLorebooksWorkspaceMeta(panel));
    }
    panel.dataset.remodelLorebooksAdapterBound = 'true';
}

function hasRequiredPersonaWorkspaceAnchors(panel) {
    const requiredSelectors = [
        '#persona-management-block',
        '.persona_management_left_column',
        '.persona_management_right_column',
        '#user_avatar_block',
        '#persona_controls',
        '#persona_description',
    ];

    return requiredSelectors.every((selector) => panel.querySelector(selector));
}

function hasRequiredLorebooksWorkspaceAnchors(panel) {
    const requiredSelectors = [
        '#wi-holder',
        '#wiTopBlock',
        '#WIMultiSelector',
        '#world_info',
        '#world_popup',
        '#world_editor_select',
        '#world_info_search',
        '#world_popup_entries_list',
    ];

    return requiredSelectors.every((selector) => panel.querySelector(selector));
}

function adoptLegacyPanel(tabId) {
    const tab = TAVERN_TABS.find((item) => item.id === tabId);
    const outlet = document.getElementById(LEGACY_OUTLET_ID);
    const panel = tab?.panelId ? document.getElementById(tab.panelId) : null;

    if (!outlet || !panel) {
        restoreAdoptedPanel();
        outlet?.append(renderMissingLegacyPanel(tab?.label || 'Panel'));
        return;
    }

    if (tabId === 'personas' && !hasRequiredPersonaWorkspaceAnchors(panel)) {
        restoreAdoptedPanel();
        outlet.append(renderMissingLegacyPanel('Personas'));
        return;
    }

    if (tabId === 'lorebooks' && !hasRequiredLorebooksWorkspaceAnchors(panel)) {
        restoreAdoptedPanel();
        outlet.append(renderMissingLegacyPanel('Lorebooks'));
        return;
    }

    const { adoptedPanel } = getSessionState();

    if (adoptedPanel && adoptedPanel !== panel) {
        restoreAdoptedPanel();
    }

    const originalPanelHomes = getOriginalPanelHomes();

    if (!originalPanelHomes.has(panel)) {
        originalPanelHomes.set(panel, {
            parent: panel.parentElement,
            nextSibling: panel.nextSibling,
        });
    }

    setAdoptedPanel(panel);
    panel.classList.add('remodel-tavern-adopted-panel', 'openDrawer');
    panel.classList.remove('closedDrawer', 'remodel-side-left', 'remodel-side-right');
    outlet.append(panel);

    if (tabId === 'lorebooks') {
        attachLorebooksWorkspaceAdapter(panel);
    }
}

function restoreAdoptedPanel() {
    const { adoptedPanel } = getSessionState();

    if (!adoptedPanel) {
        return;
    }

    const panel = adoptedPanel;
    const home = getOriginalPanelHomes().get(panel);

    panel.classList.remove('remodel-tavern-adopted-panel', 'openDrawer');
    panel.classList.add('closedDrawer');

    if (home?.parent) {
        home.parent.insertBefore(panel, home.nextSibling);
    }

    setAdoptedPanel(null);
}

function renderMissingLegacyPanel(label) {
    const missing = document.createElement('div');
    missing.className = 'remodel-timeline-empty compact';
    missing.textContent = `${label} is not available yet.`;
    return missing;
}

function renderSceneRow(scene, timeline) {
    if (!scene) {
        return '';
    }

    const isActive = timeline.activeSceneId === scene.id;
    const bindingLabel = getLinkedChatLabel(scene);
    const isRenaming = scene.id === getSessionState().renamingSceneId;

    const main = isRenaming
        ? `
            <div class="remodel-scene-main remodel-scene-main-rename">
                <input
                    type="text"
                    class="remodel-scene-rename-input"
                    value="${escapeAttribute(scene.title)}"
                    data-scene-id="${escapeAttribute(scene.id)}"
                    aria-label="Scene name"
                >
            </div>
        `
        : `
            <button
                type="button"
                class="remodel-scene-main"
                data-remodel-timeline-action="select-scene"
                data-scene-id="${escapeAttribute(scene.id)}"
            >
                <span class="remodel-scene-title">${escapeHtml(scene.title)}</span>
                <span class="remodel-scene-meta">
                    <span class="remodel-mode-pill ${scene.mode}">${escapeHtml(scene.mode)}</span>
                    <span>${escapeHtml(bindingLabel)}</span>
                </span>
            </button>
        `;

    return `
        <div class="remodel-scene-row ${isActive ? 'is-active' : ''} ${scene.status === 'missing' ? 'is-missing' : ''}">
            ${main}
            <div class="remodel-scene-row-actions">
                <button type="button" class="remodel-icon-button remodel-scene-del" title="Delete Scene" aria-label="Delete Scene" data-remodel-timeline-action="delete-scene" data-scene-id="${escapeAttribute(scene.id)}">×</button>
                <button type="button" class="remodel-icon-button" title="Open Scene" data-remodel-timeline-action="open-scene" data-scene-id="${escapeAttribute(scene.id)}">↗</button>
            </div>
        </div>
    `;
}

async function enterSceneViewport() {
    // Loading a chat (doNewChat/openCharacterChat/openGroupChat) incidentally flips
    // SillyTavern's native right-menu panel to the character-edit or group-chats
    // block as a side effect unrelated to us. Reset it to the (hidden) character
    // list so our own #right-nav-panel reveal rule — which reacts to that native
    // state — never mistakes the side effect for a deliberate Create Character click.
    clickVanillaControl('rm_button_characters');

    // Story and Roleplay scenes both just drop into plain native chat for now
    // — the dedicated Story Viewport (manuscript/adopted-chat screen) was
    // removed; scene.mode still exists as data for when that's rebuilt.
    await transitionToWindow({ kind: 'native' });
}

async function openScene(sceneId) {
    let scene = getScene(sceneId);

    if (!scene) {
        return;
    }

    // Story mode is document-only. New and migrated scenes open immediately;
    // a pre-StoryDoc scene first loads its archived linked chat below so that
    // it can be converted losslessly before entering the same editor.
    if (scene.mode === 'story' && (scene.storyDocId || !scene.linkedChat)) {
        await openStoryDocScene(sceneId);
        return;
    }

    if (!scene.linkedChat) {
        // Never-opened Roleplay Scene: let the user cast it. This replaces
        // the old behavior of silently anchoring to the first character in
        // the list — the cause of "every new roleplay opens the same
        // Co-Author chat." One character → a solo chat; several → a group.
        openRoleplayCastPicker({
            mode: 'create',
            onConfirm: (avatars) => beginRoleplaySceneWithCast(sceneId, avatars),
        });
        return;
    }

    const context = getContext();
    const linkedChat = scene.linkedChat;

    if (linkedChat.type === 'group') {
        const group = context.groups.find((item) => String(item.id) === String(linkedChat.groupId));

        // Match the chat id loosely (stored as string, core may hold number).
        const chatMatch = group?.chats?.find((c) => String(c) === String(linkedChat.chatId));
        if (!group || chatMatch === undefined) {
            updateScene(sceneId, { status: 'missing' });
            return;
        }

        setActiveScene(sceneId);
        // openGroupById selects the group and loads its current chat. If the
        // scene is bound to a specific, non-current chat within that group,
        // switch to it afterward (openGroupChat only works once the group is
        // already selected — which openGroupById has just done). Pass core's
        // own id types; its guards use strict === / includes().
        await openGroupById(group.id);
        if (String(group.chat_id) !== String(chatMatch)) {
            await context.openGroupChat(group.id, chatMatch);
        }
        await waitForChatIdSettled();
        writeSceneMetadata(scene);
        updateScene(sceneId, { status: 'active' });
        if (scene.mode === 'story') {
            migrateLoadedLegacyStoryScene(sceneId);
            await openStoryDocScene(sceneId);
        } else {
            await enterSceneViewport();
        }
        return;
    }

    const characterId = Number(linkedChat.characterId);

    if (!context.characters[characterId]) {
        updateScene(sceneId, { status: 'missing' });
        return;
    }

    const characterChats = await getPastCharacterChats(characterId);
    const hasChat = characterChats.some((chat) => String(chat.file_name).replace(/\.jsonl$/i, '') === linkedChat.fileName);

    if (!hasChat) {
        updateScene(sceneId, { status: 'missing' });
        return;
    }

    setActiveScene(sceneId);
    await context.selectCharacterById(characterId, { switchMenu: false });
    await context.openCharacterChat(linkedChat.fileName);
    writeSceneMetadata(scene);
    updateScene(sceneId, { status: 'active' });
    if (scene.mode === 'story') {
        migrateLoadedLegacyStoryScene(sceneId);
        await openStoryDocScene(sceneId);
    } else {
        await enterSceneViewport();
    }
}

// Casts a fresh roleplay scene from the picker's chosen characters. One
// character → a solo character chat (selectCharacterById + new chat, bound
// exactly like before). Two or more → a real group + a fresh group chat,
// bound to the scene. Either way the scene ends up with a linkedChat and
// drops into the viewport.
async function beginRoleplaySceneWithCast(sceneId, avatars) {
    const context = getContext();
    const scene = getScene(sceneId);
    if (!scene || !Array.isArray(avatars) || avatars.length === 0) {
        return;
    }

    if (avatars.length === 1) {
        // Solo: resolve the chosen character's id, select it, new chat, bind.
        const idx = (context.characters || []).findIndex((c) => c.avatar === avatars[0]);
        if (idx < 0) {
            return;
        }
        await context.selectCharacterById(idx, { switchMenu: false });
        await createNewChatForScene(sceneId);
        if (!getScene(sceneId)?.linkedChat) {
            return;
        }
        await enterSceneViewport();
        return;
    }

    // Group: create it, bind the scene to its fresh chat, open it.
    const groupId = await createRoleplayGroup(avatars, scene.title);
    if (!groupId) {
        return;
    }
    // Read the ids back off the real group object so they carry core's own
    // types — openGroupChat() looks the group up with a STRICT === on id and
    // includes() on chat id, so a stringified id silently fails that guard
    // and nothing opens (confirmed live: the group was created but never
    // entered). Pass group.id / group.chats[0] verbatim.
    const group = findRoleplayGroup(groupId);
    const nativeGroupId = group?.id ?? groupId;
    const nativeChatId = group?.chats?.[0] ?? group?.chat_id;
    if (nativeChatId === undefined || nativeChatId === null) {
        return;
    }
    updateScene(sceneId, {
        linkedChat: { type: 'group', groupId: String(nativeGroupId), chatId: String(nativeChatId) },
        status: 'active',
    });
    setActiveScene(sceneId);
    // openGroupById is the complete "switch to this group" entry point — it
    // sets selected_group AND loads the group's chat. context.openGroupChat
    // alone does NOT select the group (it only switches chats within an
    // already-selected group), so it silently no-ops for a just-created
    // group — confirmed live. A fresh group has exactly one chat, which
    // openGroupById opens.
    await openGroupById(nativeGroupId);
    await waitForChatIdSettled();
    writeSceneMetadata(getScene(sceneId));
    // openGroupById's CHAT_CHANGED can land before the scene metadata write
    // settles, so set the workspace class directly here too (idempotent).
    syncStoryWorkspaceClass(getScene(sceneId));
    await enterSceneViewport();
    renderRoleplayScene();
}

async function ensureActiveCharacterContext() {
    const context = getContext();

    // The definedness check alone isn't enough to mean "genuinely active" —
    // if a character is merely being browsed via the viewing-only bridge,
    // this_chid is defined but doesn't reflect a real chat. Without the
    // discriminator here, opening a never-before-opened Roleplay Scene while
    // some other character happens to be browsed in the background would
    // silently skip the auto-pick below and bind the new Scene to whoever
    // was browsed, instead of a deliberate choice.
    const hasGenuinelyActiveCharacter = context.characterId !== undefined
        && context.characterId !== null
        && !isPastChatsBridgeActive();

    if (context.groupId || hasGenuinelyActiveCharacter) {
        return;
    }

    const firstCharacterId = (context.characters || []).findIndex(Boolean);

    if (firstCharacterId === -1) {
        return;
    }

    await context.selectCharacterById(firstCharacterId, { switchMenu: false });
}

function bindCurrentChatToScene(sceneId, { silent = false } = {}) {
    const scene = getScene(sceneId);
    const linkedChat = getCurrentLinkedChat();

    if (!scene || !linkedChat) {
        if (!silent) {
            alert('Open a character or group chat before binding this Scene.');
        }
        return false;
    }

    const updatedScene = updateScene(sceneId, {
        linkedChat,
        status: 'active',
    });

    setActiveScene(sceneId);
    writeSceneMetadata(updatedScene);
    syncStoryWorkspaceClass(updatedScene);
    return true;
}

async function createNewChatForScene(sceneId) {
    const scene = getScene(sceneId);

    if (!scene) {
        return false;
    }

    await doNewChat();
    // doNewChat() resolves before context.chatId reflects the freshly-created
    // chat (the id is populated a tick later via core's own load flow), so
    // binding immediately would read a null linkedChat and no-op. Wait for
    // the chat identity to settle first — confirmed as the cause of a
    // roleplay Scene creating a chat on the right character but never binding.
    await waitForChatIdSettled();
    return bindCurrentChatToScene(sceneId, { silent: true });
}

// Polls (briefly) until a character chat identity is present, so a caller
// that just created/loaded a chat can rely on getCurrentLinkedChat().
async function waitForChatIdSettled(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const context = getContext();
        const ready = (context.groupId && context.chatId)
            || (context.characterId !== undefined && context.characterId !== null && context.chatId);
        if (ready) {
            return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 60));
    }
    return false;
}

// --- Roleplay group plumbing ---------------------------------------------
//
// These drive core's real group HTTP API directly (POST /api/groups/create
// and /api/groups/edit — the exact requests core's own createGroup()/_save()
// send), then refresh via getCharacters(). Core doesn't export createGroup
// or editGroup through getContext(), so replicating the request is the
// supported way for an extension to build/modify a group; getRequestHeaders
// and getCharacters ARE exposed, so this stays on public API surface.

// Group enum + default-avatar constants aren't exposed on context; mirror
// core's values (group-chats.js group_activation_strategy / _generation_mode,
// script.js default_avatar) so a group we create matches a natively-created
// one field-for-field.
const REMODEL_GROUP_ACTIVATION_NATURAL = 0;
const REMODEL_GROUP_GENERATION_SWAP = 0;
const REMODEL_DEFAULT_AVATAR = 'img/ai4.png';

// Creates a brand-new group from a list of character avatars and returns its
// id, without navigating anywhere. Mirrors core's createGroup() request body.
async function createRoleplayGroup(memberAvatars, name) {
    const context = getContext();
    const members = Array.isArray(memberAvatars) ? memberAvatars.filter(Boolean) : [];
    if (members.length === 0) {
        return null;
    }

    const memberNames = (context.characters || [])
        .filter((c) => members.includes(c.avatar))
        .map((c) => c.name)
        .join(', ');
    const chatName = `${Date.now()}`;

    const groupModel = {
        name: name || `Scene: ${memberNames}`,
        members,
        avatar_url: REMODEL_DEFAULT_AVATAR,
        allow_self_responses: false,
        hideMutedSprites: false,
        activation_strategy: REMODEL_GROUP_ACTIVATION_NATURAL,
        generation_mode: REMODEL_GROUP_GENERATION_SWAP,
        disabled_members: [],
        fav: false,
        chat_id: chatName,
        chats: [chatName],
        auto_mode_delay: 5,
    };

    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(groupModel),
    });
    if (!response.ok) {
        console.error('Remodel: group create failed', response.status);
        return null;
    }
    const data = await response.json();
    await context.getCharacters();
    return data?.id ?? null;
}

// Persists a modified group object (already mutated in place on
// context.groups) via core's own /api/groups/edit request, then refreshes.
async function saveRoleplayGroup(group) {
    const context = getContext();
    await fetch('/api/groups/edit', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(group),
    });
    await context.getCharacters();
}

function findRoleplayGroup(groupId) {
    return (getContext().groups || []).find((g) => String(g.id) === String(groupId)) || null;
}

// Resolves a character's avatar filename from a characterId or name.
function roleplayCharacterAvatar({ characterId, name } = {}) {
    const characters = getContext().characters || [];
    if (characterId !== undefined && characterId !== null && characters[Number(characterId)]) {
        return characters[Number(characterId)].avatar;
    }
    if (name) {
        return characters.find((c) => c.name === name)?.avatar ?? null;
    }
    return null;
}

// Adds a character (by avatar) to the CURRENT scene's cast. In a group,
// appends the member and reopens so the new cast takes effect. In a solo
// scene, promotes it: create a group of [existing solo character + new one],
// rebind the scene to a fresh group chat. Returns true on success.
async function addCharacterToRoleplayScene(newAvatar) {
    const context = getContext();
    const scene = getActiveScene();
    if (!scene || !newAvatar) {
        return false;
    }

    // Group scene: append member (guard against duplicates) + reload chat.
    if (context.groupId) {
        const group = findRoleplayGroup(context.groupId);
        if (!group) {
            return false;
        }
        if (group.members.includes(newAvatar)) {
            return false; // already in the cast
        }
        group.members = [...group.members, newAvatar];
        await saveRoleplayGroup(group);
        await context.reloadCurrentChat?.();
        renderRoleplayScene();
        return true;
    }

    // Solo scene: promote to a group. The current solo character plus the
    // new one form the group; a fresh group chat becomes the scene's chat.
    const soloAvatar = roleplayCharacterAvatar({ characterId: context.characterId });
    if (!soloAvatar || soloAvatar === newAvatar) {
        return false;
    }
    const groupId = await createRoleplayGroup([soloAvatar, newAvatar], scene.title);
    if (!groupId) {
        return false;
    }
    const group = findRoleplayGroup(groupId);
    // Native id/chat-id types — openGroupChat guards with strict === (see
    // beginRoleplaySceneWithCast).
    const nativeGroupId = group?.id ?? groupId;
    const nativeChatId = group?.chats?.[0] ?? group?.chat_id;
    if (nativeChatId === undefined || nativeChatId === null) {
        return false;
    }
    // Rebind the scene to the new group chat, then open it.
    updateScene(scene.id, {
        linkedChat: { type: 'group', groupId: String(nativeGroupId), chatId: String(nativeChatId) },
        status: 'active',
    });
    setActiveScene(scene.id);
    await openGroupById(nativeGroupId);
    await waitForChatIdSettled();
    writeSceneMetadata(getScene(scene.id));
    syncStoryWorkspaceClass(getScene(scene.id));
    renderRoleplayScene();
    return true;
}

// Removes a character (by avatar) from the current group scene. Core keeps a
// group valid down to a single member, so this is allowed until one remains;
// removing the last member is refused.
async function removeCharacterFromRoleplayScene(avatar) {
    const context = getContext();
    if (!context.groupId || !avatar) {
        return false;
    }
    const group = findRoleplayGroup(context.groupId);
    if (!group || !group.members.includes(avatar)) {
        return false;
    }
    if (group.members.length <= 1) {
        showRoleplayToast('A scene needs at least one character.');
        return false;
    }
    group.members = group.members.filter((m) => m !== avatar);
    // Keep disabled_members consistent so a removed member doesn't linger.
    group.disabled_members = (group.disabled_members || []).filter((m) => m !== avatar);
    await saveRoleplayGroup(group);
    await context.reloadCurrentChat?.();
    renderRoleplayScene();
    return true;
}

// Moves a cast member (by avatar) so it sits immediately before the member
// currently at targetAvatar (or to the end when targetAvatar is null).
// Reorders the group's members array in place and persists — this is the
// group's turn/activation order, so the change is meaningful, not cosmetic.
async function reorderRoleplayCast(movedAvatar, targetAvatar) {
    const context = getContext();
    if (!context.groupId || !movedAvatar || movedAvatar === targetAvatar) {
        return false;
    }
    const group = findRoleplayGroup(context.groupId);
    if (!group || !Array.isArray(group.members) || !group.members.includes(movedAvatar)) {
        return false;
    }

    const next = group.members.filter((m) => m !== movedAvatar);
    if (targetAvatar && next.includes(targetAvatar)) {
        next.splice(next.indexOf(targetAvatar), 0, movedAvatar);
    } else {
        next.push(movedAvatar); // dropped past the end
    }

    // No-op if order is unchanged (dropped onto its own position).
    if (next.length === group.members.length && next.every((m, i) => m === group.members[i])) {
        return false;
    }

    group.members = next;
    await saveRoleplayGroup(group);
    // Members array is the source of truth for cast order; a chat reload
    // isn't needed (no chat content changed), just re-render the column.
    renderRoleplayScene();
    return true;
}

// --- Roleplay cast picker (modal overlay) --------------------------------
//
// A tarot-styled character picker used both for scene creation (multi-select
// → "Begin scene") and for adding to an existing scene's cast ("+"). It's a
// self-contained overlay appended to <body>; selection state lives on the
// element, and the confirm/cancel result is delivered via a callback. This
// is deliberately Remodel's own UI (not core's native character list) so the
// aesthetic matches and multi-select actually works.

const ROLEPLAY_PICKER_ID = 'remodel-rp-cast-picker';

// mode: 'create' (choose a fresh cast) | 'add' (add to current scene).
// excludeAvatars: characters already in the scene (hidden in 'add' mode).
// onConfirm: (selectedAvatars: string[]) => void
function openRoleplayCastPicker({ mode = 'create', excludeAvatars = [], onConfirm } = {}) {
    document.getElementById(ROLEPLAY_PICKER_ID)?.remove();

    const context = getContext();
    const exclude = new Set(excludeAvatars);
    const characters = (context.characters || [])
        .filter((c) => c && c.avatar && c.avatar !== 'none' && !exclude.has(c.avatar));

    const overlay = document.createElement('div');
    overlay.id = ROLEPLAY_PICKER_ID;
    overlay.className = 'remodel-rp-picker-scrim';

    const title = mode === 'create' ? 'Cast your scene' : 'Add to the cast';
    const hint = mode === 'create'
        ? 'Choose one character for a solo scene, or several for a group.'
        : 'Choose one or more characters to bring into this scene.';
    const confirmLabel = mode === 'create' ? 'Begin scene' : 'Add to scene';

    const cards = characters.map((c) => {
        const hasImg = Boolean(c.avatar) && c.avatar !== 'none';
        const thumb = hasImg ? context.getThumbnailUrl('avatar', c.avatar) : '';
        return `
            <button type="button" class="remodel-rp-picker-card" data-remodel-rp-pick="${escapeAttribute(c.avatar)}" title="${escapeAttribute(c.name)}">
                <span class="remodel-rp-picker-av" ${thumb ? `style="background-image:url('${escapeAttribute(thumb)}')"` : ''}>${thumb ? '' : escapeHtml(roleplayInitials(c.name))}</span>
                <span class="remodel-rp-picker-name">${escapeHtml(c.name)}</span>
                <span class="remodel-rp-picker-check" aria-hidden="true">✓</span>
            </button>`;
    }).join('');

    overlay.innerHTML = `
        <div class="remodel-rp-picker" role="dialog" aria-modal="true" data-remodel-rp-picker-stop>
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">${escapeHtml(title)}</div>
                    <div class="remodel-rp-picker-hint">${escapeHtml(hint)}</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-rp-picker-cancel aria-label="Close">×</button>
            </div>
            <input type="text" class="remodel-rp-picker-search" data-remodel-rp-picker-search placeholder="Search characters…" spellcheck="false" />
            <div class="remodel-rp-picker-grid" data-remodel-rp-picker-grid>
                ${cards || '<div class="remodel-rp-picker-empty">No other characters available.</div>'}
            </div>
            <div class="remodel-rp-picker-foot">
                <span class="remodel-rp-picker-count" data-remodel-rp-picker-count>None selected</span>
                <div class="remodel-rp-picker-actions">
                    <button type="button" class="remodel-rp-picker-btn" data-remodel-rp-picker-cancel>Cancel</button>
                    <button type="button" class="remodel-rp-picker-btn remodel-rp-picker-go" data-remodel-rp-picker-confirm disabled>${escapeHtml(confirmLabel)}</button>
                </div>
            </div>
        </div>
    `;

    // Selection + wiring. Stored on the element so the delegated document
    // listener (bindRoleplayCastPickerEvents) can read/update it.
    overlay._remodelPicker = { selected: new Set(), onConfirm, mode };
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));
    overlay.querySelector('[data-remodel-rp-picker-search]')?.focus();
}

function closeRoleplayCastPicker() {
    const overlay = document.getElementById(ROLEPLAY_PICKER_ID);
    if (!overlay) {
        return;
    }
    overlay.classList.remove('remodel-rp-picker-in');
    setTimeout(() => overlay.remove(), 200);
}

function updateRoleplayPickerFoot(overlay) {
    const state = overlay._remodelPicker;
    const count = state.selected.size;
    const countEl = overlay.querySelector('[data-remodel-rp-picker-count]');
    const confirmBtn = overlay.querySelector('[data-remodel-rp-picker-confirm]');
    if (countEl) {
        countEl.textContent = count === 0
            ? 'None selected'
            : `${count} character${count === 1 ? '' : 's'} selected`;
    }
    if (confirmBtn) {
        confirmBtn.toggleAttribute('disabled', count === 0);
    }
}

// One delegated listener set for the picker, bound once at init. All picker
// instances share it (the overlay is looked up live), gated on the picker
// actually being present.
function bindRoleplayCastPickerEvents() {
    document.addEventListener('click', (event) => {
        const overlay = document.getElementById(ROLEPLAY_PICKER_ID);
        if (!overlay) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        // Click on the scrim (outside the dialog) cancels.
        if (target === overlay) {
            closeRoleplayCastPicker();
            return;
        }
        if (target.closest('[data-remodel-rp-picker-cancel]')) {
            closeRoleplayCastPicker();
            return;
        }

        const card = target.closest('[data-remodel-rp-pick]');
        if (card) {
            const avatar = card.getAttribute('data-remodel-rp-pick');
            const state = overlay._remodelPicker;
            if (state.selected.has(avatar)) {
                state.selected.delete(avatar);
                card.classList.remove('remodel-rp-picked');
            } else {
                state.selected.add(avatar);
                card.classList.add('remodel-rp-picked');
            }
            updateRoleplayPickerFoot(overlay);
            return;
        }

        if (target.closest('[data-remodel-rp-picker-confirm]')) {
            const state = overlay._remodelPicker;
            const chosen = Array.from(state.selected);
            if (chosen.length === 0) {
                return;
            }
            const cb = state.onConfirm;
            closeRoleplayCastPicker();
            cb?.(chosen);
            return;
        }
    });

    // Live search filter.
    document.addEventListener('input', (event) => {
        const overlay = document.getElementById(ROLEPLAY_PICKER_ID);
        if (!overlay) {
            return;
        }
        const search = event.target instanceof Element ? event.target.closest('[data-remodel-rp-picker-search]') : null;
        if (!(search instanceof HTMLInputElement)) {
            return;
        }
        const q = search.value.trim().toLowerCase();
        overlay.querySelectorAll('[data-remodel-rp-pick]').forEach((c) => {
            const name = c.querySelector('.remodel-rp-picker-name')?.textContent?.toLowerCase() ?? '';
            c.style.display = !q || name.includes(q) ? '' : 'none';
        });
    });

    // Escape closes the picker.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.getElementById(ROLEPLAY_PICKER_ID)) {
            event.preventDefault();
            closeRoleplayCastPicker();
        }
    });
}

function getCurrentLinkedChat() {
    const context = getContext();

    if (context.groupId && context.chatId) {
        return {
            type: 'group',
            groupId: String(context.groupId),
            chatId: String(context.chatId),
        };
    }

    if (context.characterId !== undefined && context.characterId !== null && context.chatId) {
        return {
            type: 'character',
            characterId: String(context.characterId),
            fileName: String(context.chatId),
        };
    }

    return null;
}

function writeSceneMetadata(scene) {
    if (!scene) {
        return;
    }

    const context = getContext();
    context.chatMetadata[CHAT_METADATA_KEY] = {
        timelineId: scene.timelineId,
        arcId: scene.arcId,
        sceneId: scene.id,
        mode: scene.mode,
        title: scene.title,
        linkedChat: scene.linkedChat,
        updatedAt: new Date().toISOString(),
    };
    context.saveMetadataDebounced();
}

// A (re)loaded chat is always a clean starting point — nothing this
// extension tracks alongside core's own state should survive a CHAT_CHANGED/
// CHAT_LOADED unless it's genuinely chat-independent. resetAllChatScopedState()
// (session-state.js) is the single, structural reconciliation point for
// every chat-scoped domain (generation, wizard, pastChatsBridge, panels) —
// each domain owns its own resetX(), registered once, so a future field has
// nowhere to go except inside a domain that's already covered. This
// replaced an earlier hand-audited flat reset function whose predecessor
// had a real, confirmed bug: it reset storyIsGenerating but not its two
// siblings in the same feature, letting a stale GENERATION_ENDED from an
// abandoned chat mutate button state for whatever chat became active by the
// time it arrived (see resetGenerationState()'s own comment in
// session-state.js for the full account).
//
// currentWindow, activeTavernTab, focusedTimelineId, and the rest of the
// `session` domain are deliberately EXEMPT from this reconciliation — see
// that domain's doc comment in session-state.js. Switching chats shouldn't
// force-close the Tavern drawer, kick a scene out of an in-progress rename,
// or discard an in-progress "create timeline" draft.
function syncActiveSceneFromChatMetadata() {
    const scene = getActiveScene();

    // Captured before resetAllChatScopedState() clears wizard.sceneCreationFlow
    // below — the reset only clears the state itself, not the wizard's DOM-
    // side cancellation effects (hideGuidedPrompt/transitionToWindow), which
    // still need to run here if the wizard was actually active. Safe to run
    // unconditionally: finishStoryGuidedCreation() already consumes the
    // wizard flow itself BEFORE triggering the chat switch that completes
    // the wizard, so wizardWasActive is already false by the time CHAT_CHANGED
    // fires from the wizard's own expected completion — this branch is a
    // no-op for that case. What it DOES fix: an UNRELATED chat switch
    // happening mid-wizard (e.g. the user manually opens a different chat
    // via native UI while still on the "choose persona" step), which would
    // otherwise leave the wizard flow dangling against a chat it no longer
    // matches, guided-prompt UI still showing.
    const wizardWasActive = getWizardState().sceneCreationFlow !== null;

    document.body.classList.remove('remodel-manuscript-editing');

    syncStoryWorkspaceClass(scene);
    resetAllChatScopedState();
    closeStoryComposer();
    updateStoryActionBarState();
    restoreAdoptedPanel(); // idempotent, safe to call unconditionally

    if (wizardWasActive) {
        hideGuidedPrompt();
        transitionToWindow({ kind: 'native' });
    }

    refreshStoryMessageDecorations();
    renderRoleplayScene(); // no-ops unless the current scene is a roleplay scene
    registerInsertedTextSlotMacros(getActiveTimelineForPriorText());
    if (!scene) {
        queueRender();
        return;
    }

    setActiveScene(scene.id);
    queueRender();
}

// The story/roleplay workspace is a native-chat sub-mode driven by which
// Scene is bound to the currently loaded chat — not a currentWindow kind
// (Window stays native/tavern). Story and Roleplay are mutually exclusive
// sub-modes of the same underlying native chat: a scene is one or the
// other, never both, so exactly one of these classes is ever set.
function syncStoryWorkspaceClass(scene) {
    const enteringRoleplay = scene?.mode === 'roleplay';
    const enteringStoryDoc = scene?.mode === 'story' && Boolean(scene.storyDocId);

    document.body.classList.remove('remodel-story-workspace-active', 'remodel-manuscript-editing');
    document.body.classList.toggle('remodel-storydoc-active', enteringStoryDoc);
    document.body.classList.toggle('remodel-roleplay-workspace-active', enteringRoleplay);

    if (enteringStoryDoc) {
        activeStoryDocId = scene.storyDocId;
        ensureStoryEditor();
        renderStoryEditor();
    }

    if (enteringRoleplay) {
        relocateRoleplayNativeButtons();
    } else if (enteringStoryDoc) {
        relocateStoryDocNativeButtons();
    } else {
        restoreNativeButtonsToOriginalHomes();
        // Return the shared Prior Text body to the story rail so its panel
        // works again outside roleplay.
        restoreRoleplayPriorTextPanel();
    }

    syncPromptStudioForCurrentMode({ apply: true });
}

// The native hamburger (#options_button) and Extensions wand
// (#extensionsMenuButton) live in #leftSendForm, part of #form_sheld, which
// roleplay hides wholesale (its own composer replaces it). Both menus
// (#options, #extensionsMenu) are positioned by core relative to their
// trigger's OWN DOM position — #extensionsMenu via a live Popper instance
// (extensions.js addExtensionsButtonAndMenu) — so clicking them from a
// synthetic lookalike button elsewhere would open them anchored to the
// hidden composer, not the rail. Relocating the real singleton elements
// into the roleplay rail makes core's own positioning correct for free.
// Reuses the same origin-tracking map the Tavern panel-adoption path uses
// (getOriginalPanelHomes) rather than a second parallel mechanism.
const ROLEPLAY_NATIVE_BUTTON_IDS = ['options_button', 'extensionsMenuButton'];

function relocateStoryDocNativeButtons() {
    const editor = getRealStoryEditor();
    if (!editor) return;
    for (const id of ROLEPLAY_NATIVE_BUTTON_IDS) {
        const el = document.getElementById(id);
        const slot = editor.querySelector(`[data-remodel-storydoc-native-slot="${id}"]`);
        if (!el || !slot || el.parentElement === slot) continue;
        if (!getOriginalPanelHomes().has(el)) {
            getOriginalPanelHomes().set(el, { parent: el.parentElement, nextSibling: el.nextSibling });
        }
        slot.insertBefore(el, slot.querySelector('.remodel-storydoc-tool-label'));
    }
}

function relocateRoleplayNativeButtons() {
    const group = document.getElementById('remodel-rp-panelgroup');
    if (!group) {
        return; // rail not built yet; ensureRoleplayPanelGroup relocates once it exists
    }
    for (const id of ROLEPLAY_NATIVE_BUTTON_IDS) {
        const el = document.getElementById(id);
        const slot = group.querySelector(`[data-remodel-rp-native-slot="${id}"]`);
        if (!el || !slot || el.parentElement === slot) {
            continue;
        }
        if (!getOriginalPanelHomes().has(el)) {
            getOriginalPanelHomes().set(el, { parent: el.parentElement, nextSibling: el.nextSibling });
        }
        slot.appendChild(el);
    }
}

// Both redesigned workspaces adopt the same native singleton controls and
// record the same original composer homes. Restoration is therefore
// deliberately workspace-neutral: leaving either StoryDoc or Roleplay for
// native chat / a legacy Story scene returns both controls to core.
function restoreNativeButtonsToOriginalHomes() {
    for (const id of ROLEPLAY_NATIVE_BUTTON_IDS) {
        const el = document.getElementById(id);
        if (!el) {
            continue;
        }
        const home = getOriginalPanelHomes().get(el);
        if (!home) {
            continue; // never relocated (e.g. roleplay never entered this session)
        }
        home.parent?.insertBefore(el, home.nextSibling);
        getOriginalPanelHomes().delete(el);
    }
}

// Roleplay counterpart to isRealStoryWorkspaceActive() — same single-
// source-of-truth discipline: every call site asks this instead of reading
// the class directly, and it reads context.chatMetadata live every call
// via getActiveScene() with no caching.
function isRealRoleplayWorkspaceActive() {
    return getActiveScene()?.mode === 'roleplay';
}

// Compatibility gate for old chat-Story event handlers that are being retired
// independently. Stage 8 made the legacy workspace permanently unreachable.
function isRealStoryWorkspaceActive() {
    return false;
}

// Detects SillyTavern's own welcome-screen placeholder content specifically
// (see welcome-screen.js: sendAssistantMessage/sendWelcomePrompt) rather
// than trying to validate "is this real story prose" in general, which
// would be guesswork. This is a narrow, exact fingerprint of ONE known-bad
// shape: exactly the two system/assistant placeholder messages
// openWelcomeScreen() pushes when it (incorrectly) fires against a chat
// that's actually still loaded. A real story chat's first two messages
// will essentially never match this exact pairing.
function getRealChatElement() {
    return document.body.querySelector(':scope > #sheld > #chat');
}

// The real #sheld directly under body — scoped the same way as
// getRealChatElement to sidestep the Background-tab clone's duplicate
// #sheld. Roleplay panels dock inside it so they position over the
// stream, not the dead clone.
function getRealSheld() {
    return document.body.querySelector(':scope > #sheld');
}

// STORY DOCUMENT EDITOR (redesigned Story mode)
// ---------------------------------------------------------------------
// A real document editor, fully decoupled from the chat DOM: no #chat, no
// .mes rows, no driving core's hidden buttons. A story scene binds to a
// StoryDoc (story-doc.js); this renders that document as an editable prose
// surface and autosaves straight back to the doc. Generation (Continue /
// Write a beat) goes through generateRaw + a single guarded context seam
// (assembleStoryContext), NOT the chat pipeline — added in later stages.
//
// Legacy chat-bound scenes are converted into this model on first open.
// =====================================================================

const STORY_EDITOR_ID = 'remodel-story-editor';

// The document currently open in the editor. Set on open; read by autosave
// and (later) generation so they write to the right doc without re-deriving
// it from scene metadata on every keystroke.
let activeStoryDocId = null;

// Scoped like getRealChatElement/getRealManuscriptOverlay — the Background
// tab clones the whole page, so a plain getElementById is ambiguous.
function getRealStoryEditor() {
    return document.body.querySelector(`:scope > #sheld > #${STORY_EDITOR_ID}`);
}

// Opens a story scene as a document. New scenes (no doc yet) first pick a
// character to bind (reusing the guided character step), create a StoryDoc,
// and bind the scene to it; already-bound scenes just load their doc.
async function openStoryDocScene(sceneId) {
    let scene = getScene(sceneId);
    if (!scene) {
        return;
    }

    if (!scene.storyDocId) {
        // A brand-new story scene needs a character bound (its card feeds the
        // generation context) — reuse the same character picker roleplay uses
        // to keep the flow familiar, but on confirm create+bind a StoryDoc
        // rather than a chat/group.
        openRoleplayCastPicker({
            mode: 'create',
            onConfirm: (avatars) => beginStoryDocScene(sceneId, avatars),
        });
        return;
    }

    setActiveScene(sceneId);
    activeStoryDocId = scene.storyDocId;
    writeSceneMetadata(scene);
    enterStoryDocWorkspace();
    await enterSceneViewport();
}

// Creates the StoryDoc for a new story scene, binds the scene to it, and
// opens the editor. Takes the first chosen character as the doc's bound
// card (story is single-voice, so only the first pick matters here).
async function beginStoryDocScene(sceneId, avatars) {
    const scene = getScene(sceneId);
    if (!scene) {
        return;
    }
    const context = getContext();
    const firstAvatar = Array.isArray(avatars) ? avatars[0] : null;
    const chid = firstAvatar
        ? (context.characters || []).findIndex((c) => c.avatar === firstAvatar)
        : (context.characterId ?? null);

    const doc = createStoryDoc({ title: scene.title, boundCharacterId: chid >= 0 ? chid : null });
    updateScene(sceneId, { storyDocId: doc.id, status: 'active' });
    setActiveScene(sceneId);
    activeStoryDocId = doc.id;
    writeSceneMetadata(getScene(sceneId));
    enterStoryDocWorkspace();
    await enterSceneViewport();
}

// One-time, idempotent migration for Story scenes created before StoryDocs.
// openScene has already loaded the exact linked chat, so core's live chat
// array is authoritative. linkedChat remains untouched as a recoverable
// archive pointer; adding storyDocId makes every later open skip migration.
function migrateLoadedLegacyStoryScene(sceneId) {
    const scene = getScene(sceneId);
    if (!scene || scene.mode !== 'story' || scene.storyDocId) {
        return scene?.storyDocId ? getStoryDoc(scene.storyDocId) : null;
    }

    const sourceMessages = Array.isArray(getContext().chat) ? getContext().chat : [];
    let body = '';
    const beats = [];

    for (const message of sourceMessages) {
        const text = String(message?.mes || '').trim();
        if (!text || message?.is_system) continue;

        if (message?.is_user) {
            const timestamp = new Date().toISOString();
            beats.push({
                id: `beat-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
                instruction: text,
                generatedText: '',
                position: body.length,
                hidden: false,
                createdAt: timestamp,
                updatedAt: timestamp,
            });
            continue;
        }

        if (body) body += '\n\n';
        body += text;
        const pendingBeat = [...beats].reverse().find((beat) => !beat.generatedText);
        if (pendingBeat) pendingBeat.generatedText = text;
    }

    const context = getContext();
    let boundCharacterId = scene.linkedChat?.type === 'character'
        ? scene.linkedChat.characterId
        : null;
    if (boundCharacterId == null && context.characterId != null && context.characters?.[Number(context.characterId)]) {
        boundCharacterId = context.characterId;
    }
    if (boundCharacterId == null && scene.linkedChat?.type === 'group') {
        const group = context.groups?.find((item) => String(item.id) === String(scene.linkedChat.groupId));
        const firstAvatar = group?.members?.[0];
        const firstMemberIndex = context.characters?.findIndex((character) => character.avatar === firstAvatar) ?? -1;
        if (firstMemberIndex >= 0) boundCharacterId = firstMemberIndex;
    }
    const doc = createStoryDoc({
        title: scene.title || 'New Story',
        boundCharacterId,
    });
    updateStoryDoc(doc.id, { body, beats });
    updateScene(sceneId, {
        storyDocId: doc.id,
        status: 'active',
    });
    return getStoryDoc(doc.id);
}

// Paints the storydoc workspace: sets the body class (CSS hides #chat and the
// native composer, shows the editor), then builds and renders the editor.
function enterStoryDocWorkspace() {
    document.body.classList.add('remodel-storydoc-active');
    document.body.classList.remove('remodel-story-workspace-active', 'remodel-roleplay-workspace-active');
    ensureStoryEditor();
    renderStoryEditor();
    relocateStoryDocNativeButtons();
}

function isRealStoryDocSceneActive() {
    const scene = getActiveScene();
    return Boolean(scene && scene.mode === 'story' && scene.storyDocId);
}

function getScenePromptChoice(scene = getActiveScene()) {
    const apiType = getPromptApiType();
    const selectedId = scene?.promptRecipeIds?.[apiType] || null;
    const selected = getPromptStudioRecipe(selectedId);
    const validSelection = selected?.mode === scene?.mode && selected?.apiType === apiType;
    const recipe = validSelection
        ? selected
        : getDefaultPromptStudioRecipe(scene?.mode || 'roleplay', apiType);
    return {
        apiType,
        recipe,
        inherited: !validSelection,
    };
}

function renderScenePromptChoice(scene = getActiveScene(), compact = false) {
    const { apiType, recipe, inherited } = getScenePromptChoice(scene);
    const completion = apiType === 'chat' ? 'Chat' : 'Text';
    return `
        <button type="button" class="remodel-scene-prompt-choice ${compact ? 'is-compact' : ''}" data-remodel-scene-prompt-choice title="Choose the prompt recipe for this Scene">
            <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
            <span class="remodel-scene-prompt-choice-copy">
                <small>${inherited ? `${completion} default` : `${completion} recipe`}</small>
                <strong>${escapeHtml(recipe?.name || 'No prompt recipe')}</strong>
            </span>
            <i class="fa-solid fa-chevron-down remodel-scene-prompt-choice-caret" aria-hidden="true"></i>
        </button>
    `;
}

function openScenePromptRecipeMenu(anchor) {
    const scene = getActiveScene();
    if (!scene) return;
    const { apiType, recipe: current, inherited } = getScenePromptChoice(scene);
    const defaultRecipe = getDefaultPromptStudioRecipe(scene.mode, apiType);
    const recipes = getPromptStudioRecipes(scene.mode, apiType);
    const items = [
        {
            id: '__default__',
            label: `Use default · ${defaultRecipe?.name || 'None'}`,
            sublabel: `Follow the account ${scene.mode} ${apiType} default`,
            active: inherited,
        },
        ...recipes.map((recipe) => ({
            id: recipe.id,
            label: recipe.name,
            sublabel: recipe.description || `${capitalizePromptLabel(scene.mode)} · ${apiType === 'chat' ? 'Chat Completion' : 'Text Completion'}`,
            active: !inherited && current?.id === recipe.id,
        })),
    ];
    openRoleplayMenu(anchor, items, (recipeId) => {
        const latestScene = getActiveScene();
        if (!latestScene) return;
        capturePromptStudioRuntimeSettings();
        updateScene(latestScene.id, {
            promptRecipeIds: {
                ...(latestScene.promptRecipeIds || {}),
                [apiType]: recipeId === '__default__' ? null : recipeId,
            },
        });
        applyPromptStudioRuntimeRecipe();
        if (latestScene.mode === 'story') renderStoryEditor();
        else {
            const root = getRealRoleplayRoot();
            if (root) renderRoleplayComposer(root);
        }
    });
}

function capitalizePromptLabel(value) {
    return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
}

function ensureStoryEditor() {
    let editor = getRealStoryEditor();
    if (editor) {
        return editor;
    }
    const chatEl = getRealChatElement();
    if (!chatEl) {
        return null;
    }
    editor = document.createElement('div');
    editor.id = STORY_EDITOR_ID;
    editor.innerHTML = `
        <header class="remodel-storydoc-header">
            <button type="button" class="remodel-storydoc-back" data-remodel-storydoc-back title="Return to Tavern">
                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
            </button>
            <div class="remodel-storydoc-heading">
                <span class="remodel-storydoc-kicker">Story manuscript</span>
                <input class="remodel-storydoc-title" data-remodel-storydoc-title aria-label="Story title" />
            </div>
            <div class="remodel-storydoc-author">
                <span class="remodel-storydoc-avatar" data-remodel-storydoc-avatar aria-hidden="true"></span>
                <span><small>Writing with</small><strong data-remodel-storydoc-character>Unbound</strong></span>
            </div>
            <div class="remodel-storydoc-save-state" data-remodel-storydoc-save-state>Saved</div>
        </header>
        <main class="remodel-storydoc-workbench">
            <section class="remodel-storydoc-page" aria-label="Manuscript">
                <div class="remodel-storydoc-page-rule"><span>Manuscript</span></div>
                <div class="remodel-storydoc-prose" data-remodel-storydoc-prose contenteditable="true" spellcheck="true"></div>
                <button type="button" class="remodel-storydoc-add-beat-marker" data-remodel-storydoc-add-beat>
                    <span class="remodel-storydoc-add-beat-tag"><i class="fa-solid fa-feather" aria-hidden="true"></i> Add Scene Beat</span>
                    <span class="remodel-storydoc-add-beat-line" aria-hidden="true"></span>
                </button>
                <div class="remodel-storydoc-prompt-choice" data-remodel-storydoc-prompt-choice></div>
            </section>
            <aside class="remodel-storydoc-tools" aria-label="Story tools">
                <button type="button" data-remodel-storydoc-tool="summary" title="Scene Summary"><i class="fa-solid fa-scroll" aria-hidden="true"></i><span>Summary</span></button>
                <button type="button" data-remodel-storydoc-tool="prior" title="Prior Scene Text"><i class="fa-solid fa-book-open" aria-hidden="true"></i><span>Prior</span></button>
                <button type="button" data-remodel-storydoc-tool="prompt" title="Final Prompt Preview"><i class="fa-solid fa-eye" aria-hidden="true"></i><span>Prompt</span></button>
                <button type="button" data-remodel-storydoc-tool="guidance" title="Author guidance"><i class="fa-solid fa-compass" aria-hidden="true"></i><span>Guide</span></button>
                <span class="remodel-storydoc-tool-control remodel-storydoc-native-slot" data-remodel-storydoc-native-slot="options_button" title="Story options">
                    <span class="remodel-storydoc-tool-label">Menu</span>
                </span>
                <span class="remodel-storydoc-tool-control remodel-storydoc-native-slot" data-remodel-storydoc-native-slot="extensionsMenuButton" title="Extensions">
                    <span class="remodel-storydoc-tool-label">Tools</span>
                </span>
                <button type="button" data-remodel-storydoc-continue title="Continue story"><i class="fa-solid fa-play" aria-hidden="true"></i><span>Continue</span></button>
                <button type="button" data-remodel-storydoc-stop title="Stop generation" disabled><i class="fa-solid fa-stop" aria-hidden="true"></i><span>Stop</span></button>
                <span class="remodel-storydoc-indicator" data-remodel-storydoc-indicator aria-live="polite"></span>
            </aside>
            <aside class="remodel-storydoc-panel" data-remodel-storydoc-panel aria-hidden="true">
                <div class="remodel-storydoc-panel-head">
                    <div><span data-remodel-storydoc-panel-kicker>Story tools</span><h3 data-remodel-storydoc-panel-title>Guidance</h3></div>
                    <button type="button" data-remodel-storydoc-panel-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="remodel-storydoc-panel-body" data-remodel-storydoc-panel-body></div>
            </aside>
        </main>
    `;
    chatEl.after(editor);
    return editor;
}

// Renders the active doc's body into the editable prose surface. Only writes
// the DOM when the value actually differs from what's typed, so a render
// triggered mid-typing (autosave, etc.) never clobbers the caret.
function renderStoryEditor(force = false) {
    if (!isRealStoryDocSceneActive()) {
        return;
    }
    const editor = ensureStoryEditor();
    const prose = editor?.querySelector('[data-remodel-storydoc-prose]');
    if (!prose) {
        return;
    }
    const doc = getStoryDoc(activeStoryDocId);
    if (!doc) {
        return;
    }
    // Split the doc body into paragraphs (blank-line separated) rendered as
    // <p> blocks — a real document look, not one run-on block. Only rebuild
    // when the editor isn't focused (never fight the user's caret).
    if (force || (document.activeElement !== prose && !prose.contains(document.activeElement))) {
        renderProseParagraphs(prose, doc.body || '', doc.beats || []);
    }
    if (prose.dataset.placeholder === undefined) {
        prose.dataset.placeholder = 'Begin your story…';
    }
    const title = editor.querySelector('[data-remodel-storydoc-title]');
    if (title && document.activeElement !== title) title.value = doc.title || 'Untitled Story';
    const promptChoice = editor.querySelector('[data-remodel-storydoc-prompt-choice]');
    if (promptChoice) promptChoice.innerHTML = renderScenePromptChoice(getActiveScene(), true);
    const character = (getContext().characters || [])[Number(doc.boundCharacterId)];
    const characterName = editor.querySelector('[data-remodel-storydoc-character]');
    if (characterName) characterName.textContent = character?.name || 'Unbound character';
    const avatar = editor.querySelector('[data-remodel-storydoc-avatar]');
    if (avatar) {
        const url = character?.avatar && character.avatar !== 'none'
            ? getContext().getThumbnailUrl('avatar', character.avatar)
            : null;
        avatar.style.backgroundImage = url ? `url('${url.replace(/'/g, "\\'")}')` : '';
        avatar.textContent = url ? '' : roleplayInitials(character?.name || 'Story');
    }
}

// Renders plain text (paragraphs separated by blank lines) as <p> elements.
function renderProseParagraphs(prose, text, beats = []) {
    prose.textContent = '';
    let cursor = 0;
    const orderedBeats = [...beats].sort((a, b) => (a.position || 0) - (b.position || 0));
    for (const beat of orderedBeats) {
        const position = Math.max(cursor, Math.min(String(text).length, Number(beat.position) || 0));
        appendStoryParagraphs(prose, String(text).slice(cursor, position));
        prose.appendChild(buildStoryDocBeat(beat));
        cursor = position;
    }
    appendStoryParagraphs(prose, String(text).slice(cursor));
    if (!prose.lastElementChild || prose.lastElementChild.matches('[data-remodel-storydoc-beat-id]')) {
        const paragraph = document.createElement('p');
        paragraph.contentEditable = 'true';
        paragraph.className = 'remodel-storydoc-writing-tail';
        paragraph.appendChild(document.createElement('br'));
        prose.appendChild(paragraph);
    }
}

function appendStoryParagraphs(prose, text) {
    if (!text) return;
    const paragraphs = String(text).split(/\n{2,}/);
    for (const para of paragraphs) {
        const p = document.createElement('p');
        p.contentEditable = 'true';
        p.textContent = para;
        prose.appendChild(p);
    }
}

// Reads the editor's current prose back to plain text (paragraphs joined by
// blank lines), the inverse of renderProseParagraphs.
function readStoryEditorText(prose) {
    const paras = [...prose.querySelectorAll('p')].map((p) => p.textContent ?? '');
    if (paras.length === 0) {
        // No <p> structure yet (freshly typed into an empty editor) — take the
        // raw text.
        return (prose.textContent ?? '').trim();
    }
    return paras.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function readStoryEditorState(prose) {
    const doc = getStoryDoc(activeStoryDocId);
    let body = '';
    const positions = new Map();
    for (const child of prose.children) {
        if (child.matches('[data-remodel-storydoc-beat-id]')) {
            positions.set(child.dataset.remodelStorydocBeatId, body.length);
            continue;
        }
        if (child.tagName !== 'P') continue;
        if (body) body += '\n\n';
        body += child.textContent || '';
    }
    return {
        body: body.trimEnd(),
        beats: (doc?.beats || []).map((beat) => positions.has(beat.id)
            ? { ...beat, position: positions.get(beat.id) }
            : beat),
    };
}

// Autosave: debounced write of the edited prose back to the StoryDoc. No
// commit-through-core, no #send_but — editing a document just saves the
// document.
let storyEditorSaveTimer = null;
function bindStoryEditorEvents() {
    document.addEventListener('input', (event) => {
        if (!isRealStoryDocSceneActive()) {
            return;
        }
        const prose = event.target instanceof Element
            ? event.target.closest('[data-remodel-storydoc-prose]')
            : null;
        if (!prose) {
            return;
        }
        const writingTail = event.target instanceof Element
            ? event.target.closest('p.remodel-storydoc-writing-tail')
            : null;
        if (writingTail?.textContent) {
            writingTail.classList.remove('remodel-storydoc-writing-tail');
        }
        clearTimeout(storyEditorSaveTimer);
        setStorySaveState('Saving…');
        storyEditorSaveTimer = setTimeout(() => {
            if (!activeStoryDocId) {
                return;
            }
            updateStoryDoc(activeStoryDocId, readStoryEditorState(prose));
            setStorySaveState('Saved');
        }, 500);
    });

    document.addEventListener('change', (event) => {
        const title = event.target instanceof Element ? event.target.closest('[data-remodel-storydoc-title]') : null;
        if (!title || !activeStoryDocId) return;
        updateStoryDoc(activeStoryDocId, { title: title.value });
        setStorySaveState('Saved');
    });

    // Story editor controls, including the right-side Continue / Stop rail.
    document.addEventListener('click', (event) => {
        if (!isRealStoryDocSceneActive()) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        const promptMenu = document.getElementById('remodel-rp-menu');
        if (promptMenu) {
            const pick = target.closest('[data-remodel-rp-menu-pick]');
            if (pick && promptMenu.contains(pick)) {
                event.preventDefault();
                const onPick = promptMenu._remodelOnPick;
                const id = pick.getAttribute('data-remodel-rp-menu-pick');
                closeRoleplayMenu();
                onPick?.(id);
                return;
            }
            if (!promptMenu.contains(target) && !target.closest('[data-remodel-scene-prompt-choice]')) {
                closeRoleplayMenu();
            }
        }

        const previewOverlay = document.getElementById(STORY_PREVIEW_ID);
        if (previewOverlay && (target.closest('[data-remodel-storydoc-preview-close]') || target === previewOverlay)) {
            event.preventDefault();
            closeStoryPromptPreview();
            return;
        }

        if (target.matches('[data-remodel-storydoc-prose]')) {
            const tail = target.querySelector(':scope > p:last-of-type');
            if (tail) placeCaretAtEnd(tail);
            return;
        }

        if (target.closest('[data-remodel-storydoc-back]')) {
            event.preventDefault();
            transitionToWindow({ kind: 'tavern', tab: 'timeline' });
            return;
        }
        const promptChoice = target.closest('[data-remodel-scene-prompt-choice]');
        if (promptChoice) {
            event.preventDefault();
            openScenePromptRecipeMenu(promptChoice);
            return;
        }
        if (target.closest('[data-remodel-storydoc-add-beat]')) {
            event.preventDefault();
            createStoryDocBeat();
            return;
        }
        const nativeSlot = target.closest('[data-remodel-storydoc-native-slot]');
        if (nativeSlot) {
            const nativeButton = nativeSlot.querySelector('#options_button, #extensionsMenuButton');
            if (nativeButton && target !== nativeButton) {
                event.preventDefault();
                nativeButton.click();
            }
            return;
        }
        if (target.closest('[data-remodel-storydoc-continue]')) {
            event.preventDefault();
            generateStory({ mode: 'continue' });
            return;
        }
        const tool = target.closest('[data-remodel-storydoc-tool]');
        if (tool) {
            event.preventDefault();
            openStoryToolPanel(tool.dataset.remodelStorydocTool, tool);
            return;
        }
        if (target.closest('[data-remodel-storydoc-panel-close]')) {
            closeStoryToolPanel();
            return;
        }
        const beatCard = target.closest('[data-remodel-storydoc-beat-id]');
        if (beatCard) {
            event.preventDefault();
            const beatId = beatCard.dataset.remodelStorydocBeatId;
            if (target.closest('[data-remodel-storydoc-beat-hide]')) toggleStoryDocBeat(beatId);
            else if (target.closest('[data-remodel-storydoc-beat-delete]')) deleteStoryDocBeat(beatId);
            else if (target.closest('[data-remodel-storydoc-beat-send]')) generateStoryDocBeat(beatId);
            return;
        }

        const generateBtn = target.closest('[data-remodel-storydoc-generate]');
        if (generateBtn) {
            event.preventDefault();
            triggerStoryBeatGeneration();
            return;
        }

        if (target.closest('[data-remodel-storydoc-stop]')) {
            event.preventDefault();
            stopStoryGeneration();
            return;
        }
    });

    // Keep paragraph boundaries deterministic around non-editable Scene Beat
    // cards. Native contenteditable can otherwise grow the tall landing block
    // on Enter or consume the preceding card on Backspace.
    document.addEventListener('keydown', (event) => {
        if (!isRealStoryDocSceneActive() || event.isComposing) return;

        const paragraph = event.target instanceof Element
            ? event.target.closest('[data-remodel-storydoc-prose] > p')
            : null;
        if (paragraph && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            paragraph.classList.remove('remodel-storydoc-writing-tail');
            const next = document.createElement('p');
            next.contentEditable = 'true';
            next.appendChild(document.createElement('br'));
            paragraph.after(next);
            placeCaretAtEnd(next);
            paragraph.closest('[data-remodel-storydoc-prose]')?.dispatchEvent(
                new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }),
            );
            return;
        }
        if (paragraph && event.key === 'Backspace' && isCaretAtStart(paragraph)
            && paragraph.previousElementSibling?.matches('[data-remodel-storydoc-beat-id]')) {
            event.preventDefault();
            return;
        }
        if (paragraph && event.key === 'Delete' && isCaretAtEnd(paragraph)
            && paragraph.nextElementSibling?.matches('[data-remodel-storydoc-beat-id]')) {
            event.preventDefault();
            return;
        }

        // Enter in the beat input triggers a beat generation.
        if (event.key !== 'Enter' || event.shiftKey) return;
        const beatInput = event.target instanceof Element
            ? event.target.closest('[data-remodel-storydoc-beat]')
            : null;
        if (!beatInput) return;
        event.preventDefault();
        triggerStoryBeatGeneration();
    });

    document.addEventListener('input', (event) => {
        const field = event.target instanceof Element ? event.target.closest('[data-remodel-storydoc-beat-instruction]') : null;
        const card = field?.closest('[data-remodel-storydoc-beat-id]');
        if (!field || !card) return;
        patchStoryDocBeat(card.dataset.remodelStorydocBeatId, { instruction: field.value });
    }, true);

    document.addEventListener('beforeinput', (event) => {
        if (!isRealStoryDocSceneActive() || !String(event.inputType).startsWith('deleteContent')) return;
        const prose = event.target instanceof Element
            ? event.target.closest('[data-remodel-storydoc-prose]')
            : null;
        if (!prose) return;
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        const paragraph = anchor instanceof Element
            ? anchor.closest('[data-remodel-storydoc-prose] > p')
            : anchor?.parentElement?.closest('[data-remodel-storydoc-prose] > p');
        if (!paragraph || paragraph.parentElement !== prose) return;
        const backward = event.inputType === 'deleteContentBackward';
        const forward = event.inputType === 'deleteContentForward';
        if ((backward && isCaretAtStart(paragraph) && paragraph.previousElementSibling?.matches('[data-remodel-storydoc-beat-id]'))
            || (forward && isCaretAtEnd(paragraph) && paragraph.nextElementSibling?.matches('[data-remodel-storydoc-beat-id]'))) {
            event.preventDefault();
        }
    });
}

function placeCaretAtEnd(element) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function isCaretAtStart(element) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (range.startContainer !== element && !element.contains(range.startContainer)) return false;
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length === 0;
}

function isCaretAtEnd(element) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (range.endContainer !== element && !element.contains(range.endContainer)) return false;
    const after = range.cloneRange();
    after.selectNodeContents(element);
    after.setStart(range.endContainer, range.endOffset);
    return after.toString().length === 0;
}

function createStoryDocBeat() {
    const prose = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]');
    if (prose) {
        clearTimeout(storyEditorSaveTimer);
        updateStoryDoc(activeStoryDocId, readStoryEditorState(prose));
        setStorySaveState('Saved');
    }
    const doc = getStoryDoc(activeStoryDocId);
    if (!doc) return;
    const beat = {
        id: `beat-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
        instruction: '',
        generatedText: '',
        position: (doc.body || '').length,
        hidden: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    updateStoryDoc(activeStoryDocId, { beats: [...(doc.beats || []), beat] });
    renderStoryEditor(true);
    const card = getRealStoryEditor()?.querySelector(`[data-remodel-storydoc-beat-id="${beat.id}"]`);
    card?.querySelector('[data-remodel-storydoc-beat-instruction]')?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}

function patchStoryDocBeat(beatId, patch) {
    const doc = getStoryDoc(activeStoryDocId);
    if (!doc) return null;
    let updated = null;
    const beats = (doc.beats || []).map((beat) => {
        if (beat.id !== beatId) return beat;
        updated = { ...beat, ...patch, updatedAt: new Date().toISOString() };
        return updated;
    });
    updateStoryDoc(activeStoryDocId, { beats });
    return updated;
}

function toggleStoryDocBeat(beatId) {
    const beat = getStoryDoc(activeStoryDocId)?.beats?.find((item) => item.id === beatId);
    if (!beat) return;
    patchStoryDocBeat(beatId, { hidden: !beat.hidden });
    renderStoryEditor(true);
}

function removeGeneratedBeatText(doc, beat) {
    if (!beat.generatedText) return { body: doc.body || '', beats: doc.beats || [] };
    const body = doc.body || '';
    const index = body.indexOf(beat.generatedText, Math.max(0, (beat.position || 0) - 2));
    if (index < 0) return { body, beats: doc.beats || [] };
    const nextBody = `${body.slice(0, index)}${body.slice(index + beat.generatedText.length)}`
        .replace(/\n{3,}/g, '\n\n').trimEnd();
    const delta = body.length - nextBody.length;
    const beats = (doc.beats || []).map((item) => item.position > beat.position
        ? { ...item, position: Math.max(beat.position, item.position - delta) }
        : item);
    return { body: nextBody, beats };
}

function deleteStoryDocBeat(beatId) {
    const doc = getStoryDoc(activeStoryDocId);
    const beat = doc?.beats?.find((item) => item.id === beatId);
    if (!doc || !beat || !confirm('Delete this Scene Beat? The manuscript prose will be kept.')) return;
    updateStoryDoc(activeStoryDocId, {
        beats: doc.beats.filter((item) => item.id !== beatId),
    });
    renderStoryEditor(true);
}

async function generateStoryDocBeat(beatId) {
    const doc = getStoryDoc(activeStoryDocId);
    const beat = doc?.beats?.find((item) => item.id === beatId);
    if (!doc || !beat || !beat.instruction.trim()) return;
    if (beat.generatedText) {
        const removed = removeGeneratedBeatText(doc, beat);
        updateStoryDoc(activeStoryDocId, {
            body: removed.body,
            beats: removed.beats.map((item) => item.id === beatId ? { ...item, generatedText: '' } : item),
        });
        renderStoryEditor(true);
    }
    await generateStory({ mode: 'beat', beat: beat.instruction, beatId });
}

function buildStoryDocBeat(beat) {
    const card = document.createElement('section');
    card.className = `remodel-storydoc-beat-card${beat.hidden ? ' is-hidden' : ''}`;
    card.dataset.remodelStorydocBeatId = beat.id;
    card.contentEditable = 'false';
    card.innerHTML = `
        <header>
            <span><i class="fa-solid fa-bolt"></i> Scene Beat</span>
            <span>
                <button type="button" data-remodel-storydoc-beat-hide>${beat.hidden ? 'Show' : 'Hide'}</button>
                <button type="button" data-remodel-storydoc-beat-delete>Delete</button>
            </span>
        </header>
        <div class="remodel-storydoc-beat-editor">
            <textarea data-remodel-storydoc-beat-instruction placeholder="Describe the next scene beat…"></textarea>
            <button type="button" data-remodel-storydoc-beat-send title="${beat.generatedText ? 'Regenerate this beat' : 'Generate this beat'}">
                <i class="fa-solid ${beat.generatedText ? 'fa-rotate-right' : 'fa-paper-plane'}"></i>
            </button>
        </div>
        ${beat.generatedText ? '<button type="button" class="remodel-storydoc-beat-regenerate" data-remodel-storydoc-beat-send>Regenerate</button>' : ''}
    `;
    card.querySelector('[data-remodel-storydoc-beat-instruction]').value = beat.instruction || '';
    return card;
}

function setStorySaveState(label) {
    const el = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-save-state]');
    if (el) el.textContent = label;
}

const STORY_PREVIEW_ID = 'remodel-story-preview-modal';
const STUDIO_PREVIEW_ID = 'remodel-prompt-studio-preview-modal';

async function openPromptStudioSource(recipe, sourceKey) {
    if (['worldInfoBefore', 'worldInfoAfter'].includes(sourceKey)) {
        await transitionToWindow({ kind: 'tavern', tab: 'lorebooks' });
        return;
    }
    if (['persona', 'personaDescription'].includes(sourceKey)) {
        await transitionToWindow({ kind: 'tavern', tab: 'personas' });
        return;
    }
    if (['characterCard', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples'].includes(sourceKey)) {
        await transitionToWindow({ kind: 'tavern', tab: 'characters' });
        return;
    }
    await transitionToWindow({ kind: 'native' });
    if (recipe?.mode === 'roleplay') {
        requestAnimationFrame(() => {
            const root = getRealRoleplayRoot();
            if (sourceKey === 'currentInput') {
                root?.querySelector('[data-remodel-rp-input]')?.focus();
            } else if (sourceKey === 'chatHistory') {
                const stream = root?.querySelector('[data-remodel-rp-stream]');
                stream?.scrollTo?.({ top: stream.scrollHeight, behavior: 'smooth' });
            }
        });
        return;
    }
    if (recipe?.mode !== 'story' || !isRealStoryDocSceneActive()) return;
    requestAnimationFrame(() => {
        if (sourceKey === 'authorGuidance') {
            const trigger = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-tool="guidance"]');
            openStoryToolPanel('guidance', trigger);
        } else if (sourceKey === 'priorText') {
            const trigger = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-tool="prior"]');
            openStoryToolPanel('prior', trigger);
        } else if (sourceKey === 'manuscript') {
            getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]')?.focus();
        }
    });
}

async function previewPromptStudioRecipe(recipe) {
    const overlay = openPromptStudioPreviewModal(recipe?.name || 'Prompt preview');
    const body = overlay.querySelector('[data-remodel-prompt-studio-preview-body]');
    const warning = overlay.querySelector('[data-remodel-prompt-studio-preview-warning]');
    try {
        const activeRecipe = getCurrentPromptStudioRecipe(recipe.mode, recipe.apiType);
        const isCurrentRoleplayRecipe = recipe.mode === 'roleplay'
            && recipe.apiType === getPromptApiType()
            && activeRecipe?.id === recipe.id
            && !isRealStoryDocSceneActive();
        if (isCurrentRoleplayRecipe) {
            const { generateData, warnings } = await runPromptPreviewDryRun('normal');
            body.textContent = formatPromptPreview(generateData);
            if (warnings?.length) {
                warning.hidden = false;
                warning.textContent = warnings.join(' · ');
            }
            return;
        }
        if (recipe.mode === 'story' && activeStoryDocId) {
            const doc = getStoryDoc(activeStoryDocId);
            const assembled = await assembleStoryContext(doc?.body || '');
            body.textContent = formatPromptStudioPreview(compilePromptRecipe(
                recipe,
                buildStoryPromptSources(doc, assembled, { mode: 'continue' }),
                { includeUnresolved: true },
            ));
            return;
        }
        body.textContent = formatPromptStudioPreview(compilePromptRecipe(recipe, {}, { includeUnresolved: true }));
        warning.hidden = false;
        warning.textContent = 'Live sources are shown as labels because no matching Story document or active Roleplay request is available.';
    } catch (error) {
        body.textContent = `Could not assemble a preview.\n\n${String(error)}`;
    }
}

function openPromptStudioPreviewModal(title) {
    document.getElementById(STUDIO_PREVIEW_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = STUDIO_PREVIEW_ID;
    overlay.className = 'remodel-rp-picker-scrim';
    overlay.innerHTML = `
        <div class="remodel-rp-preview">
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">${escapeHtml(title)}</div>
                    <div class="remodel-rp-picker-hint">Compiled preview only — nothing is sent or added to the manuscript.</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-prompt-studio-preview-close aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-preview-warn" data-remodel-prompt-studio-preview-warning hidden></div>
            <pre class="remodel-rp-preview-body" data-remodel-prompt-studio-preview-body>Assembling prompt…</pre>
        </div>
    `;
    const close = () => {
        overlay.classList.remove('remodel-rp-picker-in');
        setTimeout(() => overlay.remove(), 200);
    };
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target.closest('[data-remodel-prompt-studio-preview-close]')) close();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));
    return overlay;
}

async function openStoryPromptPreview() {
    document.getElementById(STORY_PREVIEW_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = STORY_PREVIEW_ID;
    overlay.className = 'remodel-rp-picker-scrim';
    overlay.innerHTML = `
        <div class="remodel-rp-preview" data-remodel-storydoc-preview-stop>
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">Prompt preview</div>
                    <div class="remodel-rp-picker-hint">Exactly what the model will receive on the next turn — nothing is sent.</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-storydoc-preview-close aria-label="Close">×</button>
            </div>
            <pre class="remodel-rp-preview-body" data-remodel-storydoc-preview-body>Assembling prompt…</pre>
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));

    const body = overlay.querySelector('[data-remodel-storydoc-preview-body]');
    const doc = getStoryDoc(activeStoryDocId);
    if (!body || !doc) return;
    try {
        const assembled = await assembleStoryContext(doc.body || '');
        const recipe = getCurrentPromptStudioRecipe('story', getPromptApiType());
        const sources = buildStoryPromptSources(doc, assembled, { mode: 'continue' });
        const compiled = compilePromptRecipe(recipe, sources);
        body.textContent = formatPromptStudioPreview(compiled);
    } catch (error) {
        body.textContent = `Could not assemble a preview.\n\n${String(error)}`;
    }
}

function closeStoryPromptPreview() {
    const overlay = document.getElementById(STORY_PREVIEW_ID);
    if (overlay) {
        overlay.classList.remove('remodel-rp-picker-in');
        setTimeout(() => overlay.remove(), 200);
    }
    getRealStoryEditor()?.querySelector('[data-remodel-storydoc-tool="prompt"]')?.classList.remove('is-active');
}

function closeStoryToolPanel() {
    const editor = getRealStoryEditor();
    const panel = editor?.querySelector('[data-remodel-storydoc-panel]');
    panel?.classList.remove('is-open');
    panel?.setAttribute('aria-hidden', 'true');
    if (panel) delete panel.dataset.activeTool;
    editor?.querySelectorAll('[data-remodel-storydoc-tool].is-active').forEach((button) => button.classList.remove('is-active'));
}

async function openStoryToolPanel(tool, trigger = null) {
    const editor = getRealStoryEditor();
    if (tool === 'prompt') {
        const existing = document.getElementById(STORY_PREVIEW_ID);
        if (existing) {
            closeStoryPromptPreview();
            return;
        }
        closeStoryToolPanel();
        trigger?.classList.add('is-active');
        await openStoryPromptPreview();
        return;
    }
    if (document.getElementById(STORY_PREVIEW_ID)) closeStoryPromptPreview();
    const panel = editor?.querySelector('[data-remodel-storydoc-panel]');
    const title = editor?.querySelector('[data-remodel-storydoc-panel-title]');
    const body = editor?.querySelector('[data-remodel-storydoc-panel-body]');
    const doc = getStoryDoc(activeStoryDocId);
    if (!panel || !title || !body || !doc) return;
    if (panel.classList.contains('is-open') && panel.dataset.activeTool === tool) {
        closeStoryToolPanel();
        return;
    }
    panel.dataset.activeTool = tool;
    editor.querySelectorAll('[data-remodel-storydoc-tool]').forEach((button) => {
        button.classList.toggle('is-active', button === trigger || button.dataset.remodelStorydocTool === tool);
    });
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (tool === 'summary') {
        const scene = getActiveScene();
        title.textContent = 'Scene summary';
        body.innerHTML = `<p class="remodel-storydoc-panel-copy">Keep a compact account of this scene for later prompts and timeline continuity.</p><textarea data-remodel-storydoc-summary placeholder="What happens in this scene?"></textarea><button type="button" class="remodel-storydoc-panel-action" data-remodel-storydoc-summarize><i class="fa-solid fa-wand-magic-sparkles"></i> Summarize manuscript</button><p class="remodel-storydoc-panel-foot" data-remodel-storydoc-summary-status>Saved automatically</p>`;
        const field = body.querySelector('[data-remodel-storydoc-summary]');
        field.value = scene?.summary || '';
        field.addEventListener('input', () => updateScene(scene.id, { summary: field.value, summaryUpdatedAt: new Date().toISOString() }));
        body.querySelector('[data-remodel-storydoc-summarize]').addEventListener('click', () => summarizeStoryDoc(field));
        return;
    }
    if (tool === 'prior') {
        title.textContent = 'Prior scene text';
        const activeScene = getActiveScene();
        const timeline = getTimelineStore().timelines[activeScene?.timelineId];
        const scenes = (timeline?.arcIds || []).flatMap((arcId) => getTimelineStore().arcs[arcId]?.sceneIds || [])
            .map((sceneId) => getScene(sceneId)).filter((scene) => scene && scene.id !== activeScene?.id);
        body.innerHTML = `<p class="remodel-storydoc-panel-copy">Carry prose from an earlier scene into this document's generation context.</p><label class="remodel-storydoc-field-label">Source scene<select data-remodel-storydoc-prior-select><option value="">Choose a scene…</option>${scenes.map((scene) => `<option value="${escapeAttribute(scene.id)}">${escapeHtml(scene.title)}</option>`).join('')}</select></label><button type="button" class="remodel-storydoc-panel-action" data-remodel-storydoc-prior-load>Load into context</button><textarea data-remodel-storydoc-prior-preview readonly placeholder="Loaded prose will appear here."></textarea><button type="button" class="remodel-storydoc-text-action" data-remodel-storydoc-prior-clear>Clear prior text</button>`;
        const select = body.querySelector('[data-remodel-storydoc-prior-select]');
        const preview = body.querySelector('[data-remodel-storydoc-prior-preview]');
        select.value = doc.priorSceneId || '';
        preview.value = doc.priorText || '';
        body.querySelector('[data-remodel-storydoc-prior-load]').addEventListener('click', () => loadStoryDocPriorText(select.value, preview));
        body.querySelector('[data-remodel-storydoc-prior-clear]').addEventListener('click', () => {
            updateStoryDoc(activeStoryDocId, { priorSceneId: null, priorText: '' });
            select.value = '';
            preview.value = '';
        });
        return;
    }
    if (tool === 'type') {
        title.textContent = 'Manuscript toolbar';
        body.innerHTML = `<p class="remodel-storydoc-panel-copy">Formatting is stored as lightweight manuscript markup. Font is a local reading preference.</p><div class="remodel-storydoc-format-row">${[['bold','fa-bold'],['italic','fa-italic'],['underline','fa-underline'],['strikethrough','fa-strikethrough']].map(([format, icon]) => `<button type="button" data-remodel-storydoc-format="${format}" title="${format}"><i class="fa-solid ${icon}"></i></button>`).join('')}</div><label class="remodel-storydoc-field-label">Reading font<select data-remodel-storydoc-font>${MANUSCRIPT_FONT_OPTIONS.map((option) => `<option value="${escapeAttribute(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select></label>`;
        const font = body.querySelector('[data-remodel-storydoc-font]');
        try { font.value = localStorage.getItem(MANUSCRIPT_FONT_STORAGE_KEY) || MANUSCRIPT_FONT_OPTIONS[0].value; } catch { /* local storage unavailable */ }
        font.addEventListener('change', () => handleManuscriptFontChange(font));
        body.querySelectorAll('[data-remodel-storydoc-format]').forEach((button) => button.addEventListener('click', () => formatStoryDocSelection(button.dataset.remodelStorydocFormat)));
        return;
    }
    if (tool === 'guidance') {
        title.textContent = 'Author guidance';
        body.innerHTML = `<p class="remodel-storydoc-panel-copy">Set tone, point of view, pacing, and boundaries. This is sent as authorial direction with every passage.</p><textarea data-remodel-storydoc-guidance placeholder="Example: Close third-person, restrained prose, slow-burn tension…"></textarea><p class="remodel-storydoc-panel-foot">Saved automatically</p>`;
        const field = body.querySelector('[data-remodel-storydoc-guidance]');
        field.value = doc.guidance || '';
        field.addEventListener('input', () => {
            updateStoryDoc(activeStoryDocId, { guidance: field.value });
            setStorySaveState('Saved');
        });
        return;
    }
    title.textContent = 'Generation context';
    body.innerHTML = '<p class="remodel-storydoc-panel-copy">Assembling the exact Story context…</p>';
    const assembled = await assembleStoryContext(doc.body || '');
    body.textContent = '';
    for (const [label, value] of [['Character, persona & guidance', assembled.systemPrompt], ['Prior scene text', doc.priorText], ['World Info', assembled.contextBlock], ['Manuscript tail', (doc.body || '').slice(-12000)]]) appendStoryPreviewSection(body, label, value);
}

function appendStoryPreviewSection(host, label, value) {
    const section = document.createElement('section');
    const heading = document.createElement('h4');
    const pre = document.createElement('pre');
    heading.textContent = label;
    pre.textContent = value || 'Nothing included';
    section.append(heading, pre);
    host.appendChild(section);
}

async function summarizeStoryDoc(field) {
    const doc = getStoryDoc(activeStoryDocId);
    const status = field?.parentElement?.querySelector('[data-remodel-storydoc-summary-status]');
    if (!doc || !field || !doc.body.trim()) return;
    if (status) status.textContent = 'Summarizing…';
    try {
        const summary = await getContext().generateRaw({
            systemPrompt: 'Summarize the supplied fiction scene concisely for continuity notes. Return only the summary.',
            prompt: doc.body.slice(-16000),
            responseLength: 256,
            instructOverride: true,
        });
        field.value = summary.trim();
        updateScene(getActiveScene().id, { summary: field.value, summaryUpdatedAt: new Date().toISOString() });
        if (status) status.textContent = 'Summary saved';
    } catch (error) {
        if (status) status.textContent = `Could not summarize: ${String(error?.message || error)}`;
    }
}

async function loadStoryDocPriorText(sceneId, preview) {
    const scene = getScene(sceneId);
    if (!scene || !preview) return;
    let text = '';
    if (scene.storyDocId) {
        text = getStoryDoc(scene.storyDocId)?.body || '';
    } else if (scene.linkedChat) {
        const messages = await fetchSceneMessages(scene);
        text = messages ? extractSceneProse(messages, { labelSpeakers: scene.mode === 'roleplay' }) : '';
    }
    updateStoryDoc(activeStoryDocId, { priorSceneId: scene.id, priorText: text });
    preview.value = text;
}

function formatStoryDocSelection(format) {
    const prose = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]');
    const selection = window.getSelection();
    if (!prose || !selection || selection.rangeCount === 0 || !prose.contains(selection.anchorNode)) return;
    const pair = { bold: ['**', '**'], italic: ['_', '_'], underline: ['<u>', '</u>'], strikethrough: ['~~', '~~'] }[format];
    if (!pair) return;
    const range = selection.getRangeAt(0);
    const selected = range.toString();
    const node = document.createTextNode(pair[0] + selected + pair[1]);
    range.deleteContents();
    range.insertNode(node);
    prose.dispatchEvent(new Event('input', { bubbles: true }));
}

// Reads the beat input; if it has text, generate that beat and clear it,
// otherwise Continue.
async function triggerStoryBeatGeneration() {
    const beatInput = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-beat]');
    const beat = (beatInput?.value || '').trim();
    if (beat) {
        const written = await generateStory({ mode: 'beat', beat });
        if (written && beatInput) {
            beatInput.value = '';
            getRealStoryEditor()?.classList.remove('remodel-storydoc-beat-open');
        }
    } else {
        await generateStory({ mode: 'continue' });
    }
}

// --- Story generation (the guarded core seam + generateRaw) ----------------
//
// THE ONE PLACE the whole Story feature touches SillyTavern internals. Wrapped
// in try/catch and degrades gracefully: if a core update changes the shape of
// getCharacterCardFields / getWorldInfoPrompt, story still writes + generates,
// just without WI/card context, until this one function is patched. Validated
// live (stage-1 spike) against the real exported APIs.
async function assembleStoryContext(docText) {
    const ctx = getContext();
    const doc = getStoryDoc(activeStoryDocId);
    const guidance = ctx.substituteParams?.(doc?.guidance || '') || doc?.guidance || '';

    try {
        const chid = doc?.boundCharacterId != null ? Number(doc.boundCharacterId) : ctx.characterId;

        // Character card fields (macros already resolved by core).
        let card = {};
        if (typeof ctx.getCharacterCardFields === 'function') {
            card = ctx.getCharacterCardFields({ chid }) || {};
        }

        // World Info activation, scanning OUR document text as the corpus.
        let wi = { worldInfoBefore: '', worldInfoAfter: '' };
        if (typeof ctx.getWorldInfoPrompt === 'function') {
            wi = await ctx.getWorldInfoPrompt([docText], 8192, false) || wi;
        }

        const characterCard = (ctx.substituteParams || ((s) => s))(
            [
                card.system,
                card.description,
                card.personality,
                card.scenario,
            ]
                .filter(Boolean).join('\n\n'),
        );
        const persona = (ctx.substituteParams || ((s) => s))(card.persona || '');
        const systemPrompt = [
            'You are the prose engine inside a fiction manuscript editor. Write only the requested story prose. Continue naturally from the manuscript, preserve continuity and point of view, and do not explain your work.',
            characterCard,
            persona,
            guidance,
        ].filter(Boolean).join('\n\n');
        const contextBlock = [wi.worldInfoBefore, wi.worldInfoAfter].filter(Boolean).join('\n');
        return {
            systemPrompt,
            contextBlock,
            characterCard,
            persona,
            worldInfoBefore: wi.worldInfoBefore || '',
            worldInfoAfter: wi.worldInfoAfter || '',
            authorGuidance: guidance,
        };
    } catch (err) {
        console.warn('Remodel Story: context seam failed — generating without WI/card context.', err);
        // Graceful fallback: the guidance field is ours (no core dependency),
        // so authorial steering still applies even if the core seam breaks.
        return {
            systemPrompt: guidance,
            contextBlock: '',
            characterCard: '',
            persona: '',
            worldInfoBefore: '',
            worldInfoAfter: '',
            authorGuidance: guidance,
        };
    }
}

function buildStoryPromptSources(doc, assembled, { mode = 'continue', beat = '' } = {}) {
    const body = doc?.body || '';
    const manuscript = body.length > 12000 ? body.slice(-12000) : body;
    const direction = mode === 'beat' && beat.trim()
        ? `[Write the next part of the story following this scene beat: ${beat.trim()}]`
        : '[Continue the manuscript with the next passage.]';
    return {
        characterCard: assembled?.characterCard || '',
        persona: assembled?.persona || '',
        worldInfoBefore: assembled?.worldInfoBefore || '',
        worldInfoAfter: assembled?.worldInfoAfter || '',
        authorGuidance: assembled?.authorGuidance || '',
        priorText: doc?.priorText ? `=== PRIOR SCENE TEXT ===\n${doc.priorText}` : '',
        manuscript,
        sceneBeat: direction,
    };
}

// True while a story generation is in flight, so the controls can flip to a
// Stop state and a second Continue can't stack.
let storyGenerating = false;

// Generates prose for the active document. mode 'continue' extends the prose
// from where it is; mode 'beat' writes the scene the user described. Inserts
// the result into the editor and autosaves. Streaming isn't available on
// generateRaw, so this is generate-then-insert with a live "writing…"
// indicator; Stop emits GENERATION_STOPPED, which generateRawData honors.
async function generateStory({ mode = 'continue', beat = '', beatId = null } = {}) {
    if (storyGenerating || !isRealStoryDocSceneActive()) {
        return false;
    }
    const ctx = getContext();
    const doc = getStoryDoc(activeStoryDocId);
    if (!doc) {
        return false;
    }

    // Flush any pending autosave so the doc body is current before we read it.
    clearTimeout(storyEditorSaveTimer);
    const prose = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]');
    if (prose) {
        updateStoryDoc(activeStoryDocId, readStoryEditorState(prose));
    }

    const docText = getStoryDoc(activeStoryDocId)?.body || '';
    storyGenerating = true;
    setStoryGeneratingUI(true);

    try {
        const assembled = await assembleStoryContext(docText);
        const recipe = getCurrentPromptStudioRecipe('story', getPromptApiType());
        const prompt = compilePromptRecipe(
            recipe,
            buildStoryPromptSources(getStoryDoc(activeStoryDocId), assembled, { mode, beat }),
        ).messages;

        const generated = await ctx.generateRaw({
            prompt,
            // A passage, not a full chapter. Keeping this at Horde's anonymous
            // threshold also avoids a configured 2k-token chat response turning
            // one editor click into an unexpectedly expensive request.
            responseLength: 512,
            instructOverride: false,
        });

        if (generated && generated.trim()) {
            const prose = generated.trim();
            if (beatId) insertStoryBeatProse(beatId, prose);
            else appendStoryProse(prose);
            renderStoryEditor(true);
            return true;
        }
        showStoryGenError('The model returned no prose — try again.');
        return false;
    } catch (err) {
        // GENERATION_STOPPED (user hit Stop) surfaces here as a thrown abort —
        // not an error to report.
        const msg = String(err?.message || err);
        if (!msg.match(/cancel|abort|stopped/i)) {
            console.error('Remodel Story: generation failed', err);
            // Surface a short, real reason (connection/kudos/etc.) rather than a
            // generic "failed" so the user can act on it. Horde kudos and
            // no-API errors are the common cases.
            let reason = 'Generation failed — check your API connection.';
            if (/kudos/i.test(msg)) {
                reason = 'Generation failed — not enough Horde kudos for a request this size. Try a shorter response length or a different backend.';
            } else if (/no message generated|empty/i.test(msg)) {
                reason = 'The model returned nothing — try again.';
            }
            showStoryGenError(reason);
        }
        return false;
    } finally {
        storyGenerating = false;
        setStoryGeneratingUI(false);
    }
}

// Appends generated prose to the document: split into paragraphs, add as <p>
// blocks after the existing content, save, and scroll to the new text.
function appendStoryProse(text) {
    const prose = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]');
    if (!prose) {
        return;
    }
    // If the editor is just an empty placeholder paragraph, clear it first.
    if (prose.textContent.trim() === '') {
        prose.textContent = '';
    }
    for (const para of String(text).split(/\n{2,}/)) {
        if (!para.trim()) {
            continue;
        }
        const p = document.createElement('p');
        p.textContent = para.trim();
        prose.appendChild(p);
    }
    updateStoryDoc(activeStoryDocId, readStoryEditorState(prose));
    // Land the view on the freshly written prose.
    const editor = getRealStoryEditor();
    requestAnimationFrame(() => { if (editor) editor.scrollTop = editor.scrollHeight; });
}

// Toggles the generating state class + the writing indicator. The controls
// (Continue / Stop) are CSS-driven off this class.
function setStoryGeneratingUI(on) {
    document.body.classList.toggle('remodel-storydoc-generating', Boolean(on));
    const editor = getRealStoryEditor();
    const continueButton = editor?.querySelector('[data-remodel-storydoc-continue]');
    const stopButton = editor?.querySelector('[data-remodel-storydoc-stop]');
    if (continueButton) continueButton.disabled = Boolean(on);
    if (stopButton) stopButton.disabled = !on;
    const indicator = editor?.querySelector('[data-remodel-storydoc-indicator]');
    if (indicator) {
        if (on) {
            indicator.classList.remove('remodel-storydoc-indicator-error');
            indicator.textContent = 'Writing…';
        } else if (!indicator.classList.contains('remodel-storydoc-indicator-error')) {
            indicator.textContent = '';
        }
    }
}

function insertStoryBeatProse(beatId, text) {
    const doc = getStoryDoc(activeStoryDocId);
    const beat = doc?.beats?.find((item) => item.id === beatId);
    if (!doc || !beat) return;
    const position = Math.max(0, Math.min(doc.body.length, Number(beat.position) || 0));
    const prefix = doc.body.slice(0, position);
    const suffix = doc.body.slice(position);
    const before = prefix && !prefix.endsWith('\n\n') ? '\n\n' : '';
    const after = suffix && !suffix.startsWith('\n\n') ? '\n\n' : '';
    const inserted = `${before}${text}${after}`;
    const beats = doc.beats.map((item) => item.id === beatId
        ? { ...item, generatedText: text, updatedAt: new Date().toISOString() }
        : { ...item, position: item.position > position ? item.position + inserted.length : item.position });
    updateStoryDoc(activeStoryDocId, { body: `${prefix}${inserted}${suffix}`, beats });
}

function buildStoryGenerationPrompt({ docText = '', contextBlock = '', mode = 'continue', beat = '' } = {}) {
    const doc = getStoryDoc(activeStoryDocId);
    const tail = docText.length > 12000 ? docText.slice(-12000) : docText;
    const direction = mode === 'beat' && beat.trim()
        ? `[Write the next part of the story following this scene beat: ${beat.trim()}]`
        : '[Continue the manuscript with the next passage.]';
    return [doc?.priorText && `=== PRIOR SCENE TEXT ===\n${doc.priorText}`, contextBlock, tail, direction]
        .filter(Boolean).join('\n\n');
}

function showStoryGenError(message = 'Generation failed — try again.') {
    const indicator = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-indicator]');
    if (indicator) {
        indicator.textContent = message;
        indicator.classList.add('remodel-storydoc-indicator-error');
        setTimeout(() => {
            if (indicator.textContent === message) {
                indicator.textContent = '';
                indicator.classList.remove('remodel-storydoc-indicator-error');
            }
        }, 6000);
    }
}

function stopStoryGeneration() {
    const ctx = getContext();
    ctx.eventSource?.emit?.(ctx.eventTypes.GENERATION_STOPPED);
}

// =====================================================================
// ROLEPLAY WORKSPACE
// ---------------------------------------------------------------------
// The Roleplay counterpart to the manuscript overlay: instead of one
// flowing contenteditable prose surface, it renders the same underlying
// chat[] as a stream of per-speaker chat bubbles (characters left, the
// user/persona right, narrator centered), plus a left cast column and a
// turn/speaker control bar. Same foundational contract as Story mode —
// the real #chat rows stay the hidden data source, this is a separate
// presentation layer built fresh from chat[] on every render trigger, and
// edits/sends still drive core's real buttons underneath. NOT
// contenteditable: roleplay bubbles are read-only in-place (edit opens the
// message's own editor, same as native), so no boundary-protection or
// beat-guard machinery is needed here.
// =====================================================================

const ROLEPLAY_ROOT_ID = 'remodel-roleplay-root';

// Same Background-tab duplicate-ID scoping as getRealManuscriptOverlay —
// see its comment. Resolved through the real #sheld under body so a click
// never lands on the dead hidden clone.
function getRealRoleplayRoot() {
    return document.body.querySelector(`:scope > #sheld > #${ROLEPLAY_ROOT_ID}`);
}

function ensureRoleplayRoot() {
    let root = getRealRoleplayRoot();
    if (root) {
        return root;
    }
    const chatEl = getRealChatElement();
    if (!chatEl) {
        return null;
    }
    root = document.createElement('div');
    root.id = ROLEPLAY_ROOT_ID;
    // Structural skeleton built once; contents (cast + stream + composer)
    // are re-rendered from chat[] on every refresh, same "re-derive from
    // source" discipline the manuscript overlay uses. The cast column
    // spans both rows on the left; the stream and composer stack on the
    // right (grid areas defined in style.css).
    root.innerHTML = `
        <aside class="remodel-rp-cast" data-remodel-rp-cast></aside>
        <div class="remodel-rp-stream" data-remodel-rp-stream></div>
        <div class="remodel-rp-composer-zone" data-remodel-rp-composer></div>
    `;
    chatEl.after(root);
    return root;
}

// Builds the roleplay composer zone: the turn/speaker control bar plus the
// persona input row. Rebuilt on each render so the "speak as" chip and the
// per-member active toggles reflect the current cast/persona. Sends drive
// core's real #send_textarea + #send_but underneath — the same reliable
// path the story composer uses — so generation, group activation, swipes,
// and World Info all run exactly as native.
function renderRoleplayComposer(root) {
    const zone = root.querySelector('[data-remodel-rp-composer]');
    if (!zone) {
        return;
    }
    const context = getContext();
    const members = roleplaySceneMembers(context);
    const personaName = context.name1 || 'You';

    // Active-member toggles: only meaningful for a group. For a solo chat,
    // there's just the one character and nothing to toggle.
    const memberToggles = context.groupId
        ? members.map((m) => `
            <span class="remodel-rp-active-dot remodel-rp-color-${roleplaySpeakerColor(m.name)}" data-remodel-rp-member="${escapeAttribute(String(m.characterId ?? ''))}">
                <span class="remodel-rp-dot"></span>${escapeHtml(m.name)}
            </span>`).join('')
        : '';

    // Next speaker only means something in a group; in a solo scene there's
    // one character, so it's fixed to "AI decides" and not a menu.
    const inGroup = Boolean(context.groupId);
    const nextSpeakerAttrs = inGroup
        ? 'data-remodel-rp-nextspeaker-menu role="button" tabindex="0"'
        : '';
    const triggerAttrs = inGroup
        ? 'data-remodel-rp-action="trigger"'
        : 'data-remodel-rp-act-disabled="Only in group scenes — there\'s just one character here"';

    zone.innerHTML = `
        <div class="remodel-rp-turn-bar">
            <div class="remodel-rp-speaker-select" data-remodel-rp-persona-menu role="button" tabindex="0" title="Speaking as ${escapeAttribute(personaName)} — click to switch persona">
                <span class="remodel-rp-chip-av">${escapeHtml(roleplayInitials(personaName))}</span>
                <span class="remodel-rp-speaker-lbl">${escapeHtml(personaName)}</span>
                <span class="remodel-rp-caret">▾</span>
            </div>
            <div class="remodel-rp-seg ${inGroup ? 'remodel-rp-seg-menu' : ''}" ${nextSpeakerAttrs} title="${inGroup ? 'Who speaks next' : 'The AI decides who speaks next'}"><span class="remodel-rp-seg-k">Next speaker</span><span class="remodel-rp-seg-v">AI decides</span>${inGroup ? '<span class="remodel-rp-caret">▾</span>' : ''}</div>
        </div>

        <div class="remodel-rp-action-row">
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="regenerate"><span class="remodel-rp-g">↺</span> Regenerate</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="next"><span class="remodel-rp-g">▷</span> Next</button>
            <button type="button" class="remodel-rp-act" ${triggerAttrs}><span class="remodel-rp-g">✦</span> Trigger…</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="impersonate"><span class="remodel-rp-g">✎</span> Write for me</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="preview"><span class="remodel-rp-g">◉</span> Preview</button>
            ${renderScenePromptChoice(getActiveScene(), true)}
            <span class="remodel-rp-spacer"></span>
            ${memberToggles}
        </div>

        <div class="remodel-rp-composer">
            <button type="button" class="remodel-rp-as-chip" data-remodel-rp-persona-menu title="Speak as… — click to switch persona">
                <span class="remodel-rp-as-av">${escapeHtml(roleplayInitials(personaName))}</span>
                <span class="remodel-rp-as-txt"><span class="remodel-rp-as-k">Speak as</span><span class="remodel-rp-as-v">${escapeHtml(personaName)}</span></span>
            </button>
            <textarea class="remodel-rp-input" data-remodel-rp-input placeholder="Write as ${escapeAttribute(personaName)}…" rows="1"></textarea>
            <button type="button" class="remodel-rp-send" data-remodel-rp-send title="Send">➤</button>
        </div>

        <div class="remodel-rp-composer-meta">
            <span data-remodel-rp-meta-left></span>
            <span>${members.length} character${members.length === 1 ? '' : 's'} in scene</span>
        </div>
    `;
}

// --- Turn-bar menus: persona switch + next speaker -----------------------

// A small popover menu anchored under a trigger element. Reused by the
// persona and next-speaker pills. items: [{ id, label, sublabel?, avatar?,
// initials?, active? }]; onPick receives the chosen id. Only one menu open
// at a time; clicking elsewhere or Escape closes it.
function openRoleplayMenu(anchor, items, onPick) {
    closeRoleplayMenu();
    if (!anchor || !Array.isArray(items) || items.length === 0) {
        return;
    }
    const menu = document.createElement('div');
    menu.className = 'remodel-rp-menu';
    menu.id = 'remodel-rp-menu';
    menu.innerHTML = items.map((it) => `
        <button type="button" class="remodel-rp-menu-item${it.active ? ' remodel-rp-menu-item-active' : ''}" data-remodel-rp-menu-pick="${escapeAttribute(String(it.id))}">
            ${it.avatar || it.initials
        ? `<span class="remodel-rp-menu-av"${it.avatar ? ` style="background-image:url('${escapeAttribute(it.avatar)}')"` : ''}>${it.avatar ? '' : escapeHtml(it.initials)}</span>`
        : ''}
            <span class="remodel-rp-menu-txt">
                <span class="remodel-rp-menu-lbl">${escapeHtml(it.label)}</span>
                ${it.sublabel ? `<span class="remodel-rp-menu-sub">${escapeHtml(it.sublabel)}</span>` : ''}
            </span>
            ${it.active ? '<span class="remodel-rp-menu-check">✓</span>' : ''}
        </button>`).join('');

    menu._remodelOnPick = onPick;
    document.body.appendChild(menu);

    // Position above the anchor (the turn bar sits near the bottom of the
    // stream, so a downward menu would overflow the composer).
    const rect = anchor.getBoundingClientRect();
    menu.style.visibility = 'hidden';
    requestAnimationFrame(() => {
        const mh = menu.offsetHeight;
        const top = rect.top - mh - 8;
        menu.style.left = `${Math.max(8, rect.left)}px`;
        menu.style.top = `${top > 8 ? top : rect.bottom + 8}px`;
        menu.style.visibility = 'visible';
        menu.classList.add('remodel-rp-menu-in');
    });
}

function closeRoleplayMenu() {
    const menu = document.getElementById('remodel-rp-menu');
    if (menu) {
        menu.remove();
    }
}

// Builds the persona list for the speak-as menu from core's persona map
// (powerUserSettings.personas: { avatarId: name }). The active persona is
// the current user_avatar, read from the selected native persona element.
function openRoleplayPersonaMenu(anchor) {
    const context = getContext();
    const personas = context.powerUserSettings?.personas || {};
    const currentAvatarId = currentPersonaAvatarId();

    const items = Object.entries(personas).map(([avatarId, name]) => ({
        id: avatarId,
        label: String(name || avatarId),
        avatar: context.getThumbnailUrl('persona', avatarId),
        initials: roleplayInitials(String(name || avatarId)),
        active: avatarId === currentAvatarId,
    }));

    if (items.length === 0) {
        showRoleplayToast('No personas defined. Create one in the Persona Management panel.');
        return;
    }

    openRoleplayMenu(anchor, items, (avatarId) => switchRoleplayPersona(avatarId));
}

// The active persona's avatar id — read from the native persona block's
// selected entry (user_avatar isn't exposed on context).
function currentPersonaAvatarId() {
    const selected = document.querySelector('#user_avatar_block .avatar-container.selected');
    return selected instanceof HTMLElement ? (selected.getAttribute('data-avatar-id') || null) : null;
}

// Switches the persona via core's setUserAvatar, then re-renders the
// composer so the pill/label reflect the new persona.
async function switchRoleplayPersona(avatarId) {
    closeRoleplayMenu();
    try {
        await setUserAvatar(avatarId, { toastPersonaNameChange: false });
    } catch (err) {
        console.error('Remodel: persona switch failed', err);
    }
    const root = getRealRoleplayRoot();
    if (root) {
        renderRoleplayComposer(root);
    }
}

// Next-speaker menu: "AI decides" (clears any forced next speaker — the
// default group behavior) plus one entry per cast member. Picking a member
// triggers a generation for that specific character via /trigger <name>.
function openRoleplayNextSpeakerMenu(anchor) {
    const context = getContext();
    if (!context.groupId) {
        return;
    }
    const members = roleplaySceneMembers(context);
    const items = [
        { id: '__ai__', label: 'AI decides', sublabel: 'Group picks the next speaker' },
        ...members.map((m) => ({
            id: m.name,
            label: m.name,
            avatar: (() => {
                const av = roleplayCharacterAvatar({ characterId: m.characterId, name: m.name });
                return av ? context.getThumbnailUrl('avatar', av) : '';
            })(),
            initials: roleplayInitials(m.name),
            sublabel: 'Speaks next',
        })),
    ];
    openRoleplayMenu(anchor, items, (id) => {
        closeRoleplayMenu();
        if (id === '__ai__') {
            // Nothing to force — the group's own strategy decides. Reflect it
            // in the label and let the normal Send/Next flow proceed.
            setRoleplayNextSpeakerLabel('AI decides');
            return;
        }
        setRoleplayNextSpeakerLabel(id);
        triggerRoleplaySpeaker(id);
    });
}

function setRoleplayNextSpeakerLabel(text) {
    const el = getRealRoleplayRoot()?.querySelector('.remodel-rp-seg .remodel-rp-seg-v');
    if (el) {
        el.textContent = text;
    }
}

// Triggers a generation for a specific group member by name via the native
// /trigger slash command (the supported way to make one member speak next).
async function triggerRoleplaySpeaker(name) {
    const context = getContext();
    setRoleplayGenerating(true);
    showRoleplayTypingIndicator();
    try {
        await context.executeSlashCommands(`/trigger ${name}`);
    } catch (err) {
        console.error('Remodel: trigger speaker failed', err);
        setRoleplayGenerating(false);
    }
}

// Prompt preview: assembles (but never sends) the exact prompt that a normal
// turn would produce right now — reusing the same dry-run + formatter the
// Story workspace's preview uses — and shows it in a read-only modal. Honest
// "here's what the model will actually see," including whatever's typed in
// the composer.
const ROLEPLAY_PREVIEW_ID = 'remodel-rp-preview-modal';

async function openRoleplayPromptPreview() {
    // Build the modal shell immediately with a loading state so the click is
    // acknowledged, then fill it once the dry run resolves.
    document.getElementById(ROLEPLAY_PREVIEW_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = ROLEPLAY_PREVIEW_ID;
    overlay.className = 'remodel-rp-picker-scrim';
    overlay.innerHTML = `
        <div class="remodel-rp-preview" data-remodel-rp-preview-stop>
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">Prompt preview</div>
                    <div class="remodel-rp-picker-hint">Exactly what the model will receive on the next turn — nothing is sent.</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-rp-preview-close aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-preview-warn" data-remodel-rp-preview-warn hidden></div>
            <pre class="remodel-rp-preview-body" data-remodel-rp-preview-body>Assembling prompt…</pre>
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));

    try {
        const { generateData, warnings } = await runPromptPreviewDryRun('normal');
        const bodyEl = overlay.querySelector('[data-remodel-rp-preview-body]');
        const warnEl = overlay.querySelector('[data-remodel-rp-preview-warn]');
        if (bodyEl) {
            bodyEl.textContent = formatPromptPreview(generateData);
        }
        if (warnEl && Array.isArray(warnings) && warnings.length > 0) {
            warnEl.textContent = `⚠ ${warnings.join(' · ')}`;
            warnEl.hidden = false;
        }
    } catch (err) {
        const bodyEl = overlay.querySelector('[data-remodel-rp-preview-body]');
        if (bodyEl) {
            bodyEl.textContent = `Could not assemble a preview.\n\n${String(err)}`;
        }
    }
}

function closeRoleplayPromptPreview() {
    const overlay = document.getElementById(ROLEPLAY_PREVIEW_ID);
    if (!overlay) {
        return;
    }
    overlay.classList.remove('remodel-rp-picker-in');
    setTimeout(() => overlay.remove(), 200);
}

// Sends the roleplay composer's text as a user message and lets core
// generate the reply — by driving the real #send_textarea + #send_but,
// exactly the mechanism the story composer relies on (so group activation,
// swipes, World Info, and generation all run native). An empty send
// falls through to core's own continue behavior via the composer's own
// keydown handling elsewhere; this explicit-send path always sends.
function handleRoleplaySend(root) {
    const input = root.querySelector('[data-remodel-rp-input]');
    const textarea = document.getElementById('send_textarea');
    const sendBut = document.getElementById('send_but');
    if (!(input instanceof HTMLTextAreaElement) || !(textarea instanceof HTMLTextAreaElement) || !sendBut) {
        return;
    }
    const value = input.value;
    if (!value.trim()) {
        return;
    }
    input.value = '';
    autosizeRoleplayInput(input);
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // Immediate feedback: flip the generating state on right away rather
    // than waiting for GENERATION_STARTED (there's real latency between the
    // click and that event — the gap where "nothing looks like it's
    // happening"). The event handler is idempotent, so an early flip here
    // plus the event later is harmless; GENERATION_ENDED clears it.
    setRoleplayGenerating(true);
    sendBut.click();
    // The user's own line renders via USER_MESSAGE_RENDERED; show the
    // pending speaker bubble on the next frame so it lands after it.
    requestAnimationFrame(() => showRoleplayTypingIndicator());
}

// One-line-growing textarea, capped so a long message scrolls inside the
// composer rather than pushing the stream off-screen.
function autosizeRoleplayInput(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

// Maps the roleplay action buttons onto core's real controls. Reuses the
// same native buttons the story action bar drives, so behavior is
// identical to native — no reimplementation of generation/regeneration.
function handleRoleplayAction(action) {
    switch (action) {
        case 'regenerate': {
            // core's regenerate = swipe/regenerate the last message. Flip the
            // generating state ourselves before clicking: core's own group
            // turn handling (generateGroupWrapper) flips the native group
            // panel to a full-screen modal as an unrelated internal side
            // effect, which the CSS in style.css suppresses ONLY while
            // remodel-roleplay-generating is set — this must be true before
            // the click, not after GENERATION_STARTED gets around to it.
            setRoleplayGenerating(true);
            showRoleplayTypingIndicator();
            document.getElementById('option_regenerate')?.click();
            break;
        }
        case 'next': {
            // Advance the group's turn / continue — core's continue option.
            setRoleplayGenerating(true);
            showRoleplayTypingIndicator();
            document.getElementById('option_continue')?.click();
            break;
        }
        case 'trigger': {
            // Pick a specific cast member to speak next (same menu as the
            // "Next speaker" pill). Anchored to the Trigger button.
            const btn = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-action="trigger"]');
            openRoleplayNextSpeakerMenu(btn);
            break;
        }
        case 'impersonate': {
            // "Write for me" — impersonate generation isn't in
            // STORY_GENERATION_TYPES (it's a quiet-adjacent type, not a story
            // turn), so GENERATION_STARTED won't flip remodel-roleplay-
            // generating for it. Set it directly so the group-panel
            // suppression above still applies.
            setRoleplayGenerating(true);
            document.getElementById('option_impersonate')?.click();
            break;
        }
        case 'preview': {
            openRoleplayPromptPreview();
            break;
        }
        case 'add-cast': {
            openRoleplayCastManagement();
            break;
        }
        default:
            break;
    }
}

// The cast "+" opens Remodel's own picker in 'add' mode (excluding whoever's
// already cast) and, on confirm, brings each chosen character into the scene
// — promoting a solo scene to a group on the first add, or appending to an
// existing group. Drives core's real group API under the hood
// (addCharacterToRoleplayScene).
function openRoleplayCastManagement() {
    const context = getContext();
    const already = roleplaySceneMembers(context)
        .map((m) => roleplayCharacterAvatar({ characterId: m.characterId, name: m.name }))
        .filter(Boolean);

    openRoleplayCastPicker({
        mode: 'add',
        excludeAvatars: already,
        onConfirm: async (avatars) => {
            for (const avatar of avatars) {
                // Sequential: each add may promote solo→group or reload the
                // chat, which the next add needs to see settled first.
                // eslint-disable-next-line no-await-in-loop
                await addCharacterToRoleplayScene(avatar);
            }
        },
    });
}

// Delegated listeners for the roleplay composer/turn-bar. Bound at document
// level (not on the root, which is rebuilt) and gated on
// isRealRoleplayWorkspaceActive() so nothing fires outside a roleplay scene.
function bindRoleplayComposerEvents() {
    // Send button + action buttons (click).
    document.addEventListener('click', (event) => {
        if (!isRealRoleplayWorkspaceActive()) {
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (!target) {
            return;
        }

        // Prompt-preview modal (in <body>): close on the × or scrim click.
        const previewOverlay = document.getElementById(ROLEPLAY_PREVIEW_ID);
        if (previewOverlay) {
            if (target.closest('[data-remodel-rp-preview-close]') || target === previewOverlay) {
                event.preventDefault();
                closeRoleplayPromptPreview();
                return;
            }
        }

        // Popover menu (persona / next-speaker) lives in <body>, outside the
        // roleplay root — handle picks and outside-click-to-close here first.
        const menu = document.getElementById('remodel-rp-menu');
        if (menu) {
            const pick = target.closest('[data-remodel-rp-menu-pick]');
            if (pick && menu.contains(pick)) {
                event.preventDefault();
                const onPick = menu._remodelOnPick;
                const id = pick.getAttribute('data-remodel-rp-menu-pick');
                closeRoleplayMenu();
                onPick?.(id);
                return;
            }
            // A click anywhere that isn't the menu itself (or the trigger that
            // would reopen it) closes it.
            if (!menu.contains(target) && !target.closest('[data-remodel-rp-persona-menu], [data-remodel-rp-nextspeaker-menu], [data-remodel-scene-prompt-choice]')) {
                closeRoleplayMenu();
                // fall through — the click may also be a real control.
            }
        }

        // Panels live in #sheld, outside the roleplay root — handle their
        // toggle/close buttons before the root-containment guard below.
        const panelToggle = target.closest('[data-remodel-rp-panel-toggle]');
        if (panelToggle) {
            event.preventDefault();
            toggleRoleplayPanel(panelToggle.getAttribute('data-remodel-rp-panel-toggle'));
            return;
        }
        const panelClose = target.closest('[data-remodel-rp-panel-close]');
        if (panelClose) {
            event.preventDefault();
            closeRoleplayPanel(panelClose.getAttribute('data-remodel-rp-panel-close'));
            return;
        }

        // Dice panel controls (also outside the roleplay root).
        const quickRoll = target.closest('[data-remodel-rp-roll]');
        if (quickRoll) {
            event.preventDefault();
            performRoleplayDiceRoll(quickRoll.getAttribute('data-remodel-rp-roll'));
            return;
        }
        const advBtn = target.closest('[data-remodel-rp-adv]');
        if (advBtn) {
            event.preventDefault();
            setRoleplayDiceAdvantage(advBtn.getAttribute('data-remodel-rp-adv'));
            return;
        }
        if (target.closest('[data-remodel-rp-dice-go]')) {
            event.preventDefault();
            const input = document.querySelector('[data-remodel-rp-dice-input]');
            if (input instanceof HTMLInputElement) {
                performRoleplayDiceRoll(input.value);
            }
            return;
        }

        const root = getRealRoleplayRoot();
        if (!root || !root.contains(target)) {
            return;
        }

        if (target.closest('[data-remodel-rp-send]')) {
            event.preventDefault();
            handleRoleplaySend(root);
            return;
        }

        // Persona (speak-as) menu — both the turn-bar pill and the composer
        // chip open it.
        const promptChoice = target.closest('[data-remodel-scene-prompt-choice]');
        if (promptChoice) {
            event.preventDefault();
            openScenePromptRecipeMenu(promptChoice);
            return;
        }

        const personaTrigger = target.closest('[data-remodel-rp-persona-menu]');
        if (personaTrigger) {
            event.preventDefault();
            openRoleplayPersonaMenu(personaTrigger);
            return;
        }

        // Next-speaker menu (group scenes only).
        const nextSpeakerTrigger = target.closest('[data-remodel-rp-nextspeaker-menu]');
        if (nextSpeakerTrigger) {
            event.preventDefault();
            openRoleplayNextSpeakerMenu(nextSpeakerTrigger);
            return;
        }

        // Honest feedback for controls that aren't wired yet: rather than
        // silently doing nothing, say why with a small toast.
        const disabledCtrl = target.closest('[data-remodel-rp-act-disabled], [data-remodel-rp-soon]');
        if (disabledCtrl) {
            event.preventDefault();
            const msg = disabledCtrl.getAttribute('data-remodel-rp-act-disabled')
                || disabledCtrl.getAttribute('data-remodel-rp-soon');
            showRoleplayToast(msg);
            return;
        }

        const actionBtn = target.closest('[data-remodel-rp-action]');
        if (actionBtn) {
            event.preventDefault();
            flashRoleplayButton(actionBtn);
            handleRoleplayAction(actionBtn.getAttribute('data-remodel-rp-action'));
            return;
        }

        // Inline-edit Save / Cancel.
        const editBtn = target.closest('[data-remodel-rp-edit]');
        if (editBtn) {
            event.preventDefault();
            const row = editBtn.closest('[data-remodel-mesid]');
            const mesId = Number(row?.dataset.remodelMesid);
            if (editBtn.getAttribute('data-remodel-rp-edit') === 'save') {
                commitRoleplayBubbleEdit(mesId, row);
            } else {
                renderRoleplayScene(); // cancel = discard, re-render from chat[]
            }
            return;
        }

        // Per-bubble controls (edit / delete / swipe).
        const bubbleCtrl = target.closest('[data-remodel-rp-bubble]');
        if (bubbleCtrl) {
            event.preventDefault();
            const row = bubbleCtrl.closest('[data-remodel-mesid]');
            const mesId = Number(row?.dataset.remodelMesid);
            handleRoleplayBubbleControl(bubbleCtrl.getAttribute('data-remodel-rp-bubble'), mesId, row);
            return;
        }

        // Cast: remove a member.
        const castRemove = target.closest('[data-remodel-rp-cast-remove]');
        if (castRemove) {
            event.preventDefault();
            const avatar = castRemove.getAttribute('data-remodel-rp-cast-remove');
            const member = roleplaySceneMembers(getContext()).find(
                (m) => roleplayCharacterAvatar({ characterId: m.characterId, name: m.name }) === avatar,
            );
            const who = member?.name || 'this character';
            if (confirm(`Remove ${who} from the scene?`)) {
                removeCharacterFromRoleplayScene(avatar);
            }
            return;
        }
    });

    // Enter-to-send + autosize in the roleplay input; Enter-to-roll in the
    // dice notation input.
    document.addEventListener('keydown', (event) => {
        if (!isRealRoleplayWorkspaceActive()) {
            return;
        }
        const el = event.target instanceof Element ? event.target : null;
        if (!el) {
            return;
        }

        const diceInput = el.closest('[data-remodel-rp-dice-input]');
        if (diceInput instanceof HTMLInputElement) {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                performRoleplayDiceRoll(diceInput.value);
            }
            return;
        }

        // Inline bubble editor: Ctrl/Cmd+Enter saves, Escape cancels.
        const editArea = el.closest('.remodel-rp-edit-area');
        if (editArea) {
            const row = editArea.closest('[data-remodel-mesid]');
            const mesId = Number(row?.dataset.remodelMesid);
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                commitRoleplayBubbleEdit(mesId, row);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                renderRoleplayScene();
            }
            return;
        }

        const input = el.closest('[data-remodel-rp-input]');
        if (!input) {
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
            event.preventDefault();
            const root = getRealRoleplayRoot();
            if (root) {
                handleRoleplaySend(root);
            }
        }
    });

    document.addEventListener('input', (event) => {
        if (!isRealRoleplayWorkspaceActive()) {
            return;
        }
        const el = event.target instanceof Element ? event.target : null;
        if (!el) {
            return;
        }
        const editArea = el.closest('.remodel-rp-edit-area');
        if (editArea instanceof HTMLTextAreaElement) {
            autosizeRoleplayEdit(editArea);
            return;
        }
        const input = el.closest('[data-remodel-rp-input]');
        if (input instanceof HTMLTextAreaElement) {
            autosizeRoleplayInput(input);
            return;
        }
        const rules = el.closest('[data-remodel-rp-rules]');
        if (rules instanceof HTMLTextAreaElement) {
            writeRoleplayRulesNotes(rules.value);
        }
    });
}

// Live generation feedback for the roleplay workspace. Hooks the same
// GENERATION_STARTED/ENDED/STOPPED + STREAM_TOKEN_RECEIVED events the story
// side uses, but drives a roleplay-specific typing indicator (a pending
// speaker bubble that fills with live streamed text) plus a body class
// (remodel-roleplay-generating) the CSS keys the send-button spinner and
// disabled states off of. Filtered to real user-facing turns via the same
// STORY_GENERATION_TYPES table so background/quiet generations don't flip
// the indicator on with nothing visibly happening.
function bindRoleplayGenerationFeedback() {
    const context = getContext();

    context.eventSource.on(context.eventTypes.GENERATION_STARTED, (type, options, dryRun) => {
        if (!isRealRoleplayWorkspaceActive() || dryRun || !STORY_GENERATION_TYPES.has(type)) {
            return;
        }
        setRoleplayGenerating(true);
        showRoleplayTypingIndicator();
    });

    const finish = () => {
        if (!document.body.classList.contains('remodel-roleplay-generating')) {
            return;
        }
        setRoleplayGenerating(false);
        // The finished message will render via the normal
        // MESSAGE_RECEIVED → renderRoleplayScene path, which rebuilds the
        // stream and drops the indicator; nudge a render in case the event
        // ordering leaves the indicator briefly orphaned.
        renderRoleplayScene();
    };
    context.eventSource.on(context.eventTypes.GENERATION_ENDED, finish);
    context.eventSource.on(context.eventTypes.GENERATION_STOPPED, finish);

    // Live streamed text into the pending typing bubble.
    context.eventSource.on(context.eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
        if (!isRealRoleplayWorkspaceActive() || !document.body.classList.contains('remodel-roleplay-generating')) {
            return;
        }
        updateRoleplayTypingText(text);
    });
}

function setRoleplayGenerating(on) {
    document.body.classList.toggle('remodel-roleplay-generating', Boolean(on));
    if (!on) {
        removeRoleplayTypingIndicator();
    }
}

// The pending "someone is composing" bubble at the bottom of the stream.
// Guesses the upcoming speaker: in a group we can't know for sure until the
// message arrives, so it shows a neutral "…" until the first token names a
// speaker; in a solo scene it's the one character.
function showRoleplayTypingIndicator() {
    const root = getRealRoleplayRoot();
    const stream = root?.querySelector('[data-remodel-rp-stream]');
    if (!stream || stream.querySelector('.remodel-rp-typing')) {
        return;
    }

    const context = getContext();
    const members = roleplaySceneMembers(context);
    const speaker = context.groupId ? null : members[0];
    const name = speaker?.name || '';
    const color = name ? roleplaySpeakerColor(name) : null;

    const row = document.createElement('div');
    row.className = `remodel-rp-msg remodel-rp-character remodel-rp-typing`;
    if (color) {
        row.classList.add(`remodel-rp-color-${color}`);
    }

    const avatar = speaker
        ? buildRoleplayAvatar(name)
        : (() => { const d = document.createElement('div'); d.className = 'remodel-rp-avatar'; d.textContent = '…'; return d; })();
    row.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'remodel-rp-bubble';
    bubble.innerHTML = `
        <div class="remodel-rp-meta">
            <span class="remodel-rp-name">${escapeHtml(name || 'Composing')}</span>
            <span class="remodel-rp-typing-dots"><span></span><span></span><span></span></span>
        </div>
        <div class="remodel-rp-body remodel-rp-typing-body" data-remodel-rp-typing-body></div>
    `;
    row.appendChild(bubble);
    stream.appendChild(row);
    requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
}

function updateRoleplayTypingText(text) {
    const root = getRealRoleplayRoot();
    const body = root?.querySelector('[data-remodel-rp-typing-body]');
    if (!body) {
        return;
    }
    body.textContent = String(text ?? '');
    const stream = root.querySelector('[data-remodel-rp-stream]');
    if (stream) {
        stream.scrollTop = stream.scrollHeight;
    }
}

function removeRoleplayTypingIndicator() {
    getRealRoleplayRoot()?.querySelector('.remodel-rp-typing')?.remove();
}

// Brief, non-blocking toast anchored to the roleplay workspace — used to
// explain why an unwired control did nothing, so a click always produces a
// visible response. Auto-dismisses; only one at a time.
let roleplayToastTimer = null;
function showRoleplayToast(message) {
    const root = getRealRoleplayRoot();
    if (!root || !message) {
        return;
    }
    root.querySelector('.remodel-rp-toast')?.remove();
    clearTimeout(roleplayToastTimer);

    const toast = document.createElement('div');
    toast.className = 'remodel-rp-toast';
    toast.textContent = message;
    root.appendChild(toast);
    // Force a reflow so the enter transition runs.
    void toast.offsetWidth;
    toast.classList.add('remodel-rp-toast-in');
    roleplayToastTimer = setTimeout(() => {
        toast.classList.remove('remodel-rp-toast-in');
        setTimeout(() => toast.remove(), 220);
    }, 2600);
}

// A quick press flash on an action button so the click is acknowledged even
// when the underlying core action takes a moment to visibly do anything.
function flashRoleplayButton(button) {
    if (!(button instanceof Element)) {
        return;
    }
    button.classList.remove('remodel-rp-act-flash');
    void button.offsetWidth;
    button.classList.add('remodel-rp-act-flash');
    setTimeout(() => button.classList.remove('remodel-rp-act-flash'), 320);
}

// Resolves a stable, per-name accent from the extension's own Nord aurora
// palette (see style.css --c-* / --nord-aurora-*), so each speaker keeps a
// consistent color across the whole scene without needing per-character
// config. Hash the name to one of the palette slots — deterministic, so
// "Robin" is always the same color in a given scene. The user/persona and
// the narrator are handled separately (gold / neutral) and never routed
// here.
const ROLEPLAY_SPEAKER_COLORS = ['green', 'yellow', 'frost', 'purple', 'orange', 'red'];

function roleplaySpeakerColor(name) {
    const key = String(name || '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return ROLEPLAY_SPEAKER_COLORS[hash % ROLEPLAY_SPEAKER_COLORS.length];
}

// Two-letter avatar initials from a display name ("Robin" -> "R",
// "Nico Robin" -> "NR") — the letter-tile shown when a speaker has no
// real avatar image to fall back on.
function roleplayInitials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return '?';
    }
    if (parts.length === 1) {
        return parts[0].slice(0, 1).toUpperCase();
    }
    return (parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}

// Resolves the avatar image filename a speaker should use. Prefers an
// explicit per-message override (extra.force_avatar, set by group chats
// and /sendas), then the named character's card, then the persona avatar
// for the user. Returns null when only initials are available.
function roleplayAvatarFile(name, { message = null, isUser = false } = {}) {
    const context = getContext();
    const forced = message?.extra?.force_avatar;
    if (forced) {
        // force_avatar is a full thumbnail URL already, not a bare filename.
        return { url: forced };
    }
    if (isUser) {
        // The persona avatar isn't exposed on context; read the active
        // persona thumbnail straight from core's avatar block (already a
        // resolved thumbnail URL), falling back to initials when none.
        const selected = document.querySelector('#user_avatar_block .avatar-container.selected img, #user_avatar_block .avatar-container[data-avatar-id].selected img');
        const src = selected instanceof HTMLImageElement ? selected.getAttribute('src') : null;
        return src ? { url: src } : null;
    }
    const character = (context.characters || []).find((c) => c.name === name);
    if (character?.avatar && character.avatar !== 'none') {
        return { file: character.avatar, thumbType: 'avatar' };
    }
    return null;
}

// Builds an avatar element used by both the bubble stream and the cast
// column: a real thumbnail when one exists, an initials letter-tile
// otherwise. The color class is applied by the caller (so the initials
// tile picks up the speaker's palette gradient from CSS).
function buildRoleplayAvatar(name, { message = null, isUser = false, className = 'remodel-rp-avatar' } = {}) {
    const context = getContext();
    const el = document.createElement('div');
    el.className = className;
    const resolved = roleplayAvatarFile(name, { message, isUser });
    let url = null;
    if (resolved?.url) {
        url = resolved.url;
    } else if (resolved?.file) {
        url = context.getThumbnailUrl(resolved.thumbType, resolved.file);
    }
    if (url) {
        el.classList.add('remodel-rp-has-img');
        // Set with priority so the inline image wins over the palette
        // gradient rules (which use !important); see .remodel-rp-has-img.
        el.style.setProperty('background-image', `url('${url.replace(/'/g, "\\'")}')`, 'important');
    } else {
        el.textContent = roleplayInitials(name);
    }
    return el;
}

// Builds one chat-bubble row for a single chat[] message. Kind is one of
// 'character' | 'user' | 'narrator', deciding alignment/styling. The row
// carries data-remodel-mesid so per-bubble controls (edit/delete/swipe)
// can resolve back to the real message the same way the manuscript
// overlay's spans do.
function buildRoleplayMessage(mesId, message, { messagesSince = 0 } = {}) {
    // A dice roll gets its own centered card rather than a speaker bubble.
    if (message.extra?.remodel_dice) {
        return buildRoleplayDiceCard(mesId, message, messagesSince);
    }

    const isUser = Boolean(message.is_user);
    const isSystem = Boolean(message.is_system);
    const name = message.name || (isUser ? 'You' : 'Unknown');

    const kind = isUser ? 'user' : (isSystem ? 'narrator' : 'character');
    const color = kind === 'character' ? roleplaySpeakerColor(name) : null;

    const row = document.createElement('div');
    row.className = `remodel-rp-msg remodel-rp-${kind}`;
    if (color) {
        row.classList.add(`remodel-rp-color-${color}`);
    }
    row.dataset.remodelMesid = String(mesId);

    // Avatar: real thumbnail when the speaker has one, initials otherwise.
    if (kind !== 'narrator') {
        const avatar = buildRoleplayAvatar(name, { message, isUser });
        row.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'remodel-rp-bubble';

    const meta = document.createElement('div');
    meta.className = 'remodel-rp-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'remodel-rp-name';
    nameEl.textContent = name;
    meta.appendChild(nameEl);
    if (message.send_date) {
        const timeEl = document.createElement('span');
        timeEl.className = 'remodel-rp-time';
        // send_date is already a human-ish string in core; show it as-is,
        // trimmed to a time-looking tail if it parses, else raw.
        timeEl.textContent = formatRoleplayTime(message.send_date);
        meta.appendChild(timeEl);
    }
    bubble.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'remodel-rp-body';
    // Render through core's own messageFormatting (Showdown markdown +
    // *italic actions* + code, run through core's sanitizer) so bubbles
    // match how the native chat renders the same text — same source of
    // truth, no parallel markdown implementation to drift. display_text
    // (used by some extensions to override what's shown) is honored first,
    // exactly as core does.
    const source = message.extra?.display_text ?? message.mes ?? '';
    try {
        const context = getContext();
        body.innerHTML = context.messageFormatting(source, name, isSystem, isUser, mesId);
    } catch (err) {
        // Never let a formatting hiccup blank a bubble — fall back to text.
        body.textContent = source;
    }
    bubble.appendChild(body);

    // Per-bubble controls (edit / delete, plus swipe for the last AI line).
    // They drive core's real hidden buttons on the matching .mes row — the
    // same "never touch #chat's DOM directly" discipline the manuscript
    // overlay uses. Built into the bubble; shown on hover via CSS.
    bubble.appendChild(buildRoleplayBubbleControls(mesId, message, kind));

    row.appendChild(bubble);
    return row;
}

// The hover control strip for one bubble. Edit + Delete are available on
// every real message; Swipe only on the last message and only when it's an
// AI/character line (swiping the user's own text isn't a thing in core).
function buildRoleplayBubbleControls(mesId, message, kind) {
    const context = getContext();
    const controls = document.createElement('div');
    controls.className = 'remodel-rp-controls';

    const isLast = mesId === context.chat.length - 1;
    const canSwipe = isLast && kind === 'character' && !message.is_system;

    if (canSwipe) {
        const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 1;
        const swipeIndex = Number.isFinite(message.swipe_id) ? message.swipe_id : 0;
        const swipeWrap = document.createElement('div');
        swipeWrap.className = 'remodel-rp-swipe';
        swipeWrap.innerHTML = `
            <button type="button" class="remodel-rp-ctrl" data-remodel-rp-bubble="swipe-left" title="Previous response"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
            <span class="remodel-rp-swipe-count">${swipeIndex + 1} / ${Math.max(swipeCount, swipeIndex + 1)}</span>
            <button type="button" class="remodel-rp-ctrl" data-remodel-rp-bubble="swipe-right" title="Next / new response"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
        `;
        controls.appendChild(swipeWrap);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'remodel-rp-ctrl';
    edit.dataset.remodelRpBubble = 'edit';
    edit.title = 'Edit';
    edit.innerHTML = '<i class="fa-solid fa-pencil" aria-hidden="true"></i>';
    controls.appendChild(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'remodel-rp-ctrl remodel-rp-ctrl-danger';
    del.dataset.remodelRpBubble = 'delete';
    del.title = 'Delete';
    del.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
    controls.appendChild(del);

    return controls;
}

// Routes a per-bubble control click to the right core action. mesId comes
// from the bubble row's data-remodel-mesid.
async function handleRoleplayBubbleControl(action, mesId, row) {
    const context = getContext();
    if (!Number.isFinite(mesId) || !context.chat[mesId]) {
        return;
    }

    switch (action) {
        case 'edit':
            beginRoleplayBubbleEdit(mesId, row);
            break;
        case 'delete': {
            if (!confirm('Delete this message? This cannot be undone.')) {
                return;
            }
            await context.deleteMessage(mesId);
            renderRoleplayScene();
            break;
        }
        case 'swipe-left': {
            const mesEl = getRealChatElement()?.querySelector(`.mes[mesid="${mesId}"]`);
            mesEl?.querySelector('.swipe_left')?.click();
            // core re-renders the real row + emits events; our stream render
            // is driven off those, but nudge it in case the swipe was purely
            // local (moving to an existing prior swipe, no generation).
            setTimeout(() => renderRoleplayScene(), 60);
            break;
        }
        case 'swipe-right': {
            const mesEl = getRealChatElement()?.querySelector(`.mes[mesid="${mesId}"]`);
            mesEl?.querySelector('.swipe_right')?.click();
            setTimeout(() => renderRoleplayScene(), 60);
            break;
        }
        default:
            break;
    }
}

// Inline edit: swap the bubble body for a textarea seeded with the raw
// message text, with Save / Cancel. Commit drives core's real
// .mes_edit/.mes_edit_done via the shared openEditCloseWith helper (the
// same one the manuscript overlay uses) so the write-back runs core's
// normal edit pipeline; Cancel just re-renders from untouched chat[].
function beginRoleplayBubbleEdit(mesId, row) {
    const context = getContext();
    const message = context.chat[mesId];
    const bubble = row?.querySelector('.remodel-rp-bubble');
    const body = bubble?.querySelector('.remodel-rp-body');
    if (!bubble || !body || row.querySelector('.remodel-rp-edit')) {
        return;
    }

    const editor = document.createElement('div');
    editor.className = 'remodel-rp-edit';
    const textarea = document.createElement('textarea');
    textarea.className = 'remodel-rp-edit-area';
    textarea.value = message.mes ?? '';
    editor.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'remodel-rp-edit-actions';
    actions.innerHTML = `
        <button type="button" class="remodel-rp-edit-btn" data-remodel-rp-edit="cancel">Cancel</button>
        <button type="button" class="remodel-rp-edit-btn remodel-rp-edit-save" data-remodel-rp-edit="save">Save</button>
    `;
    editor.appendChild(actions);

    body.style.display = 'none';
    bubble.appendChild(editor);
    autosizeRoleplayEdit(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function autosizeRoleplayEdit(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 420)}px`;
}

async function commitRoleplayBubbleEdit(mesId, row) {
    const textarea = row?.querySelector('.remodel-rp-edit-area');
    if (!textarea) {
        return;
    }
    const newValue = textarea.value;
    const context = getContext();
    const original = context.chat[mesId]?.mes ?? '';

    if (newValue === original) {
        renderRoleplayScene();
        return;
    }

    try {
        await openEditCloseWith(mesId, '.mes_edit_done', newValue);
    } catch (err) {
        console.error('Roleplay bubble edit failed:', err);
    }
    renderRoleplayScene();
}

// Renders a dice roll as a centered card in the stream, built from the
// structured roll data stored on the message (extra.remodel_dice), with a
// graceful fallback to the raw text if an old/foreign dice message lacks it.
// A dice roll matters most right when it happens and fast becomes stale
// context — after enough newer lines have piled up, it fades so it stops
// competing visually with the active scene. Distance-based (messages since
// the roll), not wall-clock: a roll from 15 turns ago should look faded
// whether that took 2 minutes or 2 days.
const ROLEPLAY_DICE_FADE_TIERS = [
    { after: 4, className: 'remodel-rp-dice-fade-1' },
    { after: 8, className: 'remodel-rp-dice-fade-2' },
    { after: 14, className: 'remodel-rp-dice-fade-3' },
];

function buildRoleplayDiceCard(mesId, message, messagesSince = 0) {
    const row = document.createElement('div');
    row.className = 'remodel-rp-msg remodel-rp-dice-card';
    row.dataset.remodelMesid = String(mesId);
    for (const tier of ROLEPLAY_DICE_FADE_TIERS) {
        if (messagesSince >= tier.after) {
            row.classList.add(tier.className);
        }
    }

    const data = message.extra?.remodel_dice;
    const card = document.createElement('div');
    card.className = 'remodel-rp-dice-card-inner';

    if (data && typeof data === 'object') {
        const detail = data.rolls && data.rolls.length > 1
            ? data.rolls.join(' + ') + (data.modifier ? (data.modifier > 0 ? ` + ${data.modifier}` : ` − ${Math.abs(data.modifier)}`) : '')
            : `${data.rolls?.[0] ?? ''}${data.modifier ? (data.modifier > 0 ? ` + ${data.modifier}` : ` − ${Math.abs(data.modifier)}`) : ''}`;

        const modeTag = data.mode && data.mode !== 'normal'
            ? `<span class="remodel-rp-dice-mode">${escapeHtml(data.mode)}${data.dropped != null ? ` · dropped ${escapeHtml(String(data.dropped))}` : ''}</span>`
            : '';

        card.innerHTML = `
            <span class="remodel-rp-dice-glyph"><i class="fa-solid fa-dice-d20" aria-hidden="true"></i></span>
            <div class="remodel-rp-dice-card-main">
                <div class="remodel-rp-dice-card-top">
                    <span class="remodel-rp-dice-by">${escapeHtml(data.by || 'Someone')}</span>
                    <span class="remodel-rp-dice-formula">${escapeHtml(data.formula || '')}</span>
                    ${modeTag}
                </div>
                <div class="remodel-rp-dice-card-detail">${escapeHtml(detail)}</div>
            </div>
            <span class="remodel-rp-dice-total">${escapeHtml(String(data.total))}</span>
        `;
    } else {
        card.classList.add('remodel-rp-dice-card-plain');
        card.textContent = message.mes ?? '';
    }

    row.appendChild(card);
    return row;
}

function formatRoleplayTime(sendDate) {
    const parsed = new Date(sendDate);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return String(sendDate);
}

// Top-level roleplay render — the counterpart to renderManuscriptOverlay.
// Rebuilds the whole bubble stream from chat[]. Gated the same way the
// manuscript render is: bail unless the CURRENT scene is genuinely a
// roleplay scene.
function renderRoleplayScene() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }

    const root = ensureRoleplayRoot();
    if (!root) {
        return;
    }

    const chatEl = getRealChatElement();
    const context = getContext();
    const stream = root.querySelector('[data-remodel-rp-stream]');
    if (!stream) {
        return;
    }
    stream.textContent = '';

    const mesEls = Array.from(chatEl?.querySelectorAll(':scope > .mes') ?? []);

    if (mesEls.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'remodel-rp-empty';
        empty.textContent = 'The scene is set. Write the first line below to begin.';
        stream.appendChild(empty);
    } else {
        mesEls.forEach((mesEl, index) => {
            const mesId = Number(mesEl.getAttribute('mesid'));
            const message = context.chat[mesId];
            if (!Number.isFinite(mesId) || !message) {
                return;
            }
            // Distance from the newest message — used to fade old dice cards
            // (a roll from many turns back is stale context, not something
            // that should keep taking up visual weight forever).
            const messagesSince = mesEls.length - 1 - index;
            stream.appendChild(buildRoleplayMessage(mesId, message, { messagesSince }));
        });
        // Land at the latest line, same as the manuscript's scroll-to-bottom.
        requestAnimationFrame(() => {
            stream.scrollTop = stream.scrollHeight;
        });
    }

    renderRoleplayCast(root);
    renderRoleplayComposer(root);
    ensureRoleplayPanels();

    // A stream rebuild wipes the (non-.mes-backed) typing indicator; if a
    // generation is still in flight, put it back so the "someone is
    // composing" affordance survives the user's own message rendering.
    if (document.body.classList.contains('remodel-roleplay-generating')) {
        showRoleplayTypingIndicator();
    }
}

// Right-edge drawer panels for the roleplay workspace: a floating icon
// column (like Story mode's panelgroup) plus the Rules/Mechanics and Dice
// panels themselves. Built once, gated on a live roleplay scene; each
// panel slides in from the right edge over the stream when its icon is
// clicked (an -open class toggle, same discipline as the Story panels).
function ensureRoleplayPanels() {
    ensureRoleplayPanelGroup();
    ensureRoleplayRulesPanel();
    ensureRoleplayDicePanel();
    ensureRoleplayPriorTextPanel();
}

// Prior Text in roleplay reuses the ONE story Prior Text panel rather than a
// second instance (which would duplicate every data-* hook). A roleplay
// wrapper panel (.remodel-rp-panel, slide-in from the right like Rules/Dice)
// hosts the shared body; the story panel's own inner markup is relocated in
// and out of it via getOriginalPanelHomes(), the same origin-tracking used
// for the hamburger/wand relocation — so exactly one prior-text body lives in
// the DOM at a time, and refreshPriorTextPanel()/handlers stay unchanged.
function ensureRoleplayPriorTextPanel() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }
    let panel = document.getElementById('remodel-rp-priortext-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-rp-priortext-panel';
        panel.className = 'remodel-rp-panel remodel-rp-priortext-panel';
        panel.innerHTML = `
            <div class="remodel-rp-panel-head">
                <span class="remodel-rp-panel-title"><i class="fa-solid fa-book-open" aria-hidden="true"></i> Prior Scene Text</span>
                <button type="button" class="remodel-rp-panel-close" data-remodel-rp-panel-close="priortext" title="Close" aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-panel-body" data-remodel-rp-priortext-outlet></div>
        `;
        getRealSheld()?.appendChild(panel);
    }

    // Relocate the shared prior-text body into this panel's outlet. The body
    // lives inside #remodel-priortext-panel (story) by default; move its inner
    // .remodel-priortext-body element here while roleplay is active.
    const outlet = panel.querySelector('[data-remodel-rp-priortext-outlet]');
    let body = document.querySelector('.remodel-priortext-body');
    if (!body) {
        // Story panel hasn't been built this session — build a bare host for
        // the shared markup so roleplay has something to relocate.
        ensurePriorTextHostForRoleplay();
        body = document.querySelector('.remodel-priortext-body');
    }
    if (outlet && body && body.parentElement !== outlet) {
        if (!getOriginalPanelHomes().has(body)) {
            getOriginalPanelHomes().set(body, { parent: body.parentElement, nextSibling: body.nextSibling });
        }
        outlet.appendChild(body);
    }

    refreshPriorTextPanel();
}

// Builds the story-side #remodel-priortext-panel host (hidden) purely so its
// shared .remodel-priortext-body exists to be relocated, in the case the user
// lands directly in a roleplay scene without ever entering a story one this
// session (ensurePriorTextPanel is gated on the story workspace being active).
function ensurePriorTextHostForRoleplay() {
    if (document.getElementById('remodel-priortext-panel')) {
        return;
    }
    const panel = document.createElement('div');
    panel.id = 'remodel-priortext-panel';
    panel.className = 'remodel-priortext-panel';
    panel.innerHTML = buildPriorTextBodyMarkup();
    // Park it off-screen in the real sheld; the body gets relocated out of it.
    getRealSheld()?.appendChild(panel);
}

// Restores the shared prior-text body to the story panel when leaving
// roleplay, so the story rail's Prior Text works again. Mirror of the
// hamburger/wand restore.
function restoreRoleplayPriorTextPanel() {
    const body = document.querySelector('.remodel-priortext-body');
    if (!body) {
        return;
    }
    const home = getOriginalPanelHomes().get(body);
    if (!home) {
        return;
    }
    home.parent?.insertBefore(body, home.nextSibling);
    getOriginalPanelHomes().delete(body);
}

function ensureRoleplayPanelGroup() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }
    if (document.getElementById('remodel-rp-panelgroup')) {
        return;
    }
    const group = document.createElement('div');
    group.id = 'remodel-rp-panelgroup';
    group.className = 'remodel-rp-panelgroup';
    group.innerHTML = `
        <button type="button" class="remodel-rp-panel-icon" data-remodel-rp-panel-toggle="rules" title="Rules & Mechanics" aria-label="Rules & Mechanics">
            <i class="fa-solid fa-scroll" aria-hidden="true"></i>
        </button>
        <button type="button" class="remodel-rp-panel-icon" data-remodel-rp-panel-toggle="dice" title="Dice" aria-label="Dice">
            <i class="fa-solid fa-dice-d20" aria-hidden="true"></i>
        </button>
        <button type="button" class="remodel-rp-panel-icon" data-remodel-rp-panel-toggle="priortext" title="Prior Scene Text" aria-label="Prior Scene Text">
            <i class="fa-solid fa-book-open" aria-hidden="true"></i>
        </button>
        <button type="button" class="remodel-rp-panel-icon" data-remodel-rp-action="add-cast" title="Cast & Group Controls" aria-label="Cast & Group Controls">
            <i class="fa-solid fa-users" aria-hidden="true"></i>
        </button>
        <div class="remodel-rp-panel-icon remodel-rp-native-slot" data-remodel-rp-native-slot="options_button" title="Chat Options"></div>
        <div class="remodel-rp-panel-icon remodel-rp-native-slot" data-remodel-rp-native-slot="extensionsMenuButton" title="Extensions"></div>
    `;
    getRealSheld()?.appendChild(group);
    // The rail may be built after syncStoryWorkspaceClass already flipped
    // into roleplay (renderRoleplayScene calls ensureRoleplayPanels() on
    // every render) — relocate here too so the slots don't sit empty on
    // first render.
    relocateRoleplayNativeButtons();
}

// Rules / Mechanics panel: a free-text scratchpad for the table's house
// rules, tone, and mechanics. This is user-facing reference the writer
// keeps beside the scene — it is NOT auto-injected into prompts. Core
// already owns real prompt injection (Author's Note / World Info / system
// prompt); duplicating that here would silently double-inject. So this
// panel is deliberately a notes surface, persisted per-scene in chat
// metadata, that the user can reference or copy into a real injection
// surface themselves.
function ensureRoleplayRulesPanel() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }
    if (document.getElementById('remodel-rp-rules-panel')) {
        refreshRoleplayRulesPanel();
        return;
    }
    const panel = document.createElement('div');
    panel.id = 'remodel-rp-rules-panel';
    panel.className = 'remodel-rp-panel remodel-rp-rules-panel';
    panel.innerHTML = `
        <div class="remodel-rp-panel-head">
            <span class="remodel-rp-panel-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i> Rules &amp; Mechanics</span>
            <button type="button" class="remodel-rp-panel-close" data-remodel-rp-panel-close="rules" title="Close" aria-label="Close">×</button>
        </div>
        <div class="remodel-rp-panel-body">
            <textarea class="remodel-rp-rules-textarea" data-remodel-rp-rules placeholder="House rules, tone, mechanics — your table's reference notes. Kept beside the scene; not sent to the model automatically."></textarea>
            <p class="remodel-rp-panel-hint">These notes stay with the scene. To feed them to the model, copy into your Author's Note, World Info, or system prompt.</p>
        </div>
    `;
    getRealSheld()?.appendChild(panel);
    refreshRoleplayRulesPanel();
}

function refreshRoleplayRulesPanel() {
    const panel = document.getElementById('remodel-rp-rules-panel');
    if (!panel) {
        return;
    }
    const textarea = panel.querySelector('[data-remodel-rp-rules]');
    if (textarea && document.activeElement !== textarea) {
        textarea.value = readRoleplayRulesNotes();
    }
}

// Rules notes live in chat metadata under a remodel-namespaced key, so
// they're scoped to the scene's chat and travel with it — same storage
// discipline the scene metadata uses.
function readRoleplayRulesNotes() {
    const context = getContext();
    const meta = context.chatMetadata || {};
    return typeof meta.remodelRpRules === 'string' ? meta.remodelRpRules : '';
}

function writeRoleplayRulesNotes(value) {
    const context = getContext();
    if (!context.chatMetadata) {
        return;
    }
    context.chatMetadata.remodelRpRules = String(value ?? '');
    context.saveMetadataDebounced?.();
}

const ROLEPLAY_QUICK_DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

function ensureRoleplayDicePanel() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }
    if (document.getElementById('remodel-rp-dice-panel')) {
        return;
    }
    const panel = document.createElement('div');
    panel.id = 'remodel-rp-dice-panel';
    panel.className = 'remodel-rp-panel remodel-rp-dice-panel';
    const quickButtons = ROLEPLAY_QUICK_DICE
        .map((d) => `<button type="button" class="remodel-rp-die" data-remodel-rp-roll="1${d}">${d}</button>`)
        .join('');
    panel.innerHTML = `
        <div class="remodel-rp-panel-head">
            <span class="remodel-rp-panel-title"><i class="fa-solid fa-dice-d20" aria-hidden="true"></i> Dice</span>
            <button type="button" class="remodel-rp-panel-close" data-remodel-rp-panel-close="dice" title="Close" aria-label="Close">×</button>
        </div>
        <div class="remodel-rp-panel-body">
            <div class="remodel-rp-dice-quick">${quickButtons}</div>

            <div class="remodel-rp-dice-adv" data-remodel-rp-adv-group>
                <button type="button" class="remodel-rp-adv" data-remodel-rp-adv="normal" aria-pressed="true">Normal</button>
                <button type="button" class="remodel-rp-adv" data-remodel-rp-adv="advantage" aria-pressed="false">Advantage</button>
                <button type="button" class="remodel-rp-adv" data-remodel-rp-adv="disadvantage" aria-pressed="false">Disadvantage</button>
            </div>
            <p class="remodel-rp-panel-hint remodel-rp-dice-adv-hint">Advantage / Disadvantage rolls a single d20 twice and keeps the higher / lower.</p>

            <div class="remodel-rp-dice-custom">
                <input type="text" class="remodel-rp-dice-input" data-remodel-rp-dice-input placeholder="e.g. 1d20+5, 2d6, 3d8-1" spellcheck="false" />
                <button type="button" class="remodel-rp-dice-go" data-remodel-rp-dice-go title="Roll">Roll</button>
            </div>
            <p class="remodel-rp-dice-error" data-remodel-rp-dice-error></p>

            <div class="remodel-rp-dice-recent" data-remodel-rp-dice-recent></div>
        </div>
    `;
    getRealSheld()?.appendChild(panel);
}

// --- Dice engine ---------------------------------------------------------
//
// Standard tabletop notation (NdM+K) via core's droll library (window.droll,
// exposed in lib.js). Advantage/Disadvantage isn't part of droll's grammar,
// so it's handled here: roll the formula twice and keep the higher/lower
// total. Every roll becomes a real, persisted narrator message in chat[]
// (via the same push→addOneMessage→saveChat path used everywhere else) so
// it shows as an in-stream card AND the model sees the outcome in context.

// Advantage mode is a transient UI preference for the dice panel — a
// plain module variable, not chat- or session-scoped state.
let roleplayDiceAdvantage = 'normal';

// Rolls `formula` once, returning droll's result object (or null if invalid).
function rollDiceFormula(formula) {
    const droll = window.droll;
    if (!droll || typeof droll.validate !== 'function') {
        return null;
    }
    let f = String(formula || '').trim();
    if (/^\d+$/.test(f)) {
        f = `1d${f}`;
    }
    // Accept "d20" shorthand (no leading count).
    if (/^d\d+([+-]\d+)?$/i.test(f)) {
        f = `1${f}`;
    }
    if (!droll.validate(f)) {
        return null;
    }
    const result = droll.roll(f);
    return result === false ? null : { formula: f, result };
}

// Performs a roll (honoring advantage/disadvantage for single-d20 formulas)
// and posts it to chat as an in-stream card.
function performRoleplayDiceRoll(rawFormula) {
    const errorEl = document.querySelector('[data-remodel-rp-dice-error]');
    if (errorEl) {
        errorEl.textContent = '';
    }

    const adv = roleplayDiceAdvantage;
    const first = rollDiceFormula(rawFormula);
    if (!first) {
        if (errorEl) {
            errorEl.textContent = `Not a valid dice formula: "${rawFormula}"`;
        }
        return;
    }

    // Advantage/disadvantage only applies to a single-die roll (the classic
    // d20 case). For multi-die formulas it's ignored — no meaningful "keep
    // higher of two 3d6 totals" convention to assume. droll's roll result
    // exposes the individual dice as `rolls[]` (there is no numDice field on
    // the result object), so single-die = exactly one entry.
    const singleDie = Array.isArray(first.result.rolls) && first.result.rolls.length === 1;
    let payload;
    if (adv !== 'normal' && singleDie) {
        const second = rollDiceFormula(first.formula);
        const a = first.result;
        const b = second.result;
        const keep = adv === 'advantage'
            ? (a.total >= b.total ? a : b)
            : (a.total <= b.total ? a : b);
        const dropped = keep === a ? b : a;
        payload = {
            formula: first.formula,
            mode: adv,
            keep,
            dropped,
        };
    } else {
        payload = { formula: first.formula, mode: 'normal', keep: first.result, dropped: null };
    }

    postRoleplayDiceMessage(payload);
    renderRoleplayDiceRecent(payload);
}

// Builds the human-readable roll text and pushes it as a persisted narrator
// message so it renders in the stream and enters the model's context.
async function postRoleplayDiceMessage(payload) {
    const context = getContext();
    const persona = context.name1 || 'You';
    const { formula, mode, keep, dropped } = payload;

    const detail = keep.rolls.length > 1
        ? `${keep.rolls.join(' + ')}${keep.modifier ? (keep.modifier > 0 ? ` + ${keep.modifier}` : ` - ${Math.abs(keep.modifier)}`) : ''} = ${keep.total}`
        : `${keep.rolls[0]}${keep.modifier ? (keep.modifier > 0 ? ` + ${keep.modifier}` : ` - ${Math.abs(keep.modifier)}`) : ''}${keep.modifier ? ` = ${keep.total}` : ''}`;

    let modeSuffix = '';
    if (mode !== 'normal' && dropped) {
        modeSuffix = ` — ${mode} (dropped ${dropped.total})`;
    }

    const text = `🎲 ${persona} rolls ${formula}${modeSuffix}: **${keep.total}** (${detail})`;

    const message = {
        name: 'Dice',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: text,
        extra: {
            remodel_dice: {
                formula,
                mode,
                total: keep.total,
                rolls: keep.rolls,
                modifier: keep.modifier,
                dropped: dropped ? dropped.total : null,
                by: persona,
            },
            type: 'narrator',
        },
    };

    context.chat.push(message);
    await context.addOneMessage(message, { scroll: false });
    await context.saveChat();
    // Re-render so the new card enters the bubble stream immediately.
    renderRoleplayScene();
}

// Small echo of the last few rolls inside the panel, so the user gets
// instant feedback without scrolling the stream.
function renderRoleplayDiceRecent(payload) {
    const box = document.querySelector('[data-remodel-rp-dice-recent]');
    if (!box) {
        return;
    }
    const { formula, mode, keep } = payload;
    const row = document.createElement('div');
    row.className = 'remodel-rp-dice-recent-row';
    const modeTag = mode !== 'normal' ? ` · ${mode}` : '';
    row.innerHTML = `<span class="remodel-rp-dice-recent-f">${escapeHtml(formula)}${escapeHtml(modeTag)}</span><span class="remodel-rp-dice-recent-t">${keep.total}</span>`;
    box.prepend(row);
    // Cap the visible history.
    while (box.children.length > 8) {
        box.removeChild(box.lastElementChild);
    }
}

function setRoleplayDiceAdvantage(mode) {
    roleplayDiceAdvantage = mode;
    document.querySelectorAll('[data-remodel-rp-adv]').forEach((btn) => {
        const on = btn.getAttribute('data-remodel-rp-adv') === mode;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('remodel-rp-adv-on', on);
    });
}

const ROLEPLAY_PANEL_IDS = {
    rules: 'remodel-rp-rules-panel',
    dice: 'remodel-rp-dice-panel',
    priortext: 'remodel-rp-priortext-panel',
};

function toggleRoleplayPanel(which) {
    const id = ROLEPLAY_PANEL_IDS[which];
    if (!id) {
        return;
    }
    const panel = document.getElementById(id);
    if (!panel) {
        return;
    }
    const willOpen = !panel.classList.contains('remodel-rp-panel-open');
    // Only one right-edge panel open at a time — close siblings first.
    getRealSheld()?.querySelectorAll('.remodel-rp-panel.remodel-rp-panel-open')
        .forEach((p) => p.classList.remove('remodel-rp-panel-open'));
    if (willOpen) {
        panel.classList.add('remodel-rp-panel-open');
        // The prior-text body is relocated in lazily; make sure it's present
        // and its dropdown is fresh when the panel opens.
        if (which === 'priortext') {
            ensureRoleplayPriorTextPanel();
        }
    }
}

function closeRoleplayPanel(which) {
    const id = ROLEPLAY_PANEL_IDS[which];
    if (id) {
        document.getElementById(id)?.classList.remove('remodel-rp-panel-open');
    }
}

// Rebuilds the left cast column from the current chat's participants —
// for a group, its members; for a solo character chat, that one character.
// Stage 1: renders the avatars + names read-only; add/remove/reorder and
// the live speaking indicator are wired in Stage 3.
function renderRoleplayCast(root) {
    const cast = root.querySelector('[data-remodel-rp-cast]');
    if (!cast) {
        return;
    }
    cast.textContent = '';

    const label = document.createElement('div');
    label.className = 'remodel-rp-cast-label';
    label.textContent = 'Cast';
    cast.appendChild(label);

    const context = getContext();
    const members = roleplaySceneMembers(context);
    const speakingName = roleplayCurrentSpeakerName(context);
    // Remove + reorder are only meaningful in a group with more than one
    // member (a scene needs at least one character; order matters for the
    // group's turn/activation ordering).
    const isMultiMemberGroup = Boolean(context.groupId) && members.length > 1;
    const canRemove = isMultiMemberGroup;
    const canReorder = isMultiMemberGroup;

    members.forEach((member) => {
        const avatar = roleplayCharacterAvatar({ characterId: member.characterId, name: member.name });
        const chip = document.createElement('div');
        chip.className = `remodel-rp-cast-member remodel-rp-color-${roleplaySpeakerColor(member.name)}`;
        chip.dataset.remodelCharacterId = String(member.characterId ?? '');
        if (avatar) {
            chip.dataset.remodelRpAvatar = avatar;
        }
        chip.title = canReorder ? `${member.name} — drag to reorder` : member.name;
        if (member.name === speakingName) {
            chip.classList.add('remodel-rp-speaking');
        }
        if (canReorder && avatar) {
            // Pointer-based drag (not native draggable — see
            // bindRoleplayCastDragEvents); the class marks it as a handle.
            chip.classList.add('remodel-rp-cast-draggable');
        }

        const av = buildRoleplayAvatar(member.name, { className: 'remodel-rp-cast-avatar' });
        chip.appendChild(av);

        if (canRemove && avatar) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remodel-rp-cast-remove';
            remove.title = `Remove ${member.name} from the scene`;
            remove.dataset.remodelRpCastRemove = avatar;
            remove.textContent = '×';
            chip.appendChild(remove);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'remodel-rp-cast-name';
        nameEl.textContent = member.name;
        chip.appendChild(nameEl);

        cast.appendChild(chip);
    });

    // Divider + add-character affordance. In a group this opens core's
    // group management; solo scenes surface it too so the path to "add a
    // second character" (which promotes the solo chat) is always visible.
    const divider = document.createElement('div');
    divider.className = 'remodel-rp-cast-divider';
    cast.appendChild(divider);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'remodel-rp-cast-add';
    add.title = 'Add character to scene';
    add.dataset.remodelRpAction = 'add-cast';
    add.textContent = '+';
    cast.appendChild(add);
}

// Pointer-based drag-to-reorder for cast members. Native HTML5 drag-and-drop
// proved unreliable here (the drop event frequently never fired against the
// avatar-image children), so this uses pointer events directly: press a chip,
// move past a small threshold to begin a drag, and the chip the pointer is
// over (hit-tested with elementFromPoint) shows an insertion hint; releasing
// commits via reorderRoleplayCast. Delegated at document level since the cast
// column is rebuilt on every render.
const roleplayDrag = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    movedAvatar: null,
    chip: null,
};
const ROLEPLAY_DRAG_THRESHOLD = 5; // px before a press becomes a drag

function bindRoleplayCastDragEvents() {
    document.addEventListener('pointerdown', (event) => {
        if (!isRealRoleplayWorkspaceActive() || event.button !== 0) {
            return;
        }
        const chip = event.target instanceof Element ? event.target.closest('.remodel-rp-cast-draggable') : null;
        // Don't start a drag from the remove "×" button.
        if (!chip || (event.target instanceof Element && event.target.closest('[data-remodel-rp-cast-remove]'))) {
            return;
        }
        roleplayDrag.pointerId = event.pointerId;
        roleplayDrag.startX = event.clientX;
        roleplayDrag.startY = event.clientY;
        roleplayDrag.movedAvatar = chip.dataset.remodelRpAvatar || null;
        roleplayDrag.chip = chip;
        roleplayDrag.active = false;
    });

    document.addEventListener('pointermove', (event) => {
        if (roleplayDrag.pointerId === null || event.pointerId !== roleplayDrag.pointerId) {
            return;
        }
        const dx = event.clientX - roleplayDrag.startX;
        const dy = event.clientY - roleplayDrag.startY;

        if (!roleplayDrag.active) {
            if (Math.hypot(dx, dy) < ROLEPLAY_DRAG_THRESHOLD) {
                return;
            }
            // Begin the drag.
            roleplayDrag.active = true;
            roleplayDrag.chip?.classList.add('remodel-rp-cast-dragging');
            roleplayDrag.chip?.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();

        // Hit-test the chip under the pointer and show the insertion hint.
        const cast = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-cast]');
        if (cast) {
            clearRoleplayDropHints(cast);
        }
        const overChip = roleplayChipUnderPointer(event.clientX, event.clientY);
        if (overChip && overChip.dataset.remodelRpAvatar !== roleplayDrag.movedAvatar) {
            overChip.classList.add('remodel-rp-cast-drop-before');
        }
    });

    document.addEventListener('pointerup', (event) => {
        if (roleplayDrag.pointerId === null || event.pointerId !== roleplayDrag.pointerId) {
            return;
        }
        const wasActive = roleplayDrag.active;
        const moved = roleplayDrag.movedAvatar;
        const overChip = wasActive ? roleplayChipUnderPointer(event.clientX, event.clientY) : null;
        const targetAvatar = overChip ? (overChip.dataset.remodelRpAvatar || null) : null;

        endRoleplayDrag();

        if (wasActive && moved) {
            reorderRoleplayCast(moved, targetAvatar);
        }
    });

    document.addEventListener('pointercancel', () => {
        if (roleplayDrag.pointerId !== null) {
            endRoleplayDrag();
        }
    });
}

// Returns the draggable cast chip under the given viewport point, if any.
function roleplayChipUnderPointer(x, y) {
    const el = document.elementFromPoint(x, y);
    return el instanceof Element ? el.closest('.remodel-rp-cast-draggable') : null;
}

function endRoleplayDrag() {
    roleplayDrag.chip?.classList.remove('remodel-rp-cast-dragging');
    const cast = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-cast]');
    if (cast) {
        clearRoleplayDropHints(cast);
    }
    roleplayDrag.active = false;
    roleplayDrag.pointerId = null;
    roleplayDrag.movedAvatar = null;
    roleplayDrag.chip = null;
}

function clearRoleplayDropHints(cast) {
    cast.querySelectorAll('.remodel-rp-cast-drop-before')
        .forEach((el) => el.classList.remove('remodel-rp-cast-drop-before'));
}

// The speaker to highlight in the cast: whoever produced the most recent
// non-user, non-system message. Returns null when the latest line is the
// user's or the scene is empty (nobody is "speaking" then).
function roleplayCurrentSpeakerName(context) {
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) {
            continue;
        }
        if (m.is_user) {
            return null;
        }
        if (m.is_system) {
            continue;
        }
        return m.name || null;
    }
    return null;
}

// Returns the cast list for the current chat as [{ name, characterId }].
// Group chats expose their members; a solo character chat is a cast of
// one. Deliberately reads live context, no caching.
function roleplaySceneMembers(context) {
    if (context.groupId) {
        const group = (context.groups || []).find((g) => String(g.id) === String(context.groupId));
        if (!group) {
            return [];
        }
        return (group.members || []).map((avatar) => {
            const idx = (context.characters || []).findIndex((c) => c.avatar === avatar);
            const character = idx >= 0 ? context.characters[idx] : null;
            return { name: character?.name || avatar, characterId: idx >= 0 ? idx : null };
        });
    }
    const characterId = context.characterId;
    if (characterId === undefined || characterId === null) {
        return [];
    }
    const character = (context.characters || [])[Number(characterId)];
    return character ? [{ name: character.name, characterId: Number(characterId) }] : [];
}

// Beat header clones in the overlay need their own live Hide/Delete buttons
// — the real header (with the real listeners' .closest('.mes') target)
// stays on the hidden real row and never receives a click from here. Both
// toggleStoryBeatCollapse and handleStoryBeatDelete already resolve mesId
// via the clicked button's ancestry (see their own resolveBeatMesId calls
// below) so a clone just needs to carry the same data-remodel-beat-hide/
// -delete attributes plus a data-remodel-mesid the resolver can fall back
// to when there's no real .mes ancestor.
// Legacy chat-backed manuscript overlay removed in Stage 8. Story scenes
// are migrated to StoryDocs on first open; source chats remain archived.

function getLinkedChatLabel(scene) {
    if (!scene.linkedChat) {
        return 'No chat bound';
    }

    if (scene.status === 'missing') {
        return 'Missing chat';
    }

    if (scene.linkedChat.type === 'group') {
        return `Group · ${scene.linkedChat.chatId}`;
    }

    return `Character · ${scene.linkedChat.fileName}`;
}

function queueRender() {
    if (getSessionState().renderQueued) {
        return;
    }

    setRenderQueued(true);
    requestAnimationFrame(() => {
        setRenderQueued(false);
        renderTimelinePanel();
    });
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
    return escapeHtml(value);
}

function hashHue(id) {
    let hash = 0;

    for (let i = 0; i < id.length; i++) {
        hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }

    return hash % 360;
}

function toRoman(value) {
    const number = Math.max(1, Math.floor(Number(value) || 1));
    const numerals = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
        [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
        [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
    ];

    let remaining = number;
    let result = '';

    for (const [amount, symbol] of numerals) {
        while (remaining >= amount) {
            result += symbol;
            remaining -= amount;
        }
    }

    return result;
}
