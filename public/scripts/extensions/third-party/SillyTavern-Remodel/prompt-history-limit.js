const START = /\[\[RM:CHAT_HISTORY_START:(\d+)\]\]/;
const END = /\[\[RM:CHAT_HISTORY_END\]\]/;

export function chatHistoryBoundary(limit) {
    const bounded = Math.max(0, Math.min(1000, Math.floor(Number(limit) || 0)));
    return { start: `[[RM:CHAT_HISTORY_START:${bounded}]]`, end: '[[RM:CHAT_HISTORY_END]]' };
}

/** Apply the count encoded around core's native chatHistory marker. */
export function limitBoundedChatHistory(chat) {
    if (!Array.isArray(chat)) return { applied: false, limit: null, removed: 0 };
    const startIndex = chat.findIndex((message) => START.test(String(message?.content || '')));
    const endIndex = chat.findIndex((message, index) => index > startIndex && END.test(String(message?.content || '')));
    if (startIndex < 0 || endIndex < 0) return { applied: false, limit: null, removed: 0 };

    const match = String(chat[startIndex]?.content || '').match(START);
    const limit = Math.max(0, Math.min(1000, Number(match?.[1]) || 0));
    const middle = chat.slice(startIndex + 1, endIndex);
    const kept = limit > 0 ? middle.slice(-limit) : [];
    const cleaned = [...chat.slice(0, startIndex + 1), ...kept, ...chat.slice(endIndex)]
        .map((message) => ({
            ...message,
            content: String(message?.content || '').replace(START, '').replace(END, '').trim(),
        }))
        .filter((message) => message.content || message.tool_calls);
    chat.splice(0, chat.length, ...cleaned);
    return { applied: true, limit, removed: middle.length - kept.length };
}
