import { getContext } from '../../../st-context.js';
import {
    doNavbarIconClick,
    doNewChat,
    getPastCharacterChats,
    select_selected_character as selectCharacterForEditingOnly,
    setCharacterId,
} from '../../../../script.js';
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
    advanceWizardToPersonaStep,
    armGenerationWatchdog,
    armSceneSummarySaveDebounce,
    beginManuscriptEdit,
    beginOwnedGenerationRun,
    beginWizard,
    clearGenerationWatchdog,
    clearSceneSummarySaveDebounce,
    consumeWizardFlow,
    endManuscriptEdit,
    endOwnedGenerationRun,
    getGenerationState,
    getManuscriptEditState,
    getOriginalPanelHomes,
    getPanelsState,
    getSessionState,
    getWizardState,
    isGenerationRunOurs,
    isPastChatsBridgeActive,
    mergeManuscriptSnapshotEntries,
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
    observeTavernPanelState();
    bindManuscriptBoundaryProtection();
    bindManuscriptBeatGuard();
    bindStoryWorkspaceInvariantWatcher();
    bindStoryManuscriptEditCommit();
    bindStoryManuscriptEditCancel();
    bindStoryLockInterceptor();
    bindStoryComposerContinueOnEmptySend();
    bindRoleplayComposerEvents();
    bindStoryAutoContinueEvents();
    bindStoryGenerationStateEvents();
    ensureStoryComposerExtras();
    ensurePanelGroupContainer();
    ensureSceneSummaryPanel();
    bindSceneSummaryEvents();
    registerSceneMacros();
    registerCharacterFieldMacro();
    ensurePriorTextPanel();
    bindPriorTextPanelEvents();
    registerAllInsertedTextSlotMacros();
    ensurePromptPreviewPanel();
    ensureManuscriptToolbarPanel();
    bindManuscriptToolbarEvents();
    ensureCharacterEditorCancelButton();
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
            <div class="drawer-icon fa-solid fa-beer-mug-empty fa-fw closedIcon" title="Tavern"></div>
        </div>
        <div id="${PANEL_ID}" class="drawer-content closedDrawer remodel-timeline-drawer-content">
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
    });

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

            const hideButton = target.closest('[data-remodel-beat-hide]');
            if (hideButton) {
                event.preventDefault();
                toggleStoryBeatCollapse(hideButton);
                return;
            }

            const deleteButton = target.closest('[data-remodel-beat-delete]');
            if (deleteButton) {
                event.preventDefault();
                handleStoryBeatDelete(deleteButton);
                return;
            }

            const regenerateButton = target.closest('.remodel-beat-regenerate');
            if (regenerateButton) {
                event.preventDefault();
                handleStoryRegenerateClick(regenerateButton);
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

            const manuscriptToolbarToggle = target.closest('[data-remodel-manuscript-toolbar-toggle]');
            if (manuscriptToolbarToggle) {
                event.preventDefault();
                toggleManuscriptToolbarPanel();
                return;
            }

            const promptPreviewRefreshButton = target.closest('[data-remodel-promptpreview-refresh]');
            if (promptPreviewRefreshButton) {
                event.preventDefault();
                handlePromptPreviewRefreshClick();
                return;
            }

            const manuscriptFormatButton = target.closest('[data-remodel-manuscript-format]');
            if (manuscriptFormatButton) {
                event.preventDefault();
                handleManuscriptFormatClick(manuscriptFormatButton.dataset.remodelManuscriptFormat);
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
    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    // Checked here too, not just inside renderManuscriptOverlay() below —
    // decorateStoryUserMessage/refreshStoryRegenerateButtons would otherwise
    // still run their own real-DOM work against a stale/incorrect chat
    // before renderManuscriptOverlay ever got a chance to self-correct.
    if (!enforceStoryWorkspaceInvariant()) {
        return;
    }

    document.querySelectorAll('#chat > .mes[is_user="true"]').forEach(decorateStoryUserMessage);
    refreshStoryRegenerateButtons();
    renderManuscriptOverlay();
}

function decorateStoryUserMessage(mesEl) {
    if (mesEl.querySelector('.remodel-beat-header')) {
        return; // already decorated
    }

    const mesText = mesEl.querySelector('.mes_text');

    if (!mesText) {
        return;
    }

    const header = document.createElement('div');
    header.className = 'remodel-beat-header';
    header.innerHTML = `
        <span class="remodel-beat-label"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Scene Beat</span>
        <span class="remodel-beat-header-actions">
            <button type="button" class="remodel-beat-hide" data-remodel-beat-hide>Hide</button>
            <button type="button" class="remodel-beat-delete" data-remodel-beat-delete title="Delete this Scene Beat" aria-label="Delete this Scene Beat">Delete</button>
        </span>
    `;
    mesText.before(header);
}

async function handleStoryBeatDelete(deleteButton) {
    const mesId = resolveBeatMesId(deleteButton);

    if (!Number.isFinite(mesId)) {
        return;
    }

    // mergeAdjacentAiMessages/context.deleteMessage below mutate chat[]
    // indices directly (splice/shift). If a manuscript edit is still open,
    // its snapshot's mesIds — and any block still holding unsaved typing —
    // would silently point at the wrong messages afterward. Force-settle
    // (committing any real edits) before the index-mutating delete/merge
    // proceeds, same settle path Escape and focus-out already use.
    const { snapshot: openManuscriptSnapshot } = getManuscriptEditState();
    if (openManuscriptSnapshot) {
        await settleManuscriptEdits(openManuscriptSnapshot);
    }

    const context = getContext();
    const beforeMes = context.chat[mesId - 1];
    const afterMes = context.chat[mesId + 1];
    const canMerge = Boolean(beforeMes && !beforeMes.is_user && afterMes && !afterMes.is_user);

    const confirmText = canMerge
        ? 'Delete this Scene Beat? The AI passages before and after it will merge into one continuous message.'
        : 'Delete this Scene Beat? This only removes this one message — anything after it is untouched.';

    if (!confirm(confirmText)) {
        return;
    }

    // context.deleteMessage/updateMessageBlock (called inside
    // mergeAdjacentAiMessages, or directly below) do their own internal DOM
    // removal/re-render with no scroll-position compensation of their own,
    // and renderManuscriptOverlay's full rebuild below resets scroll to 0
    // by clearing the overlay's content — capture/restore around BOTH here.
    // The overlay is the real scroll container now (#chat itself is
    // display-collapsed, see style.css), not #chat.
    const overlayEl = getRealManuscriptOverlay();
    const scrollTopBeforeDelete = overlayEl?.scrollTop;

    if (canMerge) {
        await mergeAdjacentAiMessages(mesId - 1, mesId, mesId + 1);
    } else {
        await context.deleteMessage(mesId);
    }

    refreshStoryRegenerateButtons();
    renderManuscriptOverlay();

    if (overlayEl && scrollTopBeforeDelete !== undefined) {
        requestAnimationFrame(() => {
            overlayEl.scrollTop = scrollTopBeforeDelete;
        });
    }
}

// Splices the Scene Beat's surrounding AI passages back into one continuous
// message (deleting the beat "merges" the writing on either side of it, per
// the story workspace's continuous-manuscript design) — a pure local data
// operation, NOT a new AI generation: the trailing passage's text already
// exists and was already kept by the user, so generate('continue') (which
// asks the API for brand-new tokens) would be the wrong tool here.
//
// Deliberately discards the trailing message's swipes/swipe_info/
// gen_started/gen_finished/extra (alternate generations, timing, token
// counts) — the merged message keeps only the FIRST message's metadata.
// There's no meaningful way to represent "two messages' separate generation
// histories" as one message's fields, and the alternative (silently keeping
// stale metadata that no longer describes the merged text) is worse.
async function mergeAdjacentAiMessages(firstIndex, beatIndex, secondIndex) {
    const context = getContext();
    const firstMessage = context.chat[firstIndex];
    const secondMessage = context.chat[secondIndex];

    if (!firstMessage || !secondMessage) {
        return;
    }

    const separator = firstMessage.mes.endsWith('\n') || secondMessage.mes.startsWith('\n') ? '' : '\n\n';
    firstMessage.mes = firstMessage.mes + separator + secondMessage.mes;

    if (firstMessage.swipe_id !== undefined && Array.isArray(firstMessage.swipes)) {
        firstMessage.swipes[firstMessage.swipe_id] = firstMessage.mes;
    }

    // Delete from the back so earlier indices stay valid while deleting.
    await context.deleteMessage(secondIndex);
    await context.deleteMessage(beatIndex);

    context.updateMessageBlock(firstIndex, firstMessage);
    await context.saveChat();
}

// The general two-message case for the manuscript's live boundary-crossing
// merge (backspace at a block's start / forward-delete at a block's end) —
// modeled directly on mergeAdjacentAiMessages above (same delete-then-
// re-render-then-save shape) but for exactly two ADJACENT messages with no
// beat between them, and critically with NO inserted separator: unlike that
// function (rejoining two passages a whole beat message used to sit
// between), this merge is standing in for the single boundary the user's
// own backspace/delete keystroke just erased, so the two halves are
// concatenated exactly as typed with nothing added between them. Swipe
// alternates on the absorbed message (anything in its swipes[] besides the
// one currently folded into keepMessage.mes) are deliberately discarded —
// same tradeoff mergeAdjacentAiMessages already makes for beat-delete, now
// generalized to ordinary in-manuscript typing per the user's own explicit
// sign-off on that tradeoff.
async function mergeTwoAdjacentMessages(keepIndex, absorbIndex) {
    const context = getContext();
    const keepMessage = context.chat[keepIndex];
    const absorbMessage = context.chat[absorbIndex];

    if (!keepMessage || !absorbMessage) {
        return null;
    }

    const keepIsFirst = keepIndex < absorbIndex;
    keepMessage.mes = keepIsFirst
        ? keepMessage.mes + absorbMessage.mes
        : absorbMessage.mes + keepMessage.mes;

    if (keepMessage.swipe_id !== undefined && Array.isArray(keepMessage.swipes)) {
        keepMessage.swipes[keepMessage.swipe_id] = keepMessage.mes;
    }

    await context.deleteMessage(absorbIndex);

    // deleteMessage splices chat[] — if the absorbed message was BEFORE the
    // survivor, the survivor's own index just shifted down by 1.
    const survivingIndex = absorbIndex < keepIndex ? keepIndex - 1 : keepIndex;
    context.updateMessageBlock(survivingIndex, keepMessage);
    await context.saveChat();

    return { survivingIndex, mergedText: keepMessage.mes };
}

// A beat-related button may be clicked either on the real (hidden) .mes row
// or on its clone in the manuscript overlay (buildManuscriptBeatMarker) —
// the clone has no .mes ancestor to resolve, only a data-remodel-mesid on
// the marker itself. Real row takes priority when both are somehow
// resolvable (shouldn't normally happen — a click only ever lands on one).
function resolveBeatMesId(button) {
    const mesEl = button.closest('.mes');
    if (mesEl) {
        return Number(mesEl.getAttribute('mesid'));
    }
    const marker = button.closest('[data-remodel-mesid]');
    return marker ? Number(marker.dataset.remodelMesid) : NaN;
}

async function toggleStoryBeatCollapse(hideButton) {
    const mesId = resolveBeatMesId(hideButton);
    const mesEl = document.querySelector(`#chat > .mes[mesid="${mesId}"]`);

    if (!mesEl) {
        return;
    }

    // renderManuscriptOverlay() below does a full destructive rebuild of
    // every span from chat[] — if there's unsaved typing anywhere in the
    // overlay right now, that rebuild would silently discard it (confirmed
    // as a real reported bug: clicking Hide/Show reset whatever was inside
    // the beat). Force-settle first, same pattern handleStoryBeatDelete
    // already uses for the same reason.
    const { snapshot: openManuscriptSnapshot } = getManuscriptEditState();
    if (openManuscriptSnapshot) {
        await settleManuscriptEdits(openManuscriptSnapshot);
    }

    const collapsed = mesEl.classList.toggle('remodel-beat-collapsed');
    hideButton.textContent = collapsed ? 'Show' : 'Hide';
    renderManuscriptOverlay();
}

function refreshStoryRegenerateButtons() {
    const userMessages = document.querySelectorAll('#chat > .mes[is_user="true"]');

    userMessages.forEach((mesEl, index) => {
        const existingButton = mesEl.querySelector('.remodel-beat-regenerate');
        const isLast = index === userMessages.length - 1;

        if (isLast && !existingButton) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'remodel-beat-regenerate';
            button.textContent = 'Regenerate';
            mesEl.querySelector('.mes_text')?.after(button);
        } else if (!isLast && existingButton) {
            existingButton.remove();
        }
    });

}

// --- Panel group container ---------------------------------------------------
//
// Scene Summary / Prior Scene Text / Prompt Preview each collapse their OWN
// body content already, but as three separate always-visible bordered bars
// they still stack up and eat vertical space above the manuscript even
// fully collapsed. This wrapper hides all three behind one small toggle
// button — clicking it slides out the group of collapsed bars; clicking a
// bar then expands just that one, exactly as before.

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

function extractSceneProse(messages, { wordLimit = null } = {}) {
    const proseText = messages
        .filter(isNarrativeProseMessage)
        .map((mes) => mes.mes)
        .filter(Boolean)
        .join('\n\n');

    if (!wordLimit) {
        return proseText;
    }

    const words = proseText.split(/\s+/).filter(Boolean);
    return words.slice(-wordLimit).join(' ');
}

function sanitizeSlotName(rawName) {
    return String(rawName || '').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '').slice(0, 60);
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
        panel.innerHTML = `
            <div class="remodel-priortext-body">
                <label class="remodel-priortext-label">Source Scene</label>
                <select class="remodel-priortext-select" data-remodel-priortext-select></select>

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
        ensurePanelBodyContainer()?.append(panel);
    }

    refreshPriorTextPanel();
}

function refreshPriorTextPanel() {
    const panel = document.getElementById('remodel-priortext-panel');

    if (!panel) {
        return;
    }

    const scene = getActiveScene();
    panel.style.display = scene ? '' : 'none';

    if (!scene) {
        return;
    }

    const store = getTimelineStore();
    const timeline = store.timelines[scene.timelineId];
    const select = panel.querySelector('[data-remodel-priortext-select]');

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

                const usable = rowScene.mode === 'story' && Boolean(rowScene.linkedChat);
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
    const panel = document.getElementById('remodel-priortext-panel');
    const listEl = panel?.querySelector('[data-remodel-priortext-slotlist]');

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
    const panel = document.getElementById('remodel-priortext-panel');
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
        const messages = await fetchSceneMessages(sourceScene);

        if (!messages) {
            if (statusEl) {
                statusEl.textContent = 'Could not load that Scene\'s chat.';
            }
            return;
        }

        const useFullText = Boolean(fullTextCheckbox?.checked);
        const wordLimit = useFullText ? null : Math.max(1, Number(wordCountInput?.value) || 500);
        const proseText = extractSceneProse(messages, { wordLimit });

        preview.value = proseText;
        preview.dataset.remodelPriortextSourceSceneId = sourceScene.id;
        preview.dataset.remodelPriortextSourceSceneTitle = sourceScene.title;
        preview.dataset.remodelPriortextWordMode = useFullText ? 'full' : 'last';
        preview.dataset.remodelPriortextWordCount = wordLimit ?? '';

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
    const panel = document.getElementById('remodel-priortext-panel');
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

    setInsertedTextSlot(timeline.id, slotName, {
        text: preview.value,
        sourceSceneId: preview.dataset.remodelPriortextSourceSceneId || null,
        sourceSceneTitle: preview.dataset.remodelPriortextSourceSceneTitle || '',
        wordMode: preview.dataset.remodelPriortextWordMode || 'full',
        wordCount: preview.dataset.remodelPriortextWordCount ? Number(preview.dataset.remodelPriortextWordCount) : null,
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
    const proseText = extractSceneProse(messages, { wordLimit });

    setInsertedTextSlot(timeline.id, slotName, {
        text: proseText,
        sourceSceneId: sourceScene.id,
        sourceSceneTitle: sourceScene.title,
        wordMode: slot.wordMode,
        wordCount: slot.wordCount,
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
        const fullTextCheckbox = event.target instanceof Element ? event.target.closest('[data-remodel-priortext-fulltext]') : null;

        if (!fullTextCheckbox) {
            return;
        }

        const panel = fullTextCheckbox.closest('.remodel-priortext-panel');
        const wordCountInput = panel?.querySelector('[data-remodel-priortext-wordcount]');

        if (wordCountInput) {
            wordCountInput.disabled = fullTextCheckbox.checked;
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

function ensureManuscriptToolbarPanel() {
    if (!isRealStoryWorkspaceActive()) {
        return;
    }

    let panel = document.getElementById('remodel-manuscript-toolbar-panel');

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-manuscript-toolbar-panel';
        panel.className = 'remodel-manuscript-toolbar-panel';
        panel.innerHTML = `
            <div class="remodel-manuscript-toolbar-body">
                <div class="remodel-manuscript-toolbar-row">
                    <button type="button" class="remodel-manuscript-toolbar-btn" data-remodel-manuscript-format="bold" title="Bold (**text**)" aria-label="Bold">
                        <i class="fa-solid fa-bold" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="remodel-manuscript-toolbar-btn" data-remodel-manuscript-format="italic" title="Italic (_text_)" aria-label="Italic">
                        <i class="fa-solid fa-italic" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="remodel-manuscript-toolbar-btn" data-remodel-manuscript-format="underline" title="Underline (<u>text</u>)" aria-label="Underline">
                        <i class="fa-solid fa-underline" aria-hidden="true"></i>
                    </button>
                    <button type="button" class="remodel-manuscript-toolbar-btn" data-remodel-manuscript-format="strikethrough" title="Strikethrough (~~text~~)" aria-label="Strikethrough">
                        <i class="fa-solid fa-strikethrough" aria-hidden="true"></i>
                    </button>
                </div>
                <label class="remodel-manuscript-toolbar-label">
                    Font
                    <select class="remodel-manuscript-toolbar-font" data-remodel-manuscript-font-select>
                        ${MANUSCRIPT_FONT_OPTIONS.map((opt) => `<option value="${escapeAttribute(opt.value)}">${escapeHtml(opt.label)}</option>`).join('')}
                    </select>
                </label>
            </div>
        `;
        ensurePanelBodyContainer()?.append(panel);
    }

    restoreManuscriptFontPreference();
}

function toggleManuscriptToolbarPanel() {
    document.getElementById('remodel-manuscript-toolbar-panel')?.classList.toggle('remodel-manuscript-toolbar-open');
}

// Confirmed as a real, reported bug: the font choice applied live but was
// never actually saved anywhere, so it silently reset to the default on
// every reload/reopened scene. It's a pure display preference (not story
// content, doesn't belong in chat[]/chatMetadata), so localStorage is the
// right persistence layer — survives reloads, applies globally rather than
// per-chat, which matches how a font choice is normally understood ("my
// reading font"), not scoped to one specific scene.
const MANUSCRIPT_FONT_STORAGE_KEY = 'remodel-manuscript-font';

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
function wrapManuscriptSelectionWithMarkdown(before, after) {
    const overlay = getRealManuscriptOverlay();
    const selection = window.getSelection();
    if (!overlay || !selection || selection.rangeCount === 0) {
        return;
    }
    const range = selection.getRangeAt(0);
    const block = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
        ?.closest('[data-remodel-manuscript-block]');
    if (!block || !overlay.contains(block)) {
        return; // selection isn't inside a manuscript block at all
    }

    const selectedText = range.toString();
    const replacement = document.createTextNode(before + selectedText + after);
    range.deleteContents();
    range.insertNode(replacement);
    block.normalize();

    // Place the caret right after the inserted text (or between the
    // delimiters, for an empty/collapsed selection) rather than leaving it
    // wherever insertNode happened to put it.
    const caretOffset = selectedText
        ? before.length + selectedText.length + after.length
        : before.length;
    const textNode = block.firstChild;
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const caretRange = document.createRange();
        const offset = Math.min(caretOffset, textNode.textContent.length);
        caretRange.setStart(textNode, offset);
        caretRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(caretRange);
    }
    overlay.focus();
}

function handleManuscriptFormatClick(formatType) {
    const delimiters = {
        bold: ['**', '**'],
        italic: ['_', '_'],
        underline: ['<u>', '</u>'],
        strikethrough: ['~~', '~~'],
    };
    const pair = delimiters[formatType];
    if (!pair) {
        return;
    }
    wrapManuscriptSelectionWithMarkdown(pair[0], pair[1]);
}

function bindManuscriptToolbarEvents() {
    document.addEventListener('change', (event) => {
        const select = event.target instanceof Element ? event.target.closest('[data-remodel-manuscript-font-select]') : null;
        if (!select) {
            return;
        }
        handleManuscriptFontChange(select);
    });
}

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

function closeStoryComposer() {
    document.body.classList.remove('remodel-story-input-open');
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
        const { snapshot: openManuscriptSnapshot } = getManuscriptEditState();
        if (openManuscriptSnapshot) {
            settleManuscriptEdits(openManuscriptSnapshot);
        }

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
        || Boolean(TAVERN_TABS.find((tab) => tab.id === activeTavernTab)?.panelId);
    viewport.classList.toggle('is-header-collapsed', isHeaderCollapsed);

    // Header and tabs are persistent so their collapse/slide animates; only their
    // active state and the body content are re-rendered on each pass.
    const tabsNav = viewport.querySelector('.remodel-tavern-tabs');
    tabsNav.innerHTML = renderTavernTabs();

    const body = viewport.querySelector('.remodel-tavern-body');
    body.innerHTML = renderActiveWorkspace(store);

    if (activeTavernTab === 'timeline' || activeTavernTab === 'characters') {
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

function adoptLegacyPanel(tabId) {
    const tab = TAVERN_TABS.find((item) => item.id === tabId);
    const outlet = document.getElementById(LEGACY_OUTLET_ID);
    const panel = tab?.panelId ? document.getElementById(tab.panelId) : null;

    if (!outlet || !panel) {
        restoreAdoptedPanel();
        outlet?.append(renderMissingLegacyPanel(tab?.label || 'Panel'));
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

    if (!scene.linkedChat && scene.mode === 'story') {
        // Story Scenes get a guided cast-picking flow instead of silently
        // auto-binding — character and persona are locked for the Scene's
        // lifetime, so they need to be chosen deliberately up front.
        await beginStoryGuidedCreation(sceneId);
        return;
    }

    if (!scene.linkedChat) {
        // Never-opened Roleplay Scene: doesn't need the user to have manually
        // picked a character/group first — silently anchor to one (SillyTavern's
        // generation pipeline needs *some* character context under the hood),
        // then create+bind a fresh chat and go straight into the viewport.
        // "Open Scene" should always work in one click.
        await ensureActiveCharacterContext();
        await createNewChatForScene(sceneId);
        scene = getScene(sceneId);

        if (!scene?.linkedChat) {
            return;
        }

        await enterSceneViewport();
        return;
    }

    const context = getContext();
    const linkedChat = scene.linkedChat;

    if (linkedChat.type === 'group') {
        const group = context.groups.find((item) => String(item.id) === String(linkedChat.groupId));

        if (!group || !group.chats.includes(linkedChat.chatId)) {
            updateScene(sceneId, { status: 'missing' });
            return;
        }

        setActiveScene(sceneId);
        await context.openGroupChat(linkedChat.groupId, linkedChat.chatId);
        writeSceneMetadata(scene);
        updateScene(sceneId, { status: 'active' });
        await enterSceneViewport();
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
    await enterSceneViewport();
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

function bindCurrentChatToScene(sceneId) {
    const scene = getScene(sceneId);
    const linkedChat = getCurrentLinkedChat();

    if (!scene || !linkedChat) {
        alert('Open a character or group chat before binding this Scene.');
        return;
    }

    const updatedScene = updateScene(sceneId, {
        linkedChat,
        status: 'active',
    });

    setActiveScene(sceneId);
    writeSceneMetadata(updatedScene);
    syncStoryWorkspaceClass(updatedScene);
}

async function createNewChatForScene(sceneId) {
    const scene = getScene(sceneId);

    if (!scene) {
        return;
    }

    await doNewChat();
    bindCurrentChatToScene(sceneId);
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

    // A chat switch mid-manuscript-edit leaves DOM state (the body class,
    // the overlay's stale spans) belonging to the OLD chat —
    // resetAllChatScopedState() below only clears the manuscriptEdit STATE
    // domain, not these DOM side effects, since it's a pure state module
    // with no DOM access (same convention as every other domain there).
    // Without this, the body class would stay set indefinitely, permanently
    // disabling Regenerate/Continue/Add User Message (updateStoryActionBarState
    // gates on it) and the overlay would keep showing the old chat's text
    // until refreshStoryMessageDecorations happens to run again (which it
    // won't at all if the new chat isn't a story workspace). No native
    // .mes_edit/.mes_edit_cancel replay is needed here — the chat is
    // already gone from the DOM by the time CHAT_CHANGED fires, so there's
    // nothing left to click; this is pure leftover-content cleanup.
    const overlay = getRealManuscriptOverlay();
    if (overlay) {
        overlay.textContent = '';
    }
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
    ensurePanelGroupContainer();
    ensureSceneSummaryPanel();
    refreshSceneSummaryPanel();
    ensurePriorTextPanel();
    refreshPriorTextPanel();
    registerInsertedTextSlotMacros(getActiveTimelineForPriorText());
    ensurePromptPreviewPanel();
    refreshPromptPreviewPanel();
    ensureManuscriptToolbarPanel();

    // Confirmed as a real, reported bug: opening/reopening a Story Scene
    // landed the manuscript overlay scrolled to its TOP (the opening of the
    // story) rather than the bottom (the latest, most recently written
    // content) — the natural point to resume writing from. This runs
    // exactly once per chat load (this function is CHAT_CHANGED's handler,
    // not called per-message), so it never fights a mid-session scroll
    // position the way scrolling-to-bottom on every decoration refresh
    // would. requestAnimationFrame lets the overlay's freshly (re)built
    // content lay out first — scrollHeight read synchronously right after
    // renderManuscriptOverlay() can undercount before layout settles.
    if (scene?.mode === 'story') {
        requestAnimationFrame(() => {
            const overlayEl = getRealManuscriptOverlay();
            if (overlayEl) {
                overlayEl.scrollTop = overlayEl.scrollHeight;
            }
        });
    }

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
    document.body.classList.toggle('remodel-story-workspace-active', scene?.mode === 'story');
    document.body.classList.toggle('remodel-roleplay-workspace-active', scene?.mode === 'roleplay');
}

// Roleplay counterpart to isRealStoryWorkspaceActive() — same single-
// source-of-truth discipline: every call site asks this instead of reading
// the class directly, and it reads context.chatMetadata live every call
// via getActiveScene() with no caching.
function isRealRoleplayWorkspaceActive() {
    return getActiveScene()?.mode === 'roleplay';
}

// SINGLE SOURCE OF TRUTH for "are we in the story workspace" — every other
// place in this file that needs that answer calls this function instead of
// reading document.body.classList directly. The CSS class
// (remodel-story-workspace-active) still exists and still drives every
// visual rule exactly as before — CSS's only job is painting, it was never
// the problem. The problem was that ~10 separate call sites each read that
// class directly as their OWN copy of "the answer," so a class left stale
// by one missed event silently misled all of them at once, with nothing
// cross-checking any of it. Now there is exactly one place that computes
// the real answer, live, from SillyTavern's own data — getActiveScene()
// reads context.chatMetadata directly every call, no caching — and every
// other function asks THIS instead of keeping its own copy.
//
// Confirmed as a real, reported bug (traced live, not assumed): the class
// itself is not actually what goes stale in the worst case found so far —
// context.chatMetadata can still correctly point at a real story scene
// while context.chat's actual message array has been silently replaced
// with SillyTavern's own welcome-screen placeholder content (core's
// openWelcomeScreen()/sendAssistantMessage()/sendWelcomePrompt(), a
// separate, still-open core-side race — see isChatContentSane below).
// That means "is the label right" and "is the CONTENT the label describes
// actually real story content" are two different questions —
// isRealStoryWorkspaceActive() answers the first (scene binding is live
// and correct) and isChatContentSane() answers the second (what's
// actually in chat[] right now looks like real messages, not the welcome
// screen's known placeholder shape).
function isRealStoryWorkspaceActive() {
    return getActiveScene()?.mode === 'story';
}

// Detects SillyTavern's own welcome-screen placeholder content specifically
// (see welcome-screen.js: sendAssistantMessage/sendWelcomePrompt) rather
// than trying to validate "is this real story prose" in general, which
// would be guesswork. This is a narrow, exact fingerprint of ONE known-bad
// shape: exactly the two system/assistant placeholder messages
// openWelcomeScreen() pushes when it (incorrectly) fires against a chat
// that's actually still loaded. A real story chat's first two messages
// will essentially never match this exact pairing.
function isChatContentSane() {
    const chat = getContext().chat;

    if (!Array.isArray(chat) || chat.length !== 2) {
        return true; // not the specific 2-message welcome-screen shape — assume fine
    }

    const [first, second] = chat;
    const looksLikeWelcomeGreeting = first?.extra?.type === 'assistant_message';
    const looksLikeWelcomePrompt = second?.is_system === true && String(second?.mes ?? '').includes('flex-container');

    return !(looksLikeWelcomeGreeting && looksLikeWelcomePrompt);
}

// Forcibly tears down every visible trace of the story workspace — same
// cleanup syncActiveSceneFromChatMetadata already performs on a legitimate
// chat switch, run here unconditionally when either half of the truth
// check above says the workspace should NOT be showing right now. Callers
// bail out of whatever they were about to do when this returns false, so
// nothing downstream ever renders against the mismatch.
function enforceStoryWorkspaceInvariant() {
    // Deliberately reads the PAINTED class here, not isRealStoryWorkspaceActive()
    // — this function's whole job is comparing what's painted against what's
    // actually true, so checking the truth function against itself would be
    // circular and this branch would never fire.
    const isMarkedActive = document.body.classList.contains('remodel-story-workspace-active');

    if (!isMarkedActive) {
        return true; // nothing to correct
    }

    // Fixes the ROOT CAUSE, not just the symptom isChatContentSane() below
    // catches after the fact — traced live (not assumed): browsing a
    // character's sheet from the Tavern's Characters tab while a story
    // chat is loaded repoints this_chid (via
    // noteViewingCharacterForPastChats/setCharacterId,
    // session-state.js/timeline-spine.js) at the BROWSED character,
    // overwriting the story chat's real one. Confirmed directly: core's
    // getCurrentChatId() (script.js) derives its answer from this_chid,
    // not from context.chatId — so core's own openWelcomeScreen(), which
    // core registers via eventSource.makeFirst(CHAT_CHANGED, ...) (running
    // BEFORE this extension's own CHAT_CHANGED handler ever gets a chance
    // to clean anything up), reads the wrong this_chid and concludes no
    // chat is loaded, wiping the real one. resetPastChatsBridge()'s own
    // assumption — "core has already set this_chid correctly by the time
    // CHAT_CHANGED fires" — is true for a real chat switch, but false
    // here, since openWelcomeScreen is racing to read the SAME this_chid
    // this extension temporarily repointed. This restores this_chid to
    // the scene's real linked character proactively, every time this
    // invariant check runs, rather than only on an explicit "close the
    // character editor" click — the explicit-close path still exists
    // (restorePastChatsBridge) but proved too late for this specific race.
    const scene = getActiveScene();
    if (scene?.linkedChat?.characterId !== undefined) {
        const expectedCharacterId = Number(scene.linkedChat.characterId);
        const context = getContext();
        if (Number.isFinite(expectedCharacterId) && context.characterId !== expectedCharacterId) {
            setCharacterId(expectedCharacterId);
        }
    }

    if (isRealStoryWorkspaceActive() && isChatContentSane()) {
        return true; // invariant holds — label is correct AND content is real
    }

    const overlay = getRealManuscriptOverlay();
    if (overlay) {
        overlay.textContent = '';
    }
    document.body.classList.remove('remodel-manuscript-editing');
    document.body.classList.remove('remodel-story-workspace-active');
    updateStoryActionBarState();

    return false;
}

// The always-watching half of the hardening: every render-trigger call
// site (refreshStoryMessageDecorations, renderManuscriptOverlay, etc.)
// already calls enforceStoryWorkspaceInvariant() before doing anything
// visible, but that only helps for changes THIS extension's own code
// causes. core's welcome-screen race (see isChatContentSane's comment)
// rewrites #chat's content directly, with no guarantee any of our own
// render triggers fire afterward — nothing here was watching for changes
// core itself makes. A MutationObserver on the real #chat element's
// childList catches ANY content change regardless of what caused it,
// same "observe reality, don't predict/trust events" principle already
// proven out by bindManuscriptBeatGuard elsewhere in this file. Debounced
// via requestAnimationFrame — #chat's own normal rendering already
// produces many rapid mutations per message, and the invariant check only
// needs to run once after they settle, not once per individual node.
function bindStoryWorkspaceInvariantWatcher() {
    const chatEl = getRealChatElement();
    if (!chatEl) {
        return;
    }

    let scheduled = false;
    const observer = new MutationObserver(() => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            enforceStoryWorkspaceInvariant();
        });
    });

    observer.observe(chatEl, { childList: true, subtree: false });
}

// core's Background tab embeds a full clone of the entire page markup
// (including a second, hidden, disconnected-from-events #chat/#sheld pair)
// as a live preview inside #bg_tabs — meaning document.getElementById('chat')
// is genuinely ambiguous and can silently resolve to the dead clone instead
// of the real chat log. Scoped to the real #sheld directly under body,
// which the clone is nested many levels beneath instead of matching.
function getRealChatElement() {
    return document.body.querySelector(':scope > #sheld > #chat');
}

const MANUSCRIPT_OVERLAY_ID = 'remodel-manuscript-overlay';

// The real #chat rows (avatars, mes_buttons, swipe arrows, edit buttons,
// timers) are not safe to make contenteditable wholesale — that would pull
// every one of those controls into the editable surface, each needing its
// own contenteditable="false" exclusion, a much wider and more fragile
// blast radius than the manuscript actually needs. Instead #chat stays the
// real data source, hidden, and this overlay is a SEPARATE contenteditable
// element holding only text spans (one per visible message) and non-
// editable Scene Beat header clones — the only two things that actually
// need to be in the manuscript's reading/editing flow.
// document.getElementById(MANUSCRIPT_OVERLAY_ID) is exactly as ambiguous as
// document.getElementById('chat') already proved to be (see
// getRealChatElement's own comment) — core's Background tab embeds a full
// hidden clone of the ENTIRE page, and once the overlay gets created, that
// clone acquires its own copy of #remodel-manuscript-overlay too. Plain
// getElementById can silently resolve to that dead clone instead of the
// real, live one, producing exactly the kind of stray/duplicated/unrelated
// content bleeding into the manuscript that this scoping fixes. Scoped the
// same way, through the real #sheld directly under body.
function getRealManuscriptOverlay() {
    return document.body.querySelector(`:scope > #sheld > #${MANUSCRIPT_OVERLAY_ID}`);
}

function ensureManuscriptOverlay() {
    let overlay = getRealManuscriptOverlay();
    if (overlay) {
        return overlay;
    }
    const chatEl = getRealChatElement();
    if (!chatEl) {
        return null;
    }
    overlay = document.createElement('div');
    overlay.id = MANUSCRIPT_OVERLAY_ID;
    overlay.setAttribute('contenteditable', 'true');
    chatEl.after(overlay);
    return overlay;
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

    zone.innerHTML = `
        <div class="remodel-rp-turn-bar">
            <div class="remodel-rp-speaker-select" data-remodel-rp-speaker-select title="Who narrates / speaks next">
                <span class="remodel-rp-chip-av">${escapeHtml(roleplayInitials(personaName))}</span>
                <span class="remodel-rp-speaker-lbl">${escapeHtml(personaName)}</span>
                <span class="remodel-rp-caret">▾</span>
            </div>
            <div class="remodel-rp-seg"><span class="remodel-rp-seg-k">Next speaker</span><span class="remodel-rp-seg-v">AI decides</span></div>
        </div>

        <div class="remodel-rp-action-row">
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="regenerate"><span class="remodel-rp-g">↺</span> Regenerate</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="next"><span class="remodel-rp-g">▷</span> Next</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="trigger"><span class="remodel-rp-g">✦</span> Trigger…</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="impersonate"><span class="remodel-rp-g">✎</span> Write for me</button>
            <button type="button" class="remodel-rp-act" data-remodel-rp-action="preview"><span class="remodel-rp-g">◉</span> Preview</button>
            <span class="remodel-rp-spacer"></span>
            ${memberToggles}
        </div>

        <div class="remodel-rp-composer">
            <button type="button" class="remodel-rp-as-chip" data-remodel-rp-persona title="Speak as… (persona / narrator)">
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
    input.value = '';
    autosizeRoleplayInput(input);
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    sendBut.click();
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
            // core's regenerate = swipe/regenerate the last message.
            document.getElementById('option_regenerate')?.click();
            break;
        }
        case 'next': {
            // Advance the group's turn / continue — core's continue option.
            document.getElementById('option_continue')?.click();
            break;
        }
        case 'trigger': {
            // Opens native group member selection is non-trivial; for now
            // trigger the group's "next speaker" via the native trigger flow
            // if present, else no-op. Wired fully in the cast-polish stage.
            document.getElementById('option_continue')?.click();
            break;
        }
        case 'impersonate': {
            document.getElementById('option_impersonate')?.click();
            break;
        }
        case 'preview': {
            // Reuse the existing Prompt Preview panel toggle.
            togglePromptPreviewPanel();
            break;
        }
        default:
            break;
    }
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
        const root = getRealRoleplayRoot();
        if (!root || !root.contains(target)) {
            return;
        }

        if (target.closest('[data-remodel-rp-send]')) {
            event.preventDefault();
            handleRoleplaySend(root);
            return;
        }

        const actionBtn = target.closest('[data-remodel-rp-action]');
        if (actionBtn) {
            event.preventDefault();
            handleRoleplayAction(actionBtn.getAttribute('data-remodel-rp-action'));
            return;
        }
    });

    // Enter-to-send + autosize in the roleplay input.
    document.addEventListener('keydown', (event) => {
        if (!isRealRoleplayWorkspaceActive()) {
            return;
        }
        const input = event.target instanceof Element ? event.target.closest('[data-remodel-rp-input]') : null;
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
        const input = event.target instanceof Element ? event.target.closest('[data-remodel-rp-input]') : null;
        if (input instanceof HTMLTextAreaElement) {
            autosizeRoleplayInput(input);
        }
    });
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
// "Nico Robin" -> "NR") — the mockup's letter-tile stand-in, used only
// when a message has no real avatar image (extra.force_avatar / the
// character card thumbnail are wired in a later stage).
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

// Builds one chat-bubble row for a single chat[] message. Kind is one of
// 'character' | 'user' | 'narrator', deciding alignment/styling. The row
// carries data-remodel-mesid so per-bubble controls (edit/delete/swipe)
// can resolve back to the real message the same way the manuscript
// overlay's spans do.
function buildRoleplayMessage(mesId, message) {
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

    // Avatar (letter-tile stand-in for now).
    const avatar = document.createElement('div');
    avatar.className = 'remodel-rp-avatar';
    avatar.textContent = kind === 'user' ? roleplayInitials(name) : roleplayInitials(name);
    if (kind !== 'narrator') {
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
    // Raw message text for now — markdown/italic-action rendering is a
    // later polish pass; textContent keeps it safe and structural.
    body.textContent = message.mes ?? '';
    bubble.appendChild(body);

    row.appendChild(bubble);
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
        mesEls.forEach((mesEl) => {
            const mesId = Number(mesEl.getAttribute('mesid'));
            const message = context.chat[mesId];
            if (!Number.isFinite(mesId) || !message) {
                return;
            }
            stream.appendChild(buildRoleplayMessage(mesId, message));
        });
        // Land at the latest line, same as the manuscript's scroll-to-bottom.
        requestAnimationFrame(() => {
            stream.scrollTop = stream.scrollHeight;
        });
    }

    renderRoleplayCast(root);
    renderRoleplayComposer(root);
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
    members.forEach((member) => {
        const chip = document.createElement('div');
        chip.className = `remodel-rp-cast-member remodel-rp-color-${roleplaySpeakerColor(member.name)}`;
        chip.dataset.remodelCharacterId = String(member.characterId ?? '');
        chip.title = member.name;
        chip.textContent = roleplayInitials(member.name);
        cast.appendChild(chip);
    });
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
function buildManuscriptBeatMarker(mesId, collapsed) {
    const marker = document.createElement('div');
    marker.className = 'remodel-beat-header remodel-manuscript-beat-marker';
    marker.dataset.remodelMesid = String(mesId);
    marker.setAttribute('contenteditable', 'false');
    // contenteditable="false" on the marker alone isn't reliably enough:
    // confirmed as a real bug — the label text and Hide/Delete buttons were
    // still directly typeable (a caret could be placed inside "Scene Beat"
    // itself, and Enter there ran boundary-protection's insertPlainText,
    // producing a brand-new editable text node with no relation to any
    // chat[] message). Native contenteditable's own inheritance doesn't
    // reliably block a nested, natively-focusable <button> the same way it
    // blocks plain text, so every interactive/label element inside this
    // marker is marked contenteditable="false" explicitly too, not just the
    // wrapper — belt and suspenders, not relying on inheritance alone.
    marker.innerHTML = `
        <span class="remodel-beat-label" contenteditable="false"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Scene Beat</span>
        <span class="remodel-beat-header-actions" contenteditable="false">
            <button type="button" class="remodel-beat-hide" contenteditable="false" data-remodel-beat-hide>${collapsed ? 'Show' : 'Hide'}</button>
            <button type="button" class="remodel-beat-delete" contenteditable="false" data-remodel-beat-delete title="Delete this Scene Beat" aria-label="Delete this Scene Beat">Delete</button>
        </span>
    `;
    return marker;
}

// Rebuilds the overlay's full contents from whatever's currently in the
// real (hidden) #chat — called at every point refreshStoryMessageDecorations
// already runs (chat load, a message rendered, a beat deleted/collapsed),
// so the overlay never drifts from the real DOM it mirrors. A full rebuild
// rather than incremental patching is deliberate: it's the same "just
// re-derive from source" simplicity the rest of this file already leans on
// (e.g. refreshStoryRegenerateButtons re-scans every user message rather
// than tracking deltas), and per-chat message counts here are small enough
// that this is cheap, not a real cost worth optimizing away preemptively.
//
// Live-editing note: rebuilding wipes and recreates every span, which would
// normally nuke the user's caret position mid-keystroke. This is only ever
// called from render-trigger points (new message, beat collapse/delete,
// chat load) — never on a plain keystroke, since ordinary typing lands
// directly in the overlay's own contenteditable spans and needs no rebuild
// at all. A caret invalidation during those specific trigger points (e.g.
// deleting a beat while typing elsewhere) is an accepted, narrow edge case,
// not a general typing-loses-your-place problem.
function renderManuscriptOverlay() {
    // Must run BEFORE ensureManuscriptOverlay() below — ensureManuscriptOverlay
    // itself only checks getRealChatElement() exists, not whether the
    // CURRENT chat is actually a story-mode scene, so it would happily
    // (re)create/keep the overlay even on a stale/incorrect
    // remodel-story-workspace-active. This is the actual fix for the
    // confirmed close-then-reopen-a-story-chat bug where the overlay ended
    // up rendering the welcome screen's raw HTML as literal manuscript text.
    if (!enforceStoryWorkspaceInvariant()) {
        return;
    }

    const overlay = ensureManuscriptOverlay();
    if (!overlay) {
        return;
    }

    const chatEl = getRealChatElement();
    const context = getContext();
    overlay.textContent = '';

    const mesEls = Array.from(chatEl?.querySelectorAll(':scope > .mes') ?? []);
    const snapshot = [];

    // Regenerate is only ever offered on the LATEST Scene Beat (same rule
    // refreshStoryRegenerateButtons already enforces on the real hidden
    // row) — computed once up front rather than per-message, same reason
    // refreshStoryRegenerateButtons itself needs the full user-message list
    // before it can know which one is last.
    const userMesEls = mesEls.filter((mesEl) => mesEl.getAttribute('is_user') === 'true');
    const lastUserMesId = userMesEls.length
        ? Number(userMesEls[userMesEls.length - 1].getAttribute('mesid'))
        : NaN;

    mesEls.forEach((mesEl) => {
        const mesId = Number(mesEl.getAttribute('mesid'));
        const message = context.chat[mesId];
        if (!Number.isFinite(mesId) || !message) {
            return;
        }

        if (message.is_user) {
            const collapsed = mesEl.classList.contains('remodel-beat-collapsed');
            overlay.appendChild(buildManuscriptBeatMarker(mesId, collapsed));
            if (collapsed) {
                return; // collapsed beats contribute a marker only, no editable text span
            }
        }

        const span = document.createElement('span');
        span.dataset.remodelMesid = String(mesId);
        span.dataset.remodelManuscriptBlock = '';
        if (message.is_user) {
            // Identifies the beat's OWN span directly rather than via
            // adjacent-sibling position — a marker+span sibling selector
            // silently breaks the moment the beat is collapsed, since a
            // collapsed beat contributes no span at all and the "next"
            // sibling becomes whatever AI message follows it instead
            // (confirmed as a real bug: the boxed styling wrapped the
            // FOLLOWING message's text once its own beat was hidden).
            span.classList.add('remodel-manuscript-beat-text');
        }
        span.textContent = message.mes ?? '';
        overlay.appendChild(span);

        if (message.is_user && mesId === lastUserMesId) {
            // Same class/creation shape as refreshStoryRegenerateButtons'
            // real-row button — .remodel-story-disabled state is applied
            // separately by updateStoryActionBarState, which already
            // queries by class rather than by DOM location.
            const regenerateButton = document.createElement('button');
            regenerateButton.type = 'button';
            regenerateButton.className = 'remodel-beat-regenerate';
            // Never had this at all — confirmed as a real bug: without it,
            // the button's own label text was directly editable/typeable
            // like any other manuscript text, since a <button> with no
            // contenteditable attribute of its own inherits "true" from the
            // overlay same as a plain text node would.
            regenerateButton.setAttribute('contenteditable', 'false');
            // resolveBeatMesId walks .closest('[data-remodel-mesid]') — this
            // button is appended as a standalone sibling in the overlay, not
            // nested inside the beat marker, so it needs its OWN
            // data-remodel-mesid to be resolvable at all. Confirmed as a
            // real bug: without this, clicking Regenerate fired the click
            // handler but resolveBeatMesId found no ancestor with either
            // .mes or [data-remodel-mesid], returned NaN, and
            // handleStoryRegenerateClick silently no-opped.
            regenerateButton.dataset.remodelMesid = String(mesId);
            regenerateButton.textContent = 'Regenerate';
            overlay.appendChild(regenerateButton);
        }

        snapshot.push({ mesId, originalRaw: message.mes ?? '' });
    });

    // Confirmed as a real, reported bug: a freshly-created Story Scene with
    // zero messages left the overlay as a bare, empty
    // contenteditable="true" div with no children at all — nothing in the
    // loop above ran, so there was no [data-remodel-manuscript-block] span
    // for the Manuscript Toolbar's format buttons to act on (they're
    // scoped to that selector), and the overlay itself was directly,
    // unprotectedly typeable with no Scene Beat structure around it, no
    // guard, nothing. A real user's first keystroke landed as raw text
    // with none of the manuscript's normal invariants in place. This is a
    // genuine dead-end state, not a rare edge case — it's what EVERY new
    // Story Scene looks like before its first beat exists. A single
    // non-editable placeholder (matching the Scene Beat markers' own
    // contenteditable="false" pattern above) makes the empty state
    // explicit and safe instead of silently falling through to "the whole
    // overlay is a blank text box."
    if (mesEls.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'remodel-manuscript-empty-state';
        emptyState.setAttribute('contenteditable', 'false');
        emptyState.textContent = 'Write your first Scene Beat below to begin the story.';
        overlay.appendChild(emptyState);
    }

    // The manuscript is continuously live now (requirement: no explicit
    // enter/exit) — beginManuscriptEdit's snapshot is rebuilt fresh every
    // render rather than captured once on click. Any snapshot from a PRIOR
    // render is discarded here; settleManuscriptEdits is expected to have
    // already run (via focusout/Escape/generation-start) before anything
    // could trigger a re-render while genuinely mid-edit — same ordering
    // guarantee the old click-triggered flow relied on, just re-triggered
    // continuously instead of once.
    beginManuscriptEdit(snapshot);
    document.body.classList.add('remodel-manuscript-editing');
    updateStoryActionBarState();

    // Every legitimate rebuild (a beat added/deleted/collapsed, a new AI
    // message rendered) redefines what "correct" looks like for
    // bindManuscriptBeatGuard's MutationObserver — refresh its snapshot
    // here rather than only at bind-time, or the guard would keep trying to
    // restore beats to a stale, pre-rebuild shape.
    captureBeatSnapshots(overlay);
}

// Scene Beat protection used to be predict-and-block: inspect the
// beforeinput/keydown event BEFORE it does anything, guess whether it would
// touch a beat, preventDefault() if so. That kept failing in ways synthetic
// tests never caught — confirmed via research (Mozilla bug 439808/685445/
// 685452 and others) that Backspace/Delete behavior right at a
// contenteditable="false" boundary is a long-standing, genuinely
// browser-inconsistent area of the spec, not something interceptable with
// full reliability no matter how many input-type branches are added.
// ProseMirror/Lexical solve this exact class of problem the other way
// around: let the browser mutate the DOM however it wants, then read the
// result back and reject/revert whatever violates an invariant. This is
// that approach, scoped to just the one thing that actually needs it —
// Scene Beats — while the already-reliable, already-live-verified
// beforeinput prediction in bindManuscriptBoundaryProtection keeps handling
// ordinary AI-to-AI merging exactly as before (that logic runs through
// this extension's OWN, fully controlled merge code path, not through
// unpredictable native contenteditable behavior next to a
// contenteditable="false" sibling, which is the specific part that isn't
// reliably predictable).
const beatSnapshots = new Map(); // mesId -> { markerHTML, spanText, regenerateHTML }

function captureBeatSnapshots(overlay) {
    beatSnapshots.clear();
    overlay.querySelectorAll('.remodel-manuscript-beat-marker').forEach((marker) => {
        const mesId = marker.dataset.remodelMesid;
        if (mesId === undefined) {
            return;
        }
        const span = overlay.querySelector(`.remodel-manuscript-beat-text[data-remodel-mesid="${mesId}"]`);
        // The Regenerate button (only present on the LAST user message) was
        // never tracked here at all — confirmed as a real bug: a native
        // delete that removed the beat's marker+span in one browser
        // mutation left this button behind as an orphan pointing at a
        // mesId whose marker/span had just been reverted underneath it,
        // since nothing in this guard ever looked at it.
        const regenerateButton = overlay.querySelector(`.remodel-beat-regenerate[data-remodel-mesid="${mesId}"]`);
        beatSnapshots.set(mesId, {
            markerHTML: marker.outerHTML,
            spanText: span ? span.textContent : null,
            regenerateHTML: regenerateButton ? regenerateButton.outerHTML : null,
        });
    });
}

function flashBeatGuard(el) {
    if (!el) {
        return;
    }
    el.classList.remove('remodel-beat-guard-flash');
    // Force a reflow so re-adding the class restarts the CSS transition even
    // if a previous flash on this same element hasn't finished fading yet.
    void el.offsetWidth;
    el.classList.add('remodel-beat-guard-flash');
    setTimeout(() => el.classList.remove('remodel-beat-guard-flash'), 500);
}

// Watches for any DOM mutation that violates a Scene Beat's invariants
// (its marker removed/altered, its text span removed, merged into a
// neighbor, or split into more than one node) and reverts it immediately —
// same microtask MutationObserver callbacks always run in, so there is no
// window for a second fast keystroke to land on already-corrupted DOM.
// Ordinary edits WITHIN a beat's own text (typing, selecting, deleting
// mid-span) never trip this: the span still exists, still has exactly one
// child text node, still carries its class — only boundary-violating
// mutations (the span disappearing, merging, or splitting) get caught.
function bindManuscriptBeatGuard() {
    const overlay = ensureManuscriptOverlay();
    if (!overlay) {
        return;
    }

    captureBeatSnapshots(overlay);

    const observerConfig = { childList: true, subtree: true, characterData: true };
    const observer = new MutationObserver(() => {
        if (!document.body.classList.contains('remodel-manuscript-editing')) {
            return;
        }

        // Every restorative write below (replaceWith, textContent reset,
        // rebuilt-span insertion) is itself a mutation on the exact subtree
        // this observer watches. Left connected, each write re-queues a new
        // callback that finds its OWN just-applied fix already in place —
        // that should be a no-op next pass, but was confirmed live to hang
        // the renderer instead (a minimal isolated repro — one span, one
        // text-node split, one textContent reset back to snapshot — never
        // returned even on a freshly launched, otherwise-responsive Chrome
        // instance). Disconnecting before writing and reconnecting after
        // guarantees self-caused mutations are never observed at all, which
        // is the standard pattern for a MutationObserver that both watches
        // and repairs the same subtree.
        observer.disconnect();

        for (const [mesId, snap] of beatSnapshots) {
            const marker = overlay.querySelector(`.remodel-manuscript-beat-marker[data-remodel-mesid="${mesId}"]`);
            const span = overlay.querySelector(`.remodel-manuscript-beat-text[data-remodel-mesid="${mesId}"]`);

            const markerBroken = !marker || marker.outerHTML !== snap.markerHTML;
            // STRUCTURAL violations only — the span disappearing, splitting
            // into multiple nodes, or its single child stopping being a
            // plain text node. Comparing against the snapshot's TEXT was a
            // real bug caught in review before ever needing a live test:
            // the snapshot only refreshes on a full renderManuscriptOverlay()
            // rebuild, never on ordinary keystrokes, so it goes stale the
            // instant the user types their first character inside a beat —
            // every following keystroke would then look "broken" against
            // that stale baseline and get silently reverted, making beats
            // completely uneditable. A beat's own text is free to change;
            // only the span's STRUCTURE (still exists, still exactly one
            // text-node child, still not merged into a sibling) is guarded.
            // Zero children is also valid — confirmed as a real, reported
            // bug: backspacing a beat down to its very last character
            // empties the text node's parent to 0 childNodes (the browser
            // drops the now-empty text node entirely rather than leaving
            // it as an empty string), which childNodes.length !== 1 read as
            // "broken" and reverted back to the last 1-character snapshot —
            // so the final backspace of a full clear-out always silently
            // resurrected one stray leftover character. An empty, fully
            // cleared beat is legitimate content, not corruption; only 2+
            // children (split/merged text) or a single non-text child
            // counts as broken.
            const spanBroken = snap.spanText !== null
                && (!span || span.childNodes.length > 1
                    || (span.childNodes.length === 1 && span.firstChild.nodeType !== Node.TEXT_NODE));

            if (!markerBroken && !spanBroken) {
                // No structural violation — update the live snapshot so a
                // FUTURE structural check has an up-to-date baseline to
                // restore to if something does go wrong later in the
                // session (e.g. the marker itself gets tampered with after
                // the beat's text has already been legitimately edited).
                if (span) {
                    snap.spanText = span.textContent;
                }
                continue;
            }

            if (markerBroken && marker) {
                // The marker itself was mutated (its Hide/Delete buttons live
                // inside it) rather than removed outright — restore its exact
                // original markup in place.
                const restored = document.createRange().createContextualFragment(snap.markerHTML);
                marker.replaceWith(restored);
            } else if (markerBroken && !marker && span) {
                // Marker was removed entirely (e.g. backspace at the very
                // start of the beat's text tried to delete backward into/
                // through it) — reinsert it right before the surviving span.
                const restored = document.createRange().createContextualFragment(snap.markerHTML);
                span.before(restored);
            }

            if (spanBroken && snap.spanText !== null) {
                const currentMarker = overlay.querySelector(`.remodel-manuscript-beat-marker[data-remodel-mesid="${mesId}"]`);
                if (span) {
                    // Span still exists but its content was corrupted
                    // (merged with neighboring text, split into multiple
                    // nodes, etc.) — reset it to exactly one text node.
                    span.textContent = snap.spanText;
                } else if (currentMarker) {
                    // Span was removed outright (e.g. forward-delete at the
                    // beat's end tried to delete forward through it) —
                    // rebuild and reinsert it right after the marker.
                    const rebuilt = document.createElement('span');
                    rebuilt.dataset.remodelMesid = mesId;
                    rebuilt.dataset.remodelManuscriptBlock = '';
                    rebuilt.classList.add('remodel-manuscript-beat-text');
                    rebuilt.textContent = snap.spanText;
                    currentMarker.after(rebuilt);
                }
            }

            // Confirmed as a real, reported bug: a native delete that
            // removed the beat's marker+span in one mutation left the
            // Regenerate button (a standalone sibling, only present on the
            // LAST user message) behind, pointing at a mesId whose
            // marker/span had just been restored above it — this button was
            // never part of the guarded set at all until now. Only ever
            // acts if the button existed in the original snapshot (beats
            // that aren't the last user message have no Regenerate button
            // and none should reappear here).
            if (snap.regenerateHTML !== null) {
                const regenerateButton = overlay.querySelector(`.remodel-beat-regenerate[data-remodel-mesid="${mesId}"]`);
                const regenerateBroken = !regenerateButton || regenerateButton.outerHTML !== snap.regenerateHTML;
                if (regenerateBroken) {
                    if (regenerateButton) {
                        regenerateButton.replaceWith(document.createRange().createContextualFragment(snap.regenerateHTML));
                    } else {
                        const anchor = overlay.querySelector(`.remodel-manuscript-beat-text[data-remodel-mesid="${mesId}"]`)
                            ?? overlay.querySelector(`.remodel-manuscript-beat-marker[data-remodel-mesid="${mesId}"]`);
                        if (anchor) {
                            anchor.after(document.createRange().createContextualFragment(snap.regenerateHTML));
                        }
                    }
                }
            }

            const flashTarget = overlay.querySelector(`.remodel-manuscript-beat-marker[data-remodel-mesid="${mesId}"]`);
            flashBeatGuard(flashTarget);
        }

        observer.observe(overlay, observerConfig);
    });

    observer.observe(overlay, observerConfig);
}

// Detects and blocks/handles typing that would cross a message-span
// boundary — a mid-message Enter always stays one message (never splits),
// per this feature's own design; a backspace-at-start/forward-delete-at-end
// AT this stage (Stage 1 of the overlay rewrite) is still unconditionally
// blocked, matching the original per-block design. Merging across a
// boundary instead of blocking it is Stage 2+ work, not yet wired here.
function bindManuscriptBoundaryProtection() {
    // Bound to the overlay, not the real (hidden) #chat — typing/backspace/
    // paste all happen in the overlay's own contenteditable spans now, per
    // ensureManuscriptOverlay's separate-contenteditable-surface design.
    const chat = ensureManuscriptOverlay();

    if (!chat) {
        return;
    }

    const isActive = () => document.body.classList.contains('remodel-manuscript-editing');
    const getBlock = (node) => {
        const el = node instanceof Element ? node : node?.parentElement;
        return el?.closest('[data-remodel-manuscript-block]') ?? null;
    };
    // Scene Beats are always fully off-limits to every typing behavior this
    // whole closure implements — never merged into, never merged out of,
    // never split by Enter, never pasted into across a boundary. A single,
    // named, checked-FIRST gate, not a condition buried inside one sub-path
    // (merge) that other handlers (Enter, paste) forgot to also check —
    // that gap is exactly why Enter inside a beat still created a stray new
    // block and backspace at a beat's start still deleted it outright, both
    // confirmed as real, reported bugs despite the merge path itself
    // already excluding beats correctly.
    const isBeatBlock = (block) => Boolean(block?.classList.contains('remodel-manuscript-beat-text'));
    const isCrossBlockSelection = () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }
        const anchorBlock = getBlock(selection.anchorNode);
        const focusBlock = getBlock(selection.focusNode);
        return Boolean(anchorBlock && focusBlock && anchorBlock !== focusBlock);
    };
    // event.target for a real, physically-dispatched key event is whatever
    // element currently has DOM FOCUS — which is the overlay itself (the
    // one and only contenteditable="true" root), not the specific message
    // span the caret happens to be inside. getBlock(event.target) therefore
    // resolved to null for every real keypress once focus lived on the
    // overlay rather than a span, silently skipping every check that
    // followed — confirmed as the actual root cause of Enter still
    // splitting a Scene Beat into two spans live (event.target-based
    // resolution never even reached the isBeatBlock gate). The Selection's
    // anchor node is always the caret's true container regardless of which
    // ancestor holds focus, and is what every other check in this closure
    // (isCrossBlockSelection, insertPlainText) already correctly relies on.
    const getBlockFromSelection = () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }
        return getBlock(selection.getRangeAt(0).startContainer);
    };
    // document.execCommand('insertText', ...) was tried first (matches core's
    // own editing-command usage elsewhere) but Chrome's contenteditable engine
    // interprets embedded \n characters in the inserted string as paragraph
    // breaks, splitting the block into multiple <div> children instead of
    // inserting a literal newline character — confirmed directly via live
    // diagnostic (childNodeTypes showed new DIV nodes appear, not a single
    // updated text node). That silently violates the single-text-node/
    // fixed-block-count invariant this whole feature depends on. Manually
    // splicing the Range's text content sidesteps the browser's paragraph
    // heuristics entirely and always produces one Text node per block.
    const insertPlainText = (text) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return;
        }
        const range = selection.getRangeAt(0);
        const block = getBlock(range.startContainer);
        // Caret offset relative to the block's full text, measured BEFORE
        // the splice, so it can be restored by plain character offset after
        // normalize() below invalidates today's node references.
        const preRange = document.createRange();
        preRange.selectNodeContents(block ?? range.startContainer);
        preRange.setEnd(range.startContainer, range.startOffset);
        const caretOffset = preRange.toString().length + text.length;

        range.deleteContents();
        range.insertNode(document.createTextNode(text));

        // insertNode splits any existing text node around the insertion
        // point, leaving multiple sibling Text nodes — normalize() merges
        // them back into the single Text node the rest of this feature
        // assumes (block.firstChild, textNode.textContent.length checks
        // above).
        block?.normalize();
        if (block?.firstChild) {
            const restoredRange = document.createRange();
            const offset = Math.min(caretOffset, block.firstChild.textContent.length);
            restoredRange.setStart(block.firstChild, Math.max(0, offset));
            restoredRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(restoredRange);
        }
    };

    // Finds the adjacent EDITABLE block in the given direction, skipping
    // past any non-block siblings (Scene Beat markers, Regenerate button)
    // that sit between two message spans — a Scene Beat's own header/
    // controls are never merge targets themselves, only its text span is
    // (and that span is still excluded separately below via the beat-text
    // class check, since Stage 2 only wires the backspace/previous
    // direction — see handleManuscriptBoundaryMerge's own comment).
    const getAdjacentBlock = (block, direction) => {
        let sibling = direction === 'previous' ? block.previousElementSibling : block.nextElementSibling;
        while (sibling && !sibling.hasAttribute('data-remodel-manuscript-block')) {
            sibling = direction === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
        }
        return sibling;
    };

    // Performs a real chat[]-level merge instead of just blocking the
    // boundary-crossing edit, per the user's explicit sign-off: true
    // single-document feel, backspacing/forward-deleting across a message
    // boundary should actually join the two messages, discarding any
    // unused swipe alternates on the absorbed one. Scene Beats are always a
    // hard stop in both directions (never absorbed, never absorb) — a beat
    // is a distinct user-authored instruction with its own swipe/
    // regenerate/delete lifecycle (requirement #1 from the plan), so
    // silently folding its text into surrounding AI prose would corrupt
    // that lifecycle exactly as explicit-action-only merging already
    // avoids for handleStoryBeatDelete. Stage 2 only wires the
    // backspace/'previous' direction; forward-delete/'next' plus the full
    // beat-boundary check on THAT side is Stage 3.
    async function handleManuscriptBoundaryMerge(block, direction) {
        const adjacent = getAdjacentBlock(block, direction);
        if (!adjacent) {
            return false; // start/end of the whole manuscript — nothing to merge into
        }
        if (block.classList.contains('remodel-manuscript-beat-text')
            || adjacent.classList.contains('remodel-manuscript-beat-text')) {
            return false; // Scene Beat boundary — never merged, either side
        }

        // Which message SURVIVES differs by direction, and getting this
        // backwards silently swaps whose swipe alternates get kept vs
        // discarded (confirmed as a real bug during review, caught before
        // ever shipping the 'next' direction): backspace at the START of
        // `block` absorbs `block` INTO the previous message (`adjacent`
        // survives) — symmetrically, forward-delete at the END of `block`
        // absorbs the NEXT message (`adjacent`) INTO `block` (`block`
        // survives). In both cases the message the user is actively
        // standing in when they press the key is the one that keeps going;
        // the other one is what disappears.
        const keepMesId = Number((direction === 'previous' ? adjacent : block).dataset.remodelMesid);
        const absorbMesId = Number((direction === 'previous' ? block : adjacent).dataset.remodelMesid);
        if (!Number.isFinite(keepMesId) || !Number.isFinite(absorbMesId)) {
            return false;
        }

        const result = await mergeTwoAdjacentMessages(keepMesId, absorbMesId);
        if (!result) {
            return false;
        }
        mergeManuscriptSnapshotEntries(absorbMesId);

        // Reflect the merge live in the overlay immediately, rather than
        // waiting for the next full renderManuscriptOverlay() rebuild — the
        // user is actively typing right now and a full rebuild mid-keystroke
        // would nuke their caret (see renderManuscriptOverlay's own
        // live-editing note). Fold the absorbed block's text into the
        // surviving one directly, in the same order mergeTwoAdjacentMessages
        // used, and place the caret at the exact join point.
        const survivorEl = direction === 'previous' ? adjacent : block;
        const removedEl = direction === 'previous' ? block : adjacent;
        // The join point is always the SURVIVOR's own pre-merge text
        // length, read here before its textContent is overwritten below.
        // True in both directions because the survivor is always
        // chronologically the earlier of the two messages, so its own text
        // is always the first half of the merged result: 'previous' merges
        // adjacent.mes + block.mes (survivor=adjacent); 'next' merges
        // block.mes + adjacent.mes (survivor=block). Either way, the
        // survivor's own pre-merge length is exactly where its text ends
        // and the absorbed text begins.
        const joinOffset = survivorEl.textContent?.length ?? 0;
        survivorEl.textContent = result.mergedText;
        survivorEl.dataset.remodelMesid = String(result.survivingIndex);
        removedEl.remove();

        // deleteMessage() (inside mergeTwoAdjacentMessages) splices chat[],
        // shifting every message ABOVE absorbMesId down by 1 — exactly the
        // same bookkeeping mergeManuscriptSnapshotEntries already does for
        // the snapshot, but the live DOM spans' own data-remodel-mesid
        // attributes need the identical correction, or a SECOND merge later
        // in the same session reads a stale mesId and silently targets the
        // wrong chat[] message. Confirmed as a real bug via live multi-merge
        // testing: without this, merging twice in one session merged the
        // WRONG pair the second time, silently dropping a message's text
        // entirely rather than merging the intended one.
        // Every mesId-carrying element in the overlay, not just message
        // spans — the Scene Beat marker (buildManuscriptBeatMarker) and its
        // Regenerate button carry their own data-remodel-mesid too, and
        // neither has data-remodel-manuscript-block, so a selector scoped
        // to only that attribute would miss them. A beat that sits AFTER
        // the merge point would otherwise keep pointing its Hide/Delete/
        // Regenerate handlers at the wrong (stale) chat[] message.
        chat.querySelectorAll('[data-remodel-mesid]').forEach((el) => {
            const elMesId = Number(el.dataset.remodelMesid);
            if (Number.isFinite(elMesId) && elMesId > absorbMesId && el !== survivorEl) {
                el.dataset.remodelMesid = String(elMesId - 1);
            }
        });

        const targetNode = survivorEl.firstChild;
        if (targetNode) {
            const caretRange = document.createRange();
            const maxOffset = targetNode.nodeType === Node.TEXT_NODE ? targetNode.textContent.length : 0;
            caretRange.setStart(targetNode, Math.min(joinOffset, maxOffset));
            caretRange.collapse(true);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(caretRange);
        }

        return true;
    }

    chat.addEventListener('beforeinput', (event) => {
        if (!isActive() || event.isComposing) {
            return; // IME composition: let it run uninterrupted rather than risk corrupting it
        }

        const block = getBlockFromSelection();

        if (!block) {
            return;
        }

        if (isCrossBlockSelection()) {
            event.preventDefault(); // any edit over a cross-block selection is rejected outright
            return;
        }

        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

        if (!range || !range.collapsed) {
            return;
        }

        const atStart = range.startContainer === (block.firstChild ?? block) && range.startOffset === 0;
        const atEnd = range.endContainer === (block.lastChild ?? block) && range.endOffset === (block.textContent?.length ?? 0);

        if (event.inputType === 'deleteContentBackward' && atStart) {
            event.preventDefault(); // native delete never gets to run — we replay it as a real merge, or block it
            // Scene Beats are checked HERE, before handleManuscriptBoundaryMerge
            // is ever called — not delegated to a check inside that function.
            // A beat at the boundary must be a hard, immediate no-op: nothing
            // deleted, nothing merged, full stop. Confirmed as a real bug:
            // relying on the merge function's own internal beat check wasn't
            // enough on its own to guarantee this — the gate now lives at the
            // single point every boundary-crossing keystroke passes through.
            if (isBeatBlock(block)) {
                return;
            }
            handleManuscriptBoundaryMerge(block, 'previous');
        } else if (event.inputType === 'deleteContentForward' && atEnd) {
            event.preventDefault(); // native delete never gets to run — we replay it as a real merge, or block it
            if (isBeatBlock(block)) {
                return;
            }
            handleManuscriptBoundaryMerge(block, 'next');
        } else if (event.inputType === 'insertParagraph') {
            // Real, physical Enter keypresses were confirmed to still
            // create a brand-new block-level element (native contenteditable's
            // default action for a paragraph break) despite the keydown
            // listener below calling preventDefault() first — keydown's
            // preventDefault() does not reliably suppress the SEPARATE
            // beforeinput event that follows it in every engine/situation,
            // and this handler previously had no insertParagraph branch at
            // all to catch it as a second line of defense. Blocked here
            // unconditionally; the keydown handler is what actually inserts
            // the replacement literal \n.
            event.preventDefault();
        }
    });

    // Enter is handled here via keydown, not beforeinput's insertParagraph —
    // keydown is the more universally reliable signal for the Enter key
    // specifically across browser engines, and handling it in exactly one
    // place avoids any risk of double-inserting the replacement newline.
    chat.addEventListener('keydown', (event) => {
        if (!isActive() || event.key !== 'Enter' || event.shiftKey || event.ctrlKey
            || event.altKey || event.isComposing) {
            return;
        }

        const block = getBlockFromSelection();
        if (!block) {
            return;
        }

        event.preventDefault();

        // Confirmed as a real, reported bug, live-verified via real
        // (non-synthetic) CDP keyboard dispatch: resolving the block via
        // getBlock(event.target) was broken the moment DOM focus lived on
        // the overlay root rather than the specific span (the normal case,
        // since the overlay is the only contenteditable="true" element) —
        // event.target for a keydown is the FOCUSED element, not the
        // caret's container, so getBlock resolved to null and this entire
        // handler silently no-opped on every real keypress, leaving
        // native Enter's default paragraph-split behavior to run
        // unblocked (the actual cause of Enter creating a stray second
        // boxed span inside a beat). Fixed by resolving via
        // getBlockFromSelection() (Selection.anchorNode is always the
        // caret's true container) instead of event.target — this alone
        // fixes Enter for beats too, same as any other block: a literal
        // \n in place, never a preventDefault()-only no-op. Beats are NOT
        // a hard stop for Enter (unlike merge/delete) — multi-line beat
        // text is expected, same as any other block.
        insertPlainText('\n');
    });

    const handlePasteOrDrop = (event) => {
        if (!isActive() || !getBlockFromSelection()) {
            return;
        }

        event.preventDefault();

        if (isCrossBlockSelection()) {
            return; // reject outright rather than guess which block should receive it
        }

        const text = (event.clipboardData || event.dataTransfer)?.getData('text/plain') ?? '';
        insertPlainText(text.replace(/\r\n?/g, '\n'));
    };

    chat.addEventListener('paste', handlePasteOrDrop);
    chat.addEventListener('drop', handlePasteOrDrop);
}

// Drives core's real, hidden .mes_edit/.mes_edit_done/.mes_edit_cancel
// buttons for exactly one message and waits for that message's write-back to
// actually land in chat[] — messageEditDone (script.js) is not exported, so
// this is the only way to invoke it. MESSAGE_UPDATED is emitted at the very
// end of messageEditDone, strictly after chat[].mes has been overwritten and
// the DOM re-rendered back to formatted HTML (both happen synchronously,
// earlier in that same function, before any await) — confirmed directly by
// reading messageEditDone's source rather than assumed. Listening for it is
// therefore a reliable way to sequence N of these calls one at a time,
// exactly as this_edit_mes_id (a single scalar slot) requires.
function openEditCloseWith(mesId, closeSelector, newValue) {
    const context = getContext();
    return new Promise((resolve, reject) => {
        const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        const editButton = mesEl?.querySelector('.mes_edit');
        if (!mesEl || !editButton) {
            reject(new Error(`Manuscript commit: message #${mesId} not found in DOM.`));
            return;
        }

        const onUpdated = (updatedMesId) => {
            if (Number(updatedMesId) !== mesId) {
                return; // some other message's edit resolved first (shouldn't happen — sequential by design)
            }
            context.eventSource.removeListener(context.eventTypes.MESSAGE_UPDATED, onUpdated);
            // messageEditDone/messageEditCancel (script.js) clear this_edit_mes_id
            // on the line immediately AFTER awaiting this same MESSAGE_UPDATED
            // emit — meaning this listener can run (and this Promise can
            // resolve) BEFORE that clear has actually happened, since it runs
            // synchronously inside the emit's own internal listener loop.
            // Resolving on setTimeout(0) instead of immediately guarantees
            // the caller's continuation (this loop's next iteration, opening
            // the next message) runs in a later tick, after this_edit_mes_id
            // is definitely cleared — confirmed necessary via live diagnostic
            // (without this, the next .mes_edit click could still see a
            // stale this_edit_mes_id and take core's own
            // auto-commit-previous-edit branch unexpectedly).
            setTimeout(resolve, 0);
        };
        context.eventSource.on(context.eventTypes.MESSAGE_UPDATED, onUpdated);

        editButton.click();
        const textarea = mesEl.querySelector('#curEditTextarea');
        if (!textarea) {
            context.eventSource.removeListener(context.eventTypes.MESSAGE_UPDATED, onUpdated);
            reject(new Error(`Manuscript commit: #curEditTextarea did not appear for message #${mesId}.`));
            return;
        }
        if (newValue !== null) {
            textarea.value = newValue;
        }
        mesEl.querySelector(closeSelector)?.click();
    });
}

// Sequential, not parallel — this_edit_mes_id is a genuine single slot, so
// two of these in flight at once would corrupt each other. Dirty blocks are
// written back via open->overwrite->.mes_edit_done (real commit, re-runs
// core's normal MESSAGE_EDITED/MESSAGE_UPDATED/saveChatConditional pipeline
// exactly as a native single-message edit would). Untouched blocks — and
// EVERY block, dirty or not, when discard is true (Escape) — are restored
// via open->.mes_edit_cancel instead of hand-rolling a re-render — slightly
// wasteful, but reuses core's own messageFormatting() call with zero
// reimplementation, and .mes_edit_cancel is unconditionally present in the
// DOM (just CSS-hidden) so it's clickable even though never visible.
async function settleManuscriptEdits(snapshot, { discard = false } = {}) {
    // The overlay is the real scroll container now (#chat itself is
    // display-collapsed, see style.css) — captured here because
    // renderManuscriptOverlay's rebuild at the end of this function resets
    // scroll to 0 by clearing the overlay's content.
    const overlayEl = getRealManuscriptOverlay();
    const scrollTopBeforeCommit = overlayEl?.scrollTop;

    // Read every block's dirty/clean text BEFORE touching anything — once the
    // replay below starts clicking .mes_edit, core's own focus() call on the
    // freshly-created #curEditTextarea fires ANOTHER focusout on whatever was
    // focused a moment ago. If the manuscript state were still "active" at
    // that point, bindStoryManuscriptEditCommit's listener would treat that
    // as a second, overlapping commit and start a concurrent, racing call
    // into this same function — confirmed directly via live diagnostic
    // (multiple .mes_edit buttons ended up open simultaneously, and content
    // landed on the wrong message's DOM block via this_edit_mes_id cross-talk
    // between the two racing sequences). Snapshot the diffs and null out
    // getManuscriptEditState().snapshot synchronously, before the first
    // await, so that a re-entrant focusout/Escape during the replay below is
    // a guaranteed no-op in every OTHER binding that gates on that snapshot.
    // The remodel-manuscript-editing BODY CLASS is deliberately NOT removed
    // here: it stays present (and contenteditable/data-remodel-manuscript-block
    // stay stripped only from the blocks, not the class) until the replay
    // below fully finishes, so external callers — including tests — that
    // watch the class as a "settled" signal don't observe a false-early
    // completion while .mes_edit/.mes_edit_done/.mes_edit_cancel replay is
    // still in flight. Confirmed via live diagnostic: removing the class
    // before the loop let a completion-watcher read stale, still-being-
    // replayed DOM text as final.
    const diffs = snapshot.map(({ mesId, originalRaw }) => {
        const block = document.querySelector(`#${MANUSCRIPT_OVERLAY_ID} [data-remodel-mesid="${mesId}"][data-remodel-manuscript-block]`);
        const currentRaw = block ? block.textContent : originalRaw;
        return { mesId, currentRaw, dirty: !discard && currentRaw !== originalRaw };
    });

    endManuscriptEdit();

    for (const { mesId, currentRaw, dirty } of diffs) {
        try {
            if (dirty) {
                await openEditCloseWith(mesId, '.mes_edit_done', currentRaw);
            } else {
                await openEditCloseWith(mesId, '.mes_edit_cancel', null);
            }
        } catch (err) {
            console.error('Remodel manuscript editor: failed to settle message', mesId, err);
        }
    }

    // Unlike the old click-to-enter model, there is no "exit" state to
    // return to — the manuscript is continuously editable, so committing
    // just means "rebuild the overlay from whatever chat[] now says" (picks
    // up anything updateMessage's macro/regex pipeline changed on write)
    // rather than tearing edit mode down. renderManuscriptOverlay() already
    // re-adds remodel-manuscript-editing and calls updateStoryActionBarState.
    renderManuscriptOverlay();

    if (overlayEl && scrollTopBeforeCommit !== undefined) {
        requestAnimationFrame(() => {
            overlayEl.scrollTop = scrollTopBeforeCommit;
        });
    }
}

// Whole-manuscript commit trigger: focus leaving the entire manuscript-edit
// DOM subtree.
//
// Confirmed as a real, reported bug (traced live, not assumed): typed
// edits made without triggering an AI generation never saved at all —
// only edits that happened to run right before a generation started
// (which force-commits separately, see the GENERATION_STARTED handler)
// ever stuck. Root cause: clicking or placing a caret ANYWHERE inside a
// contenteditable region gives real DOM focus to the contenteditable
// ROOT itself (#remodel-manuscript-overlay) — the caret position within
// it is tracked purely via Selection/Range, never by focusing individual
// child <span> elements (confirmed directly: span.focus() silently does
// nothing here, document.activeElement stays the overlay/body). This
// listener is bound directly to the overlay (not delegated from a
// parent), so for a focusout fired BECAUSE THE OVERLAY ITSELF lost
// focus, event.target IS the overlay — .closest('[data-remodel-manuscript-block]')
// on the overlay itself always returned null (the overlay is the
// blocks' PARENT, not a block), so this guard silently discarded every
// single real commit attempt, unconditionally, regardless of what was
// clicked. There was no bug in WHEN this fired — only in a target check
// that could never pass.
function bindStoryManuscriptEditCommit() {
    const overlay = ensureManuscriptOverlay();
    overlay?.addEventListener('focusout', (event) => {
        if (!document.body.classList.contains('remodel-manuscript-editing')) {
            return;
        }

        // event.target is the overlay itself here (this listener is bound
        // directly to it) — the real question is only where focus is
        // GOING, not where it came from.
        const relatedTarget = event.relatedTarget;
        const stayingInManuscript = relatedTarget instanceof Element
            && overlay.contains(relatedTarget);
        if (stayingInManuscript) {
            return; // focus moved to something still inside the manuscript (e.g. a beat's Hide/Delete button) — not a commit
        }

        const { snapshot } = getManuscriptEditState();
        if (!snapshot) {
            return;
        }
        settleManuscriptEdits(snapshot);
    }, true); // capture — focusout target resolution is more reliable in capture for delegated listeners
}

// Escape discards the WHOLE in-progress manuscript edit, not just the
// focused block — a deliberate departure from core's own global Escape
// handler (script.js), which only closes whatever single message is
// currently mid-edit via this_edit_mes_id. That handler is also bound on
// document in the bubble phase, so capturing Escape here first and calling
// stopPropagation() (not just preventDefault()) keeps it from ever seeing
// the key at all — there is nothing for it to act on anyway, since by the
// time settleManuscriptEdits's discard pass finishes, this_edit_mes_id has
// already cycled through the real .mes_edit/.mes_edit_cancel replay itself.
function bindStoryManuscriptEditCancel() {
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing) {
            return;
        }
        if (!document.body.classList.contains('remodel-manuscript-editing')) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const { snapshot } = getManuscriptEditState();
        if (!snapshot) {
            return;
        }
        settleManuscriptEdits(snapshot, { discard: true });
    }, true); // capture — must run before core's own document-level Escape handler
}

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
