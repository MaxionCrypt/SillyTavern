// Review I1: the live Loom indicator almost never opened.
//
// `refreshLiveDirectionChrome` decided between three chrome states by hand,
// with `const directing = !run && uiState.state === 'Directing'`. But
// live-direction.js's `notifyTransient('Directing')` — the call that announces
// a pass has begun — passes a truthy placeholder `{state, acceptedVisibleText}`
// rather than null, and `handleRoleplaySend` hand-rolled the same shape. So on
// both of those calls `directing` was false: the function CLOSED the Loom
// indicator and put the generic unlabeled "composing…" bubble up instead.
//
// The only remaining opener was renderRoleplayScene's tail, and the only thing
// that triggers it during a pass is USER_MESSAGE_RENDERED — which fires from
// sendMessageAsUser, i.e. a first-attempt user send. Autoplay continuations,
// Next, Retry after a failure that had already posted, and the empty-response
// retry therefore showed nothing Loom-specific for the whole 101-202s of
// the call. That is the branch's headline feature — watching the Loom
// think — working on one entry point out of five.
//
// The branch now lives in a pure module precisely so it can be tested:
// timeline-spine.js touches the DOM at module scope through its imports and
// cannot be imported here at all, which is why the defect had no coverage.
import { test, expect } from '@jest/globals';
import { resolveDirectionChromeMode } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/turn-chrome.js';

// Exactly what live-direction.js's notifyTransient builds. Reproduced as a
// literal rather than imported, because the POINT is that it is run-shaped
// without being a run — a helper that constructed it "correctly" would hide
// the thing under test.
const transientPlaceholder = { state: 'Directing', acceptedVisibleText: '' };

// getLiveDirectionUiState's shape, for the three states that matter here.
const directingUi = { active: true, state: 'Directing' };
const readyUi = { active: true, state: 'Ready' };
const freePlayUi = { active: false, state: 'Free play' };

/** A real run, as publicRun() hands it out: it carries a directionId. */
function liveRun(overrides = {}) {
    return {
        directionId: 'direction-abc',
        state: 'Speaking',
        acceptedVisibleText: 'The door creaks',
        performer: { label: 'Wren' },
        acceptedComplete: false,
        ...overrides,
    };
}

// ------------------------------------------------------------ the defect

test("the placeholder notifyTransient('Directing') passes opens the Loom indicator rather than closing it", () => {
    // THE regression. Under the old `!run` test this returned 'idle', which
    // closed the indicator and fell through to the unlabeled bubble.
    expect(resolveDirectionChromeMode({ run: transientPlaceholder, uiState: directingUi }))
        .toBe('directing');
});

test("handleRoleplaySend's placeholder opens the indicator even before the direction lock exists", () => {
    // handleRoleplaySend paints this synchronously, BEFORE submitDirectedRoleplay
    // has taken the lock — so getLiveDirectionUiState still says 'Ready' at
    // that instant. The first frame after the user presses send is exactly
    // when the indicator matters most, so the placeholder's own state has to be
    // enough on its own.
    expect(resolveDirectionChromeMode({ run: { state: 'Directing', acceptedVisibleText: '' }, uiState: readyUi }))
        .toBe('directing');
});

test('a pass with no run object at all still opens the indicator (autoplay, Next, Retry, the empty-response retry)', () => {
    // These paths reach the chrome through notifyState(), which passes null
    // when there is no activeRun. getLiveDirectionUiState is authoritative
    // here: it reads the direction lock directly.
    expect(resolveDirectionChromeMode({ run: null, uiState: directingUi })).toBe('directing');
});

// ------------------------------------------------- the other two branches

test('a real run mid-reveal is the performer speaking, never the Loom indicator', () => {
    expect(resolveDirectionChromeMode({ run: liveRun(), uiState: readyUi })).toBe('speaking');
});

test('a private Narrator run stays hidden until the Loom owns the visible buffer', () => {
    expect(resolveDirectionChromeMode({
        run: { directionId: 'dir-private', phase: 'narrator', acceptedVisibleText: '', acceptedComplete: false },
        uiState: readyUi,
    })).toBe('directing');
    expect(resolveDirectionChromeMode({
        run: { directionId: 'dir-loom', phase: 'loom', acceptedVisibleText: 'The door', acceptedComplete: false },
        uiState: readyUi,
    })).toBe('speaking');
});

test('a real run outranks a Directing ui state, so the two surfaces are never both up', () => {
    // Can happen transiently: a run exists while the lock has not yet been
    // released. Showing the Loom's shell over a revealing response would
    // claim the pass had not started generating.
    expect(resolveDirectionChromeMode({ run: liveRun(), uiState: directingUi })).toBe('speaking');
});

test('a recovered run holding at the end of its accepted response is idle, not speaking', () => {
    // recoverLiveDirectionMessages rebuilds a run with acceptedComplete: true
    // and state 'Waiting for you'. Treating the mere existence of that object
    // as an active speaker is what resurrected a permanent "composing…" row
    // every time a directed Scene was opened after a reload.
    expect(resolveDirectionChromeMode({ run: liveRun({ acceptedComplete: true, state: 'Waiting for you' }), uiState: readyUi }))
        .toBe('idle');
});

test('an idle directed Scene shows neither surface', () => {
    expect(resolveDirectionChromeMode({ run: null, uiState: readyUi })).toBe('idle');
});

test('a Free play Scene shows neither surface', () => {
    expect(resolveDirectionChromeMode({ run: null, uiState: freePlayUi })).toBe('idle');
});

// ------------------------------------------------------------- degradation

test('missing arguments degrade to idle rather than throwing at render time', () => {
    // Called from a render path; a throw here would take the whole Roleplay
    // workspace down rather than mislabel a wait.
    expect(resolveDirectionChromeMode()).toBe('idle');
    expect(resolveDirectionChromeMode({})).toBe('idle');
    expect(resolveDirectionChromeMode({ run: null, uiState: null })).toBe('idle');
    expect(resolveDirectionChromeMode({ run: 'not an object', uiState: undefined })).toBe('idle');
});

test('a run-shaped object with no directionId is never treated as a run, whatever else it carries', () => {
    // The structural distinction the fix rests on: only generateDirectedPerformer
    // assigns a directionId, so nothing else can be mistaken for a run. This
    // placeholder carries acceptedVisibleText and a performer-ish state and
    // still must not suppress the Loom indicator.
    expect(resolveDirectionChromeMode({
        run: { state: 'Directing', acceptedVisibleText: 'partial', performer: { label: 'Wren' } },
        uiState: directingUi,
    })).toBe('directing');
});
