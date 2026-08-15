import {
    directorResponseTokens,
    interpretStructuredReply,
    looksTruncated,
    REASONING_SAFE_FLOOR,
    structuredResponseLength,
    StructuredReplyError,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/structured-reply.js';

describe('Remodel Director answer allowance', () => {
    it('uses the explicit setting when one is configured', () => {
        expect(directorResponseTokens({ directorResponseTokens: 4000, contextBudget: 6000 })).toBe(4000);
        expect(directorResponseTokens({ directorResponseTokens: 12000, contextBudget: 1000 })).toBe(12000);
    });

    it('never returns less than the reasoning floor', () => {
        // Below the floor a reasoning model can exhaust the allowance before
        // writing a character of the envelope, which fails silently rather
        // than returning a shorter answer.
        expect(directorResponseTokens({ directorResponseTokens: 10 })).toBeGreaterThanOrEqual(REASONING_SAFE_FLOOR);
        expect(directorResponseTokens({ directorResponseTokens: -500 })).toBeGreaterThanOrEqual(REASONING_SAFE_FLOOR);
    });

    it('falls back to the derived value for a profile saved before the setting existed', () => {
        expect(directorResponseTokens({ contextBudget: 6000 })).toBe(2000);
        expect(directorResponseTokens({})).toBe(REASONING_SAFE_FLOOR);
    });

    it('caps an absurd configured value rather than sending it', () => {
        expect(directorResponseTokens({ directorResponseTokens: 10_000_000 })).toBe(32000);
    });

    it('keeps the derived sizing available for the mechanical preflight', () => {
        expect(structuredResponseLength(6000, { divisor: 3, ceiling: 3000 })).toBe(2000);
        expect(structuredResponseLength(32000, { divisor: 3, ceiling: 3000 })).toBe(3000);
        expect(structuredResponseLength(0)).toBe(REASONING_SAFE_FLOOR);
    });
});

describe('Remodel structured reply diagnosis', () => {
    it('treats an empty object as a legitimate answer, not a failure', () => {
        // The mechanical handbook explicitly tells the model to return no
        // requests when nothing is worth tracking.
        expect(interpretStructuredReply({}, 'Game Director')).toEqual({});
        expect(interpretStructuredReply('{}', 'Game Director')).toEqual({});
    });

    it('reports an empty reply as a budget problem', () => {
        expect(() => interpretStructuredReply('', 'Game Director')).toThrow(StructuredReplyError);
        try {
            interpretStructuredReply('   ', 'Game Director');
        } catch (error) {
            expect(error.stage).toBe('empty');
        }
    });

    it('separates a truncated envelope from a malformed one', () => {
        try {
            interpretStructuredReply('{"movement":{"objective":"she turns', 'Game Director');
        } catch (error) {
            expect(error.stage).toBe('truncated');
        }
        try {
            interpretStructuredReply('Sure! Here is the direction you asked for.', 'Game Director');
        } catch (error) {
            expect(error.stage).toBe('malformed');
        }
    });

    it('detects unbalanced delimiters and unterminated strings', () => {
        expect(looksTruncated('{"a":1')).toBe(true);
        expect(looksTruncated('{"a":"unclosed')).toBe(true);
        expect(looksTruncated('{"a":1}')).toBe(false);
        expect(looksTruncated('not json at all')).toBe(false);
        // A closing brace inside a string must not read as a close.
        expect(looksTruncated('{"a":"}"')).toBe(true);
        expect(looksTruncated('{"a":"}"}')).toBe(false);
        // An escaped quote must not toggle string state.
        expect(looksTruncated('{"a":"say \\"hi\\""}')).toBe(false);
    });
});
