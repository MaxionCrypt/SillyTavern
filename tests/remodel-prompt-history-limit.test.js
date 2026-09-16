import { chatHistoryBoundary, getLatestPlayerAction, limitBoundedChatHistory, removeLatestPlayerAction, removeLegacyNarratorConstraints, removeNativeNewChatBootstrap, restoreTaggedNextAction, tagNextAction } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-history-limit.js';

test('removes only core\'s new-chat bootstrap from Roleplay history', () => {
    const chat = [
        { role: 'system', identifier: 'newMainChat', content: '[Start a new Chat]' },
        { role: 'system', identifier: 'scene-state', content: 'A genuine system record stays.' },
        { role: 'user', content: 'The first player action stays.' },
    ];

    expect(removeNativeNewChatBootstrap(chat)).toBe(1);
    expect(chat).toEqual([
        { role: 'system', identifier: 'scene-state', content: 'A genuine system record stays.' },
        { role: 'user', content: 'The first player action stays.' },
    ]);
});

test('removes the obsolete injected Narrator constraints while preserving other system records', () => {
    const chat = [
        { role: 'system', content: '[Narrator constraints, active: bodies only.]' },
        { role: 'system', content: 'A genuine system record stays.' },
        { role: 'user', content: 'The player action stays.' },
    ];

    expect(removeLegacyNarratorConstraints(chat)).toBe(1);
    expect(chat).toEqual([
        { role: 'system', content: 'A genuine system record stays.' },
        { role: 'user', content: 'The player action stays.' },
    ]);
});

test('keeps the newest requested native history messages and removes its boundaries', () => {
    const boundary = chatHistoryBoundary(2);
    const chat = [
        { role: 'system', content: `Grounding\n${boundary.start}` },
        { role: 'user', content: 'old user' },
        { role: 'assistant', content: 'old reply' },
        { role: 'user', content: 'latest user' },
        { role: 'assistant', content: 'latest reply' },
        { role: 'system', content: `${boundary.end}\nWrite now.` },
    ];
    expect(limitBoundedChatHistory(chat)).toEqual({ applied: true, limit: 2, removed: 2 });
    expect(chat.map((message) => message.content)).toEqual(['Grounding', 'latest user', 'latest reply', 'Write now.']);
    expect(JSON.stringify(chat)).not.toContain('RM:CHAT_HISTORY');
});

test('messages=0 removes native history but preserves surrounding prompts', () => {
    const boundary = chatHistoryBoundary(0);
    const chat = [
        { role: 'system', content: boundary.start },
        { role: 'user', content: 'drop me' },
        { role: 'system', content: boundary.end },
        { role: 'system', content: 'Generation nudge' },
    ];
    expect(limitBoundedChatHistory(chat)).toEqual({ applied: true, limit: 0, removed: 1 });
    expect(chat).toEqual([{ role: 'system', content: 'Generation nudge' }]);
});

test('does nothing when a recipe did not request a bound', () => {
    const chat = [{ role: 'user', content: 'untouched' }];
    expect(limitBoundedChatHistory(chat).applied).toBe(false);
    expect(chat).toEqual([{ role: 'user', content: 'untouched' }]);
});

test('routes only the newest player action outside Chat History', () => {
    const sourceChat = [
        { is_user: true, mes: 'Earlier player action.' },
        { is_user: false, mes: 'Earlier narrator response.' },
        { is_user: true, mes: 'Newest player action.' },
    ];
    const promptChat = [
        { role: 'user', content: 'Earlier player action.' },
        { role: 'assistant', content: 'Earlier narrator response.' },
        { role: 'user', content: 'Newest player action.' },
    ];

    const action = getLatestPlayerAction(sourceChat);
    expect(action).toBe('Newest player action.');
    expect(removeLatestPlayerAction(promptChat, action)).toBe(1);
    expect(promptChat.map((message) => message.content)).toEqual([
        'Earlier player action.',
        'Earlier narrator response.',
    ]);
});

test('protects the separately routed action from the history filter and removes its tag', () => {
    const chat = [
        { role: 'user', content: 'Earlier action.' },
        { role: 'user', content: 'Newest action.' },
        { role: 'user', content: tagNextAction('Newest action.') },
    ];

    expect(removeLatestPlayerAction(chat, 'Newest action.')).toBe(1);
    expect(restoreTaggedNextAction(chat)).toBe(1);
    expect(chat.map((message) => message.content)).toEqual(['Earlier action.', 'Newest action.']);
});
