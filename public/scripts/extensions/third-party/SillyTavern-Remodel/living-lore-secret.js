// Reserved Living Lore keywords: type/visibility markers, never trigger words.
//
// A `secret` entry is Loom-visible but hidden from the Narrator. The Narrator
// generates through SillyTavern's native prompt, which activates the chat-bound
// Timeline book (see chat-lorebook.js). Native activation skips disabled entries,
// so a secret entry is marked two ways that are kept in sync: it carries the
// reserved `secret` keyword (the marker) AND is `disable: true` (the native
// enforcement). The Loom's own retrieval ignores that disable for secret
// entries, so the Loom still sees it; revealing an entry drops the keyword and
// re-enables it, returning it to ordinary native activation.
//
// `goal` and `variable` are the reserved markers left by the Goals & Variables
// dissolution: an entry tagged with one is a former Goal or Variable, set aside
// as an ordinary Living Lore entry. They are markers only and carry no behaviour
// of their own — how a Goal or Variable reads and updates is the recipe macro,
// the fence schema, and the model's reasoning, not code here.

export const SECRET_KEYWORD = 'secret';
export const GOAL_KEYWORD = 'goal';
export const VARIABLE_KEYWORD = 'variable';

/** Every reserved keyword: recognised as a role/visibility marker, not a trigger. */
export const RESERVED_LIVING_LORE_KEYWORDS = Object.freeze([SECRET_KEYWORD, GOAL_KEYWORD, VARIABLE_KEYWORD]);

function normalize(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

function hasReservedKeyword(entry, keyword) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    return keys.some((key) => normalize(key) === keyword);
}

/** True when a key is one of the reserved Living Lore markers. */
export function isReservedLivingLoreKeyword(key) {
    return RESERVED_LIVING_LORE_KEYWORDS.includes(normalize(key));
}

/** True when a native World Info entry carries the reserved `secret` keyword. */
export function isSecretEntry(entry) {
    return hasReservedKeyword(entry, SECRET_KEYWORD);
}

/** True when a native World Info entry carries the reserved `goal` keyword. */
export function isGoalEntry(entry) {
    return hasReservedKeyword(entry, GOAL_KEYWORD);
}

/** True when a native World Info entry carries the reserved `variable` keyword. */
export function isVariableEntry(entry) {
    return hasReservedKeyword(entry, VARIABLE_KEYWORD);
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
