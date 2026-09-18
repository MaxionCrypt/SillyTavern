// A `secret` Living Lore entry is Loom-visible but hidden from the Narrator.
//
// The Narrator generates through SillyTavern's native prompt, which activates
// the chat-bound Timeline book (see chat-lorebook.js). Native activation skips
// disabled entries, so a secret entry is marked two ways that are kept in sync:
// it carries the reserved `secret` keyword (the marker) AND is `disable: true`
// (the native enforcement). The Loom's own retrieval ignores that disable for
// secret entries, so the Loom still sees it; revealing an entry drops the
// keyword and re-enables it, returning it to ordinary native activation.

export const SECRET_KEYWORD = 'secret';

function normalize(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

/** True when a native World Info entry carries the reserved `secret` keyword. */
export function isSecretEntry(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    return keys.some((key) => normalize(key) === SECRET_KEYWORD);
}

/** The key list with the reserved `secret` keyword present exactly once. */
export function addSecretKeyword(keys) {
    const list = (Array.isArray(keys) ? keys : []).map((key) => String(key));
    return list.some((key) => normalize(key) === SECRET_KEYWORD) ? list : [...list, SECRET_KEYWORD];
}

/** The key list with every `secret` keyword removed. */
export function removeSecretKeyword(keys) {
    return (Array.isArray(keys) ? keys : []).map((key) => String(key)).filter((key) => normalize(key) !== SECRET_KEYWORD);
}
