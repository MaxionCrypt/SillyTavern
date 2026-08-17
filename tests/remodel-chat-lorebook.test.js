import { resolveChatLorebook } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/chat-lorebook.js';

// The Timeline's lorebook becomes the chat's lorebook, because chat lore is
// the only binding core resolves without a selected character — see the module
// header. These rules are about what that must NOT do on the way.

test('a Timeline lorebook is bound to an unbound chat', () => {
    const result = resolveChatLorebook({ timelineLorebook: 'Borrowed Miracles' });

    expect(result.action).toBe('bind');
    expect(result.value).toBe('Borrowed Miracles');
});

test('binding is idempotent', () => {
    const result = resolveChatLorebook({ timelineLorebook: 'Borrowed Miracles', chatLorebook: 'Borrowed Miracles' });

    expect(result.action).toBe('keep');
    expect(result.value).toBe('Borrowed Miracles');
});

test("a chat lorebook the user set by hand is never overwritten", () => {
    // A chat holds exactly one book, so binding would DESTROY this one. The
    // Timeline binding is a convenience; a deliberate per-chat choice outranks
    // it, and the refusal has to say so rather than fail silently.
    const result = resolveChatLorebook({ timelineLorebook: 'Borrowed Miracles', chatLorebook: 'Their Own Book' });

    expect(result.action).toBe('refuse');
    expect(result.value).toBe('Their Own Book');
    expect(result.reason).toContain('Their Own Book');
    expect(result.reason).toContain('Borrowed Miracles');
});

test('a book WE bound is ours to move when the Timeline changes', () => {
    const result = resolveChatLorebook({
        timelineLorebook: 'New Book', chatLorebook: 'Old Book', managedLorebook: 'Old Book',
    });

    expect(result.action).toBe('bind');
    expect(result.value).toBe('New Book');
});

test('clearing the Timeline lorebook releases the one we bound', () => {
    const result = resolveChatLorebook({ chatLorebook: 'Borrowed Miracles', managedLorebook: 'Borrowed Miracles' });

    expect(result.action).toBe('release');
    expect(result.value).toBe('');
});

test("clearing the Timeline lorebook leaves a book we did not bind alone", () => {
    // The absence of a Timeline binding is not an instruction to remove
    // somebody else's book.
    const result = resolveChatLorebook({ chatLorebook: 'Their Own Book', managedLorebook: 'Something Else' });

    expect(result.action).toBe('keep');
    expect(result.value).toBe('Their Own Book');
});

test('a Story Scene is left alone entirely', () => {
    // Story resolves its own books and never generates through the native
    // chat, so a binding here would be a write with no reader.
    const result = resolveChatLorebook({ timelineLorebook: 'Borrowed Miracles', mode: 'story' });

    expect(result.action).toBe('keep');
    expect(result.value).toBe('');
});

test('blank and whitespace names are not books', () => {
    expect(resolveChatLorebook({ timelineLorebook: '   ' }).action).toBe('keep');
    expect(resolveChatLorebook({ timelineLorebook: null }).action).toBe('keep');
    expect(resolveChatLorebook().action).toBe('keep');
});

test('every outcome explains itself', () => {
    const cases = [
        { timelineLorebook: 'A' },
        { timelineLorebook: 'A', chatLorebook: 'A' },
        { timelineLorebook: 'A', chatLorebook: 'B' },
        { chatLorebook: 'A', managedLorebook: 'A' },
        { mode: 'story' },
    ];
    for (const input of cases) {
        const result = resolveChatLorebook(input);
        expect(typeof result.reason).toBe('string');
        expect(result.reason.length).toBeGreaterThan(0);
    }
});
