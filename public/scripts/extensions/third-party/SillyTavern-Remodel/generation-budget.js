// Did a generation stop because it ran out of response budget, or because it
// was finished?
//
// WHY THIS INFERS RATHER THAN READING finish_reason: SillyTavern never surfaces
// it. `finish_reason` appears nowhere in this repository — not in the client,
// not in the server proxy. Core's streaming generator yields only
// `{ text, swipes, logprobs, toolCalls, state }`, and the single place a count
// is computed (script.js, "Stream stats") counts stream CHUNKS rather than
// tokens, is a console.warn, and is not exported. The provider's own stop
// signal is simply not reachable from an extension.
//
// What IS reachable is the ceiling — getMaxResponseTokens() — and the text that
// came back. A response stops at max_tokens EXACTLY, so a generation whose
// reasoning plus visible text reaches that ceiling did not choose to stop. That
// is the inference this module makes, and it is the whole of it.
//
// Reasoning is counted with the visible text because it is spent from the SAME
// budget. That is the case this was written for: a 2000-token ceiling with
// reasoning_effort "high" spent ~1950 tokens thinking and emitted 900 characters
// of prose that ended mid-word, and every downstream symptom — a truncated turn,
// a Loom pass that never reached its state fence, an Archive that silently did
// not advance — followed from that one fact.

/** Client-side token counts come from a different tokenizer than the provider
 *  used, so they drift by a percent or two. Treat "within 2% of the ceiling" as
 *  having hit it, with a small absolute floor for tiny budgets. */
const DEFAULT_TOLERANCE_RATIO = 0.02;
const MIN_TOLERANCE_TOKENS = 2;

/**
 * @param {{visibleTokens?: number, reasoningTokens?: number, maxTokens?: number,
 *          toleranceRatio?: number}} [input]
 * @returns {{exhausted: boolean, used: number, max: number, visible: number,
 *           reasoning: number, reasoningShare: number, tolerance: number}}
 *          `exhausted` false when the ceiling is unknown — an unknown budget
 *          cannot be proven spent, and a false alarm on every turn would train
 *          the reader to ignore the real one.
 */
export function describeGenerationBudget({
    visibleTokens = 0, reasoningTokens = 0, maxTokens = 0, toleranceRatio = DEFAULT_TOLERANCE_RATIO,
} = {}) {
    // Guard the coercion explicitly. Number(null), Number('') and Number([]) are
    // all 0, and a silent 0 here would read as "no tokens used" on a turn that
    // simply failed to report — the opposite of the truth.
    const toCount = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
    };
    const visible = toCount(visibleTokens);
    const reasoning = toCount(reasoningTokens);
    const max = toCount(maxTokens);
    const used = visible + reasoning;
    const ratio = Number.isFinite(Number(toleranceRatio)) && Number(toleranceRatio) >= 0
        ? Number(toleranceRatio)
        : DEFAULT_TOLERANCE_RATIO;
    const tolerance = Math.max(MIN_TOLERANCE_TOKENS, Math.ceil(max * ratio));
    return {
        exhausted: max > 0 && used > 0 && used >= max - tolerance,
        used,
        max,
        visible,
        reasoning,
        reasoningShare: used > 0 ? reasoning / used : 0,
        tolerance,
    };
}

/**
 * One line a human can act on, or '' when the budget was not exhausted.
 *
 * It names the reasoning share deliberately: "the response was truncated" sends
 * someone hunting through Remodel, while "reasoning used 97% of your 2000-token
 * budget" points straight at the setting that caused it.
 */
export function describeBudgetWarning(budget, label = 'The response') {
    if (!budget?.exhausted) return '';
    const share = Math.round((budget.reasoningShare || 0) * 100);
    const parts = [
        `${label} stopped because it ran out of response budget`,
        `(~${budget.used} of ${budget.max} tokens).`,
    ];
    if (budget.reasoning > 0) {
        parts.push(`Reasoning took ${share}% of it, leaving ~${budget.visible} tokens of output.`);
        parts.push('Raise the response length, or lower the reasoning effort.');
    } else {
        parts.push('Raise the response length.');
    }
    return parts.join(' ');
}

/**
 * Detect a substantial prose response that never reached a plausible terminal
 * boundary. Some compatible providers close a successful stream without
 * forwarding finish_reason and far below the configured token ceiling. That
 * leaves token-budget inference blind, while the returned prose still ends on
 * a bare word, contraction, comma, or colon.
 *
 * Sentence punctuation, closing quotes/brackets, ellipses, and a deliberate
 * em-dash cliff edge are accepted. Short fragments are ignored because this
 * guard is for Narrator passages, not UI labels or intentionally terse beats.
 *
 * @param {string} text
 * @param {{minimumLength?: number}} [options]
 * @returns {{incomplete: boolean, ending: string}}
 */
export function describeIncompleteProse(text, { minimumLength = 80 } = {}) {
    const prose = String(text || '').trim();
    if (prose.length < Math.max(1, Number(minimumLength) || 80)) {
        return { incomplete: false, ending: prose.slice(-80) };
    }

    // Markdown wrappers may legally follow the terminal punctuation.
    const ending = prose.replace(/(?:\*\*|__|[*_`])+$/u, '').trimEnd();
    const complete = /(?:[.!?…]|\.{3}|[—–])(?:["'’”»)\]}]+)?$/u.test(ending)
        || /["'’”»)\]}]$/u.test(ending);
    return { incomplete: !complete, ending: ending.slice(-80) };
}
