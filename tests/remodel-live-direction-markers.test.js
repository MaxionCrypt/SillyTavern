import { parseDirectionText, readDirectionUnit, sanitizeDirectionText } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction-markers.js';

describe('Remodel Live Direction markers', () => {
    test('withholds a partial marker from visible prose', () => {
        const result = parseDirectionText('One sentence.[[RM:BRE', { final: false });
        expect(result).toEqual({ visibleText: 'One sentence.', markers: [], trailingPartial: true, consumed: 13 });
    });

    test('parses marker order and visible offsets deterministically', () => {
        const source = 'One.[[RM:BREATH]]Two.[[RM:OPENING:intervene]][[RM:COMMIT:damage-1]]Three.[[RM:HARD_PAUSE]]';
        const result = parseDirectionText(source, { final: true });
        expect(result.visibleText).toBe('One.Two.Three.');
        expect(result.markers.map(({ kind, id, visibleOffset }) => ({ kind, id, visibleOffset }))).toEqual([
            { kind: 'breath', id: undefined, visibleOffset: 4 },
            { kind: 'opening', id: 'intervene', visibleOffset: 8 },
            { kind: 'commit', id: 'damage-1', visibleOffset: 8 },
            { kind: 'hard-pause', id: undefined, visibleOffset: 14 },
        ]);
    });

    test('strips known, unknown, malformed, and incomplete markers', () => {
        expect(sanitizeDirectionText('A[[RM:NOPE:x]]B[[RM:BREATH]]C[[RM:OPENING:bad id]]D[[RM:COM')).toBe('ABCD');
    });

    test('does not mistake ordinary brackets for protocol markers', () => {
        expect(readDirectionUnit('[ordinary]', 0)).toEqual({ kind: 'text', value: '[', nextOffset: 1 });
        expect(sanitizeDirectionText('[ordinary] text')).toBe('[ordinary] text');
    });
});
