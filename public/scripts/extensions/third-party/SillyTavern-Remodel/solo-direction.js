const DIRECTION_PROTOCOL = 'remodel-direction/1';

function createId(prefix) {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/** True only when the Scene has explicitly opted into single-agent (solo) mode. */
export function isSoloMode(scene) {
    return scene?.liveDirection?.mode === 'solo';
}

/**
 * Solo mode produces a turn with no separate Director call. The Narrator is the
 * one mind; a minimal envelope keeps the shared turn machinery (performer,
 * reveal, finalize, extraction) unchanged. The turn pauses for the user
 * afterward; the mechanics snapshot rides along so Pass 2 extraction can
 * advertise and resolve Variables/Goals against the same address book.
 *
 * @returns {{ envelope: object, storedTurn: null }}
 */
export function soloEnvelope(scene, snapshot, turn) {
    return {
        storedTurn: null,
        envelope: {
            protocol: DIRECTION_PROTOCOL,
            directionId: createId('direction'),
            notebookTurn: turn,
            reasoning: '',
            flow: { continueAfter: false, hardPauseAfter: true },
            requests: [],
            mechanicsSnapshot: snapshot.mechanics,
        },
    };
}
