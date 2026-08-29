/** Pure identity check used before invoking SillyTavern's expensive group loader. */
export function isLinkedGroupChatLoaded({ selectedGroupId, groupId, currentChatId, targetChatId } = {}) {
    return sameIdentity(selectedGroupId, groupId) && sameIdentity(currentChatId, targetChatId);
}

function sameIdentity(left, right) {
    if (left == null || right == null) return false;
    return String(left) === String(right);
}
