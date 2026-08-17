// Story Goals — the oracle.
//
// This module owns the die and the arithmetic, and nothing else. The Director
// calls it and cannot fudge the answer: the roll, the margin, and whether a
// reach hit are decided here.
//
// What it deliberately does NOT own is vocabulary. How favourable a chance is,
// how far a meaningful shift moves — those are judgements, and they live in the
// Director's editable prompt where the owner can change them. This module used
// to hold seven named rate bands and four shift magnitudes as lookup tables,
// and `goal.shift` accepted only those four words; the Director could not
// express how far a Goal had actually moved. Deleting the tables is what lets
// it state a number.
//
// Pure functions only — no I/O, no storage, no DOM.

/** A rollable rate never reaches certainty in either direction. `status:
 *  achieved` and `status: impossible` express the absolutes better than a 0%
 *  or 100% roll does. */
export const RATE_FLOOR = 5;
export const RATE_CEIL = 95;

// --- the die ---------------------------------------------------------------

/** A d100: a uniform integer in 1..100. Crypto-backed where available. */
export function rollD100() {
    if (globalThis.crypto?.getRandomValues) {
        const values = new Uint32Array(1);
        // Reject the tail that would bias a plain modulo (2^32 is not a
        // multiple of 100), so every face stays equally likely.
        const limit = Math.floor(0xFFFFFFFF / 100) * 100;
        do {
            globalThis.crypto.getRandomValues(values);
        } while (values[0] >= limit);
        return (values[0] % 100) + 1;
    }
    return Math.floor(Math.random() * 100) + 1;
}

// --- rates -----------------------------------------------------------------

/**
 * Clamp a usable Success Rate into 5–95, or return null when there is no
 * usable value to clamp.
 *
 * The null matters. `Number(null)`, `Number('')` and `Number([])` are all `0`,
 * which is finite — so a guard placed on the *coerced* value never fires, and
 * the clamp then lifts that phantom zero to the floor. A Goal created without a
 * stated rate would silently become nearly impossible instead of taking its
 * default. This repo has shipped that exact trap three times (`clampNumber` in
 * variables-store.js, `coerceSettingValue` in prompt-studio-store.js, and turn
 * numbering in live-direction.js), so the usability question is answered here,
 * before any coercion, and callers supply their own default with `??`.
 */
export function clampRate(value) {
    // Accept only what is genuinely a rate: a finite number, or a string that
    // spells one. Listing the unusable inputs instead does not work — the first
    // draft of this function rejected null, undefined and '' and still let `[]`
    // through, because `Number([])` is 0 and finite too. Whitelisting the two
    // usable shapes has no such tail.
    const number = typeof value === 'number' ? value
        : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    if (!Number.isFinite(number)) return null;
    return Math.max(RATE_FLOOR, Math.min(RATE_CEIL, Math.round(number)));
}

// --- the reach -------------------------------------------------------------

/**
 * The margin of a reach: rate minus roll, then the modifier added. Modifiers
 * attach to the MARGIN rather than to the raw die, since a reach is judged by
 * rolling *under* the rate.
 *
 * A margin >= 0 is a hit; a negative margin is a miss, and its magnitude says
 * how badly — which is the Director's to interpret in the fiction, not this
 * module's to charge a penalty for.
 */
export function margin(rate, roll, modifier = 0) {
    return (Number(rate) || 0) - (Number(roll) || 0) + (Number(modifier) || 0);
}

/** A hit is any margin at or above zero. */
export function isHit(marginValue) {
    return (Number(marginValue) || 0) >= 0;
}

/**
 * Resolve one reach end to end and report the frozen inputs beside the outcome,
 * so a receipt can show exactly what was rolled against what.
 *
 * The caller supplies a usable rate — a Goal always has one. An unusable rate
 * is a programming error rather than something to paper over with a default,
 * because silently substituting one is how a reach ends up resolved against a
 * number nobody chose.
 */
export function resolveReach({ rate, modifier = 0, roll = null } = {}) {
    const baseRate = clampRate(rate);
    if (baseRate === null) throw new TypeError('resolveReach needs a usable rate.');
    const die = roll == null ? rollD100() : Math.max(1, Math.min(100, Math.round(Number(roll) || 1)));
    const marginValue = margin(baseRate, die, modifier);
    return {
        roll: die,
        rate: baseRate,
        modifier: Number(modifier) || 0,
        margin: marginValue,
        hit: isHit(marginValue),
    };
}
