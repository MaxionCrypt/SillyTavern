// Budget sizing and failure diagnosis for the hidden structured AI calls
// (Live Direction and the mechanical preflight).
//
// PURE — no context, no network, no DOM — so the diagnosis logic can be tested
// offline against real reply shapes.
//
// Both callers ask for a strict JSON envelope. Their old failure message was
// "returned invalid structured JSON", which blames the model's formatting for
// what is usually a budget problem: a reasoning model spends its token
// allowance thinking and the envelope is cut off mid-object, or never starts.
// Truncated JSON and malformed JSON look identical to JSON.parse, but they have
// completely different fixes, so we separate them here.

/**
 * A reasoning model can burn well over a thousand tokens before emitting its
 * first structured character. `max_tokens` is a CAP, not a spend — a concise
 * model still costs what it actually writes — so a generous floor is close to
 * free and removes an entire class of silent failure.
 */
export const REASONING_SAFE_FLOOR = 1500;

/**
 * Size a structured call from the Mechanics context budget.
 * The floor wins over the derived share; the ceiling still caps the top end.
 *
 * Still used by the standalone mechanical preflight, whose size genuinely does
 * track how much mechanical state it was handed. The Director no longer derives
 * its allowance this way — see directorResponseTokens.
 */
export function structuredResponseLength(contextBudget, { divisor = 3, ceiling = 3000 } = {}) {
    const budget = Math.max(0, Number(contextBudget) || 0);
    const derived = Math.round(budget / Math.max(1, divisor));
    return Math.max(REASONING_SAFE_FLOOR, Math.min(ceiling, Math.max(derived, REASONING_SAFE_FLOOR)));
}

/**
 * The Director's answer allowance, in tokens.
 *
 * Reads the explicit Mechanics-profile setting, falling back to the old derived
 * value only for a profile object that predates it — a caller holding a stale
 * profile should not silently get an unbounded request.
 *
 * @param {{ directorResponseTokens?: number, contextBudget?: number }} profile
 */
export function directorResponseTokens(profile = {}) {
    const explicit = Math.round(Number(profile?.directorResponseTokens) || 0);
    if (explicit >= REASONING_SAFE_FLOOR) {
        return Math.min(32000, explicit);
    }
    return structuredResponseLength(profile?.contextBudget, { divisor: 3, ceiling: 3000 });
}

/** Thrown with a `stage` so callers can distinguish the cause. */
export class StructuredReplyError extends Error {
    constructor(stage, message, detail = null) {
        super(message);
        this.name = 'StructuredReplyError';
        this.stage = stage;
        this.detail = detail;
    }
}

/**
 * Turn a raw structured reply into an envelope, or throw something actionable.
 *
 * Note an EMPTY OBJECT is a legitimate answer, not a failure: the mechanical
 * handbook explicitly instructs the model to return no requests when nothing is
 * worth tracking. Only an empty *string* or unparseable text is a fault.
 *
 * @param {any} raw    whatever generateRaw returned
 * @param {string} who label for the message, e.g. 'Game Director'
 */
export function interpretStructuredReply(raw, who = 'model') {
    if (raw && typeof raw === 'object') {
        return Array.isArray(raw) ? {} : raw;
    }

    const text = String(raw ?? '').trim();
    if (!text) {
        throw new StructuredReplyError(
            'empty',
            `The ${who} returned nothing at all. This is almost always the token budget: reasoning is paid for out of the same allowance as the answer, so a thinking model can exhaust it before writing a single character. Raise the Mechanics context budget, or reduce the model's reasoning effort.`,
        );
    }

    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        // Truncated JSON and malformed JSON both land here, but they mean very
        // different things, so say which one this is.
        if (looksTruncated(text)) {
            throw new StructuredReplyError(
                'truncated',
                `The ${who}'s reply was cut off mid-structure, which means it ran out of tokens rather than formatting badly. Raise the Mechanics context budget, or reduce the model's reasoning effort.`,
                text.slice(-160),
            );
        }
        throw new StructuredReplyError(
            'malformed',
            `The ${who} returned text that is not valid JSON. First characters: ${JSON.stringify(text.slice(0, 120))}`,
            String(error?.message || error),
        );
    }
}

/**
 * Did this start as JSON and simply stop? An opening brace or bracket with more
 * of them opened than closed is a strong truncation signal — a model that is
 * merely formatting badly usually does not balance its delimiters this way.
 */
export function looksTruncated(text) {
    const source = String(text ?? '').trim();
    if (!source || !/^[[{]/.test(source)) {
        return false;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const character of source) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (character === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') depth -= 1;
    }
    // Still open at the end, or the string itself never closed.
    return depth > 0 || inString;
}
