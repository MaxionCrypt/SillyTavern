import { getContext } from '../../../st-context.js';
import {
    doNavbarIconClick,
    doNewChat,
    extension_prompt_roles,
    extension_prompt_types,
    getPastCharacterChats,
    select_selected_character as selectCharacterForEditingOnly,
    selectRightMenuWithAnimation,
    setCharacterId,
    setCharacterName,
    setExtensionPrompt,
} from '../../../../script.js';
import { openGroupById } from '../../../group-chats.js';
// The live Chat Completion prompt manager. Read-only here: after a preview dry
// run it holds the assembled prompt broken down BY SOURCE (one collection per
// prompt identifier), which is the only place that attribution exists — the
// generateData.prompt array core hands back has already been flattened.
import { promptManager } from '../../../openai.js';
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
    isDuetScene,
    setActiveArc,
    setActiveScene,
    setActiveTimeline,
    setInsertedTextSlot,
    setSceneDuetSeats,
    setSceneRoleplayDirector,
    updateArc,
    updateScene,
    updateTimeline,
} from './timeline-state.js';
import {
    createStoryDoc,
    getStoryDoc,
    updateStoryDoc,
} from './story-doc.js';
import { generateProse } from './story-generate.js';
import {
    advanceStoryWorldInfoState,
    getStoryLorebookNames,
    getStoryWorldInfoMaxContext,
    resolveStoryWorldInfo,
} from './story-world-info.js';
import {
    applyPromptStudioRuntimeRecipe,
    capturePromptLog,
    capturePromptStudioRuntimeSettings,
    compilePromptRecipe,
    formatPromptStudioPreview,
    getCurrentPromptStudioRecipe,
    setRemodelNativePromptContent,
    getDefaultPromptStudioRecipe,
    getPromptApiType,
    getPromptStudioRecipe,
    getPromptStudioRecipes,
    initPromptStudio,
    renderPromptStudioWorkspace,
    syncPromptStudioForCurrentMode,
} from './prompt-studio.js';
import {
    decorateStoryGoalStream,
    formatStoryGoalsPrompt,
    getStoryGoalComposerIntents,
    handleGoalAwareRoleplaySend,
    initStoryGoals,
    isStoryPipelineRunning,
    renderStoryGoalsForRoleplay,
} from './story-goals.js';
import { getSceneGoals, updateSceneGoalState } from './story-goals-store.js';
import { clearMechanicsReceiptInjection } from './mechanics-runtime.js';
import { listVariablesForLoreRef, listVariableValues } from './variables-store.js';
import {
    listEvents as archiveListEvents,
    listSceneFacts as archiveListSceneFacts,
    listCharStates as archiveListCharStates,
    listSecrets as archiveListSecrets,
    setSceneFact as archiveSetSceneFact,
    clearSceneFact as archiveClearSceneFact,
    setSecret as archiveSetSecret,
    clearSecret as archiveClearSecret,
    clearCharStateFacet as archiveClearCharStateFacet,
} from './archivist-store.js';
import {
    buildVariableStateBodyMarkup,
    handleVariablesUiChange,
    handleVariablesUiClick,
    handleVariablesUiInput,
    refreshVariableLore,
    renderLinkedVariablesSection,
    renderVariableCodex,
    renderVariableStateInner,
} from './variables-ui.js';
import {
    canSendWithoutLiveDirection,
    clearLiveDirectionFailure,
    continueLiveDirection,
    dismissDirectionRecord,
    restoreStandingDirectionFromMessage,
    formatDirectorNotesPrompt,
    frameDirectorReasoning,
    getLiveDirectionRun,
    getLiveDirectionUiState,
    handleLiveDirectionDraft,
    initLiveDirection,
    describeNativeGenerationBlock,
    isDirectedLiveScene,
    ownsLiveDirectionGeneration,
    previewDirectorPrompt,
    regenerateLastDirectedResponse,
    requestNextDirection,
    retryLiveStep,
    continueLiveStep,
    describeLiveStepActions,
    forgetStandingDirection,
    retryLiveDirection,
    sendWithoutLiveDirection,
    setLiveDirectionEnabled,
    setLiveDirectionPacing,
    setLiveDirectionMode,
    setNextPerformerOverride,
    stopLiveDirection,
    submitDirectedRoleplay,
} from './live-direction.js';
import { listExtractionProfiles, getExtractionProfileId, setExtractionProfileId } from './extraction-config.js';
import { sanitizeDirectionText } from './live-direction-markers.js';
import { resolveDirectionChromeMode } from './direction-chrome.js';
import {
    readAllEntriesForOwner,
    readTurnReasoning,
} from './director-notes-store.js';
import {
    handleDebugConsoleChange,
    handleDebugConsoleClick,
    handleDebugConsoleInput,
    initDebugConsole,
    recordDebugEvent,
    renderDebugConsoleWorkspace,
} from './debug-console.js';
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
    setCodexOpen,
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

import { resolveChatLorebook } from './chat-lorebook.js';
// world-info.js's METADATA_KEY. Named locally rather than imported so this
// module keeps its single core-import surface, and stated as a constant rather
// than a literal because getChatLore reads this exact key and nothing else.
const WORLD_INFO_METADATA_KEY = 'world_info';
const DRAWER_ID = 'remodel-timeline-drawer';
const PANEL_ID = 'remodel-timeline-panel';
const CONTENT_ID = 'remodel-timeline-content';
const LEGACY_OUTLET_ID = 'remodel-tavern-legacy-outlet';
const timelineChromeStages = new Map();
const timelineScrollIntent = new Map();

// View state for the Loom's Archive panel (a Timeline-focus surface, same
// family as codexOpen in session-state.js, but kept local here rather than
// added to that shared module: nothing outside this file needs it). Not
// chat-scoped and not persisted, matching every other view-only flag in this
// file (storyGenerating, timelineChromeStages, etc.).
const loomArchive = {
    open: false,
    // Which Scene's Archive is showing. Null selects the Timeline's own
    // activeSceneId (or the first eligible Scene) at render time, so the
    // picker doesn't have to be primed before the panel can open.
    sceneId: null,
    // Whose view of the Archive: 'loom' sees everything (secrets, odds,
    // variable values); 'narrator' sees the filtered view (no secrets, goals
    // as objectives without numbers, no variables).
    view: 'loom', // 'loom' | 'narrator'
    // The one record currently showing an inline edit field instead of
    // read-only text, or '' when none. Deliberately NOT mirrored into a
    // re-rendered-on-every-keystroke state field: this workspace replaces its
    // whole body innerHTML on every queueRender(), which would steal focus and
    // cursor position. The field is read directly from the DOM at Save time.
    editingId: '',
};

function resetLoomArchiveView() {
    loomArchive.open = false;
    loomArchive.sceneId = null;
    loomArchive.view = 'loom';
    loomArchive.editingId = '';
}

const TIMELINE_SCROLL_RESISTANCE = 160;
const TIMELINE_SCROLL_INTENT_WINDOW_MS = 650;
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
    {
        id: 'debug',
        label: 'Debug',
        icon: 'fa-terminal',
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

    initDebugConsole();
    const drawer = ensureTimelineDrawer();
    bindDrawerToggle(drawer);
    bindTimelineEvents(drawer);
    bindSillyTavernEvents();
    bindStoryLockInterceptor();
    observeTavernPanelState();
    bindExternalSidebarWindowSwitch();
    bindVariablesSurfaces();
    bindStoryEditorEvents();
    bindRoleplayComposerEvents();
    bindRoleplayGenerationFeedback();
    bindRoleplayCastPickerEvents();
    bindRoleplayDuetPickerEvents();
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
    initStoryGoals({
        getActiveScene,
        getCast: () => roleplaySceneMembers(getContext()).map((member) => ({ kind: 'character', id: getContext().characters?.[member.characterId]?.avatar || String(member.characterId), label: member.name })),
        getPersona: () => ({ kind: 'persona', id: currentPersonaAvatarId() || getContext().name1 || 'user', label: getContext().name1 || 'You' }),
        requestRender: renderRoleplayScene,
        showToast: showRoleplayToast,
    });
    initLiveDirection({
        getActiveScene,
        getCast: getLiveDirectionCast,
        getPersona: () => ({ kind: 'persona', id: currentPersonaAvatarId() || getContext().name1 || 'user', label: getContext().name1 || 'You' }),
        ensureSceneReady: ensureRoleplaySceneChatReady,
        getComposerDraft: () => getRealRoleplayRoot()?.querySelector('[data-remodel-rp-input]')?.value || '',
        clearComposer: clearRoleplayComposerDraft,
        sendNormally: sendRoleplayNormally,
        onStateChange: refreshLiveDirectionChrome,
        onSettled: () => { setRoleplayGenerating(false); renderRoleplayScene(); },
        setNativePromptContent: (sourceKey, content) => setRemodelNativePromptContent(sourceKey, content),
        onRecovered: () => { document.getElementById('remodel-direction-failure')?.remove(); },
        onFailure: showLiveDirectionFailure,
        // Called on EVERY chunk of the Director's streamed reply —
        // beginDirection's onChunk closure forwards each one unconditionally
        // (live-direction.js). This is the receiving half; do not add a
        // second forward, or every chunk arrives twice.
        onDirectorChunk: updateDirectionStreamCard,
    });
    // Initial extension startup can occur after core has already loaded a
    // linked chat, so no CHAT_CHANGED event remains to paint the correct
    // workspace. Reconcile from the live metadata immediately.
    syncStoryWorkspaceClass(getActiveScene());
    renderRoleplayScene();
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
/**
 * Variables surfaces are mounted in three places — both scene rails (inside
 * #sheld) and inside native Lorebook entries — so their events are caught at the
 * document rather than on any one container. The handlers claim an event by
 * returning true, and repaint every mounted surface so the two rails and an open
 * entry never disagree about what a Variable currently is.
 */
function bindVariablesSurfaces() {
    document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('[data-remodel-varstate], [data-remodel-varlink], [data-remodel-varcodex]')) return;
        if (handleVariablesUiClick(event.target, refreshVariableStateSurfaces)) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    document.addEventListener('input', (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('[data-remodel-varstate], [data-remodel-varlink], [data-remodel-varcodex]')) return;
        handleVariablesUiInput(event.target);
    });
    document.addEventListener('change', (event) => {
        if (!(event.target instanceof Element)) return;
        if (!event.target.closest('[data-remodel-varstate], [data-remodel-varlink], [data-remodel-varcodex]')) return;
        if (handleVariablesUiChange(event.target, refreshVariableStateSurfaces)) {
            event.stopPropagation();
        }
    });
}

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
        if (event.target instanceof Element && handleDebugConsoleClick(event.target, queueRender)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
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
        if (event.target instanceof Element && handleDebugConsoleInput(event.target)) return;
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
        if (event.target instanceof Element && handleDebugConsoleChange(event.target, queueRender)) return;
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

    drawer.addEventListener('wheel', (event) => {
        const main = event.target instanceof Element
            ? event.target.closest('[data-remodel-route-main]')
            : null;

        if (!main || !event.deltaY) return;

        const timelineId = main.dataset.timelineId;
        const scenes = main.querySelector('.remodel-route-scenes');
        const stage = getTimelineChromeStage(timelineId);
        const direction = Math.sign(event.deltaY);
        const shouldCollapse = direction > 0 && stage < 2;
        const shouldExpand = direction < 0 && stage > 0 && (!scenes || scenes.scrollTop <= 1);

        if (!shouldCollapse && !shouldExpand) return;

        event.preventDefault();
        if (!hasTimelineScrollIntentReachedThreshold(timelineId, direction, event)) return;
        setTimelineChromeStage(timelineId, stage + direction);
    }, { passive: false });
}

function getTimelineChromeStage(timelineId) {
    return timelineChromeStages.get(timelineId) || 0;
}

function hasTimelineScrollIntentReachedThreshold(timelineId, direction, event) {
    const now = performance.now();
    const prior = timelineScrollIntent.get(timelineId);
    const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 100 : 1;
    const delta = Math.abs(event.deltaY) * multiplier;
    const continuesPriorIntent = prior
        && prior.direction === direction
        && now - prior.updatedAt <= TIMELINE_SCROLL_INTENT_WINDOW_MS;
    const amount = (continuesPriorIntent ? prior.amount : 0) + delta;

    if (amount < TIMELINE_SCROLL_RESISTANCE) {
        timelineScrollIntent.set(timelineId, { direction, amount, updatedAt: now });
        return false;
    }

    timelineScrollIntent.delete(timelineId);
    return true;
}

function setTimelineChromeStage(timelineId, requestedStage) {
    if (!timelineId) return;

    const stage = Math.max(0, Math.min(2, Number(requestedStage) || 0));
    if (stage) timelineChromeStages.set(timelineId, stage);
    else timelineChromeStages.delete(timelineId);
    timelineScrollIntent.delete(timelineId);

    const main = document.querySelector(`[data-remodel-route-main][data-timeline-id="${CSS.escape(timelineId)}"]`);
    main?.classList.toggle('is-premise-collapsed', stage >= 1);
    main?.classList.toggle('is-synopsis-collapsed', stage >= 2);
    main?.querySelector('[data-remodel-timeline-action="toggle-premise"]')
        ?.setAttribute('aria-expanded', String(stage === 0));
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
    if (context.eventTypes.WORLDINFO_SETTINGS_UPDATED) {
        context.eventSource.on(context.eventTypes.WORLDINFO_SETTINGS_UPDATED, refreshStoryLorebookBindings);
    }
}

function refreshStoryLorebookBindings() {
    const doc = activeStoryDocId ? getStoryDoc(activeStoryDocId) : null;
    if (!doc) return;
    for (const select of document.querySelectorAll('[data-remodel-storydoc-lorebook]')) {
        select.innerHTML = renderStoryLorebookOptions(doc);
        select.value = doc.lorebookName || '';
    }
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
    await enterSceneViewport(getScene(sceneId));
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
    if (ownsLiveDirectionGeneration()) return;
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
    const previousCharacterId = context.characterId;
    const previousCharacterName = context.name2;
    const groupPreviewSpeaker = getGroupPreviewSpeaker(context);
    const restoreGroupPreviewName = bridgeGroupPreviewSpeakerName(groupPreviewSpeaker);

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
        if (groupPreviewSpeaker) {
            setCharacterId(groupPreviewSpeaker.characterId);
            setCharacterName(groupPreviewSpeaker.name);
        }

        await context.generate(generationType, groupPreviewSpeaker
            ? { force_chid: groupPreviewSpeaker.characterId }
            : {}, true);
    } finally {
        context.eventSource.removeListener(context.eventTypes.GENERATE_AFTER_DATA, captureListener);

        restoreGroupPreviewName();
        setCharacterId(previousCharacterId);
        setCharacterName(previousCharacterName);

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

// Core's group dry-run path selects the first enabled member but then clears
// name2 before resolving card fields and prompt macros. Real group generation
// does not: generateGroupWrapper keeps both the drafted character id and name
// active throughout assembly. Determine the same member core's dry run will
// choose so Preview can reproduce the real generation context.
function getGroupPreviewSpeaker(context) {
    if (!context.groupId) return null;

    const group = (context.groups || []).find((candidate) => String(candidate.id) === String(context.groupId));
    if (!group || !Array.isArray(group.members)) return null;

    const disabledMembers = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
    const seenMembers = new Set();

    for (const avatar of group.members) {
        if (seenMembers.has(avatar) || disabledMembers.has(avatar)) continue;
        seenMembers.add(avatar);
        const characterId = (context.characters || []).findIndex((character) => character?.avatar === avatar);
        const character = context.characters?.[characterId];
        if (characterId !== -1 && character?.name) {
            return { group, characterId, name: character.name };
        }
    }

    return null;
}

// getCharacterCardFields() consults generation_mode immediately after core's
// dry-run branch clears name2. Temporarily preserving that ordinary property
// behind an accessor gives us one precise extension-side seam to restore the
// drafted name before any card text, World Info scan data, or {{char}} macros
// are resolved. The original descriptor and any value written during the dry
// run are restored in finally, so the group object is unchanged afterward.
function bridgeGroupPreviewSpeakerName(speaker) {
    if (!speaker?.group || !speaker.name) return () => {};

    const group = speaker.group;
    const property = 'generation_mode';
    const originalDescriptor = Object.getOwnPropertyDescriptor(group, property);
    if (originalDescriptor && (!originalDescriptor.configurable || originalDescriptor.get || originalDescriptor.set)) {
        return () => {};
    }

    let value = originalDescriptor?.value ?? group[property];
    Object.defineProperty(group, property, {
        configurable: true,
        enumerable: originalDescriptor?.enumerable ?? true,
        get() {
            setCharacterName(speaker.name);
            return value;
        },
        set(nextValue) {
            value = nextValue;
        },
    });

    return () => {
        if (originalDescriptor) {
            Object.defineProperty(group, property, { ...originalDescriptor, value });
        } else {
            delete group[property];
        }
    };
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
            .map((entry) => {
                const role = String(entry.role || 'unknown').toUpperCase();
                const name = String(entry.name || '').trim();
                const heading = name ? `${role} · ${name}` : role;
                return `=== ${heading} ===\n${entry.content ?? ''}`;
            })
            .join('\n\n');
    }

    return '(Unrecognized prompt format — nothing to show.)';
}

// --- Prompt preview, broken down by source ---------------------------------
//
// generateData.prompt is the FLATTENED message array — by the time core hands
// it over, "which prompt did this come from" is gone. promptManager.messages,
// set at the end of the same assembly (setChatCompletion), still has the
// structure: one MessageCollection per prompt identifier, in prompt order.
// Reading it straight after the dry run is what lets the preview say "this
// paragraph is World Info (after)" instead of showing one undifferentiated
// wall of text.
function collectPromptPreviewSections() {
    const root = promptManager?.messages;
    if (!root || typeof root.getCollection !== 'function') {
        return null;
    }
    const counts = promptManager.tokenHandler?.getCounts?.() || {};
    const sections = root.getCollection().map((entry) => {
        const identifier = String(entry?.identifier || '');
        const prompt = promptManager.getPromptById?.(identifier);
        // A marker expands to a collection of messages; a plain prompt is a
        // single Message. Normalize both to a list.
        const messages = typeof entry?.getChat === 'function'
            ? entry.getChat()
            : [{ role: entry?.role, content: entry?.content, name: entry?.name }];
        const filled = messages.filter((message) => String(message?.content || '').trim().length > 0);
        return {
            identifier,
            title: prompt?.name || prettifyPromptIdentifier(identifier),
            role: prompt?.role || filled[0]?.role || 'system',
            marker: Boolean(prompt?.marker),
            tokens: Number(counts[identifier]) || 0,
            messages: filled,
        };
    });
    return sections.length ? sections : null;
}

function prettifyPromptIdentifier(identifier) {
    if (!identifier) return 'Unnamed prompt';
    return identifier
        .replace(/[-_]+/g, ' ')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/^./, (character) => character.toUpperCase());
}

function renderPromptPreviewSections(sections) {
    const total = sections.reduce((sum, section) => sum + section.tokens, 0);
    const present = sections.filter((section) => section.messages.length).length;
    const cards = sections.map((section) => {
        const empty = section.messages.length === 0;
        const body = section.messages
            .map((message) => {
                const speaker = String(message.name || '').trim();
                const label = speaker
                    ? `${String(message.role || 'system').toUpperCase()} · ${speaker}`
                    : String(message.role || 'system').toUpperCase();
                return `<div class="remodel-rp-preview-msg"><span class="remodel-rp-preview-msg-role">${escapeHtml(label)}</span><pre>${escapeHtml(message.content || '')}</pre></div>`;
            })
            .join('');
        return `
            <article class="remodel-rp-preview-card${empty ? ' is-empty' : ''}${section.marker ? ' is-marker' : ''}" data-remodel-preview-card${empty ? '' : ' open'}>
                <details${empty ? '' : ' open'}>
                    <summary>
                        <span class="remodel-rp-preview-card-role">${escapeHtml(String(section.role || 'system').toUpperCase())}</span>
                        <span class="remodel-rp-preview-card-title">${escapeHtml(section.title)}</span>
                        <span class="remodel-rp-preview-card-meta">${escapeHtml(section.identifier)}${empty ? ' · empty' : ` · ${section.tokens} tok`}</span>
                    </summary>
                    <div class="remodel-rp-preview-card-body">${empty ? '<p class="remodel-rp-preview-empty">Nothing was contributed by this source on this turn.</p>' : body}</div>
                </details>
            </article>
        `;
    }).join('');
    return `
        <div class="remodel-rp-preview-summary">
            <span><strong>${present}</strong> of ${sections.length} sources contributed</span>
            <span><strong>${total}</strong> tokens total</span>
        </div>
        <div class="remodel-rp-preview-cards">${cards}</div>
    `;
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
const MANUSCRIPT_FONT_STORAGE_KEY = 'remodel-manuscript-font';
const MANUSCRIPT_SIZE_STORAGE_KEY = 'remodel-manuscript-size';
const MANUSCRIPT_DEFAULT_SIZE = '15px';

const MANUSCRIPT_FONT_OPTIONS = [
    { label: 'Georgia (default)', value: "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', serif" },
    { label: 'Garamond', value: "'EB Garamond', Garamond, 'Times New Roman', serif" },
    { label: 'Courier (typewriter)', value: "'Courier New', Courier, monospace" },
    { label: 'Grotesque (sans)', value: "'Segoe UI', Helvetica, Arial, sans-serif" },
];

const MANUSCRIPT_SIZE_OPTIONS = ['13px', '14px', '15px', '16px', '17px', '18px', '20px', '22px', '26px'];

// --remodel-manuscript-font is a SHARED variable — the roleplay stream reads
// it too — so whole-manuscript typography is scoped to the story editor
// element instead of being set on <body>. One scene's face and size can then
// never reach another scene, and a roleplay scene always renders in the
// default stack declared on body.st-remodel-active.
function applyManuscriptTypography(doc) {
    const editor = getRealStoryEditor();
    if (!editor) {
        return;
    }
    editor.style.setProperty('--remodel-manuscript-font', doc?.font || MANUSCRIPT_FONT_OPTIONS[0].value);
    editor.style.setProperty('--remodel-manuscript-size', doc?.fontSize || MANUSCRIPT_DEFAULT_SIZE);
    clearLegacyManuscriptTypography();
}

// Earlier builds wrote these two onto <body> (and into localStorage), which
// is exactly the bleed this scoping fixes — strip whatever they left behind
// so a returning reader isn't stuck with a roleplay scene in Courier.
function clearLegacyManuscriptTypography() {
    document.body.style.removeProperty('--remodel-manuscript-font');
    document.body.style.removeProperty('--remodel-manuscript-size');
    try {
        localStorage.removeItem(MANUSCRIPT_FONT_STORAGE_KEY);
        localStorage.removeItem(MANUSCRIPT_SIZE_STORAGE_KEY);
    } catch (err) {
        /* local storage unavailable — nothing to clean up */
    }
}

// Whole-manuscript font/size writes: the doc owns them, so they persist with
// the document and travel with the scene.
function setManuscriptTypography(patch) {
    if (!activeStoryDocId) {
        return;
    }
    updateStoryDoc(activeStoryDocId, patch);
    applyManuscriptTypography(getStoryDoc(activeStoryDocId));
    setStorySaveState('Saved');
}

function handleManuscriptFontChange(selectEl) {
    setManuscriptTypography({ font: selectEl.value });
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
        // A streamed Story request bypasses generateRawData, so it never sees
        // core's own abort hook — Stop has to reach it through here.
        storyStreamAbort?.abort(new Error('Generation stopped'));

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

/**
 * Pick the lorebook bound to a whole Timeline.
 *
 * Until now the only story lorebook control was the per-document one buried in
 * the story editor's guidance panel, so a book shared by every Scene in a
 * Timeline had to be re-selected on each document. This binds it once, at the
 * level people actually think about it.
 */
async function chooseTimelineLorebook(timelineId) {
    const timeline = getTimelineStore().timelines[timelineId];
    if (!timeline) {
        return;
    }
    const context = getContext();
    const names = getStoryLorebookNames();
    const current = String(timeline.lorebookName || '');

    const wrapper = document.createElement('div');
    wrapper.className = 'remodel-lorebook-picker';
    const options = ['<option value="">No timeline lorebook</option>'];
    // Keep a book that has since been renamed or deleted visible, so opening
    // the picker can never silently discard an existing binding.
    if (current && !names.includes(current)) {
        options.push(`<option value="${escapeAttribute(current)}">${escapeHtml(current)} (unavailable)</option>`);
    }
    options.push(...names.map((name) => `<option value="${escapeAttribute(name)}">${escapeHtml(name)}</option>`));
    wrapper.innerHTML = `
        <h3>Timeline lorebook</h3>
        <p>Entries from this book are offered to every Scene in this Timeline. Global, character and persona lorebooks keep working as they always do.</p>
        <select data-remodel-timeline-lorebook>${options.join('')}</select>`;
    const select = wrapper.querySelector('select');
    select.value = current;

    const result = await context.callGenericPopup(wrapper, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
    });
    if (!result) {
        return;
    }
    updateTimeline(timelineId, { lorebookName: select.value || null });
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
            timelineChromeStages.delete(element.dataset.timelineId);
            timelineScrollIntent.delete(element.dataset.timelineId);
            resetLoomArchiveView();
            setFocusedTimelineId(element.dataset.timelineId);
            break;
        case 'close-timeline':
            timelineChromeStages.delete(focusedTimelineId);
            timelineScrollIntent.delete(focusedTimelineId);
            resetLoomArchiveView();
            setFocusedTimelineId(null);
            break;
        case 'delete-timeline':
            if (confirm('Delete this Timeline and all of its Arcs and Scenes?')) {
                if (focusedTimelineId === element.dataset.timelineId) {
                    setFocusedTimelineId(null);
                }
                timelineChromeStages.delete(element.dataset.timelineId);
                timelineScrollIntent.delete(element.dataset.timelineId);
                deleteTimeline(element.dataset.timelineId);
            }
            break;
        case 'toggle-premise': {
            const timelineId = element.dataset.timelineId;
            setTimelineChromeStage(timelineId, getTimelineChromeStage(timelineId) === 0 ? 1 : 0);
            return;
        }
        case 'choose-lorebook':
            await chooseTimelineLorebook(element.dataset.timelineId);
            break;
        case 'toggle-codex':
            setCodexOpen(!getSessionState().codexOpen);
            // Entry names and the attach browser come from an async read.
            if (getSessionState().codexOpen) refreshVariableLore().then(queueRender);
            break;
        case 'toggle-archive':
            loomArchive.open = !loomArchive.open;
            loomArchive.editingId = '';
            break;
        case 'archive-view':
            loomArchive.view = element.dataset.view === 'narrator' ? 'narrator' : 'loom';
            loomArchive.editingId = '';
            break;
        case 'archive-edit-start':
            loomArchive.editingId = element.dataset.recordId || '';
            break;
        case 'archive-edit-cancel':
            loomArchive.editingId = '';
            break;
        case 'archive-edit-save': {
            const { timelineId, sceneId, recordId } = element.dataset;
            // Read straight off the DOM rather than tracked state — the panel
            // re-renders on every keystroke, which would steal the caret.
            const draft = element.closest('.remodel-archive-item')?.querySelector('[data-remodel-archive-draft]');
            if (timelineId && sceneId && recordId && draft instanceof HTMLInputElement) {
                applyArchiveEdit(timelineId, sceneId, recordId, draft.value);
            }
            loomArchive.editingId = '';
            break;
        }
        case 'archive-delete': {
            const { timelineId, sceneId, recordId } = element.dataset;
            if (timelineId && sceneId && recordId && confirm('Remove this from the Loom\'s memory? This cannot be undone.')) {
                applyArchiveDelete(timelineId, sceneId, recordId);
                if (loomArchive.editingId === recordId) loomArchive.editingId = '';
            }
            break;
        }
        case 'create-arc': {
            const title = askForTitle('Arc title?', 'New Arc');
            if (title) {
                createArc(element.dataset.timelineId, title);
            }
            break;
        }
        case 'select-arc':
            setActiveArc(element.dataset.arcId);
            break;
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
        case 'rename-scene':
            setRenamingSceneId(element.dataset.sceneId);
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
        case 'archive-scene':
            loomArchive.sceneId = value || null;
            loomArchive.editingId = '';
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
        || activeTavernTab === 'debug'
        || Boolean(TAVERN_TABS.find((tab) => tab.id === activeTavernTab)?.panelId);
    viewport.classList.toggle('is-header-collapsed', isHeaderCollapsed);
    viewport.classList.toggle('is-timeline-focus', isTimelineFocused);
    viewport.classList.toggle('is-personas-workspace', activeTavernTab === 'personas');
    viewport.classList.toggle('is-lorebooks-workspace', activeTavernTab === 'lorebooks');
    viewport.classList.toggle('is-debug-workspace', activeTavernTab === 'debug');

    // Header and tabs are persistent so their collapse/slide animates; only their
    // active state and the body content are re-rendered on each pass.
    const tabsNav = viewport.querySelector('.remodel-tavern-tabs');
    tabsNav.innerHTML = renderTavernTabs();

    const body = viewport.querySelector('.remodel-tavern-body');
    body.innerHTML = renderActiveWorkspace(store);

    if (activeTavernTab === 'timeline' || activeTavernTab === 'characters' || activeTavernTab === 'prompts' || activeTavernTab === 'debug') {
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

    if (loomArchive.editingId) {
        const draft = body.querySelector('[data-remodel-archive-draft]');

        if (draft instanceof HTMLInputElement) {
            draft.focus();
            draft.setSelectionRange(draft.value.length, draft.value.length);
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

    if (activeTavernTab === 'debug') {
        return renderDebugConsoleWorkspace();
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
    const activeArc = store.arcs[timeline.activeArcId] || store.arcs[timeline.arcIds[0]] || null;
    const timelineOrder = Math.max(1, store.timelineIds.indexOf(timeline.id) + 1);
    const sceneCount = timeline.arcIds.reduce((total, arcId) => total + (store.arcs[arcId]?.sceneIds.length || 0), 0);
    const chromeStage = getTimelineChromeStage(timeline.id);

    return `
        <section class="remodel-timeline-focus remodel-route-overview ${hasImage ? 'has-image' : ''}" style="${rootStyle}" aria-label="Timeline ${escapeAttribute(timeline.title)}">
            <div class="remodel-focus-backdrop" aria-hidden="true"></div>
            <header class="remodel-route-toolbar">
                <div class="remodel-route-toolbar-leading">
                    <button type="button" class="remodel-route-round-button" title="Back to Timelines" aria-label="Back to Timelines" data-remodel-timeline-action="close-timeline">
                        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
                    </button>
                    <div class="remodel-route-breadcrumb">
                        <span>Timeline Archive</span>
                        <strong>Route ${toRoman(timelineOrder)}</strong>
                    </div>
                </div>
                <div class="remodel-route-toolbar-meta" aria-label="Timeline statistics">
                    <span>${timeline.arcIds.length} Arc${timeline.arcIds.length === 1 ? '' : 's'}</span>
                    <span>${sceneCount} Scene${sceneCount === 1 ? '' : 's'}</span>
                </div>
                <div class="remodel-route-toolbar-actions">
                    <button
                        type="button"
                        class="remodel-route-round-button ${timeline.lorebookName ? 'is-bound' : ''}"
                        title="${timeline.lorebookName ? `Timeline lorebook: ${escapeAttribute(timeline.lorebookName)}` : 'Choose a lorebook for this timeline'}"
                        aria-label="Timeline lorebook"
                        data-remodel-timeline-action="choose-lorebook"
                        data-timeline-id="${escapeAttribute(timeline.id)}"
                    >
                        <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                    </button>
                    <button
                        type="button"
                        class="remodel-route-round-button ${getSessionState().codexOpen ? 'is-open' : ''}"
                        title="${getSessionState().codexOpen ? 'Back to Scenes' : 'Variables Codex'}"
                        aria-label="Variables Codex"
                        aria-pressed="${getSessionState().codexOpen ? 'true' : 'false'}"
                        data-remodel-timeline-action="toggle-codex"
                    >
                        <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>
                    </button>
                    <button
                        type="button"
                        class="remodel-route-round-button ${loomArchive.open ? 'is-open' : ''}"
                        title="${loomArchive.open ? 'Back to Scenes' : "Loom's Archive"}"
                        aria-label="Loom's Archive"
                        aria-pressed="${loomArchive.open ? 'true' : 'false'}"
                        data-remodel-timeline-action="toggle-archive"
                        data-timeline-id="${escapeAttribute(timeline.id)}"
                    >
                        <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
                    </button>
                    <label class="remodel-route-round-button" title="Change timeline cover">
                        <input type="file" accept="image/*" data-remodel-timeline-photo-input data-timeline-id="${escapeAttribute(timeline.id)}" hidden>
                        <i class="fa-solid fa-image" aria-hidden="true"></i>
                    </label>
                    <button type="button" class="remodel-route-round-button danger" title="Delete Timeline" aria-label="Delete Timeline" data-remodel-timeline-action="delete-timeline" data-timeline-id="${escapeAttribute(timeline.id)}">
                        <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                    </button>
                </div>
            </header>
            ${getSessionState().codexOpen ? `<div class="remodel-route-layout is-codex">${renderVariableCodex()}</div>` : loomArchive.open ? `<div class="remodel-route-layout is-archive">${renderLoomArchive(timeline, store)}</div>` : `
            <div class="remodel-route-layout">
                <aside class="remodel-route-side">
                    <label class="remodel-timeline-card remodel-route-cover-card" title="Change timeline cover">
                        <input type="file" accept="image/*" data-remodel-timeline-photo-input data-timeline-id="${escapeAttribute(timeline.id)}" hidden>
                        <span class="remodel-timeline-card-frame">
                            <span class="remodel-timeline-card-art ${hasImage ? 'has-image' : ''}" aria-hidden="true"></span>
                            <span class="remodel-timeline-card-numeral">${toRoman(timelineOrder)}</span>
                            ${renderCardFlourishes()}
                            <span class="remodel-timeline-card-plate">
                                <span class="remodel-timeline-card-title">${escapeHtml(timeline.title)}</span>
                                <span class="remodel-timeline-card-meta">${timeline.arcIds.length} Arc${timeline.arcIds.length === 1 ? '' : 's'} &middot; ${sceneCount} Scene${sceneCount === 1 ? '' : 's'}</span>
                            </span>
                            ${hasImage ? '' : '<span class="remodel-route-cover-empty"><i class="fa-solid fa-image" aria-hidden="true"></i><small>Add cover art</small></span>'}
                        </span>
                    </label>
                </aside>
                <main class="remodel-route-main ${chromeStage >= 1 ? 'is-premise-collapsed' : ''} ${chromeStage >= 2 ? 'is-synopsis-collapsed' : ''}" data-remodel-route-main data-timeline-id="${escapeAttribute(timeline.id)}">
                    <section class="remodel-route-identity">
                        <input
                            type="text"
                            class="remodel-route-title"
                            value="${escapeAttribute(timeline.title)}"
                            data-remodel-timeline-field="timeline-title"
                            data-timeline-id="${escapeAttribute(timeline.id)}"
                            aria-label="Timeline name"
                        >
                        <div class="remodel-route-premise-reveal">
                            <label class="remodel-route-description-field">
                                <span>Timeline premise</span>
                                <textarea
                                    rows="${estimateTextareaRows(timeline.description, 78, 3)}"
                                    placeholder="Describe the premise, tone, and direction of this timeline..."
                                    data-remodel-timeline-field="timeline-description"
                                    data-timeline-id="${escapeAttribute(timeline.id)}"
                                >${escapeHtml(timeline.description || '')}</textarea>
                            </label>
                        </div>
                    </section>
                    <button
                        type="button"
                        class="remodel-route-rule"
                        title="${chromeStage >= 1 ? 'Show timeline premise' : 'Hide timeline premise'}"
                        aria-label="${chromeStage >= 1 ? 'Show timeline premise' : 'Hide timeline premise'}"
                        aria-expanded="${String(chromeStage === 0)}"
                        data-remodel-timeline-action="toggle-premise"
                        data-timeline-id="${escapeAttribute(timeline.id)}"
                    ><span></span></button>
                    <section class="remodel-route-arc-stage">
                        ${activeArc ? renderActiveArc(activeArc, timeline, store) : renderEmptyArcStage(timeline)}
                    </section>
                </main>
                ${renderArcIndex(timeline, store, activeArc)}
            </div>`}
        </section>
    `;
}

// --- Loom's Archive (Timeline focus surface) --------------------------------
//
// The owner-facing view onto the Loom's memory of a Scene: its own store
// (events, scene facts, character states, secrets) plus the Goals and
// Variables it posts to. Reached from the same toolbar as the Variables Codex
// (toggle-archive / toggle-codex are siblings) and replaces the same arc-stage
// layout while open. A view toggle switches between the Loom's full view
// (everything, including secrets and the numbers) and the Narrator's filtered
// view (no secrets, goals as objectives without odds, no variables) — so the
// owner can see exactly what each side of the turn is allowed to know.

/** Roleplay Scenes in this Timeline, in Arc/Scene order — the ones the Loom
 * keeps an Archive for. */
function listArchiveScenes(timeline, store) {
    return timeline.arcIds
        .flatMap((arcId) => store.arcs[arcId]?.sceneIds || [])
        .map((sceneId) => store.scenes[sceneId])
        .filter((scene) => scene?.mode === 'roleplay')
        .map((scene) => ({ id: scene.id, title: scene.title || 'Untitled Scene' }));
}

/** One Archive section: a titled, counted list of items (each already HTML),
 * or an empty line when there is nothing to show. */
function renderArchiveSection(title, icon, items, emptyText, { tone = '' } = {}) {
    return `<section class="remodel-archive-section ${tone}">
        <header class="remodel-archive-section-head">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <span>${escapeHtml(title)}</span>
            <span class="remodel-archive-count">${items.length}</span>
        </header>
        ${items.length
        ? `<ul class="remodel-archive-list">${items.join('')}</ul>`
        : `<p class="remodel-archive-empty-line">${escapeHtml(emptyText)}</p>`}
    </section>`;
}

/**
 * A keyed item: an optional key/label on the left, its value text on the
 * right, and an optional trailing badge (odds / a number). When `recordId` is
 * given and the item is editable/deletable, it also carries the Loom-only edit
 * (inline text field) and delete controls that correct the Loom's memory. The
 * whole item collapses to an inline editor while `loomArchive.editingId`
 * matches its `recordId`.
 */
function renderArchiveItem(key, text, {
    badge = '', recordId = '', editable = false, deletable = false, editValue = '', timelineId = '', sceneId = '',
} = {}) {
    const editing = recordId && loomArchive.editingId === recordId;
    const attrs = `data-record-id="${escapeAttribute(recordId)}" data-timeline-id="${escapeAttribute(timelineId)}" data-scene-id="${escapeAttribute(sceneId)}"`;

    if (editing) {
        return `<li class="remodel-archive-item is-editing">
            ${key ? `<span class="remodel-archive-key">${escapeHtml(key)}</span>` : ''}
            <span class="remodel-archive-edit">
                <input type="text" data-remodel-archive-draft value="${escapeAttribute(editValue)}">
                <button type="button" data-remodel-timeline-action="archive-edit-save" ${attrs}>Save</button>
                <button type="button" data-remodel-timeline-action="archive-edit-cancel">Cancel</button>
            </span>
        </li>`;
    }

    const actions = recordId && (editable || deletable)
        ? `<span class="remodel-archive-item-actions">
            ${editable ? `<button type="button" title="Edit" aria-label="Edit" data-remodel-timeline-action="archive-edit-start" ${attrs}><i class="fa-solid fa-pen" aria-hidden="true"></i></button>` : ''}
            ${deletable ? `<button type="button" class="danger" title="Remove from the Loom's memory" aria-label="Remove" data-remodel-timeline-action="archive-delete" ${attrs}><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>` : ''}
        </span>`
        : '';

    return `<li class="remodel-archive-item">
        ${key ? `<span class="remodel-archive-key">${escapeHtml(key)}</span>` : ''}
        <span class="remodel-archive-item-text">${text}</span>
        ${badge ? `<span class="remodel-archive-badge">${escapeHtml(badge)}</span>` : ''}
        ${actions}
    </li>`;
}

/** Apply an inline edit from the Archive: the recordId is `<type>:<key>`. Only
 * the Loom's own key/value records (facts, secrets) are editable. */
function applyArchiveEdit(timelineId, sceneId, recordId, value) {
    const separator = recordId.indexOf(':');
    const type = recordId.slice(0, separator);
    const key = recordId.slice(separator + 1);
    if (type === 'fact') archiveSetSceneFact(timelineId, sceneId, key, value);
    else if (type === 'secret') archiveSetSecret(timelineId, sceneId, key, value);
}

/** Delete a record from the Loom's memory. Facts and secrets clear directly; a
 * character record is removed by clearing every facet it holds. */
function applyArchiveDelete(timelineId, sceneId, recordId) {
    const separator = recordId.indexOf(':');
    const type = recordId.slice(0, separator);
    const key = recordId.slice(separator + 1);
    if (type === 'fact') archiveClearSceneFact(timelineId, sceneId, key);
    else if (type === 'secret') archiveClearSecret(timelineId, sceneId, key);
    else if (type === 'char') {
        const record = archiveListCharStates(timelineId, sceneId).find((char) => char.charId === key);
        for (const facet of Object.keys(record?.facets || {})) archiveClearCharStateFacet(timelineId, sceneId, key, facet);
    }
}

function renderArchiveViewToggle() {
    const isNarrator = loomArchive.view === 'narrator';
    return `<div class="remodel-archive-viewtoggle" role="group" aria-label="Whose view of the Archive">
        <button type="button" class="${isNarrator ? '' : 'is-active'}" aria-pressed="${isNarrator ? 'false' : 'true'}" data-remodel-timeline-action="archive-view" data-view="loom"><i class="fa-solid fa-eye" aria-hidden="true"></i> Loom's view</button>
        <button type="button" class="${isNarrator ? 'is-active' : ''}" aria-pressed="${isNarrator ? 'true' : 'false'}" data-remodel-timeline-action="archive-view" data-view="narrator"><i class="fa-solid fa-feather-pointed" aria-hidden="true"></i> Narrator's view</button>
    </div>`;
}

function renderLoomArchive(timeline, store) {
    const isNarrator = loomArchive.view === 'narrator';
    const closeButton = `<button type="button" class="remodel-notebook-close" data-remodel-timeline-action="toggle-archive">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to Scenes
    </button>`;
    const head = `<header class="remodel-notebook-head">
        <div>
            <span>Loom's Archive</span>
            <strong>${escapeHtml(timeline.title)}</strong>
        </div>
        <p>${isNarrator
        ? 'The Narrator\'s view: readable state and objectives only — no odds, no variables, no secrets.'
        : 'The Loom\'s full memory of this Scene — what happened, the facts and characters it tracks, its secrets, and the numbers behind Goals and Variables.'}</p>
    </header>`;

    const scenes = listArchiveScenes(timeline, store);
    if (!scenes.length) {
        return `<section class="remodel-notebook remodel-archive" aria-label="Loom's Archive">
            ${closeButton}
            ${head}
            <div class="remodel-notebook-empty">
                <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
                <p>This Timeline has no Roleplay Scenes yet, so the Loom has no Archive.</p>
            </div>
        </section>`;
    }

    const activeSceneId = scenes.some((scene) => scene.id === loomArchive.sceneId)
        ? loomArchive.sceneId
        : (scenes.find((scene) => scene.id === timeline.activeSceneId)?.id || scenes[0].id);

    const events = archiveListEvents(timeline.id, activeSceneId);
    const facts = archiveListSceneFacts(timeline.id, activeSceneId);
    const chars = archiveListCharStates(timeline.id, activeSceneId);
    const secrets = archiveListSecrets(timeline.id, activeSceneId);
    const goals = getSceneGoals(activeSceneId, { includeResolved: true, states: ['active', 'background'] });
    const variables = listVariableValues({ timelineId: timeline.id });

    // Edit/delete correct the Loom's own memory — offered only in the Loom's
    // view (the Narrator's view is a read-only preview of what it may see).
    const editable = !isNarrator;
    const scope = { timelineId: timeline.id, sceneId: activeSceneId };

    // What happened — newest first, so the latest beat is at the top. Events
    // are an append-only record, so they are never edited or deleted here.
    const eventItems = events.slice().reverse()
        .map((event) => renderArchiveItem('', escapeHtml(event.summary || '')));
    const factItems = facts.map((fact) => renderArchiveItem(fact.key, escapeHtml(String(fact.value)), {
        recordId: `fact:${fact.key}`, editable, deletable: editable, editValue: String(fact.value), ...scope,
    }));
    const charItems = chars.map((char) => renderArchiveItem(
        char.charId,
        escapeHtml(Object.entries(char.facets || {}).map(([facet, value]) => `${facet}: ${value}`).join(' · ')),
        { recordId: `char:${char.charId}`, deletable: editable, ...scope },
    ));
    const goalItems = goals.map((goal) => renderArchiveItem(
        '',
        `<strong>${escapeHtml(goal.title || 'Untitled goal')}</strong>${goal.description ? ` — ${escapeHtml(goal.description)}` : ''}`,
        // The odds are the Loom's alone; the Narrator sees an objective, not a bet.
        { badge: isNarrator ? '' : `${Number(goal.successRate)}%` },
    ));
    const variableItems = variables.map((variable) => renderArchiveItem(
        variable.name,
        escapeHtml(String(variable.value)),
    ));
    const secretItems = secrets.map((secret) => renderArchiveItem(secret.key, escapeHtml(String(secret.value)), {
        recordId: `secret:${secret.key}`, editable, deletable: editable, editValue: String(secret.value), ...scope,
    }));

    const sections = [
        renderArchiveSection('What happened', 'fa-clock-rotate-left', eventItems, 'Nothing recorded yet.'),
        renderArchiveSection('Scene', 'fa-map-pin', factItems, 'No scene facts yet.'),
        renderArchiveSection('Characters', 'fa-users', charItems, 'No character states yet.'),
        renderArchiveSection(isNarrator ? 'Objectives' : 'Goals', 'fa-bullseye', goalItems, 'No goals yet.'),
        // Loom-only sections — the numbers and the hidden truths.
        ...(isNarrator ? [] : [renderArchiveSection('Variables', 'fa-sliders', variableItems, 'No variables yet.')]),
        ...(isNarrator ? [] : [renderArchiveSection('Secrets', 'fa-lock', secretItems, 'No secrets kept.', { tone: 'is-secret' })]),
    ].join('');

    return `<section class="remodel-notebook remodel-archive" aria-label="Loom's Archive">
        ${closeButton}
        ${head}
        <div class="remodel-notebook-controls">
            <label class="remodel-notebook-scene-picker">
                <span>Scene</span>
                <select data-remodel-timeline-field="archive-scene" data-timeline-id="${escapeAttribute(timeline.id)}">
                    ${scenes.map((scene) => `<option value="${escapeAttribute(scene.id)}" ${scene.id === activeSceneId ? 'selected' : ''}>${escapeHtml(scene.title)}</option>`).join('')}
                </select>
            </label>
            ${renderArchiveViewToggle()}
        </div>
        <div class="remodel-archive-sections">
            ${sections}
        </div>
    </section>`;
}

function renderArcIndex(timeline, store, activeArc) {
    const arcButtons = timeline.arcIds.map((arcId, index) => {
        const arc = store.arcs[arcId];
        if (!arc) return '';

        const active = arc.id === activeArc?.id;
        return `
            <button
                type="button"
                class="remodel-route-arc-index-item ${active ? 'is-active' : ''}"
                title="Arc ${toRoman(index + 1)}: ${escapeAttribute(arc.title)}"
                aria-label="Open Arc ${toRoman(index + 1)}: ${escapeAttribute(arc.title)}"
                aria-current="${active ? 'true' : 'false'}"
                data-remodel-timeline-action="select-arc"
                data-arc-id="${escapeAttribute(arc.id)}"
            >
                <span class="remodel-route-arc-index-name">${toRoman(index + 1)} &middot; ${escapeHtml(arc.title)}</span>
                <span class="remodel-route-arc-index-tick" aria-hidden="true"></span>
            </button>
        `;
    }).join('');

    return `
        <nav class="remodel-route-arc-index" aria-label="Timeline arcs">
            <div class="remodel-route-arc-index-list">
                ${arcButtons}
            </div>
            <button
                type="button"
                class="remodel-route-arc-index-add"
                title="Add arc"
                aria-label="Add arc"
                data-remodel-timeline-action="create-arc"
                data-timeline-id="${escapeAttribute(timeline.id)}"
            ><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
        </nav>
    `;
}

function renderEmptyArcStage(timeline) {
    return `
        <div class="remodel-route-empty-arc">
            <span class="remodel-route-empty-symbol"><i class="fa-solid fa-route" aria-hidden="true"></i></span>
            <div>
                <div class="remodel-route-kicker">No chapters yet</div>
                <h2>Begin the first arc</h2>
                <p>Arcs hold the Roleplay and Story scenes that make up this route.</p>
            </div>
            <button type="button" data-remodel-timeline-action="create-arc" data-timeline-id="${escapeAttribute(timeline.id)}">
                <i class="fa-solid fa-plus" aria-hidden="true"></i>
                Create Arc
            </button>
        </div>
    `;
}

function renderActiveArc(arc, timeline, store) {
    const sceneCards = arc.sceneIds
        .map((sceneId, index) => renderRouteScene(store.scenes[sceneId], timeline, index + 1))
        .join('');

    return `
        <header class="remodel-route-arc-head">
            <div class="remodel-route-arc-heading">
                <input
                    type="text"
                    class="remodel-route-arc-title"
                    value="${escapeAttribute(arc.title)}"
                    data-remodel-timeline-field="arc-title"
                    data-arc-id="${escapeAttribute(arc.id)}"
                    aria-label="Arc title"
                >
            </div>
            <div class="remodel-route-arc-actions">
                <button type="button" data-remodel-timeline-action="create-scene" data-mode="roleplay" data-arc-id="${escapeAttribute(arc.id)}">
                    <i class="fa-solid fa-masks-theater" aria-hidden="true"></i>
                    Roleplay Scene
                </button>
                <button type="button" data-remodel-timeline-action="create-scene" data-mode="story" data-arc-id="${escapeAttribute(arc.id)}">
                    <i class="fa-solid fa-feather-pointed" aria-hidden="true"></i>
                    Story Scene
                </button>
                <button type="button" class="danger" title="Delete arc" aria-label="Delete arc" data-remodel-timeline-action="delete-arc" data-arc-id="${escapeAttribute(arc.id)}">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                </button>
            </div>
        </header>
        <div class="remodel-route-arc-summary-reveal">
            <label class="remodel-route-arc-summary">
                <span>Arc synopsis</span>
                <textarea
                    rows="${estimateTextareaRows(arc.summary, 104, 2)}"
                    placeholder="Describe the conflict, turning point, or promise of this arc..."
                    data-remodel-timeline-field="arc-summary"
                    data-arc-id="${escapeAttribute(arc.id)}"
                >${escapeHtml(arc.summary || '')}</textarea>
            </label>
        </div>
        <div class="remodel-route-scenes-head">
            <div>
                <span>Scene Record</span>
                <strong>${arc.sceneIds.length} Scene${arc.sceneIds.length === 1 ? '' : 's'}</strong>
            </div>
            <small>Select a scene to mark it current; open it to enter the writing view.</small>
        </div>
        <div class="remodel-route-scenes ${arc.sceneIds.length ? '' : 'is-empty'}">
            ${sceneCards || `
                <div class="remodel-route-scenes-empty">
                    <i class="fa-regular fa-compass" aria-hidden="true"></i>
                    <p>This arc is waiting for its first scene.</p>
                    <div>
                        <button type="button" data-remodel-timeline-action="create-scene" data-mode="roleplay" data-arc-id="${escapeAttribute(arc.id)}">+ Roleplay</button>
                        <button type="button" data-remodel-timeline-action="create-scene" data-mode="story" data-arc-id="${escapeAttribute(arc.id)}">+ Story</button>
                    </div>
                </div>
            `}
        </div>
    `;
}

function renderRouteScene(scene, timeline, order) {
    if (!scene) return '';

    const isActive = timeline.activeSceneId === scene.id;
    const isRenaming = scene.id === getSessionState().renamingSceneId;
    const bindingLabel = getLinkedChatLabel(scene);
    const summary = String(scene.summary || '').trim();
    const titleMarkup = isRenaming
        ? `<input type="text" class="remodel-scene-rename-input" value="${escapeAttribute(scene.title)}" data-scene-id="${escapeAttribute(scene.id)}" aria-label="Scene name">`
        : `<span class="remodel-route-scene-title">${escapeHtml(scene.title)}</span>`;
    const selectOpen = isRenaming
        ? '<div class="remodel-route-scene-select is-renaming">'
        : `<button type="button" class="remodel-route-scene-select" data-remodel-timeline-action="select-scene" data-scene-id="${escapeAttribute(scene.id)}" aria-label="Select ${escapeAttribute(scene.title)}">`;
    const selectClose = isRenaming ? '</div>' : '</button>';

    return `
        <article class="remodel-route-scene ${isActive ? 'is-active' : ''} ${scene.status === 'missing' ? 'is-missing' : ''}">
            ${selectOpen}
                <span class="remodel-route-scene-index">${String(order).padStart(2, '0')}</span>
                <span class="remodel-route-scene-copy">
                    <span class="remodel-route-scene-heading">
                        ${titleMarkup}
                        <span class="remodel-mode-pill ${escapeAttribute(scene.mode)}">${escapeHtml(scene.mode)}</span>
                    </span>
                    <span class="remodel-route-scene-binding">${escapeHtml(bindingLabel)}</span>
                    <span class="remodel-route-scene-summary ${summary ? '' : 'is-empty'}">${escapeHtml(summary || 'No scene summary yet. Open this scene to write, then return here to see its synopsis.')}</span>
                </span>
            ${selectClose}
            <div class="remodel-route-scene-actions">
                <button type="button" title="Rename scene" aria-label="Rename scene" data-remodel-timeline-action="rename-scene" data-scene-id="${escapeAttribute(scene.id)}">
                    <i class="fa-solid fa-pen" aria-hidden="true"></i>
                </button>
                <button type="button" title="Open scene" aria-label="Open scene" data-remodel-timeline-action="open-scene" data-scene-id="${escapeAttribute(scene.id)}">
                    <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>
                </button>
                <button type="button" class="danger" title="Delete scene" aria-label="Delete scene" data-remodel-timeline-action="delete-scene" data-scene-id="${escapeAttribute(scene.id)}">
                    <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
                </button>
            </div>
        </article>
    `;
}

function estimateTextareaRows(value, charactersPerLine, minimumRows) {
    const text = String(value || '');
    const rows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
    return Math.max(minimumRows, rows);
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

function setRemodeledLorebooksGlobalLabel(panel) {
    const label = panel?.querySelector('#WIMultiSelector .range-block-title small');
    if (!(label instanceof HTMLElement)) return;
    if (!label.dataset.remodelOriginalLorebooksLabel) {
        label.dataset.remodelOriginalLorebooksLabel = label.textContent || 'Active World(s) for all chats';
        label.dataset.remodelOriginalLorebooksI18n = label.getAttribute('data-i18n') || '';
    }
    label.textContent = 'Active Lorebooks for Roleplay & Story';
    label.removeAttribute('data-i18n');
}

function restoreNativeLorebooksGlobalLabel(panel) {
    const label = panel?.querySelector('#WIMultiSelector .range-block-title small');
    if (!(label instanceof HTMLElement) || !label.dataset.remodelOriginalLorebooksLabel) return;
    label.textContent = label.dataset.remodelOriginalLorebooksLabel;
    const i18n = label.dataset.remodelOriginalLorebooksI18n;
    if (i18n) label.setAttribute('data-i18n', i18n);
    else label.removeAttribute('data-i18n');
    delete label.dataset.remodelOriginalLorebooksLabel;
    delete label.dataset.remodelOriginalLorebooksI18n;
}

function attachLorebooksWorkspaceAdapter(panel) {
    syncLorebooksWorkspaceMeta(panel);
    setRemodeledLorebooksGlobalLabel(panel);
    decorateLorebookVariableLinks(panel);
    // Entry names and the attach picker come from an async read; warm it, then
    // repaint so links render as titles rather than as raw book/uid pairs.
    refreshVariableLore().then(() => decorateLorebookVariableLinks(panel));

    if (panel.dataset.remodelLorebooksAdapterBound === 'true') {
        return;
    }

    const select = panel.querySelector('#world_editor_select');
    if (select) {
        $(select).off('change.remodelLorebooks').on('change.remodelLorebooks', () => { syncLorebooksWorkspaceMeta(panel); decorateLorebookVariableLinks(panel); });
    }
    const observer = new MutationObserver(() => decorateLorebookVariableLinks(panel));
    const entries = panel.querySelector('#world_popup_entries_list');
    if (entries) observer.observe(entries, { childList: true, subtree: true });
    panel.dataset.remodelLorebooksAdapterBound = 'true';
}

/**
 * The exact name of the book currently open in native's editor.
 *
 * Neither obvious source is safe on its own. The option's VALUE is a numeric
 * index, not a name — using it keys lookups as "4.0". Its TEXT is not the name
 * either: HTMLOptionElement.text is specified to return the child text
 * *stripped and collapsed*, so a book actually called "TEST  The Box" (two
 * spaces) reports as "TEST The Box" and never matches a stored link.
 *
 * The value is an index into getWorldInfoNames(), which is the same list the
 * Variables lore layer enumerates, so that is the primary lookup. The collapsed
 * text is kept only as a fallback for the case where the two lists drift.
 */
function selectedLorebookName(select) {
    if (!select) return '';
    let names = [];
    try {
        names = getContext().getWorldInfoNames() || [];
    } catch {
        names = [];
    }
    const byIndex = names[Number(select.value)];
    if (typeof byIndex === 'string') return byIndex;
    const label = select.options?.[select.selectedIndex]?.text?.trim() || '';
    const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();
    return names.find((name) => collapse(name) === collapse(label)) || '';
}

// Marks lorebook entries that Variables are attached to. The count is re-read on
// every pass rather than guarded by presence, so an entry that gains or loses a
// Variable does not keep a stale badge. Entries with no Variables carry no badge
// at all — attaching happens inside the expanded entry, not from this row.
function decorateLorebookVariableLinks(panel) {
    const select = panel.querySelector('#world_editor_select');
    const book = selectedLorebookName(select);
    if (!book) return;
    const timelineId = getTimelineStore().activeTimelineId || '';
    panel.querySelectorAll('#world_popup_entries_list .world_entry').forEach((entry) => {
        if (!(entry instanceof HTMLElement)) return;
        const uidNode = entry.matches('[data-uid]') ? entry : entry.querySelector('[data-uid]');
        const uid = entry.dataset.uid || uidNode?.getAttribute('data-uid') || entry.getAttribute('uid');
        if (uid == null || uid === '') return;
        const linked = listVariablesForLoreRef({ book, uid }, { timelineId });
        let badge = entry.querySelector('[data-remodel-variable-lore-link]');
        if (!linked.length) {
            badge?.remove();
            return;
        }
        if (!badge) {
            const anchor = entry.querySelector('.world_entry_form_control') || entry.querySelector('.world_entry_thin_controls') || entry;
            badge = document.createElement('span');
            badge.className = 'fa-solid fa-chart-simple remodel-variable-lore-link';
            badge.dataset.remodelVariableLoreLink = '';
            anchor.append(badge);
        }
        badge.dataset.book = book;
        badge.dataset.uid = String(uid);
        badge.dataset.linkedCount = String(linked.length);
        badge.title = `${linked.length} linked Variable${linked.length === 1 ? '' : 's'}: ${linked.map((variable) => variable.name).join(', ')}`;
    });
    decorateExpandedLorebookEntries(panel, book);
}

/**
 * Put the Linked Variables editor inside an expanded Lorebook entry.
 *
 * Native builds the expanded body lazily and destroys it again on collapse
 * (world-info.js getWorldEntry: `inline-drawer-toggle` → addEditorDrawerContent,
 * clearEntryList on close), so this cannot be a one-time injection. It re-runs
 * from the MutationObserver that already watches the entry list, and each
 * section is keyed to its entry so a rebuilt outlet gets a fresh one while an
 * untouched entry keeps the section the user is typing in.
 */
function decorateExpandedLorebookEntries(panel, book) {
    panel.querySelectorAll('#world_popup_entries_list .world_entry .inline-drawer-outlet').forEach((outlet) => {
        if (!(outlet instanceof HTMLElement) || !outlet.children.length) return;
        const entry = outlet.closest('.world_entry');
        const uidNode = entry?.matches('[data-uid]') ? entry : entry?.querySelector('[data-uid]');
        const uid = entry?.dataset.uid || uidNode?.getAttribute('data-uid') || entry?.getAttribute('uid');
        if (uid == null || uid === '') return;
        let section = outlet.querySelector('[data-remodel-varlink]');
        if (section && section.dataset.book === book && section.dataset.uid === String(uid)) return;
        if (!section) {
            section = document.createElement('div');
            section.className = 'remodel-varlink';
            section.dataset.remodelVarlink = '';
            outlet.append(section);
        }
        section.dataset.book = book;
        section.dataset.uid = String(uid);
        section.innerHTML = `<h5 class="remodel-varlink-title"><i class="fa-solid fa-chart-simple"></i> Linked Variables</h5>${renderLinkedVariablesSection({ book, uid: String(uid) })}`;
    });
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

    restoreNativeLorebooksGlobalLabel(panel);
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

async function enterSceneViewport(scene = getActiveScene()) {
    // Loading a chat (doNewChat/openCharacterChat/openGroupChat) incidentally flips
    // SillyTavern's native right-menu panel to the character-edit or group-chats
    // block as a side effect unrelated to us. Close that incidental panel directly.
    // Do NOT click rm_button_characters here: that is a real navigation action,
    // emits character_page_loaded, and opens the Characters workspace over the
    // Scene that was just selected. Native sidebar panels remain user-controlled
    // overlays; selecting a different Scene replaces the Scene underneath them.
    selectRightMenuWithAnimation(null);

    // Do not rely on CHAT_CHANGED to paint the selected Scene. Core correctly
    // skips that event when the requested Scene is backed by the chat that is
    // already loaded (a common StoryDoc -> Roleplay switch), but the workspace
    // still has to change. Make Scene selection authoritative even on that
    // no-op chat path, and leave the previous Scene mounted only as dormant DOM.
    syncStoryWorkspaceClass(scene);

    // Story and Roleplay scenes both just drop into plain native chat for now
    // — the dedicated Story Viewport (manuscript/adopted-chat screen) was
    // removed; scene.mode still exists as data for when that's rebuilt.
    await transitionToWindow({ kind: 'native' });

    if (scene?.mode === 'roleplay') {
        renderRoleplayScene();
    }
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
        // Never-opened Roleplay Scene. A Roleplay Scene is a Director and a
        // Narrator, so casting one is choosing those two seats rather than
        // assembling a group and assigning jobs to it afterwards.
        openRoleplayDuetPicker({
            sceneTitle: scene.title,
            onConfirm: (seats) => beginRoleplaySceneAsDuet(sceneId, seats),
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
        dismissProgrammaticGroupEditor();
        writeSceneMetadata(scene);
        updateScene(sceneId, { status: 'active' });
        if (scene.mode === 'story') {
            migrateLoadedLegacyStoryScene(sceneId);
            await openStoryDocScene(sceneId);
        } else {
            await enterSceneViewport(getScene(sceneId));
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
        await enterSceneViewport(getScene(sceneId));
    }
}

/**
 * Casts a fresh Roleplay Scene as a Director + Narrator pair.
 *
 * The native chat is still an ordinary group, because everything downstream —
 * World Info, swipes, generation, force_chid — is native group machinery and
 * stays that way. What changes is that the group has exactly two members with
 * fixed jobs: the Director card supplies directing doctrine to the hidden pass
 * and never speaks, and the Narrator card is the only visible performer.
 *
 * Both seats are written before the group is opened, so the Scene is already a
 * complete directed Scene the first time anything renders it — there is no
 * intermediate state where a two-card group has no assigned Director and could
 * be mistaken for an ordinary free-play group.
 */
async function beginRoleplaySceneAsDuet(sceneId, { directorAvatar, narratorAvatar } = {}) {
    const context = getContext();
    const scene = getScene(sceneId);
    if (!scene || !directorAvatar || !narratorAvatar || directorAvatar === narratorAvatar) {
        return;
    }
    const findCard = (avatar) => (context.characters || []).find((item) => item?.avatar === avatar) || null;
    const directorCard = findCard(directorAvatar);
    const narratorCard = findCard(narratorAvatar);
    if (!directorCard || !narratorCard) {
        return;
    }

    // Narrator first, Director muted. Directed generation always forces the
    // performer, so neither matters on that path — but a Scene switched to Free
    // play, a swipe, or any native path that reaches the group without
    // force_chid falls back to core's own activation over `enabledMembers`.
    // Muting the Director there is what makes "the Director never speaks" a
    // property of the group rather than a promise Remodel has to keep. It stays
    // a member, so its card is still read for directing doctrine, and
    // resolveDirector matches on the ref rather than on enabled membership.
    const groupId = await createRoleplayGroup([narratorAvatar, directorAvatar], scene.title, {
        disabledMembers: [directorAvatar],
    });
    if (!groupId) {
        return;
    }
    // Ids read back off the real group object — openGroupChat guards with a
    // strict === on id, so a stringified id silently fails and nothing opens.
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
    setSceneDuetSeats(sceneId, {
        directorRef: { kind: 'character', id: directorAvatar, label: directorCard.name },
        narratorRef: { kind: 'narrator', id: narratorAvatar, label: narratorCard.name },
    });

    setActiveScene(sceneId);
    await openGroupById(nativeGroupId);
    await waitForChatIdSettled();
    dismissProgrammaticGroupEditor();
    // A fresh group opens with both cards' greetings. In a directed Scene the
    // Director must never appear as a visible line, and the Narrator's opening
    // belongs to the Director's first movement, not to the card's own greeting.
    await clearFreshRoleplayGreetingMessages();
    writeSceneMetadata(getScene(sceneId));
    syncStoryWorkspaceClass(getScene(sceneId));
    await enterSceneViewport(getScene(sceneId));
}

// Casts a fresh roleplay scene from the picker's chosen characters. One
// character → a solo character chat (selectCharacterById + new chat, bound
// exactly like before). Two or more → a real group + a fresh group chat,
// bound to the scene. Either way the scene ends up with a linkedChat and
// drops into the viewport.
//
// Retained for Scenes cast before the two-seat model and for the "add a
// character" path, which promotes a solo chat into a group.
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
        await clearFreshRoleplayGreetingMessages();
        await enterSceneViewport(getScene(sceneId));
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
    dismissProgrammaticGroupEditor();
    await clearFreshRoleplayGreetingMessages();
    writeSceneMetadata(getScene(sceneId));
    // openGroupById's CHAT_CHANGED can land before the scene metadata write
    // settles, so set the workspace class directly here too (idempotent).
    syncStoryWorkspaceClass(getScene(sceneId));
    await enterSceneViewport(getScene(sceneId));
    renderRoleplayScene();
}

// Native solo and group chats begin by inserting each selected card's first
// message. That is correct for ordinary SillyTavern chats, but a freshly cast
// Remodel Scene has not begun yet: the Director should respond only after the
// user's first accepted action. This helper is called only during creation of a
// brand-new Scene chat, never while opening an existing chat.
async function clearFreshRoleplayGreetingMessages() {
    const context = getContext();
    if (!Array.isArray(context.chat) || context.chat.length === 0) return;
    if (context.chat.some((message) => message?.is_user)) return;
    context.chat.splice(0, context.chat.length);
    document.getElementById('chat')?.replaceChildren();
    await context.saveChat();
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
async function createRoleplayGroup(memberAvatars, name, { disabledMembers = [] } = {}) {
    const context = getContext();
    const members = Array.isArray(memberAvatars) ? memberAvatars.filter(Boolean) : [];
    if (members.length === 0) {
        return null;
    }
    const disabled = (Array.isArray(disabledMembers) ? disabledMembers : []).filter((avatar) => members.includes(avatar));

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
        disabled_members: disabled,
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

// The reverse of roleplayCharacterAvatar: a native character index from an
// avatar filename. Returns null when the card is not loaded, which callers
// must treat as "no native index" rather than coercing to a number — core
// reads force_chid with `typeof … == 'number'`, and NaN passes that test.
function roleplayCharacterIdForAvatar(avatar) {
    if (!avatar) {
        return null;
    }
    const index = (getContext().characters || []).findIndex((item) => item?.avatar === avatar);
    return index >= 0 ? index : null;
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
    dismissProgrammaticGroupEditor();
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
const ROLEPLAY_DUET_PICKER_ID = 'remodel-rp-duet-picker';

/**
 * Casts a Roleplay Scene by filling two named seats.
 *
 * Deliberately not a multi-select: the two jobs are not interchangeable, and a
 * flat "pick your cast" grid cannot express which card directs and which one
 * speaks. The active seat is the one being filled; clicking a card fills it and
 * advances. A card already holding the other seat is shown as taken rather than
 * hidden, so swapping the two is one click rather than a reset.
 *
 * onConfirm: ({ directorAvatar, narratorAvatar }) => void
 */
function openRoleplayDuetPicker({ sceneTitle = '', onConfirm } = {}) {
    document.getElementById(ROLEPLAY_DUET_PICKER_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = ROLEPLAY_DUET_PICKER_ID;
    overlay.className = 'remodel-rp-picker-scrim';
    overlay._remodelDuet = { seat: 'narrator', directorAvatar: '', narratorAvatar: '', onConfirm };

    overlay.innerHTML = `
        <div class="remodel-rp-picker remodel-rp-duet" role="dialog" aria-modal="true" data-remodel-rp-picker-stop>
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">Cast ${sceneTitle ? escapeHtml(sceneTitle) : 'this scene'}</div>
                    <div class="remodel-rp-picker-hint">A Roleplay Scene is two cards. The Narrator performs every visible line; the Director decides what happens and never speaks.</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-rp-duet-cancel aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-duet-seats" data-remodel-rp-duet-seats></div>
            <input type="text" class="remodel-rp-picker-search" data-remodel-rp-duet-search placeholder="Search characters…" spellcheck="false" />
            <div class="remodel-rp-picker-grid" data-remodel-rp-duet-grid></div>
            <div class="remodel-rp-picker-foot">
                <span class="remodel-rp-picker-count" data-remodel-rp-duet-status></span>
                <div class="remodel-rp-picker-actions">
                    <button type="button" class="remodel-rp-picker-btn" data-remodel-rp-duet-cancel>Cancel</button>
                    <button type="button" class="remodel-rp-picker-btn remodel-rp-picker-go" data-remodel-rp-duet-confirm disabled>Begin scene</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    renderRoleplayDuetPicker(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));
    overlay.querySelector('[data-remodel-rp-duet-search]')?.focus();
}

const ROLEPLAY_DUET_SEATS = Object.freeze([
    {
        key: 'narrator',
        field: 'narratorAvatar',
        label: 'Narrator',
        icon: 'fa-microphone-lines',
        blurb: 'Writes every visible line',
        empty: 'Choose who tells this story',
    },
    {
        key: 'director',
        field: 'directorAvatar',
        label: 'Director',
        icon: 'fa-clapperboard',
        blurb: 'Decides cause and consequence, unseen',
        empty: 'Choose who directs it',
    },
]);

function renderRoleplayDuetPicker(overlay) {
    const state = overlay._remodelDuet;
    const context = getContext();
    const characters = (context.characters || []).filter((item) => item?.avatar && item.avatar !== 'none');
    const byAvatar = new Map(characters.map((item) => [item.avatar, item]));

    const seats = overlay.querySelector('[data-remodel-rp-duet-seats]');
    if (seats) {
        seats.innerHTML = ROLEPLAY_DUET_SEATS.map((seat) => {
            const avatar = state[seat.field];
            const card = avatar ? byAvatar.get(avatar) : null;
            const thumb = card ? context.getThumbnailUrl('avatar', card.avatar) : '';
            const active = state.seat === seat.key;
            return `
                <button type="button" class="remodel-rp-duet-seat${active ? ' is-active' : ''}${card ? ' is-filled' : ''}"
                        data-remodel-rp-duet-seat="${escapeAttribute(seat.key)}"
                        aria-pressed="${active}">
                    <span class="remodel-rp-duet-seat-av" ${thumb ? `style="background-image:url('${escapeAttribute(thumb)}')"` : ''}>${card ? '' : '<i class="fa-solid fa-plus" aria-hidden="true"></i>'}</span>
                    <span class="remodel-rp-duet-seat-text">
                        <span class="remodel-rp-duet-seat-role"><i class="fa-solid ${seat.icon}" aria-hidden="true"></i>${escapeHtml(seat.label)}</span>
                        <span class="remodel-rp-duet-seat-name">${card ? escapeHtml(card.name) : escapeHtml(seat.empty)}</span>
                        <span class="remodel-rp-duet-seat-blurb">${escapeHtml(seat.blurb)}</span>
                    </span>
                </button>`;
        }).join('');
    }

    const grid = overlay.querySelector('[data-remodel-rp-duet-grid]');
    if (grid) {
        const activeSeat = ROLEPLAY_DUET_SEATS.find((seat) => seat.key === state.seat) || ROLEPLAY_DUET_SEATS[0];
        const otherSeat = ROLEPLAY_DUET_SEATS.find((seat) => seat.key !== state.seat);
        grid.innerHTML = characters.map((card) => {
            const thumb = context.getThumbnailUrl('avatar', card.avatar);
            const isChosen = state[activeSeat.field] === card.avatar;
            // Held by the OTHER seat. Shown, not hidden: clicking it swaps the
            // two, which is the most common correction.
            const isTaken = otherSeat && state[otherSeat.field] === card.avatar;
            return `
                <button type="button" class="remodel-rp-picker-card${isChosen ? ' remodel-rp-picked' : ''}${isTaken ? ' remodel-rp-duet-taken' : ''}"
                        data-remodel-rp-duet-pick="${escapeAttribute(card.avatar)}"
                        title="${escapeAttribute(isTaken ? `${card.name} — currently the ${otherSeat.label}; choosing here swaps the seats` : card.name)}">
                    <span class="remodel-rp-picker-av" ${thumb ? `style="background-image:url('${escapeAttribute(thumb)}')"` : ''}>${thumb ? '' : escapeHtml(roleplayInitials(card.name))}</span>
                    <span class="remodel-rp-picker-name">${escapeHtml(card.name)}</span>
                    ${isTaken ? `<span class="remodel-rp-duet-taken-tag">${escapeHtml(otherSeat.label)}</span>` : '<span class="remodel-rp-picker-check" aria-hidden="true">✓</span>'}
                </button>`;
        }).join('') || '<div class="remodel-rp-picker-empty">No characters available.</div>';
    }

    const ready = Boolean(state.directorAvatar && state.narratorAvatar);
    const status = overlay.querySelector('[data-remodel-rp-duet-status]');
    if (status) {
        const activeSeat = ROLEPLAY_DUET_SEATS.find((seat) => seat.key === state.seat);
        status.textContent = ready
            ? 'Both seats filled'
            : `Choosing the ${activeSeat?.label || 'Narrator'}`;
    }
    const confirm = overlay.querySelector('[data-remodel-rp-duet-confirm]');
    if (confirm) confirm.toggleAttribute('disabled', !ready);

    // Re-apply the live filter so re-rendering the grid does not undo a search.
    const search = overlay.querySelector('[data-remodel-rp-duet-search]');
    if (search instanceof HTMLInputElement && search.value.trim()) filterRoleplayDuetGrid(overlay, search.value);
}

function filterRoleplayDuetGrid(overlay, query) {
    const needle = String(query || '').trim().toLowerCase();
    overlay.querySelectorAll('[data-remodel-rp-duet-pick]').forEach((card) => {
        const name = card.querySelector('.remodel-rp-picker-name')?.textContent?.toLowerCase() ?? '';
        card.style.display = !needle || name.includes(needle) ? '' : 'none';
    });
}

function closeRoleplayDuetPicker() {
    const overlay = document.getElementById(ROLEPLAY_DUET_PICKER_ID);
    if (!overlay) return;
    overlay.classList.remove('remodel-rp-picker-in');
    setTimeout(() => overlay.remove(), 200);
}

// One delegated listener set, bound once at init, gated on the picker existing.
function bindRoleplayDuetPickerEvents() {
    document.addEventListener('click', (event) => {
        const overlay = document.getElementById(ROLEPLAY_DUET_PICKER_ID);
        if (!overlay) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        if (target === overlay || target.closest('[data-remodel-rp-duet-cancel]')) {
            closeRoleplayDuetPicker();
            return;
        }

        const seatButton = target.closest('[data-remodel-rp-duet-seat]');
        if (seatButton) {
            overlay._remodelDuet.seat = seatButton.getAttribute('data-remodel-rp-duet-seat');
            renderRoleplayDuetPicker(overlay);
            return;
        }

        const card = target.closest('[data-remodel-rp-duet-pick]');
        if (card) {
            const avatar = card.getAttribute('data-remodel-rp-duet-pick');
            const state = overlay._remodelDuet;
            const activeSeat = ROLEPLAY_DUET_SEATS.find((seat) => seat.key === state.seat) || ROLEPLAY_DUET_SEATS[0];
            const otherSeat = ROLEPLAY_DUET_SEATS.find((seat) => seat.key !== activeSeat.key);
            // Picking the card the other seat holds swaps them, rather than
            // leaving the same card in both seats — which setSceneDuetSeats
            // would refuse anyway.
            if (otherSeat && state[otherSeat.field] === avatar) {
                state[otherSeat.field] = state[activeSeat.field];
            }
            state[activeSeat.field] = avatar;
            // Advance to the empty seat if there is one, so the common path is
            // two clicks with no seat-switching in between.
            const unfilled = ROLEPLAY_DUET_SEATS.find((seat) => !state[seat.field]);
            if (unfilled) state.seat = unfilled.key;
            renderRoleplayDuetPicker(overlay);
            return;
        }

        if (target.closest('[data-remodel-rp-duet-confirm]')) {
            const state = overlay._remodelDuet;
            if (!state.directorAvatar || !state.narratorAvatar) return;
            const seats = { directorAvatar: state.directorAvatar, narratorAvatar: state.narratorAvatar };
            const callback = state.onConfirm;
            closeRoleplayDuetPicker();
            callback?.(seats);
        }
    });

    document.addEventListener('input', (event) => {
        const overlay = document.getElementById(ROLEPLAY_DUET_PICKER_ID);
        if (!overlay) return;
        const search = event.target instanceof Element ? event.target.closest('[data-remodel-rp-duet-search]') : null;
        if (!(search instanceof HTMLInputElement)) return;
        filterRoleplayDuetGrid(overlay, search.value);
    });
}

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
    const previous = context.chatMetadata[CHAT_METADATA_KEY] || {};
    context.chatMetadata[CHAT_METADATA_KEY] = {
        timelineId: scene.timelineId,
        arcId: scene.arcId,
        sceneId: scene.id,
        mode: scene.mode,
        title: scene.title,
        linkedChat: scene.linkedChat,
        // What we last bound as this chat's lorebook. Carried forward so the
        // next pass can tell a book that is ours to move from one the user
        // chose by hand — see applyTimelineChatLorebook.
        managedLorebook: applyTimelineChatLorebook(scene, previous.managedLorebook || null),
        updatedAt: new Date().toISOString(),
    };
    context.saveMetadataDebounced();
}

/**
 * Make the Timeline's lorebook this chat's lorebook.
 *
 * `timeline.lorebookName` used to have exactly one consumer — story-world-info.js
 * — so a Timeline book did nothing whatsoever in Roleplay while the UI showed
 * it as bound. Chat lore is the only one of core's four bindings that resolves
 * without a selected character, which is what the Director's out-of-band scan
 * needs; the module header on chat-lorebook.js has the full reasoning.
 *
 * @returns {string|null} the book now under our management, for the metadata.
 */
function applyTimelineChatLorebook(scene, managedLorebook) {
    const context = getContext();
    const timeline = getTimelineStore().timelines[scene.timelineId];
    const result = resolveChatLorebook({
        timelineLorebook: timeline?.lorebookName || null,
        chatLorebook: context.chatMetadata[WORLD_INFO_METADATA_KEY] || null,
        managedLorebook,
        mode: scene.mode,
    });
    if (result.action === 'bind' || result.action === 'release') {
        // Written straight to the metadata key core reads (world-info.js's
        // METADATA_KEY), not through a setter: there is no exported one, and
        // getChatLore consults this key and nothing else.
        context.chatMetadata[WORLD_INFO_METADATA_KEY] = result.value;
    }
    if (result.action !== 'keep') {
        recordDebugEvent('direction', 'lorebook.chat', {
            sceneId: scene.id, action: result.action, reason: result.reason,
        }, { severity: result.action === 'refuse' ? 'warn' : 'info', summary: result.reason });
    }
    // Only a bind leaves something of ours behind. A refusal manages nothing,
    // and a release just gave up what it managed.
    return result.action === 'bind' ? result.value : (result.action === 'release' ? null : managedLorebook);
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
    setRoleplayCastOpen(getRealRoleplayRoot(), false);

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
    manuscriptSelection = null;
    document.body.classList.toggle('remodel-roleplay-workspace-active', enteringRoleplay);
    if (enteringRoleplay) document.getElementById('remodel-direction-failure')?.remove();

    if (enteringStoryDoc) {
        activeStoryDocId = scene.storyDocId;
        ensureStoryEditor();
        renderStoryEditor();
    } else {
        // The editor node is retained for cheap reopening, but it no longer
        // owns a document once another Scene type becomes authoritative.
        activeStoryDocId = null;
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

// openGroupById() selects the native Group Controls page as a side effect.
// Scene navigation uses it only to load the linked chat, never to ask the
// user to edit the group, so dismiss that page before exposing Roleplay.
function dismissProgrammaticGroupEditor() {
    const groupPanel = document.getElementById('rm_group_chats_block');
    if (groupPanel && getComputedStyle(groupPanel).display !== 'none') {
        selectRightMenuWithAnimation(null);
    }
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
    await enterSceneViewport(scene);
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
    await enterSceneViewport(getScene(sceneId));
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
    // Offsets from the document being closed mean nothing in the one being
    // opened — a stale selection would format the wrong sentence.
    manuscriptSelection = null;
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
                ${renderManuscriptRule()}
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
                <button type="button" data-remodel-storydoc-tool="state" title="Timeline State"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i><span>State</span></button>
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
    clearLegacyManuscriptTypography();
    syncManuscriptRuleControls();
    bindManuscriptRuleStick(editor);
    return editor;
}

// The Manuscript rule doubles as the format bar. It's the page's own header:
// sticky under the document header while you scroll, permanently open at the
// top of the manuscript, and collapsed behind the gear once it sticks (see
// bindManuscriptRuleStick).
function renderManuscriptRule() {
    const fonts = MANUSCRIPT_FONT_OPTIONS
        .map((option) => `<option value="${escapeAttribute(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');
    const sizes = MANUSCRIPT_SIZE_OPTIONS
        .map((size) => `<option value="${escapeAttribute(size)}">${escapeHtml(size.replace('px', ''))}</option>`)
        .join('');
    const marks = [['bold', 'fa-bold', 'Bold'], ['italic', 'fa-italic', 'Italic'], ['underline', 'fa-underline', 'Underline']]
        .map(([format, icon, label]) => `<button type="button" data-remodel-storydoc-format="${format}" title="${label}" aria-label="${label}" aria-pressed="false"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`)
        .join('');
    return `
        <div class="remodel-storydoc-page-rule is-format-open" data-remodel-storydoc-rule>
            <span class="remodel-storydoc-rule-label">Manuscript</span>
            <button type="button" class="remodel-storydoc-format-toggle" data-remodel-storydoc-format-toggle title="Formatting" aria-label="Formatting" aria-expanded="true">
                <i class="fa-solid fa-gear" aria-hidden="true"></i>
            </button>
            <span class="remodel-storydoc-rule-line" aria-hidden="true"></span>
            <div class="remodel-storydoc-format-bar" data-remodel-storydoc-format-bar>
                <span class="remodel-storydoc-format-scope" data-remodel-storydoc-format-scope>Whole manuscript</span>
                <select data-remodel-storydoc-font aria-label="Manuscript font" title="Font">${fonts}</select>
                <select data-remodel-storydoc-fontsize aria-label="Manuscript font size" title="Font size">${sizes}</select>
                <span class="remodel-storydoc-format-sep" aria-hidden="true"></span>
                ${marks}
            </div>
        </div>
    `;
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
    // This document's own face and size, re-applied on every open so opening
    // a second story never inherits the first one's typography.
    applyManuscriptTypography(doc);
    // Split the doc body into paragraphs (blank-line separated) rendered as
    // <p> blocks — a real document look, not one run-on block. Only rebuild
    // when the editor isn't focused (never fight the user's caret).
    if (force || (document.activeElement !== prose && !prose.contains(document.activeElement))) {
        renderProseParagraphs(prose, doc.body || '', doc.beats || [], doc.styleRuns || []);
    }
    syncManuscriptRuleControls();
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

// Renders plain text (paragraphs separated by blank lines) as <p> elements,
// with the doc's style runs painted back on as inline spans.
function renderProseParagraphs(prose, text, beats = [], styleRuns = []) {
    prose.textContent = '';
    let cursor = 0;
    const orderedBeats = [...beats].sort((a, b) => (a.position || 0) - (b.position || 0));
    for (const beat of orderedBeats) {
        const position = Math.max(cursor, Math.min(String(text).length, Number(beat.position) || 0));
        appendStoryParagraphs(prose, String(text).slice(cursor, position), cursor, styleRuns);
        prose.appendChild(buildStoryDocBeat(beat));
        cursor = position;
    }
    appendStoryParagraphs(prose, String(text).slice(cursor), cursor, styleRuns);
    if (!prose.lastElementChild || prose.lastElementChild.matches('[data-remodel-storydoc-beat-id]')) {
        const paragraph = document.createElement('p');
        paragraph.contentEditable = 'true';
        paragraph.className = 'remodel-storydoc-writing-tail';
        paragraph.appendChild(document.createElement('br'));
        prose.appendChild(paragraph);
    }
}

// `base` is the slice's absolute offset in the doc body — style runs are
// stored in body coordinates, so paragraph boundaries have to be tracked
// exactly (hence walking the separators rather than a plain split()).
function appendStoryParagraphs(prose, text, base = 0, styleRuns = []) {
    if (!text) return;
    const source = String(text);
    const separator = /\n{2,}/g;
    const bounds = [];
    let start = 0;
    let match;
    while ((match = separator.exec(source)) !== null) {
        bounds.push([start, match.index]);
        start = match.index + match[0].length;
    }
    bounds.push([start, source.length]);
    for (const [from, to] of bounds) {
        const p = document.createElement('p');
        p.contentEditable = 'true';
        appendStyledText(p, source.slice(from, to), base + from, styleRuns);
        prose.appendChild(p);
    }
}

// Splits one paragraph's text at every style-run boundary that falls inside
// it, wrapping the covered stretches in spans and leaving the rest as bare
// text nodes (so unformatted prose keeps exactly the DOM shape it had before
// style runs existed).
function appendStyledText(paragraph, text, base, styleRuns = []) {
    if (!text) {
        paragraph.textContent = '';
        return;
    }
    const end = base + text.length;
    const overlapping = (styleRuns || [])
        .filter((run) => run && run.end > base && run.start < end)
        .sort((a, b) => a.start - b.start);
    let cursor = base;
    for (const run of overlapping) {
        const from = Math.max(base, run.start);
        const to = Math.min(end, run.end);
        if (to <= cursor) continue;
        if (from > cursor) {
            paragraph.appendChild(document.createTextNode(text.slice(cursor - base, from - base)));
        }
        paragraph.appendChild(buildStyleRunSpan(text.slice(from - base, to - base), run));
        cursor = to;
    }
    if (cursor < end) {
        paragraph.appendChild(document.createTextNode(text.slice(cursor - base)));
    }
}

function buildStyleRunSpan(text, run) {
    const span = document.createElement('span');
    span.setAttribute('data-remodel-storydoc-run', '');
    // Assigned through CSSOM, never interpolated into markup: a stored font
    // value is arbitrary text and the browser drops anything it can't parse.
    if (run.font) span.style.fontFamily = run.font;
    if (run.size) span.style.fontSize = run.size;
    if (run.bold) span.style.fontWeight = '700';
    if (run.italic) span.style.fontStyle = 'italic';
    if (run.underline) span.style.textDecoration = 'underline';
    span.textContent = text;
    return span;
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

// Body text, beat positions and style runs all come out of the SAME walk —
// they're three views of one set of offsets, and computing them separately
// is how they'd drift. Runs are re-derived from the live DOM on every save
// rather than patched, so ordinary typing (which grows or splits the spans
// natively) keeps them aligned without any offset bookkeeping.
function readStoryEditorState(prose) {
    const doc = getStoryDoc(activeStoryDocId);
    let body = '';
    const positions = new Map();
    const styleRuns = [];
    for (const child of prose.children) {
        if (child.matches('[data-remodel-storydoc-beat-id]')) {
            positions.set(child.dataset.remodelStorydocBeatId, body.length);
            continue;
        }
        if (child.tagName !== 'P') continue;
        if (body) body += '\n\n';
        const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue || '';
            if (!text) continue;
            const span = node.parentElement?.closest('[data-remodel-storydoc-run]');
            if (span) {
                pushStyleRun(styleRuns, body.length, body.length + text.length, readStyleRunSpan(span));
            }
            body += text;
        }
    }
    const trimmed = body.trimEnd();
    return {
        body: trimmed,
        beats: (doc?.beats || []).map((beat) => positions.has(beat.id)
            ? { ...beat, position: positions.get(beat.id) }
            : beat),
        styleRuns: clampStyleRuns(styleRuns, trimmed.length),
    };
}

function readStyleRunSpan(span) {
    const style = {};
    if (span.style.fontFamily) style.font = span.style.fontFamily;
    if (span.style.fontSize) style.size = span.style.fontSize;
    if (span.style.fontWeight === '700' || span.style.fontWeight === 'bold') style.bold = true;
    if (span.style.fontStyle === 'italic') style.italic = true;
    if (span.style.textDecoration.includes('underline')) style.underline = true;
    return style;
}

// Appends a run, coalescing with the previous one when they touch and carry
// the same style — a paragraph re-read after typing is otherwise one run per
// text node.
function pushStyleRun(runs, start, end, style) {
    if (end <= start || !hasStyle(style)) return;
    const last = runs[runs.length - 1];
    if (last && last.end === start && sameStyle(last, style)) {
        last.end = end;
        return;
    }
    runs.push({ start, end, ...style });
}

function clampStyleRuns(runs, length) {
    return runs
        .map((run) => ({ ...run, start: Math.max(0, run.start), end: Math.min(length, run.end) }))
        .filter((run) => run.end > run.start);
}

function hasStyle(style) {
    return Boolean(style && (style.font || style.size || style.bold || style.italic || style.underline));
}

function sameStyle(a, b) {
    return (a.font || '') === (b.font || '')
        && (a.size || '') === (b.size || '')
        && Boolean(a.bold) === Boolean(b.bold)
        && Boolean(a.italic) === Boolean(b.italic)
        && Boolean(a.underline) === Boolean(b.underline);
}

// --- Manuscript format bar -------------------------------------------------
//
// The bar edits two different things, and the split is the whole feature:
// with NOTHING selected, font and size are a reading preference and move the
// entire manuscript (one body-level custom property, remembered in
// localStorage, never part of the story). With text SELECTED they're
// manuscript content and land in the doc's styleRuns. Bold/italic/underline
// are only ever the second kind, so they ask for a selection.
//
// The last manuscript selection is kept in body coordinates rather than as a
// live Range: clicking a <select> in the bar blurs the contenteditable, and
// character offsets survive that (and the re-render that follows) where a
// Range would not.
let manuscriptSelection = null;
let manuscriptStickFrame = 0;
let manuscriptScopeFlashTimer = null;

function getManuscriptRule() {
    return getRealStoryEditor()?.querySelector('[data-remodel-storydoc-rule]') || null;
}

function getManuscriptProse() {
    return getRealStoryEditor()?.querySelector('[data-remodel-storydoc-prose]') || null;
}

// Sticky rule: pinned under the document header once the manuscript scrolls
// past it. The pin is CSS (position:sticky); this only reports WHEN it
// happens, so the bar can collapse behind the gear while stuck and reopen on
// its own back at the top of the page.
function bindManuscriptRuleStick(editor) {
    const rule = editor.querySelector('[data-remodel-storydoc-rule]');
    const header = editor.querySelector('.remodel-storydoc-header');
    if (!rule || !header || editor.dataset.remodelRuleBound) {
        return;
    }
    editor.dataset.remodelRuleBound = '1';
    // The pinned bar parks INSIDE the document header's band — centred on the
    // same row as the back button, title and save state — rather than sitting
    // as a second bar underneath it. Measured while unstuck: once it sticks
    // the format controls collapse and its height changes, and feeding that
    // back into its own pin position would make the two states chase each
    // other.
    let pinnedTop = 0;
    const sync = () => {
        manuscriptStickFrame = 0;
        const headerHeight = Math.round(header.getBoundingClientRect().height) || 76;
        if (!rule.classList.contains('is-stuck')) {
            const ruleHeight = Math.round(rule.getBoundingClientRect().height) || 38;
            pinnedTop = Math.max(0, Math.round((headerHeight - ruleHeight) / 2));
            editor.style.setProperty('--remodel-storydoc-rule-top', `${pinnedTop}px`);
        }
        const offset = rule.getBoundingClientRect().top - editor.getBoundingClientRect().top;
        const stuck = offset <= pinnedTop + 0.5;
        if (stuck === rule.classList.contains('is-stuck')) {
            return;
        }
        rule.classList.toggle('is-stuck', stuck);
        setManuscriptFormatOpen(rule, !stuck);
    };
    const schedule = () => {
        if (manuscriptStickFrame) {
            return;
        }
        manuscriptStickFrame = requestAnimationFrame(sync);
    };
    editor.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    schedule();
}

function setManuscriptFormatOpen(rule, open) {
    rule.classList.toggle('is-format-open', open);
    rule.querySelector('[data-remodel-storydoc-format-toggle]')?.setAttribute('aria-expanded', String(open));
}

function toggleManuscriptFormatBar() {
    const rule = getManuscriptRule();
    if (rule) {
        setManuscriptFormatOpen(rule, !rule.classList.contains('is-format-open'));
    }
}

// --- selection tracking ----------------------------------------------------

function bindManuscriptSelectionTracking() {
    document.addEventListener('selectionchange', () => {
        if (!isRealStoryDocSceneActive()) {
            return;
        }
        const prose = getManuscriptProse();
        const selection = window.getSelection();
        if (!prose || !selection || selection.rangeCount === 0) {
            return;
        }
        const range = selection.getRangeAt(0);
        // Selections that leave the prose (a click into the bar itself) are
        // ignored rather than cleared — the button being clicked still needs
        // the manuscript selection it was aimed at.
        if (!prose.contains(range.startContainer) || !prose.contains(range.endContainer)) {
            return;
        }
        setManuscriptSelection(range.collapsed ? null : {
            start: storyProseOffset(prose, range.startContainer, range.startOffset),
            end: storyProseOffset(prose, range.endContainer, range.endOffset),
        });
    });
}

function setManuscriptSelection(next) {
    manuscriptSelection = next && Number.isFinite(next.start) && Number.isFinite(next.end) && next.end > next.start
        ? next
        : null;
    syncManuscriptRuleControls();
}

// Absolute offset of a DOM point inside the doc body — the same walk
// readStoryEditorState uses to build that body, so the two always agree.
function storyProseOffset(prose, node, offset) {
    if (!node || !prose.contains(node)) {
        return null;
    }
    if (node === prose) {
        // Boundary on the container itself, which is what a select-all
        // produces: count the paragraphs that end before the boundary index.
        let total = 0;
        for (const child of [...prose.childNodes].slice(0, offset)) {
            if (!(child instanceof Element) || child.tagName !== 'P') continue;
            if (total) total += 2;
            total += child.textContent.length;
        }
        return total;
    }
    let total = 0;
    for (const child of prose.children) {
        if (child.matches('[data-remodel-storydoc-beat-id]')) continue;
        if (child.tagName !== 'P') continue;
        if (total) total += 2;
        if (child === node || child.contains(node)) {
            return total + textLengthBefore(child, node, offset);
        }
        total += child.textContent.length;
    }
    return null;
}

function textLengthBefore(root, node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
        let total = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (text === node) {
                return total + Math.min(offset, (text.nodeValue || '').length);
            }
            total += (text.nodeValue || '').length;
        }
        return total;
    }
    let total = 0;
    for (const child of [...node.childNodes].slice(0, offset)) {
        total += child.textContent?.length || 0;
    }
    if (node === root || !node.parentNode) {
        return total;
    }
    return total + textLengthBefore(root, node.parentNode, [...node.parentNode.childNodes].indexOf(node));
}

// Inverse of storyProseOffset: the DOM point for a body offset, used to put
// the selection back after a re-render.
function storyProsePoint(prose, target) {
    let total = 0;
    for (const child of prose.children) {
        if (child.matches('[data-remodel-storydoc-beat-id]')) continue;
        if (child.tagName !== 'P') continue;
        if (total) total += 2;
        const length = child.textContent.length;
        if (target <= total + length) {
            let local = Math.max(0, target - total);
            const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                const size = (text.nodeValue || '').length;
                if (local <= size) {
                    return { node: text, offset: local };
                }
                local -= size;
            }
            return { node: child, offset: child.childNodes.length };
        }
        total += length;
    }
    const last = prose.lastElementChild;
    return last ? { node: last, offset: last.childNodes.length } : null;
}

function restoreStoryProseSelection(prose, start, end) {
    const from = storyProsePoint(prose, start);
    const to = storyProsePoint(prose, end);
    const selection = window.getSelection();
    if (!from || !to || !selection) {
        return;
    }
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    selection.removeAllRanges();
    selection.addRange(range);
}

// --- style runs ------------------------------------------------------------

// Rewrites the run list so [start,end) carries `patch` on top of whatever was
// already there. Boundary-sweep rather than in-place splicing: every existing
// edge plus the two new ones becomes a segment, each segment gets its
// covering run's style merged with the patch, and touching segments with an
// identical style are folded back together.
function mergeStyleRuns(runs, start, end, patch) {
    const points = new Set([start, end]);
    for (const run of runs) {
        points.add(run.start);
        points.add(run.end);
    }
    const ordered = [...points].sort((a, b) => a - b);
    const merged = [];
    for (let index = 0; index < ordered.length - 1; index++) {
        const from = ordered[index];
        const to = ordered[index + 1];
        const covering = runs.find((run) => run.start <= from && run.end >= to);
        const inPatch = from >= start && to <= end;
        const style = pickStyle({ ...(covering || {}), ...(inPatch ? patch : {}) });
        if (!hasStyle(style)) {
            continue;
        }
        const last = merged[merged.length - 1];
        if (last && last.end === from && sameStyle(last, style)) {
            last.end = to;
            continue;
        }
        merged.push({ start: from, end: to, ...style });
    }
    return merged;
}

function pickStyle(value) {
    const style = {};
    if (value.font) style.font = value.font;
    if (value.size) style.size = value.size;
    if (value.bold) style.bold = true;
    if (value.italic) style.italic = true;
    if (value.underline) style.underline = true;
    return style;
}

// Shifts runs after an insertion point — the one place body text changes by
// splicing a string instead of by editing the DOM (insertStoryBeatProse).
function shiftStyleRuns(runs, position, length) {
    if (!length) {
        return runs || [];
    }
    return (runs || []).map((run) => ({
        ...run,
        start: run.start >= position ? run.start + length : run.start,
        end: run.end > position ? run.end + length : run.end,
    }));
}

// The style shared by the ENTIRE selection. A mark that only covers part of
// it reads as off, so the button turns it on for the whole range first —
// the behaviour every word processor has.
function manuscriptSelectionStyle() {
    const doc = getStoryDoc(activeStoryDocId);
    const selection = manuscriptSelection;
    const style = {};
    if (!doc || !selection) {
        return style;
    }
    const span = selection.end - selection.start;
    const runs = (doc.styleRuns || []).filter((run) => run.end > selection.start && run.start < selection.end);
    const coverage = (predicate) => runs
        .filter(predicate)
        .reduce((sum, run) => sum + (Math.min(run.end, selection.end) - Math.max(run.start, selection.start)), 0);
    for (const key of ['bold', 'italic', 'underline']) {
        if (coverage((run) => run[key]) >= span) {
            style[key] = true;
        }
    }
    for (const key of ['font', 'size']) {
        const values = new Set(runs.filter((run) => run[key]).map((run) => run[key]));
        if (values.size === 1 && coverage((run) => run[key]) >= span) {
            style[key] = [...values][0];
        }
    }
    return style;
}

// --- applying ---------------------------------------------------------------

function applyManuscriptSelectionStyle(patch) {
    const prose = getManuscriptProse();
    if (!prose || !activeStoryDocId || !manuscriptSelection) {
        return false;
    }
    // Beat the pending autosave to the document, then work from the state we
    // just read — the DOM is the truth for both text and existing runs.
    clearTimeout(storyEditorSaveTimer);
    const state = readStoryEditorState(prose);
    const start = Math.max(0, Math.min(state.body.length, manuscriptSelection.start));
    const end = Math.max(0, Math.min(state.body.length, manuscriptSelection.end));
    if (end <= start) {
        return false;
    }
    updateStoryDoc(activeStoryDocId, { ...state, styleRuns: mergeStyleRuns(state.styleRuns, start, end, patch) });
    setStorySaveState('Saved');
    renderStoryEditor(true);
    prose.focus({ preventScroll: true });
    restoreStoryProseSelection(prose, start, end);
    manuscriptSelection = { start, end };
    syncManuscriptRuleControls();
    return true;
}

function handleManuscriptMarkClick(format) {
    if (!manuscriptSelection) {
        flashManuscriptScope('Select text first');
        return;
    }
    applyManuscriptSelectionStyle({ [format]: !manuscriptSelectionStyle()[format] });
}

function handleManuscriptFontSelect(select) {
    if (manuscriptSelection) {
        applyManuscriptSelectionStyle({ font: select.value });
        return;
    }
    handleManuscriptFontChange(select);
}

function handleManuscriptSizeSelect(select) {
    if (manuscriptSelection) {
        applyManuscriptSelectionStyle({ size: select.value });
        return;
    }
    setManuscriptTypography({ fontSize: select.value });
}

// --- bar state -------------------------------------------------------------

function documentManuscriptFont() {
    return getStoryDoc(activeStoryDocId)?.font || MANUSCRIPT_FONT_OPTIONS[0].value;
}

function documentManuscriptSize() {
    return getStoryDoc(activeStoryDocId)?.fontSize || MANUSCRIPT_DEFAULT_SIZE;
}

function syncManuscriptRuleControls() {
    const rule = getManuscriptRule();
    if (!rule) {
        return;
    }
    const scoped = Boolean(manuscriptSelection);
    const style = manuscriptSelectionStyle();
    rule.classList.toggle('is-selection-scoped', scoped);
    const scope = rule.querySelector('[data-remodel-storydoc-format-scope]');
    if (scope && !scope.dataset.flash) {
        scope.textContent = scoped ? 'Selection' : 'Whole manuscript';
    }
    const font = rule.querySelector('[data-remodel-storydoc-font]');
    if (font) {
        font.value = matchingOptionValue(font, style.font || documentManuscriptFont());
    }
    const size = rule.querySelector('[data-remodel-storydoc-fontsize]');
    if (size) {
        size.value = matchingOptionValue(size, style.size || documentManuscriptSize());
    }
    for (const button of rule.querySelectorAll('[data-remodel-storydoc-format]')) {
        const active = Boolean(style[button.dataset.remodelStorydocFormat]);
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    }
}

function matchingOptionValue(select, value) {
    return [...select.options].some((option) => option.value === value) ? value : select.value;
}

function flashManuscriptScope(message) {
    const scope = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-format-scope]');
    if (!scope) {
        return;
    }
    scope.dataset.flash = '1';
    scope.textContent = message;
    clearTimeout(manuscriptScopeFlashTimer);
    manuscriptScopeFlashTimer = setTimeout(() => {
        delete scope.dataset.flash;
        syncManuscriptRuleControls();
    }, 2200);
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
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const font = target.closest('[data-remodel-storydoc-font]');
        if (font) {
            handleManuscriptFontSelect(font);
            return;
        }
        const size = target.closest('[data-remodel-storydoc-fontsize]');
        if (size) {
            handleManuscriptSizeSelect(size);
            return;
        }
        const title = target.closest('[data-remodel-storydoc-title]');
        if (!title || !activeStoryDocId) return;
        updateStoryDoc(activeStoryDocId, { title: title.value });
        setStorySaveState('Saved');
    });

    // Keep the manuscript selection alive across a toolbar click: without
    // this, mousedown on a button collapses the very selection the button is
    // about to format. (Selects are left alone — they need the mousedown to
    // open their popup.)
    document.addEventListener('mousedown', (event) => {
        if (!isRealStoryDocSceneActive()) return;
        const control = event.target instanceof Element
            ? event.target.closest('[data-remodel-storydoc-rule] [data-remodel-storydoc-format],[data-remodel-storydoc-format-toggle]')
            : null;
        if (control) event.preventDefault();
    });

    bindManuscriptSelectionTracking();

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
        if (previewOverlay) {
            // Same BY SOURCE / RAW PROMPT toggle the Roleplay preview's panels
            // use, reused rather than rebuilt — see setRoleplayPreviewView.
            // The Story modal has no tab panels of its own, so the overlay
            // itself stands in for the "panel" that function scopes its
            // lookups to.
            const viewButton = target.closest('[data-remodel-rp-preview-view]');
            if (viewButton && previewOverlay.contains(viewButton)) {
                event.preventDefault();
                setRoleplayPreviewView(previewOverlay, viewButton.dataset.remodelRpPreviewView);
                return;
            }
        }

        if (target.closest('[data-remodel-storydoc-format-toggle]')) {
            event.preventDefault();
            toggleManuscriptFormatBar();
            return;
        }
        // Scoped to the rule on purpose: the legacy "Manuscript toolbar"
        // panel reuses this attribute for its own markdown-wrapping buttons.
        const formatMark = target.closest('[data-remodel-storydoc-rule] [data-remodel-storydoc-format]');
        if (formatMark) {
            event.preventDefault();
            handleManuscriptMarkClick(formatMark.dataset.remodelStorydocFormat);
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
        autosizeStoryBeatInput(field);
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
    const isRegeneration = Boolean(beat.generatedText);
    if (isRegeneration) {
        const removed = removeGeneratedBeatText(doc, beat);
        updateStoryDoc(activeStoryDocId, {
            body: removed.body,
            beats: removed.beats.map((item) => item.id === beatId ? { ...item, generatedText: '' } : item),
        });
        renderStoryEditor(true);
    }
    await generateStory({ mode: isRegeneration ? 'regenerate' : 'beat', beat: beat.instruction, beatId });
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
    const instruction = card.querySelector('[data-remodel-storydoc-beat-instruction]');
    instruction.value = beat.instruction || '';
    // Size it to the text it already holds. The card is not in the document
    // yet, so scrollHeight is unavailable until it is attached — measure on the
    // next frame instead of reading zero here.
    requestAnimationFrame(() => autosizeStoryBeatInput(instruction));
    return card;
}

/**
 * Grow a Scene Beat field to fit its content.
 *
 * Beats are written as prose and are routinely several sentences long, so a
 * fixed 62px box hid most of what had been typed behind an inner scrollbar.
 * There is no upper clamp on purpose — unlike the roleplay composer, a beat is
 * a document element and should show the whole instruction.
 */
function autosizeStoryBeatInput(input) {
    if (!(input instanceof HTMLTextAreaElement)) {
        return;
    }
    input.style.height = 'auto';
    input.style.height = `${Math.max(input.scrollHeight, 62)}px`;
}

function setStorySaveState(label) {
    const el = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-save-state]');
    if (el) el.textContent = label;
}

const STORY_PREVIEW_ID = 'remodel-story-preview-modal';
const STUDIO_PREVIEW_ID = 'remodel-prompt-studio-preview-modal';

async function openPromptStudioSource(recipe, sourceKey) {
    if (sourceKey === 'storyGoals') {
        await transitionToWindow({ kind: 'native' });
        const scene = getActiveScene();
        if (scene?.mode === 'roleplay') {
            updateSceneGoalState(scene.id, { boardOpen: true }, { timelineId: scene.timelineId });
            requestAnimationFrame(() => renderRoleplayScene());
        }
        return;
    }
    if (['worldInfoBefore', 'worldInfoAfter', 'worldInfoExamples', 'worldInfoDepth'].includes(sourceKey)) {
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
            const request = getStoryPreviewRequest(doc);
            const assembled = await assembleStoryContext({ doc, ...request, dryRun: true });
            body.textContent = formatPromptStudioPreview(compilePromptRecipe(
                recipe,
                buildStoryPromptSources(doc, assembled, request),
                { includeUnresolved: true, macroOptions: assembled.macroOptions, outlets: assembled.outlets },
            ));
            populateStoryWorldInfoReport(
                overlay.querySelector('[data-remodel-prompt-studio-story-report]'),
                assembled,
            );
            if (assembled.diagnostics?.length) {
                warning.hidden = false;
                warning.textContent = assembled.diagnostics.join(' · ');
            }
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
            <details class="remodel-story-resolver-report" data-remodel-prompt-studio-story-report hidden><summary>World Info resolution</summary><pre></pre></details>
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

// Informational, not a fault: the compiled prompt below is exact for the beat
// text currently sitting in the composer. World Info activation is scored
// against that same text (resolveStoryWorldInfo's corpus scan reads doc+beat),
// so further edits the user makes before actually sending can change what
// activates — the one part of this preview that cannot be pinned down ahead
// of time. Mirrors DIRECTOR_RETRIEVAL_NOTE's treatment of the Director's own
// retrieval caveat: same neutral callout, same reasoning, a different source
// of drift. Always shown — unlike the diagnostics note below, this is not
// conditional on what happened to resolve, it is a property of every preview.
const STORY_WORLD_INFO_NOTE = '<p class="remodel-rp-preview-note">This compiles exactly for the beat text currently entered. World Info activation is scored from that same text, so further edits before you send can change what resolves.</p>';

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
                    <div class="remodel-rp-picker-hint">What the model will receive if you send now — nothing is sent.</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-storydoc-preview-close aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-preview-warn" data-remodel-storydoc-preview-warning hidden></div>
            <div class="remodel-rp-preview-note" data-remodel-storydoc-preview-diagnostics hidden></div>
            ${STORY_WORLD_INFO_NOTE}
            <details class="remodel-story-resolver-report" data-remodel-storydoc-preview-report hidden><summary>World Info resolution</summary><pre></pre></details>
            ${PREVIEW_VIEWS_MARKUP}
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));

    const body = overlay.querySelector('[data-remodel-rp-preview-body]');
    const doc = getStoryDoc(activeStoryDocId);
    if (!body || !doc) return;
    try {
        const request = getStoryPreviewRequest(doc);
        const assembled = await assembleStoryContext({ doc, ...request, dryRun: true });
        const recipe = getCurrentPromptStudioRecipe('story', getPromptApiType());
        const sources = buildStoryPromptSources(doc, assembled, request);
        const compiled = compilePromptRecipe(recipe, sources, { macroOptions: assembled.macroOptions, outlets: assembled.outlets, trace: true });
        body.textContent = formatPromptStudioPreview(compiled);
        populateStoryWorldInfoReport(overlay.querySelector('[data-remodel-storydoc-preview-report]'), assembled);

        // Same by-source treatment the Director tab gets, off the same trace
        // shape and the same renderer — see renderPromptTraceSections. Story
        // has no fallback-prompt path the way the Director does, so a trace
        // is always present here; the guard stays anyway rather than assuming
        // that instead of defending against an empty or malformed compile.
        const sourcesEl = overlay.querySelector('[data-remodel-rp-preview-sources]');
        const viewsEl = overlay.querySelector('[data-remodel-rp-preview-views]');
        if (Array.isArray(compiled.trace) && compiled.trace.length && sourcesEl && viewsEl) {
            sourcesEl.innerHTML = await renderPromptTraceSections(compiled.trace, compiled.messages);
            sourcesEl.hidden = false;
            viewsEl.hidden = false;
            body.hidden = true;
        }

        // assembled.diagnostics is the World Info resolver's own accounting of
        // how resolution went — an unbound character, a budget cut, a missing
        // lorebook — which is information, not a sign anything broke. Only
        // usedFallback (the whole context seam throwing) is a genuine fault,
        // so that is the only case that reaches the red box; everything else
        // gets the same neutral callout as STORY_WORLD_INFO_NOTE above.
        const warning = overlay.querySelector('[data-remodel-storydoc-preview-warning]');
        const note = overlay.querySelector('[data-remodel-storydoc-preview-diagnostics]');
        const target = assembled.usedFallback ? warning : note;
        if (target && assembled.diagnostics?.length) {
            target.hidden = false;
            target.textContent = assembled.diagnostics.join(' · ');
        }
    } catch (error) {
        body.textContent = `Could not assemble a preview.\n\n${String(error)}`;
    }
}

function getStoryPreviewRequest(doc) {
    const activeInput = document.activeElement instanceof HTMLTextAreaElement
        && document.activeElement.matches('[data-remodel-storydoc-beat-instruction]')
        ? document.activeElement
        : null;
    if (activeInput) {
        const beatId = activeInput.closest('[data-remodel-storydoc-beat-id]')?.dataset.remodelStorydocBeatId;
        const beat = doc?.beats?.find((item) => item.id === beatId);
        const instruction = activeInput.value.trim();
        if (instruction) return { mode: beat?.generatedText ? 'regenerate' : 'beat', beat: instruction };
    }
    const pendingBeat = getRealStoryEditor()?.querySelector('[data-remodel-storydoc-beat]')?.value?.trim() || '';
    return pendingBeat ? { mode: 'beat', beat: pendingBeat } : { mode: 'continue', beat: '' };
}

function populateStoryWorldInfoReport(element, assembled) {
    if (!(element instanceof HTMLDetailsElement)) return;
    const bookLines = Object.entries(assembled?.books || {})
        .flatMap(([source, names]) => (names || []).map((name) => `${source}: ${name}`));
    const entryLines = (assembled?.activatedEntries || [])
        .map((entry) => `${entry.world} #${entry.uid} · ${entry.title} → ${entry.destination || 'prompt'}`);
    const budget = assembled?.budget
        ? `${assembled.budget.used} / ${assembled.budget.maximum} tokens`
        : 'unavailable';
    const lines = [
        `Books\n${bookLines.length ? bookLines.join('\n') : '(none)'}`,
        `Activated entries\n${entryLines.length ? entryLines.join('\n') : '(none)'}`,
        `Budget\n${budget}`,
    ];
    if (assembled?.diagnostics?.length) lines.push(`Warnings\n${assembled.diagnostics.join('\n')}`);
    if (assembled?.notes?.length) lines.push(`Compatibility\n${assembled.notes.join('\n')}`);
    const pre = element.querySelector('pre');
    if (pre) pre.textContent = lines.join('\n\n');
    element.hidden = false;
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
    if (tool === 'state') {
        title.textContent = 'Timeline State';
        body.innerHTML = buildVariableStateBodyMarkup();
        // Lore is read asynchronously; repaint when it arrives.
        refreshVariableLore().then(refreshVariableStateSurfaces);
        return;
    }
    if (tool === 'guidance') {
        title.textContent = 'Author guidance';
        body.innerHTML = `<p class="remodel-storydoc-panel-copy">Set tone, point of view, pacing, boundaries, and the lorebook attached directly to this manuscript.</p><p class="remodel-storydoc-panel-copy">Lorebook keys scan the current Scene Beat first, then newest manuscript paragraphs and prior-scene text. Author Guidance joins only when enabled below. Generated prose becomes eligible on the next request.</p><label class="remodel-storydoc-field-label">Document lorebook<select data-remodel-storydoc-lorebook>${renderStoryLorebookOptions(doc)}</select></label><label class="remodel-storydoc-check"><input type="checkbox" data-remodel-storydoc-scan-guidance><span>Allow Author Guidance to activate lorebook entries</span></label><textarea data-remodel-storydoc-guidance placeholder="Example: Close third-person, restrained prose, slow-burn tension…"></textarea><p class="remodel-storydoc-panel-foot">Saved automatically · Timeline, global and character lorebooks stay active automatically · Persona lorebooks are not used in Story Scenes</p>`;
        const field = body.querySelector('[data-remodel-storydoc-guidance]');
        const lorebook = body.querySelector('[data-remodel-storydoc-lorebook]');
        const scanGuidance = body.querySelector('[data-remodel-storydoc-scan-guidance]');
        field.value = doc.guidance || '';
        lorebook.value = doc.lorebookName || '';
        scanGuidance.checked = Boolean(doc.scanGuidanceForLore);
        field.addEventListener('input', () => {
            updateStoryDoc(activeStoryDocId, { guidance: field.value });
            setStorySaveState('Saved');
        });
        lorebook.addEventListener('change', () => {
            updateStoryDoc(activeStoryDocId, { lorebookName: lorebook.value || null });
            setStorySaveState('Saved');
        });
        scanGuidance.addEventListener('change', () => {
            updateStoryDoc(activeStoryDocId, { scanGuidanceForLore: scanGuidance.checked });
            setStorySaveState('Saved');
        });
        return;
    }
    title.textContent = 'Generation context';
    body.innerHTML = '<p class="remodel-storydoc-panel-copy">Assembling the exact Story context…</p>';
    const assembled = await assembleStoryContext({ doc, mode: 'continue', dryRun: true });
    body.textContent = '';
    const bookSummary = Object.entries(assembled.books || {}).flatMap(([kind, names]) => (names || []).map((name) => `${kind}: ${name}`)).join('\n');
    const activationSummary = (assembled.activatedEntries || []).map((entry) => `${entry.world} #${entry.uid} · ${entry.title} → ${entry.destination || 'prompt'}`).join('\n');
    const scanSummary = [
        '1. Current Scene Beat — scanned for Beat and Regenerate requests',
        '2. Manuscript — newest paragraphs first',
        '3. Prior scene — loaded prose after the manuscript',
        `4. Author Guidance — ${doc.scanGuidanceForLore ? 'enabled' : 'disabled'}`,
        'Generated prose joins the manuscript scan on the next request.',
    ].join('\n');
    for (const [label, value] of [
        ['Character, persona & guidance', assembled.systemPrompt],
        ['Prior scene text', doc.priorText],
        ['Lorebook keyword scan', scanSummary],
        ['Resolved lorebook sources', bookSummary],
        ['Activated entries', activationSummary],
        ['World Info prompt content', assembled.contextBlock],
        ['Resolver notes', (assembled.diagnostics || []).join('\n')],
        ['Compatibility notes', (assembled.notes || []).join('\n')],
        ['Manuscript tail', (doc.body || '').slice(-12000)],
    ]) appendStoryPreviewSection(body, label, value);
}

function renderStoryLorebookOptions(doc) {
    const names = getStoryLorebookNames();
    const selected = String(doc?.lorebookName || '');
    const options = ['<option value="">No document-specific lorebook</option>'];
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeAttribute(selected)}">${escapeHtml(selected)} (unavailable)</option>`);
    }
    options.push(...names.map((name) => `<option value="${escapeAttribute(name)}">${escapeHtml(name)}</option>`));
    return options.join('');
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
        // Same budget rule as prose: a reasoning model pays for its thinking out
        // of this allowance, so a tight cap here produced a reply that was all
        // reasoning and no summary. The "concisely" instruction does the
        // shaping instead.
        const { text: summary } = await generateProse({
            systemPrompt: 'Summarize the supplied fiction scene concisely for continuity notes. Return only the summary.',
            prompt: doc.body.slice(-16000),
            responseLength: storyResponseLength(),
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
// THE ONE PLACE Story prompt sources are assembled. World Info resolution is
// explicit and document-scoped: it never borrows the active chat's character,
// metadata, extension prompts, or timed-effect state.
async function assembleStoryContext({ doc = getStoryDoc(activeStoryDocId), mode = 'continue', beat = '', dryRun = true } = {}) {
    const ctx = getContext();

    try {
        const chid = doc?.boundCharacterId == null ? null : Number(doc.boundCharacterId);
        const character = Number.isInteger(chid) ? ctx.characters?.[chid] : null;
        const wi = await resolveStoryWorldInfo({
            doc,
            mode,
            beat,
            maxContext: getStoryWorldInfoMaxContext(),
            dryRun,
            // The Timeline this Scene belongs to may bind a lorebook of its own,
            // shared by every Scene under it.
            timelineLorebook: getActiveTimelineLorebook(),
        });
        const macroOptions = wi.macroOptions;
        const resolve = (value) => ctx.substituteParams?.(String(value || ''), macroOptions) || String(value || '');
        const characterCard = resolve([
            ctx.powerUserSettings?.prefer_character_prompt ? character?.data?.system_prompt : '',
            character?.description,
            character?.personality,
            character?.scenario,
        ].filter(Boolean).join('\n\n'));
        // A Story document has no persona. The user is the AUTHOR here, not a
        // character inside the fiction — the bound character is a voice to
        // narrate with, not a partner being addressed. Injecting "who the user
        // is playing" only muddies the prose, so persona is deliberately empty
        // for stories. (Roleplay Scenes are untouched; they still use it.)
        const persona = '';
        const guidance = [wi.authorNoteBefore, resolve(doc?.guidance), wi.authorNoteAfter].filter(Boolean).join('\n\n');
        const systemPrompt = [
            'You are the prose engine inside a fiction manuscript editor. Write only the requested story prose. Continue naturally from the manuscript, preserve continuity and point of view, and do not explain your work.',
            characterCard,
            guidance,
        ].filter(Boolean).join('\n\n');
        const depthText = (wi.worldInfoDepth?.messages || []).map((message) => `[${message.role} · depth ${message.depth}]\n${message.content}`).join('\n');
        const contextBlock = [wi.worldInfoBefore, wi.worldInfoAfter, wi.worldInfoExamples, depthText].filter(Boolean).join('\n\n');
        return {
            systemPrompt,
            contextBlock,
            characterCard,
            persona,
            worldInfoBefore: wi.worldInfoBefore || '',
            worldInfoAfter: wi.worldInfoAfter || '',
            worldInfoExamples: wi.worldInfoExamples || '',
            worldInfoDepth: wi.worldInfoDepth || { messages: [] },
            authorGuidance: guidance,
            outlets: wi.outlets || {},
            activatedEntries: wi.activatedEntries || [],
            diagnostics: wi.diagnostics || [],
            // False here: everything below is the resolver's own accounting of
            // what it did (an unbound character, a budget cut, a missing
            // lorebook) — information about how resolution went, not a sign the
            // seam itself broke. See usedFallback: true below for the one case
            // that actually is a fault, and openStoryPromptPreview for where
            // this decides red-warn vs neutral-note.
            usedFallback: false,
            notes: wi.notes || [],
            books: wi.books || {},
            budget: wi.budget || null,
            pendingState: wi.pendingState,
            macroOptions: wi.macroOptions || macroOptions,
        };
    } catch (err) {
        console.warn('Remodel Story: isolated context seam failed — generating without WI/card context.', err);
        // Graceful fallback: the guidance field is ours (no core dependency),
        // so authorial steering still applies even if the core seam breaks.
        const macroOptions = { name1Override: ctx.name1 || 'User', name2Override: 'Character', replaceCharacterCard: false };
        const guidance = ctx.substituteParams?.(doc?.guidance || '', macroOptions) || doc?.guidance || '';
        return {
            systemPrompt: guidance,
            contextBlock: '',
            characterCard: '',
            persona: '',
            worldInfoBefore: '',
            worldInfoAfter: '',
            worldInfoExamples: '',
            worldInfoDepth: { messages: [] },
            authorGuidance: guidance,
            outlets: {},
            activatedEntries: [],
            diagnostics: [`Story World Info resolver failed: ${String(err?.message || err)}`],
            // True here, unlike the success path above: the whole World
            // Info/character seam threw, so the prompt being previewed is a
            // guidance-only degradation, not a normal resolution outcome.
            usedFallback: true,
            notes: [],
            books: {},
            budget: null,
            pendingState: doc?.worldInfoState,
            macroOptions,
        };
    }
}

function buildStoryPromptSources(doc, assembled, { mode = 'continue', beat = '' } = {}) {
    const body = doc?.body || '';
    const manuscript = body.length > 12000 ? body.slice(-12000) : body;
    const direction = mode !== 'continue' && beat.trim()
        ? `[Write the next part of the story following this scene beat: ${beat.trim()}]`
        : '[Continue the manuscript with the next passage.]';
    return {
        characterCard: assembled?.characterCard || '',
        persona: assembled?.persona || '',
        worldInfoBefore: assembled?.worldInfoBefore || '',
        worldInfoAfter: assembled?.worldInfoAfter || '',
        worldInfoExamples: assembled?.worldInfoExamples || '',
        worldInfoDepth: assembled?.worldInfoDepth || { messages: [] },
        authorGuidance: assembled?.authorGuidance || '',
        priorText: doc?.priorText ? `=== PRIOR SCENE TEXT ===\n${doc.priorText}` : '',
        manuscript,
        sceneBeat: direction,
    };
}

// How long a generated passage may be.
//
// This used to be hardcoded to 512 for every backend, which quietly broke
// reasoning models: reasoning tokens are spent from the SAME budget as the
// answer, so a thinking model burned the whole 512 before writing a word and
// returned a reply containing only a thinking block. Lowering "reasoning
// effort" does not reliably get under such a small cap, so it looked
// unfixable from the outside.
//
// The cap only ever existed to stop an anonymous Horde request becoming
// expensive, so it now applies to Horde alone. Everywhere else we honour the
// response length the user has already configured for their API — which also
// makes "raise the response length" real advice they can act on.
/**
 * Hover text for the Live Direction pill.
 *
 * States what is CURRENTLY on, first and plainly, then what clicking does.
 * The old title said only "Enable/Disable Live Direction", which describes the
 * action — so combined with a label that showed the run state, there was no way
 * to read the Scene's actual mode off the control.
 */
function liveModeTitle(ui) {
    if (!ui?.active) {
        return 'Live Direction is OFF. This Scene is on Free play: replies come straight from SillyTavern, with no directing pass and no paced reveal. Click to turn Live Direction on.';
    }
    const parts = ['Live Direction is ON. A hidden directing pass chooses the performer and paces the reply.'];
    if (ui.state) parts.push(`Right now: ${ui.state}.`);
    if (ui.performerLabel) parts.push(`Performer: ${ui.performerLabel}.`);
    parts.push('Click to switch this Scene back to Free play.');
    return parts.join(' ');
}

/** The lorebook bound to the Timeline that owns the active Scene, if any. */
function getActiveTimelineLorebook() {
    const scene = getActiveScene();
    if (!scene?.timelineId) {
        return null;
    }
    return getTimelineStore().timelines[scene.timelineId]?.lorebookName || null;
}

function storyResponseLength() {
    return getContext().mainApi === 'koboldhorde' ? 512 : null;
}

// True while a story generation is in flight, so the controls can flip to a
// Stop state and a second Continue can't stack.
let storyGenerating = false;
// Aborts an in-flight streamed Story generation. Null whenever nothing is
// streaming; Stop reaches the request through this.
let storyStreamAbort = null;

/**
 * A transient preview shown while prose streams in.
 *
 * Sits directly below the Scene Beat that asked for it (or at the end of the
 * manuscript for a plain continue), and carries a reasoning console that fills
 * in as the model thinks — the same generator supplies both, so the reasoning
 * costs nothing extra once the text is streaming.
 */
function openStoryStreamPreview(beatId) {
    const editor = getRealStoryEditor();
    const prose = editor?.querySelector('[data-remodel-storydoc-prose]');
    if (!prose) {
        return null;
    }
    const live = document.createElement('section');
    live.className = 'remodel-storydoc-stream';
    live.contentEditable = 'false';
    live.innerHTML = `
        <header><i class="fa-solid fa-feather-pointed"></i> Writing<span class="remodel-storydoc-stream-dots"><i></i><i></i><i></i></span></header>
        <div class="remodel-storydoc-stream-text" data-remodel-stream-text></div>
        <details class="remodel-storydoc-stream-reasoning" data-remodel-stream-reasoning hidden>
            <summary><i class="fa-solid fa-brain"></i> Reasoning</summary>
            <pre data-remodel-stream-reasoning-body></pre>
        </details>`;
    const anchor = beatId ? prose.querySelector(`[data-remodel-storydoc-beat-id="${CSS.escape(beatId)}"]`) : null;
    if (anchor) anchor.after(live);
    else prose.append(live);
    live.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return live;
}

function updateStoryStreamPreview(live, text, reasoning) {
    if (!live?.isConnected) {
        return;
    }
    const body = live.querySelector('[data-remodel-stream-text]');
    if (body) body.textContent = String(text || '');
    const panel = live.querySelector('[data-remodel-stream-reasoning]');
    const thoughts = String(reasoning || '').trim();
    if (panel) {
        // The panel only appears once the model actually reasons, so a
        // non-reasoning model shows no empty console.
        panel.hidden = !thoughts;
        const pre = panel.querySelector('[data-remodel-stream-reasoning-body]');
        if (pre && pre.textContent !== thoughts) {
            pre.textContent = thoughts;
            pre.scrollTop = pre.scrollHeight;
        }
    }
}

function closeStoryStreamPreview(live) {
    live?.remove();
}

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

    storyGenerating = true;
    setStoryGeneratingUI(true);

    try {
        const currentDoc = getStoryDoc(activeStoryDocId);
        const assembled = await assembleStoryContext({ doc: currentDoc, mode, beat, dryRun: false });
        const recipe = getCurrentPromptStudioRecipe('story', getPromptApiType());
        const prompt = compilePromptRecipe(
            recipe,
            buildStoryPromptSources(currentDoc, assembled, { mode, beat }),
            { macroOptions: assembled.macroOptions, outlets: assembled.outlets },
        ).messages;

        // The live region is a PREVIEW, deliberately separate from the
        // manuscript: streaming straight into the contenteditable would fight
        // autosave and the paragraph structure on every chunk. The finished
        // text still goes through the same insert path as before, so nothing
        // about persistence changes.
        storyStreamAbort = new AbortController();
        const live = openStoryStreamPreview(beatId);
        let prose = '';
        try {
            ({ text: prose } = await generateProse({
                prompt,
                responseLength: storyResponseLength(),
                instructOverride: false,
                signal: storyStreamAbort.signal,
                onStream: ({ text, reasoning }) => updateStoryStreamPreview(live, text, reasoning),
            }));
        } finally {
            closeStoryStreamPreview(live);
            storyStreamAbort = null;
        }

        if (beatId) insertStoryBeatProse(beatId, prose);
        else appendStoryProse(prose);
        updateStoryDoc(activeStoryDocId, { worldInfoState: advanceStoryWorldInfoState(assembled.pendingState) });
        renderStoryEditor(true);
        return true;
    } catch (err) {
        // GENERATION_STOPPED (user hit Stop) surfaces here as a thrown abort —
        // not an error to report.
        const msg = String(err?.message || err);
        if (!msg.match(/cancel|abort|stopped/i)) {
            console.error('Remodel Story: generation failed', err);
            // generateProse already worked out WHICH layer failed — an empty
            // prompt that never left the browser, a request the backend
            // rejected, or a reply that carried no prose — so report that
            // rather than a guess. The old code blamed the connection for all
            // three, which sent you looking in the wrong place.
            if (err?.name === 'StoryGenerationError') {
                console.error('Remodel Story: failure stage =', err.stage, '· detail =', err.detail);
                showStoryGenError(err.message);
            } else {
                showStoryGenError(`Generation failed — ${msg}`);
            }
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
    updateStoryDoc(activeStoryDocId, {
        body: `${prefix}${inserted}${suffix}`,
        beats,
        // Beat prose lands mid-document, so any formatting further down has
        // to move with it (beat positions above do the same thing).
        styleRuns: shiftStyleRuns(doc.styleRuns, position, inserted.length),
    });
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
let roleplayHoverMenuTimer = null;

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
    // source" discipline the manuscript overlay uses. The header identifies
    // the scene and owns the cast disclosure; the roster itself remains the
    // same functional cast component, now overlaid at its familiar left edge.
    root.innerHTML = `
        <header class="remodel-rp-scene-header">
            <button type="button" class="remodel-rp-scene-back" data-remodel-rp-scene-back title="Return to Tavern" aria-label="Return to Tavern">
                <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
            </button>
            <div class="remodel-rp-scene-heading">
                <span class="remodel-rp-scene-kicker">Roleplay scene</span>
                <strong class="remodel-rp-scene-title" data-remodel-rp-scene-title>Roleplay</strong>
                <button type="button" class="remodel-rp-cast-toggle" data-remodel-rp-cast-toggle aria-expanded="false" aria-controls="remodel-rp-cast-roster">
                    <i class="fa-solid fa-users" aria-hidden="true"></i>
                    <span class="remodel-rp-cast-toggle-copy">
                        <strong>Cast</strong>
                        <em data-remodel-rp-director-label>No Roleplay Director</em>
                    </span>
                    <small data-remodel-rp-cast-count>0</small>
                    <i class="fa-solid fa-chevron-down remodel-rp-cast-toggle-caret" aria-hidden="true"></i>
                </button>
            </div>
        </header>
        <aside id="remodel-rp-cast-roster" class="remodel-rp-cast" data-remodel-rp-cast aria-hidden="true"></aside>
        <div class="remodel-rp-stream" data-remodel-rp-stream></div>
        <div class="remodel-rp-composer-zone" data-remodel-rp-composer></div>
    `;
    chatEl.after(root);
    return root;
}

function setRoleplayCastOpen(root, open) {
    if (!root) return;
    const isOpen = Boolean(open);
    root.classList.toggle('is-cast-open', isOpen);
    root.querySelector('[data-remodel-rp-cast-toggle]')?.setAttribute('aria-expanded', String(isOpen));
    root.querySelector('[data-remodel-rp-cast]')?.setAttribute('aria-hidden', String(!isOpen));
}

function renderRoleplayHeader(root) {
    const scene = getActiveScene();
    const members = roleplaySceneMembers(getContext());
    const title = root.querySelector('[data-remodel-rp-scene-title]');
    const count = root.querySelector('[data-remodel-rp-cast-count]');
    const director = root.querySelector('[data-remodel-rp-director-label]');
    if (title) title.textContent = scene?.title || 'Roleplay';
    if (count) count.textContent = String(members.length);
    if (director) director.textContent = scene?.liveDirection?.directorRef?.label
        ? `Director: ${scene.liveDirection.directorRef.label}`
        : 'Choose a Roleplay Director';
}

// Builds the roleplay composer zone: a compact command dock above the persona
// input row. Rebuilt on each render so the "speak as" chip reflects the active
// persona. Sends drive
// core's real #send_textarea + #send_but underneath — the same reliable
// path the story composer uses — so generation, group activation, swipes,
// and World Info all run exactly as native.
function renderRoleplayComposer(root) {
    const zone = root.querySelector('[data-remodel-rp-composer]');
    if (!zone) {
        return;
    }
    const preservedDraft = zone.querySelector('[data-remodel-rp-input]')?.value || '';
    const context = getContext();
    const personaName = context.name1 || 'You';
    const activeScene = getActiveScene();
    const goalIntents = activeScene ? getStoryGoalComposerIntents(activeScene.id) : [];
    const attachedGoals = new Set(goalIntents.map((item) => item.goalId));
    const goalChips = activeScene ? getSceneGoals(activeScene.id, { includeResolved: false, states: ['active', 'background'] }) : [];
    const directionUi = getLiveDirectionUiState(activeScene);

    // Next speaker only means something in a group; in a solo scene there's
    // one character, so it's fixed to "AI decides" and not a menu.
    const inGroup = Boolean(context.groupId);
    const nextSpeakerAttrs = inGroup
        ? 'data-remodel-rp-nextspeaker-menu'
        : 'data-remodel-rp-act-disabled="Next speaker is only available in group scenes"';
    const triggerAttrs = inGroup
        ? 'data-remodel-rp-action="trigger"'
        : 'data-remodel-rp-act-disabled="Only in group scenes — there\'s just one character here"';

    // What Retry and Continue would do from where the loop currently stands.
    // Read once here and used for the label, the tooltip AND the enabled state,
    // so a button cannot offer something the handler would then refuse — the
    // handler resolves the same function against the same inputs.
    //
    // Directed Scenes only. In free play these buttons map onto core's own
    // regenerate/continue, which have no Director step to be between.
    const step = isDirectedLiveScene(activeScene)
        ? describeLiveStepActions(activeScene)
        : { retry: { target: 'narrator', reason: 'Regenerate the last response' }, continue: { target: 'narrator', reason: 'Generate the next response' } };

    zone.innerHTML = `
        <div class="remodel-rp-command-dock" aria-label="Roleplay commands">
            <button type="button" class="remodel-rp-command remodel-rp-nextspeaker" ${nextSpeakerAttrs} title="${inGroup ? 'Choose the next speaker' : 'Next speaker is only available in group scenes'}">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-users" aria-hidden="true"></i></span>
                <span class="remodel-rp-command-stack"><small>Next speaker</small><strong>AI decides</strong></span>
                ${inGroup ? '<i class="fa-solid fa-chevron-down remodel-rp-command-caret" aria-hidden="true"></i>' : ''}
            </button>
            <button type="button" class="remodel-rp-command remodel-rp-act" ${stepAttrs(step.retry, 'regenerate')} title="${escapeAttribute(step.retry.reason)}">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></span><span class="remodel-rp-command-label">${escapeHtml(stepLabel('Retry', step.retry))}</span>
            </button>
            <button type="button" class="remodel-rp-command remodel-rp-act" ${stepAttrs(step.continue, 'next')} title="${escapeAttribute(step.continue.reason)}">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-forward-step" aria-hidden="true"></i></span><span class="remodel-rp-command-label">${escapeHtml(stepLabel('Continue', step.continue))}</span>
            </button>
            <button type="button" class="remodel-rp-command remodel-rp-act" ${triggerAttrs} title="Trigger a group member">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span><span class="remodel-rp-command-label">Trigger&hellip;</span>
            </button>
            <button type="button" class="remodel-rp-command remodel-rp-act" data-remodel-rp-action="impersonate" title="Write for me">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-pen-nib" aria-hidden="true"></i></span><span class="remodel-rp-command-label">Write for me</span>
            </button>
            <button type="button" class="remodel-rp-command remodel-rp-act" data-remodel-rp-action="preview" title="Preview the final prompt">
                <span class="remodel-rp-command-icon"><i class="fa-solid fa-eye" aria-hidden="true"></i></span><span class="remodel-rp-command-label">Preview</span>
            </button>
            <span class="remodel-rp-command-prompt">${renderScenePromptChoice(getActiveScene(), true)}</span>
            <span class="remodel-live-flow-actions">
                <button type="button" data-remodel-live-continue${directionUi.canContinue ? '' : ' hidden'}><i class="fa-solid fa-play"></i> Continue</button>
                <button type="button" data-remodel-live-stop${directionUi.canStop ? '' : ' hidden'}><i class="fa-solid fa-stop"></i> Stop</button>
            </span>
        </div>

        <div class="remodel-live-flow${directionUi.active ? ' is-directed' : ''}" data-remodel-live-flow>
            <button type="button" class="remodel-live-mode${directionUi.active ? ' is-on' : ''}" data-remodel-live-mode
                aria-pressed="${directionUi.active ? 'true' : 'false'}"
                title="${escapeAttribute(liveModeTitle(directionUi))}">
                <i class="fa-solid ${directionUi.active ? 'fa-wave-square' : 'fa-feather'}" aria-hidden="true"></i>
                <span>${directionUi.active ? 'Directed' : 'Free play'}</span>
            </button>
            ${directionUi.active ? `<small class="remodel-live-state" data-remodel-live-state>${escapeHtml(directionUi.state)}</small>` : ''}
            ${directionUi.performerLabel ? `<small>${escapeHtml(directionUi.performerLabel)}</small>` : ''}
            <em data-remodel-live-opening${directionUi.openingLabel ? '' : ' hidden'}><i class="fa-regular fa-lightbulb"></i> <span>${escapeHtml(directionUi.openingLabel || '')}</span></em>
        </div>

        <div class="remodel-rp-composer-tools">
            <button type="button" class="remodel-rp-goals-pill" data-remodel-rp-panel-toggle="goals" title="Story Goals" aria-label="Story Goals">
                <i class="fa-solid fa-bullseye" aria-hidden="true"></i><span>Goals</span>
            </button>
            <div class="remodel-rp-goal-chips" aria-label="Goals available for this action">
                ${goalChips.map((goal) => `<button type="button" class="${attachedGoals.has(goal.id) ? 'is-attached' : ''}" data-remodel-goal-intent="${escapeAttribute(goal.id)}" title="${attachedGoals.has(goal.id) ? 'Remove decisive attempt' : 'Attach as a decisive attempt'}: ${escapeAttribute(goal.title)}"><i class="fa-solid fa-dice-d20"></i><span>${escapeHtml(goal.title)}</span><small>${goal.successRate}%</small></button>`).join('')}
            </div>
        </div>

        <div class="remodel-live-pacing-row">
            <label class="remodel-live-pacing">Pacing
                <select data-remodel-live-pacing aria-label="Live Direction pacing">
                    ${['slow', 'natural', 'fast', 'instant'].map((value) => `<option value="${value}"${directionUi.pacing === value ? ' selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}
                </select>
            </label>
        </div>
        ${directionUi.reasoningWarning ? `<div class="remodel-live-reasoning-warning" role="status" title="Solo mode records what changed from the Narrator's reasoning. This model returned none, so state was inferred from the prose alone.">⚠ No reasoning from this model — enable thinking or use a reasoning-capable model for accurate state tracking.</div>` : ''}

        <div class="remodel-rp-composer">
            <button type="button" class="remodel-rp-as-chip" data-remodel-rp-persona-menu title="Speak as… — click to switch persona">
                <span class="remodel-rp-as-av">${escapeHtml(roleplayInitials(personaName))}</span>
                <span class="remodel-rp-as-txt"><span class="remodel-rp-as-k">Speak as</span><span class="remodel-rp-as-v">${escapeHtml(personaName)}</span></span>
            </button>
            <textarea class="remodel-rp-input" data-remodel-rp-input placeholder="Write as ${escapeAttribute(personaName)}…" rows="1"></textarea>
            <button type="button" class="remodel-rp-send" data-remodel-rp-send title="Send">➤</button>
        </div>
    `;
    const restoredInput = zone.querySelector('[data-remodel-rp-input]');
    if (restoredInput instanceof HTMLTextAreaElement && preservedDraft) {
        restoredInput.value = preservedDraft;
        autosizeRoleplayInput(restoredInput);
    }
}

function clearRoleplayComposerDraft() {
    const input = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-input]');
    if (input instanceof HTMLTextAreaElement) {
        input.value = '';
        autosizeRoleplayInput(input);
    }
}

function getLiveDirectionCast() {
    const context = getContext();
    const scene = getActiveScene();
    const groupId = context.groupId || scene?.linkedChat?.type === 'group' && scene.linkedChat.groupId;
    const activeGroup = groupId
        ? (context.groups || []).find((group) => String(group.id) === String(groupId))
        : null;
    const disabledAvatars = new Set(Array.isArray(activeGroup?.disabled_members) ? activeGroup.disabled_members : []);
    const sceneMembers = activeGroup
        ? (activeGroup.members || []).map((avatar) => {
            const characterId = (context.characters || []).findIndex((character) => character?.avatar === avatar);
            const character = context.characters?.[characterId];
            return { name: character?.name || avatar, characterId: characterId >= 0 ? characterId : null };
        })
        : roleplaySceneMembers(context);
    const members = sceneMembers.map((member) => {
        const character = context.characters?.[member.characterId];
        const avatar = roleplayCharacterAvatar({ characterId: member.characterId, name: member.name });
        return {
            characterId: member.characterId,
            name: member.name,
            label: member.name,
            ref: { kind: 'character', id: avatar || String(member.characterId), label: member.name },
            description: character?.description || '',
            personality: character?.personality || '',
            scenario: character?.scenario || '',
            creatorNotes: character?.creator_notes || '',
            systemPrompt: character?.system_prompt || '',
            postHistoryInstructions: character?.post_history_instructions || '',
            disabled: Boolean(avatar && disabledAvatars.has(avatar)),
        };
    });
    const legacy = scene?.liveDirection?.narratorRef;
    if (legacy?.kind === 'legacy-character-index') {
        const member = members.find((item) => item.characterId === Number(legacy.id));
        if (member) updateScene(scene.id, { liveDirection: { ...scene.liveDirection, narratorRef: { kind: 'narrator', id: member.ref.id, label: member.label } } });
    }
    return members;
}

// The remodeled Scene can remain visible after Tavern navigation has cleared
// core's selected character/group. Live Direction must generate against the
// Scene's real native chat, not whichever chat happens to be selected (or no
// chat at all). This hook runs before every Director request, including Retry,
// Next, and autonomous continuations, while leaving the composer draft intact.
async function ensureRoleplaySceneChatReady(scene) {
    if (!scene?.linkedChat) return false;
    const context = getContext();
    const linked = scene.linkedChat;

    if (linked.type === 'group') {
        const group = (context.groups || []).find((item) => String(item.id) === String(linked.groupId));
        const chatId = group?.chats?.find((candidate) => String(candidate) === String(linked.chatId));
        if (!group || chatId === undefined) return false;
        let openedGroup = false;
        if (String(context.groupId || '') !== String(group.id)) {
            await openGroupById(group.id);
            openedGroup = true;
        }
        if (String(context.chatId || '') !== String(chatId)) {
            await context.openGroupChat(group.id, chatId);
        }
        const settled = await waitForChatIdSettled();
        if (!settled || String(getContext().groupId || '') !== String(group.id)) return false;
        if (openedGroup) dismissProgrammaticGroupEditor();
        await removeLeakedNativeRoleplayGreetings(scene);
        writeSceneMetadata(scene);
        syncStoryWorkspaceClass(scene);
        ensureRoleplayRoot();
        renderRoleplayScene();
        return true;
    }

    const characterId = Number(linked.characterId);
    if (!context.characters?.[characterId]) return false;
    const currentFile = String(context.chatId || '').replace(/\.jsonl$/i, '');
    const targetFile = String(linked.fileName || '').replace(/\.jsonl$/i, '');
    if (Number(context.characterId) !== characterId) {
        await context.selectCharacterById(characterId, { switchMenu: false });
    }
    if (currentFile !== targetFile) {
        await context.openCharacterChat(linked.fileName);
    }
    await removeLeakedNativeRoleplayGreetings(scene);
    writeSceneMetadata(scene);
    syncStoryWorkspaceClass(scene);
    ensureRoleplayRoot();
    renderRoleplayScene();
    return Boolean(getContext().chatId);
}

function isLeakedNativeRoleplayGreeting(message) {
    if (!message || message.is_user || message.is_system || !message.original_avatar) return false;
    if (message.extra?.remodelDirection || message.extra?.api || message.gen_started || message.gen_finished) return false;
    return true;
}

async function removeLeakedNativeRoleplayGreetings(scene) {
    if (!isDirectedLiveScene(scene)) return false;
    const context = getContext();
    const firstUserIndex = (context.chat || []).findIndex((message) => message?.is_user);
    const boundary = firstUserIndex < 0 ? context.chat.length : firstUserIndex;
    let count = 0;
    while (count < boundary && isLeakedNativeRoleplayGreeting(context.chat[count])) count++;
    if (!count) return false;
    context.chat.splice(0, count);
    await context.saveChat();
    return true;
}

function openRoleplayDirectorMenu(anchor) {
    const scene = getActiveScene();
    if (!scene || !anchor) return;
    const context = getContext();
    const members = roleplaySceneMembers(context);
    const currentId = scene.liveDirection?.directorRef?.id || '';
    const narratorId = scene.liveDirection?.narratorRef?.id || '';
    const items = [
        ...(currentId ? [{ id: '__clear__', label: 'No Roleplay Director', sublabel: 'Clear the Director seat', active: false }] : []),
        ...members.map((member) => {
            const avatar = roleplayCharacterAvatar(member);
            return {
                id: avatar,
                label: member.name,
                avatar: avatar ? context.getThumbnailUrl('avatar', avatar) : '',
                initials: roleplayInitials(member.name),
                sublabel: avatar === narratorId ? 'Bound Narrator — unavailable as Director' : 'Directs privately; operation cards appear in the stream',
                active: avatar === currentId,
            };
        }).filter((item) => item.id && item.id !== narratorId),
    ];
    openRoleplayMenu(anchor, items, (id) => {
        const member = members.find((item) => roleplayCharacterAvatar(item) === id);
        const directorRef = id === '__clear__' || !member ? null : { kind: 'character', id, label: member.name };
        setSceneRoleplayDirector(scene.id, directorRef);
        clearLiveDirectionFailure();
        document.getElementById('remodel-direction-failure')?.remove();
        showRoleplayToast(directorRef ? `${member.name} is now the Roleplay Director.` : 'Roleplay Director seat cleared.');
        renderRoleplayScene();
    });
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
        if (isDirectedLiveScene(getActiveScene())) {
            const member = members.find((item) => item.name === id);
            const avatar = member ? roleplayCharacterAvatar({ characterId: member.characterId, name: member.name }) : '';
            if (member && avatar) setNextPerformerOverride({ kind: 'character', id: avatar, label: member.name });
            showRoleplayToast(`${id} will perform the next directed response.`);
            return;
        }
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

// Prompt preview: assembles (but never sends) the exact prompts a normal turn
// would produce right now, and shows them in a read-only modal split into two
// tabs — Directed Roleplay sends two separately-authored prompts on a turn,
// the hidden Director and the visible Narrator, and a user should be able to
// see what each one will actually be sent.
//
// Narrator tab: reuses the same dry-run + formatter the Story workspace's
// preview uses. Honest "here's what the model will actually see," including
// whatever's typed in the composer.
//
// Director tab: compiles through the exact path a real direction pass takes
// (previewDirectorPrompt → compileDirectorPrompt in live-direction.js — same
// recipe resolution, same buildDirectionSources, same compilePromptRecipe) so
// the compile mechanism can never drift from what actually gets sent. The one
// piece that cannot be made exact is Variables/Goals retrieval, which is
// scored against a message the user has not sent yet — see the note rendered
// in the Director panel below and previewDirectorPrompt's own doc comment.
const ROLEPLAY_PREVIEW_ID = 'remodel-rp-preview-modal';

const previewTab = (id, label, active) =>
    `<button type="button" data-remodel-rp-preview-tab="${id}" class="${active === id ? 'is-active' : ''}">${label}</button>`;

// The hint under the title used to describe both prompts at once, which is
// never what is on screen — only one tab is ever visible. One line per tab,
// swapped by setRoleplayPreviewTab.
const PREVIEW_TAB_HINTS = Object.freeze({
    director: 'What the hidden Director will receive on the next turn — nothing is sent.',
    narrator: 'What the Narrator will receive on the next turn — nothing is sent.',
});

// Both panels get the same BY SOURCE / RAW PROMPT toggle and the same pair of
// containers, under the same attribute names. Every lookup below is scoped to
// one panel rather than to the overlay, so the toggle is one component serving
// two tabs instead of two near-identical ones drifting apart — this codebase
// has a documented history of defects from handlers that enumerate cases
// instead of generalising.
const PREVIEW_VIEWS_MARKUP = `
                <div class="remodel-rp-preview-views" data-remodel-rp-preview-views hidden>
                    <button type="button" class="is-active" data-remodel-rp-preview-view="sources">By source</button>
                    <button type="button" data-remodel-rp-preview-view="raw">Raw prompt</button>
                </div>
                <div class="remodel-rp-preview-sources" data-remodel-rp-preview-sources hidden></div>
                <pre class="remodel-rp-preview-body" data-remodel-rp-preview-body>Assembling prompt…</pre>`;

const previewPanel = (id, activeTab, lead = '') => `
            <div class="remodel-rp-preview-panel" data-remodel-rp-preview-panel="${id}" ${activeTab === id ? '' : 'hidden'}>
                <div class="remodel-rp-preview-warn" data-remodel-rp-preview-warn hidden></div>
                ${lead}${PREVIEW_VIEWS_MARKUP}
            </div>`;

// Informational, not a fault: the compile path is exact and only the retrieval
// scoring can move, so this gets the neutral callout. The red warn box in the
// same panel stays reserved for usedFallback, which genuinely is a fault.
const DIRECTOR_RETRIEVAL_NOTE = '<p class="remodel-rp-preview-note">Everything here compiles exactly like a real request, except Variables/Goals retrieval — it is scored against your current history and this composer draft, and can select differently once you actually send.</p>';

async function openRoleplayPromptPreview() {
    // Build the modal shell immediately with a loading state so the click is
    // acknowledged, then fill it once the dry runs resolve.
    document.getElementById(ROLEPLAY_PREVIEW_ID)?.remove();
    const activeScene = getActiveScene();
    const directed = isDirectedLiveScene(activeScene);
    // Free play never calls the Director, so default to whichever tab this
    // Scene will actually use on its next turn.
    const defaultTab = directed ? 'director' : 'narrator';
    const overlay = document.createElement('div');
    overlay.id = ROLEPLAY_PREVIEW_ID;
    overlay.className = 'remodel-rp-picker-scrim';
    overlay.innerHTML = `
        <div class="remodel-rp-preview" data-remodel-rp-preview-stop>
            <div class="remodel-rp-picker-head">
                <div>
                    <div class="remodel-rp-picker-title">Prompt preview</div>
                    <div class="remodel-rp-picker-hint" data-remodel-rp-preview-hint>${escapeHtml(PREVIEW_TAB_HINTS[defaultTab])}</div>
                </div>
                <button type="button" class="remodel-rp-picker-x" data-remodel-rp-preview-close aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-preview-tabs" data-remodel-rp-preview-tabs>
                ${previewTab('director', 'Director', defaultTab)}
                ${previewTab('narrator', 'Narrator', defaultTab)}
            </div>
            ${previewPanel('director', defaultTab, directed ? DIRECTOR_RETRIEVAL_NOTE : '')}
            ${previewPanel('narrator', defaultTab)}
        </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('remodel-rp-picker-in'));

    // Both panels now use the same attribute names for their body, sources and
    // view toggle, so every lookup has to be scoped to its own panel — an
    // overlay-wide querySelector would find whichever panel comes first.
    const narratorPanel = overlay.querySelector('[data-remodel-rp-preview-panel="narrator"]');
    fillDirectorPreviewPanel(overlay.querySelector('[data-remodel-rp-preview-panel="director"]'), activeScene, directed);

    try {
        const { generateData, warnings } = await runPromptPreviewDryRun('normal');
        const attachedGoalIntents = activeScene ? getStoryGoalComposerIntents(activeScene.id) : [];
        if (attachedGoalIntents.length) {
            warnings.push(`${attachedGoalIntents.length} attached Story Goal attempt${attachedGoalIntents.length === 1 ? '' : 's'} will be assessed by the hidden Game Director when sent; preview never rolls or mutates.`);
        }
        // Names what actually still happens. Performer selection, openings and
        // checkpoints were all deleted by the director rework: the Narrator
        // badge decides who speaks, pacing is derived from the finished prose,
        // and every mechanical request applies once the response is accepted.
        if (directed) warnings.push('The Director has not run: its instruction to the performer, and any Goal or Variable change it requests, are decided when you send and applied once the response is accepted. Preview never rolls or mutates.');
        const bodyEl = narratorPanel?.querySelector('[data-remodel-rp-preview-body]');
        const warnEl = narratorPanel?.querySelector('[data-remodel-rp-preview-warn]');
        if (bodyEl) {
            bodyEl.textContent = formatPromptPreview(generateData);
        }
        // Source breakdown is the default view when it's available — Text
        // Completion scenes never populate the prompt manager, so those keep
        // the raw dump with no view switcher at all.
        const sections = collectPromptPreviewSections();
        const sourcesEl = narratorPanel?.querySelector('[data-remodel-rp-preview-sources]');
        const viewsEl = narratorPanel?.querySelector('[data-remodel-rp-preview-views]');
        if (sections && sourcesEl && viewsEl && bodyEl) {
            sourcesEl.innerHTML = renderPromptPreviewSections(sections);
            sourcesEl.hidden = false;
            viewsEl.hidden = false;
            bodyEl.hidden = true;
        }
        if (warnEl && Array.isArray(warnings) && warnings.length > 0) {
            warnEl.textContent = `⚠ ${warnings.join(' · ')}`;
            warnEl.hidden = false;
        }
    } catch (err) {
        const bodyEl = narratorPanel?.querySelector('[data-remodel-rp-preview-body]');
        if (bodyEl) {
            bodyEl.textContent = `Could not assemble a preview.\n\n${String(err)}`;
        }
    }
}

// Fills the Director tab by compiling the active Director recipe against a
// snapshot built for the current Scene — the same compile path
// requestDirection uses for a real direction pass (see
// previewDirectorPrompt/compileDirectorPrompt in live-direction.js) — so the
// two can never drift apart. Runs independently of the Narrator dry run above
// so one tab's failure never blocks the other from filling in.
async function fillDirectorPreviewPanel(panel, scene, directed) {
    const bodyEl = panel?.querySelector('[data-remodel-rp-preview-body]');
    const warnEl = panel?.querySelector('[data-remodel-rp-preview-warn]');
    if (!bodyEl) return;
    if (!directed) {
        bodyEl.textContent = '(This Scene is on Free play — no Director request is made on its next turn. Turn Live Direction on to preview it.)';
        return;
    }
    try {
        const { prompt, usedFallback, trace, contractOk, hasTags, hasFence } = await previewDirectorPrompt(scene);
        bodyEl.textContent = formatPromptStudioPreview({ apiType: 'chat', messages: prompt });
        // Keyed on usedFallback, not on "no recipe": compileDirectorPrompt also
        // falls back when a recipe exists but compiles to nothing or lost its
        // protocol block — exactly the user who most needs to be told they are
        // looking at the built-in prompt, not their own recipe's output.
        if (usedFallback && warnEl) {
            warnEl.textContent = '⚠ No usable Director recipe — showing the built-in fallback prompt.';
            warnEl.hidden = false;
        } else if (!contractOk && warnEl) {
            // The recipe compiles and will be sent exactly as shown. What it
            // no longer carries is the part the REPLY PARSER depends on, and
            // the symptom of that is silent: a Director writes prose, nothing
            // tags it, and the whole reply is stored as one untagged note with
            // any secret inside it. Said here because this panel is where an
            // owner rewriting the protocol is standing.
            const missing = [!hasTags && 'the notebook tags ({{director::notebook.tags}})', !hasFence && 'the state fence ({{director::state.fence}})'].filter(Boolean).join(' and ');
            warnEl.textContent = `⚠ This prompt is missing ${missing}. It will be sent as shown, but the Director's reply cannot be parsed into typed entries — everything it writes lands as a single untagged note, secrets included, and no Goal or Variable request can be read.`;
            warnEl.hidden = false;
        }
        // No trace on the fallback path: the cards would be captioning the
        // user's recipe blocks over a prompt those blocks did not produce.
        // That case keeps the raw dump and the red box that explains it.
        const sourcesEl = panel.querySelector('[data-remodel-rp-preview-sources]');
        const viewsEl = panel.querySelector('[data-remodel-rp-preview-views]');
        if (Array.isArray(trace) && trace.length && sourcesEl && viewsEl) {
            sourcesEl.innerHTML = await renderPromptTraceSections(trace, prompt);
            sourcesEl.hidden = false;
            viewsEl.hidden = false;
            bodyEl.hidden = true;
        }
    } catch (err) {
        bodyEl.textContent = `Could not assemble a Director preview.\n\n${String(err)}`;
    }
}

/**
 * Sizes a list of prompt texts, and says what unit it managed to size them in.
 *
 * The Narrator's own per-source figures come from core's promptManager
 * tokenHandler, keyed by native identifier — which does not apply to the
 * Director or Story previews at all: neither one populates the native prompt
 * manager (the Director streams its own message array through
 * sendOpenAIRequest — generateRawData and its schema were deleted with the
 * envelope; the Story preview compiles through compilePromptRecipe
 * directly). The only
 * counter reachable from either path is core's own tokenizer. Ask it; if it
 * is missing or throws, fall back to character counts for the WHOLE set and
 * say so in the label, rather than printing characters under a "tok" heading
 * or mixing units card to card.
 */
async function measurePreviewTexts(texts) {
    try {
        const context = getContext();
        if (typeof context?.getTokenCountAsync !== 'function') throw new Error('no tokenizer available');
        const sizes = await Promise.all(texts.map(async (text) => {
            const count = Number(await context.getTokenCountAsync(text));
            if (!Number.isFinite(count)) throw new Error('tokenizer returned a non-number');
            return count;
        }));
        return { unit: 'tok', unitLabel: 'tokens', sizes };
    } catch {
        return { unit: 'chars', unitLabel: 'characters', sizes: texts.map((text) => String(text || '').length) };
    }
}

/**
 * The BY SOURCE view for any surface that compiles through compilePromptRecipe
 * with `trace: true` — currently the Director tab and the Story preview.
 * One function, not one per surface: both recipes concatenate adjacent
 * same-role blocks (the seeded Director recipe's five authored blocks arrive
 * as two messages; a Story recipe's several same-role World Info/context
 * blocks fold the same way), and a second near-identical renderer is exactly
 * the shape of defect this codebase has repeatedly shipped — a rule or
 * renderer duplicated and then left to drift.
 *
 * Deliberately grouped by the message each block landed in rather than shown
 * as a flat list: the whole reason this view beats the raw dump is that the
 * raw dump cannot show a user which authored blocks arrive folded into one
 * message. Blocks that resolved to nothing get a group of their own so they
 * are visibly empty rather than simply absent, which is the same treatment
 * renderPromptPreviewSections gives an empty Narrator source.
 */
async function renderPromptTraceSections(trace, messages) {
    // Measured per contribution rather than per block: a block that straddled
    // two messages would otherwise have its whole size counted into both of
    // the groups it appears in. No Director source straddles — every one
    // resolves to a single string — but a Story source can: worldInfoDepth
    // resolves to a `{messages: [...]}` array (see compilePromptRecipe), and
    // its parts can land in more than one message. Sizing per part rather
    // than per block is what keeps that case honest too.
    const parts = trace.flatMap((entry) => entry.parts);
    const { unit, unitLabel, sizes } = await measurePreviewTexts(parts.map((part) => part.content || ''));
    const sizeOfPart = new Map(parts.map((part, index) => [part, sizes[index]]));
    const sizeOf = (candidates) => candidates.reduce((sum, part) => sum + (sizeOfPart.get(part) || 0), 0);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const contributed = trace.filter((entry) => entry.messageIndex >= 0);

    const groups = (messages || []).map((message, index) => ({
        index,
        role: message.role,
        entries: trace.filter((entry) => entry.messageIndices.includes(index)),
    })).filter((group) => group.entries.length);
    const unsent = trace.filter((entry) => entry.messageIndex < 0);

    const renderCard = (entry) => {
        const empty = entry.messageIndex < 0;
        const body = empty
            ? '<p class="remodel-rp-preview-empty">This block resolved to nothing and was left out of the request.</p>'
            : entry.parts.map((part) => `<div class="remodel-rp-preview-msg"><span class="remodel-rp-preview-msg-role">${escapeHtml(String(part.role || 'system').toUpperCase())}</span><pre>${escapeHtml(part.content || '')}</pre></div>`).join('');
        return `
            <article class="remodel-rp-preview-card${empty ? ' is-empty' : ''}" data-remodel-preview-card${empty ? '' : ' open'}>
                <details${empty ? '' : ' open'}>
                    <summary>
                        <span class="remodel-rp-preview-card-role">${escapeHtml(String(entry.role || 'system').toUpperCase())}</span>
                        <span class="remodel-rp-preview-card-title">${escapeHtml(entry.label || entry.sourceKey || 'Block')}</span>
                        <span class="remodel-rp-preview-card-meta">${escapeHtml(entry.sourceKey || 'authored')}${empty ? ' · empty' : ` · ${sizeOf(entry.parts)} ${unit}`}</span>
                    </summary>
                    <div class="remodel-rp-preview-card-body">${body}</div>
                </details>
            </article>
        `;
    };

    const renderGroup = (group) => {
        const size = sizeOf(group.entries.flatMap((entry) => entry.parts).filter((part) => part.messageIndex === group.index));
        const merged = group.entries.length > 1;
        return `
            <section class="remodel-rp-preview-merge">
                <header class="remodel-rp-preview-merge-head">
                    <span class="remodel-rp-preview-merge-index">Message ${group.index + 1}</span>
                    <span class="remodel-rp-preview-merge-role">${escapeHtml(String(group.role || 'system').toUpperCase())}</span>
                    <span class="remodel-rp-preview-merge-note">${merged ? `${group.entries.length} blocks merged into one message` : 'one block, sent on its own'} · ${size} ${unit}</span>
                </header>
                <div class="remodel-rp-preview-cards">${group.entries.map(renderCard).join('')}</div>
            </section>
        `;
    };

    const unsentGroup = unsent.length
        ? `
            <section class="remodel-rp-preview-merge is-unsent">
                <header class="remodel-rp-preview-merge-head">
                    <span class="remodel-rp-preview-merge-index">Not sent</span>
                    <span class="remodel-rp-preview-merge-note">${unsent.length} block${unsent.length === 1 ? '' : 's'} resolved to nothing</span>
                </header>
                <div class="remodel-rp-preview-cards">${unsent.map(renderCard).join('')}</div>
            </section>
        `
        : '';

    return `
        <div class="remodel-rp-preview-summary">
            <span><strong>${contributed.length}</strong> of ${trace.length} blocks contributed</span>
            <span><strong>${groups.length}</strong> message${groups.length === 1 ? '' : 's'} sent</span>
            <span><strong>${total}</strong> ${unitLabel} total</span>
        </div>
        <div class="remodel-rp-preview-merges">${groups.map(renderGroup).join('')}${unsentGroup}</div>
    `;
}

function setRoleplayPreviewTab(overlay, tab) {
    for (const panel of overlay.querySelectorAll('[data-remodel-rp-preview-panel]')) {
        panel.hidden = panel.dataset.remodelRpPreviewPanel !== tab;
    }
    for (const button of overlay.querySelectorAll('[data-remodel-rp-preview-tab]')) {
        button.classList.toggle('is-active', button.dataset.remodelRpPreviewTab === tab);
    }
    // Only one tab is ever on screen, so the hint has to describe that one.
    const hintEl = overlay.querySelector('[data-remodel-rp-preview-hint]');
    if (hintEl && PREVIEW_TAB_HINTS[tab]) hintEl.textContent = PREVIEW_TAB_HINTS[tab];
}

// Takes a scoping element, not necessarily the whole overlay: the Director
// and Narrator tabs each pass their own panel so the toggle only switches
// that tab's own body and cards, while the Story preview — which has no tab
// panels of its own — passes its overlay directly, the same shape one level
// up.
function setRoleplayPreviewView(panel, view) {
    if (!panel) return;
    const showRaw = view === 'raw';
    const sourcesEl = panel.querySelector('[data-remodel-rp-preview-sources]');
    const bodyEl = panel.querySelector('[data-remodel-rp-preview-body]');
    if (sourcesEl) sourcesEl.hidden = showRaw;
    if (bodyEl) bodyEl.hidden = !showRaw;
    for (const button of panel.querySelectorAll('[data-remodel-rp-preview-view]')) {
        button.classList.toggle('is-active', button.dataset.remodelRpPreviewView === view);
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
async function handleRoleplaySend(root) {
    if (root.dataset.remodelRpSubmitting === 'true') return;
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
    const scene = getActiveScene();
    // Free play hands the line to core's native group generator, which returns
    // silently when SillyTavern is disconnected — no message, no error, and no
    // GENERATION_ENDED to clear the composing indicator. Refuse the send with a
    // reason instead of spinning forever. Directed sends carry their own check.
    const blocked = describeNativeGenerationBlock();
    if (blocked && !isDirectedLiveScene(scene)) {
        showLiveDirectionFailure(new Error(blocked), { heading: 'Cannot send.', recoverable: false });
        return;
    }
    if (isDirectedLiveScene(scene)) {
        root.dataset.remodelRpSubmitting = 'true';
        setRoleplayGenerating(true);
        refreshLiveDirectionChrome({ state: 'Directing', acceptedVisibleText: getLiveDirectionRun()?.acceptedVisibleText || '' });
        const intents = getStoryGoalComposerIntents(scene.id);
        try {
            await submitDirectedRoleplay({ scene, text: value, authorizedGoalIds: intents.map((item) => item.goalId) });
        } finally {
            delete root.dataset.remodelRpSubmitting;
        }
        return;
    }
    const sendNative = () => {
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
    };
    await handleGoalAwareRoleplaySend({ root, scene: getActiveScene(), text: value, sendNative });
}

function sendRoleplayNormally(value) {
    const input = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-input]');
    const textarea = document.getElementById('send_textarea');
    const button = document.getElementById('send_but');
    if (!(input instanceof HTMLTextAreaElement) || !(textarea instanceof HTMLTextAreaElement) || !button) return;
    input.value = '';
    autosizeRoleplayInput(input);
    textarea.value = String(value || '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    setRoleplayGenerating(true);
    button.click();
}

/**
 * @param {Error|string} error
 * @param {{ heading?: string, recoverable?: boolean }} [options]
 *        `recoverable: false` omits Retry / Send Normally. Both of those re-run
 *        the same request, so offering them for a blocked connection would only
 *        reproduce the failure the panel just reported.
 */
function showLiveDirectionFailure(error, { heading = 'Direction paused.', recoverable = true } = {}) {
    document.getElementById('remodel-direction-failure')?.remove();
    setRoleplayGenerating(false);
    removeRoleplayTypingIndicator();
    const panel = document.createElement('div');
    panel.id = 'remodel-direction-failure';
    panel.className = 'remodel-mechanics-failure remodel-direction-failure';
    // Send Normally re-sends the user's own intervention. An autonomous
    // continuation has none, so the button would be inert — offer only Retry.
    const actions = recoverable
        ? `<button type="button" data-remodel-direction-retry>Retry Direction</button>${canSendWithoutLiveDirection() ? '<button type="button" data-remodel-direction-bypass>Send Normally</button>' : ''}`
        : '';
    panel.innerHTML = `<span><strong>${escapeHtml(heading)}</strong> ${escapeHtml(error?.message || String(error))}</span>${actions}<button type="button" class="remodel-direction-failure-x" data-remodel-direction-dismiss aria-label="Dismiss">×</button>`;
    getRealRoleplayRoot()?.append(panel);
    dismissDirectionFailureOnOutsideClick(panel);
}

/**
 * Let a click anywhere else take the notice down.
 *
 * It sits over the composer with no way out but Retry, so a user who wants
 * neither — because the scene recovered on its own, or because they would
 * rather just type — had a permanent obstruction. Dismissing is only ever
 * removing a message: `pendingFailure` stays, so Retry Direction remains
 * available from the command dock afterward and nothing about the failed pass
 * is forgotten by hiding the notice about it.
 *
 * Listener attached on the NEXT frame, not immediately: the click that caused
 * the failure may still be propagating, and a listener added during it would
 * see that same click and dismiss the notice before it was ever visible.
 */
function dismissDirectionFailureOnOutsideClick(panel) {
    requestAnimationFrame(() => {
        if (!panel.isConnected) return;
        const onPointerDown = (event) => {
            // Inside the notice is a click on its own controls, which own
            // themselves — Retry and Send Normally remove it their own way.
            if (panel.contains(event.target)) return;
            panel.remove();
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
        // Capture phase, so a handler that stops propagation on the way up
        // cannot leave the notice stranded.
        document.addEventListener('pointerdown', onPointerDown, true);
    });
}

function refreshLiveDirectionChrome(run = getLiveDirectionRun()) {
    const root = getRealRoleplayRoot();
    if (!root) return;
    renderRoleplayDirectionFeed(root, getActiveScene());
    ensureLiveDirectionCardInStream(root, run);
    const body = root.querySelector('[data-remodel-rp-typing-body]');
    if (body && run?.acceptedVisibleText != null) {
        // Editor mode is hold-then-show: the narrator's draft must not appear.
        // Until the run commits (the Director-editor has reconciled it), show a
        // reviewing placeholder instead of the streaming draft; then reveal the
        // committed prose.
        const reviewing = getLiveDirectionUiState(getActiveScene())?.mode === 'editor' && !run.acceptedComplete;
        body.textContent = reviewing ? 'The Director is reviewing the scene…' : run.acceptedVisibleText;
    }
    const zone = root.querySelector('[data-remodel-rp-composer]');
    const flow = zone?.querySelector('[data-remodel-live-flow]');
    if (flow) {
        const ui = getLiveDirectionUiState(getActiveScene());
        // The mode label is left alone on purpose: it names which mode the
        // Scene is IN ("Directed" / "Free play") and must not be overwritten
        // with the transient run state, which is what used to make it
        // impossible to tell whether Live Direction was on.
        flow.querySelector('[data-remodel-live-state]')?.replaceChildren(document.createTextNode(run?.state || ui.state || ''));
        flow.querySelector('[data-remodel-live-mode]')?.setAttribute('title', liveModeTitle({ ...ui, state: run?.state || ui.state }));
        const opening = flow.querySelector('[data-remodel-live-opening]');
        if (opening) {
            opening.hidden = !run?.openingLabel;
            opening.querySelector('span')?.replaceChildren(document.createTextNode(run?.openingLabel || ''));
        }
        // Run controls live in the command dock, not in the flow row — looked
        // up from the zone so this keeps working wherever the dock puts them.
        const continueButton = zone.querySelector('[data-remodel-live-continue]');
        if (continueButton) continueButton.hidden = run?.state !== 'Waiting for you';
        const stopButton = zone.querySelector('[data-remodel-live-stop]');
        // ui.canStop, not the existence of a run: a Director pass that has not
        // produced a visible run yet is still a busy pipeline the user must be
        // able to abandon. Keyed on `run` alone, Stop was hidden for the whole
        // multi-second hidden call and pressing nothing did nothing.
        if (stopButton) stopButton.hidden = !ui.canStop;
        // Same reason — refusing a send while the Director is out is only
        // legible if the composer says so.
        const sendButton = zone?.querySelector('[data-remodel-rp-send]');
        if (sendButton instanceof HTMLButtonElement) sendButton.disabled = ui.canSend === false;
    }
    // A hidden Director pass — after beginDirection's opening notifyTransient
    // but before generateDirectedPerformer has a record for
    // ensureLiveDirectionCardInStream to insert — gets its own streaming
    // shell instead of the generic "Composing" bubble, so the wait reads as
    // the Director's own from the first moment rather than an unlabeled
    // placeholder.
    //
    // The three-way choice is resolved by direction-chrome.js's pure
    // predicate, shared with renderRoleplayScene's tail below, because
    // deciding it by hand here is what shipped the defect: `run` is TRUTHY on
    // the two calls that mean "a pass just started" (notifyTransient and
    // handleRoleplaySend both pass a placeholder), so a `!run` test closed
    // the card on exactly the calls that should have opened it.
    const mode = resolveDirectionChromeMode({ run, uiState: getLiveDirectionUiState(getActiveScene()) });
    if (mode !== 'directing') {
        closeDirectionStreamCard(root);
    }
    // A recovered run at the end of its accepted response is deliberately
    // represented as "Waiting for you" so Continue can start a fresh
    // direction. It is not generating and has no hidden suffix to reveal.
    // Treating the mere existence of that recovery object as an active
    // speaker resurrected a permanent "Narrator composing..." row every
    // time a directed Scene was opened after a page reload — which is why
    // 'speaking' requires a real run, not merely a run-shaped object.
    if (mode === 'speaking') {
        if (!root.querySelector('.remodel-rp-typing')) showRoleplayTypingIndicator(run.performer || null);
        return;
    }
    // No run yet, but a Director pass is out. Survives re-render, unlike the
    // one-shot indicator handleRoleplaySend puts up at submit time — losing it
    // was half of why a hidden pass looked like an idle Scene. The generic
    // bubble comes down with it: the two are alternatives, and leaving a
    // stale one up beside the Director's shell is the unlabeled wait this
    // card exists to replace.
    if (mode === 'directing') {
        removeRoleplayTypingIndicator();
        ensureDirectionStreamCard(root);
    }
}

/**
 * Puts the current pass's Director card into the stream as soon as the pass has
 * one, rather than whenever the next full rebuild happens to run.
 *
 * The card was only ever painted by renderRoleplayScene(), so which side of the
 * narration it landed on depended on which incidental re-render fired first: an
 * autonomous continuation had one before the prose, a user send did not, and the
 * card only appeared once the response settled. Direction is decided BEFORE the
 * performer speaks, so the card belongs above the prose in both cases.
 *
 * Insert-before-the-typing-indicator keeps it there while the response reveals.
 */
function ensureLiveDirectionCardInStream(root, run) {
    if (!run?.directionId) return;
    const stream = root.querySelector('[data-remodel-rp-stream]');
    if (!stream) return;
    if (stream.querySelector(`[data-remodel-direction-id="${CSS.escape(run.directionId)}"]`)) return;
    const record = (getActiveScene()?.liveDirection?.directionLog || []).find((item) => item?.id === run.directionId);
    if (!record) return;
    stream.querySelector('.remodel-rp-empty')?.remove();
    const card = buildRoleplayDirectionCard(record);
    const typing = stream.querySelector('.remodel-rp-typing');
    if (typing) stream.insertBefore(card, typing);
    else stream.appendChild(card);
    requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
}

/**
 * The Director's OWN streaming shell — shown from the moment a pass begins
 * (beginDirection's opening `notifyTransient('Directing')`), well before
 * ensureLiveDirectionCardInStream above has a real record to insert
 * (persistDirectionRecord only runs once the whole Director round-trip has
 * returned). Shares its outer look with the finished card
 * (remodel-rp-direction-stream-card/-inner, remodel-rp-direction-badge) but
 * is a distinct element — the finished card is a permanent record of what
 * happened; this one is torn down the moment that record lands or the pass
 * ends any other way (see closeDirectionStreamCard, called from
 * refreshLiveDirectionChrome).
 *
 * Shape follows openStoryStreamPreview/updateStoryStreamPreview: cumulative
 * text plus a reasoning disclosure that un-hides once reasoning is
 * non-empty — Story mode's own pattern for exactly this kind of live fill,
 * copied rather than reinvented.
 */
function ensureDirectionStreamCard(root) {
    const stream = root.querySelector('[data-remodel-rp-stream]');
    if (!stream || stream.querySelector('[data-remodel-direction-live]')) return;
    stream.querySelector('.remodel-rp-empty')?.remove();
    const live = document.createElement('article');
    live.className = 'remodel-rp-msg remodel-rp-direction-stream-card is-live';
    live.dataset.remodelDirectionLive = 'true';
    live.innerHTML = `
        <div class="remodel-rp-direction-stream-inner">
            <header>
                <span class="remodel-rp-direction-badge"><i class="fa-solid fa-clapperboard"></i> Roleplay Director</span>
                <span class="remodel-rp-direction-live-dots"><i></i><i></i><i></i></span>
            </header>
            <div class="remodel-rp-direction-live-text" data-remodel-direction-live-text></div>
            <details class="remodel-rp-direction-section is-reasoning" data-remodel-direction-live-reasoning hidden>
                <summary><i class="fa-solid fa-brain"></i> Reasoning</summary>
                <pre class="remodel-rp-direction-reasoning" data-remodel-direction-live-reasoning-body></pre>
            </details>
        </div>`;
    stream.appendChild(live);
    requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; });
}

/**
 * Fills the streaming shell with the Director's cumulative text/reasoning so
 * far. Registered as the `onDirectorChunk` hook (see initLiveDirection's
 * call site above) and shaped to match story-stream.js's onChunk contract
 * exactly — `{ text, reasoning }`, cumulative, same as
 * updateStoryStreamPreview reads.
 *
 * Fed for real: `beginDirection`'s onChunk closure calls
 * `hooks.onDirectorChunk(update)` on every chunk, unconditionally (the
 * once-per-pass journal entry beside it is a separate, first-chunk-only
 * record). So this fills live for the whole 101-202s of a Director call, and
 * the shell `ensureDirectionStreamCard` opened is not an empty placeholder.
 *
 * Returns silently when no shell is open. That is not a gap either: the shell
 * is opened by `refreshLiveDirectionChrome`/`renderRoleplayScene` whenever the
 * pass is in the Directing state (see `resolveDirectionChromeMode`), and a
 * chunk arriving when the Roleplay workspace is not on screen has nowhere to
 * go by definition.
 */
function updateDirectionStreamCard(update) {
    const live = getRealRoleplayRoot()?.querySelector('[data-remodel-direction-live]');
    if (!live) return;
    const body = live.querySelector('[data-remodel-direction-live-text]');
    if (body) body.textContent = String(update?.text || '');
    const panel = live.querySelector('[data-remodel-direction-live-reasoning]');
    const thoughts = String(update?.reasoning || '').trim();
    if (panel) {
        // The panel only appears once the model actually reasons, so a
        // non-reasoning model shows no empty console — same rule as Story's.
        panel.hidden = !thoughts;
        const pre = panel.querySelector('[data-remodel-direction-live-reasoning-body]');
        if (pre && pre.textContent !== thoughts) {
            pre.textContent = thoughts;
            pre.scrollTop = pre.scrollHeight;
        }
    }
    const stream = getRealRoleplayRoot()?.querySelector('[data-remodel-rp-stream]');
    if (stream) stream.scrollTop = stream.scrollHeight;
}

function closeDirectionStreamCard(root) {
    root?.querySelector('[data-remodel-direction-live]')?.remove();
}

// One-line-growing textarea, capped so a long message scrolls inside the
// composer rather than pushing the stream off-screen.
function autosizeRoleplayInput(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

/**
 * A step button's wiring: live when it has something to do, and inert with a
 * stated reason when it does not.
 *
 * `data-remodel-rp-act-disabled` is the dock's existing idiom for "present but
 * refusing, and able to say why" — the same one the group-only controls use —
 * rather than a `disabled` attribute the user can hover and learn nothing from.
 */
function stepAttrs(action, name) {
    return action.target
        ? `data-remodel-rp-action="${name}"`
        : `data-remodel-rp-act-disabled="${escapeAttribute(action.reason)}"`;
}

/**
 * "Retry" and "Continue" name the verb; the suffix names what it will act on.
 *
 * Worth the extra word because the two targets are not interchangeable: a
 * Continue that speaks a standing direction costs one generation, and a
 * Continue that directs the next moment costs a Director call as well. The
 * suffix is the only thing on screen that distinguishes them.
 */
function stepLabel(verb, action) {
    if (!action.target) return verb;
    return `${verb} · ${action.target === 'director' ? 'Director' : 'Narrator'}`;
}

// Maps the roleplay action buttons onto core's real controls. Reuses the
// same native buttons the story action bar drives, so behavior is
// identical to native — no reimplementation of generation/regeneration.
function handleRoleplayAction(action) {
    switch (action) {
        case 'regenerate': {
            if (isDirectedLiveScene(getActiveScene())) {
                // Retry, not regenerate: re-runs the last STEP of the loop in
                // place, which is the Director when a direction is standing
                // unspoken and the performer otherwise. retryLiveStep decides
                // that from the same resolver the button is labelled from, so
                // the label and the action cannot disagree.
                retryLiveStep(getActiveScene());
                break;
            }
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
            if (isDirectedLiveScene(getActiveScene())) {
                // Continue advances the loop by one step without touching
                // what is already there. When a direction is standing that
                // means asking the performer to speak it — no second Director
                // call, which is the expensive half.
                continueLiveStep(getActiveScene());
                break;
            }
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
    // The compact dock blooms on hover. For the two selector controls, a
    // short intentional-hover delay opens their real menu as well; the delay
    // prevents a casual pointer pass across the composer from flashing menus.
    document.addEventListener('pointerover', (event) => {
        if (!isRealRoleplayWorkspaceActive() || !window.matchMedia('(hover: hover)').matches) return;

        const target = event.target instanceof Element ? event.target : null;
        const anchor = target?.closest('[data-remodel-rp-nextspeaker-menu], [data-remodel-scene-prompt-choice]');
        const root = getRealRoleplayRoot();
        if (!anchor || !root?.contains(anchor) || anchor.contains(event.relatedTarget)) return;

        clearTimeout(roleplayHoverMenuTimer);
        roleplayHoverMenuTimer = setTimeout(() => {
            if (!anchor.isConnected || !anchor.matches(':hover')) return;
            if (anchor.matches('[data-remodel-rp-nextspeaker-menu]')) {
                openRoleplayNextSpeakerMenu(anchor);
            } else {
                openScenePromptRecipeMenu(anchor);
            }
        }, 220);
    });

    document.addEventListener('pointerout', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const anchor = target?.closest('[data-remodel-rp-nextspeaker-menu], [data-remodel-scene-prompt-choice]');
        if (!anchor || anchor.contains(event.relatedTarget)) return;
        clearTimeout(roleplayHoverMenuTimer);
        roleplayHoverMenuTimer = null;
    });

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
            const tabButton = target.closest('[data-remodel-rp-preview-tab]');
            if (tabButton && previewOverlay.contains(tabButton)) {
                event.preventDefault();
                setRoleplayPreviewTab(previewOverlay, tabButton.dataset.remodelRpPreviewTab);
                return;
            }
            const viewButton = target.closest('[data-remodel-rp-preview-view]');
            if (viewButton && previewOverlay.contains(viewButton)) {
                event.preventDefault();
                // Scoped to the panel the button lives in, so the Director and
                // Narrator tabs keep their own view state.
                setRoleplayPreviewView(viewButton.closest('[data-remodel-rp-preview-panel]'), viewButton.dataset.remodelRpPreviewView);
                return;
            }
        }

        // Popover menu (persona / next-speaker / Director) lives in <body>, outside the
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
            if (!menu.contains(target) && !target.closest('[data-remodel-rp-persona-menu], [data-remodel-rp-nextspeaker-menu], [data-remodel-rp-director-menu], [data-remodel-scene-prompt-choice]')) {
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

        if (target.closest('[data-remodel-direction-dismiss]')) {
            event.preventDefault();
            // Removes the notice and nothing else. `pendingFailure` survives,
            // so Retry Direction is still available afterward — dismissing is
            // "I have read this", never "forget the failed pass".
            document.getElementById('remodel-direction-failure')?.remove();
            return;
        }
        if (target.closest('[data-remodel-direction-retry]')) {
            event.preventDefault();
            document.getElementById('remodel-direction-failure')?.remove();
            retryLiveDirection();
            return;
        }
        if (target.closest('[data-remodel-direction-bypass]')) {
            event.preventDefault();
            document.getElementById('remodel-direction-failure')?.remove();
            sendWithoutLiveDirection();
            return;
        }
        if (target.closest('[data-remodel-live-mode]')) {
            event.preventDefault();
            const scene = getActiveScene();
            setLiveDirectionEnabled(scene, !isDirectedLiveScene(scene));
            renderRoleplayComposer(root);
            return;
        }
        if (target.closest('[data-remodel-live-continue]')) {
            event.preventDefault();
            continueLiveDirection();
            return;
        }
        if (target.closest('[data-remodel-live-stop]')) {
            event.preventDefault();
            stopLiveDirection();
            return;
        }
        if (target.closest('[data-remodel-rp-scene-back]')) {
            event.preventDefault();
            setRoleplayCastOpen(root, false);
            transitionToWindow({ kind: 'tavern', tab: 'timeline' });
            return;
        }

        const castToggle = target.closest('[data-remodel-rp-cast-toggle]');
        if (castToggle) {
            event.preventDefault();
            setRoleplayCastOpen(root, !root.classList.contains('is-cast-open'));
            return;
        }

        const directorMenu = target.closest('[data-remodel-rp-director-menu]');
        if (directorMenu) {
            event.preventDefault();
            openRoleplayDirectorMenu(directorMenu);
            return;
        }

        if (root.classList.contains('is-cast-open')
            && !target.closest('[data-remodel-rp-cast]')) {
            setRoleplayCastOpen(root, false);
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

        const directionDismiss = target.closest('[data-remodel-direction-card-dismiss]');
        if (directionDismiss) {
            event.preventDefault();
            const recordId = directionDismiss.getAttribute('data-remodel-direction-card-dismiss');
            if (recordId && confirm('Discard this direction? Its notebook entries will be removed.')) {
                dismissDirectionRecord(getActiveScene(), recordId);
                document.getElementById('remodel-direction-failure')?.remove();
                renderRoleplayScene();
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

        // The Director plaque is deliberately inside the expanded Cast
        // roster: choosing a card here assigns the extension-only Director
        // seat. It does not make that card speak in native chat.
        const directorSeat = target.closest('[data-remodel-rp-director-seat]');
        if (directorSeat) {
            event.preventDefault();
            event.stopPropagation();
            const avatar = directorSeat.getAttribute('data-remodel-rp-director-seat');
            const scene = getActiveScene();
            const member = roleplaySceneMembers(getContext()).find(
                (item) => roleplayCharacterAvatar(item) === avatar,
            );
            if (!scene || !member) return;
            const currentId = scene.liveDirection?.directorRef?.id || '';
            const directorRef = currentId === avatar
                ? null
                : { kind: 'character', id: avatar, label: member.name };
            setSceneRoleplayDirector(scene.id, directorRef);
            clearLiveDirectionFailure();
            document.getElementById('remodel-direction-failure')?.remove();
            showRoleplayToast(directorRef
                ? `${member.name} is now the Roleplay Director.`
                : 'Roleplay Director seat cleared.');
            renderRoleplayScene();
            setRoleplayCastOpen(document.getElementById('remodel-roleplay-root'), true);
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

        if (event.key === 'Escape') {
            const root = getRealRoleplayRoot();
            if (root?.classList.contains('is-cast-open')) {
                event.preventDefault();
                setRoleplayCastOpen(root, false);
                return;
            }
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
            handleLiveDirectionDraft(input.value);
            return;
        }

        const rules = el.closest('[data-remodel-rp-rules]');
        if (rules instanceof HTMLTextAreaElement) {
            writeRoleplayRulesNotes(rules.value);
        }
    });
    document.addEventListener('change', (event) => {
        if (!isRealRoleplayWorkspaceActive()) return;
        const pacing = event.target instanceof Element ? event.target.closest('[data-remodel-live-pacing]') : null;
        if (pacing instanceof HTMLSelectElement) setLiveDirectionPacing(getActiveScene(), pacing.value);
        const mode = event.target instanceof Element ? event.target.closest('[data-remodel-live-mode]') : null;
        if (mode instanceof HTMLSelectElement) setLiveDirectionMode(getActiveScene(), mode.value);
        const extractor = event.target instanceof Element ? event.target.closest('[data-remodel-live-extractor]') : null;
        if (extractor instanceof HTMLSelectElement) setExtractionProfileId(extractor.value);
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
        if (!ownsLiveDirectionGeneration()) capturePromptLog('chat');
        setRoleplayGenerating(true);
        showRoleplayTypingIndicator();
    });

    const finish = () => {
        clearMechanicsReceiptInjection();
        if (ownsLiveDirectionGeneration() || getLiveDirectionRun()) {
            return;
        }
        if (!document.body.classList.contains('remodel-roleplay-generating')) {
            return;
        }
        // A directed Scene runs two generations back to back. This fires at the
        // end of the FIRST leg, so tearing the turn UI down here would drop the
        // typing indicator and re-render while the narrator is still to come.
        if (isStoryPipelineRunning()) {
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
        if (!ownsLiveDirectionGeneration()) updateRoleplayTypingText(text);
    });
}

function setRoleplayGenerating(on) {
    if (!on && isRealRoleplayWorkspaceActive()) {
        // Core's generateGroupWrapper() always calls select_group_chats()
        // before a group response. In native SillyTavern that merely changes
        // the right drawer's current page; Remodel adopts that page as a
        // full-screen editor, so it must be put away before the temporary
        // generating class (which hides it during the request) is removed.
        // A Cast/Group editor deliberately opened while idle is unaffected:
        // this cleanup runs only when an actual roleplay generation settles.
        const groupPanel = document.getElementById('rm_group_chats_block');
        if (groupPanel && getComputedStyle(groupPanel).display !== 'none') {
            selectRightMenuWithAnimation(null);
        }
    }
    document.body.classList.toggle('remodel-roleplay-generating', Boolean(on));
    if (!on) {
        removeRoleplayTypingIndicator();
    }
}

// The pending "someone is composing" bubble at the bottom of the stream.
// Guesses the upcoming speaker: in a group we can't know for sure until the
// message arrives, so it shows a neutral "…" until the first token names a
// speaker; in a solo scene it's the one character.
function showRoleplayTypingIndicator(forcedPerformer = null) {
    const root = getRealRoleplayRoot();
    const stream = root?.querySelector('[data-remodel-rp-stream]');
    if (!stream || stream.querySelector('.remodel-rp-typing')) {
        return;
    }

    const context = getContext();
    const scene = getActiveScene();
    const narratorId = scene?.liveDirection?.narratorRef?.id || '';
    // In a directed Scene the upcoming speaker is not a guess — it is the
    // Scene's bound Narrator. Without this, every call that could not name a
    // performer yet (the send handler's first paint, a stream rebuild during
    // generation, the hidden Director pass) fell through to the group's "we
    // cannot know" branch and drew a CHARACTER bubble labelled "Composing",
    // while the calls that did know a performer drew the Narrator's manuscript
    // byline. Same pending response, two completely different rows depending
    // on which code path happened to paint it.
    const performer = forcedPerformer
        || (narratorId && isDirectedLiveScene(scene)
            ? { label: scene.liveDirection.narratorRef.label, ref: scene.liveDirection.narratorRef, characterId: roleplayCharacterIdForAvatar(narratorId) }
            : null);

    const members = roleplaySceneMembers(context);
    const speaker = performer
        ? members.find((member) => member.characterId === performer.characterId) || null
        : (context.groupId ? null : members[0]);
    const name = performer?.label || speaker?.name || '';
    const color = name ? roleplaySpeakerColor(name) : null;

    const performerId = performer?.ref?.id || '';
    const isNarrator = Boolean(narratorId && performerId === narratorId);
    const row = document.createElement('div');
    row.className = `remodel-rp-msg remodel-rp-${isNarrator ? 'narrator' : 'character'} remodel-rp-typing`;
    // The revealing text must already be set as manuscript, or the prose visibly
    // reflows out of a bubble and into a page the instant the run settles.
    if (isNarrator) row.classList.add('remodel-rp-manuscript');
    if (color) {
        row.classList.add(`remodel-rp-color-${color}`);
    }

    const avatar = speaker
        ? buildRoleplayAvatar(name)
        : (() => { const d = document.createElement('div'); d.className = 'remodel-rp-avatar'; d.textContent = '…'; return d; })();
    if (!isNarrator) row.appendChild(avatar);

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

    const scene = getActiveScene();
    const narratorId = scene?.liveDirection?.narratorRef?.id || '';
    const speakerAvatar = roleplayCharacterAvatar({ name });
    const isBoundNarrator = !isUser && narratorId && speakerAvatar === narratorId;
    const kind = isUser ? 'user' : (isSystem || message.extra?.type === 'narrator' || isBoundNarrator ? 'narrator' : 'character');
    const color = kind === 'character' ? roleplaySpeakerColor(name) : null;
    // Narration is prose, not dialogue, so it is set like the Story document
    // rather than boxed in a speaker bubble. Scoped to the Scene's actual bound
    // Narrator and to text a directed run produced — a system notice or a dice
    // card is also `kind === 'narrator'` and is not manuscript.
    const isManuscript = !isSystem && (isBoundNarrator || Boolean(message.extra?.remodelDirection));

    const row = document.createElement('div');
    row.className = `remodel-rp-msg remodel-rp-${kind}`;
    if (isManuscript) row.classList.add('remodel-rp-manuscript');
    if (message.extra?.remodelDirection?.interrupted) row.classList.add('remodel-rp-interrupted');
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
    const source = sanitizeDirectionText(message.extra?.display_text ?? message.mes ?? '');
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
            const deleted = context.chat[mesId];
            const directionMeta = deleted?.extra?.remodelDirection;
            await context.deleteMessage(mesId);
            if (directionMeta && !deleted.is_user) {
                restoreStandingDirectionFromMessage(getActiveScene(), directionMeta);
            }
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
    const activeRoleplayScene = getActiveScene();
    // Written onto the native prompt rather than injected at a chat depth, so
    // the recipe's own ordering places it. See setRemodelNativePromptContent.
    setRemodelNativePromptContent('storyGoals', formatStoryGoalsPrompt(activeRoleplayScene));
    // Same mirroring as Story Goals above, under the Director's Notes source's
    // own native identifier (remodel_director_notes) — this call, not the
    // recipe editor, is what actually gets the Director's notebook into a real
    // Narrator generation. Reasoning-first: when the Director's raw thinking
    // tokens are stored for the latest turn, use them instead of the tagged
    // journal entries that contaminate Narrator prose.
    const latestTurn = readAllEntriesForOwner(activeRoleplayScene.timelineId, { sceneId: activeRoleplayScene.id })
        .reduce((highest, entry) => Math.max(highest, Number(entry.turn) || 0), 0);
    const storedReasoning = latestTurn > 0
        ? readTurnReasoning(activeRoleplayScene.timelineId, { sceneId: activeRoleplayScene.id, turn: latestTurn })
        : '';
    const reasoningBridge = frameDirectorReasoning(storedReasoning);
    setRemodelNativePromptContent('directorNotes', reasoningBridge || formatDirectorNotesPrompt(activeRoleplayScene));
    const stream = root.querySelector('[data-remodel-rp-stream]');
    if (!stream) {
        return;
    }
    stream.textContent = '';
    const liveRun = getLiveDirectionRun();

    const firstUserIndex = (context.chat || []).findIndex((message) => message?.is_user);
    const greetingBoundary = firstUserIndex < 0 ? context.chat.length : firstUserIndex;
    const mesEls = Array.from(chatEl?.querySelectorAll(':scope > .mes') ?? []).filter((mesEl) => {
        const mesId = Number(mesEl.getAttribute('mesid'));
        const message = context.chat[mesId];
        return !(isDirectedLiveScene(activeRoleplayScene)
            && mesId >= 0 && mesId < greetingBoundary
            && isLeakedNativeRoleplayGreeting(message));
    });

    if (mesEls.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'remodel-rp-empty';
        empty.textContent = 'The scene is set. Write the first line below to begin.';
        stream.appendChild(empty);
    } else {
        const pendingDirections = [...(Array.isArray(activeRoleplayScene?.liveDirection?.directionLog)
            ? activeRoleplayScene.liveDirection.directionLog
            : [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
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
            const messageTime = new Date(message.send_date || message.sendDate || 0).getTime();
            while (pendingDirections.length && Number.isFinite(messageTime)
                && new Date(pendingDirections[0].createdAt).getTime() <= messageTime) {
                stream.appendChild(buildRoleplayDirectionCard(pendingDirections.shift()));
            }
            const isHiddenLiveMessage = liveRun && !liveRun.acceptedComplete && !message.is_user && mesId === liveRun.messageId;
            if (!isHiddenLiveMessage) stream.appendChild(buildRoleplayMessage(mesId, message, { messagesSince }));
        });
        pendingDirections.forEach((record) => stream.appendChild(buildRoleplayDirectionCard(record)));
        // Land at the latest line, same as the manuscript's scroll-to-bottom.
        requestAnimationFrame(() => {
            stream.scrollTop = stream.scrollHeight;
        });
    }

    renderRoleplayHeader(root);
    renderRoleplayCast(root);
    renderRoleplayDirectionFeed(root, activeRoleplayScene);
    renderRoleplayComposer(root);
    decorateStoryGoalStream(root, getActiveScene());
    renderStoryGoalsForRoleplay(root, getActiveScene());
    ensureRoleplayPanels();

    // A stream rebuild wipes the (non-.mes-backed) typing indicator, and the
    // Director's live shell with it (stream.textContent = '' above). Put
    // whichever one belongs back, so a full rebuild mid-wait (switching tabs
    // away and back, say) doesn't drop back to the unlabeled bubble — the
    // SAME predicate refreshLiveDirectionChrome uses, shared rather than
    // restated, so the two cannot disagree about what is on screen.
    const chromeMode = resolveDirectionChromeMode({
        run: liveRun,
        uiState: getLiveDirectionUiState(activeRoleplayScene),
    });
    if (chromeMode === 'speaking') {
        showRoleplayTypingIndicator(liveRun.performer);
        updateRoleplayTypingText(liveRun.acceptedVisibleText || '');
    } else if (chromeMode === 'directing') {
        ensureDirectionStreamCard(root);
    } else if (document.body.classList.contains('remodel-roleplay-generating')) {
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
    ensureRoleplayStatePanel();
}

// Prior Text in roleplay reuses the ONE story Prior Text panel rather than a
// second instance (which would duplicate every data-* hook). A roleplay
// wrapper panel (.remodel-rp-panel, slide-in from the right like Rules/Dice)
// hosts the shared body; the story panel's own inner markup is relocated in
// and out of it via getOriginalPanelHomes(), the same origin-tracking used
// for the hamburger/wand relocation — so exactly one prior-text body lives in
// the DOM at a time, and refreshPriorTextPanel()/handlers stay unchanged.
/**
 * The Timeline State panel on the roleplay rail.
 *
 * Unlike Prior Scene Text this does not relocate a shared DOM node between the
 * two rails: its view state lives in variables-ui.js, not in the markup, so both
 * rails can render the same body independently and stay in agreement. Nothing to
 * move means nothing to orphan when a workspace tears down.
 */
function ensureRoleplayStatePanel() {
    if (!isRealRoleplayWorkspaceActive()) {
        return;
    }
    let panel = document.getElementById('remodel-rp-state-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'remodel-rp-state-panel';
        panel.className = 'remodel-rp-panel remodel-rp-state-panel';
        panel.innerHTML = `
            <div class="remodel-rp-panel-head">
                <span class="remodel-rp-panel-title"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Timeline State</span>
                <button type="button" class="remodel-rp-panel-close" data-remodel-rp-panel-close="state" title="Close" aria-label="Close">×</button>
            </div>
            <div class="remodel-rp-panel-body">${buildVariableStateBodyMarkup()}</div>
        `;
        getRealSheld()?.appendChild(panel);
    }
    refreshVariableLore().then(refreshVariableStateSurfaces);
}

/**
 * Repaint every mounted Variables surface — both rails and any expanded
 * Lorebook entry. Swaps inner markup rather than re-rendering the workspace,
 * following refreshDebugConsoleWorkspace, so an open drawer does not flicker.
 */
function refreshVariableStateSurfaces() {
    for (const host of document.querySelectorAll('[data-remodel-varstate]')) {
        host.innerHTML = renderVariableStateInner();
    }
    for (const host of document.querySelectorAll('[data-remodel-varlink]')) {
        const { book, uid } = host.dataset;
        host.innerHTML = renderLinkedVariablesSection({ book, uid });
    }
    // The Codex owns its whole layout, so it is replaced rather than patched.
    for (const host of document.querySelectorAll('[data-remodel-varcodex]')) {
        host.outerHTML = renderVariableCodex();
    }
}

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
        <button type="button" class="remodel-rp-panel-icon" data-remodel-rp-panel-toggle="state" title="Timeline State" aria-label="Timeline State">
            <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>
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
    state: 'remodel-rp-state-panel',
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
        // Lore lists are read asynchronously, so repaint once they land rather
        // than showing an editor that thinks every entry is missing.
        if (which === 'state') {
            refreshVariableLore().then(refreshVariableStateSurfaces);
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

    const context = getContext();
    const members = roleplaySceneMembers(context);
    const scene = getActiveScene();
    const directorId = scene?.liveDirection?.directorRef?.id || '';
    const narratorId = scene?.liveDirection?.narratorRef?.id || '';
    const speakingName = roleplayCurrentSpeakerName(context);
    // A two-seat Scene's cast is not a list that happens to have two entries —
    // it is two named jobs. Both seats were bound when the Scene was cast, so
    // there is nothing to assign, add, remove, or reorder here.
    const duet = isDuetScene(scene);

    const label = document.createElement('div');
    label.className = 'remodel-rp-cast-label';
    label.textContent = duet ? 'Seats' : 'Cast';
    cast.appendChild(label);

    // Remove + reorder are only meaningful in a group with more than one
    // member (a scene needs at least one character; order matters for the
    // group's turn/activation ordering).
    const isMultiMemberGroup = Boolean(context.groupId) && members.length > 1;
    const canRemove = isMultiMemberGroup && !duet;
    const canReorder = isMultiMemberGroup && !duet;

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

        if (duet) {
            // Fixed badges. The seat is a property of the Scene, so it reads as
            // a statement of what this card IS, not a control that might move.
            const seat = avatar === directorId ? 'director' : (avatar === narratorId ? 'narrator' : '');
            if (seat) {
                const badge = document.createElement('span');
                badge.className = `remodel-rp-seat-badge remodel-rp-seat-${seat}`;
                badge.innerHTML = seat === 'director'
                    ? '<i class="fa-solid fa-clapperboard" aria-hidden="true"></i><span>Director</span>'
                    : '<i class="fa-solid fa-microphone-lines" aria-hidden="true"></i><span>Narrator</span>';
                badge.title = seat === 'director'
                    ? `${member.name} directs this scene and never speaks in it.`
                    : `${member.name} performs every visible line in this scene.`;
                chip.classList.add(`is-seat-${seat}`);
                chip.appendChild(badge);
            }
        } else if (avatar && avatar !== narratorId) {
            const director = document.createElement('button');
            director.type = 'button';
            director.className = 'remodel-rp-director-plaque';
            director.dataset.remodelRpDirectorSeat = avatar;
            director.title = directorId === avatar ? `${member.name} is the Roleplay Director — click to clear` : `Make ${member.name} the Roleplay Director`;
            director.setAttribute('aria-pressed', String(directorId === avatar));
            director.innerHTML = directorId === avatar
                ? '<i class="fa-solid fa-clapperboard" aria-hidden="true"></i><span>Roleplay Director</span>'
                : '<i class="fa-solid fa-clapperboard" aria-hidden="true"></i><span>Direct</span>';
            chip.classList.toggle('is-roleplay-director', directorId === avatar);
            chip.appendChild(director);
        } else if (avatar === narratorId) {
            const performer = document.createElement('span');
            performer.className = 'remodel-rp-performer-plaque';
            performer.innerHTML = '<i class="fa-solid fa-microphone-lines" aria-hidden="true"></i><span>Visible Narrator</span>';
            chip.appendChild(performer);
        }

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

    // A two-seat Scene has no third seat to add a card to. Offering "+" here
    // would promote the group to three members and hand the extra card to
    // native activation, which is precisely the shape this model removes.
    if (duet) {
        return;
    }

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

function renderRoleplayDirectionFeed(root, scene) {
    // Director selection belongs exclusively to the expanded Cast roster.
    // Direction records themselves are inserted chronologically into the
    // roleplay stream, so no detached floating Director bar is rendered.
}

function buildRoleplayDirectionCard(record) {
    const row = document.createElement('article');
    row.className = 'remodel-rp-msg remodel-rp-direction-stream-card';
    row.dataset.remodelDirectionId = record.id;
    const beats = record.constraints?.length
        ? `<ul>${record.constraints.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
        : '';
    const openings = record.openings?.length
        ? `<span><i class="fa-regular fa-lightbulb"></i> ${record.openings.map((item) => escapeHtml(item.label)).join(' · ')}</span>`
        : '';
    const mechanicalCount = Number(record.immediateCount || 0) + Number(record.checkpointCount || 0);
    const trace = record.decisionTrace || {};
    const traceItems = [
        ...(trace.observations || []).map((item) => `<li><span>Observed</span>${escapeHtml(item)}</li>`),
        ...(trace.intent ? [`<li><span>Intent</span>${escapeHtml(trace.intent)}</li>`] : []),
        ...(trace.performerReason ? [`<li><span>Performer</span>${escapeHtml(trace.performerReason)}</li>`] : []),
    ].join('');
    // Each section folds independently so the card stays a one-line summary
    // until you want the detail behind it.
    const operations = Array.isArray(record.operations) ? record.operations : [];
    const operationsSection = operations.length
        // "on accept" is stated once here, not per line: every operation in
        // this list applies under the same rule (see finalizeRunMessage), so
        // repeating it per row carried no information, only noise.
        ? `<details class="remodel-rp-direction-section">
            <summary><i class="fa-solid fa-gears"></i> What it changed · applied on accept <b>${operations.length}</b></summary>
            <ul class="remodel-rp-direction-ops">
                ${operations.map((op) => `<li>
                    <code>${escapeHtml(op.capability)}</code>
                    ${op.reason ? `<span>${escapeHtml(op.reason)}</span>` : ''}
                </li>`).join('')}
            </ul>
        </details>`
        : (mechanicalCount
            ? `<details class="remodel-rp-direction-section"><summary><i class="fa-solid fa-gears"></i> What it changed <b>${mechanicalCount}</b></summary><p class="remodel-rp-direction-note">Recorded before per-operation detail was captured, so only the count survives for this one.</p></details>`
            : '');
    const traceSection = traceItems
        ? `<details class="remodel-rp-direction-section">
            <summary><i class="fa-solid fa-diagram-project"></i> Decision trace</summary>
            <p class="remodel-rp-direction-note">The Director's own declared rationale — a summary it wrote for you, not its private thinking.</p>
            <ul class="remodel-rp-direction-trace-list">${traceItems}</ul>
        </details>`
        : '';
    const reasoning = String(record.reasoning || '').trim();
    const reasoningSection = reasoning
        ? `<details class="remodel-rp-direction-section is-reasoning">
            <summary><i class="fa-solid fa-brain"></i> Raw reasoning</summary>
            <p class="remodel-rp-direction-note">Unedited chain-of-thought as the model returned it.</p>
            <pre class="remodel-rp-direction-reasoning">${escapeHtml(reasoning)}</pre>
        </details>`
        : '';
    const beatsSection = beats
        ? `<details class="remodel-rp-direction-section" open>
            <summary><i class="fa-solid fa-list-ol"></i> Beats for ${escapeHtml(record.performerLabel || 'the performer')}</summary>
            ${beats}
        </details>`
        : '';

    row.innerHTML = `<div class="remodel-rp-direction-stream-inner">
        <header><span class="remodel-rp-direction-badge"><i class="fa-solid fa-clapperboard"></i> Roleplay Director</span><strong>${escapeHtml(record.directorLabel || 'Game Director')}</strong><small>${escapeHtml(formatRoleplayTime(record.createdAt))}</small><button type="button" class="remodel-rp-direction-dismiss" data-remodel-direction-card-dismiss="${escapeAttribute(record.id)}" title="Discard this direction and its notebook entries" aria-label="Discard direction"><i class="fa-solid fa-xmark"></i></button></header>
        <p>${escapeHtml(record.objective)}</p>
        ${beatsSection}
        ${operationsSection}
        ${traceSection}
        ${reasoningSection}
        <footer><span>Directing ${escapeHtml(record.performerLabel || 'the next performer')}</span>${openings}${record.hardPauseAfter ? '<span><i class="fa-solid fa-hand"></i> Hard pause</span>' : ''}</footer>
    </div>`;
    return row;
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
        if (!chip || (event.target instanceof Element && event.target.closest('[data-remodel-rp-cast-remove], [data-remodel-rp-director-seat]'))) {
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
