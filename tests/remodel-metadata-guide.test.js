import { buildMetadataGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js';
import { readLoreKeywords, readLoreOps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';

describe('Remodel metadata guide', () => {
    // The guide now covers exactly the three live surfaces: the state fence, its
    // top-level keys, and Living Lore. Goals/Variables are dissolved — there is
    // no mechanics capability dictionary or Narrator verb table to advertise.

    test('carries exactly the fence, envelope, and lore surfaces', () => {
        expect(Object.keys(buildMetadataGuide()).sort()).toEqual(['envelope', 'fence', 'lore']);
    });

    // --- The fence and the envelope ----------------------------------------

    test('the fence example is a fence the parser accepts', () => {
        const { example, opener } = buildMetadataGuide().fence;
        expect(example.startsWith(opener)).toBe(true);
        const match = example.match(/```state\s*\n([\s\S]*?)\n?```/i);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match[1]);
        // The fence carries the four dissolved-era keys, and its loreOps survive
        // the reader as recognised typed ops — no mechanics `requests` channel.
        expect(parsed.requests).toBeUndefined();
        expect(new Set(Object.keys(parsed))).toEqual(new Set(['swaps', 'loreKeywords', 'loreOps', 'flow']));
        for (const op of readLoreOps(parsed.loreOps)) {
            expect(['lore.edit', 'lore.create']).toContain(op.op);
        }
    });

    test('every top-level key example is valid JSON in envelope position', () => {
        for (const item of buildMetadataGuide().envelope) {
            expect(() => JSON.parse(`{${item.example}}`)).not.toThrow();
            expect(Object.keys(JSON.parse(`{${item.example}}`))).toEqual([item.name]);
        }
    });

    test('the envelope names exactly the four fence keys', () => {
        expect(buildMetadataGuide().envelope.map((item) => item.name))
            .toEqual(['swaps', 'loreKeywords', 'loreOps', 'flow']);
    });

    // --- Living Lore --------------------------------------------------------

    test('the lore ops example survives the loreOps reader as edit and create', () => {
        const { loreOps } = JSON.parse(buildMetadataGuide().lore.ops.example);
        expect(readLoreOps(loreOps)).toEqual([
            { op: 'lore.edit', book: 'TL', uid: '1', content: 'The lighthouse has run unmanned on a timer since the keeper died.' },
            { op: 'lore.create', name: 'Queens Lake Lighthouse', keys: ['Queens Lake Lighthouse', 'the lighthouse'], secondaryKeys: [], content: 'A coastal light north of the town, automated.' },
        ]);
    });

    test('the keyword example survives the keyword reader unchanged', () => {
        const { loreKeywords } = JSON.parse(buildMetadataGuide().lore.keywords.example);
        expect(readLoreKeywords(loreKeywords)).toEqual(loreKeywords);
    });

    test('the stated keyword ceiling is the ceiling that is enforced', () => {
        const stated = Number(buildMetadataGuide().lore.keywords.arguments[0].hint.match(/Up to (\d+)/)[1]);
        expect(readLoreKeywords(Array.from({ length: stated + 3 }, (_, index) => [`key-${index}`]))).toHaveLength(stated);
    });

    test('every lore-ops argument carries a hint', () => {
        for (const argument of buildMetadataGuide().lore.ops.arguments) {
            expect(String(argument.hint || '').trim()).not.toBe('');
        }
    });
});
