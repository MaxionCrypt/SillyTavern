// Which of the three Roleplay-stream chrome states a directed Scene is in.
//
// PURE — no imports, so the branch can be asserted offline. It is extracted
// rather than left inline because it is the branch that shipped a defect: two
// callers in timeline-spine.js (refreshLiveDirectionChrome and
// renderRoleplayScene's tail) each decided it by hand, one of them wrongly,
// and neither could be reached by a test — timeline-spine.js touches the DOM
// at module scope through its imports.
//
// THE DEFECT, so it is not reintroduced: `refreshLiveDirectionChrome` asked
// `!run && uiState.state === 'Directing'`. But live-direction.js's
// `notifyTransient('Directing')` — the call that opens a pass — passes a
// TRUTHY placeholder `{state, acceptedVisibleText}` rather than null, and
// `handleRoleplaySend` hand-rolled the same shape. So `!run` was false on
// exactly the calls that meant "a Loom pass just started", the Loom
// indicator was CLOSED, and the generic unlabeled "composing…" bubble went up
// instead. The indicator then only ever opened from renderRoleplayScene's tail,
// whose only trigger during a pass is USER_MESSAGE_RENDERED — a first-attempt
// user send. Autoplay continuations, Next, Retry after a failure that had
// already posted, and the empty-response retry all showed nothing
// Loom-specific for the whole 101-202s call.
//
// The fix is to stop asking "is there a run object?" and start asking "is
// there a RUN?" — which the placeholder cannot answer yes to, because only a
// real run carries a `directionId`.

/**
 * @param {object|null} [run] whatever the caller has: `getLiveDirectionRun()`'s
 *        real run, `null`, or one of the transient
 *        `{state, acceptedVisibleText}` placeholders described above.
 * @param {{state?: string}|null} [uiState] `getLiveDirectionUiState(scene)`.
 *        Authoritative for the hidden phase — it reads the direction lock
 *        directly, so it says 'Directing' for the whole window in which no
 *        visible run exists yet.
 * @returns {'speaking'|'directing'|'idle'}
 *        - `speaking`: a real run is revealing prose. The performer's typing
 *          indicator belongs on screen.
 *        - `directing`: a hidden Loom pass is out and has produced no run
 *          yet. The Loom's own streaming shell belongs on screen.
 *        - `idle`: neither. Both surfaces come down; a plain generating
 *          indicator (free play) is the caller's business, not this one's.
 */
/**
 * What Retry and Continue mean right now.
 *
 * Two verbs, and the difference between them is the whole point:
 *
 * - **Retry** re-runs the last turn IN PLACE — deletes the committed message and
 *   undoes what it recorded, then does it again. It never appends.
 * - **Continue** advances to the next turn. It never touches what is there.
 *
 * In Loom mode a turn's only trace is its committed Narrator message, so the
 * step is read straight off the chat: if the last message is a directed response
 * it can be retried; either way the next turn can be run.
 *
 * PURE, and separated from the store queries that answer its inputs.
 *
 * @param {{lastMessageIsUser?: boolean, hasMessages?: boolean, busy?: boolean,
 *          resumable?: boolean}} [input]
 * @returns {{retry: {target: 'narrator'|null, reason: string},
 *            continue: {target: 'loom'|'resume'|null, reason: string}}}
 *          `target` is null when the action cannot do anything, and `reason`
 *          says why — a disabled button that cannot explain itself is the
 *          thing this return shape exists to prevent.
 */
export function resolveDirectionActions({
    lastMessageIsUser = false, hasMessages = false, busy = false, resumable = false,
} = {}) {
    // A reveal that is holding — for a breath, for the user's typing, or at the
    // end of a turn — is "busy" by every other measure, but it is precisely the
    // moment Continue must work. There is only ONE Continue control now, so if
    // it went inert here the user would have no way to resume a held reveal at
    // all. Checked BEFORE busy for that reason.
    if (resumable) {
        return {
            retry: { target: null, reason: 'Let this response finish first.' },
            continue: { target: 'resume', reason: 'Resume the reveal.' },
        };
    }
    if (busy) {
        return {
            retry: { target: null, reason: 'Something is already running.' },
            continue: { target: null, reason: 'Something is already running.' },
        };
    }
    if (hasMessages && !lastMessageIsUser) {
        return {
            retry: { target: 'narrator', reason: 'Replace the last response.' },
            continue: { target: 'loom', reason: 'Write the next moment.' },
        };
    }
    return {
        // The user's own message is theirs to edit, not ours to regenerate.
        retry: { target: null, reason: hasMessages ? 'The last message is yours — edit it instead.' : 'Nothing has happened yet.' },
        continue: { target: 'loom', reason: 'Write the next moment.' },
    };
}

export function resolveDirectionChromeMode({ run = null, uiState = null } = {}) {
    // `directionId` is assigned once, in generateDirectedPerformer, and
    // publicRun carries it — so it is present on every real run and on no
    // placeholder. Structural, not a heuristic: a caller cannot accidentally
    // construct one, which is precisely how the placeholder got mistaken for
    // a run in the first place.
    const liveRun = run && typeof run === 'object' && run.directionId ? run : null;
    if (liveRun) {
        if (liveRun.acceptedComplete) return 'idle';
        return liveRun.phase === 'narrator' ? 'directing' : 'speaking';
    }
    // A placeholder's own `state` is consulted BEFORE the ui state, because
    // handleRoleplaySend paints one before `submitDirectedRoleplay` has taken
    // the direction lock — at that instant `getLiveDirectionUiState` still
    // says 'Ready', and the composer's first frame is exactly when the user
    // most needs to see that something began.
    const state = String((run && typeof run === 'object' ? run.state : '') || uiState?.state || '');
    return state === 'Directing' ? 'directing' : 'idle';
}
