import { test, expect } from '@jest/globals';
import { resolveRoleplayMessageIds } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/roleplay-message-list.js';

test('roleplay message selection is driven by canonical chat data, not native DOM rows', () => {
    const chat = [
        { is_user: true, mes: 'I open the door.' },
        { is_user: false, mes: 'Rain reaches through the doorway.' },
    ];

    expect(resolveRoleplayMessageIds(chat)).toEqual([0, 1]);
});

test('directed roleplay still hides only leaked greetings before the first user turn', () => {
    const leaked = { is_user: false, mes: 'Legacy greeting', leaked: true };
    const chat = [
        leaked,
        { is_user: true, mes: 'Begin.' },
        { is_user: false, mes: 'The scene begins.' },
    ];

    expect(resolveRoleplayMessageIds(chat, {
        directed: true,
        isLeakedGreeting: (message) => message.leaked === true,
    })).toEqual([1, 2]);
    expect(resolveRoleplayMessageIds(chat, {
        directed: false,
        isLeakedGreeting: (message) => message.leaked === true,
    })).toEqual([0, 1, 2]);
});
