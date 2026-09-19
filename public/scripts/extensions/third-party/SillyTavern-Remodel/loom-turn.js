const DIRECTION_PROTOCOL = 'remodel-direction/1';

function createId(prefix) {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/** True when the Scene uses a native Narrator followed by Loom reconciliation. */
export function isLoomMode(scene) {
    return scene?.liveDirection?.mode === 'loom';
}

/**
 * Loom mode starts with one native Narrator generation. A minimal envelope
 * keeps the shared turn machinery (performer, reveal, reconciliation and
 * finalize) unchanged.
 *
 * @returns {{ envelope: object, storedTurn: null }}
 */
export function createLoomTurnEnvelope(scene, snapshot, turn) {
    return {
        storedTurn: null,
        envelope: {
            protocol: DIRECTION_PROTOCOL,
            directionId: createId('direction'),
            notebookTurn: turn,
            reasoning: '',
            flow: { continueAfter: false, hardPauseAfter: true },
            currentPlayerAction: String(snapshot.currentPlayerAction || ''),
            archiveProjection: snapshot.archiveProjection,
        },
    };
}
