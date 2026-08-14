// Story Goals — the resolution maths.
//
// This module is the SINGLE source of truth for every number the system
// produces: the die, the margin, and the miss bands.
// rate clamping. Nothing else in the extension may roll a die or do goal
// arithmetic.
//
// That rule is what makes "the extension enforces the mechanics, the AI only
// judges" enforceable rather than aspirational. The Mechanical AI proposes
// judgments (which Variable applies, why a rate moved, what a miss costs in the
// fiction); it never produces a value that matters mechanically.
//
// Pure functions only — no I/O, no storage, no DOM. Everything here is
// directly testable with the worked examples from Roleplay_System.md.

// --- tunable constants -----------------------------------------------------
//
// The spec deliberately leaves the bands open ("to be calibrated in code once
// real pool sizes are settled"). They live here, named, so tuning is a one-file
// edit rather than a hunt.

/** A rate can never reach certainty in either direction (spec §3). */
export const RATE_FLOOR = 5;
export const RATE_CEIL = 95;

export const OPENING_RATE_BANDS = Object.freeze({
    nearly_impossible: 5,
    extreme: 15,
    difficult: 30,
    uncertain: 50,
    favorable: 70,
    strongly_favored: 85,
    nearly_assured: 95,
});

export const RATE_SHIFT_BANDS = Object.freeze({
    minor: 3,
    meaningful: 7,
    major: 12,
    decisive: 20,
});

/**
 * Miss severity bands, keyed by how far the modified margin fell below zero.
 * `upTo` is inclusive; the last band catches everything worse.
 * `cost` is the permanent rate penalty the miss inflicts.
 */
export const MISS_BANDS = Object.freeze([
    { id: 'minor', label: 'Minor', upTo: 10, cost: 2 },
    { id: 'serious', label: 'Serious', upTo: 25, cost: 5 },
    { id: 'severe', label: 'Severe', upTo: 50, cost: 10 },
    { id: 'catastrophic', label: 'Catastrophic', upTo: Infinity, cost: 18 },
]);

/**
 * How much a landed hit removes from a Constitution pool, banded by the rate
 * the reach was made at (spec §6). A lucky hit at a low rate barely dents a
 * formidable target; a hit earned by building the rate up bites deep. This is
 * what stops a 5% fluke from ending a fight on the first swing.
 */
export const BITE_BANDS = Object.freeze([
    { upTo: 25, bite: 10 },
    { upTo: 50, bite: 20 },
    { upTo: 75, bite: 35 },
    { upTo: Infinity, bite: 50 },
]);

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

/** Clamp a Success Rate into the legal 5–95 band. */
export function clampRate(value) {
    const rate = Math.round(Number(value) || 0);
    return Math.max(RATE_FLOOR, Math.min(RATE_CEIL, rate));
}

// --- the reach -------------------------------------------------------------

/**
 * The margin of a reach: rate minus roll, then the relevant stat modifier
 * added (spec §5 — modifiers attach to the MARGIN, never to the raw die, since
 * a reach is judged by rolling *under* the rate).
 *
 * A margin >= 0 is a hit; a negative margin is a miss, and its magnitude
 * measures how badly.
 *
 * Worked examples from the spec:
 *   margin(5, 35, 14)  === -16  (still a miss, but a far gentler one)
 *   margin(20, 25, 20) === +15  (the modifier rescues a near-miss into a hit)
 */
export function margin(rate, roll, modifier = 0) {
    return (Number(rate) || 0) - (Number(roll) || 0) + (Number(modifier) || 0);
}

/** A hit is any margin at or above zero. */
export function isHit(marginValue) {
    return (Number(marginValue) || 0) >= 0;
}

/**
 * The miss band for a modified margin, or null if the reach actually hit.
 * Because the modifier is applied before the band is read, a good enough
 * modifier can pull a miss down into a gentler band (spec §7).
 */
export function missBand(marginValue) {
    const value = Number(marginValue) || 0;
    if (value >= 0) {
        return null;
    }
    const depth = Math.abs(value);
    return MISS_BANDS.find((band) => depth <= band.upTo) || MISS_BANDS[MISS_BANDS.length - 1];
}

// --- Constitution ----------------------------------------------------------

/**
 * How much a landed hit takes out of a Constitution pool, from the rate the
 * reach was made at. Note this reads the RATE, not the die: how powerful an
 * outcome is tracks the quality of the position, not the luck of the roll
 * (spec §6). Once a reach has hit, the size of the positive margin is
 * irrelevant — a hit is a hit.
 */
export function constitutionBite(rate) {
    const value = clampRate(rate);
    return (BITE_BANDS.find((band) => value <= band.upTo) || BITE_BANDS[BITE_BANDS.length - 1]).bite;
}

/**
 * Apply a bite to a pool, respecting its win direction. Returns the new
 * current value, clamped to 0..max.
 */
export function applyBite(pool, bite) {
    const max = Math.max(1, Math.round(Number(pool?.max) || 1));
    const current = Math.round(Number(pool?.current) || 0);
    const amount = Math.max(0, Math.round(Number(bite) || 0));
    const next = pool?.winDirection === 'fill' ? current + amount : current - amount;
    return Math.max(0, Math.min(max, next));
}

/** Whether a pool has reached its win condition. */
export function isPoolResolved(pool) {
    if (!pool) {
        return false;
    }
    const max = Math.max(1, Math.round(Number(pool.max) || 1));
    const current = Math.round(Number(pool.current) || 0);
    return pool.winDirection === 'fill' ? current >= max : current <= 0;
}

// --- resolving a whole reach ----------------------------------------------

/**
 * Resolve one reach end to end. The caller supplies the rate and the stat
 * modifier the Director named; everything numeric is decided here.
 *
 * Returns the roll, the modified margin, whether it hit, the miss band and its
 * rate cost when it didn't, and the Constitution bite when it did.
 */
export function resolveReach({ rate, modifier = 0, roll = null } = {}) {
    const baseRate = clampRate(rate);
    const die = roll == null ? rollD100() : Math.max(1, Math.min(100, Math.round(Number(roll) || 1)));
    const marginValue = margin(baseRate, die, modifier);
    const hit = isHit(marginValue);
    const band = missBand(marginValue);
    return {
        roll: die,
        rate: baseRate,
        modifier: Number(modifier) || 0,
        margin: marginValue,
        hit,
        band: band?.id ?? null,
        bandLabel: band?.label ?? null,
        rateCost: band?.cost ?? 0,
        bite: hit ? constitutionBite(baseRate) : 0,
    };
}

export function openingRateForBand(band) {
    return OPENING_RATE_BANDS[String(band || '').toLowerCase()] ?? OPENING_RATE_BANDS.uncertain;
}

export function shiftForMagnitude(magnitude) {
    return RATE_SHIFT_BANDS[String(magnitude || '').toLowerCase()] ?? 0;
}
