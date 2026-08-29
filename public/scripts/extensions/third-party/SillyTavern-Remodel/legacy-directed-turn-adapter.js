import {
    continueLiveStep,
    getLiveDirectionRun,
    getLiveDirectionUiState,
    handleLiveDirectionDraft,
    initLiveDirection,
    recoverLiveDirection,
    rerunDirectedRoleplayFromUserMessage,
    retryLiveDirection,
    retryLiveStep,
    stopLiveDirection,
    submitDirectedRoleplay,
} from './live-direction.js';
import { createDirectedTurnController } from './directed-turn-controller.js';

/** Stable rollback implementation. */
export const legacyDirectedTurnAdapter = Object.freeze({
    initialize: initLiveDirection,
    getRun: getLiveDirectionRun,
    getUiState: getLiveDirectionUiState,
    start: (options) => submitDirectedRoleplay({ ...options, deliveryMode: 'legacy' }),
    continue: (scene) => continueLiveStep(scene, { deliveryMode: 'legacy' }),
    retry: (scene) => retryLiveStep(scene, { deliveryMode: 'legacy' }),
    retryFailure: retryLiveDirection,
    stop: stopLiveDirection,
    interrupt: handleLiveDirectionDraft,
    editAndRerun: (options) => rerunDirectedRoleplayFromUserMessage({ ...options, deliveryMode: 'legacy' }),
    recover: recoverLiveDirection,
});

/** Commit 3 implementation: shared orchestration, rebuilt canonical delivery. */
export const canonicalDirectedTurnAdapter = Object.freeze({
    ...legacyDirectedTurnAdapter,
    start: (options) => submitDirectedRoleplay({ ...options, deliveryMode: 'canonical' }),
    continue: (scene) => continueLiveStep(scene, { deliveryMode: 'canonical' }),
    retry: (scene) => retryLiveStep(scene, { deliveryMode: 'canonical' }),
    editAndRerun: (options) => rerunDirectedRoleplayFromUserMessage({ ...options, deliveryMode: 'canonical' }),
});

// This branch exists to build and run the rebuilt pipeline, so canonical is not
// a per-Scene choice here: it is what this branch is. The legacy adapter is
// kept intact and callable as the rollback path, which is a branch switch, not
// a runtime toggle.
function implementationFor() {
    return canonicalDirectedTurnAdapter;
}

/** The Scene chooses at one seam; the UI and controller know neither engine. */
export const routedDirectedTurnAdapter = Object.freeze({
    initialize: legacyDirectedTurnAdapter.initialize,
    getRun: legacyDirectedTurnAdapter.getRun,
    getUiState: legacyDirectedTurnAdapter.getUiState,
    start: (options) => implementationFor(options?.scene).start(options),
    continue: (scene) => implementationFor(scene).continue(scene),
    retry: (scene) => implementationFor(scene).retry(scene),
    retryFailure: legacyDirectedTurnAdapter.retryFailure,
    stop: legacyDirectedTurnAdapter.stop,
    interrupt: legacyDirectedTurnAdapter.interrupt,
    editAndRerun: (options) => implementationFor(options?.scene).editAndRerun(options),
    recover: legacyDirectedTurnAdapter.recover,
});

export const directedTurnController = createDirectedTurnController(routedDirectedTurnAdapter);
