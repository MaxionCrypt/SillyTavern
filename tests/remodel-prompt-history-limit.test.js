import { chatHistoryBoundary, limitBoundedChatHistory } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-history-limit.js';

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
