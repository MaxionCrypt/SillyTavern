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

/** The sole binding between the public turn contract and the legacy engine. */
export const legacyDirectedTurnAdapter = Object.freeze({
    initialize: initLiveDirection,
    getRun: getLiveDirectionRun,
    getUiState: getLiveDirectionUiState,
    start: submitDirectedRoleplay,
    continue: continueLiveStep,
    retry: retryLiveStep,
    retryFailure: retryLiveDirection,
    stop: stopLiveDirection,
    interrupt: handleLiveDirectionDraft,
    editAndRerun: rerunDirectedRoleplayFromUserMessage,
    recover: recoverLiveDirection,
});

export const directedTurnController = createDirectedTurnController(legacyDirectedTurnAdapter);
