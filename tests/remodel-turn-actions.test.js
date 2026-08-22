import { resolveDirectionActions } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/turn-chrome.js';

// Retry re-runs the last turn in place. Continue advances to the next one.
// In Loom mode a turn's only trace is its committed Narrator message, so the
// step is read straight off the chat.

test('after the performer speaks, Retry replaces it and Continue directs the next moment', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: false });

    expect(actions.retry.target).toBe('narrator');
    expect(actions.continue.target).toBe('loom');
});

test('after the user writes, Continue directs and there is nothing to Retry', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: true });

    expect(actions.continue.target).toBe('loom');
    // The user's own message is theirs to edit. Regenerating it would be this
    // feature rewriting the one thing in the scene that is not ours to write.
    expect(actions.retry.target).toBeNull();
    expect(actions.retry.reason).toMatch(/yours/i);
});

test('an empty scene can only be Continued', () => {
    const actions = resolveDirectionActions({ hasMessages: false });

    expect(actions.continue.target).toBe('loom');
    expect(actions.retry.target).toBeNull();
});

test('nothing is offered while a pass is in flight, and both say why', () => {
    const actions = resolveDirectionActions({ hasMessages: true, lastMessageIsUser: false, busy: true });

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
    expect(resolveDirectionActions().continue.target).toBe('loom');
});
