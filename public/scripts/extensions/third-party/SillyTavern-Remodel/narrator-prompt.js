// Loom state renderer. Goals and Variables are dissolved into Living Lore
// (reserved-keyword entries surfaced through {{loom.lore}}), and the
// Archive-backed renderers went with the Loom Archive. What survives is the
// current player action.

/** {{loom.action}} — the player's authoritative turn input. */
export function renderLoomAction(action) {
    const text = String(action || '').trim();
    if (!text) return '';
    return [
        'CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT',
        'This is the player\'s explicit speech, voluntary action, or attempted action for this turn. It outranks conflicting inference in the Narrator draft. Preserve what the player explicitly said or attempted, judge only uncertain outcomes and world reactions, and never invent additional voluntary player speech, thoughts, decisions, or actions.',
        text,
    ].join('\n');
}

/**
 * The extra instruction a Narrator retry carries after an empty response.
 *
 * THE DEFECT THIS FIXES: the empty-response path re-sent a BYTE-IDENTICAL
 * request. Captured on the wire — attempts 2 and 3 of one turn produced
 * request bodies that compared equal character for character, 72 seconds
 * apart. Asking a model the identical question it just failed to answer is a
 * repetition, not a retry, and it burned the whole retry budget (and, in three
 * observed turns, the entire turn) on the same failure.
 *
 * The observed failure is specific: the provider spends the response on
 * private reasoning and returns no visible content — 3,000 to 8,000 characters
 * of thinking against an empty `mes`. So the nudge names exactly that, rather
 * than being a generic "try again".
 *
 * Returns '' for a first attempt, so the initial request is never altered.
 *
 * @param {number} attempt 1 for the first try; 2+ for a retry
 * @param {{reasoningLength?: number}} [previous] what the failed attempt returned
 */
export function buildEmptyResponseNudge(attempt, { reasoningLength = 0, failureCause = '' } = {}) {
    const n = Number(attempt);
    if (!Number.isFinite(n) || n < 2) return '';
    const malformed = ['reasoning-in-content', 'instruction-echo', 'protocol-output'].includes(String(failureCause));
    const thought = failureCause === 'reasoning-in-content'
        ? 'The previous attempt exposed private planning in the visible content channel.'
        : failureCause === 'instruction-echo'
            ? 'The previous attempt copied prompt instructions into the response.'
            : failureCause === 'protocol-output'
                ? 'The previous attempt returned state or protocol JSON instead of narration.'
                : Number(reasoningLength) > 0
        ? 'The previous attempt spent its entire response on private reasoning and returned no prose.'
        : 'The previous attempt returned an empty response.';
    return [
        '## Output required',
        thought,
        malformed
            ? 'Return only the scene prose. Do not explain your approach, repeat any instruction, quote the prompt, or emit JSON/protocol data.'
            : 'Write the scene prose itself in your reply, as visible text. Do not answer with reasoning alone, and do not return an empty message.',
    ].join('\n');
}
