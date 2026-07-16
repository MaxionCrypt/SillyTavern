// session-state.js — ephemeral, non-persisted UI/session state for the
// Remodel extension. Mirrors timeline-state.js's module-private-store
// convention (module-scoped data + exported functions as the only surface)
// but for state that must NOT survive a reload and must NOT go through
// context.saveSettingsDebounced().
//
// Every domain below except `session` is chat-scoped: its resetX() is
// called unconditionally on every CHAT_CHANGED/CHAT_LOADED via
// resetAllChatScopedState(), so a future field has nowhere to go except
// inside a domain that already gets reset. UI-nav state that must NOT reset
// on chat change (currentWindow, activeTavernTab, etc.) lives in the
// `session` domain below instead, which resetAllChatScopedState()
// deliberately never touches.
//
// Nothing outside this file can reach the raw state objects below — they
// are never exported. Getters return frozen shallow copies, so a caller
// that tries to mutate a getter's return value gets a thrown TypeError
// (ES modules are always strict mode) instead of a silent no-op.

// --- Generation-tracking domain --------------------------------------------
//
// isGenerating: optimistic UI flag — drives disabled buttons + the loading
// spinner. Set directly (via setGenerating) by call sites that trigger their
// own generation and guard themselves with try/finally (auto-continue,
// Regenerate) BEFORE the real GENERATION_STARTED event arrives — this is a
// deliberate two-step sequence, not an oversight: the optimistic flag makes
// the button disable instantly, while runIsOurs (below) is only ever
// claimed by the GENERATION_STARTED handler itself.
//
// runIsOurs: true only while THIS extension's own story-turn tracking
// claims ownership of the in-flight generation. GENERATION_STARTED/ENDED/
// STOPPED fire for EVERY generation on the page (quiet/background calls
// too) — this flag is what lets ENDED/STOPPED tell "a story turn we
// started" apart from "some unrelated generation elsewhere finished."
//
// watchdog: timeout handle that force-clears isGenerating if neither
// GENERATION_ENDED nor GENERATION_STOPPED ever arrives (a real gap in core:
// an exception thrown before the request starts skips both events).
const generation = {
    isGenerating: false,
    runIsOurs: false,
    watchdog: null,
    autoContinue: { status: 'idle' }, // 'idle' | 'playing' | 'paused'
    autoContinueTurnIsFirst: true,
};

export function getGenerationState() {
    return Object.freeze({ ...generation, autoContinue: { ...generation.autoContinue } });
}

// Optimistic UI-only flag. Does NOT claim run ownership — see domain
// comment above. Used by call sites that trigger their own generation and
// guard themselves with try/finally.
export function setGenerating(value) {
    generation.isGenerating = value;
}

// The real "this run is ours" claim, made only by the GENERATION_STARTED
// handler. Also flips isGenerating, matching that handler's original
// combined assignment.
export function beginOwnedGenerationRun() {
    generation.runIsOurs = true;
    generation.isGenerating = true;
}

// The real "this run is over" release, made only by the GENERATION_ENDED/
// STOPPED handlers once they've confirmed the run was ours.
export function endOwnedGenerationRun() {
    generation.runIsOurs = false;
    generation.isGenerating = false;
}

export function isGenerationRunOurs() {
    return generation.runIsOurs;
}

export function armGenerationWatchdog(onFire, ms) {
    clearTimeout(generation.watchdog);
    generation.watchdog = setTimeout(onFire, ms);
}

export function clearGenerationWatchdog() {
    clearTimeout(generation.watchdog);
    generation.watchdog = null;
}

export function setAutoContinueStatus(status) {
    generation.autoContinue = { status };
}

export function setAutoContinueTurnIsFirst(value) {
    generation.autoContinueTurnIsFirst = value;
}

// All 5 siblings together. This is the function whose predecessor's
// partial-reset bug (storyGenerationRunIsOurs/watchdog not reset alongside
// storyIsGenerating) let a stale, late-arriving GENERATION_ENDED from an
// abandoned chat mutate button state for whatever chat became active by the
// time it arrived. A 6th generation-domain field now has nowhere to live
// except inside this same object and this same reset.
export function resetGenerationState() {
    generation.isGenerating = false;
    generation.runIsOurs = false;
    clearTimeout(generation.watchdog);
    generation.watchdog = null;
    generation.autoContinue = { status: 'idle' };
    generation.autoContinueTurnIsFirst = true;
}

// --- Guided Story-Scene creation wizard domain ------------------------------
//
// sceneCreationFlow: { sceneId, step: 'choose-character' | 'choose-persona',
// chosenCharacterId } while the wizard is active, null otherwise. Separate
// from currentWindow (a later increment's session domain) — this tracks
// wizard progress, which drives transitionToWindow calls as a side effect
// but isn't itself a Window kind.
const wizard = { sceneCreationFlow: null };

export function getWizardState() {
    return Object.freeze({
        sceneCreationFlow: wizard.sceneCreationFlow ? { ...wizard.sceneCreationFlow } : null,
    });
}

export function beginWizard(sceneId) {
    wizard.sceneCreationFlow = { sceneId, step: 'choose-character', chosenCharacterId: null };
}

// Replaces (never mutates in place) — the wizard's flow object moves from
// 'choose-character' to 'choose-persona' as a new object, not a patched one.
export function advanceWizardToPersonaStep(chosenCharacterId) {
    if (!wizard.sceneCreationFlow) {
        return;
    }
    wizard.sceneCreationFlow = { ...wizard.sceneCreationFlow, chosenCharacterId, step: 'choose-persona' };
}

// Returns the flow's {sceneId, chosenCharacterId} and clears it in the same
// step — mirrors the original finishStoryGuidedCreation's destructure-then-
// null pattern so completing the wizard can't leave a stale flow behind.
export function consumeWizardFlow() {
    const flow = wizard.sceneCreationFlow;
    wizard.sceneCreationFlow = null;
    return flow;
}

export function resetWizardState() {
    wizard.sceneCreationFlow = null;
}

// --- Character-viewing / past-chats bridge domain ---------------------------
//
// viewedCharacterId: which character's editor panel is open, set the moment
// a character card is clicked for viewing/editing only — never activates a
// chat with them (see selectCharacterForEditingOnly's call site in
// timeline-spine.js). weSetThisChid: true only while THIS bridge is the one
// that temporarily set this_chid, so clearing it can never clobber a
// genuinely active chat's real this_chid. Exists to bridge the gap between
// "viewing a character's sheet" (which never touches this_chid here) and
// core's native "Manage chat files" delete/rename flow, which assumes
// this_chid is already set by the time it runs. setCharacterId is core's
// own function, passed in by the caller rather than imported here — this
// module stays a pure state container with no core/DOM dependencies, same
// as timeline-state.js.
const pastChatsBridge = { viewedCharacterId: null, weSetThisChid: false };

export function getPastChatsBridgeState() {
    return Object.freeze({ ...pastChatsBridge });
}

// Called the instant a character sheet is opened for viewing only.
export function noteViewingCharacterForPastChats(characterId) {
    pastChatsBridge.viewedCharacterId = characterId;
}

// Called by the #option_select_chat capture hook right before letting the
// native handler run, only when there's no genuinely active chat yet.
// Returns whether it actually bridged anything, so the call site doesn't
// need to re-derive the guard.
export function bridgeThisChidForPastChats(setCharacterId) {
    if (pastChatsBridge.viewedCharacterId === null) {
        return false;
    }
    setCharacterId(pastChatsBridge.viewedCharacterId);
    pastChatsBridge.weSetThisChid = true;
    return true;
}

// The ONE function every backstop site calls to tear the bridge down —
// idempotent, safe to call redundantly. Only clears this_chid if THIS
// bridge is the one that set it.
export function clearPastChatsBridge(setCharacterId) {
    if (pastChatsBridge.weSetThisChid) {
        setCharacterId(undefined);
    }
    pastChatsBridge.weSetThisChid = false;
    pastChatsBridge.viewedCharacterId = null;
}

export function resetPastChatsBridge(setCharacterId) {
    clearPastChatsBridge(setCharacterId);
}

// --- Session / UI-navigation domain -----------------------------------------
//
// Ephemeral on-screen-UI state that is explicitly NOT chat-scoped — this is
// the one domain resetAllChatScopedState() below deliberately never touches,
// because switching chats should not force-close an open Timeline drawer,
// collapse an open Tab, or discard an in-progress "create timeline" draft.
// Mirrors reconcileStateOnCoreChange()'s field-by-field "EXEMPT" comments in
// timeline-spine.js.
//
// initialized: guards initTimelineSpine() against double-init.
//
// renderQueued: rAF-batches queueRender() calls so a burst of state changes
// collapses into a single render.
//
// activeTavernTab: which Tavern-drawer tab ('timeline' | 'characters' | ...)
// is currently showing.
//
// focusedTimelineId: which Timeline is expanded/focused within the Timeline
// tab, null when showing the deck view.
//
// createModalOpen / createModalDraft: whether the "create timeline" modal is
// open, and its in-progress {title, description, thumbnail} draft.
//
// characterSearchQuery / characterSortMode: Characters-tab search filter
// text and sort mode.
//
// renamingSceneId: which scene row is mid-inline-rename, null otherwise.
//
// adoptedPanel: which native panel (Personas/WorldInfo) has been DOM-adopted
// into the Tavern drawer, null when nothing is adopted.
//
// tavernPanelObserver: MutationObserver watching the drawer's open/closed
// class, so external drawer closes (via SillyTavern's own doNavbarIconClick)
// can be reconciled back into currentWindow.
//
// currentWindow: single source of truth for what's on screen —
// { kind: 'native' } or { kind: 'tavern', tab }. Only transitionToWindow()
// (in timeline-spine.js) may assign to this; setCurrentWindow exists only
// for that one call site, not as a general-purpose setter.
//
// suppressDrawerObserver: reentrancy guard set true only while our own code
// is driving doNavbarIconClick, so tavernPanelObserver's mutation callback
// doesn't mistake our own drawer toggle for an externally-triggered close.
//
// originalPanelHomes is deliberately kept OUTSIDE this object — see the
// comment above its declaration below.
const session = {
    initialized: false,
    renderQueued: false,
    activeTavernTab: 'timeline',
    focusedTimelineId: null,
    createModalOpen: false,
    createModalDraft: { title: '', description: '', thumbnail: null },
    characterSearchQuery: '',
    characterSortMode: 'name-asc',
    renamingSceneId: null,
    adoptedPanel: null,
    tavernPanelObserver: null,
    currentWindow: { kind: 'native' },
    suppressDrawerObserver: false,
};

// originalPanelHomes: maps an adopted panel back to its original DOM
// {parent, nextSibling}, so restoreAdoptedPanel() can put it back where it
// came from. Deliberately NOT a field on `session` above and deliberately
// NOT covered by getSessionState()'s frozen-copy pattern: it's a Map, and
// Object.freeze is shallow, so freezing a copy of an object that merely
// *holds a reference* to this Map would freeze the reference, not the Map's
// contents — callers would still be able to .set()/.get()/.delete() on it
// through that "frozen" copy. Rather than ship a getter whose "frozen"
// guarantee is fake for this one field, this is a documented, deliberate
// exception: getOriginalPanelHomes() hands back the live Map on purpose.
const originalPanelHomes = new Map();

export function getSessionState() {
    return Object.freeze({ ...session });
}

// Deliberate exception to the frozen-copy pattern — see the comment above
// originalPanelHomes' declaration. Returns the live, mutable Map itself
// (not frozen, not copied) because call sites need to .set()/.get()/.has()/
// .delete() on it directly.
export function getOriginalPanelHomes() {
    return originalPanelHomes;
}

export function setInitialized(value) {
    session.initialized = value;
}

export function setRenderQueued(value) {
    session.renderQueued = value;
}

export function setActiveTavernTab(value) {
    session.activeTavernTab = value;
}

export function setFocusedTimelineId(value) {
    session.focusedTimelineId = value;
}

export function setCreateModalOpen(value) {
    session.createModalOpen = value;
}

export function setCreateModalDraft(value) {
    session.createModalDraft = value;
}

export function setCharacterSearchQuery(value) {
    session.characterSearchQuery = value;
}

export function setCharacterSortMode(value) {
    session.characterSortMode = value;
}

export function setRenamingSceneId(value) {
    session.renamingSceneId = value;
}

export function setAdoptedPanel(value) {
    session.adoptedPanel = value;
}

export function setTavernPanelObserver(value) {
    session.tavernPanelObserver = value;
}

// Only transitionToWindow() (timeline-spine.js) may call this — see the
// currentWindow field comment in the session domain doc block above.
export function setCurrentWindow(value) {
    session.currentWindow = value;
}

export function setSuppressDrawerObserver(value) {
    session.suppressDrawerObserver = value;
}

// --- Chat-scoped reconciliation ---------------------------------------------
//
// setCharacterId is threaded through here only because resetPastChatsBridge
// needs it — every other domain's reset is a pure state operation.
//
// The `session` domain above is intentionally NOT reset here. It holds
// on-screen-UI state (currentWindow, activeTavernTab, focusedTimelineId,
// etc.) that is orthogonal to which chat is loaded — e.g. switching chats
// while the Tavern drawer is open should not force-close it, and switching
// chats mid-rename shouldn't kick a scene out of its rename input. See the
// `session` domain's own doc comment above, and reconcileStateOnCoreChange()'s
// field-by-field "EXEMPT" comments in timeline-spine.js, for the reasoning.
export function resetAllChatScopedState(setCharacterId) {
    resetGenerationState();
    resetWizardState();
    resetPastChatsBridge(setCharacterId);
}
