// Whether a Roleplay Scene's chat should carry the Timeline's lorebook, and
// what that costs.
//
// PURE — no imports, so the rules can be asserted offline.
//
// WHY THE CHAT BINDING AND NOT ANY OTHER. SillyTavern resolves world info from
// four places (world-info.js's getSortedEntries), and only one of them works
// for a directed Scene:
//
// - `getCharacterLore()` opens with `characters[this_chid]` — the single
//   SELECTED character. A group chat at rest has no `this_chid`, so when Live
//   Direction runs its own out-of-band scan to build the Director's snapshot,
//   character lore resolves to nothing no matter whose card the book is on.
//   During a native group generation core sets `this_chid` to the speaking
//   member, so the performer resolves ITS OWN card's book and no one else's —
//   which means a book on the Director's card is invisible to every path.
// - `getPersonaLore()` has the same shape, against the persona.
// - `getGlobalLore()` applies everywhere, which is the opposite of what a
//   per-Timeline book is for.
// - `getChatLore()` reads `chat_metadata['world_info']` and consults nothing
//   else. It is the one binding that resolves identically for the Director's
//   scan and the performer's native generation.
//
// So the Timeline book becomes the chat book. Before this, `lorebookName` had
// exactly one consumer — story-world-info.js — and a Timeline lorebook did
// nothing at all in Roleplay while appearing to be bound in the UI.

/**
 * @param {{timelineLorebook?: string|null, chatLorebook?: string|null,
 *          managedLorebook?: string|null, mode?: string}} [input]
 *   `managedLorebook` is what this extension last bound to THIS chat. It is
 *   what separates "the chat's book is ours to move" from "the user set this
 *   by hand", and without it the two are indistinguishable.
 * @returns {{action: 'bind'|'release'|'keep'|'refuse', value: string, reason: string}}
 */
export function resolveChatLorebook({
    timelineLorebook = null, chatLorebook = null, managedLorebook = null, mode = 'roleplay',
} = {}) {
    const timeline = name(timelineLorebook);
    const chat = name(chatLorebook);
    const managed = name(managedLorebook);

    // Story Scenes resolve their own books (story-world-info.js) and never
    // generate through the native chat, so binding one there would be a write
    // with no reader.
    if (mode !== 'roleplay') return { action: 'keep', value: chat, reason: 'Only Roleplay Scenes generate through the native chat.' };

    if (timeline) {
        if (chat === timeline) return { action: 'keep', value: chat, reason: 'Already bound.' };
        // A chat may hold exactly ONE lorebook — `chat_metadata.world_info` is
        // a single name, not a list — so binding the Timeline's book would
        // silently destroy a book the user chose for this chat by hand. The
        // Timeline binding is a convenience; a deliberate per-chat choice
        // outranks it, and saying so is better than winning quietly.
        if (chat && chat !== managed) {
            return { action: 'refuse', value: chat, reason: `This chat already has its own lorebook (${chat}), so the Timeline's (${timeline}) was not applied. A chat can only hold one.` };
        }
        return { action: 'bind', value: timeline, reason: `Bound the Timeline's lorebook (${timeline}) to this chat.` };
    }

    // The Timeline no longer names a book. Release ours, and only ours: a book
    // the user set by hand is theirs, and the absence of a Timeline binding is
    // not an instruction to remove it.
    if (managed && chat === managed) return { action: 'release', value: '', reason: `Released the Timeline's lorebook (${managed}) from this chat.` };
    return { action: 'keep', value: chat, reason: 'Nothing to bind.' };
}

function name(value) {
    return value == null ? '' : String(value).trim();
}
