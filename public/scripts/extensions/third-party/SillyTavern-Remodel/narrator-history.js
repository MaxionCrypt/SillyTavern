// Narrows a Narrator's own generation prompt to its own prose.
//
// Design: the Narrator is a passive voice. It renders what the hidden
// Loom has decided, informed by its own PRIOR PROSE — never by what the
// user typed, and never by what any other cast member wrote. Everything the
// user did this turn reaches the Narrator only through the Loom's notes
// (a separate, already-filtered injection — see loom-notes-store.js's
// readNarratorEntries), so this filter's one job is to remove the user's and
// other cast members' chat-history lines from the compiled prompt without
// ever touching anything that is not chat history.
//
// PURE — no imports, so the exact filter can be asserted offline.

/**
 * Core's own name transform, reproduced exactly.
 *
 * THIS IS THE WHOLE POINT OF THIS HELPER, so it is worth stating: the `name`
 * that reaches a compiled history message is NOT the character's label. Core
 * attaches one only under `character_names_behavior.COMPLETION`, and when it
 * does it runs the label through `PromptManager.sanitizeName` first —
 * `name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64)` (openai.js's
 * `populateChatHistory`, PromptManager.js's `isValidName`/`sanitizeName`). A
 * Narrator called `Dr. Aris O'Neill` therefore arrives here as
 * `Dr__Aris_O_Neill`, and comparing it against the raw label matched NOTHING —
 * dropping every one of the Narrator's own messages, silently, for the whole
 * session. Comparing the sanitized form of both sides is what makes the
 * comparison meet core where core actually left the value.
 *
 * `isValidName` short-circuits the transform for a label that is already
 * `[a-zA-Z0-9_]{1,64}`, but sanitizing such a label is a no-op anyway, so one
 * unconditional pass reproduces both of core's branches.
 *
 * Two labels that differ only in punctuation (`The.Narrator` vs `The Narrator`)
 * collapse to the same key and would be treated as the same speaker. That is
 * the same failure DIRECTION this module already chooses everywhere else —
 * keeping a line that might not be the Narrator's, rather than dropping one
 * that is — and it is what core itself does to those two names on the wire.
 */
function sanitizedNameKey(value) {
    return String(value).replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
}

/**
 * @param {object[]} messages  compiled chat-completion-style messages, in the
 *        order they will be sent — each shaped roughly like
 *        `{role: 'user'|'assistant'|'system'|..., content: string, name?: string}`.
 * @param {{narratorName?: string}} [options] the Narrator's own display name.
 *        Matched against each history entry's `name` field after BOTH sides are
 *        put through core's own `sanitizeName` transform — see
 *        `sanitizedNameKey` above for why a raw comparison is wrong.
 * @returns {object[]} a NEW array (the input is never mutated): every
 *        `role: 'user'` entry removed, every `role: 'assistant'` entry whose
 *        `name` is present and does not match `narratorName` removed, and
 *        everything else — system prompts, the Loom's notes injection,
 *        tool messages, nameless entries — left exactly where it was. Entries
 *        that are not objects at all are dropped, since there is nothing in
 *        them to identify and nothing core could have compiled them from.
 *        Beyond that this function only ever removes an entry it can
 *        positively identify as chat history authored by someone other than
 *        the Narrator; it never guesses, because a wrong guess here is either
 *        a leak (the wrong exclusion) or a scene the Narrator can no longer
 *        make sense of (over-exclusion) — and the notes injection in
 *        particular must survive, since with the Narrator already blind to
 *        the user's words, losing the notes too leaves it with no account of
 *        this turn at all.
 *
 * NOTE ON SCOPE, so the guarantee is not read as wider than it is: the
 * cast-exclusion half of this filter only does anything under
 * `names_behavior: Completion`. Under the shipped default core embeds the
 * speaker inside `content` for a group and omits `name` entirely for a solo
 * chat, so every assistant entry arrives nameless and is KEPT (see below).
 * The user-message exclusion is unconditional — it keys on `role`, not on a
 * name — so the design's primary promise holds under every setting.
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
        // main prompt, and the Loom's own notes all arrive as
        // `role: 'system'` entries — is never chat history and is never
        // filtered.
        if (role !== 'assistant') return true;
        const speaker = typeof message.name === 'string' ? message.name.trim() : '';
        // No author on an assistant line means it cannot be positively
        // identified as NOT the Narrator. Dropping it on a guess would be
        // the failure this filter exists to avoid, not to cause, so it is
        // kept. This is also the ONLY branch that runs under the default
        // "Names behavior", where core attaches no `name` at all.
        if (!speaker) return true;
        // Sanitized on both sides, never raw. See sanitizedNameKey.
        return sanitizedNameKey(speaker) === sanitizedNameKey(name);
    });
}
