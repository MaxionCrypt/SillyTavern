import * as math from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-math.js';

// The module is the oracle the Director calls: it owns the die and the
// arithmetic, and nothing else. The rate vocabulary — what counts as a
// favourable chance, how far a meaningful shift moves — lives in the
// Director's editable prompt, not in a lookup table here.

test('the module exposes only the oracle and its bounds', () => {
    expect(Object.keys(math).sort()).toEqual([
        'RATE_CEIL', 'RATE_FLOOR', 'clampRate', 'isHit', 'margin', 'resolveReach', 'rollD100',
    ]);
});

test('margin is rate minus roll plus modifier', () => {
    expect(math.margin(60, 40, 0)).toBe(20);
    // A negative modifier turns a narrow hit into a miss.
    expect(math.margin(60, 40, -25)).toBe(-5);
    // A positive modifier rescues a miss.
    expect(math.margin(30, 55, 30)).toBe(5);
});

test('a hit is a margin at or above zero, exactly at the boundary', () => {
    expect(math.isHit(0)).toBe(true);
    expect(math.isHit(-1)).toBe(false);
});

test('a usable rate clamps into 5-95 so a roll always has both outcomes', () => {
    expect(math.clampRate(0)).toBe(5);
    expect(math.clampRate(100)).toBe(95);
    expect(math.clampRate(50)).toBe(50);
    expect(math.clampRate('70')).toBe(70);
});

test('an absent rate is not read as zero', () => {
    // Number(null), Number('') and Number([]) are all 0, which is finite — so a
    // guard on the COERCED value never fires and the clamp lifts it to the
    // floor. This codebase has shipped that trap three times: clampNumber in
    // variables-store.js, coerceSettingValue in prompt-studio-store.js, and
    // turn numbering in live-direction.js. A Goal created without a stated rate
    // would silently become nearly impossible rather than taking a default.
    expect(math.clampRate(null)).toBeNull();
    expect(math.clampRate(undefined)).toBeNull();
    expect(math.clampRate('')).toBeNull();
    expect(math.clampRate([])).toBeNull();
    expect(math.clampRate('not a number')).toBeNull();
});

test('resolveReach freezes its inputs and reports them beside the outcome', () => {
    const result = math.resolveReach({ rate: 60, modifier: 10, roll: 40 });
    expect(result).toEqual({ roll: 40, rate: 60, modifier: 10, margin: 30, hit: true });
});

test('resolveReach reports a miss without inventing a penalty for it', () => {
    // Miss-depth penalties are deleted: how badly a miss went is the Director's
    // to judge in the fiction, not code's to charge automatically.
    const result = math.resolveReach({ rate: 20, modifier: 0, roll: 90 });
    expect(result.hit).toBe(false);
    expect(result.margin).toBe(-70);
    expect(Object.keys(result).sort()).toEqual(['hit', 'margin', 'modifier', 'rate', 'roll']);
});

test('resolveReach rolls its own die when none is supplied, always in 1..100', () => {
    for (let index = 0; index < 200; index += 1) {
        const { roll } = math.resolveReach({ rate: 50 });
        expect(Number.isInteger(roll)).toBe(true);
        expect(roll).toBeGreaterThanOrEqual(1);
        expect(roll).toBeLessThanOrEqual(100);
    }
});
