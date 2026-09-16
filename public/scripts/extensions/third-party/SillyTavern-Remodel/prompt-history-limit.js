const START = /\[\[RM:CHAT_HISTORY_START:(\d+)\]\]/;
const END = /\[\[RM:CHAT_HISTORY_END\]\]/;
const NATIVE_NEW_CHAT_MESSAGE = 'newMainChat';
const LEGACY_NARRATOR_CONSTRAINTS = /^\[Narrator constraints, active:/i;
const NEXT_ACTION_MARKER = '[[RM:NEXT_ACTION]]';

export function chatHistoryBoundary(limit) {
    const bounded = Math.max(0, Math.min(1000, Math.floor(Number(limit) || 0)));
    return { start: `[[RM:CHAT_HISTORY_START:${bounded}]]`, end: '[[RM:CHAT_HISTORY_END]]' };
}

/**
 * Core adds its `[Start a new Chat]` system message to every Chat Completion
 * history collection, including an otherwise empty chat.  Roleplay owns its
 * first-turn setup in the recipe, so that bootstrap is neither scene history
 * nor a Roleplay instruction and must not cross the `{{chat.history}}`
 * boundary.  The identifier is core's stable Message identifier, making this
 * deliberately narrower than filtering all system-role history.
 */
export function removeNativeNewChatBootstrap(chat) {
    if (!Array.isArray(chat)) return 0;
    const retained = chat.filter((message) => String(message?.identifier || '') !== NATIVE_NEW_CHAT_MESSAGE);
    const removed = chat.length - retained.length;
    if (removed) chat.splice(0, chat.length, ...retained);
    return removed;
}

/**
 * Drop the obsolete, out-of-recipe Narrator constraint injection if a legacy
 * extension/profile still adds it inside native chat history. It is neither
 * player/Narrator history nor a Prompt Studio source. Match only its explicit
 * signature and only on a system message; owner-authored history remains
 * untouched.
 */
export function removeLegacyNarratorConstraints(chat) {
    if (!Array.isArray(chat)) return 0;
    const retained = chat.filter((message) => !(
        String(message?.role || '').toLowerCase() === 'system'
        && LEGACY_NARRATOR_CONSTRAINTS.test(String(message?.content || '').trim())
    ));
    const removed = chat.length - retained.length;
    if (removed) chat.splice(0, chat.length, ...retained);
    return removed;
}

/** Return the newest real player turn, ignoring system and assistant messages. */
export function getLatestPlayerAction(messages) {
    if (!Array.isArray(messages)) return '';
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message?.is_user || message?.is_system) continue;
        const action = String(message?.mes ?? message?.content ?? '').trim();
        if (action) return action;
    }
    return '';
}

/**
 * Remove only the exact current player action from core's flattened prompt.
 * Earlier player turns remain history.  A strict content match deliberately
 * prevents a same-looking assistant/system message from being removed.
 */
export function removeLatestPlayerAction(chat, action) {
    if (!Array.isArray(chat) || !String(action || '').trim()) return 0;
    const expected = String(action).trim();
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (String(message?.role || '').toLowerCase() !== 'user') continue;
        const content = String(message?.content ?? message?.mes ?? '').trim();
        // The recipe-owned `{{next.action}}` copy is tagged until the last
        // assembly step, so it can never be mistaken for the history copy.
        if (content.startsWith(NEXT_ACTION_MARKER) || content !== expected) continue;
        chat.splice(index, 1);
        return 1;
    }
    return 0;
}

export function tagNextAction(action) {
    return `${NEXT_ACTION_MARKER}${String(action || '').trim()}`;
}

/** Remove the private routing tag just before the provider sees the prompt. */
export function restoreTaggedNextAction(chat) {
    if (!Array.isArray(chat)) return 0;
    let restored = 0;
    for (const message of chat) {
        const content = String(message?.content ?? '');
        if (!content.startsWith(NEXT_ACTION_MARKER)) continue;
        message.content = content.slice(NEXT_ACTION_MARKER.length);
        restored++;
    }
    return restored;
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
