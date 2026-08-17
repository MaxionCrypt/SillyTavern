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
// exactly the calls that meant "a Director pass just started", the Director
// card was CLOSED, and the generic unlabeled "composing…" bubble went up
// instead. The card then only ever opened from renderRoleplayScene's tail,
// whose only trigger during a pass is USER_MESSAGE_RENDERED — a first-attempt
// user send. Autoplay continuations, Next, Retry after a failure that had
// already posted, and the empty-response retry all showed nothing
// Director-specific for the whole 101-202s call.
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
 *        - `directing`: a hidden Director pass is out and has produced no run
 *          yet. The Director's own streaming shell belongs on screen.
 *        - `idle`: neither. Both surfaces come down; a plain generating
 *          indicator (free play) is the caller's business, not this one's.
 */
/**
 * What Retry and Continue mean right now.
 *
 * Two verbs, and the difference between them is the whole point:
 *
 * - **Retry** re-runs the last thing that happened, IN PLACE. It deletes what
 *   that step produced — the message, and the notebook entries if the step was
 *   a direction — and does it again. It never appends.
 * - **Continue** advances to whatever comes next in the loop. It never touches
 *   what is already there.
 *
 * The Director deliberately has no message in the transcript: putting one there
 * would place its entries, secrets included, in the chat history the Narrator
 * reads, and its isolation would then depend on a filter rather than on the
 * text never being there. So "the last message was the Director's" cannot be
 * read off the chat, and is instead the `standingDirection` state — a direction
 * was produced and the performer never spoke it. That is what a failed or
 * stopped pass leaves behind, and it is the state the owner sees as "Direction
 * paused".
 *
 * PURE, and separated from the store queries that answer its inputs, because
 * this is a three-way branch over two booleans and one message shape — exactly
 * the kind of thing that was hand-decided in two places once already (see the
 * defect above) and got it wrong in one of them.
 *
 * @param {{lastMessageIsUser?: boolean, hasMessages?: boolean,
 *          standingDirection?: boolean, busy?: boolean}} [input]
 * @returns {{retry: {target: 'director'|'narrator'|null, reason: string},
 *            continue: {target: 'director'|'narrator'|null, reason: string}}}
 *          `target` is null when the action cannot do anything, and `reason`
 *          says why — a disabled button that cannot explain itself is the
 *          thing this return shape exists to prevent.
 */
export function resolveDirectionActions({
    lastMessageIsUser = false, hasMessages = false, standingDirection = false, busy = false,
} = {}) {
    if (busy) {
        return {
            retry: { target: null, reason: 'Something is already running.' },
            continue: { target: null, reason: 'Something is already running.' },
        };
    }
    // Checked FIRST, before the chat is consulted at all. A standing direction
    // sits after the last chat message by definition — it was produced in
    // response to it — so whatever that message is says nothing about what
    // should happen next while a direction is waiting to be spoken.
    if (standingDirection) {
        return {
            retry: { target: 'director', reason: 'Direct this moment again, discarding the direction that was not spoken.' },
            continue: { target: 'narrator', reason: 'Let the performer speak the direction that is already standing.' },
        };
    }
    if (hasMessages && !lastMessageIsUser) {
        return {
            retry: { target: 'narrator', reason: 'Replace the last response.' },
            continue: { target: 'director', reason: 'Direct the next moment.' },
        };
    }
    return {
        // The user's own message is theirs to edit, not ours to regenerate.
        retry: { target: null, reason: hasMessages ? 'The last message is yours — edit it instead.' : 'Nothing has happened yet.' },
        continue: { target: 'director', reason: 'Direct the next moment.' },
    };
}

export function resolveDirectionChromeMode({ run = null, uiState = null } = {}) {
    // `directionId` is assigned once, in generateDirectedPerformer, and
    // publicRun carries it — so it is present on every real run and on no
    // placeholder. Structural, not a heuristic: a caller cannot accidentally
    // construct one, which is precisely how the placeholder got mistaken for
    // a run in the first place.
    const liveRun = run && typeof run === 'object' && run.directionId ? run : null;
    if (liveRun) return liveRun.acceptedComplete ? 'idle' : 'speaking';
    // A placeholder's own `state` is consulted BEFORE the ui state, because
    // handleRoleplaySend paints one before `submitDirectedRoleplay` has taken
    // the direction lock — at that instant `getLiveDirectionUiState` still
    // says 'Ready', and the composer's first frame is exactly when the user
    // most needs to see that something began.
    const state = String((run && typeof run === 'object' ? run.state : '') || uiState?.state || '');
    return state === 'Directing' ? 'directing' : 'idle';
}
