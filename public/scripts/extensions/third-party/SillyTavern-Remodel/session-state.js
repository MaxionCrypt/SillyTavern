// session-state.js — ephemeral, non-persisted UI/session state for the
// Remodel extension. Mirrors timeline-state.js's module-private-store
// convention (module-scoped data + exported functions as the only surface)
// but for state that must NOT survive a reload and must NOT go through
// context.saveSettingsDebounced().
//
// Every domain below is chat-scoped: its resetX() is called unconditionally
// on every CHAT_CHANGED/CHAT_LOADED via resetAllChatScopedState(), so a
// future field has nowhere to go except inside a domain that already gets
// reset. UI-nav state that must NOT reset on chat change (currentWindow,
// activeTavernTab, etc.) does not belong in this file's chat-scoped domains
// — see the plan for where it lands in a later increment.
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

// --- Chat-scoped reconciliation ---------------------------------------------
//
// setCharacterId is threaded through here only because resetPastChatsBridge
// needs it — every other domain's reset is a pure state operation.
export function resetAllChatScopedState(setCharacterId) {
    resetGenerationState();
    resetWizardState();
    resetPastChatsBridge(setCharacterId);
}
