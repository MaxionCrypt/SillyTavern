import { resolveDirectionActions } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-chrome.js';

// Retry re-runs the last step in place. Continue advances to the next one.
// The Director has no message in the transcript by design, so "the Director
// went last" is the standingDirection state — a direction produced and never
// spoken — rather than anything readable off the chat.

test('after the performer speaks, Retry replaces it and Continue directs the next moment', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: false });

    expect(actions.retry.target).toBe('narrator');
    expect(actions.continue.target).toBe('director');
});

test('after the user writes, Continue directs and there is nothing to Retry', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: true });

    expect(actions.continue.target).toBe('director');
    // The user's own message is theirs to edit. Regenerating it would be this
    // feature rewriting the one thing in the scene that is not ours to write.
    expect(actions.retry.target).toBeNull();
    expect(actions.retry.reason).toMatch(/yours/i);
});

test('an unspoken direction is Continued by the performer and Retried by the Director', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: true, standingDirection: true });

    // This is the "Direction paused" state: the Director produced a turn and
    // the performer rendered nothing. Continue must let the performer speak
    // the direction that already exists rather than spend another Director
    // call — which on the owner's connection is the expensive half.
    expect(actions.continue.target).toBe('narrator');
    expect(actions.retry.target).toBe('director');
});

test('a standing direction outranks whatever the last chat message was', () => {
    // It sits after that message by definition — it was produced in response
    // to it — so the message says nothing about what happens next.
    const afterUser = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: true, standingDirection: true });
    const afterNarrator = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: false, standingDirection: true });

    expect(afterUser).toEqual(afterNarrator);
});

test('an empty scene can only be Continued', () => {
    const actions = resolveDirectionActions({ hasMessages: false });

    expect(actions.continue.target).toBe('director');
    expect(actions.retry.target).toBeNull();
});

test('nothing is offered while a pass is in flight, and both say why', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: false, standingDirection: true, busy: true });

    expect(actions.retry.target).toBeNull();
    expect(actions.continue.target).toBeNull();
    expect(actions.retry.reason).toMatch(/already running/i);
    expect(actions.continue.reason).toMatch(/already running/i);
});

test('every branch explains itself, so no button is disabled without a reason', () => {
    const cases = [
        { hasMessages: false },
        { hasMessages: true, lastMessageIsUser: true },
        { hasMessages: true, lastMessageIsUser: false },
        { hasMessages: true, standingDirection: true },
        { hasMessages: true, busy: true },
    ];
    for (const input of cases) {
        const actions = resolveDirectionActions(input);
        for (const action of [actions.retry, actions.continue]) {
            expect(typeof action.reason).toBe('string');
            expect(action.reason.length).toBeGreaterThan(0);
        }
    }
});

test('no input at all degrades to the empty scene rather than throwing', () => {
    expect(() => resolveDirectionActions()).not.toThrow();
    expect(resolveDirectionActions().continue.target).toBe('director');
});
