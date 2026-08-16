// Narrows a Narrator's own generation prompt to its own prose.
//
// Design: the Narrator is a passive voice. It renders what the hidden
// Director has decided, informed by its own PRIOR PROSE — never by what the
// user typed, and never by what any other cast member wrote. Everything the
// user did this turn reaches the Narrator only through the Director's notes
// (a separate, already-filtered injection — see director-notes-store.js's
// readNarratorEntries), so this filter's one job is to remove the user's and
// other cast members' chat-history lines from the compiled prompt without
// ever touching anything that is not chat history.
//
// PURE — no imports, so the exact filter can be asserted offline.

/**
 * @param {object[]} messages  compiled chat-completion-style messages, in the
 *        order they will be sent — each shaped roughly like
 *        `{role: 'user'|'assistant'|'system'|..., content: string, name?: string}`.
 * @param {{narratorName?: string}} [options] the Narrator's own display name,
 *        matched against each history entry's `name` field.
 * @returns {object[]} a NEW array (the input is never mutated): every
 *        `role: 'user'` entry removed, every `role: 'assistant'` entry whose
 *        `name` is present and does not match `narratorName` removed, and
 *        everything else — system prompts, the Director's notes injection,
 *        tool messages, malformed or nameless entries — left exactly where
 *        it was. This function only ever removes an entry it can positively
 *        identify as chat history authored by someone other than the
 *        Narrator; it never guesses, because a wrong guess here is either a
 *        leak (the wrong exclusion) or a scene the Narrator can no longer
 *        make sense of (over-exclusion) — and the notes injection in
 *        particular must survive, since with the Narrator already blind to
 *        the user's words, losing the notes too leaves it with no account of
 *        this turn at all.
 */
export function filterNarratorHistory(messages, { narratorName } = {}) {
    if (!Array.isArray(messages)) return [];
    const name = typeof narratorName === 'string' ? narratorName.trim() : '';
    // No identifiable Narrator to filter for. Guessing which entries to drop
    // without one risks exactly the silent-incoherence failure this filter
    // exists to prevent, so this degrades to a no-op rather than to "drop
    // everything" or "drop nothing but the user" on a guess.
    if (!name) return messages.slice();
    return messages.filter((message) => {
        if (!message || typeof message !== 'object') return false;
        const role = message.role;
        // The user never speaks as the Narrator. Excluded unconditionally —
        // never on a name match — so this holds even when the compiled
        // prompt carries no separate `name` field at all (SillyTavern only
        // attaches one when "Names behavior" is set to Completion; the
        // default embeds the speaker in `content` instead, or omits it
        // entirely for a solo, non-group chat).
        if (role === 'user') return false;
        // Anything that is not chat history — world info, the jailbreak, the
        // main prompt, and the Director's own notes all arrive as
        // `role: 'system'` entries — is never chat history and is never
        // filtered.
        if (role !== 'assistant') return true;
        const speaker = typeof message.name === 'string' ? message.name.trim() : '';
        // No author on an assistant line means it cannot be positively
        // identified as NOT the Narrator. Dropping it on a guess would be
        // the failure this filter exists to avoid, not to cause, so it is
        // kept.
        if (!speaker) return true;
        return speaker === name;
    });
}
