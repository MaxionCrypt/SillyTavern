/**
 * Resolve the canonical chat indices rendered by the roleplay workspace.
 *
 * This intentionally accepts chat data rather than native `.mes` elements.
 * Core replaces those elements while generation settles; the chat array is
 * stable across that rebuild and is the source Remodel ultimately persists.
 */
export function resolveRoleplayMessageIds(chat, {
    directed = false,
    isLeakedGreeting = () => false,
} = {}) {
    const messages = Array.isArray(chat) ? chat : [];
    const firstUserIndex = messages.findIndex((message) => message?.is_user);
    const greetingBoundary = firstUserIndex < 0 ? messages.length : firstUserIndex;

    return messages.flatMap((message, mesId) => {
        const hiddenGreeting = directed
            && mesId < greetingBoundary
            && isLeakedGreeting(message);
        return hiddenGreeting ? [] : [mesId];
    });
}
